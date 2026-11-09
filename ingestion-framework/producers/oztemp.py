"""Producer: OzTemp subsurface temperatures for the four basin regions (lowcarbon-pack.json, oztemp.points).

Each temperature becomes a measurement linked to its well when the well name matches the Geoscience Australia
borehole layer, and to every basin whose outline contains it.
"""
from __future__ import annotations

from . import vocabulary as v
from .common import Bundle, norm_well, slug, title_case
from .ga_basins import resolve_well

NAME = "ga-oztemp"


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    oz = bundle.lowcarbon_pack["oztemp"]
    w = writer_cls(out_root, name=NAME, title="OzTemp well temperatures", priority=60, producer="producers/oztemp.py",
                   description=f"Subsurface temperature measurements from the Geoscience Australia OzTemp database inside the GeoBasin map window. {oz.get('credit', '')}".strip(),
                   sources=[{"id": "ga-oztemp", "title": "OzTemp interpreted temperature and well temperature database", "publisher": "Geoscience Australia", "licence": "CC BY 4.0"}])
    v.entity_type(w, "TemperatureMeasurement")
    v.relationship_type(w, "measuredIn")
    v.relationship_type(w, "locatedIn")
    seen: dict[str, int] = {}
    for name, lon, lat, depth, temp, method in oz["points"]:
        base = f"temp:oztemp:{slug(norm_well(name))}:{depth:g}"
        seen[base] = seen.get(base, 0) + 1
        tid = base if seen[base] == 1 else f"{base}:{seen[base]}"
        w.add_entity("TemperatureMeasurement", id=tid, label=f"{title_case(name)} at {depth:g} m", lon=lon, lat=lat, properties={
            "well_name": name, "depth_m": depth, "temperature_c": temp, "method": method, "source": "OzTemp"})
        wid = resolve_well(bundle, name, lon, lat)
        if wid:
            w.add_relationship("measuredIn", tid, "TemperatureMeasurement", wid, "Wellbore")
        for b in bundle.basins_at(lon, lat):
            w.add_relationship("locatedIn", tid, "TemperatureMeasurement", f"basin:{b}", "Basin")
    return w.close()
