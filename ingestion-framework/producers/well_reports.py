"""Producer: what was read from the scanned well reports (wells.json, lowcarbon-sites.json, velocity.json).

This is the document-extraction layer: each report document, every value read from it with its page, quote,
confidence and review flag, the findings the reports state, the temperature log, the checkshot survey and the
time-depth curve, plus the carbon-storage project context. It shows how unstructured documents become entities and
relationships that the framework can load.
"""
from __future__ import annotations

from . import vocabulary as v
from .common import Bundle, clean, num, slug, snake_header, unique, well_id
from .wellsites import load_sites, load_velocity, site_doc_id, velocity_doc_id

NAME = "geobasin-well-reports"
INPUTS = {"targetDepthM": "target_depth_m", "fracGradKPaM": "fracture_gradient_kpa_per_m", "porePressureMPa": "pore_pressure_mpa",
          "tdsMgL": "formation_water_tds_mg_per_l", "porosityPct": "porosity_pct", "permMd": "permeability_md", "oz5kmC": "oztemp_5km_temperature_c"}


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    sites, velocity = load_sites(bundle), load_velocity(bundle)
    srcs = sorted({(s["source"].get("publisher", ""), s["source"].get("licence", "")) for s in sites.values() if s.get("source")})
    w = writer_cls(out_root, name=NAME, title="Values and findings read from scanned well reports", priority=90, producer="producers/well_reports.py",
                   description="Well completion reports, appendices and enclosures for Innamincka 1, Marabooka 1, ZeroGen 2 and Habanero 1, read page by page: the documents, each extracted value with page, quote, confidence and review status, the stated findings, the temperature log, the checkshot survey and the time-depth curve.",
                   sources=[{"id": f"well-reports-{i}", "title": "Open-file well reports", "publisher": p, "licence": lic} for i, (p, lic) in enumerate(srcs, 1)])
    for t in ("Document", "ExtractedField", "ReportFinding", "WellLog", "TemperatureMeasurement", "PressureMeasurement", "CheckshotReading", "TimeDepthPoint", "LowCarbonProject"):
        v.entity_type(w, t)
    # Values read from a well's own completion report outrank the rounded borehole-layer attributes and the kit.
    v.entity_type(w, "Wellbore", priority=110)
    for r in ("reportFor", "aboutWell", "fromDocument", "measuredIn", "partOfLog", "locatedIn"):
        v.relationship_type(w, r)
    for sid in sorted(sites):
        _site(w, sites[sid])
    _velocity(w, velocity)
    for c in bundle.lowcarbon_pack.get("context", []):
        pid = f"project:{c['id']}"
        facts = " ".join(f"{f['text']} ({f.get('source', 'source not named')}{', ' + f['url'] if f.get('url') else ''})" for f in c.get("facts", []))
        w.add_entity("LowCarbonProject", id=pid, label=c["name"], lon=c["lon"], lat=c["lat"], properties=clean({"tag": c.get("tag"), "position_note": c.get("positionNote"), "facts": facts}))
        for b in bundle.basins_at(c["lon"], c["lat"]):
            w.add_relationship("locatedIn", pid, "LowCarbonProject", f"basin:{b}", "Basin")
    return w.close()


def _site(w, s: dict) -> None:
    sid, wid = s["siteId"], well_id(s["name"])
    props = {"spud_year": s.get("spudYear"), "operator": s.get("operator"), "total_depth_m": s.get("totalDepthM"), "position_source": s.get("positionSource"),
             "report_summary": s.get("role"), "kind": s.get("kind"), "tag": s.get("tag"), "headline": s.get("headline"), "identity_issue": s.get("identityIssue"),
             "lenses": ", ".join(s.get("lenses", [])) or None, "report_documents_in_package": (s.get("stats") or {}).get("docsInPackage"),
             "report_pages_read": (s.get("stats") or {}).get("pagesSampled"), "report_fields_needing_review": (s.get("stats") or {}).get("fieldsNeedReview")}
    for k, col in INPUTS.items():
        val = (s.get("inputs") or {}).get(k)
        props[col] = val if isinstance(val, (int, float)) and not isinstance(val, bool) else None
    w.add_entity("Wellbore", id=wid, label=s["name"], properties=clean(props), lon=s.get("lon"), lat=s.get("lat"))
    for d in s.get("documents", []):
        did = site_doc_id(sid, d["docId"])
        pages = d.get("pages")
        w.add_entity("Document", id=did, label=d["title"], properties=clean({
            "type": d.get("kind"), "file": d.get("file"), "year": d.get("year"), "pages": pages if isinstance(pages, int) else None,
            "format": d.get("format"), "readability": d.get("readability"), "note": d.get("note"), "publisher": (s.get("source") or {}).get("publisher"),
            "licence": (s.get("source") or {}).get("licence")}))
        w.add_relationship("reportFor", did, "Document", wid, "Wellbore")
    for f in s.get("fields", []):
        fid = f"field:{sid}:{f['fieldId']}"
        ocr = f.get("ocrBaseline") or {}
        w.add_entity("ExtractedField", id=fid, label=f"{s['name']}: {f['label']}", properties=clean({
            "field": f["fieldId"], "group": f.get("group"), "value": None if f.get("value") is None else str(f["value"]), "page": f.get("page"),
            "quote": f.get("quote"), "method": f.get("method"), "confidence": f.get("confidence"), "confidence_reason": f.get("confidenceWhy"),
            "needs_review": bool(f.get("needsReview")), "ocr_comparison": ocr.get("status"), "ocr_text": ocr.get("text")}))
        w.add_relationship("aboutWell", fid, "ExtractedField", wid, "Wellbore")
        if f.get("docId"):
            w.add_relationship("fromDocument", fid, "ExtractedField", site_doc_id(sid, f["docId"]), "Document")
    for f in s.get("findings", []):
        fid = f"finding:{sid}:{f['findingId']}"
        w.add_entity("ReportFinding", id=fid, label=f"{s['name']} {f.get('topic', 'finding')}: {f['text'][:120]}", properties=clean({
            "topic": f.get("topic"), "text": f.get("text"), "quote": f.get("quote"), "page": f.get("page"), "confidence": f.get("confidence")}))
        w.add_relationship("aboutWell", fid, "ReportFinding", wid, "Wellbore")
        if f.get("docId"):
            w.add_relationship("fromDocument", fid, "ReportFinding", site_doc_id(sid, f["docId"]), "Document")
    for c in s.get("curves", []):
        _curve(w, s, sid, wid, c)


def _curve(w, s: dict, sid: str, wid: str, c: dict) -> None:
    lid = f"log:{sid}:{c['curveId']}"
    pts = c.get("points", [])
    unit = c.get("unit") or ""
    kind = "temperature" if "°C" in unit or "C" == unit else "pressure" if "pa" in unit.lower() else "other"
    w.add_entity("WellLog", id=lid, label=f"{s['name']}: {c.get('label', c['curveId'])}"[:200], properties=clean({
        "curve": c["curveId"], "kind": kind, "unit": unit, "depth_unit": c.get("depthUnit"), "note": c.get("note"), "points": len(pts),
        "depth_min_m": min((p[0] for p in pts), default=None), "depth_max_m": max((p[0] for p in pts), default=None),
        "value_min": min((p[1] for p in pts), default=None), "value_max": max((p[1] for p in pts), default=None)}))
    w.add_relationship("measuredIn", lid, "WellLog", wid, "Wellbore")
    if c.get("docId"):
        w.add_relationship("fromDocument", lid, "WellLog", site_doc_id(sid, c["docId"]), "Document")
    if kind == "other":
        return
    etype = "TemperatureMeasurement" if kind == "temperature" else "PressureMeasurement"
    for i, (depth, value) in enumerate(pts):
        mid = f"{'temp' if kind == 'temperature' else 'pres'}:{sid}:{c['curveId']}:{i:03d}"
        props = {"depth_m": depth, "method": c.get("label"), "source": "well log", "well_name": s["name"]}
        props["temperature_c" if kind == "temperature" else "pressure_mpa"] = value
        w.add_entity(etype, id=mid, label=f"{s['name']} {kind} at {depth:g} m ({c['curveId']})", properties=props)
        w.add_relationship("measuredIn", mid, etype, wid, "Wellbore")
        w.add_relationship("partOfLog", mid, etype, lid, "WellLog")


def _velocity(w, vel: dict) -> None:
    site = vel["well"]
    wid = well_id(site)
    for it in vel["items"]:
        did = velocity_doc_id(vel, it["itemId"])
        scan = it.get("scan") or {}
        w.add_entity("Document", id=did, label=f"{it['title'].title()} ({site.replace('-', ' ').title()})", properties=clean({
            "type": it.get("kind"), "file": it.get("file"), "format": scan.get("bits"), "readability": scan.get("readability"), "note": scan.get("note"),
            "publisher": (vel.get("source") or {}).get("publisher"), "licence": (vel.get("source") or {}).get("licence")}))
        w.add_relationship("reportFor", did, "Document", wid, "Wellbore")
        for val in it.get("values", []):
            fid = f"field:{site}:{val['valueId']}"
            w.add_entity("ExtractedField", id=fid, label=f"{site.replace('-', ' ').title()}: {val['label']}", properties=clean({
                "field": val["valueId"], "value": None if val.get("value") is None else str(val["value"]), "quote": val.get("quote"),
                "confidence": val.get("confidence"), "needs_review": bool(val.get("needsReview")), "note": val.get("note"), "method": "vision-read"}))
            w.add_relationship("aboutWell", fid, "ExtractedField", wid, "Wellbore")
            w.add_relationship("fromDocument", fid, "ExtractedField", did, "Document")
        headers = unique([snake_header(h) for h in it.get("headers", [])])
        for row in it.get("rows", []):
            cells = dict(zip(headers, row.get("cells", [])))
            shot = cells.get(headers[0]) if headers else None
            rid = f"checkshot:{site}:{slug(str(shot)) or len(cells)}"
            props = {k: (num(x) if num(x) is not None else x) for k, x in cells.items() if x not in (None, "")}
            props.update(clean({"confidence": row.get("confidence"), "needs_review": bool(row.get("needsReview")), "note": row.get("note")}))
            w.add_entity("CheckshotReading", id=rid, label=f"Marabooka 1 checkshot shot {shot}", properties=props)
            w.add_relationship("measuredIn", rid, "CheckshotReading", wid, "Wellbore")
            w.add_relationship("fromDocument", rid, "CheckshotReading", did, "Document")
        for i, p in enumerate(it.get("curvePoints", [])):
            pid = f"tz:{site}:{i:03d}"
            depth_ft = num(p.get("depthFtMSL"))
            w.add_entity("TimeDepthPoint", id=pid, label=f"Marabooka 1 time-depth point at {depth_ft:g} ft below MSL", properties=clean({
                "depth_ft_msl": depth_ft, "depth_m_msl": round(depth_ft * 0.3048, 2) if depth_ft is not None else None,
                "two_way_time_s": num(p.get("twtSec")), "confidence": p.get("confidence")}))
            w.add_relationship("measuredIn", pid, "TimeDepthPoint", wid, "Wellbore")
            w.add_relationship("fromDocument", pid, "TimeDepthPoint", did, "Document")
