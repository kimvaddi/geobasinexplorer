import json
import struct

import pytest

from ontology_ingest import library as lib

SHA = "a" * 64
DOC = "b" * 64
EV = "layout-v1-" + "c" * 64 + "-0f0e0d0c-0b0a-4908-8706-050403020100"
REF = {"sourceId": "ga-147461", "sha256": SHA, "extractionVersion": EV}
PREFIX = f"sources/ga-147461/{SHA}/{EV}"
BUNDLE_PATH = f"{PREFIX}/extraction.json"


def chunk(i, **over):
    value = {**REF, "documentSha256": DOC, "docId": "ga-147461-x", "id": f"ga-147461_{SHA}_{EV}_{DOC}_c{i}", "page": 1,
             "text": f"passage {i}", "headingPath": ["Intro"], "boundingRegions": [], "boundingRegionsSummary": [
                 {"page": 1, "x": 0, "y": 0, "width": 8.5, "height": 11, "unit": "inch"}],
             "points": [], "places": [], "placeHow": [], "geoBasins": ["Cooper"], "geotag": "basin", "basin": "Cooper",
             "well": None, "visibility": "public", "owner": "", "licence": "CC BY 4.0", "attribution": "GA",
             "vector": [0.1] * lib.LIVE_VECTOR_DIMENSIONS}
    value.update(over)
    return value


def files(chunks=None):
    chunks = chunks if chunks is not None else [chunk(0), chunk(1)]
    record = {**REF, "documentSha256": DOC, "docId": "ga-147461-x", "title": "Report", "pageCount": 1,
              "chunkCount": len(chunks), "licence": "CC BY 4.0", "attribution": "GA", "confidence": {"minimum": 0.9}}
    doc = f"{PREFIX}/{DOC}"
    store = {f"{doc}/pages/1.json": {**REF, "documentSha256": DOC, "page": 1, "text": "t", "headingPath": [], "width": 8.5}}
    store.update({f"{doc}/chunks/{i}.json": c for i, c in enumerate(chunks)})
    bundle = {**REF, "registryEtag": "e", "jobId": "j", "createdAt": "2026-11-02T22:41:18.775Z",
              "documents": [{"record": record, "pages": [f"{doc}/pages/1.json"],
                             "chunks": [f"{doc}/chunks/{i}.json" for i in range(len(chunks))]}]}
    return bundle, store.get


def manifest(version=3, chunk_count=2, **source):
    entry = {**REF, "publisher": "GA", "title": "Report", "url": "https://example.org", "licence": "CC BY 4.0",
             "attribution": "GA", "licenceBasis": "open", "publishAllowed": True, "visibility": "public", "v1DocIds": [],
             "wellLocation": None, "documents": [{"docId": "ga-147461-x", "sha256": DOC, "title": "Report", "pageCount": 1,
                                                   "chunkCount": chunk_count}],
             "approval": {**REF, "decision": "approved", "reason": "ok", "by": "owner", "at": "2026-11-02T23:00:00.000Z"}}
    entry.update(source)
    return {"schemaVersion": 1, "manifestVersion": version, "createdAt": "2026-11-02T23:00:00.000Z",
            "indexName": lib.LIVE_INDEX_NAME, "sources": [entry]}


def test_silver_rows_carry_every_page_and_chunk():
    bundle, read = files()
    silver = lib.silver_extraction(bundle, BUNDLE_PATH, read, loaded_at="now")
    assert [len(silver[k]) for k in ("documents", "pages", "chunks")] == [1, 1, 2]
    assert silver["chunks"][0]["extractionKey"] == lib.extraction_key(REF)
    assert silver["documents"][0]["extractor"] == "gbx-process"


@pytest.mark.parametrize("bad", [
    {"vector": [0.1] * 10},
    {"visibility": "private"},
    {"owner": "someone"},
    {"page": 2},
    {"id": "ga-147461_other_c0"},
])
def test_silver_refuses_a_chunk_the_publisher_would_refuse(bad):
    bundle, read = files([chunk(0, **bad)])
    with pytest.raises(lib.LibraryError):
        lib.silver_extraction(bundle, BUNDLE_PATH, read, loaded_at="now")


def test_silver_refuses_a_bundle_whose_identity_or_paths_escape():
    bundle, read = files()
    with pytest.raises(lib.LibraryError):
        lib.silver_extraction({**bundle, "sha256": "d" * 64}, BUNDLE_PATH, read, loaded_at="now")
    bundle["documents"][0]["chunks"][0] = f"{PREFIX}/{DOC}/../../escape.json"
    with pytest.raises(lib.LibraryError):
        lib.silver_extraction(bundle, BUNDLE_PATH, read, loaded_at="now")


def test_gold_binds_the_manifest_to_silver_with_first_published_provenance():
    bundle, read = files()
    silver = lib.silver_extraction(bundle, BUNDLE_PATH, read, loaded_at="now")
    first = lib.first_published_versions([manifest(5), manifest(2)])
    gold = lib.gold_publication(manifest(5), silver["documents"], list(reversed(silver["chunks"])), first, written_at="now")
    assert [c["id"].rsplit("_c", 1)[1] for c in gold["chunks"]] == ["0", "1"]
    assert {c["manifestVersion"] for c in gold["chunks"]} == {2}
    assert gold["sources"][0]["firstManifestVersion"] == 2


def test_gold_refuses_a_manifest_that_silver_cannot_fully_back():
    bundle, read = files()
    silver = lib.silver_extraction(bundle, BUNDLE_PATH, read, loaded_at="now")
    with pytest.raises(lib.LibraryError, match="not in silver"):
        lib.gold_publication(manifest(), [], [], {}, written_at="now")
    with pytest.raises(lib.LibraryError, match="disagree"):
        lib.gold_publication(manifest(chunk_count=3), silver["documents"], silver["chunks"], {}, written_at="now")
    with pytest.raises(lib.LibraryError, match="well location"):
        lib.gold_publication(manifest(wellLocation={"lon": 140.1, "lat": -27.5, "datum": "GDA94"}), silver["documents"],
                             silver["chunks"], {}, written_at="now")


def test_evidence_document_matches_the_live_index_fields_and_single_precision():
    bundle, read = files([chunk(0, points=[{"longitude": 140.1, "latitude": -27.5}], vector=[0.1 + 1e-12] * 3072)])
    row = {**lib.silver_extraction(bundle, BUNDLE_PATH, read, loaded_at="now")["chunks"][0], "manifestVersion": 4}
    doc = json.loads(lib.evidence_bytes(row))
    assert tuple(doc) == lib.LIVE_INDEX_FIELDS
    assert doc["points"] == [{"type": "Point", "coordinates": [140.1, -27.5]}]
    assert struct.pack("f", doc["vector"][0]) == struct.pack("f", 0.1 + 1e-12)
    assert len(json.dumps(doc["vector"])) < 64_000
    path = lib.evidence_path(row)
    assert path.startswith("gold/evidence/ga-147461/") and len(path.rsplit("/", 1)[1]) < 255 and path == lib.evidence_path(row)


def layout(content, spans, paragraphs=(), sections=()):
    return {"apiVersion": "2024-11-30", "modelId": "prebuilt-layout", "stringIndexType": "utf16CodeUnit", "content": content,
            "pages": [{"pageNumber": 1, "width": 8.5, "height": 11, "unit": "inch", "spans": spans,
                       "words": [{"confidence": 0.9}, {"confidence": 0.7}]}],
            "paragraphs": list(paragraphs), "sections": list(sections)}


DOC_REF = {**REF, "documentSha256": DOC, "docId": "ga-147461-x"}
GEO = {"points": [], "places": [], "placeHow": [], "geoBasins": ["Cooper"], "geotag": "basin", "basin": "Cooper", "well": None}


def test_layout_port_counts_utf16_units_and_carries_section_headings():
    # "😀" is two UTF-16 code units, so the paragraph after it starts at offset 9, as Document Intelligence reports it.
    content = "Intro 😀\nBody text"
    paragraphs = [{"role": "sectionHeading", "content": " Intro 😀 ", "spans": [{"offset": 0, "length": 8}],
                   "boundingRegions": [{"pageNumber": 1, "polygon": [1, 1, 2, 1, 2, 2, 1, 2]}]},
                  {"content": "Body text", "spans": [{"offset": 9, "length": 9}],
                   "boundingRegions": [{"pageNumber": 1, "polygon": [1, 3, 4, 3, 4, 4, 1, 4]}]}]
    sections = [{"elements": ["/paragraphs/0", "/paragraphs/1"]}]
    out = lib.normalize_layout(layout(content, [{"offset": 0, "length": 18}], paragraphs, sections), DOC_REF, GEO,
                               licence="CC BY 4.0", attribution="GA")
    assert [c["text"] for c in out["chunks"]] == [content]
    assert out["chunks"][0]["headingPath"] == ["Intro 😀"] and out["pages"][0]["confidence"] == 0.8
    assert json.loads(out["chunks"][0]["boundingRegionsSummaryJson"])[1] == {"page": 1, "unit": "inch", "x": 1, "y": 3, "width": 3, "height": 1}


def test_layout_port_splits_long_pages_at_a_boundary_and_refuses_other_models():
    content = ("word " * 1000).strip()
    out = lib.normalize_layout(layout(content, [{"offset": 0, "length": len(content)}]), DOC_REF, GEO, licence="x", attribution="y")
    assert [len(c["text"]) for c in out["chunks"]] == [3500, len(content) - 3500] and out["chunks"][0]["text"].endswith(" ")
    with pytest.raises(lib.LibraryError):
        lib.normalize_layout({**layout(content, []), "modelId": "prebuilt-read"}, DOC_REF, GEO, licence="x", attribution="y")


def test_chunk_parity_needs_identical_chunks_and_near_identical_vectors():
    a = [{**lib.chunk_row(chunk(0), "k"), "vector": [1.0, 0.0]}]
    assert lib.chunk_parity(a, [dict(a[0], vector=[0.9999, 0.001])])["equivalent"]
    assert not lib.chunk_parity(a, [dict(a[0], text="other")])["equivalent"]
    assert not lib.chunk_parity(a, [dict(a[0], vector=[0.0, 1.0])])["equivalent"]
