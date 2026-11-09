"""Producer: World Stress Map 2025 records for Australia (source/geospatial/world-stress-map-2025/WSM_Database_2025.csv).

Each record becomes a stress measurement with every published column, linked to the basins whose outline contains
it and to its well when the locality names a well in the Geoscience Australia borehole layer.
"""
from __future__ import annotations

import csv

from . import vocabulary as v
from .common import Bundle, clean, num
from .ga_basins import resolve_well

NAME = "wsm-2025-australia"
TEXT = ("ISC_ID", "SITE", "TYPE", "QUALITY", "REGIME", "LOCALITY", "COUNTRY", "DATE", "TIME", "VENT", "ANISOTROPY", "METHOD", "MAG_TYPE", "CRUST", "COMMENT", "PLATE")
NUMBERS = ("NUMBER", "SD", "TOT_LEN", "TOP", "BOT", "S1AZ", "S1PL", "S2AZ", "S2PL", "S3AZ", "S3PL", "EQ_MAG", "DIST")


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    path = bundle.root / "source/geospatial/world-stress-map-2025/WSM_Database_2025.csv"
    wsm_meta = next((s for s in bundle.basins_pack["meta"]["sources"] if s["id"] == "wsm2025"), {})
    w = writer_cls(out_root, name=NAME, title="World Stress Map 2025 (Australia)", priority=60, producer="producers/wsm.py",
                   description="In-situ stress indicators for Australia from the World Stress Map Database Release 2025: orientation of the maximum horizontal stress, stress regime, quality rank, depth and method.",
                   sources=[{"id": "wsm2025", "title": wsm_meta.get("title", "World Stress Map Database Release 2025"), "publisher": wsm_meta.get("publisher", "World Stress Map project"),
                             "licence": wsm_meta.get("licence", "CC BY 4.0"), "url": "https://www.world-stress-map.org"}])
    v.entity_type(w, "StressMeasurement")
    v.relationship_type(w, "locatedIn")
    v.relationship_type(w, "measuredIn")
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("COUNTRY", "").strip().lower() != "australia":
                continue
            lon, lat = num(row["LON"]), num(row["LAT"])
            azi = num(row.get("AZI"))
            props = {k.lower(): row[k].strip() for k in TEXT if row.get(k, "").strip()}
            props.update(clean({k.lower(): num(row.get(k)) for k in NUMBERS}))
            props.update(clean({"azimuth_deg": int(azi) if azi is not None and azi != 999 else None, "depth_km": num(row.get("DEPTH")),
                                "references": ", ".join(row[k] for k in ("REF1", "REF2", "REF3", "REF4", "REF5", "REF6") if row.get(k))}))
            sid = f"wsm:{row['ID']}"
            where = row.get("LOCALITY") or row.get("SITE") or row["ID"]
            w.add_entity("StressMeasurement", id=sid, label=f"{where} ({row.get('TYPE') or 'type not recorded'}, quality {row.get('QUALITY') or '?'})", lon=lon, lat=lat, properties=props)
            if lon is None or lat is None:
                continue
            for b in bundle.basins_at(lon, lat):
                w.add_relationship("locatedIn", sid, "StressMeasurement", f"basin:{b}", "Basin")
            loc = (row.get("LOCALITY") or "").replace("-", " ").strip()
            wid = resolve_well(bundle, loc, lon, lat) if loc else None
            if wid:
                w.add_relationship("measuredIn", sid, "StressMeasurement", wid, "Wellbore")
    return w.close()
