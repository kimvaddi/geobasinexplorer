"""Producer: the GeoBasin application pack (app-pack.json) and the interpreted seismic figures.

Emits the basin-package dataset catalogue, numeric depths for the core images, numeric ages and evidence links for
the play intervals, the passages extracted from the scanned well reports, the interpreted figures, the data-quality
findings and validation checks, the 2D seismic line segments, and the recorded positions of Marabooka 1.
"""
from __future__ import annotations

import json

from . import vocabulary as v
from .common import Bundle, clean, haversine_km, num, slug, well_id
from .wellsites import load_sites, load_velocity, match_doc

NAME = "geobasin-app-pack"


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    app = bundle.app_pack
    w = writer_cls(out_root, name=NAME, title="GeoBasin application pack", priority=70, producer="producers/app_pack.py",
                   description="Records that GeoBasin Explorer AI prepared from the public sources: the dataset catalogue of each basin package, core images, play intervals, passages read from the scanned well reports, interpreted figures, data-quality findings, validation checks, 2D seismic coverage and well positions.",
                   sources=[{"id": "geobasin-app-pack", "title": f"GeoBasin application pack (built {app['built']})", "publisher": "GeoBasin Explorer AI", "licence": "CC BY 4.0 (derived from CC BY 4.0 sources)"}])
    for t in ("Dataset", "CoreImage", "PlayInterval", "EvidencePassage", "Figure", "DataQualityFinding", "ValidationCheck", "SeismicLine", "WellPosition"):
        v.entity_type(w, t)
    for r in ("coversBasin", "evidencedBy", "aboutWell", "fromDocument", "locatedIn", "positionOf"):
        v.relationship_type(w, r)
    passage_ids = {p["id"] for b in bundle.basins_pack["basins"] for p in b["passages"]}
    sites, velocity = load_sites(bundle), load_velocity(bundle)
    names = {b.id: b.name for b in bundle.basins}

    for d in app["datasets"]:
        did = f"dataset:{d['basin']}:{slug(d['name'])}"
        w.add_entity("Dataset", id=did, label=d["name"].replace("_", " "), package_id=d["basin"],
                     properties=clean({"name": d["name"], "format": d["fmt"], "records": d.get("records"), "crs": d.get("crs"), "licence": d.get("licence"), "file": d.get("file")}))
        w.add_relationship("coversBasin", did, "Dataset", f"basin:{d['basin']}", "Basin")

    core = app["core"]
    for p in core["panels"]:
        w.add_entity("CoreImage", id=f"core:{p['id']}", label=p["title"], package_id=p.get("basin"),
                     properties=clean({"product": p.get("code"), "play_key": p.get("play"), "image_width_px": p.get("w"), "image_height_px": p.get("h"), "scale": p.get("scale"), "file": p.get("file")}))
    for s in core["strips"]:
        w.add_entity("CoreImage", id=f"core:{s['id']}", label=f"{s['unit']} core strip, {s['well']}",
                     properties=clean({"panel": s.get("panel"), "unit": s.get("unit"), "well": s.get("well"), "depth_min_m": num(s.get("top")), "depth_max_m": num(s.get("base"))}))
    for p in core["photos"]:
        depths = [x for x in (num(d) for d in (p.get("depths_m") or [])) if x is not None]
        w.add_entity("CoreImage", id=f"core:{p['id']}", label=f"{p['formation']} core photograph",
                     properties=clean({"file": p.get("file"), "formation": p.get("formation"), "play": p.get("play"), "wells": ", ".join(p.get("wells", [])), "product": p.get("code"),
                                       "regions": ", ".join(p.get("regions", [])), "depth_min_m": min(depths) if depths else None, "depth_max_m": max(depths) if depths else None}))

    for p in app["plays"]:
        pid = f"play:{p['id']}"
        w.add_entity("PlayInterval", id=pid, label=p["play"], properties=clean({
            "age_top_ma": p.get("top"), "age_base_ma": p.get("base"), "interval": p.get("interval"), "stage": p.get("stage"), "period": p.get("period"),
            "ecat": p.get("ecat"), "basins": ", ".join(p.get("basins", [])), "units_in_play": len(p.get("units", [])),
            "depositional_environment": ", ".join(p.get("env", [])), "lithology": ", ".join(p.get("lith", [])),
            "resource_flags": ", ".join(p.get("res", [])), "petroleum_roles": ", ".join(p.get("roles", []))}))
        for ref in p.get("passages", []):
            if ref in passage_ids:
                w.add_relationship("evidencedBy", pid, "PlayInterval", f"passage:{ref}", "EvidencePassage")

    for p in app["extraPassages"]:
        pid = f"passage:{p['id']}"
        label = f"{p['doc']}, page {p['page']}: {p['h']}" if p.get("page") else f"{p['doc']}: {p['h']}"
        w.add_entity("EvidencePassage", id=pid, label=label[:200], properties=clean({"document": p["doc"], "page": p.get("page") or None, "heading": p.get("h"), "text": p["t"], "kind": p.get("kind")}))
        if p.get("well"):
            w.add_relationship("aboutWell", pid, "EvidencePassage", well_id(p["well"]), "Wellbore")
        doc = match_doc(p["doc"], sites, velocity)
        if doc:
            w.add_relationship("fromDocument", pid, "EvidencePassage", doc, "Document")

    figures = json.loads(bundle.processed("seismic/seismic-figures.json").read_text(encoding="utf-8"))
    for f in figures:
        fid = f"figure:{slug(f['doc'])}:p{f['page']}"
        read = "; ".join(f"{x['label']}: {x['value']} ({x.get('confidence', 'unrated')} confidence)" for x in f.get("extracted", []))
        w.add_entity("Figure", id=fid, label=f["title"], properties=clean({
            "document": f["doc"], "page": f["page"], "caption": f.get("caption"), "values_read": read, "values_read_count": len(f.get("extracted", [])),
            "legend": json.dumps(f["legend"], ensure_ascii=False) if isinstance(f.get("legend"), (list, dict)) else f.get("legend"),
            "reading_failures": len(f.get("failures", [])), "image_width_px": f.get("w"), "image_height_px": f.get("h")}))
        doc = match_doc(f["doc"], sites, velocity)
        if doc:
            w.add_relationship("fromDocument", fid, "Figure", doc, "Document")
        site = next((sid for sid, s in sites.items() if f["doc"].lower().startswith(s["name"].lower())), None)
        if site:
            w.add_relationship("aboutWell", fid, "Figure", well_id(site), "Wellbore")

    for f in app["checks"]["findings"]:
        w.add_entity("DataQualityFinding", id=f"dq:{f['id']}", label=f["title"],
                     properties=clean({"kind": f.get("kind"), "severity": f.get("severity"), "detail": f.get("detail"), "sources": ", ".join(f.get("sources", []))}))
    for i, c in enumerate(app["checks"]["validation"], 1):
        w.add_entity("ValidationCheck", id=f"check:{i:02d}-{slug(c['claim'])[:60]}", label=c["claim"],
                     properties=clean({"claim": c["claim"], "source_reference": c.get("src"), "computed": c.get("computed"), "matches": bool(c.get("match"))}))

    for basin_key, lines in app["seismic2d"].items():
        for i, seg in enumerate(lines):
            (x0, y0), (x1, y1) = seg[0], seg[-1]
            mid_lon, mid_lat = (x0 + x1) / 2, (y0 + y1) / 2
            sid = f"seismic:{basin_key}:{i}"
            w.add_entity("SeismicLine", id=sid, label=f"{names.get(basin_key, basin_key)} 2D seismic segment {i + 1}", lon=round(mid_lon, 5), lat=round(mid_lat, 5), package_id=basin_key,
                         properties={"length_km": round(sum(haversine_km(*seg[k], *seg[k + 1]) for k in range(len(seg) - 1)), 3), "start_lon": x0, "start_lat": y0, "end_lon": x1, "end_lat": y1, "basin_package": basin_key})
            for b in bundle.basins_at(mid_lon, mid_lat):
                w.add_relationship("locatedIn", sid, "SeismicLine", f"basin:{b}", "Basin")

    pos = app["positions"]
    wid = well_id(pos["well"])
    rows = list(pos["rows"])
    ga = pos.get("ga") or {}
    if ga.get("lat") is not None:
        rows.insert(0, {"source": "Geoscience Australia borehole layer", "datum": "GDA94", "lat": ga["lat"], "lon": ga["lon"], "kmFromGA": 0.0, "how": ga.get("src") or ga.get("source"), "confidence": "reference"})
    for i, r in enumerate(rows):
        pid = f"position:{pos['well']}:{i}"
        w.add_entity("WellPosition", id=pid, label=f"{r['source']} position", lon=r.get("lon"), lat=r.get("lat"),
                     properties=clean({"source": r.get("source"), "printed": r.get("printed"), "datum": r.get("datum"), "km_from_ga": r.get("kmFromGA"), "how": r.get("how"), "confidence": r.get("confidence")}))
        w.add_relationship("positionOf", pid, "WellPosition", wid, "Wellbore")
    return w.close()
