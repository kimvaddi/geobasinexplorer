"""Producer: provenance. The GeoBasin library sources and their indexed documents, the package source records, and
every file in the data bundle (SOURCE_MANIFEST.csv) with its origin, licence and checksum.

The library list comes from a snapshot of the live lane's published manifest (services/api/src/live/README.md), which
records the sources and documents the live pipeline indexed. Point GBX_LIVE_MANIFEST at that JSON file (default
build/live-manifest.json under the workspace); without one the library part is left out and the rest is still written.
"""
from __future__ import annotations

import csv
import json
import os
import re

from . import vocabulary as v
from .common import Bundle, clean, slug, snake_header, well_id

NAME = "geobasin-provenance"
MANIFEST = os.environ.get("GBX_LIVE_MANIFEST", "build/live-manifest.json")
TEGI = {"147461": "cooper", "147462": "adavale", "147460": "galilee", "147459": "northbowen"}
KEYWORDS = {"world stress map": "wsm2025", "natural earth": "naturalearth", "marabooka": "peps-sa-marabooka-1", "habanero": "peps-sa-habanero-1"}


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    path = bundle.workspace / MANIFEST
    live = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"manifestVersion": "none", "sources": []}
    meta = bundle.basins_pack["meta"]["sources"]
    w = writer_cls(out_root, name=NAME, title="GeoBasin sources and file provenance", priority=85, producer="producers/sources.py",
                   description="The licensed sources in the GeoBasin library with their indexed documents, and every file in the data bundle with its original source, URL, publisher, licence, checksum and use.",
                   sources=[{"id": "geobasin-library", "title": f"GeoBasin library manifest version {live.get('manifestVersion')}", "publisher": "GeoBasin Explorer AI", "licence": "Per source"}])
    for t in ("Source", "Document", "SourceFile"):
        v.entity_type(w, t)
    for r in ("partOfSource", "fileOfSource", "coversBasin", "aboutWell"):
        v.relationship_type(w, r)

    ids = set()
    for s in meta:
        sid = f"source:{s['id']}"
        ids.add(s["id"])
        w.add_entity("Source", id=sid, label=s["title"], properties=clean({"publisher": s.get("publisher"), "licence": s.get("licence"), "attribution": s.get("credit"),
                                                                            "doi": s.get("doi"), "url": f"https://doi.org/{s['doi']}" if s.get("doi") else None}))
    for s in live["sources"]:
        sid = f"source:{s['sourceId']}"
        ids.add(s["sourceId"])
        docs = s.get("documents", [])
        loc = s.get("wellLocation") or {}
        w.add_entity("Source", id=sid, label=s["title"], lon=loc.get("lon"), lat=loc.get("lat"), properties=clean({
            "publisher": s.get("publisher"), "licence": s.get("licence"), "attribution": s.get("attribution"), "sha256": s.get("sha256"),
            "extraction_version": s.get("extractionVersion"), "documents": len(docs), "pages": sum(d.get("pageCount") or 0 for d in docs),
            "chunks": sum(d.get("chunkCount") or 0 for d in docs), "in_live_library": True,
            "required_by_live_app": s["sourceId"] in set(live.get("requiredSourceIds") or [])}))
        for d in docs:
            did = f"doc:{d['docId']}"
            w.add_entity("Document", id=did, label=d.get("title") or d["docId"], properties=clean({
                "type": "library document", "pages": d.get("pageCount"), "chunks": d.get("chunkCount"), "sha256": d.get("sha256"),
                "publisher": s.get("publisher"), "licence": s.get("licence")}))
            w.add_relationship("partOfSource", did, "Document", sid, "Source")
        m = re.search(r"(\d{6})", s["sourceId"])
        if m and m.group(1) in TEGI and not re.search(r"ecat-", s["sourceId"]):
            w.add_relationship("coversBasin", sid, "Source", f"basin:{TEGI[m.group(1)]}", "Basin")
        m = re.match(r"peps-sa-(.+)$", s["sourceId"])
        if m:
            w.add_relationship("aboutWell", sid, "Source", well_id(m.group(1)), "Wellbore")
    for s in meta:
        m = re.search(r"(\d{6})", s["id"])
        if m and m.group(1) in TEGI:
            w.add_relationship("coversBasin", f"source:{s['id']}", "Source", f"basin:{TEGI[m.group(1)]}", "Basin")

    by_ecat: dict[str, list[str]] = {}
    for i in sorted(ids):
        m = re.search(r"(\d{5,6})", i)
        if m:
            by_ecat.setdefault(m.group(1), []).append(i)
    files = bundle.root / "SOURCE_MANIFEST.csv"  # the bundle's per-file list; a bundle made by tools/make_bundle.py has none
    with (files.open(encoding="utf-8-sig", newline="") if files.is_file() else open(os.devnull, encoding="utf-8")) as fh:
        for row in csv.DictReader(fh):
            fid = f"file:{slug(row['file_name'])}"
            props = clean({snake_header(k): (row[k] or "").strip() for k in row if k and k != "file_name"})
            props["path"] = row["file_name"]
            w.add_entity("SourceFile", id=fid, label=row["file_name"].rsplit("/", 1)[-1], properties=props)
            text = " ".join(row.get(k) or "" for k in ("original_source", "description", "file_name", "source_url")).lower()
            targets = set()
            for ecat in re.findall(r"(?:ecat\s*|ga-|/)(\d{5,6})", text):
                targets.update(by_ecat.get(ecat, []))
            for kw, sid in KEYWORDS.items():
                if kw in text and sid in ids:
                    targets.add(sid)
            for sid in sorted(targets):
                w.add_relationship("fileOfSource", fid, "SourceFile", f"source:{sid}", "Source")
    return w.close()
