"""Bounded quarantine scanner, one-message queue courier, and isolated signature updater.

Six case-sensitive tags: gbx-clamav-{scan-result,sha256,engine,signature-version,
signature-date,scanned-at}. Only the exact "No threats found" verdict permits
processing, with all metadata present, signature-date <= scanned-at <= now,
both timestamps <=72h old, and SHA-256 matching the SAME buffer parsed downstream.
An outdated engine is logged "<version> (outdated)" and tagged "<version> outdated"
(parentheses are not supported in Azure index-tag values). Missing tags mean pending;
Error and Malicious are final. Only the scanner may write quarantine verdict tags.
Queue messages carry NO verdict: the worker remains the sole owner of job status.

https://learn.microsoft.com/azure/storage/blobs/storage-blob-tags-python
https://learn.microsoft.com/rest/api/storageservices/set-blob-tags
https://learn.microsoft.com/python/api/azure-storage-queue/azure.storage.queue.queueclient
"""

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import stat
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "database"
WORK = ROOT / "work"
MAX_BYTES = 200_000_000
MAX_SIGNATURE_BYTES = 512 * 1024 * 1024
MAX_STATE_BYTES = 1024 * 1024
# 72 hours (docs/SECURITY.md, malware scanning): ClamAV published no daily CVD for over
# 30 hours, and full signed CVDs are the only updates accepted here. It was 24 hours.
MAX_SIGNATURE_AGE = 72 * 60 * 60
FAMILIES = ("main", "daily", "bytecode")
SIGNED_DATABASES = tuple(f"{family}.cvd" for family in FAMILIES)
MAX_CACHE_ENTRIES = 16
SOURCE_QUEUE = "scan-jobs"
NEXT_QUEUE = "ingest-jobs"
VISIBILITY_TIMEOUT = 960
PREFIX = "gbx-clamav-"
TAG_FIELDS = {
    "scan-result": "verdict", "sha256": "sha256", "engine": "engine",
    "signature-version": "signature_version", "signature-date": "signature_date",
    "scanned-at": "scan_time",
}
# Exact libclamav/cvd.c banner in ClamAV 1.4.6; partial or altered warnings are not allow-listed.
OUTDATED_BANNER = "\n".join("LibClamAV Warning: " + line for line in (
    "*******************************************************************",
    "***  This version of the ClamAV engine is outdated.             ***",
    "***   Read https://docs.clamav.net/manual/Installing.html       ***",
    "*******************************************************************",
))


class ScanFailure(Exception):
    pass


class InvalidMessage(ScanFailure):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ScanFailure("invalid-arguments")


def utc(timestamp=None):
    return datetime.fromtimestamp(time.time() if timestamp is None else timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def failure(result, exc):
    result.update(verdict="Error", reason=str(exc) if isinstance(exc, ScanFailure) else type(exc).__name__)


@contextmanager
def deadline(seconds):
    previous, interval = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()
    signal.setitimer(signal.ITIMER_REAL, min(seconds, previous) if previous else seconds)
    try:
        yield
    finally:
        remaining = max(0.001, previous - (time.monotonic() - started)) if previous else 0
        signal.setitimer(signal.ITIMER_REAL, remaining, interval)


def command(args, timeout):
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          encoding="utf-8", errors="replace", start_new_session=True) as process:
        try:
            output, _ = process.communicate(timeout=timeout)
        except BaseException:
            # Freshclam forks a validation child; terminate the entire owned process group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        return subprocess.CompletedProcess(args, process.returncode, output)


def scan_command(path, work, database=None):
    return [
        "clamscan", f"--database={database or DATABASE}", f"--tempdir={work}", "--stdout", "--no-summary",
        "--official-db-only=yes", "--heuristic-alerts=yes", "--alert-exceeds-max=yes",
        "--alert-encrypted=yes", "--alert-broken=yes", "--alert-broken-media=yes",
        "--scan-archive=yes", "--scan-pdf=yes", "--disable-cache", "--nocerts",
        f"--max-filesize={MAX_BYTES}", "--max-scansize=400000000", "--max-recursion=16",
        "--max-files=10000", "--max-scantime=120000", "--bytecode-timeout=1000", str(path),
    ]


def self_check(require_queue=True):
    from azure.identity import ManagedIdentityCredential
    from azure.storage.blob import BlobClient, ContainerClient
    from azure.core import MatchConditions

    assert ManagedIdentityCredential and BlobClient and ContainerClient and MatchConditions.IfNotModified
    if require_queue:
        from azure.storage.queue import QueueClient
        assert QueueClient
    assert os.getuid() == 65534 and os.access(WORK, os.W_OK)
    help_text = command(["clamscan", "--help"], 10).stdout
    for flag in scan_command(Path("payload"), WORK)[1:-1]:
        assert flag.split("=")[0] in help_text, flag
    help_text = command(["freshclam", "--help"], 10).stdout
    assert "--no-dns" in help_text and "--stdout" in help_text
    assert "--info" in command(["sigtool", "--help"], 10).stdout
    print(json.dumps({"self_check": "ok", "uid": os.getuid(), "queue_sdk_checked": require_queue,
                      "engine": command(["clamscan", "--version"], 10).stdout.strip()}))


def copy_bounded(chunks, destination, expected_size, maximum=None):
    maximum = MAX_BYTES if maximum is None else maximum
    if not 0 <= expected_size <= maximum:
        raise ScanFailure("blob-size-exceeds-200MB" if maximum == MAX_BYTES else "signature-size-exceeded")
    digest, size = hashlib.sha256(), 0
    with destination.open("xb") as output:
        for chunk in chunks:
            size += len(chunk)
            if size > maximum or size > expected_size:
                raise ScanFailure("download-size-exceeded")
            output.write(chunk)
            digest.update(chunk)
    if size != expected_size:
        raise ScanFailure("download-size-mismatch")
    return digest.hexdigest()


def copy_local(path, destination):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ScanFailure("local-input-not-regular-file")
        return copy_bounded(iter(lambda: source.read(1024 * 1024), b""), destination, info.st_size)


def storage_options(service):
    from azure.identity import ManagedIdentityCredential

    account = os.environ.get("STORAGE_ACCOUNT", "")
    client_id = os.environ.get("AZURE_CLIENT_ID", "")
    if not re.fullmatch(r"[a-z0-9]{3,24}", account) or not client_id:
        raise ScanFailure("missing-or-invalid-storage-identity-config")
    uuid.UUID(client_id)
    return {"account_url": f"https://{account}.{service}.core.windows.net",
            "credential": ManagedIdentityCredential(client_id=client_id, connection_timeout=10, read_timeout=20, retry_total=1),
            "connection_timeout": 10, "read_timeout": 30, "retry_total": 1}


def blob_client(blob_name):
    from azure.storage.blob import BlobClient

    return BlobClient(**storage_options("blob"), container_name="quarantine", blob_name=blob_name,
                      max_single_get_size=4 * 1024 * 1024, max_chunk_get_size=4 * 1024 * 1024)


def signature_client():
    from azure.storage.blob import ContainerClient

    return ContainerClient(**storage_options("blob"), container_name="signatures",
                           max_single_get_size=4 * 1024 * 1024, max_chunk_get_size=4 * 1024 * 1024)


def queue_client(name):
    from azure.storage.queue import QueueClient

    # The source queue plus exactly the configured forwarding routes (an invalid allowlist raises and fails closed).
    if name != SOURCE_QUEUE and name not in allowed_routes():
        raise ScanFailure("invalid-queue-name")
    return QueueClient(**storage_options("queue"), queue_name=name,
                       message_encode_policy=None, message_decode_policy=None)


def download(client, destination, maximum=None, properties=None):
    from azure.core import MatchConditions

    maximum = MAX_BYTES if maximum is None else maximum
    properties = properties if properties is not None else client.get_blob_properties(timeout=20)
    if not 0 <= properties.size <= maximum:
        raise ScanFailure("blob-size-exceeds-200MB" if maximum == MAX_BYTES else "signature-size-exceeded")
    # The SDK rejects a length without an offset (ValueError); a zero-length blob is read whole.
    byte_range = {"offset": 0, "length": properties.size} if properties.size else {}
    stream = client.download_blob(**byte_range, etag=properties.etag,
                                  match_condition=MatchConditions.IfNotModified, max_concurrency=1, timeout=30)
    return copy_bounded(stream.chunks(), destination, properties.size, maximum), properties


def check_signature_names(names, allow_cld_cleanup=False):
    for count, name in enumerate(names, 1):
        if count > MAX_CACHE_ENTRIES:
            raise ScanFailure("signature-cache-too-many-files")
        if name in SIGNED_DATABASES or name == "freshclam.dat":
            continue
        if name.lower().endswith(".cld"):
            if allow_cld_cleanup:
                continue
            raise ScanFailure(f"unsigned-cld-cache:{name}")
        raise ScanFailure(f"unexpected-signature-file:{name}")


def family_file(database, family):
    path = database / f"{family}.cvd"
    if not path.is_file() or path.is_symlink():
        raise ScanFailure(f"missing-or-unsafe-database-{family}")
    return path


def verify_databases(database):
    check_signature_names(path.name for path in database.iterdir())
    verified = []
    for family in FAMILIES:
        path = family_file(database, family)
        checked = command(["sigtool", f"--info={path}"], 60)
        if checked.returncode != 0 or not re.search(r"^Verification OK\.?\r?$", checked.stdout, re.MULTILINE):
            raise ScanFailure(f"signature-verification-failed:{family}")
        verified.append(path.name)
    return verified


def database_metadata(result, database=None):
    database = database or DATABASE
    check_signature_names(path.name for path in database.iterdir())
    versions, databases = [], {}
    for name in FAMILIES:
        path = family_file(database, name)
        # Age comes from the embedded header, never from filesystem mtime.
        with path.open("rb") as source:
            header = source.read(512).decode("ascii").strip(" \x00\r\n").split(":")
        if len(header) < 9 or header[0] != "ClamAV-VDB" or any(not header[i].isdigit() for i in (2, 3, 8)):
            raise ScanFailure(f"invalid-database-header-{name}")
        if any(int(header[i]) <= 0 for i in (2, 3, 8)):
            raise ScanFailure(f"invalid-database-header-{name}")
        versions.append(f"{name}:{header[2]}")
        databases[name] = {"file": path.name, "version": int(header[2]), "build_time": utc(int(header[8]))}
        if name == "daily":
            daily_timestamp = int(header[8])
    result.update(signature_version="/".join(versions), databases=databases,
                  signature_date=utc(daily_timestamp), signature_age_seconds=int(time.time()) - daily_timestamp)
    if result["signature_age_seconds"] < 0:
        raise ScanFailure("signature-database-in-future")
    if result["signature_age_seconds"] > MAX_SIGNATURE_AGE:
        raise ScanFailure("signature-database-stale")


def signature_inventory(container, allow_cld_cleanup=False):
    inventory = {}
    for count, blob in enumerate(container.list_blobs(results_per_page=8, timeout=20), 1):
        if count > MAX_CACHE_ENTRIES:
            raise ScanFailure("signature-cache-too-many-files")
        inventory[blob.name] = blob
    check_signature_names(inventory, allow_cld_cleanup)
    return inventory


def restore_signatures(container, destination, updater=False, removed_files=None):
    from azure.core import MatchConditions

    inventory = signature_inventory(container, allow_cld_cleanup=updater)
    if updater:
        # Never restore an unsigned CLD, even as a refresh seed. Remove it conditionally and re-list.
        stale = [name for name in inventory if name.lower().endswith(".cld")]
        for name in stale:
            container.delete_blob(name, etag=inventory[name].etag, match_condition=MatchConditions.IfNotModified, timeout=20)
            if removed_files is not None:
                removed_files.append(name)
        if stale:
            inventory = signature_inventory(container)
    destination.mkdir(mode=0o700)
    names = []
    for family, name in zip(FAMILIES, SIGNED_DATABASES):
        if name in inventory:
            names.append(name)
        elif not updater:
            raise ScanFailure(f"missing-or-unsafe-database-{family}")
    if updater and "freshclam.dat" in inventory:
        names.append("freshclam.dat")
    for name in names:
        path = destination / name
        limit = MAX_STATE_BYTES if name == "freshclam.dat" else MAX_SIGNATURE_BYTES
        download(container.get_blob_client(name), path, limit, inventory[name])
        path.chmod(0o600 if updater else 0o400)
    return inventory


def scan_file(path, work, result, database=None):
    database = database or DATABASE
    version = command(["clamscan", "--version"], 10)
    engine = re.match(r"ClamAV ([0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.-]*)", version.stdout)
    if version.returncode != 0 or not engine:
        raise ScanFailure("engine-version-unavailable")
    result.update(engine=engine[1], engine_outdated=False)
    database_metadata(result, database)
    result["verified_signature_files"] = verify_databases(database)
    result["signature_integrity_verified"] = True
    scanned = command(scan_command(path, work, database), 180)
    output = scanned.stdout
    detections = re.findall(rf"^{re.escape(str(path))}: ([^\r\n]+) FOUND$", output, re.MULTILINE)
    for prefix, reason in (("Heuristics.Limits.Exceeded", "scan-limit-exceeded"),
                           ("Heuristics.Encrypted.", "encrypted-content"), ("Heuristics.Broken.", "broken-content")):
        if any(detection.startswith(prefix) for detection in detections):
            raise ScanFailure(reason)
    database_metadata(result, database)
    if OUTDATED_BANNER in output:
        result.update(engine_outdated=True, engine=engine[1] + " (outdated)")
        output = output.replace(OUTDATED_BANNER, "")
    if scanned.returncode == 1 and detections:
        result.update(verdict="Malicious", reason="malware-detected", detection=detections[0][:256])
    elif scanned.returncode != 0 or re.search(r"\b(ERROR|WARNING)\b", output, re.IGNORECASE):
        raise ScanFailure("clamav-execution-error")
    elif output.strip() == f"{path}: OK":
        result.update(verdict="No threats found", reason="scanned")
    else:
        raise ScanFailure("missing-clean-output")


def invalidate(client):
    owned = {PREFIX + suffix for suffix in TAG_FIELDS}
    tags = {key: value for key, value in client.get_blob_tags(timeout=15).items() if key not in owned}
    client.set_blob_tags(tags, timeout=15)
    return len(tags) + len(owned) <= 10


def publish(client, result):
    owned = {PREFIX + suffix: str(result.get(field) or "unavailable") for suffix, field in TAG_FIELDS.items()}
    if result.get("engine_outdated"):
        owned[PREFIX + "engine"] = result["engine"].removesuffix(" (outdated)") + " outdated"
    tags = {key: value for key, value in client.get_blob_tags(timeout=15).items() if key not in owned}
    if len(tags) + len(owned) > 10:
        if result["verdict"] != "Error":
            raise ScanFailure("blob-tag-capacity-exceeded")
        owned = {PREFIX + "scan-result": "Error"}
    if len(tags) + len(owned) > 10:
        raise ScanFailure("blob-tag-capacity-exceeded")
    client.set_blob_tags({**tags, **owned}, timeout=15)


def new_result():
    return {"verdict": "Error", "sha256": None, "engine": None, "signature_version": None,
            "signature_date": None, "scan_time": utc(), "tags_written": False, "signature_integrity_verified": False}


def validate_blob_name(name, error=ScanFailure):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9/_.-]{1,200}", name) or ".." in name or name.startswith("/"):
        raise error("invalid-blob-name")
    return name


def process_scan(result, blob_name=None, local_file=None, force_error=None):
    client, work = None, None
    result["input"] = str(local_file) if local_file else blob_name
    try:
        with deadline(720):
            if local_file is None:
                validate_blob_name(blob_name)
                client = blob_client(blob_name)
                if not invalidate(client):
                    raise ScanFailure("blob-tag-capacity-exceeded")
            if force_error:
                raise ScanFailure(force_error)
            work = WORK / uuid.uuid4().hex
            work.mkdir(parents=True, mode=0o700)
            payload = work / "payload"
            if local_file is not None:
                result["sha256"] = copy_local(local_file, payload)
            else:
                result["sha256"], properties = download(client, payload)
            database = DATABASE
            if local_file is None or os.environ.get("STORAGE_ACCOUNT"):
                database = work / "database"
                restore_signatures(signature_client(), database)
            scan_file(payload, work, result, database)
            if client:
                current = client.get_blob_properties(timeout=20)
                if current.etag != properties.etag or current.size != properties.size:
                    raise ScanFailure("blob-changed-during-scan")
    except Exception as exc:
        failure(result, exc)
    finally:
        if work and work.exists():
            try:
                shutil.rmtree(work)
            except Exception as exc:
                failure(result, exc)
    result["scan_time"] = utc()
    if client:
        try:
            with deadline(60):
                publish(client, result)
            result["tags_written"] = True
        except Exception as exc:
            failure(result, ScanFailure(f"tag-write-failed:{type(exc).__name__}"))
            try:
                with deadline(30):
                    publish(client, result)
                result["tags_written"] = True
            except Exception:
                result["tags_written"] = False


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InvalidMessage("duplicate-json-key")
        value[key] = item
    return value


def allowed_routes():
    routes = os.environ.get("GBX_ROUTES", "ingest-jobs,process-jobs").split(",")
    if (not routes or len(routes) != len(set(routes)) or NEXT_QUEUE not in routes
            or any(not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", name) or "--" in name or name == SOURCE_QUEUE for name in routes)):
        raise ScanFailure("invalid-route-allowlist")
    return set(routes)


def decode_message(text):
    if not isinstance(text, str) or not 1 <= len(text) <= 65536:
        raise InvalidMessage("invalid-message-text")
    value = json.loads(base64.b64decode(text, validate=True).decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) not in ({"jobId", "blob", "owner"}, {"jobId", "blob", "owner", "route"}):
        raise InvalidMessage("invalid-message-schema")
    if any(not isinstance(value[key], str) or not value[key].strip() for key in ("jobId", "owner")):
        raise InvalidMessage("invalid-message-schema")
    validate_blob_name(value["blob"], InvalidMessage)
    route = value.get("route", NEXT_QUEUE)
    if not isinstance(route, str) or route not in allowed_routes():
        raise InvalidMessage("forbidden-route")
    return value


def process_queue(result):
    next_name = os.environ.get("GBX_NEXT_QUEUE", NEXT_QUEUE)
    if next_name != NEXT_QUEUE:
        raise ScanFailure("invalid-next-queue")
    allowed_routes()
    source = queue_client(SOURCE_QUEUE)
    message = source.receive_message(visibility_timeout=VISIBILITY_TIMEOUT, timeout=20)
    if message is None:
        result.update(status="Empty", reason="queue-empty")
        return
    result.update(message_id=message.id, dequeue_count=message.dequeue_count, queue_forwarded=False, queue_deleted=False)
    try:
        value = decode_message(message.content)
    except (InvalidMessage, ValueError):
        source.delete_message(message.id, message.pop_receipt, timeout=20)
        result.update(status="Discarded", reason="invalid-queue-message", queue_deleted=True)
        return
    next_name = value.get("route", next_name)
    result["job_id"] = value["jobId"]
    result["route"] = next_name
    process_scan(result, blob_name=value["blob"], force_error="poison-message" if message.dequeue_count > 3 else None)
    if not result["tags_written"]:
        raise ScanFailure("verdict-not-persisted")
    queue_client(next_name).send_message(message.content, timeout=20)
    result["queue_forwarded"] = True
    source.delete_message(message.id, message.pop_receipt, timeout=20)
    result.update(status="Forwarded", queue_deleted=True)


def update_signatures(result):
    from azure.core import MatchConditions

    work = WORK / uuid.uuid4().hex
    work.mkdir(parents=True, mode=0o700)
    result.update(status="Error", published_files=[], removed_files=[], signatures_published=False,
                  signature_integrity_verified=False)
    try:
        with deadline(660):
            container = signature_client()
            database = work / "database"
            inventory = restore_signatures(container, database, updater=True, removed_files=result["removed_files"])
            config = work / "freshclam.conf"
            config.write_text(f"DatabaseDirectory {database}\nDatabaseOwner nobody\nDatabaseMirror database.clamav.net\n"
                              "ConnectTimeout 10\nReceiveTimeout 30\nMaxAttempts 1\nTestDatabases yes\nScriptedUpdates no\n")
            refresh = command(["freshclam", f"--config-file={config}", "--no-dns", "--stdout"], 600)
            result["refresh_exit_code"] = refresh.returncode
            if refresh.returncode < 0:
                raise ScanFailure("signature-updater-crashed")
            database_metadata(result, database)
            result["verified_signature_files"] = verify_databases(database)
            result["signature_integrity_verified"] = True
            files = [family_file(database, family) for family in FAMILIES]
            state = database / "freshclam.dat"
            if not state.is_file() or state.is_symlink():
                raise ScanFailure("missing-freshclam-state")
            files.append(state)
            for path in files:
                limit = MAX_STATE_BYTES if path == state else MAX_SIGNATURE_BYTES
                if not 0 < path.stat().st_size <= limit:
                    raise ScanFailure("signature-size-exceeded")
        # Preparation is capped separately so a slow cold refresh cannot consume the upload budget.
        with deadline(180):
            for path in files:
                options = {"overwrite": False}
                if path.name in inventory:
                    options.update(overwrite=True, etag=inventory[path.name].etag, match_condition=MatchConditions.IfNotModified)
                with path.open("rb") as data:
                    container.upload_blob(path.name, data, length=path.stat().st_size, max_concurrency=1, timeout=60, **options)
                result["published_files"].append(path.name)
            current = signature_inventory(container)
            if set(current) != {path.name for path in files}:
                raise ScanFailure("published-signature-set-incomplete")
            database_metadata(result, database)
            result.update(status="Published", signatures_published=True)
    finally:
        shutil.rmtree(work)


def interrupted(signum, frame):
    raise ScanFailure("execution-timeout" if signum == signal.SIGALRM else "execution-interrupted")


def main(argv=None):
    logging.disable(logging.CRITICAL)
    started, result = time.monotonic(), new_result()
    code = 2
    for sig in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    signal.alarm(840)
    try:
        parser = Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
        inputs = parser.add_mutually_exclusive_group()
        inputs.add_argument("--local-file", type=Path)
        inputs.add_argument("--blob-name")
        inputs.add_argument("--update-signatures", action="store_true")
        args = parser.parse_args(argv)
        blob_name = args.blob_name if args.blob_name is not None else os.environ.get("GBX_SCAN_BLOB")
        if args.update_signatures:
            result = {"mode": "signatures"}
            update_signatures(result)
            code = 0
        elif args.local_file is not None or args.blob_name is not None or blob_name:
            result["mode"] = "local" if args.local_file is not None else "blob"
            process_scan(result, blob_name=blob_name, local_file=args.local_file)
            code = {"No threats found": 0, "Malicious": 1, "Error": 2}[result["verdict"]]
        else:
            result["mode"] = "queue"
            process_queue(result)
            code = 0
    except Exception as exc:
        if result.get("mode") == "queue":
            result.update(status="Error", dispatch_error=str(exc) if isinstance(exc, ScanFailure) else type(exc).__name__)
        else:
            failure(result, exc)
            result["status"] = "Error"
    finally:
        signal.alarm(0)
    result.update(duration_ms=round((time.monotonic() - started) * 1000), completed_at=utc())
    print(json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
