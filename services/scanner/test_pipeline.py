"""Queue/updater tests use in-memory storage; no Azure account or Queue SDK transport is exercised."""

import base64
import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import types
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from azure.core.exceptions import ResourceModifiedError, ResourceNotFoundError

import scan


class QueueTests(unittest.TestCase):
    def setUp(self):
        raw = ' { "owner": "owner-1", "blob": "folder/report.pdf", "jobId": "job-1" }\n'
        self.text = base64.b64encode(raw.encode()).decode()
        self.message = SimpleNamespace(content=self.text, id="message-id", pop_receipt="receipt", dequeue_count=1)
        self.source, self.target = Mock(), Mock()
        self.source.receive_message.return_value = self.message
        self.events = []
        self.source.delete_message.side_effect = lambda *a, **k: self.events.append("delete")
        self.target.send_message.side_effect = lambda *a, **k: self.events.append("forward")
        env = patch.dict(os.environ, {"GBX_NEXT_QUEUE": scan.NEXT_QUEUE, "GBX_ROUTES": "ingest-jobs,process-jobs", "GBX_SCAN_BLOB": ""})
        env.start()
        self.addCleanup(env.stop)

    def run_queue(self, verdict="No threats found", tags=True, decode_error=None):
        def process(result, blob_name=None, force_error=None):
            self.events.append("scan")
            result.update(verdict="Error" if force_error else verdict, tags_written=tags,
                          reason=force_error or "scanned", input=blob_name)
        output = io.StringIO()
        factory = Mock(side_effect=lambda name: {scan.SOURCE_QUEUE: self.source, scan.NEXT_QUEUE: self.target, "process-jobs": self.target}[name])
        with patch.object(scan, "queue_client", factory), patch.object(scan, "process_scan", side_effect=process) as scanner, \
             contextlib.redirect_stdout(output):
            if decode_error:
                with patch.object(scan, "decode_message", side_effect=decode_error):
                    code = scan.main([])
            else:
                code = scan.main([])
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertNotIn(self.text, output.getvalue())
        return code, json.loads(output.getvalue()), scanner, factory

    def test_all_final_verdicts_forward_original_text_then_delete(self):
        for verdict in ("No threats found", "Malicious", "Error"):
            with self.subTest(verdict=verdict):
                self.events.clear()
                code, result, _, _ = self.run_queue(verdict)
                self.assertEqual(code, 0)
                self.assertEqual(result["verdict"], verdict)
                self.assertEqual(result["status"], "Forwarded")
                self.assertEqual(self.events, ["scan", "forward", "delete"])
                self.target.send_message.assert_called_with(self.text, timeout=20)
                self.source.delete_message.assert_called_with("message-id", "receipt", timeout=20)
                self.source.receive_message.assert_called_with(visibility_timeout=960, timeout=20)

    def test_explicit_routes_forward_original_message(self):
        for route in ("ingest-jobs", "process-jobs"):
            with self.subTest(route=route):
                self.events.clear()
                self.message.content = base64.b64encode(json.dumps({"jobId": "j", "blob": "sources/source/file.pdf", "owner": "o", "route": route}).encode()).decode()
                code, result, _, factory = self.run_queue()
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "Forwarded")
                self.assertEqual(factory.call_args.args, (route,))
                self.target.send_message.assert_called_with(self.message.content, timeout=20)
                self.assertEqual(self.events, ["scan", "forward", "delete"])

    def test_forbidden_or_malformed_routes_never_scan_or_forward(self):
        for route in (None, "", "scan-jobs", "other-jobs", 3, []):
            with self.subTest(route=route):
                self.events.clear()
                self.message.content = base64.b64encode(json.dumps({"jobId": "j", "blob": "ok.pdf", "owner": "o", "route": route}).encode()).decode()
                code, result, scanner, _ = self.run_queue()
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "Discarded")
                scanner.assert_not_called()
                self.assertEqual(self.events, ["delete"])

    def test_route_removed_from_allowlist_is_rejected(self):
        with patch.dict(os.environ, {"GBX_ROUTES": "ingest-jobs"}):
            text = base64.b64encode(b'{"jobId":"j","owner":"o","blob":"x.pdf","route":"process-jobs"}').decode()
            with self.assertRaises(scan.InvalidMessage):
                scan.decode_message(text)

    def test_fourth_dequeue_is_poison_and_forwards_error(self):
        self.message.dequeue_count = 4
        code, result, scanner, _ = self.run_queue()
        self.assertEqual((code, result["verdict"], result["reason"]), (0, "Error", "poison-message"))
        self.assertEqual(scanner.call_args.kwargs["force_error"], "poison-message")
        self.assertEqual(self.events, ["scan", "forward", "delete"])

    def test_third_dequeue_still_scans(self):
        self.message.dequeue_count = 3
        code, _, scanner, _ = self.run_queue()
        self.assertEqual(code, 0)
        self.assertIsNone(scanner.call_args.kwargs["force_error"])

    def test_invalid_messages_are_deleted_without_forward_or_scan(self):
        invalid = ["not-base64!", "", "x" * 65537,
                   base64.b64encode(b"not JSON").decode(), base64.b64encode(b"\xff").decode()]
        payloads = [None, [], {}, {"blob": "ok", "jobId": "j"},
                    {"blob": "ok", "jobId": "j", "owner": "o", "extra": 1},
                    {"blob": "ok", "jobId": 1, "owner": "o"},
                    {"blob": "ok", "jobId": "j", "owner": " "},
                    {"blob": None, "jobId": "j", "owner": "o"}]
        invalid += [base64.b64encode(json.dumps(payload).encode()).decode() for payload in payloads]
        invalid.append(base64.b64encode(b'{"jobId":"a","jobId":"b","blob":"x","owner":"o"}').decode())
        for text in invalid:
            with self.subTest(text=text[:60]):
                self.message.content = text
                self.events.clear()
                code, result, scanner, _ = self.run_queue()
                self.assertEqual((code, result["status"]), (0, "Discarded"))
                self.assertEqual(self.events, ["delete"])
                self.assertFalse(result["queue_forwarded"])
                scanner.assert_not_called()

    def test_blob_name_validation_has_exact_requested_bounds(self):
        for name in ("a", "Folder-1/report_2.pdf", "a" * 200):
            text = base64.b64encode(json.dumps({"jobId": "j", "blob": name, "owner": "o"}).encode()).decode()
            self.assertEqual(scan.decode_message(text)["blob"], name)
        for name in ("", "a" * 201, "/absolute", "../x", "x/../y", "x..y", "two words", "x\\y", "é", "x\ny", "x?y"):
            with self.subTest(name=name), self.assertRaises(scan.InvalidMessage):
                text = base64.b64encode(json.dumps({"jobId": "j", "blob": name, "owner": "o"}).encode()).decode()
                scan.decode_message(text)

    def test_invalid_poison_message_is_discarded_not_forwarded(self):
        self.message.dequeue_count, self.message.content = 8, "invalid!"
        code, result, scanner, _ = self.run_queue()
        self.assertEqual((code, result["status"]), (0, "Discarded"))
        self.assertEqual(self.events, ["delete"])
        scanner.assert_not_called()

    def test_unexpected_decoder_failure_does_not_acknowledge(self):
        code, result, _, _ = self.run_queue(decode_error=RuntimeError("internal bug"))
        self.assertEqual((code, result["status"]), (2, "Error"))
        self.assertEqual(self.events, [])

    def test_only_ingest_jobs_is_an_allowed_next_queue(self):
        for name in ("other", "", "scan-jobs"):
            with self.subTest(name=name), patch.dict(os.environ, {"GBX_NEXT_QUEUE": name}):
                code, result, _, factory = self.run_queue()
                self.assertEqual((code, result["dispatch_error"]), (2, "invalid-next-queue"))
                factory.assert_not_called()

    def test_default_next_queue(self):
        with patch.dict(os.environ):
            os.environ.pop("GBX_NEXT_QUEUE")
            code, result, _, factory = self.run_queue()
        self.assertEqual((code, result["status"]), (0, "Forwarded"))
        self.assertEqual([call.args[0] for call in factory.call_args_list], ["scan-jobs", "ingest-jobs"])

    def test_empty_queue_is_a_successful_noop(self):
        self.source.receive_message.return_value = None
        code, result, scanner, _ = self.run_queue()
        self.assertEqual((code, result["status"]), (0, "Empty"))
        self.assertEqual(self.events, [])
        scanner.assert_not_called()

    def test_failed_tag_persistence_cannot_forward_or_delete(self):
        code, result, _, _ = self.run_queue(tags=False)
        self.assertEqual((code, result["dispatch_error"]), (2, "verdict-not-persisted"))
        self.assertEqual(self.events, ["scan"])

    def test_failed_forward_never_deletes_source(self):
        self.target.send_message.side_effect = RuntimeError("network")
        code, result, _, _ = self.run_queue()
        self.assertEqual(code, 2)
        self.assertFalse(result["queue_forwarded"])
        self.source.delete_message.assert_not_called()

    def test_delete_failure_records_forward_and_leaves_retry(self):
        self.source.delete_message.side_effect = RuntimeError("ack failed")
        code, result, _, _ = self.run_queue()
        self.assertEqual(code, 2)
        self.assertTrue(result["queue_forwarded"])
        self.assertFalse(result["queue_deleted"])

    def test_receive_failure_does_not_send_or_ack(self):
        self.source.receive_message.side_effect = RuntimeError("read failed")
        code, _, scanner, _ = self.run_queue()
        self.assertEqual(code, 2)
        self.target.send_message.assert_not_called()
        self.source.delete_message.assert_not_called()
        scanner.assert_not_called()

    def test_queue_client_disables_both_encoding_policies(self):
        module = types.ModuleType("azure.storage.queue")
        module.QueueClient = Mock()
        with patch.dict(sys.modules, {"azure.storage.queue": module}), \
             patch.object(scan, "storage_options", return_value={"account_url": "https://account.queue.core.windows.net", "credential": "identity"}):
            scan.queue_client("scan-jobs")
        kwargs = module.QueueClient.call_args.kwargs
        self.assertIsNone(kwargs["message_encode_policy"])
        self.assertIsNone(kwargs["message_decode_policy"])
        self.assertEqual(kwargs["queue_name"], "scan-jobs")


class MemoryBlob:
    def __init__(self, container, name):
        self.container, self.name = container, name

    def get_blob_properties(self, **kwargs):
        c, name = self.container, self.name
        c.events.append(("properties", name))
        if name not in c.data:
            raise ResourceNotFoundError("missing")
        return SimpleNamespace(size=c.size_overrides.get(name, len(c.data[name])), etag=c.etags[name])

    def download_blob(self, **kwargs):
        c, name = self.container, self.name
        c.events.append(("download", name))
        # Mirror azure-storage-blob 12.31.1 (_blob_client.py:758): a length needs an offset.
        if kwargs.get("length") is not None and kwargs.get("offset") is None:
            raise ValueError("Offset value must not be None if length is set.")
        if kwargs["etag"] != c.etags[name]:
            raise ResourceModifiedError("changed")
        assert kwargs["match_condition"].name == "IfNotModified" and kwargs["max_concurrency"] == 1
        return SimpleNamespace(chunks=lambda: iter([c.data[name]]))


class MemoryContainer:
    def __init__(self, data=None):
        self.data = dict(data or {})
        self.etags = {name: '"v1"' for name in self.data}
        self.events, self.size_overrides = [], {}
        self.fail_upload, self.after_upload = None, None
        self.counter = 1

    def get_blob_client(self, name):
        return MemoryBlob(self, name)

    def list_blobs(self, **kwargs):
        assert kwargs["results_per_page"] == 8 and kwargs["timeout"] == 20
        self.events.append(("list", ""))
        for name in sorted(self.data):
            yield SimpleNamespace(name=name, size=self.size_overrides.get(name, len(self.data[name])), etag=self.etags[name])

    def upload_blob(self, name, data, **kwargs):
        self.events.append(("upload", name))
        if self.fail_upload == name:
            raise RuntimeError("upload failed")
        if name in self.data:
            assert kwargs["overwrite"] and kwargs["match_condition"].name == "IfNotModified"
            if kwargs["etag"] != self.etags[name]:
                raise ResourceModifiedError("conflict")
        else:
            assert kwargs["overwrite"] is False
        self.data[name] = data.read()
        assert kwargs["length"] == len(self.data[name]) and kwargs["max_concurrency"] == 1
        self.counter += 1
        self.etags[name] = f'"v{self.counter}"'
        if self.after_upload:
            self.after_upload(name)

    def delete_blob(self, name, **kwargs):
        self.events.append(("delete", name))
        assert kwargs["match_condition"].name == "IfNotModified"
        if kwargs["etag"] != self.etags[name]:
            raise ResourceModifiedError("conflict")
        del self.data[name]
        del self.etags[name]


class SignatureTests(unittest.TestCase):
    def setUp(self):
        self.root = scan.WORK / ("signature-test-" + uuid.uuid4().hex)
        self.root.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.root)
        self.now = int(time.time())
        self.snapshot = {family + ".cvd": self.header(family) for family in scan.FAMILIES}
        self.snapshot["freshclam.dat"] = b"updater-state"
        work_patch = patch.object(scan, "WORK", self.root / "runs")
        work_patch.start()
        self.addCleanup(work_patch.stop)

    def header(self, family, age=None, version=None):
        age = age if age is not None else (3600 if family == "daily" else 30 * 86400)
        version = version or {"main": 63, "daily": 28172, "bytecode": 339}[family]
        value = f"ClamAV-VDB:date:{version}:100:90:hash:signature:builder:{self.now-age}"
        return value.encode().ljust(512, b" ") + b"unit fixture, not a signed database"

    def fake_refresh(self, args, timeout):
        self.assertEqual(args[0], "freshclam")
        self.assertIn("--no-dns", args)
        self.assertEqual(timeout, 600)
        config = Path(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--config-file="))).read_text()
        self.assertIn("TestDatabases yes\n", config)
        self.assertIn("ScriptedUpdates no\n", config)
        self.assertNotIn("ScriptedUpdates yes", config)
        self.assertIn("DatabaseMirror database.clamav.net\n", config)
        database = Path(config.splitlines()[0].split(" ", 1)[1])
        for name, data in self.snapshot.items():
            (database / name).write_bytes(data)
        return subprocess.CompletedProcess(args, 0, "updated")

    def fake_command(self, args, timeout, refresh=None):
        if args[0] == "sigtool":
            self.assertEqual(timeout, 60)
            self.assertTrue(args[1].endswith(".cvd"))
            return subprocess.CompletedProcess(args, 0, "Verification OK.\n")
        return (refresh or self.fake_refresh)(args, timeout)

    def update(self, container, refresh=None):
        result = {"mode": "signatures"}
        with patch.object(scan, "signature_client", return_value=container), \
             patch.object(scan, "command", side_effect=lambda args, timeout: self.fake_command(args, timeout, refresh)):
            scan.update_signatures(result)
        return result

    def test_scanner_restores_only_three_readonly_databases(self):
        container = MemoryContainer(self.snapshot)
        destination = self.root / "restored"
        scan.restore_signatures(container, destination)
        self.assertEqual(set(p.name for p in destination.iterdir()), {family + ".cvd" for family in scan.FAMILIES})
        for path in destination.iterdir():
            self.assertEqual(path.read_bytes(), self.snapshot[path.name])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o222, 0)
        self.assertNotIn(("properties", "freshclam.dat"), container.events)
        self.assertFalse(any(action in ("upload", "delete") for action, _ in container.events))

    def test_scanner_refuses_incomplete_or_ambiguous_snapshot(self):
        for ambiguous in (False, True):
            with self.subTest(ambiguous=ambiguous):
                data = dict(self.snapshot)
                if ambiguous:
                    data["daily.cld"] = self.header("daily")
                else:
                    del data["daily.cvd"]
                with self.assertRaisesRegex(scan.ScanFailure, "unsigned-cld-cache:daily.cld" if ambiguous else "database-daily"):
                    scan.restore_signatures(MemoryContainer(data), self.root / str(ambiguous))

    def test_signature_download_has_separate_size_bound(self):
        container = MemoryContainer(self.snapshot)
        container.size_overrides["daily.cvd"] = scan.MAX_SIGNATURE_BYTES + 1
        with self.assertRaisesRegex(scan.ScanFailure, "signature-size-exceeded"):
            scan.restore_signatures(container, self.root / "oversize")
        self.assertNotIn(("download", "daily.cvd"), container.events)

    def test_updater_can_restore_empty_cold_container(self):
        container = MemoryContainer()
        scan.restore_signatures(container, self.root / "empty", updater=True)
        self.assertEqual(list((self.root / "empty").iterdir()), [])

    def test_updater_deletes_cld_before_restoring_only_cvd_and_state(self):
        data = {**self.snapshot, "daily.cld": self.header("daily", version=28173)}
        container = MemoryContainer(data)
        destination, removed = self.root / "cache", []
        scan.restore_signatures(container, destination, updater=True, removed_files=removed)
        self.assertFalse((destination / "daily.cld").exists())
        self.assertNotIn("daily.cld", container.data)
        self.assertTrue((destination / "daily.cvd").is_file())
        self.assertEqual(removed, ["daily.cld"])
        self.assertNotIn(("download", "daily.cld"), container.events)
        self.assertLess(container.events.index(("delete", "daily.cld")),
                        next(i for i, event in enumerate(container.events) if event[0] == "download"))
        self.assertEqual((destination / "freshclam.dat").read_bytes(), b"updater-state")
        self.assertEqual(stat.S_IMODE((destination / "main.cvd").stat().st_mode), 0o600)

    def test_scanner_run_returns_error_for_cld_container_without_running_native_tools(self):
        local = self.root / "input.pdf"
        local.write_bytes(b"abc")
        container = MemoryContainer({**self.snapshot, "daily.cld": self.header("daily")})
        output = io.StringIO()
        with patch.dict(os.environ, {"STORAGE_ACCOUNT": "stgbxtest01"}), patch.object(scan, "signature_client", return_value=container), \
             patch.object(scan, "command") as native, contextlib.redirect_stdout(output):
            code = scan.main(["--local-file", str(local)])
        result = json.loads(output.getvalue())
        self.assertEqual((code, result["verdict"]), (2, "Error"))
        self.assertEqual(result["reason"], "unsigned-cld-cache:daily.cld")
        self.assertFalse(result["signature_integrity_verified"])
        native.assert_not_called()

    def test_cld_reappearing_during_cleanup_blocks_restore(self):
        container = MemoryContainer({**self.snapshot, "daily.cld": b"bad"})
        delete = container.delete_blob
        def replace(name, **kwargs):
            delete(name, **kwargs)
            container.data[name] = b"new unsigned cache"
            container.etags[name] = '"new"'
        with patch.object(container, "delete_blob", side_effect=replace), \
             self.assertRaisesRegex(scan.ScanFailure, "unsigned-cld-cache:daily.cld"):
            scan.restore_signatures(container, self.root / "racing", updater=True)
        self.assertFalse(any(action == "download" for action, _ in container.events))

    def test_scanner_and_updater_refuse_other_database_files(self):
        for name in ("custom.ndb", "custom.ldb", "rogue.cvd", "nested/main.cvd", "notes.txt"):
            for updater in (False, True):
                with self.subTest(name=name, updater=updater):
                    container = MemoryContainer({**self.snapshot, name: b"untrusted"})
                    with self.assertRaisesRegex(scan.ScanFailure, "unexpected-signature-file"):
                        scan.restore_signatures(container, self.root / uuid.uuid4().hex, updater=updater)
                    self.assertFalse(any(action in ("download", "delete") for action, _ in container.events))

    def test_container_inventory_has_a_hard_entry_bound(self):
        container = MemoryContainer({**self.snapshot, **{f"extra-{i}.cld": b"bad" for i in range(20)}})
        with self.assertRaisesRegex(scan.ScanFailure, "signature-cache-too-many-files"):
            scan.restore_signatures(container, self.root / "many", updater=True)
        self.assertFalse(any(action in ("download", "delete") for action, _ in container.events))

    def test_cld_cleanup_is_etag_conditional_and_conflict_aborts(self):
        container = MemoryContainer({**self.snapshot, "daily.cld": b"bad"})
        original = container.etags["daily.cld"]
        with patch.object(container, "delete_blob", side_effect=ResourceModifiedError("changed")) as delete, \
             self.assertRaises(ResourceModifiedError):
            scan.restore_signatures(container, self.root / "conflict", updater=True)
        self.assertEqual(delete.call_args.kwargs["etag"], original)
        self.assertEqual(delete.call_args.kwargs["match_condition"].name, "IfNotModified")
        self.assertFalse(any(action == "download" for action, _ in container.events))

    def test_cold_updater_publishes_all_versions_and_build_times(self):
        container = MemoryContainer()
        result = self.update(container)
        self.assertTrue(result["signatures_published"])
        self.assertEqual(result["status"], "Published")
        self.assertEqual(set(container.data), set(self.snapshot))
        self.assertEqual(result["signature_version"], "main:63/daily:28172/bytecode:339")
        self.assertEqual(result["databases"]["daily"]["build_time"], scan.utc(self.now - 3600))
        self.assertEqual(set(result["databases"]), set(scan.FAMILIES))
        self.assertEqual(list((self.root / "runs").iterdir()), [])

    def test_updater_replaces_cld_only_cache_with_full_verified_cvds(self):
        data = {family + ".cld": self.header(family) for family in scan.FAMILIES}
        data["freshclam.dat"] = b"updater-state"
        container = MemoryContainer(data)
        result = self.update(container)
        self.assertEqual(set(container.data), set(self.snapshot))
        self.assertEqual(set(result["removed_files"]), {family + ".cld" for family in scan.FAMILIES})
        self.assertTrue(result["signature_integrity_verified"])
        self.assertEqual(result["verified_signature_files"], list(scan.SIGNED_DATABASES))
        self.assertTrue(all(not name.endswith(".cld") for action, name in container.events if action == "download"))

    def test_updater_preserves_all_existing_signed_cvd_blobs(self):
        container = MemoryContainer(self.snapshot)
        result = self.update(container)
        self.assertEqual(result["removed_files"], [])
        self.assertFalse(any(action == "delete" for action, _ in container.events))
        self.assertEqual(set(container.data), set(self.snapshot))

    def test_updater_budgets_leave_publication_margin(self):
        with patch.object(scan, "deadline", wraps=scan.deadline) as deadline:
            self.update(MemoryContainer())
        self.assertEqual([call.args[0] for call in deadline.call_args_list], [660, 180])

    def test_updater_does_not_publish_when_cvd_verification_fails(self):
        container = MemoryContainer(self.snapshot)
        def native(args, timeout):
            if args[0] == "sigtool":
                return subprocess.CompletedProcess(args, 1, "Verification failed.\n")
            return self.fake_refresh(args, timeout)
        output = io.StringIO()
        with patch.object(scan, "signature_client", return_value=container), patch.object(scan, "command", side_effect=native), contextlib.redirect_stdout(output):
            code = scan.main(["--update-signatures"])
        result = json.loads(output.getvalue())
        self.assertEqual((code, result["verdict"]), (2, "Error"))
        self.assertFalse(result["signatures_published"])
        self.assertFalse(result["signature_integrity_verified"])
        self.assertIn("signature-verification-failed", result["reason"])
        self.assertFalse(any(action == "upload" for action, _ in container.events))

    def test_updater_rejects_a_cld_unexpectedly_produced_by_refresh(self):
        container = MemoryContainer(self.snapshot)
        def refresh(args, timeout):
            result = self.fake_refresh(args, timeout)
            config = Path(args[1].split("=", 1)[1]).read_text()
            database = Path(config.splitlines()[0].split(" ", 1)[1])
            (database / "daily.cld").write_bytes(self.header("daily"))
            return result
        with self.assertRaisesRegex(scan.ScanFailure, "unsigned-cld-cache:daily.cld"):
            self.update(container, refresh)
        self.assertFalse(any(action == "upload" for action, _ in container.events))

    def test_failed_refresh_may_publish_still_fresh_cache_without_changing_age(self):
        container = MemoryContainer(self.snapshot)
        result = self.update(container, lambda args, timeout: subprocess.CompletedProcess(args, 11, "connection failed"))
        self.assertTrue(result["signatures_published"])
        self.assertEqual(result["refresh_exit_code"], 11)
        self.assertEqual(result["signature_date"], scan.utc(self.now - 3600))

    def test_stale_cache_is_never_published_even_if_freshclam_returns_zero(self):
        for returncode in (0, 11):
            with self.subTest(returncode=returncode):
                container = MemoryContainer({**self.snapshot, "daily.cvd": self.header("daily", age=scan.MAX_SIGNATURE_AGE + 3600)})
                with self.assertRaisesRegex(scan.ScanFailure, "signature-database-stale"):
                    self.update(container, lambda args, timeout: subprocess.CompletedProcess(args, returncode, ""))
                self.assertFalse(any(action in ("upload", "delete") for action, _ in container.events))

    def test_snapshot_aging_out_during_upload_is_not_claimed_fresh(self):
        container = MemoryContainer(self.snapshot)
        with patch.object(scan.time, "time", return_value=self.now) as clock:
            def after_upload(name):
                if name == "freshclam.dat":
                    clock.return_value = self.now + scan.MAX_SIGNATURE_AGE + 3600
            container.after_upload = after_upload
            with self.assertRaisesRegex(scan.ScanFailure, "signature-database-stale"):
                self.update(container)

    def test_missing_state_blocks_publication(self):
        container = MemoryContainer({name: data for name, data in self.snapshot.items() if name != "freshclam.dat"})
        with self.assertRaisesRegex(scan.ScanFailure, "missing-freshclam-state"):
            self.update(container, lambda args, timeout: subprocess.CompletedProcess(args, 0, ""))
        self.assertFalse(any(action == "upload" for action, _ in container.events))

    def test_partial_upload_does_not_claim_publication_or_delete_old_forms(self):
        container = MemoryContainer(self.snapshot)
        container.fail_upload = "daily.cvd"
        output = io.StringIO()
        with patch.object(scan, "signature_client", return_value=container), patch.object(scan, "command", side_effect=self.fake_command), contextlib.redirect_stdout(output):
            code = scan.main(["--update-signatures"])
        result = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertFalse(result["signatures_published"])
        self.assertEqual(result["published_files"], ["main.cvd"])
        self.assertEqual(result["status"], "Error")
        self.assertFalse(any(action == "delete" for action, _ in container.events))
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_concurrent_updater_change_is_not_overwritten(self):
        container = MemoryContainer(self.snapshot)
        def refresh(args, timeout):
            container.etags["main.cvd"] = '"changed"'
            return subprocess.CompletedProcess(args, 0, "")
        with self.assertRaises(ResourceModifiedError):
            self.update(container, refresh)
        self.assertFalse(any(action == "delete" for action, _ in container.events))

    def test_unexpected_alternate_after_publication_is_error(self):
        container = MemoryContainer(self.snapshot)
        def after_upload(name):
            if name == "daily.cvd":
                container.data["daily.cld"] = self.header("daily")
                container.etags["daily.cld"] = '"concurrent"'
        container.after_upload = after_upload
        with self.assertRaisesRegex(scan.ScanFailure, "unsigned-cld-cache:daily.cld"):
            self.update(container)

    def test_local_mode_without_storage_does_not_connect_or_refresh(self):
        local = self.root / "input.pdf"
        local.write_bytes(b"abc")
        def clean(path, work, result, database):
            result.update(verdict="No threats found", reason="scanned")
        output = io.StringIO()
        with patch.dict(os.environ, {"STORAGE_ACCOUNT": ""}), patch.object(scan, "signature_client") as cloud, \
             patch.object(scan, "command") as native, patch.object(scan, "scan_file", side_effect=clean), contextlib.redirect_stdout(output):
            code = scan.main(["--local-file", str(local)])
        self.assertEqual(code, 0)
        cloud.assert_not_called()
        native.assert_not_called()

    def test_local_mode_in_job_restores_readonly_cloud_snapshot(self):
        local = self.root / "input.pdf"
        local.write_bytes(b"abc")
        container = MemoryContainer(self.snapshot)
        def clean(path, work, result, database):
            self.assertEqual(set(p.name for p in database.iterdir()), {family + ".cvd" for family in scan.FAMILIES})
            result.update(verdict="No threats found", reason="scanned")
        output = io.StringIO()
        with patch.dict(os.environ, {"STORAGE_ACCOUNT": "stgbxtest01"}), patch.object(scan, "signature_client", return_value=container), \
             patch.object(scan, "scan_file", side_effect=clean), contextlib.redirect_stdout(output):
            code = scan.main(["--local-file", str(local)])
        self.assertEqual(code, 0)
        self.assertFalse(any(action in ("upload", "delete") for action, _ in container.events))


if __name__ == "__main__":
    unittest.main()


class QueueClientGuardTests(unittest.TestCase):
    """Exercise the real queue_client guard; only the SDK constructor is faked (it failed live on 2 Nov 2026)."""

    def make(self, name, routes=None):
        env = {"STORAGE_ACCOUNT": "stgbxtest01", "AZURE_CLIENT_ID": str(uuid.uuid4())}
        if routes is not None:
            env["GBX_ROUTES"] = routes
        captured = {}

        class FakeQueueClient:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        fake_module = types.SimpleNamespace(QueueClient=FakeQueueClient)
        with patch.dict(os.environ, env, clear=False), patch.dict(sys.modules, {"azure.storage.queue": fake_module}):
            if routes is None:
                os.environ.pop("GBX_ROUTES", None)
            scan.queue_client(name)
        return captured

    def test_source_and_every_default_route_are_permitted(self):
        for name in ("scan-jobs", "ingest-jobs", "process-jobs"):
            self.assertEqual(self.make(name)["queue_name"], name)

    def test_unlisted_queue_is_refused(self):
        with self.assertRaises(scan.ScanFailure) as raised:
            self.make("other-jobs")
        self.assertEqual(str(raised.exception), "invalid-queue-name")

    def test_route_removed_from_allowlist_is_refused(self):
        with self.assertRaises(scan.ScanFailure):
            self.make("process-jobs", routes="ingest-jobs")

    def test_invalid_allowlist_fails_closed(self):
        with self.assertRaises(scan.ScanFailure):
            self.make("process-jobs", routes="process-jobs")
