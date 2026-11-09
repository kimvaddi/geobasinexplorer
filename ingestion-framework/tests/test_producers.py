"""Producer behaviour: borehole decoding and de-duplication, same-name well resolution, and document matching."""
from __future__ import annotations

from pathlib import Path

import pytest

from producers.common import Borehole, Bundle, snake_header, title_case, unique, well_id
from producers.ga_basins import borehole_records, cluster_boreholes, resolve_well
from producers.wellsites import _merge_site, match_doc

WORKSPACE = Path(__file__).resolve().parents[3]
BUNDLE = WORKSPACE / "GeoBasin_Explorer_AI_DATA_BUNDLE"
needs_bundle = pytest.mark.skipif(not (BUNDLE / "processed").is_dir(), reason="GeoBasin data bundle not present")


def hole(basin, index, lon, lat, td=None, year=None, name=None, kind="UNKNOWN"):
    return Borehole(basin=basin, index=index, lon=lon, lat=lat, td=td, type=kind, year=year, inside=True, major=False,
                    name=name, operator="", result="")


def test_well_ids_follow_the_kit_rules():
    assert well_id("GSQ Taroom 10") == "bh:taroom-10"
    assert well_id("  INNAMINCKA   1 ") == "bh:innamincka-1"
    assert title_case("DELHI DIO INNAMINCKA 1") == "Delhi DIO Innamincka 1"
    assert snake_header("Z(KB)") == "z_kb" and snake_header("1ST SHOT") == "c_1st_shot"
    assert unique(["depth", "depth", "time"]) == ["depth", "depth_2", "time"]


def test_cross_package_copies_of_one_borehole_merge_but_same_package_records_do_not():
    a = hole("adavale", 26, 143.92990, -25.50620, td=3105, year=1965, name="YONGALA 1")
    b = hole("galilee", 83, 143.92992, -25.50621, td=3105, year=1965, name="YONGALA 1")
    c = hole("galilee", 84, 143.92991, -25.50620, td=3105, year=1965)
    far = hole("cooper", 9, 143.9312, -25.5037, td=3100, year=1965, name="YONGALA 1")
    clusters = cluster_boreholes([a, b, c, far])
    assert sorted(len(x) for x in clusters) == [1, 1, 2]
    assert any({h.index for h in x} == {26, 83} for x in clusters)


def test_conflicting_depth_or_name_keeps_records_apart():
    a = hole("cooper", 1, 140.0, -27.0, td=1000, name="A 1")
    b = hole("galilee", 2, 140.0, -27.0, td=1200, name="A 1")
    c = hole("adavale", 3, 140.0, -27.0, td=1000, name="B 1")
    assert len(cluster_boreholes([a, b])) == 2
    assert len(cluster_boreholes([a, c])) == 2


def test_re_registrations_of_one_hole_merge_but_plugged_back_bores_do_not():
    petroleum = hole("galilee", 54, 145.0000, -25.0000, td=4184, year=1966, name="LEOPARDWOOD 1", kind="PETROLEUM")
    water = hole("galilee", 2347, 145.0002, -25.0001, td=4180, year=1965, name="PPC LEOPARDWOOD       NO1", kind="WATER")
    plugged = hole("galilee", 2386, 146.0, -24.0, td=2188, year=1965, name="PPC LISSOY NO.1", kind="WATER")
    lissoy = hole("galilee", 55, 146.0, -24.0, td=4137, year=1965, name="LISSOY 1", kind="PETROLEUM")
    clusters = cluster_boreholes([petroleum, water, plugged, lissoy])
    assert sorted(len(x) for x in clusters) == [1, 1, 2]
    merged = next(x for x in clusters if len(x) == 2)
    assert {h.index for h in merged} == {54, 2347}
    names = {"galilee": "Galilee Basin"}
    record = next(r for r in borehole_records([petroleum, water], names, {}) if len(r["members"]) == 2)
    assert record["id"] == "bh:leopardwood-1"
    assert len(cluster_boreholes([hole("galilee", 1, 145.0, -25.0, td=3048, name="NO1"), hole("galilee", 2, 145.0, -25.0, td=3048, name="NO 1")])) == 2


def test_shared_names_give_the_plain_id_to_the_kit_well():
    near = hole("cooper", 2987, 140.4787, -28.4707, td=1567, name="MCKINLAY 1")
    other = hole("galilee", 112, 142.2609, -21.591, td=421, name="MCKINLAY 1")
    names = {"cooper": "Cooper Basin", "galilee": "Galilee Basin"}
    ids = {r["id"] for r in borehole_records([other, near], names, {"bh:mckinlay-1": (140.47869, -28.47073)})}
    assert ids == {"bh:mckinlay-1", "bh:mckinlay-1@galilee.112"}
    unnamed = borehole_records([hole("cooper", 5, 141.0, -27.0)], names, {})
    assert unnamed[0]["id"] == "bh:ga-cooper-5" and unnamed[0]["label"].startswith("Unnamed borehole (Cooper Basin")


def test_site_records_merge_lists_by_id_without_overwriting():
    site = {"siteId": "x", "documents": [{"docId": "body", "title": "Report"}], "operator": "A"}
    _merge_site(site, {"documents": [{"docId": "body", "title": "Other"}, {"docId": "app3", "title": "Appendix 3"}], "operator": "B", "spudYear": 1959})
    assert [d["docId"] for d in site["documents"]] == ["body", "app3"] and site["documents"][0]["title"] == "Report"
    assert site["operator"] == "A" and site["spudYear"] == 1959


def test_passage_labels_map_to_document_ids():
    sites = {"innamincka-1": {"name": "Innamincka 1", "documents": [
        {"docId": "body", "title": "Well Completion Report, D.F.S. Innamincka No. 1 (report body)"},
        {"docId": "app4", "title": "Appendix 4 - Core analysis (Delhi core programme + Core Laboratories core records)"},
        {"docId": "ocr", "title": "Government OCR text of the report (GSQ portal)"}]}}
    velocity = {"well": "marabooka-1", "items": [{"itemId": "checkshot-table"}, {"itemId": "tz-diagram"}]}
    assert match_doc("Innamincka 1 · Appendix 4 - Core analysis (Delhi core programme + Core Laboratories core records)", sites, velocity) == "doc:innamincka-1:app4"
    assert match_doc("Innamincka 1 · Government OCR text", sites, velocity) == "doc:innamincka-1:ocr"
    assert match_doc("Innamincka 1 · something unlisted", sites, velocity) == "doc:innamincka-1:body"
    assert match_doc("Nowhere 9 · report", sites, velocity) is None


@pytest.fixture(scope="module")
def bundle():
    return Bundle.load(BUNDLE, WORKSPACE)


@needs_bundle
def test_borehole_layer_decodes_like_the_app(bundle):
    assert len(bundle.boreholes) == 21961
    inn = [h for h in bundle.boreholes if h.name == "INNAMINCKA 1"]
    assert len(inn) == 1 and inn[0].td == 3852 and inn[0].year == 1959 and inn[0].basin == "cooper"
    assert abs(inn[0].lon - 140.92013) < 1e-4 and abs(inn[0].lat + 27.48762) < 1e-4


@needs_bundle
def test_measurements_resolve_to_the_nearest_same_name_well(bundle):
    assert resolve_well(bundle, "Innamincka 1", 140.9202, -27.4876) == "bh:innamincka-1"
    assert resolve_well(bundle, "McKinlay 1", 140.4787, -28.4707) == "bh:mckinlay-1"
    galilee = resolve_well(bundle, "McKinlay 1", 142.2609, -21.591)
    assert galilee and galilee.startswith("bh:mckinlay-1@galilee")
    assert resolve_well(bundle, "Innamincka 1", 150.0, -20.0) is None
    assert resolve_well(bundle, "No Such Well 99") is None


def test_a_kit_well_is_located_in_a_basin_only_when_the_outline_contains_it():
    from producers.kit import _outside_outline

    def edge(source, target, source_type="Wellbore"):
        return {"source_id": source, "source_type": source_type, "target_id": target, "target_type": "Basin"}
    inside, covered = {"bh:gidgealpa-1": {"cooper"}, "bh:snatcher-2": set()}, {"cooper", "galilee"}
    assert not _outside_outline(edge("bh:gidgealpa-1", "basin:cooper"), inside, covered)
    assert _outside_outline(edge("bh:snatcher-2", "basin:cooper"), inside, covered)
    assert not _outside_outline(edge("bh:not-in-the-layer-1", "basin:cooper"), inside, covered)
    assert not _outside_outline(edge("bh:snatcher-2", "basin:eromanga"), inside, covered)
    assert not _outside_outline(edge("feature:cooper:nappamerri-trough", "basin:cooper", "StructuralElement"), inside, covered)


@needs_bundle
def test_the_borehole_layer_says_which_kit_wells_lie_outside_their_package_outline(bundle):
    from producers.ga_basins import wells_inside
    inside = wells_inside(bundle)
    assert inside["bh:gidgealpa-1"] == {"cooper"} and inside["bh:marabooka-1"] == {"cooper"}
    assert inside["bh:snatcher-2"] == set() and inside["bh:eromanga-1"] == set()


def test_feature_depth_prefers_the_depocentre_zone_like_the_app():
    from producers.ga_basins import _canonical_floor
    zone = {"max": 10046, "mean": 8759, "p90": 9755, "r": 25}
    fst = [9759, 6292, 8961, 3000, 25, "p", 7968]
    assert _canonical_floor(fst, zone)["basin_floor_max_m"] == 10046
    assert _canonical_floor(fst, zone)["basin_floor_basis"].startswith("depocentre zone")
    assert _canonical_floor(fst, None)["basin_floor_max_m"] == 9759
    assert _canonical_floor(fst, None)["basin_floor_basis"].startswith("circle around")
    assert _canonical_floor(None, None) == {}
