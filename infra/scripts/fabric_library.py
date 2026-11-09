"""The library in OneLake (docs/LIBRARY_ONELAKE.md): the library's clean files reach Microsoft Fabric through OneLake
shortcuts, notebooks write silver and gold Delta tables, and the OneLake files indexer publishes gold to search.

    infra/scripts/deploy.sh library               # setup, deploy, search and run, in that order (the usual way)
    python3 infra/scripts/fabric_library.py status
    python3 infra/scripts/fabric_library.py setup   # workspace identity, trusted access, lakehouse, connection, shortcuts
    python3 infra/scripts/fabric_library.py deploy  # the silver, gold and extract notebooks and the publish pipeline
    python3 infra/scripts/fabric_library.py search  # the index, data source and OneLake files indexer for gold
    python3 infra/scripts/fabric_library.py run     # silver, gold, the indexer run, verification, then the gold pointer
    python3 infra/scripts/fabric_library.py extract --sources <id,...> --max-pages 60   # extraction in Fabric, compared

The storage account keeps its public network access disabled. The Fabric workspace reads it through OneLake shortcuts
authorised by its workspace identity and admitted by a resource instance rule (Microsoft Learn, Trusted workspace access).
Silver holds every extraction the live lane's gbx-process job has written; gold holds exactly what the current publication
manifest selects, with one JSON file per published passage. The OneLake files indexer reads those files into
gbx-evidence-onelake, and `run` moves the gold pointer `Files/gold/_publication/current.json` only after the indexer has
finished with no failed item and the index holds every gold passage, matching the push index field for field. The site
reads that index when GBX_V2_LIBRARY_INDEX names it, which `deploy.sh library` sets once a run has passed.

Every value comes from infra/config/environment.env and the foundation's outputs, which infra/scripts/deploy.sh exports, so
run the commands through `deploy.sh library` or with those variables set. Every command is idempotent. The signed-in Azure
CLI account must be an admin of the Fabric workspace, may change the storage account's network rules and deploy role
assignments in rg-geobasin-data, and may manage the search service. If the capacity is paused, resume it first.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ingestion-framework"))

from ontology_ingest.auth import FABRIC_RESOURCE, STORAGE_RESOURCE, AzureCliTokenProvider  # noqa: E402
from ontology_ingest.fabric import FabricClient  # noqa: E402
from ontology_ingest.notebooks import CODE_CELL_METADATA, DEFAULT_KERNEL_METADATA  # noqa: E402
from ontology_ingest.onelake import OneLakeClient  # noqa: E402

def _setting(name: str) -> str:
    return os.environ.get(name, "").strip()


TENANT = _setting("GBX_TENANT_ID")
SUB = _setting("GBX_SUBSCRIPTION_ID")
WORKSPACE = _setting("GBX_FABRIC_WORKSPACE_ID")
STORAGE_ACCOUNT, STORAGE_RG = _setting("GBX_STORAGE_ACCOUNT"), "rg-geobasin-data"
SEARCH_SERVICE, SEARCH_RG = _setting("GBX_SEARCH_NAME"), "rg-geobasin-ai"
SEARCH = f"https://{SEARCH_SERVICE}.search.windows.net"
SEARCH_API = "api-version=2026-04-01"
# The extract notebook calls Document Intelligence and the platform Foundry account's embedding deployment (gbx-embed).
DOCINTEL_ENDPOINT = _setting("GBX_DOCINTEL_ENDPOINT").rstrip("/")
FOUNDRY_ENDPOINT = _setting("GBX_FOUNDRY_ENDPOINT").rstrip("/")
REQUIRED = ("GBX_TENANT_ID", "GBX_SUBSCRIPTION_ID", "GBX_FABRIC_WORKSPACE_ID", "GBX_STORAGE_ACCOUNT", "GBX_SEARCH_NAME",
            "GBX_DOCINTEL_ENDPOINT", "GBX_FOUNDRY_ENDPOINT")
LAKEHOUSE = "geobasin_library_lh"
CONNECTION = "gbx-library-blob-workspace-identity"
SHORTCUTS = ("raw", "processed", "manifests")
PUSH_INDEX, INDEX = "gbx-evidence-v2", "gbx-evidence-onelake"
DATASOURCE = INDEXER = "gbx-library-gold"
EVIDENCE_FOLDER = "gold/evidence"
POINTER = "gold/_publication/current.json"
NOTHING_PUBLISHED = 3  # run's exit code when no manifest exists yet; deploy.sh library treats it as nothing to do
NOTEBOOKS = {"silver": "geobasin_library silver", "gold": "geobasin_library gold", "extract": "geobasin_library extract"}
PIPELINE = "geobasin_library publish"
ARM = "https://management.azure.com"
LIBRARY_SOURCE = ROOT / "ingestion-framework" / "ontology_ingest" / "library.py"
FABRIC_RULE = f"/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/Fabric/providers/Microsoft.Fabric/workspaces/{WORKSPACE}"
ACCESS_TEMPLATE = ROOT / "infra" / "bicep" / "library-access.bicep"

_tokens: dict[str, AzureCliTokenProvider] = {}


def token(resource: str) -> str:
    return _tokens.setdefault(resource, AzureCliTokenProvider(resource)).get_token()


def call(method: str, url: str, body: Any = None, resource: str = ARM, timeout: int = 120,
         headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], Any]:
    """Returns (status, lower-cased headers, parsed JSON or None); never raises for an HTTP status."""
    h = {"Authorization": f"Bearer {token(resource)}", "Accept": "application/json", **(headers or {})}
    data = json.dumps(body).encode() if body is not None else (b"" if method in {"POST", "PUT", "PATCH"} else None)
    if body is not None:
        h["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=timeout) as r:
            status, rh, raw = r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        status, rh, raw = e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    try:
        return status, rh, json.loads(raw) if raw else None
    except ValueError:
        return status, rh, raw.decode("utf-8", "replace")


def need(ok: bool, what: str, detail: Any = "") -> None:
    if not ok:
        sys.exit(f"{what}: {detail}" if detail != "" else what)


def fabric() -> FabricClient:
    return FabricClient(WORKSPACE, AzureCliTokenProvider(FABRIC_RESOURCE), operation_timeout=7200, poll_interval=10, max_polls=900)


def fabric_url(path: str) -> str:
    return f"{FABRIC_RESOURCE}/v1{path}"


def workspace_identity(provision: bool) -> dict[str, Any] | None:
    status, _, body = call("GET", fabric_url(f"/workspaces/{WORKSPACE}"), resource=FABRIC_RESOURCE)
    need(status == 200, "The workspace could not be read", body)
    if body.get("workspaceIdentity") or not provision:
        return body.get("workspaceIdentity")
    status, headers, body = call("POST", fabric_url(f"/workspaces/{WORKSPACE}/provisionIdentity"), resource=FABRIC_RESOURCE)
    need(status in (200, 202), "The workspace identity could not be provisioned", body)
    for _ in range(60):
        if status == 200 or not headers.get("location"):
            break
        time.sleep(5)
        status, _, op = call("GET", headers["location"], resource=FABRIC_RESOURCE)
        if isinstance(op, dict) and op.get("status") in {"Succeeded", "Failed"}:
            need(op["status"] == "Succeeded", "Provisioning the workspace identity failed", op)
            break
    return workspace_identity(False)


def workspace_role(principal_id: str, role: str) -> None:
    status, _, body = call("GET", fabric_url(f"/workspaces/{WORKSPACE}/roleAssignments"), resource=FABRIC_RESOURCE)
    need(status == 200, "Workspace roles could not be read", body)
    if any(r["principal"]["id"] == principal_id for r in body["value"]):
        return
    status, _, body = call("POST", fabric_url(f"/workspaces/{WORKSPACE}/roleAssignments"), resource=FABRIC_RESOURCE,
                           body={"principal": {"id": principal_id, "type": "ServicePrincipal"}, "role": role})
    need(status in (200, 201), f"The {role} role could not be granted", body)


def storage_rule_present() -> bool:
    url = f"{ARM}/subscriptions/{SUB}/resourceGroups/{STORAGE_RG}/providers/Microsoft.Storage/storageAccounts/{STORAGE_ACCOUNT}?api-version=2025-06-01"
    status, _, body = call("GET", url)
    need(status == 200, "The storage account could not be read", body)
    props = body["properties"]
    need(props.get("publicNetworkAccess") == "Disabled", "The storage account must keep public network access disabled",
         props.get("publicNetworkAccess"))
    return any(r.get("resourceId", "").lower() == FABRIC_RULE.lower() for r in props.get("networkAcls", {}).get("resourceAccessRules", []))


def lakehouse(client: FabricClient, create: bool) -> dict[str, Any] | None:
    found = client.find_item(LAKEHOUSE, "Lakehouse")
    if found or not create:
        return found
    status, _, body = call("POST", fabric_url(f"/workspaces/{WORKSPACE}/lakehouses"), resource=FABRIC_RESOURCE, body={
        "displayName": LAKEHOUSE, "creationPayload": {"enableSchemas": True},
        "description": "GeoBasin version 2 library in OneLake: bronze shortcuts to the clean files, silver and gold Delta tables, "
                       "and the gold evidence files the OneLake files indexer reads (docs/v2/LIBRARY_ONELAKE.md)."})
    need(status in (200, 201, 202), "The library lakehouse could not be created", body)
    for _ in range(30):
        found = client.find_item(LAKEHOUSE, "Lakehouse")
        if found:
            return found
        time.sleep(5)
    sys.exit("The library lakehouse did not appear")


def connection(create: bool) -> dict[str, Any] | None:
    status, _, body = call("GET", fabric_url("/connections"), resource=FABRIC_RESOURCE)
    need(status == 200, "Connections could not be listed", body)
    found = next((c for c in body["value"] if c.get("displayName") == CONNECTION), None)
    if found or not create:
        return found
    status, _, body = call("POST", fabric_url("/connections"), resource=FABRIC_RESOURCE, body={
        "connectivityType": "ShareableCloud", "displayName": CONNECTION, "privacyLevel": "Organizational",
        "connectionDetails": {"type": "AzureBlobs", "creationMethod": "AzureBlobs", "parameters": [
            {"dataType": "Text", "name": "account", "value": STORAGE_ACCOUNT},
            {"dataType": "Text", "name": "domain", "value": "blob.core.windows.net"}]},
        # The connection test runs at creation, so a missing rule or role fails here rather than in a notebook.
        "credentialDetails": {"singleSignOnType": "None", "connectionEncryption": "NotEncrypted", "skipTestConnection": False,
                              "credentials": {"credentialType": "WorkspaceIdentity"}}})
    need(status in (200, 201), "The workspace-identity connection could not be created", body)
    return body


def shortcuts(lakehouse_id: str, connection_id: str | None) -> list[str]:
    base = fabric_url(f"/workspaces/{WORKSPACE}/items/{lakehouse_id}/shortcuts")
    status, _, body = call("GET", base, resource=FABRIC_RESOURCE)
    need(status == 200, "Shortcuts could not be listed", body)
    have = {f"{s['path'].strip('/')}/{s['name']}" for s in body.get("value", [])}  # the listing returns "/Files/bronze"
    if connection_id:
        for name in SHORTCUTS:
            if f"Files/bronze/{name}" in have:
                continue
            status, _, made = call("POST", base + "?shortcutConflictPolicy=Abort", resource=FABRIC_RESOURCE, body={
                "path": "Files/bronze", "name": name, "target": {"azureBlobStorage": {
                    "location": f"https://{STORAGE_ACCOUNT}.blob.core.windows.net", "subpath": f"/{name}",
                    "connectionId": connection_id}}})
            need(status in (200, 201), f"The {name} shortcut could not be created", made)
            have.add(f"Files/bronze/{name}")
    return sorted(have)


def onelake(lakehouse_id: str) -> OneLakeClient:
    return OneLakeClient(WORKSPACE, lakehouse_id, AzureCliTokenProvider(STORAGE_RESOURCE))


def read_file(lakehouse_id: str, path: str) -> bytes | None:
    try:
        return onelake(lakehouse_id).read_bytes(path)
    except Exception as error:  # a missing file is an answer, not a failure
        if "404" in str(error) or "PathNotFound" in str(error):
            return None
        raise


# ---------------------------------------------------------------------------------------------------------------- notebooks

SILVER = r'''import concurrent.futures as cf
import datetime
import json
import os
import traceback

import pyarrow as pa
from deltalake import DeltaTable, write_deltalake
from deltalake.exceptions import TableNotFoundError

FILES = "/lakehouse/default/Files"
PROCESSED = FILES + "/bronze/processed"
TABLES = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Tables"
SCHEMAS = arrow_schemas()
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

def options():
    return {"bearer_token": notebookutils.credentials.getToken("storage"), "use_fabric_endpoint": "true"}

def uri(name):
    schema, table = name.split(".")
    return f"{TABLES}/{schema}/{table}"

def table(name):
    try:
        return DeltaTable(uri(name), storage_options=options())
    except TableNotFoundError:
        return None

def read_json(path):
    with open(f"{PROCESSED}/{path}", "rb") as f:
        return json.loads(f.read())

def listdir(path):
    try:
        return sorted(os.listdir(path))
    except FileNotFoundError:
        return []

def bundles():
    root = PROCESSED + "/sources"
    for source in listdir(root):
        for sha in listdir(f"{root}/{source}"):
            for version in listdir(f"{root}/{source}/{sha}"):
                path = f"sources/{source}/{sha}/{version}/extraction.json"
                if bundle_ref(path) and os.path.isfile(f"{PROCESSED}/{path}"):
                    yield path

def load(path):
    bundle = read_json(path)
    wanted = [p for d in bundle.get("documents", []) for p in d.get("pages", []) + d.get("chunks", [])]
    with cf.ThreadPoolExecutor(16) as pool:
        files = dict(zip(wanted, pool.map(lambda p: read_json(p) if isinstance(p, str) and ".." not in p else None, wanted)))
    return silver_extraction(bundle, path, files.get, loaded_at=now)

def append(name, rows):
    if rows:
        write_deltalake(uri(name), pa.Table.from_pylist(rows, schema=SCHEMAS[name]), mode="append", storage_options=options())

try:
    existing = table("silver.documents")
    known = set(existing.to_pyarrow_table(columns=["extractionKey"]).column("extractionKey").to_pylist()) if existing else set()
    found = list(bundles())
    new = [p for p in found if extraction_key(bundle_ref(p)) not in known]
    written = {"documents": 0, "pages": 0, "chunks": 0}
    # Ten extractions at a time keep the vectors in memory bounded. Pages and chunks are written before their documents, and
    # a rerun first deletes any pages and chunks a failed batch left behind, so silver.documents marks complete extractions.
    for start in range(0, len(new), 10):
        batch = [load(p) for p in new[start:start + 10]]
        keys = sorted({r["extractionKey"] for b in batch for r in b["documents"]})
        for name in ("silver.pages", "silver.chunks"):
            existing_table = table(name)
            if existing_table and keys:
                existing_table.delete("extractionKey IN (" + ", ".join(f"'{k}'" for k in keys) + ")")
            append(name, [r for b in batch for r in b[name.split(".")[1]]])
        append("silver.documents", [r for b in batch for r in b["documents"]])
        for part in written:
            written[part] += sum(len(b[part]) for b in batch)
    summary = {"step": "silver", "extractions": len(found), "alreadyInSilver": len(found) - len(new), "added": written, "at": now}
except Exception as error:
    if raise_errors.strip().lower() == "true":
        raise
    summary = {"step": "silver", "error": {"type": type(error).__name__, "message": str(error)[:4000],
                                            "traceback": traceback.format_exc()[-3000:]}}
notebookutils.notebook.exit(json.dumps(summary))
'''

GOLD = r'''import datetime
import json
import os
import traceback

import pyarrow as pa
import pyarrow.compute as pc
from deltalake import DeltaTable, write_deltalake
from deltalake.exceptions import TableNotFoundError

FILES = "/lakehouse/default/Files"
MANIFESTS = FILES + "/bronze/manifests"
TABLES = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Tables"
SCHEMAS = arrow_schemas()
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

def options():
    return {"bearer_token": notebookutils.credentials.getToken("storage"), "use_fabric_endpoint": "true"}

def uri(name):
    schema, table = name.split(".")
    return f"{TABLES}/{schema}/{table}"

def read_json(path):
    with open(path, "rb") as f:
        return json.loads(f.read())

def onelake_names(directory):
    """File names in a Files folder, listed through the OneLake DFS API; the mount's listing of a shortcut can come back short."""
    import urllib.parse, urllib.request
    names, query = [], {"resource": "filesystem", "recursive": "false", "directory": f"{lakehouse_id}/Files/{directory}"}
    while True:
        request = urllib.request.Request(f"https://onelake.dfs.fabric.microsoft.com/{workspace_id}?" + urllib.parse.urlencode(query),
            headers={"Authorization": "Bearer " + notebookutils.credentials.getToken("storage"), "x-ms-version": "2023-11-03"})
        with urllib.request.urlopen(request, timeout=120) as response:
            body, continuation = json.loads(response.read()), response.headers.get("x-ms-continuation")
        names += [p["name"].rsplit("/", 1)[1] for p in body.get("paths", []) if str(p.get("isDirectory", "false")).lower() != "true"]
        if not continuation:
            return sorted(names)
        query["continuation"] = continuation

def rows(name, keys):
    dataset = DeltaTable(uri(name), storage_options=options()).to_pyarrow_dataset()
    return dataset.to_table(filter=pc.field("extractionKey").isin(keys)).to_pylist()

def overwrite(name, records, schema):
    write_deltalake(uri(name), pa.Table.from_pylist(records, schema=schema), mode="overwrite", storage_options=options())

try:
    current = check_manifest(read_json(f"{MANIFESTS}/current.json"), "current.json")
    names = [n for n in onelake_names("bronze/manifests") if MANIFEST_PATH.fullmatch(n)]
    history = [check_manifest(read_json(f"{MANIFESTS}/{name}"), name) for name in names]
    # Every version up to the current one is kept as immutable history, so a short listing is an error, not a smaller run.
    missing = set(range(1, current["manifestVersion"] + 1)) - {m["manifestVersion"] for m in history}
    if missing:
        raise LibraryError(f"Manifest history is missing {len(missing)} versions, such as v{min(missing)}")
    keys = [extraction_key(s) for s in current["sources"]]
    gold = gold_publication(current, rows("silver.documents", keys), rows("silver.chunks", keys),
                            first_published_versions(history + [current]), written_at=now)
    overwrite("gold.sources", gold["sources"], SCHEMAS["gold.sources"])
    overwrite("gold.documents", gold["documents"], SCHEMAS["gold.documents"])
    overwrite("gold.chunks", gold["chunks"], gold_chunk_schema())
    # One file per published passage. A file whose bytes are already right is left alone, so the indexer's change detection
    # sees only new or corrected passages; a file a failed run cut short, or one whose provenance changed, is written again.
    written = 0
    for chunk in gold["chunks"]:
        data = evidence_bytes(chunk)
        path = f"{FILES}/{evidence_path(chunk)}"
        if os.path.isfile(path) and os.path.getsize(path) == len(data):
            with open(path, "rb") as f:
                if f.read() == data:
                    continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        written += 1
    try:
        published = set(DeltaTable(uri("gold.publications"), storage_options=options()).to_pyarrow_table(
            columns=["manifestVersion"]).column("manifestVersion").to_pylist())
    except TableNotFoundError:
        published = set()
    if current["manifestVersion"] not in published:
        write_deltalake(uri("gold.publications"), pa.Table.from_pylist([{
            "manifestVersion": current["manifestVersion"], "createdAt": current["createdAt"], "sources": len(gold["sources"]),
            "documents": len(gold["documents"]), "chunks": len(gold["chunks"]), "newEvidenceFiles": written, "writtenAt": now}],
            schema=SCHEMAS["gold.publications"]), mode="append", storage_options=options())
    summary = {"step": "gold", "manifestVersion": current["manifestVersion"], "sources": len(gold["sources"]),
               "documents": len(gold["documents"]), "chunks": len(gold["chunks"]), "newEvidenceFiles": written,
               "manifestsRead": len(history), "at": now}
except Exception as error:
    if raise_errors.strip().lower() == "true":
        raise
    summary = {"step": "gold", "error": {"type": type(error).__name__, "message": str(error)[:4000],
                                          "traceback": traceback.format_exc()[-3000:]}}
notebookutils.notebook.exit(json.dumps(summary))
'''

EXTRACT = r'''import datetime
import hashlib
import io
import json
import os
import time
import traceback
import urllib.error
import urllib.request
import zipfile

import pyarrow as pa
import pyarrow.compute as pc
from deltalake import DeltaTable, write_deltalake

FILES = "/lakehouse/default/Files"
TABLES = f"abfss://{workspace_id}@onelake.dfs.fabric.microsoft.com/{lakehouse_id}/Tables"
DI = docintel_endpoint.rstrip("/") + "/documentintelligence/documentModels/prebuilt-layout"
EMBED = foundry_endpoint.rstrip("/") + "/openai/deployments/gbx-embed/embeddings?api-version=2024-10-21"
SCHEMAS = arrow_schemas()
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

def options():
    return {"bearer_token": notebookutils.credentials.getToken("storage"), "use_fabric_endpoint": "true"}

def uri(name):
    schema, table = name.split(".")
    return f"{TABLES}/{schema}/{table}"

def ai(method, url, body=None, content_type="application/json"):
    """Document Intelligence and the embedding model, as the notebook's run-as person, with Azure's retry advice on 429."""
    for attempt in range(8):
        request = urllib.request.Request(url, data=body, method=method, headers={
            "Authorization": "Bearer " + notebookutils.credentials.getToken("https://cognitiveservices.azure.com"),
            "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 503) or attempt == 7:
                raise RuntimeError(f"{method} {url.split('?')[0]} failed with HTTP {error.code}: {error.read()[:300]!r}") from None
            time.sleep(min(60, float(error.headers.get("retry-after-ms", 0)) / 1000 or float(error.headers.get("retry-after", 2 ** attempt))))

def analyze(pdf):
    _, headers, _ = ai("POST", DI + ":analyze?api-version=2024-11-30&stringIndexType=utf16CodeUnit", pdf, "application/octet-stream")
    location = headers.get("Operation-Location") or headers.get("operation-location")
    if not location or not location.startswith(DI + "/analyzeResults/"):
        raise LibraryError("Unexpected analysis operation location")
    for _ in range(720):
        _, headers, body = ai("GET", location)
        result = json.loads(body)
        if result["status"] == "succeeded":
            return result["analyzeResult"]
        if result["status"] in ("failed", "canceled"):
            raise LibraryError(f"Layout analysis {result['status']}")
        time.sleep(float(headers.get("Retry-After") or headers.get("retry-after") or 2))
    raise LibraryError("Layout analysis did not finish within an hour")

def embed(texts):
    vectors = []
    for start in range(0, len(texts), 64):
        _, _, body = ai("POST", EMBED, json.dumps({"input": texts[start:start + 64]}).encode())
        data = sorted(json.loads(body)["data"], key=lambda d: d["index"])
        vectors += [d["embedding"] for d in data]
    if len(vectors) != len(texts) or any(len(v) != LIVE_VECTOR_DIMENSIONS for v in vectors):
        raise LibraryError("Embedding response is incomplete")
    return vectors

def pdf_bytes(document):
    """The document's own PDF, from the clean file the bronze shortcut exposes, checked against its recorded hash."""
    with open(f"{FILES}/bronze/raw/{document['rawBlob']}", "rb") as f:
        raw = f.read()
    if document["memberName"]:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            raw = archive.read(document["memberName"])
    if hashlib.sha256(raw).hexdigest() != document["documentSha256"]:
        raise LibraryError(f"{document['docId']}: bytes differ from the recorded document hash")
    return raw

def rows(name, column, values):
    return DeltaTable(uri(name), storage_options=options()).to_pyarrow_dataset().to_table(filter=pc.field(column).isin(values)).to_pylist()

try:
    with open(f"{FILES}/bronze/manifests/current.json", "rb") as f:
        current = check_manifest(json.loads(f.read()))
    wanted = {s.strip() for s in sources.split(",") if s.strip()}
    selected = [s for s in current["sources"] if not wanted or s["sourceId"] in wanted]
    if wanted - {s["sourceId"] for s in selected}:
        raise LibraryError(f"Not in the current manifest: {sorted(wanted - {s['sourceId'] for s in selected})}")
    keys = [extraction_key(s) for s in selected]
    documents = rows("silver.documents", "extractionKey", keys)
    pages_needed = sum(d["pageCount"] for d in documents)
    if int(max_pages) and pages_needed > int(max_pages):
        raise LibraryError(f"{pages_needed} pages exceed max_pages={max_pages}; raise it deliberately to extract more")
    reference = rows("silver.chunks", "extractionKey", keys)
    by_source = {s["sourceId"]: s for s in selected}
    fabric_pages, fabric_chunks, parity = [], [], []
    for document in sorted(documents, key=lambda d: (d["sourceId"], d["documentSha256"])):
        source, began = by_source[document["sourceId"]], time.time()
        mine = [c for c in reference if c["extractionKey"] == document["extractionKey"] and c["documentSha256"] == document["documentSha256"]]
        geo = {k: mine[0][k] for k in ("points", "places", "placeHow", "geoBasins", "geotag", "basin", "well")}
        result = analyze(pdf_bytes(document))
        layout_path = f"{FILES}/silver/layout/{document['extractionKey']}/{document['documentSha256']}.json"
        os.makedirs(os.path.dirname(layout_path), exist_ok=True)
        with open(layout_path, "w") as f:
            json.dump(result, f)
        ref = {k: document[k] for k in ("sourceId", "sha256", "extractionVersion", "documentSha256", "docId")}
        out = normalize_layout(result, ref, geo, licence=source["licence"], attribution=source["attribution"])
        for chunk, vector in zip(out["chunks"], embed([c["text"] for c in out["chunks"]])):
            chunk["vector"] = vector
        report = chunk_parity(mine, out["chunks"])
        parity.append({"extractionKey": document["extractionKey"], "sourceId": document["sourceId"], "documentSha256": document["documentSha256"],
                       "title": document["title"], "pages": len(out["pages"]), "referencePages": document["pageCount"],
                       "referenceChunks": report["referenceChunks"], "fabricChunks": report["candidateChunks"],
                       "matchingText": report["matching"]["text"], "matchingHeadings": report["matching"]["headingPath"],
                       "matchingRegions": report["matching"]["regions"], "minCosine": report["minCosine"],
                       "equivalent": report["equivalent"] and len(out["pages"]) == document["pageCount"],
                       "seconds": round(time.time() - began, 1), "extractor": FABRIC_EXTRACTOR, "extractedAt": now})
        fabric_pages += out["pages"]
        fabric_chunks += out["chunks"]
    parity_schema = pa.schema([("extractionKey", pa.string()), ("sourceId", pa.string()), ("documentSha256", pa.string()),
        ("title", pa.string()), ("pages", pa.int64()), ("referencePages", pa.int64()), ("referenceChunks", pa.int64()),
        ("fabricChunks", pa.int64()), ("matchingText", pa.int64()), ("matchingHeadings", pa.int64()), ("matchingRegions", pa.int64()),
        ("minCosine", pa.float64()), ("equivalent", pa.bool_()), ("seconds", pa.float64()), ("extractor", pa.string()), ("extractedAt", pa.string())])
    for name, records, schema in (("silver.fabric_pages", fabric_pages, SCHEMAS["silver.pages"]),
                                  ("silver.fabric_chunks", fabric_chunks, SCHEMAS["silver.chunks"]),
                                  ("silver.extraction_parity", parity, parity_schema)):
        if records:
            write_deltalake(uri(name), pa.Table.from_pylist(records, schema=schema), mode="append", storage_options=options())
    summary = {"step": "extract", "manifestVersion": current["manifestVersion"], "documents": len(parity), "pages": len(fabric_pages),
               "chunks": len(fabric_chunks), "equivalent": sum(p["equivalent"] for p in parity),
               "parity": [{k: p[k] for k in ("sourceId", "title", "pages", "referenceChunks", "fabricChunks", "matchingText", "minCosine", "equivalent", "seconds")} for p in parity],
               "at": now}
except Exception as error:
    if raise_errors.strip().lower() == "true":
        raise
    summary = {"step": "extract", "error": {"type": type(error).__name__, "message": str(error)[:4000],
                                             "traceback": traceback.format_exc()[-3000:]}}
notebookutils.notebook.exit(json.dumps(summary))
'''

DESCRIPTIONS = {
    "silver": ("# Library silver\n\nRead every extraction that `gbx-process` wrote, through the bronze shortcut to the closed "
               "storage account, check each page and chunk as the live publisher does, and append the new extractions to "
               "`silver.documents`, `silver.pages` and `silver.chunks` (docs/v2/LIBRARY_ONELAKE.md).\n"),
    "gold": ("# Library gold\n\nRead the current publication manifest and its history through the bronze shortcut, bind every "
             "selected extraction to silver, rewrite `gold.sources`, `gold.documents` and `gold.chunks`, and write one evidence "
             "file per published passage for the OneLake files indexer (decision D5).\n"),
    "extract": ("# Library extraction in Fabric\n\nDecision D4: read each selected document's clean bytes through the bronze shortcut, "
                "analyse them with Document Intelligence's layout model and embed the chunks as the notebook's run-as person, "
                "with no key, then compare every chunk with what `gbx-process` produced and write `silver.fabric_pages`, "
                "`silver.fabric_chunks` and `silver.extraction_parity`.\n"),
}


def _cell(source: str, *, parameters: bool = False) -> dict[str, Any]:
    import hashlib
    metadata = json.loads(json.dumps(CODE_CELL_METADATA))
    if parameters:
        metadata["tags"] = ["parameters"]
    return {"id": "code-" + hashlib.sha256(source.encode()).hexdigest()[:16], "cell_type": "code", "execution_count": None,
            "metadata": metadata, "outputs": [], "source": source.splitlines(keepends=True)}


def build_notebook(step: str, lakehouse_id: str) -> dict[str, Any]:
    """A Python (non-Spark) notebook: parameters, the library module embedded verbatim, then the step itself."""
    parameters = (f"workspace_id = {json.dumps(WORKSPACE)}\nlakehouse_id = {json.dumps(lakehouse_id)}\n"
                  "raise_errors = \"false\"\n" + (f"sources = \"\"\nmax_pages = \"60\"\ndocintel_endpoint = {json.dumps(DOCINTEL_ENDPOINT)}\n"
                     f"foundry_endpoint = {json.dumps(FOUNDRY_ENDPOINT)}\n" if step == "extract" else ""))
    library = LIBRARY_SOURCE.read_text(encoding="utf-8").replace("from __future__ import annotations\n", "")
    metadata = json.loads(json.dumps(DEFAULT_KERNEL_METADATA))
    metadata["dependencies"] = {"lakehouse": {"default_lakehouse": lakehouse_id, "default_lakehouse_name": LAKEHOUSE,
                                              "default_lakehouse_workspace_id": WORKSPACE}}
    return {"nbformat": 4, "nbformat_minor": 5, "metadata": metadata, "cells": [
        {"id": "description", "cell_type": "markdown", "metadata": {}, "source": DESCRIPTIONS[step].splitlines(keepends=True)},
        _cell(parameters, parameters=True), _cell(library), _cell({"silver": SILVER, "gold": GOLD, "extract": EXTRACT}[step])]}


def build_pipeline(notebook_ids: dict[str, str], lakehouse_id: str) -> dict[str, Any]:
    def activity(name: str, notebook_id: str, after: str | None) -> dict[str, Any]:
        return {"name": name, "type": "TridentNotebook",
                "dependsOn": [{"activity": after, "dependencyConditions": ["Succeeded"]}] if after else [],
                "policy": {"timeout": "0.02:00:00", "retry": 0, "retryIntervalInSeconds": 30, "secureOutput": False, "secureInput": False},
                "typeProperties": {"notebookId": notebook_id, "workspaceId": WORKSPACE, "parameters": {
                    "workspace_id": {"value": WORKSPACE, "type": "string"}, "lakehouse_id": {"value": lakehouse_id, "type": "string"},
                    "raise_errors": {"value": "true", "type": "string"}}}}
    return {"properties": {
        "description": "The library in OneLake: silver from every extraction, then gold from the current publication manifest "
                       "(docs/v2/LIBRARY_ONELAKE.md). fabric_library.py run then runs the OneLake files indexer and moves the gold pointer.",
        "activities": [activity("Build silver", notebook_ids["silver"], None),
                       activity("Build gold", notebook_ids["gold"], "Build silver")]}}


# ------------------------------------------------------------------------------------------------------------------- search

def search(method: str, path: str, body: Any = None, timeout: int = 120) -> tuple[int, Any]:
    sep = "&" if "?" in path else "?"
    status, _, data = call(method, f"{SEARCH}{path}{sep}{SEARCH_API}", body=body, resource="https://search.azure.com",
                           timeout=timeout)
    return status, data


def search_identity() -> str:
    url = f"{ARM}/subscriptions/{SUB}/resourceGroups/{SEARCH_RG}/providers/Microsoft.Search/searchServices/{SEARCH_SERVICE}?api-version=2025-05-01"
    status, _, body = call("GET", url)
    need(status == 200, "The search service could not be read", body)
    principal = (body.get("identity") or {}).get("principalId")
    if principal:
        return principal
    status, _, body = call("PATCH", url, body={"identity": {"type": "SystemAssigned"}})
    need(status in (200, 201, 202), "The search service's managed identity could not be turned on", body)
    for _ in range(30):
        status, _, body = call("GET", url)
        principal = (body.get("identity") or {}).get("principalId")
        if principal:
            return principal
        time.sleep(5)
    sys.exit("The search service's managed identity did not appear")


def ensure_search(lakehouse_id: str) -> None:
    principal = search_identity()
    # Learn: the search service's identity needs at least the Contributor role on the workspace for the OneLake files indexer.
    workspace_role(principal, "Contributor")
    status, push = search("GET", f"/indexes/{PUSH_INDEX}")
    need(status == 200, "The push index could not be read", push)
    index = {k: v for k, v in push.items() if not k.startswith("@odata")}
    index["name"] = INDEX
    status, body = search("PUT", f"/indexes/{INDEX}", index)
    need(status in (200, 201, 204), "The OneLake-fed index could not be created", body)
    status, body = search("PUT", f"/datasources/{DATASOURCE}", {
        "name": DATASOURCE, "type": "onelake",
        "description": "Gold evidence files in the GeoBasin library lakehouse (docs/v2/LIBRARY_ONELAKE.md)",
        "credentials": {"connectionString": f"ResourceId={WORKSPACE}"},
        "container": {"name": lakehouse_id, "query": EVIDENCE_FOLDER}})
    need(status in (200, 201, 204), "The OneLake data source could not be created", body)
    status, body = search("PUT", f"/indexers/{INDEXER}", {
        "name": INDEXER, "dataSourceName": DATASOURCE, "targetIndexName": INDEX,
        "description": "Feeds gbx-evidence-onelake from gold; run on demand by fabric_library.py run (decision D5)",
        # A run counts as a success while its errors stay under these limits, so no failed item is tolerated.
        "parameters": {"maxFailedItems": 0, "maxFailedItemsPerBatch": 0, "configuration": {
            "parsingMode": "json", "dataToExtract": "contentAndMetadata", "indexedFileNameExtensions": ".json"}},
        "fieldMappings": [], "outputFieldMappings": []})
    need(status in (200, 201, 204), "The OneLake files indexer could not be created", body)


def indexer_status() -> dict[str, Any]:
    status, body = search("GET", f"/indexers/{INDEXER}/status")
    need(status == 200, "The indexer status could not be read", body)
    return body


def run_indexer(timeout: int = 3600) -> dict[str, Any]:
    before = (indexer_status().get("lastResult") or {}).get("startTime")
    status, body = search("POST", f"/indexers/{INDEXER}/run")
    need(status in (200, 202, 204), "The indexer could not be started", body)
    began = time.time()
    while time.time() - began < timeout:
        time.sleep(10)
        last = indexer_status().get("lastResult") or {}
        if last.get("startTime") == before or last.get("status") == "inProgress":
            continue
        return last
    sys.exit("The indexer run did not finish in time")


def tuple_filter(sources: list[dict[str, Any]]) -> str:
    return " or ".join(f"(sourceId eq '{s['sourceId']}' and sha256 eq '{s['sha256']}' and extractionVersion eq '{s['extractionVersion']}')"
                       for s in sources)


def count(index: str, filter_text: str) -> int:
    total = 0
    sources = filter_text.split(" or ")
    for start in range(0, len(sources), 20):  # keep each filter well inside the request size limit
        status, body = search("POST", f"/indexes/{index}/docs/search",
                              {"search": "*", "filter": " or ".join(sources[start:start + 20]), "count": True, "top": 0})
        need(status == 200, f"{index} could not be counted", body)
        total += body["@odata.count"]
    return total


def verify(manifest: dict[str, Any]) -> dict[str, Any]:
    """The OneLake-fed index must hold exactly the gold passages, matching the push index field for field for every source."""
    expected = sum(d["chunkCount"] for s in manifest["sources"] for d in s["documents"])
    selection = tuple_filter(manifest["sources"])
    onelake_count, push_count = count(INDEX, selection), count(PUSH_INDEX, selection)
    fields = ["id", "page", "text", "headingPath", "documentSha256", "docId", "licence", "geotag", "basin", "well", "manifestVersion",
              "places", "geoBasins", "publishAllowed", "visibility", "owner"]
    mismatched = []
    for s in manifest["sources"]:
        flt = tuple_filter([s])
        _, a = search("POST", f"/indexes/{INDEX}/docs/search", {"search": "*", "filter": flt, "select": ",".join(fields), "top": 1000})
        _, b = search("POST", f"/indexes/{PUSH_INDEX}/docs/search", {"search": "*", "filter": flt, "select": ",".join(fields), "top": 1000})
        left, right = ({d["id"]: d for d in x.get("value", [])} for x in (a, b))
        mismatched += [i for i in set(left) | set(right) if {k: left.get(i, {}).get(k) for k in fields} != {k: right.get(i, {}).get(k) for k in fields}]
    return {"manifestVersion": manifest["manifestVersion"], "expectedChunks": expected, "onelakeIndex": onelake_count,
            "pushIndex": push_count, "mismatchedPassages": len(mismatched), "firstMismatches": sorted(mismatched)[:5], "ok": onelake_count == expected and not mismatched}


# ----------------------------------------------------------------------------------------------------------------- commands

def cmd_setup(_: argparse.Namespace) -> None:
    identity = workspace_identity(provision=True)
    print(f"workspace identity  {identity['applicationId']} (service principal {identity['servicePrincipalId']})")
    # Learn's prerequisites for trusted workspace access give the workspace identity the Contributor role on its workspace.
    workspace_role(identity["servicePrincipalId"], "Contributor")
    if not storage_rule_present():
        # The next foundation deployment keeps this rule, because main.bicepparam passes GBX_FABRIC_WORKSPACE_ID to data.bicep.
        subprocess.run(["az", "storage", "account", "network-rule", "add", "--subscription", SUB, "-g", STORAGE_RG,
                        "--account-name", STORAGE_ACCOUNT, "--tenant-id", TENANT, "--resource-id", FABRIC_RULE, "-o", "none"], check=True)
    need(storage_rule_present(), "The storage account still has no resource instance rule for the workspace")
    print("trusted access      resource instance rule present; public network access stays Disabled")
    subprocess.run(["az", "deployment", "group", "create", "--subscription", SUB, "-g", STORAGE_RG, "-n", "gbx-library-access",
                    "-f", str(ACCESS_TEMPLATE), "-p", f"workspaceIdentityPrincipalId={identity['servicePrincipalId']}",
                    f"storageAccountName={STORAGE_ACCOUNT}", "-o", "none"], check=True)
    print("storage roles       Storage Blob Delegator on the account; Storage Blob Data Reader on raw, processed and manifests")
    client = fabric()
    lh = lakehouse(client, create=True)
    conn = connection(create=True)
    print(f"lakehouse           {LAKEHOUSE} {lh['id']}")
    print(f"connection          {CONNECTION} {conn['id']}")
    print("shortcuts           " + ", ".join(shortcuts(lh["id"], conn["id"])))
    entries = onelake(lh["id"]).list("bronze", recursive=False)
    print(f"read through OneLake {len(entries)} bronze folders")
    current = read_file(lh["id"], "bronze/manifests/current.json")
    if current is None:
        print("no publication yet  approve a source in the site, then run: infra/scripts/deploy.sh library")
    else:
        m = json.loads(current)
        print(f"read through OneLake manifest v{m['manifestVersion']}: {len(m['sources'])} sources")


def cmd_deploy(_: argparse.Namespace) -> None:
    client = fabric()
    lh = lakehouse(client, create=False)
    need(lh is not None, "Run setup first")
    ids = {}
    for step, name in NOTEBOOKS.items():
        ids[step] = client.upsert_notebook(name, build_notebook(step, lh["id"]), DESCRIPTIONS[step].splitlines()[2][:256])["id"]
        print(f"notebook  {name} {ids[step]}")
    pipe = client.upsert_pipeline(PIPELINE, build_pipeline(ids, lh["id"]), "Silver, then gold, for the library in OneLake")
    print(f"pipeline  {PIPELINE} {pipe['id']}")


def cmd_search(_: argparse.Namespace) -> None:
    lh = lakehouse(fabric(), create=False)
    need(lh is not None, "Run setup first")
    ensure_search(lh["id"])
    print(f"index {INDEX}, data source {DATASOURCE} and indexer {INDEXER} are in place")


def cmd_run(args: argparse.Namespace) -> None:
    client = fabric()
    lh = lakehouse(client, create=False)
    pipe = client.find_item(PIPELINE, "DataPipeline")
    need(lh is not None and pipe is not None, "Run setup and deploy first")
    if read_file(lh["id"], "bronze/manifests/current.json") is None:
        print("Nothing is published yet, so there is no gold to build; approve a source in the site first.")
        sys.exit(NOTHING_PUBLISHED)
    began = dt.datetime.now(dt.timezone.utc)
    if not args.skip_pipeline:
        run = client.run_pipeline(pipe["id"], {})
        after = (began - dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        before = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        for activity in client.pipeline_activity_runs(run["id"], after=after, before=before):
            output = activity.get("output") or {}
            print(f"  {activity.get('activityName')}: {activity.get('status')} {output.get('result', {}).get('exitValue', '')}"
                  f"{(activity.get('error') or {}).get('message', '')}"[:1500])
        need(run["status"].casefold() == "completed", "The library pipeline did not complete", run)
        print(f"pipeline {PIPELINE}: {run['status']} in {(dt.datetime.now(dt.timezone.utc) - began).seconds} s")
    manifest = json.loads(read_file(lh["id"], "bronze/manifests/current.json"))
    result = run_indexer()
    print(f"indexer {INDEXER}: {result.get('status')}, {result.get('itemsProcessed')} processed, {result.get('itemsFailed')} failed"
          + (f", {result.get('errors')[:3]}" if result.get("errors") else ""))
    need(result.get("status") == "success" and result.get("itemsFailed") == 0, "The indexer run did not succeed cleanly; "
         "the gold pointer stays where it was")
    check = verify(manifest)
    print(json.dumps(check, indent=2))
    need(check["ok"], "Verification failed; the gold pointer stays where it was")
    pointer = {"manifestVersion": manifest["manifestVersion"], "indexName": INDEX, "chunks": check["expectedChunks"],
               "indexerRunEnded": result.get("endTime"), "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    onelake(lh["id"]).write_bytes(POINTER, json.dumps(pointer, indent=2).encode())
    print(f"gold pointer moved to manifest v{manifest['manifestVersion']} ({POINTER})")


def cmd_extract(args: argparse.Namespace) -> None:
    """Decision D4: extraction in a Fabric notebook, run as the signed-in operator, compared chunk by chunk with gbx-process."""
    client = fabric()
    item = client.find_item(NOTEBOOKS["extract"], "Notebook")
    need(item is not None, "Run deploy first")
    began = time.time()
    result = client.run_notebook_job(item["id"], {"sources": args.sources, "max_pages": str(args.max_pages)})
    summary = json.loads(result["exitValue"] or "{}")
    print(json.dumps(summary, indent=2))
    need("error" not in summary, "Extraction failed")
    need(summary["equivalent"] == summary["documents"], "A Fabric extraction differs from gbx-process; see silver.extraction_parity")
    print(f"{summary['documents']} documents extracted in Fabric in {time.time() - began:.0f} s, every one equivalent to gbx-process")


def cmd_status(_: argparse.Namespace) -> None:
    identity = workspace_identity(provision=False)
    print("workspace identity  " + (identity["servicePrincipalId"] if identity else "none"))
    print("trusted access      " + ("rule present" if storage_rule_present() else "no rule"))
    client = fabric()
    lh = lakehouse(client, create=False)
    conn = connection(create=False)
    print("lakehouse           " + (lh["id"] if lh else "none"))
    print("connection          " + (conn["id"] if conn else "none"))
    if lh:
        print("shortcuts           " + ", ".join(shortcuts(lh["id"], None)))
        for name in [*NOTEBOOKS.values(), PIPELINE]:
            item = client.find_item(name, "DataPipeline" if name == PIPELINE else "Notebook")
            print(f"{name:<28}{item['id'] if item else 'none'}")
        raw = read_file(lh["id"], POINTER)
        current_raw = read_file(lh["id"], "bronze/manifests/current.json")
        current = json.loads(current_raw) if current_raw else {"manifestVersion": "none (nothing published yet)"}
        pointer = json.loads(raw) if raw else None
        print("gold pointer        " + (f"manifest v{pointer['manifestVersion']} verified {pointer['verifiedAt']}" if pointer else "none"))
        print(f"current manifest    v{current['manifestVersion']}" + (" (gold is current)" if pointer and
              pointer["manifestVersion"] == current["manifestVersion"] else " (run `run` to bring gold up to date)"))
    status, body = search("GET", f"/indexers/{INDEXER}/status")
    last = (body or {}).get("lastResult") or {} if status == 200 else {}
    print("indexer             " + (f"{last.get('status')} at {last.get('endTime')}" if status == 200 else "none"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "setup", "deploy", "search"):
        sub.add_parser(name)
    run = sub.add_parser("run")
    run.add_argument("--skip-pipeline", action="store_true", help="only run the indexer, verify and move the pointer")
    extract = sub.add_parser("extract", help="decision D4: extract sources in Fabric and compare them with gbx-process")
    extract.add_argument("--sources", default="", help="comma-separated source ids from the current manifest; empty means all")
    extract.add_argument("--max-pages", type=int, default=60, help="refuse a run over this many Document Intelligence pages; 0 lifts it")
    args = parser.parse_args()
    missing = [name for name in REQUIRED if not _setting(name)]
    need(not missing, "Missing settings " + ", ".join(missing) + "; run this through infra/scripts/deploy.sh library")
    {"status": cmd_status, "setup": cmd_setup, "deploy": cmd_deploy, "search": cmd_search, "run": cmd_run, "extract": cmd_extract}[args.command](args)


if __name__ == "__main__":
    main()
