"""The library in OneLake (version 2, Phase 2; docs/v2/LIBRARY_ONELAKE.md).

Pure functions shared by the library notebooks in Fabric and by the tests. The notebooks read the library through the
bronze shortcuts (`Files/bronze/processed`, `Files/bronze/manifests`), and this module turns what they read into rows:

- **silver**, every extraction the pipeline has written, whether or not the owner has approved it yet;
- **gold**, exactly what the current publication manifest selects, bound to silver and checked against it;
- **evidence documents**, one JSON file per gold passage carrying the fields `pipeline-publish.ts` pushes today
  (`LIVE_INDEX_FIELDS` in services/api/src/live/contracts.ts), which the OneLake files indexer reads (decision D5).

The checks mirror `validChunk` and `publishExtraction` in services/api/src/live/pipeline-publish.ts, so gold never holds a
passage the live publisher would refuse. Licence policy for withheld passages stays in the app: gold takes only what the
owner already approved and the manifest already published.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from typing import Any, Callable, Iterable, Mapping

LIVE_INDEX_NAME = "gbx-evidence-v2"
LIVE_VECTOR_DIMENSIONS = 3072
SHA256 = re.compile(r"[a-f0-9]{64}")
SOURCE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
EXTRACTION_VERSION = re.compile(
    r"layout-v1-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
BUNDLE_PATH = re.compile(r"sources/([a-z0-9][a-z0-9-]{0,63})/([a-f0-9]{64})/([^/]+)/extraction\.json")
MANIFEST_PATH = re.compile(r"v([1-9][0-9]{0,9})\.json")
EXTRACTOR = "gbx-process"
# The fields the live publisher pushes, in the same order (contracts.ts LIVE_INDEX_FIELDS).
LIVE_INDEX_FIELDS = (
    "id", "sourceId", "sha256", "extractionVersion", "documentSha256", "docId", "page", "headingPath", "text", "vector",
    "boundingRegionsSummary", "points", "places", "placeHow", "geoBasins", "geotag", "basin", "well", "licence", "attribution",
    "publishAllowed", "manifestVersion", "visibility", "owner",
)


class LibraryError(ValueError):
    """A record that the live publisher would refuse; the run stops rather than write it."""


def _fail(why: str) -> None:
    raise LibraryError(why)


def extraction_key(ref: Mapping[str, Any]) -> str:
    return f"{ref['sourceId']}_{ref['sha256']}_{ref['extractionVersion']}"


def extraction_prefix(ref: Mapping[str, Any]) -> str:
    return f"sources/{ref['sourceId']}/{ref['sha256']}/{ref['extractionVersion']}"


def check_ref(ref: Mapping[str, Any], where: str) -> None:
    if not (isinstance(ref.get("sourceId"), str) and SOURCE_ID.fullmatch(ref["sourceId"])
            and isinstance(ref.get("sha256"), str) and SHA256.fullmatch(ref["sha256"])
            and isinstance(ref.get("extractionVersion"), str) and EXTRACTION_VERSION.fullmatch(ref["extractionVersion"])):
        _fail(f"{where}: invalid extraction identity")


def same_extraction(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    return all(a.get(k) == b.get(k) for k in ("sourceId", "sha256", "extractionVersion"))


def bundle_ref(path: str) -> dict[str, str] | None:
    """The identity a bundle path claims, or None for anything that is not an extraction bundle."""
    match = BUNDLE_PATH.fullmatch(path)
    if not match or not EXTRACTION_VERSION.fullmatch(match.group(3)):
        return None
    return {"sourceId": match.group(1), "sha256": match.group(2), "extractionVersion": match.group(3)}


def _inside(path: Any, prefix: str, where: str) -> str:
    if not isinstance(path, str) or not path.startswith(prefix + "/") or ".." in path.split("/") or "\\" in path:
        _fail(f"{where}: path escapes its extraction")
    return path


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _strings(value: Any, where: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        _fail(f"{where}: expected a list of strings")
    return list(value)


def check_chunk(chunk: Mapping[str, Any], ref: Mapping[str, Any], document_sha256: str, page_count: int) -> None:
    """validChunk in pipeline-publish.ts, without the app's licence policy."""
    prefix = f"{ref['sourceId']}_{ref['sha256']}_{ref['extractionVersion']}_{document_sha256}_c"
    vector = chunk.get("vector")
    if (not same_extraction(chunk, ref) or chunk.get("documentSha256") != document_sha256
            or not isinstance(chunk.get("page"), int) or isinstance(chunk.get("page"), bool)
            or not 1 <= chunk["page"] <= page_count
            or not isinstance(chunk.get("id"), str) or not chunk["id"].startswith(prefix) or not chunk["id"][len(prefix):].isdigit()
            or not isinstance(chunk.get("text"), str) or not chunk["text"].strip()
            or chunk.get("visibility") != "public" or chunk.get("owner") != ""
            or not isinstance(vector, list) or len(vector) != LIVE_VECTOR_DIMENSIONS or not all(_finite(v) for v in vector)):
        _fail(f"Invalid silver chunk {chunk.get('id')!r}")


def silver_extraction(bundle: Mapping[str, Any], bundle_path: str, read_json: Callable[[str], Any], *,
                      loaded_at: str) -> dict[str, list[dict[str, Any]]]:
    """Silver rows for one extraction bundle: its documents, pages and chunks, each checked as the publisher checks them."""
    claimed = bundle_ref(bundle_path)
    if claimed is None:
        _fail(f"{bundle_path}: not an extraction bundle path")
    check_ref(bundle, bundle_path)
    if not same_extraction(bundle, claimed):
        _fail(f"{bundle_path}: bundle identity differs from its path")
    documents = bundle.get("documents")
    if not isinstance(documents, list) or not documents:
        _fail(f"{bundle_path}: no documents")
    key, prefix = extraction_key(bundle), extraction_prefix(bundle)
    out: dict[str, list[dict[str, Any]]] = {"documents": [], "pages": [], "chunks": []}
    seen_docs: set[str] = set()
    for entry in documents:
        record = entry.get("record") if isinstance(entry, dict) else None
        if not isinstance(record, dict) or not same_extraction(record, bundle):
            _fail(f"{bundle_path}: document record identity differs")
        doc_sha = record.get("documentSha256")
        if not isinstance(doc_sha, str) or not SHA256.fullmatch(doc_sha) or doc_sha in seen_docs:
            _fail(f"{bundle_path}: invalid or repeated document hash")
        seen_docs.add(doc_sha)
        pages, chunks = entry.get("pages"), entry.get("chunks")
        page_count, chunk_count = record.get("pageCount"), record.get("chunkCount")
        if (not isinstance(pages, list) or not isinstance(chunks, list) or not isinstance(page_count, int)
                or not isinstance(chunk_count, int) or len(pages) != page_count or len(chunks) != chunk_count or page_count < 1
                or chunk_count < 1):
            _fail(f"{bundle_path}: incomplete silver document inventory for {doc_sha}")
        doc_prefix = f"{prefix}/{doc_sha}"
        confidence = record.get("confidence") if isinstance(record.get("confidence"), dict) else {}
        out["documents"].append({
            "extractionKey": key, "sourceId": record["sourceId"], "sha256": record["sha256"],
            "extractionVersion": record["extractionVersion"], "documentSha256": doc_sha, "docId": str(record.get("docId", "")),
            "title": str(record.get("title", "")), "originalName": str(record.get("originalName", "")),
            "memberName": record.get("memberName") if isinstance(record.get("memberName"), str) else None,
            "rawBlob": str(record.get("rawBlob", "")), "rawBlobVersionId": str(record.get("rawBlobVersionId", "")),
            "layoutBlob": str(record.get("layoutBlob", "")), "pageCount": page_count, "chunkCount": chunk_count,
            "confidenceMinimum": confidence.get("minimum") if _finite(confidence.get("minimum")) else None,
            "confidenceMean": confidence.get("mean") if _finite(confidence.get("mean")) else None,
            "measuredPages": int(confidence.get("measuredPages") or 0),
            "lowConfidencePages": int(confidence.get("lowConfidencePages") or 0),
            "licence": str(record.get("licence", "")), "attribution": str(record.get("attribution", "")),
            "registryEtag": str(bundle.get("registryEtag", "")), "jobId": str(bundle.get("jobId", "")),
            "extractedAt": str(bundle.get("createdAt", "")), "extractor": EXTRACTOR, "loadedAt": loaded_at,
        })
        for i, path in enumerate(pages):
            page = read_json(_inside(path, doc_prefix, bundle_path))
            if (not isinstance(page, dict) or not same_extraction(page, bundle) or page.get("documentSha256") != doc_sha
                    or page.get("page") != i + 1):
                _fail(f"{bundle_path}: invalid page identity at page {i + 1} of {doc_sha}")
            out["pages"].append({
                "extractionKey": key, "sourceId": page["sourceId"], "sha256": page["sha256"],
                "extractionVersion": page["extractionVersion"], "documentSha256": doc_sha, "docId": str(page.get("docId", "")),
                "page": i + 1, "text": str(page.get("text", "")),
                "width": float(page["width"]) if _finite(page.get("width")) else None,
                "height": float(page["height"]) if _finite(page.get("height")) else None,
                "unit": str(page.get("unit", "")), "headingPath": _strings(page.get("headingPath", []), bundle_path),
                "boundingRegionsJson": json.dumps(page.get("boundingRegions", []), separators=(",", ":")),
                "imageBlob": str(page.get("imageBlob", "")),
                "confidence": float(page["confidence"]) if _finite(page.get("confidence")) else None,
            })
        for path in chunks:
            chunk = read_json(_inside(path, doc_prefix, bundle_path))
            if not isinstance(chunk, dict):
                _fail(f"{bundle_path}: missing silver chunk {path}")
            check_chunk(chunk, bundle, doc_sha, page_count)
            if chunk.get("licence") != record.get("licence") or chunk.get("attribution") != record.get("attribution"):
                _fail(f"{bundle_path}: chunk licence differs from its document")
            out["chunks"].append(chunk_row(chunk, key))
    ids = [c["id"] for c in out["chunks"]]
    if len(set(ids)) != len(ids):
        _fail(f"{bundle_path}: repeated chunk id")
    return out


def chunk_row(chunk: Mapping[str, Any], key: str) -> dict[str, Any]:
    points = chunk.get("points", [])
    if not isinstance(points, list) or not all(isinstance(p, dict) and _finite(p.get("longitude")) and _finite(p.get("latitude"))
                                               for p in points):
        _fail(f"Invalid points on chunk {chunk.get('id')!r}")
    return {
        "extractionKey": key, "id": chunk["id"], "sourceId": chunk["sourceId"], "sha256": chunk["sha256"],
        "extractionVersion": chunk["extractionVersion"], "documentSha256": chunk["documentSha256"],
        "docId": str(chunk.get("docId", "")), "page": chunk["page"], "text": chunk["text"],
        "headingPath": _strings(chunk.get("headingPath", []), str(chunk["id"])),
        "boundingRegionsSummaryJson": json.dumps(chunk.get("boundingRegionsSummary", []), separators=(",", ":")),
        "boundingRegionsJson": json.dumps(chunk.get("boundingRegions", []), separators=(",", ":")),
        "points": [{"longitude": float(p["longitude"]), "latitude": float(p["latitude"])} for p in points],
        "places": _strings(chunk.get("places", []), chunk["id"]), "placeHow": _strings(chunk.get("placeHow", []), chunk["id"]),
        "geoBasins": _strings(chunk.get("geoBasins", []), chunk["id"]), "geotag": str(chunk.get("geotag", "")),
        "basin": chunk.get("basin") if isinstance(chunk.get("basin"), str) else None,
        "well": chunk.get("well") if isinstance(chunk.get("well"), str) else None,
        "visibility": chunk["visibility"], "owner": chunk["owner"],
        "licence": str(chunk.get("licence", "")), "attribution": str(chunk.get("attribution", "")),
        "vector": [float(v) for v in chunk["vector"]],
    }


def check_manifest(manifest: Any, where: str = "manifest") -> dict[str, Any]:
    """The structural rules of MANIFEST_SCHEMA that gold depends on; the app's validateManifest stays authoritative."""
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or manifest.get("indexName") != LIVE_INDEX_NAME:
        _fail(f"{where}: not a version 1 publication manifest for {LIVE_INDEX_NAME}")
    version = manifest.get("manifestVersion")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        _fail(f"{where}: invalid manifestVersion")
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        _fail(f"{where}: no sources")
    seen: set[str] = set()
    for s in sources:
        if not isinstance(s, dict):
            _fail(f"{where}: invalid source entry")
        check_ref(s, f"{where} source")
        approval = s.get("approval")
        if (s["sourceId"] in seen or s.get("publishAllowed") is not True or s.get("visibility") != "public"
                or not isinstance(approval, dict) or not same_extraction(approval, s) or approval.get("decision") != "approved"
                or not approval.get("by") or not approval.get("at")):
            _fail(f"{where}: source {s['sourceId']} is repeated, unapproved or not public")
        seen.add(s["sourceId"])
        docs = s.get("documents")
        if not isinstance(docs, list) or not docs:
            _fail(f"{where}: source {s['sourceId']} has no documents")
        for d in docs:
            if (not isinstance(d, dict) or not isinstance(d.get("sha256"), str) or not SHA256.fullmatch(d["sha256"])
                    or not isinstance(d.get("pageCount"), int) or not isinstance(d.get("chunkCount"), int)
                    or d["pageCount"] < 1 or d["chunkCount"] < 1):
                _fail(f"{where}: source {s['sourceId']} has an invalid document entry")
    return manifest


def first_published_versions(manifests: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    """For every extraction, the first manifest version that selected it. The live publisher stamps each passage with the
    version it was first staged for, so gold's evidence carries the same provenance."""
    first: dict[str, int] = {}
    for m in sorted(manifests, key=lambda m: m["manifestVersion"]):
        for s in m["sources"]:
            first.setdefault(extraction_key(s), m["manifestVersion"])
    return first


def gold_publication(manifest: Mapping[str, Any], silver_documents: Iterable[Mapping[str, Any]],
                     silver_chunks: Iterable[Mapping[str, Any]], first_versions: Mapping[str, int], *,
                     written_at: str) -> dict[str, list[dict[str, Any]]]:
    """Gold for the current manifest: every selected extraction must be complete in silver and agree with the manifest."""
    check_manifest(manifest)
    version = manifest["manifestVersion"]
    docs_by_key: dict[str, dict[str, Mapping[str, Any]]] = {}
    for d in silver_documents:
        docs_by_key.setdefault(d["extractionKey"], {})[d["documentSha256"]] = d
    chunks_by_doc: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for c in silver_chunks:
        chunks_by_doc.setdefault((c["extractionKey"], c["documentSha256"]), []).append(c)
    out: dict[str, list[dict[str, Any]]] = {"sources": [], "documents": [], "chunks": []}
    for s in manifest["sources"]:
        key = extraction_key(s)
        silver = docs_by_key.get(key)
        if not silver:
            _fail(f"Manifest v{version} selects {key}, which is not in silver")
        if set(silver) != {d["sha256"] for d in s["documents"]}:
            _fail(f"Manifest v{version} and silver list different documents for {s['sourceId']}")
        approval, well = s["approval"], s.get("wellLocation")
        staged = first_versions.get(key, version)
        out["sources"].append({
            "manifestVersion": version, "extractionKey": key, "sourceId": s["sourceId"], "sha256": s["sha256"],
            "extractionVersion": s["extractionVersion"], "publisher": str(s.get("publisher", "")), "title": str(s.get("title", "")),
            "url": str(s.get("url", "")), "licence": str(s.get("licence", "")), "attribution": str(s.get("attribution", "")),
            "licenceBasis": str(s.get("licenceBasis", "")), "v1DocIds": [str(v) for v in s.get("v1DocIds", [])],
            "wellLocationJson": json.dumps(well, separators=(",", ":")) if well else None,
            "approvedBy": str(approval["by"]), "approvedAt": str(approval["at"]), "approvalReason": str(approval.get("reason", "")),
            "firstManifestVersion": staged, "writtenAt": written_at,
        })
        for d in s["documents"]:
            sd = silver[d["sha256"]]
            if sd["pageCount"] != d["pageCount"] or sd["chunkCount"] != d["chunkCount"]:
                _fail(f"Manifest v{version} and silver disagree on the size of document {d['sha256']}")
            chunks = sorted(chunks_by_doc.get((key, d["sha256"]), []), key=lambda c: int(c["id"].rsplit("_c", 1)[1]))
            if len(chunks) != d["chunkCount"]:
                _fail(f"Silver holds {len(chunks)} of the {d['chunkCount']} chunks manifest v{version} expects for {d['sha256']}")
            out["documents"].append({
                "manifestVersion": version, "extractionKey": key, "sourceId": s["sourceId"], "sha256": s["sha256"],
                "extractionVersion": s["extractionVersion"], "documentSha256": d["sha256"], "docId": str(d.get("docId", "")),
                "title": str(d.get("title", "")), "pageCount": d["pageCount"], "chunkCount": d["chunkCount"],
            })
            for c in chunks:
                if c["licence"] != s.get("licence") or c["attribution"] != s.get("attribution"):
                    _fail(f"Chunk {c['id']} licence differs from the approved source")
                if well and (c["geotag"] != "point" or not any(p["longitude"] == well["lon"] and p["latitude"] == well["lat"]
                                                               for p in c["points"])):
                    _fail(f"Chunk {c['id']} lacks its source's registered well location")
                out["chunks"].append({**dict(c), "manifestVersion": staged, "publishAllowed": True})
    ids = [c["id"] for c in out["chunks"]]
    if len(set(ids)) != len(ids):
        _fail(f"Manifest v{version} selects a chunk twice")
    return out


def _single(value: float) -> float:
    """The value Azure AI Search stores for an Edm.Single, written with the nine significant digits that round-trip it."""
    return float(f"{struct.unpack('f', struct.pack('f', value))[0]:.9g}")


def evidence_path(chunk: Mapping[str, Any]) -> str:
    """Relative to the lakehouse Files area. Chunk ids run to about 230 characters, past the 255-byte file-name limit, so
    the file is named by a hash of its id, and the id itself travels inside the document as the index key. Chunk ids are
    immutable, so a file is written once and never rewritten."""
    if not SOURCE_ID.fullmatch(str(chunk["sourceId"])) or not re.fullmatch(r"[a-z0-9_-]{1,1024}", str(chunk["id"])):
        _fail("Unsafe evidence file name")
    return f"gold/evidence/{chunk['sourceId']}/{hashlib.sha256(chunk['id'].encode()).hexdigest()[:40]}.json"


def evidence_document(chunk: Mapping[str, Any]) -> dict[str, Any]:
    """One search document, field for field what pipeline-publish.ts uploads (LiveEvidenceRecord), with points as GeoJSON."""
    doc = {
        "id": chunk["id"], "sourceId": chunk["sourceId"], "sha256": chunk["sha256"],
        "extractionVersion": chunk["extractionVersion"], "documentSha256": chunk["documentSha256"], "docId": chunk["docId"],
        "page": int(chunk["page"]), "headingPath": list(chunk["headingPath"]), "text": chunk["text"],
        "vector": [_single(v) for v in chunk["vector"]],
        "boundingRegionsSummary": json.loads(chunk["boundingRegionsSummaryJson"]),
        "points": [{"type": "Point", "coordinates": [p["longitude"], p["latitude"]]} for p in chunk["points"]],
        "places": list(chunk["places"]), "placeHow": list(chunk["placeHow"]), "geoBasins": list(chunk["geoBasins"]),
        "geotag": chunk["geotag"], "basin": chunk["basin"], "well": chunk["well"], "licence": chunk["licence"],
        "attribution": chunk["attribution"], "publishAllowed": True, "manifestVersion": int(chunk["manifestVersion"]),
        "visibility": "public", "owner": "",
    }
    if tuple(doc) != LIVE_INDEX_FIELDS:
        _fail("Evidence document fields differ from LIVE_INDEX_FIELDS")
    return doc


def evidence_bytes(chunk: Mapping[str, Any]) -> bytes:
    return json.dumps(evidence_document(chunk), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def arrow_schemas() -> dict[str, Any]:
    """Explicit Delta schemas, so an empty run and a full run write the same columns."""
    import pyarrow as pa

    text, num, whole = pa.string(), pa.float64(), pa.int64()
    strings = pa.list_(pa.string())
    point = pa.struct([("longitude", num), ("latitude", num)])
    keys = [("extractionKey", text), ("sourceId", text), ("sha256", text), ("extractionVersion", text)]
    return {
        "silver.documents": pa.schema(keys + [
            ("documentSha256", text), ("docId", text), ("title", text), ("originalName", text), ("memberName", text),
            ("rawBlob", text), ("rawBlobVersionId", text), ("layoutBlob", text), ("pageCount", whole), ("chunkCount", whole),
            ("confidenceMinimum", num), ("confidenceMean", num), ("measuredPages", whole), ("lowConfidencePages", whole),
            ("licence", text), ("attribution", text), ("registryEtag", text), ("jobId", text), ("extractedAt", text),
            ("extractor", text), ("loadedAt", text)]),
        "silver.pages": pa.schema(keys + [
            ("documentSha256", text), ("docId", text), ("page", whole), ("text", text), ("width", num), ("height", num),
            ("unit", text), ("headingPath", strings), ("boundingRegionsJson", text), ("imageBlob", text), ("confidence", num)]),
        "silver.chunks": pa.schema([("extractionKey", text), ("id", text), ("sourceId", text), ("sha256", text),
            ("extractionVersion", text), ("documentSha256", text), ("docId", text), ("page", whole), ("text", text),
            ("headingPath", strings), ("boundingRegionsSummaryJson", text), ("boundingRegionsJson", text),
            ("points", pa.list_(point)), ("places", strings), ("placeHow", strings), ("geoBasins", strings), ("geotag", text),
            ("basin", text), ("well", text), ("visibility", text), ("owner", text), ("licence", text), ("attribution", text),
            ("vector", pa.list_(pa.float32()))]),
        "gold.sources": pa.schema([("manifestVersion", whole)] + keys + [
            ("publisher", text), ("title", text), ("url", text), ("licence", text), ("attribution", text), ("licenceBasis", text),
            ("v1DocIds", strings), ("wellLocationJson", text), ("approvedBy", text), ("approvedAt", text),
            ("approvalReason", text), ("firstManifestVersion", whole), ("writtenAt", text)]),
        "gold.documents": pa.schema([("manifestVersion", whole)] + keys + [
            ("documentSha256", text), ("docId", text), ("title", text), ("pageCount", whole), ("chunkCount", whole)]),
        "gold.publications": pa.schema([("manifestVersion", whole), ("createdAt", text), ("sources", whole), ("documents", whole),
            ("chunks", whole), ("newEvidenceFiles", whole), ("writtenAt", text)]),
    }


def gold_chunk_schema() -> Any:
    import pyarrow as pa
    base = arrow_schemas()["silver.chunks"]
    return base.append(pa.field("manifestVersion", pa.int64())).append(pa.field("publishAllowed", pa.bool_()))


# ------------------------------------------------------------------------------------------- extraction in Fabric (decision D4)

LAYOUT_API_VERSION, LAYOUT_MODEL = "2024-11-30", "prebuilt-layout"
CHUNK_MAX_CHARS, CHUNK_MAX_UTF8_BYTES = 3500, 7500
FABRIC_EXTRACTOR = "fabric-notebook"


class _Utf16:
    """A string indexed in UTF-16 code units, as JavaScript indexes it, so offsets from Document Intelligence (requested with
    stringIndexType=utf16CodeUnit) and the chunker's arithmetic agree with normalizeLayout in pipeline-layout.ts."""

    def __init__(self, text: str):
        self.data = text.encode("utf-16-le", "surrogatepass")

    def __len__(self) -> int:
        return len(self.data) // 2

    def slice(self, start: int, end: int) -> "_Utf16":
        out = _Utf16("")
        out.data = self.data[2 * max(0, start):2 * max(0, min(end, len(self)))]
        return out

    def unit(self, i: int) -> int:
        return self.data[2 * i] | (self.data[2 * i + 1] << 8)

    def last_index_of(self, code: int, from_index: int) -> int:
        for i in range(min(from_index, len(self) - 1), -1, -1):
            if self.unit(i) == code:
                return i
        return -1

    def utf8_bytes(self) -> int:
        return len(str(self).encode("utf-8", "surrogatepass"))

    def __str__(self) -> str:
        return self.data.decode("utf-16-le", "surrogatepass")


def _js_trim(text: str) -> str:
    return text.strip(" \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")


def normalize_layout(result: Mapping[str, Any], ref: Mapping[str, Any], geo: Mapping[str, Any], *, licence: str,
                     attribution: str, expected_pages: int | None = None) -> dict[str, Any]:
    """A port of normalizeLayout (pipeline-layout.ts): page records and page-bounded chunks with heading paths and regions.

    `geo` carries the source's registered place fields (points, places, placeHow, geoBasins, geotag, basin, well), which the
    app derives from its source policy. Vectors are added afterwards by the embedding step."""
    if (result.get("apiVersion") != LAYOUT_API_VERSION or result.get("modelId") != LAYOUT_MODEL
            or result.get("stringIndexType") != "utf16CodeUnit" or not isinstance(result.get("content"), str)):
        _fail("Unexpected or incomplete layout result")
    pages_in = result.get("pages") or []
    expected = expected_pages if expected_pages is not None else len(pages_in)
    if len(pages_in) != expected or expected < 1:
        _fail("Layout page count differs from the document")
    content = _Utf16(result["content"])
    paragraphs, sections = result.get("paragraphs") or [], result.get("sections") or []
    heading_paths: dict[int, list[str]] = {}
    children: set[int] = set()
    for section in sections:
        for e in section.get("elements") or []:
            if re.fullmatch(r"/sections/\d+", e):
                children.add(int(e.split("/")[2]))

    def visit(n: int, parent: list[str], ancestors: frozenset[int]) -> None:
        if n >= len(sections) or n in ancestors or len(ancestors) >= 32:
            _fail("Invalid or cyclic section hierarchy")
        elements = sections[n].get("elements") or []
        heading = next((paragraphs[int(m.group(1))] for m in (re.fullmatch(r"/paragraphs/(\d+)", e) for e in elements) if m
                        and int(m.group(1)) < len(paragraphs)
                        and paragraphs[int(m.group(1))].get("role") in ("title", "sectionHeading")), None)
        path = [*parent, _js_trim(heading["content"])] if heading else parent
        for e in elements:
            p, s = re.fullmatch(r"/paragraphs/(\d+)", e), re.fullmatch(r"/sections/(\d+)", e)
            if p:
                i = int(p.group(1))
                if i >= len(paragraphs):
                    _fail("Missing paragraph in section")
                old = heading_paths.get(i)
                if old is None or len(old) < len(path):
                    heading_paths[i] = path
            elif s:
                visit(int(s.group(1)), path, ancestors | {n})
            elif not re.fullmatch(r"/(?:tables|figures)/\d+", e):
                _fail("Unexpected layout section pointer")

    for i in range(len(sections)):
        if i not in children:
            visit(i, [], frozenset())
    if sections and len(children) >= len(sections):
        _fail("Cyclic section roots")
    key = extraction_key(ref)
    pages: list[dict[str, Any]] = []
    chunks: list[dict[str, Any]] = []
    seen: set[int] = set()
    current_heading: list[str] = []
    for page in sorted(pages_in, key=lambda p: p["pageNumber"]):
        n = page["pageNumber"]
        if (not isinstance(n, int) or not 1 <= n <= expected or n in seen or not _finite(page.get("width")) or page["width"] <= 0
                or not _finite(page.get("height")) or page["height"] <= 0 or page.get("unit") not in ("inch", "pixel")):
            _fail("Invalid layout page geometry or identity")
        seen.add(n)
        unit, spans = page["unit"], page.get("spans") or []
        for s in spans:
            if s["offset"] < 0 or s["length"] < 0 or s["offset"] + s["length"] > len(content):
                _fail("Invalid page text span")
        text = _Utf16("\n".join(str(content.slice(s["offset"], s["offset"] + s["length"])) for s in spans))
        relevant = [(i, p) for i, p in enumerate(paragraphs) if any(r.get("pageNumber") == n for r in p.get("boundingRegions") or [])]
        regions: list[dict[str, Any]] = []
        for _, p in relevant:
            for r in p.get("boundingRegions") or []:
                if r.get("pageNumber") == n:
                    polygon = r.get("polygon")
                    if not polygon or len(polygon) < 6 or len(polygon) % 2 or not all(_finite(v) for v in polygon):
                        _fail("Invalid layout bounding polygon")
                    regions.append({"page": n, "polygon": polygon, "unit": unit})
        if not regions:
            w, h = page["width"], page["height"]
            regions.append({"page": n, "unit": unit, "polygon": [0, 0, w, 0, w, h, 0, h]})
        confidence = [w.get("confidence") for w in page.get("words") or []]
        mean = sum(confidence) / len(confidence) if confidence else None
        first = next(((i, p) for i, p in relevant if p.get("role") in ("title", "sectionHeading")), None)
        if first:
            current_heading = heading_paths.get(first[0], [_js_trim(first[1]["content"])])
        page_heading = list(current_heading)
        pages.append({**{k: ref[k] for k in ("sourceId", "sha256", "extractionVersion", "documentSha256", "docId")},
                      "extractionKey": key, "page": n, "text": str(text), "width": float(page["width"]),
                      "height": float(page["height"]), "unit": unit, "headingPath": page_heading,
                      "boundingRegionsJson": json.dumps(regions, separators=(",", ":")), "imageBlob": "", "confidence": mean})
        summary = []
        for r in regions:
            xs, ys = r["polygon"][0::2], r["polygon"][1::2]
            summary.append({"page": n, "unit": unit, "x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)})
        offset, base = 0, spans[0]["offset"] if spans else 0
        while offset < len(text):
            end = min(len(text), offset + CHUNK_MAX_CHARS)
            if end < len(text):
                boundary = max(text.last_index_of(10, end), text.last_index_of(32, end))
                if boundary > offset + 1000:
                    end = boundary + 1
            while text.slice(offset, end).utf8_bytes() > CHUNK_MAX_UTF8_BYTES:
                end -= 1
            part = text.slice(offset, end)
            absolute_start, absolute_end = base + offset, base + offset + len(part)
            paragraph = next(((i, p) for i, p in relevant if any(s["offset"] < absolute_end and absolute_start < s["offset"] + s["length"]
                                                                for s in p.get("spans") or [])), None)
            heading_path = heading_paths.get(paragraph[0], page_heading) if paragraph else page_heading
            if _js_trim(str(part)):
                chunks.append({"extractionKey": key, "id": f"{key}_{ref['documentSha256']}_c{len(chunks)}",
                               **{k: ref[k] for k in ("sourceId", "sha256", "extractionVersion", "documentSha256", "docId")},
                               "page": n, "text": str(part), "headingPath": list(heading_path),
                               "boundingRegionsSummaryJson": json.dumps(summary, separators=(",", ":")),
                               "boundingRegionsJson": json.dumps(regions, separators=(",", ":")),
                               "points": [dict(p) for p in geo.get("points", [])], "places": list(geo.get("places", [])),
                               "placeHow": list(geo.get("placeHow", [])), "geoBasins": list(geo.get("geoBasins", [])),
                               "geotag": geo.get("geotag", ""), "basin": geo.get("basin"), "well": geo.get("well"),
                               "visibility": "public", "owner": "", "licence": licence, "attribution": attribution, "vector": []})
            offset = end
    if len(seen) != expected:
        _fail("A page is missing from extraction")
    if not chunks:
        _fail("No readable evidence")
    return {"pages": pages, "chunks": chunks}


def chunk_parity(reference: list[Mapping[str, Any]], candidate: list[Mapping[str, Any]], *, min_cosine: float = 0.999) -> dict[str, Any]:
    """How a Fabric extraction compares with gbx-process for the same document, chunk by chunk in order."""
    def ordinal(c: Mapping[str, Any]) -> int:
        return int(str(c["id"]).rsplit("_c", 1)[1])

    a, b = sorted(reference, key=ordinal), sorted(candidate, key=ordinal)
    same = {"text": 0, "page": 0, "headingPath": 0, "regions": 0}
    cosines: list[float] = []
    for x, y in zip(a, b):
        same["text"] += x["text"] == y["text"]
        same["page"] += x["page"] == y["page"]
        same["headingPath"] += list(x["headingPath"]) == list(y["headingPath"])
        same["regions"] += json.loads(x["boundingRegionsSummaryJson"]) == json.loads(y["boundingRegionsSummaryJson"])
        if x.get("vector") and y.get("vector"):
            dot = sum(p * q for p, q in zip(x["vector"], y["vector"]))
            norm = math.sqrt(sum(p * p for p in x["vector"])) * math.sqrt(sum(q * q for q in y["vector"]))
            cosines.append(dot / norm if norm else 0.0)
    identical = len(a) == len(b) and all(v == len(a) for v in same.values())
    return {"referenceChunks": len(a), "candidateChunks": len(b), "matching": same,
            "minCosine": min(cosines) if cosines else None,
            "equivalent": identical and (not cosines or min(cosines) >= min_cosine)}
