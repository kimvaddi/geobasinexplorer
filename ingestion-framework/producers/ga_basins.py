"""Producer: Geoscience Australia TEGI basin packages (Cooper, Adavale, Galilee, North Bowen) from basins-pack.json.

Emits basins with their published facts and statistics, the borehole layers (de-duplicated where the package
bounding boxes overlap), structural features with depocentre depth statistics, named folds, numeric ages for the
stratigraphic units, and the text passages of the package documents.
"""
from __future__ import annotations

import csv
import math
import re

from . import vocabulary as v
from .common import Bundle, Borehole, clean, haversine_km, norm_well, slug, title_case, well_id

NAME = "ga-basin-packages"
CORE_DOCS = {"Cooper report": "doc:ga-cooper", "Adavale report": "doc:ga-adavale", "Galilee report": "doc:ga-galilee",
             "North Bowen report": "doc:ga-northbowen", "TEGI glossary": "doc:ga-glossary"}
SAME_HOLE_KM = 0.04
ALIAS_KM = 0.05


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    pack = bundle.basins_pack
    sources = [s for s in pack["meta"]["sources"] if s["id"].startswith("ga-")]
    w = writer_cls(out_root, name=NAME, title="Geoscience Australia basin packages (TEGI)", priority=80, producer="producers/ga_basins.py",
                   description="Basin outlines and statistics, borehole layers, structural features and depocentres, stratigraphic frameworks and document passages from the Geoscience Australia TEGI packages for the Cooper, Adavale, Galilee and North Bowen basins (CC BY 4.0).",
                   sources=[{"id": s["id"], "title": s["title"], "publisher": s["publisher"], "licence": s["licence"], "url": f"https://doi.org/{s['doi']}" if s.get("doi") else ""} for s in sources])
    for t in ("Basin", "Wellbore", "StructuralElement", "StratigraphicUnit", "EvidencePassage", "Document"):
        v.entity_type(w, t)
    for r in ("locatedIn", "aboutBasin", "fromDocument", "describes"):
        v.relationship_type(w, r)
    names = {b["id"]: b["name"] for b in pack["basins"]}
    for r in pack["basins"]:
        _basin(w, r)
        _features(w, r)
        _units(w, r)
        _passages(w, r)
    _boreholes(w, bundle.boreholes, names, _kit_anchors(bundle))
    return w.close()


def _basin(w, r: dict) -> None:
    st, ss, cat = r["stats"], r["stressSum"], r["catalogue"]
    t1 = {x["f"]: x["v"] for x in r["table1"]}
    props = clean({
        "state": r["state"], "age": r["age"], "area_km2": st.get("area_km2"), "published_area": t1.get("Area"),
        "depth_min_m": st.get("depth_min_m"), "depth_max_m": st.get("depth_max_m"), "depth_grid_title": r["depth"]["title"],
        "maximum_thickness": t1.get("Maximum thickness"), "maximum_depth_to_base": t1.get("Maximum depth to base"),
        "tectonic_setting": t1.get("Tectonic setting"), "key_structures": t1.get("Key structures"),
        "basin_overlies": t1.get("Basin overlies"), "basin_underlies": t1.get("Basin underlies"), "basins_adjacent": t1.get("Basins adjacent"),
        "boreholes_in_the_layer": r["bh"]["n"], "boreholes_inside": st.get("boreholes"),
        "boreholes_deeper_than_1000m": st.get("boreholes_gt1000"), "boreholes_deeper_than_2000m": st.get("boreholes_gt2000"),
        "boreholes_reaching_base": st.get("boreholes_reaching_base"), "key_boreholes": st.get("boreholes_key"),
        "seismic_km": st.get("seismic_km"), "seismic_lines": st.get("seismic_lines"), "seismic_surveys": st.get("seismic_surveys"),
        "faults": st.get("faults"), "fault_km": st.get("fault_km"), "folds": st.get("folds"), "depocentre_zones": st.get("zones"),
        "core_photos": st.get("core_photos"), "charts": st.get("charts"), "passages": st.get("passages"),
        "stress_records_inside": st.get("stress_n_in"), "stress_records_a_to_c_inside": st.get("stress_n_ABC_in"),
        "dominant_stress_regime": ss.get("dominant_regime"), "mean_shmax_azimuth_deg": ss.get("mean_azi_ABC"),
        "shmax_circular_std_deg": ss.get("circ_std"), "nearest_stress_record_km": ss.get("nearest_km"),
        "catalogue_title": cat.get("title"), "doi": cat.get("doi"), "ecat": cat.get("ecat"), "catalogue_year": cat.get("year"),
        "licence": cat.get("licence"), "bbox_west": r["bbox"][0], "bbox_south": r["bbox"][1], "bbox_east": r["bbox"][2], "bbox_north": r["bbox"][3],
    })
    w.add_entity("Basin", id=f"basin:{r['id']}", label=r["name"], properties=props, lon=r["labelAt"][0], lat=r["labelAt"][1], package_id=r["id"])


def _features(w, r: dict) -> None:
    bid = r["id"]
    zones = {z["n"]: z for z in r["zones"]}
    used = set()
    for f in r["features"]:
        fid = f"feature:{bid}:{slug(f['n'])}"
        props = {"type": f["t"], "kind": f["k"], "position_approximate": f["approx"]}
        if f.get("fst"):
            mx, mean, p90, mn, radius = f["fst"][:5]
            props.update(label_point_floor_max_m=mx, label_point_floor_mean_m=mean, label_point_floor_p90_m=p90,
                         label_point_floor_min_m=mn, label_point_radius_km=radius)
        z = zones.get(f.get("zone") or "")
        if z:
            used.add(z["n"])
            props.update(_zone_props(z))
        props.update(_canonical_floor(f.get("fst"), z))
        w.add_entity("StructuralElement", id=fid, label=f["n"], properties=clean(props), lon=f["lon"], lat=f["lat"], package_id=bid)
        w.add_relationship("locatedIn", fid, "StructuralElement", f"basin:{bid}", "Basin")
    for z in r["zones"]:
        if z["n"] in used:
            continue
        fid = f"feature:{bid}:{slug(z['n'])}"
        w.add_entity("StructuralElement", id=fid, label=z["n"], properties=clean({"type": "Depocentre", "kind": "low", **_zone_props(z), **_canonical_floor(None, z)}),
                     lon=z["c"][0], lat=z["c"][1], package_id=bid)
        w.add_relationship("locatedIn", fid, "StructuralElement", f"basin:{bid}", "Basin")
    for fold in r["folds"]:
        if not fold.get("n"):
            continue
        pts = fold["p"]
        length = sum(haversine_km(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
        mid = pts[len(pts) // 2]
        fid = f"feature:{bid}:{slug(fold['n'])}"
        w.add_entity("StructuralElement", id=fid, label=fold["n"], properties={"type": fold["k"].capitalize(), "fold_axis_length_km": round(length, 2)},
                     lon=mid[0], lat=mid[1], package_id=bid)
        w.add_relationship("locatedIn", fid, "StructuralElement", f"basin:{bid}", "Basin")


def _zone_props(z: dict) -> dict:
    return {"depocentre_max_depth_m": z["max"], "depocentre_mean_depth_m": z["mean"], "depocentre_p90_depth_m": z["p90"],
            "depocentre_area_km2": z["area"], "depocentre_radius_km": z["r"], "depocentre_boreholes": z["bh"]}


def _canonical_floor(fst: list | None, z: dict | None) -> dict:
    """The feature's depth to the basin floor, chosen as the GeoBasin app does: the depocentre zone centred on the deepest
    part of the feature when one exists, otherwise the circle around the feature's label point."""
    if z:
        return {"basin_floor_max_m": z["max"], "basin_floor_mean_m": z["mean"], "basin_floor_p90_m": z["p90"],
                "basin_floor_radius_km": z["r"], "basin_floor_basis": "depocentre zone centred on the deepest part of the feature"}
    if fst:
        mx, mean, p90, _, radius = fst[:5]
        return {"basin_floor_max_m": mx, "basin_floor_mean_m": mean, "basin_floor_p90_m": p90, "basin_floor_radius_km": radius,
                "basin_floor_basis": "circle around the feature's label point"}
    return {}


def _units(w, r: dict) -> None:
    for u in r["units"]:
        uid = f"unit:{slug(u['prov'])}:{slug(u['n'])}"
        w.add_entity("StratigraphicUnit", id=uid, label=u["n"], properties=clean({
            "age_top_ma": u.get("top"), "age_base_ma": u.get("base"), "ccs_potential": True if u.get("ccs") else None}))


def _doc_id(bid: str, doc: str) -> str:
    return CORE_DOCS.get(doc) or f"doc:ga-{bid}-{slug(doc)}"


def _passages(w, r: dict) -> None:
    bid = r["id"]
    for doc in sorted({p["doc"] for p in r["passages"]}):
        did = _doc_id(bid, doc)
        if doc not in CORE_DOCS:
            kind = ("metadata record" if "metadata" in doc.lower() else "reference list" if "references" in doc.lower()
                    else "play-interval table" if "table" in doc.lower() else "catalogue record" if "catalogue" in doc.lower() else "document")
            w.add_entity("Document", id=did, label=doc, properties={"type": kind, "publisher": "Geoscience Australia", "licence": "CC BY 4.0"}, package_id=bid)
            w.add_relationship("describes", did, "Document", f"basin:{bid}", "Basin")
    for p in r["passages"]:
        pid = f"passage:{p['id']}"
        label = f"{p['doc']}, page {p['page']}: {p['h']}" if p.get("h") else f"{p['doc']}, page {p['page']}"
        w.add_entity("EvidencePassage", id=pid, label=label[:200], properties=clean({"document": p["doc"], "page": p["page"], "heading": p.get("h"), "text": p["t"]}), package_id=bid)
        w.add_relationship("aboutBasin", pid, "EvidencePassage", f"basin:{bid}", "Basin")
        w.add_relationship("fromDocument", pid, "EvidencePassage", _doc_id(bid, p["doc"]), "Document")


def _close(a: int | None, b: int | None, tolerance: int) -> bool:
    return a is None or b is None or abs(a - b) <= tolerance


def alias_name(name: str) -> str:
    """Comparison form of a well name that also matches re-registrations such as 'PPC LEOPARDWOOD NO1' of 'LEOPARDWOOD 1'."""
    s = re.sub(r"^(PPC|P\.S\.)\s+", "", norm_well(name))
    return re.sub(r"\s+", " ", re.sub(r"\bNO\.?\s*(\d+)\b", r"\1", s)).strip()


def _alias_of(a: Borehole, b: Borehole) -> bool:
    """The same hole registered twice (for example once as a petroleum well and once as a water bore) in one or more layers."""
    if not (a.name and b.name) or haversine_km(a.lon, a.lat, b.lon, b.lat) > ALIAS_KM:
        return False
    key = alias_name(a.name)
    return bool(re.search(r"[A-Z]{3}", key)) and key == alias_name(b.name) and _close(a.td, b.td, 10) and _close(a.year, b.year, 1)


def _same_hole(a: Borehole, b: Borehole) -> bool:
    if a.basin == b.basin or haversine_km(a.lon, a.lat, b.lon, b.lat) > SAME_HOLE_KM:
        return False
    if a.td and b.td and a.td != b.td:
        return False
    if a.year and b.year and a.year != b.year:
        return False
    return not (a.name and b.name and norm_well(a.name) != norm_well(b.name))


def _joins(cluster: list[Borehole], h: Borehole) -> bool:
    if any(_alias_of(m, h) for m in cluster):
        return True
    return all(m.basin != h.basin for m in cluster) and _same_hole(cluster[0], h)


def cluster_boreholes(holes: list[Borehole]) -> list[list[Borehole]]:
    """Group records of the same physical borehole: copies in overlapping package layers, and re-registrations of one hole."""
    clusters: list[list[Borehole]] = []
    grid: dict[tuple[int, int], list[int]] = {}
    cell = 0.001
    for h in holes:
        cx, cy = math.floor(h.lon / cell), math.floor(h.lat / cell)
        hit = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ci in grid.get((cx + dx, cy + dy), ()):
                    if _joins(clusters[ci], h):
                        hit = ci
                        break
                if hit is not None:
                    break
            if hit is not None:
                break
        if hit is None:
            clusters.append([h])
            grid.setdefault((cx, cy), []).append(len(clusters) - 1)
        else:
            clusters[hit].append(h)
    return clusters


def _kit_anchors(bundle: Bundle) -> dict[str, tuple[float, float]]:
    """Positions of the curated kit's wells; where a well name is shared by several boreholes, the plain id goes to
    the borehole the kit means, so the two datasets merge on the same physical well."""
    path = bundle.processed("geology/fabric-iq-kit/entities/Wellbore.csv")
    if not path.exists():
        return {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return {r["id"]: (float(r["lon"]), float(r["lat"])) for r in csv.DictReader(fh) if r.get("lon") and r.get("lat")}


def borehole_records(holes: list[Borehole], names: dict[str, str], anchors: dict[str, tuple[float, float]]) -> list[dict]:
    """One record per physical borehole with its final id. A name shared by several boreholes gives the plain id to
    the one nearest the curated kit's position for that name (or the first in package order), and qualifies the
    others with their package record, for example bh:mckinlay-1@galilee.112."""
    clusters = cluster_boreholes(holes)
    by_id: dict[str, list[int]] = {}
    for i, c in enumerate(clusters):
        name = next((h.name for h in c if h.name), None)
        if name:
            by_id.setdefault(well_id(name), []).append(i)
    plain: dict[int, str] = {}
    for bid, members in by_id.items():
        if bid in anchors and len(members) > 1:
            lon, lat = anchors[bid]
            members = sorted(members, key=lambda i: haversine_km(clusters[i][0].lon, clusters[i][0].lat, lon, lat))
        plain[members[0]] = bid
    out = []
    for i, c in enumerate(clusters):
        first = c[0]
        name = next((h.name for h in c if h.name), None)
        if name:
            bid = plain.get(i) or f"{well_id(name)}@{first.basin}.{first.index}"
            label = title_case(name)
        else:
            bid = f"bh:ga-{first.basin}-{first.index}"
            label = f"Unnamed borehole ({names[first.basin]} layer, record {first.index})"
        out.append({"id": bid, "label": label, "name": name, "members": c, "lon": first.lon, "lat": first.lat})
    return out


def _records(bundle: Bundle) -> list[dict]:
    """borehole_records for the whole bundle, computed once and cached on it."""
    if "borehole_records" not in bundle.cache:
        names = {b["id"]: b["name"] for b in bundle.basins_pack["basins"]}
        bundle.cache["borehole_records"] = borehole_records(bundle.boreholes, names, _kit_anchors(bundle))
    return bundle.cache["borehole_records"]


def wells_inside(bundle: Bundle) -> dict[str, set[str]]:
    """Each borehole id to the basins whose outline contains it, as the Geoscience Australia layer flags it."""
    return {rec["id"]: {h.basin for h in rec["members"] if h.inside} for rec in _records(bundle)}


def well_index(bundle: Bundle) -> dict[str, list[tuple[str, float, float]]]:
    """Normalised well name to its boreholes (id, lon, lat), with the plain id first; cached on the bundle."""
    if "well_index" not in bundle.cache:
        idx: dict[str, list[tuple[str, float, float]]] = {}
        for rec in _records(bundle):
            if rec["name"]:
                idx.setdefault(norm_well(rec["name"]), []).append((rec["id"], rec["lon"], rec["lat"]))
        for key in idx:
            idx[key].sort(key=lambda t: "@" in t[0])
        bundle.cache["well_index"] = idx
    return bundle.cache["well_index"]


def resolve_well(bundle: Bundle, name: str, lon: float | None = None, lat: float | None = None, max_km: float = 5.0) -> str | None:
    """The borehole a measurement names: the nearest same-name borehole within max_km when a position is known."""
    cands = well_index(bundle).get(norm_well(name))
    if not cands:
        return None
    if lon is None or lat is None:
        return cands[0][0]
    best = min(cands, key=lambda t: haversine_km(t[1], t[2], lon, lat))
    return best[0] if haversine_km(best[1], best[2], lon, lat) <= max_km else None


def _boreholes(w, holes: list[Borehole], names: dict[str, str], anchors: dict[str, tuple[float, float]]) -> None:
    for rec in borehole_records(holes, names, anchors):
        c = rec["members"]
        bid, label, name = rec["id"], rec["label"], rec["name"]
        first = c[0]
        kind = next((h.type for h in c if h.type != "UNKNOWN"), "UNKNOWN").lower()
        inside = sorted({h.basin for h in c if h.inside})
        props = clean({
            "name": name, "type": kind, "total_depth_m": next((h.td for h in c if h.td), None), "year": next((h.year for h in c if h.year), None),
            "operator": next((h.operator for h in c if h.operator), None), "result": next((h.result for h in c if h.result), None),
            "major": any(h.major for h in c), "inside_basin_outline": bool(inside), "basins_inside": ",".join(inside),
            "basin_packages": ",".join(sorted({h.basin for h in c})), "ga_layer_records": ",".join(f"{h.basin}:{h.index}" for h in c),
        })
        w.add_entity("Wellbore", id=bid, label=label, properties=props, lon=round(first.lon, 5), lat=round(first.lat, 5), package_id=first.basin)
        for b in inside:
            w.add_relationship("locatedIn", bid, "Wellbore", f"basin:{b}", "Basin")
