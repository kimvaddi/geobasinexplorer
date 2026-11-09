import csv
import json
from datetime import datetime, timezone

import pyarrow as pa
import pytest

from ontology_ingest.contract import DatasetWriter
from ontology_ingest.delta import InMemoryWriter, LocalDeltaWriter
from ontology_ingest.plan import OntologyPlan
from ontology_ingest.prepare import run as prepare_run
from ontology_ingest.storage import LocalFolder, MemoryStorage
from ontology_ingest.tmdl import build_definition


def run(*args, **kwargs):
    # Data-transformation tests pin in-place names; test_staging exercises the safe default.
    kwargs.setdefault("publish_mode", "in_place")
    return prepare_run(*args, **kwargs)


@pytest.fixture
def landing(tmp_path):
    root = tmp_path / "landing"
    alpha = DatasetWriter(root / "alpha", name="alpha", priority=10)
    alpha.entity_type("Tree", priority=90, description="A tree", synonyms=["plant"])
    alpha.entity_type("NoRows")
    alpha.add_entity("Tree", id="a", label="Alpha", properties={"height": "3,852 m", "count": "oops", "id": "external-id", "leaf": None})
    alpha.add_entity("Tree", id="b", label="Bee", properties={"height": "not recorded", "leaf": "yes"})
    alpha.add_entity("Group", id="g", label="Low priority")
    alpha.relationship_type("emptyRelation")
    alpha.add_relationship("links", "a", "Tree", "g", "Group")
    alpha.add_relationship("parent", "b", "Tree", "a", "Tree")
    alpha.close()
    beta = DatasetWriter(root / "beta", name="beta", priority=50)
    beta.entity_type("Tree", synonyms=["arbor"], properties={"count": {"dataType": "int64"}})
    beta.add_entity("Tree", id="a", label="Beta", properties={"height": "4,000 m", "count": 100, "leaf": False, "date": "2025-03-01T01:00:00+01:00"})
    beta.add_entity("Tree", id="c", label="Cee", properties={"height": "5,000 m", "count": "5", "date": "2025-03-02"})
    beta.add_entity("Group", id="g", label="Higher priority")
    beta.add_relationship("links", "g", "Group", "a", "Tree")
    beta.add_relationship("links", "a", "Tree", "g", "Group")
    beta.add_relationship("parent", "b", "Tree", "a", "Tree")
    beta.close()
    with (root / "alpha/entities/Tree.csv").open("a", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["a", "Duplicate ignored", '{"ignored":true}'])
        writer.writerow(["", "No id", "{}"])
    (root / "beta/relationships/bad.csv").write_text(
        "source_id,source_type,target_id,target_type\n"
        ",Tree,g,Group\n"
        "a,Unknown,g,Group\n"
        "a,Tree,g,Unknown\n"
        "missing,Tree,g,Group\n"
        "a,Tree,missing,Group\n", encoding="utf-8")
    return root


def test_prepare_two_datasets_merges_types_derivations_edges_and_audit(landing, tmp_path):
    tables = InMemoryWriter()
    reports = LocalFolder(tmp_path / "reports")
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    summary = run(LocalFolder(landing), tables, "test", output=reports, now=now)
    plan = OntologyPlan.from_json(reports.read_bytes(summary["planPath"]))
    quality = json.loads(reports.read_bytes(summary["qualityPath"]))
    rows = {row["id"]: row for row in tables.tables["dbo", "tree"].to_pylist()}
    assert rows["a"]["label"] == "Alpha"
    assert rows["a"]["height_m"] == 3852.0 and rows["a"]["height"] == "3,852 m"
    assert rows["b"]["height_m"] is None and rows["b"]["height"] is None
    assert rows["a"]["leaf"] is False and rows["b"]["leaf"] is True
    assert rows["a"]["count"] == 100 and rows["c"]["count"] == 5
    assert rows["a"]["source_datasets"] == "alpha,beta" and rows["a"]["id_prop"] == "external-id"
    assert rows["a"]["date"] == datetime(2025, 3, 1, tzinfo=timezone.utc)
    assert "ignored" not in rows["a"]
    assert tables.tables["dbo", "group"].to_pylist()[0]["label"] == "Higher priority"
    assert tables.tables["dbo", "tree"].schema.field("date").type == pa.timestamp("us", tz="UTC")
    assert tables.tables["dbo", "tree"].schema.names[:2] == ["id", "label"]
    assert quality["conflicts"]["Tree"]["label"] == 1
    assert quality["castErrors"] == [{"entity": "Tree", "column": "count", "dataType": "int64", "count": 1}]
    assert quality["skippedEntities"] == ["NoRows"]
    assert "emptyRelation" in quality["skippedRelationships"]
    assert quality["duplicateEdges"] == 2
    assert set(quality["quarantinedEdges"]["byReason"]) == {"empty_id", "unknown_source_type", "unknown_target_type", "missing_source", "missing_target"}
    assert summary["entityRows"] == 4 and summary["edges"] == 3 and summary["quarantinedEdges"] == 5
    assert {rel.name for rel in plan.relationships} == {"links_Tree_Group", "links_Group_Tree", "parent"}
    entity = next(entity for entity in plan.entities if entity.name == "Tree")
    assert entity.synonyms == ["arbor", "plant"]
    derived = next(prop for prop in entity.properties if prop.name == "height_m")
    assert derived.unit == "m" and derived.derivedFrom == "height"
    raw = tables.tables["raw", "alpha__e_tree"]
    assert raw.num_rows == 4
    assert raw.schema.field("properties_json").type == pa.string()
    assert raw.schema.field("_row_number").type == pa.int64()
    assert raw.to_pylist()[0]["_ingested_at"] == now
    parts = build_definition(plan, "Test", "A test", "endpoint.invalid", "id")
    assert "relationship rel_parent__to\n" in parts["relationships.tmdl"]
    assert "\tisActive: false\n\tfromColumn: rel_parent.target_id" in parts["relationships.tmdl"]
    original_plan = reports.read_bytes(summary["planPath"])
    original_quality = reports.read_bytes(summary["qualityPath"])
    run(LocalFolder(landing), tables, "test", output=reports, now=now)
    assert reports.read_bytes(summary["planPath"]) == original_plan
    assert reports.read_bytes(summary["qualityPath"]) == original_quality


def test_cross_dataset_aliases_share_columns_and_local_native_values_win():
    store = MemoryStorage({
        "a/entities/T.jsonl": b'{"id":"a","label":"a","properties_json":{"depth":"10 m","depth_m":7,"a-b":1,"id":"foreign"}}\n',
        "b/entities/T.jsonl": b'{"id":"b","label":"b","properties_json":{"a b":2,"depth":"20 m"}}\n',
    })
    writer = InMemoryWriter()
    summary = run(store, writer, "r")
    report = json.loads(store.read_bytes(summary["qualityPath"]))
    rows = writer.tables["dbo", "t"].to_pylist()
    assert report["columnMaps"]["T"]["b"]["a b"] == report["columnMaps"]["T"]["a"]["a-b"] == "a_b"
    assert rows[0]["depth_m"] == 7 and rows[1]["depth_m"] == 20.0
    assert "depth_m_2" not in writer.tables["dbo", "t"].column_names
    assert report["conflicts"]["T"]["depth_m"] == 1
    assert rows[0]["id_prop"] == "foreign"


def test_bad_json_properties_nested_values_and_raw_headers_are_preserved():
    store = MemoryStorage({"d/entities/T.jsonl":
        b'{"id":"a","label":"a","properties_json":"not json","Bad Header (m)":"12","_dataset":"original"}\n'
        b'{"id":"b","label":"b","properties_json":{"nested":{"x":[1,null]},"raw value":2},"raw value":3}\n'
        b'not-json\n'})
    writer = InMemoryWriter()
    summary = run(store, writer, "r")
    report = json.loads(store.read_bytes(summary["qualityPath"]))
    assert {error["code"] for error in report["parseErrors"]} == {"row_parse", "properties_json", "flat_property_collision"}
    raw = writer.tables["raw", "d__e_t"].to_pylist()
    assert raw[0]["_dataset"] == "d" and raw[0]["dataset"] == "original"
    assert raw[2]["unparsed_json"] == "not-json"
    rows = writer.tables["dbo", "t"].to_pylist()
    assert rows[0]["bad_header_m"] == 12
    assert rows[1]["nested"] == '{"x":[1,null]}' and rows[1]["raw_value"] == 3


def test_priority_tie_uses_dataset_name_and_declared_types_are_reported():
    store = MemoryStorage({"z/dataset.json": b'{"entityTypes":{"T":{"properties":{"v":{"dataType":"double"}}}}}',
        "a/dataset.json": b'{"entityTypes":{"T":{"properties":{"v":{"dataType":"int64"}}}}}',
        "a/entities/T.csv": b'id,label,v\nx,A,1\n', "z/entities/T.csv": b'id,label,v\nx,Z,2.4\n'})
    writer = InMemoryWriter()
    summary = run(store, writer, "r")
    assert writer.tables["dbo", "t"].to_pylist()[0]["label"] == "A"
    assert writer.tables["dbo", "t"].schema.field("v").type == pa.int64()
    assert json.loads(store.read_bytes(summary["qualityPath"]))["declarationConflicts"][0]["chosen"] == "int64"


def test_declared_type_matches_sanitized_name_without_creating_a_second_column():
    store = MemoryStorage({"d/dataset.json": b'{"entityTypes":{"T":{"properties":{"depth_m":{"dataType":"string","description":"Keep original"}}}}}',
                           "d/entities/T.jsonl": b'{"id":"a","label":"a","Depth (m)":12}\n'})
    writer = InMemoryWriter()
    summary = run(store, writer, "r")
    assert writer.tables["dbo", "t"].to_pylist()[0]["depth_m"] == "12"
    plan = OntologyPlan.from_json(store.read_bytes(summary["planPath"]))
    assert next(prop for prop in plan.entities[0].properties if prop.name == "depth_m").description == "Keep original"


@pytest.mark.parametrize("files", [
    {"d/entities/FooBar.csv": b"id,label\na,A\n", "d/entities/Foo_Bar.csv": b"id,label\nb,B\n"},
    {"a-b/entities/T.csv": b"id,label\na,A\n", "a_b/entities/T.csv": b"id,label\nb,B\n"},
    {"d/entities/T.csv": b"id,label\na,A\n", "d/entities/RelLinks.csv": b"id,label\na,A\n",
     "d/relationships/links.csv": b"source_id,source_type,target_id,target_type\na,T,a,T\n"},
])
def test_table_collisions_fail_before_any_write(files):
    writer = InMemoryWriter()
    with pytest.raises(ValueError, match="collision|junction"):
        run(MemoryStorage(files), writer, "r")
    assert not writer.tables


def test_large_strings_fail_before_any_write():
    row = json.dumps({"id": "a", "label": "🦆" * 17000}).encode()
    writer = InMemoryWriter()
    with pytest.raises(ValueError, match="65535"):
        run(MemoryStorage({"d/entities/T.jsonl": row}), writer, "r")
    assert not writer.tables


def test_empty_plan_and_parquet_fallback(tmp_path):
    store = MemoryStorage({"d/entities/T.csv": b"id,label\n", "d/relationships/r.csv": b"source_id,source_type,target_id,target_type\n"})
    writer = LocalDeltaWriter(tmp_path, use_delta=False)
    summary = run(store, writer, "empty")
    assert summary["entities"] == 0 and summary["relationships"] == 0
    assert writer.count_rows("raw", "d__e_t") == 0
    assert writer.count_rows("raw", "quarantine_edges") == 0
    assert json.loads((writer.path("raw", "d__e_t") / "_format.json").read_text())["format"] == "parquet-fallback"


def test_failed_overwrite_marks_the_old_plan_unusable_before_publishing():
    from ontology_ingest.workflow import publish_plan
    landing = MemoryStorage({"d/entities/T.csv": b"id,label\na,A\n"})
    output = MemoryStorage()
    summary = run(landing, InMemoryWriter(), "same", output=output)
    original_plan = output.read_bytes(summary["planPath"])

    class FailingWriter:
        def write(self, schema, table, data):
            raise RuntimeError("write failed")
    with pytest.raises(RuntimeError, match="write failed"):
        run(landing, FailingWriter(), "same", output=output)
    assert output.read_bytes(summary["planPath"]) == original_plan
    status = json.loads(output.read_bytes(summary["statusPath"]))
    assert status["state"] == "failed"
    with pytest.raises(ValueError, match="not complete"):
        publish_plan(object(), output, "lh", summary["planPath"], "Test")


def test_json_and_csv_empty_properties_are_both_null():
    store = MemoryStorage({"d/entities/J.jsonl": b'{"id":"a","label":"","value":""}\n{"id":"b","label":"B","value":"2"}\n',
                           "d/entities/C.csv": b'id,label,value\na,,\nb,B,2\n'})
    writer = InMemoryWriter()
    run(store, writer, "r")
    assert writer.tables["dbo", "j"].to_pylist()[0]["value"] is None
    assert writer.tables["dbo", "j"].to_pylist()[0]["label"] is None
    assert writer.tables["dbo", "j"].schema.field("value").type == pa.int64()
    assert writer.tables["dbo", "c"].to_pylist()[0]["value"] is None
    assert writer.tables["dbo", "c"].schema.field("value").type == pa.int64()


def _prepared_properties(sources):
    files = {}
    for dataset, (metadata, rows) in sources.items():
        files[f"{dataset}/dataset.json"] = json.dumps(metadata).encode()
        files[f"{dataset}/entities/T.jsonl"] = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows).encode()
    store = MemoryStorage(files)
    writer = InMemoryWriter()
    summary = run(store, writer, "properties")
    plan = OntologyPlan.from_json(store.read_bytes(summary["planPath"]))
    return writer.tables["dbo", "t"], plan.entities[0], json.loads(store.read_bytes(summary["qualityPath"]))


def test_property_identity_is_canonical_across_datasets_and_metadata_uses_own_raw_keys():
    table, entity, quality = _prepared_properties({
        "kit": ({"priority": 90, "title": "Curated kit", "entityTypes": {"T": {"properties": {
            "Year": {"dataType": "string", "description": "The reporting\nyear."}}}}},
            [{"id": "a", "label": "A", "properties_json": {"Operator": "Kit", "Type": "Well", "Year": 1959, "Result": None, "Resource flags": "gas"}}]),
        "ga": ({"priority": 50, "title": "Geoscience archive", "entityTypes": {"T": {"properties": {
            "year": {"dataType": "int64", "description": "Lower priority description."}}}}},
            [{"id": "a", "label": "A", "operator": "GA", "type": "Hole", "year": 2026, "result": "Oil", "resource_flags": "oil"}]),
    })
    assert set(table.column_names) == {"id", "label", "operator", "type", "year", "result", "resource_flags", "source_datasets"}
    row = table.to_pylist()[0]
    assert (row["operator"], row["type"], row["year"], row["result"]) == ("Kit", "Well", "1959", "Oil")
    assert quality["columnMaps"]["T"]["kit"]["Operator"] == quality["columnMaps"]["T"]["ga"]["operator"] == "operator"
    assert quality["columnMaps"]["T"]["kit"]["Resource flags"] == "resource_flags"
    assert quality["conflicts"]["T"]["operator"] == 1
    assert quality["declarationConflicts"][0]["chosen"] == "string"
    prop = next(prop for prop in entity.properties if prop.name == "year")
    assert prop.description == "The reporting year."


def test_only_collisions_inside_one_dataset_get_suffixes_and_keep_their_metadata():
    table, entity, quality = _prepared_properties({
        "a": ({"priority": 50, "entityTypes": {"T": {"properties": {
            "operator name": {"description": "Primary operator."},
            "operator-name": {"description": "Secondary operator."}}}}},
            [{"id": "shared", "label": "Shared", "operator-name": "Secondary", "operator name": "Primary"}]),
        "b": ({"priority": 90}, [{"id": "shared", "label": "Shared", "Operator Name": "Preferred"}]),
    })
    assert table.to_pylist()[0]["operator_name"] == "Preferred"
    assert table.to_pylist()[0]["operator_name_2"] == "Secondary"
    assert quality["columnMaps"]["T"]["a"] == {"operator name": "operator_name", "operator-name": "operator_name_2"}
    assert quality["columnMaps"]["T"]["b"] == {"Operator Name": "operator_name"}
    props = {prop.name: prop for prop in entity.properties}
    assert props["operator_name"].description == "Primary operator."
    assert props["operator_name_2"].description == "Secondary operator."


@pytest.mark.parametrize("kit_priority", [10, 90])
def test_native_and_derived_units_and_en_dash_ranges_merge_by_dataset_priority(kit_priority):
    table, entity, quality = _prepared_properties({
        "kit": ({"priority": kit_priority, "title": "Curated kit"}, [
            {"id": "a", "label": "A", "Total depth": "3,852 m", "Depth interval": "2,616.6–3,942.6 m", "Area": "130,196 km²"},
            {"id": "b", "label": "B", "Total depth": "1,200 m", "Depth interval": "866 to 4,781 m", "Area": "2 km²"},
        ]),
        "native": ({"priority": 50, "title": "Native archive", "entityTypes": {"T": {"properties": {
            "total_depth_m": {"description": "Total depth in metres from the archive."}}}}}, [
            {"id": "a", "label": "A", "total_depth_m": 4000, "depth_interval_min_m": 2700, "depth_interval_max_m": 4000, "area_km2": 140000},
        ]),
    })
    row = table.to_pylist()[0]
    assert row["total_depth_m"] == (3852.0 if kit_priority > 50 else 4000)
    assert row["depth_interval_min_m"] == (2616.6 if kit_priority > 50 else 2700)
    assert row["depth_interval_max_m"] == (3942.6 if kit_priority > 50 else 4000)
    assert row["area_km2"] == (130196.0 if kit_priority > 50 else 140000)
    assert row["total_depth"] == "3,852 m"
    assert table.to_pylist()[1]["depth_interval_min_m"] == 866.0
    assert table.to_pylist()[1]["depth_interval_max_m"] == 4781.0
    assert not any(name.endswith("_2") for name in table.column_names)
    props = {prop.name: prop for prop in entity.properties}
    for column in ("total_depth_m", "depth_interval_min_m", "depth_interval_max_m", "area_km2"):
        assert table.schema.field(column).type == pa.float64()
        assert props[column].derivedFrom is None
        assert props[column].unit == ("km2" if column == "area_km2" else "m")
        assert quality["conflicts"]["T"][column] == 1
    assert props["total_depth_m"].description == "Total depth in metres from the archive."
    assert props["area_km2"].description == "area_km2, as recorded in Native archive and Curated kit."
    assert {entry["column"] for entry in quality["derivedColumns"]} >= {"total_depth_m", "depth_interval_min_m", "depth_interval_max_m", "area_km2"}


def test_native_values_win_locally_but_nulls_fill_and_only_real_disagreements_count():
    table, entity, quality = _prepared_properties({"d": ({}, [
        {"id": "a", "label": "A", "Depth": "10 m", "depth_m": 7},
        {"id": "b", "label": "B", "Depth": "20 m", "depth_m": None},
        {"id": "c", "label": "C", "Depth": "0 m", "depth_m": 0},
        {"id": "d", "label": "D", "Depth": "30 m", "depth_m": "30"},
    ])})
    assert table["depth_m"].to_pylist() == [7.0, 20.0, 0.0, 30.0]
    assert quality["conflicts"]["T"]["depth_m"] == 1
    prop = next(prop for prop in entity.properties if prop.name == "depth_m")
    assert prop.derivedFrom is None and prop.unit == "m"
    assert "parsed from" not in prop.description


def test_mixed_native_and_derived_columns_use_normal_type_inference():
    table, entity, _ = _prepared_properties({
        "native": ({}, [{"id": "a", "label": "A", "depth_m": "unavailable"}]),
        "derived": ({}, [{"id": "b", "label": "B", "Depth": "10 m"}]),
    })
    assert table["depth_m"].to_pylist() == ["unavailable", "10.0"]
    prop = next(prop for prop in entity.properties if prop.name == "depth_m")
    assert prop.dataType == "string" and prop.derivedFrom is None and prop.unit == "m"


@pytest.mark.parametrize("key,value,column,unit,words", [
    ("Total depth", "3,852 m", "total_depth_m", "m", "metres"),
    ("Area", "130,196 km²", "area_km2", "km2", "square kilometres"),
    ("Epoch", "Pliocene (2.6–5.3 Ma)", "epoch_min_ma", "Ma", "millions of years"),
    ("Temperature", "66.7 °C", "temperature_c", "°C", "degrees Celsius"),
    ("Pressure", "25 bar", "pressure_bar", "bar", "bar"),
])
def test_pure_derived_descriptions_use_raw_keys_units_and_first_usable_example(key, value, column, unit, words):
    table, entity, _ = _prepared_properties({"kit": ({}, [
        {"id": "a", "label": "A", key: None, column: None},
        {"id": "b", "label": "B", key: "not recorded", column: None},
        {"id": "c", "label": "C", key: value, column: None},
    ])})
    prop = next(prop for prop in entity.properties if prop.name == column)
    assert prop.derivedFrom is not None and prop.unit == unit
    assert prop.description == f"Numeric value in {words} parsed from {key} (for example {value})."
    assert table[column].to_pylist()[0:2] == [None, None]


def test_fallback_descriptions_use_raw_aliases_and_at_most_three_dataset_titles():
    sources = {}
    for index, name in enumerate("abcde"):
        title = ["Alpha\narchive", "", "Gamma archive", "Fourth archive", "Fifth archive"][index]
        key = "Operator" if index == 0 else "operator"
        sources[name] = ({"title": title}, [{"id": name, "label": name, key: name}])
    _, entity, _ = _prepared_properties(sources)
    prop = next(prop for prop in entity.properties if prop.name == "operator")
    assert prop.description == "Operator, as recorded in Alpha archive, b, Gamma archive and 2 more."


def test_property_descriptions_are_single_line_and_below_the_payload_limit():
    _, entity, _ = _prepared_properties({"d": ({"title": "Archive\t" + "long " * 1000,
        "entityTypes": {"T": {"properties": {"declared": {"description": "Declared\n" + "long " * 1000}}}}},
        [{"id": "a", "label": "A", "Raw\nname": "text", "declared": "text"}])})
    for prop in entity.properties:
        assert len(prop.description) < 4000
        assert "\n" not in prop.description and "\t" not in prop.description


def test_quarantined_pairs_do_not_rename_valid_relationships():
    store = MemoryStorage({"d/entities/T.csv": b"id,label\na,A\nb,B\n", "d/relationships/links.csv":
        b"source_id,source_type,target_id,target_type\na,T,b,T\na,Wrong,b,T\na,T,missing,Other\n"})
    writer = InMemoryWriter()
    summary = run(store, writer, "r")
    plan = OntologyPlan.from_json(store.read_bytes(summary["planPath"]))
    assert [(rel.name, rel.table, rel.edgeCount) for rel in plan.relationships] == [("links", "rel_links", 1)]
    assert summary["quarantinedEdges"] == 2


def test_declared_cast_failure_falls_through_without_a_shadow_quantity_column():
    table, entity, quality = _prepared_properties({
        "high": ({"priority": 90, "entityTypes": {"T": {"properties": {"total_depth_m": {"dataType": "double"}}}}},
                 [{"id": "a", "label": "A", "total_depth_m": "3,852 m"}]),
        "low": ({"priority": 10}, [{"id": "a", "label": "A", "total_depth_m": 4440}]),
    })
    assert table["total_depth_m"].to_pylist() == [4440.0]
    assert "total_depth_m_m" not in table.column_names
    assert quality["castErrors"] == [{"entity": "T", "column": "total_depth_m", "dataType": "double", "count": 1}]
    assert not quality["conflicts"]["T"]


def test_json_placeholders_fall_through_and_raw_values_are_preserved():
    store = MemoryStorage({"high/dataset.json": b'{"priority":90}',
        "high/entities/T.jsonl": b'{"id":"a","label":"unknown","operator":"","properties_json":{"depth":"not recorded","year":" n/a "},"flag":false,"count":0}\n',
        "low/entities/T.csv": b'id,label,operator,depth,year,flag,count\na,Real label,Santos,100 m,1965,true,1\n'})
    writer = InMemoryWriter()
    run(store, writer, "r")
    row = writer.tables["dbo", "t"].to_pylist()[0]
    assert (row["label"], row["operator"], row["depth"], row["year"]) == ("Real label", "Santos", "100 m", 1965)
    assert row["flag"] is False and row["count"] == 0
    raw = writer.tables["raw", "high__e_t"].to_pylist()[0]
    assert raw["label"] == "unknown" and raw["operator"] == ""
    assert json.loads(raw["properties_json"]) == {"depth": "not recorded", "year": " n/a "}


def test_conflicts_compare_canonical_numbers_and_utc_timestamps():
    table, entity, quality = _prepared_properties({
        "high": ({"priority": 90}, [
            {"id": "a", "label": "A", "year": "1965", "depth_m": 4440.0, "at": "2026-01-01T08:00:00+08:00"},
            {"id": "b", "label": "B", "depth_m": 3851.8},
        ]),
        "low": ({"priority": 10}, [
            {"id": "a", "label": "A", "year": 1965, "depth_m": 4440, "at": "2026-01-01T00:00:00Z"},
            {"id": "b", "label": "B", "depth_m": 3852},
        ]),
    })
    assert quality["conflicts"]["T"] == {"depth_m": 1}
    assert table["depth_m"].to_pylist() == [4440.0, 3851.8]


def test_declared_decimal_binds_as_double_without_fixed_scale_loss():
    table, entity, quality = _prepared_properties({"d": ({"entityTypes": {"T": {"properties": {
        "amount": {"dataType": "decimal"}}}}}, [{"id": "a", "label": "A", "amount": "1.23456789"}])})
    prop = next(prop for prop in entity.properties if prop.name == "amount")
    assert prop.dataType == "double" and table.schema.field("amount").type == pa.float64()
    assert table["amount"].to_pylist() == [1.23456789] and not quality["castErrors"]


def test_fallback_description_selects_one_human_readable_key():
    _, entity, _ = _prepared_properties({
        "a": ({"title": "Archive"}, [{"id": "a", "label": "A", "depositional_environment": "Marine"}]),
        "b": ({"title": "Kit"}, [{"id": "b", "label": "B", "Depositional environment": "Marine"}]),
    })
    prop = next(prop for prop in entity.properties if prop.name == "depositional_environment")
    assert prop.description == "Depositional environment, as recorded in Archive and Kit."


def test_relationship_placeholder_identifiers_are_null_but_raw_text_is_retained():
    store = MemoryStorage({"d/entities/T.csv": b"id,label\na,A\n", "d/relationships/links.csv":
        b"source_id,source_type,target_id,target_type\nnone,T,a,T\na,T, N/A ,T\n"})
    writer = InMemoryWriter()
    summary = run(store, writer, "r")
    quality = json.loads(store.read_bytes(summary["qualityPath"]))
    assert quality["quarantinedEdges"]["byReason"] == {"empty_id": 2}
    raw = writer.tables["raw", "d__r_links"].to_pylist()
    assert raw[0]["source_id"] == "none" and raw[1]["target_id"] == " N/A "
