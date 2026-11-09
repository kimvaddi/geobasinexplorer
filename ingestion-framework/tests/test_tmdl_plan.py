import base64
import copy
import json
from pathlib import Path

import pytest

from ontology_ingest.plan import EntityPlan, OntologyPlan, PropertyPlan, validate_plan
from ontology_ingest.tmdl import build_definition, to_api_definition, verify_definition


def test_plan_and_each_record_round_trip(small_plan):
    assert OntologyPlan.from_json(small_plan.to_json()) == small_plan
    for record in [small_plan.entities[0], small_plan.entities[0].properties[0], small_plan.relationships[0]]:
        assert type(record).from_json(record.to_json()) == record
    bad = small_plan.to_dict()
    bad["contractVersion"] = "99"
    with pytest.raises(ValueError, match="contractVersion"):
        OntologyPlan.from_dict(bad)


def test_tmdl_exact_golden_parts(small_plan):
    parts = build_definition(small_plan, "Example ontology", "Offline golden example.", "endpoint.invalid", "sql-id")
    root = Path(__file__).parent / "golden" / "small"
    expected = {path.relative_to(root).as_posix(): path.read_text(encoding="utf-8") for path in root.rglob("*") if path.is_file()}
    assert parts == expected
    assert verify_definition(small_plan, parts) == {"entities": 1, "relationships": 1, "tables": 2}
    definition = to_api_definition(parts)
    assert {part["path"]: base64.b64decode(part["payload"]).decode() for part in definition["parts"]} == parts


def test_tmdl_descriptions_cannot_inject_keywords_and_m_literals_escape(small_plan):
    plan = copy.deepcopy(small_plan)
    plan.entities[0].description = "first\r\nentity Malicious\n" + "x" * 5000
    parts = build_definition(plan, "Safe", "x" * 256, 'host"#(cr)', 'id"')
    entity = parts["entities/O'Brien Node.tmdl"]
    assert "\n/// entity Malicious\n" in entity and "\nentity Malicious\n" not in entity
    comments = [line[4:] for line in entity.splitlines() if line.startswith("/// ")]
    assert sum(map(len, comments)) <= 4000
    # The live Create Item API rejects item descriptions above 256 characters (InvalidParameter).
    assert len(json.loads(parts[".platform"])["metadata"]["description"]) == 256
    with pytest.raises(ValueError, match="limited to 256"):
        build_definition(plan, "Safe", "x" * 257, "host", "id")
    assert 'Sql.Database("host""#(#)(cr)", "id""")' in parts["expressions.tmdl"]


def test_round_trip_accepts_reordered_parts_and_default_namespace(small_plan):
    parts = build_definition(small_plan, "X", "", "host", "id")
    parts["entities/O'Brien Node.tmdl"] = parts.pop("entities/O'Brien Node.tmdl").replace("entity 'O''Brien Node'", "entity 'default#O''Brien Node'")
    parts["entityRelationships.tmdl"] = parts["entityRelationships.tmdl"].replace("entityRelationship 'part of'", "entityRelationship 'default#part of'")
    parts = dict(reversed(list(parts.items())))
    assert verify_definition(small_plan, parts)["entities"] == 1
    parts["tables/node.tmdl"] = parts["tables/node.tmdl"].replace("sourceColumn: count", "sourceColumn: wrong")
    with pytest.raises(ValueError, match="sourceColumn"):
        verify_definition(small_plan, parts)


@pytest.mark.parametrize("change,match", [
    (lambda p: p.entities.append(copy.deepcopy(p.entities[0])), "Duplicate entity"),
    (lambda p: setattr(p.relationships[0], "toEntity", "Missing"), "unknown entity"),
    (lambda p: setattr(p.relationships[0], "table", "node"), "junction"),
    (lambda p: setattr(p.entities[0].properties[0], "dataType", "double"), "key property"),
    (lambda p: setattr(p.entities[0], "synonyms", ["x" * 101]), "synonym"),
    (lambda p: setattr(p.entities[0], "synonyms", ["x"] * 101), "100 synonyms"),
    (lambda p: setattr(p.entities[0], "name", "../escape"), "separator"),
    (lambda p: setattr(p.entities[0], "name", "x" * 513), "512"),
    (lambda p: setattr(p.entities[0].properties[-1], "derivedFrom", "absent"), "missing property"),
])
def test_validator_rejects_bad_references_types_and_names(small_plan, change, match):
    change(small_plan)
    with pytest.raises(ValueError, match=match):
        build_definition(small_plan, "X", "", "host", "id")


def test_property_and_model_budgets_are_validated(small_plan):
    props = [PropertyPlan("id", "id", "string")] + [PropertyPlan(f"c{i}", f"c{i}", "int64") for i in range(999)]
    small_plan.entities[0].properties = props + [PropertyPlan("last", "last", "string")]
    with pytest.raises(ValueError, match="1000 properties"):
        validate_plan(small_plan)
    plan = OntologyPlan(entities=[EntityPlan(f"Entity{i}", f"table{i}", properties=copy.deepcopy(props)) for i in range(16)])
    with pytest.raises(ValueError, match="16000"):
        validate_plan(plan)


def test_round_trip_detects_missing_bindings_and_inactive_self_relationship(small_plan):
    parts = build_definition(small_plan, "X", "", "host", "id")
    parts["relationships.tmdl"] = parts["relationships.tmdl"].replace("\tisActive: false\n", "")
    with pytest.raises(ValueError, match="inactive"):
        verify_definition(small_plan, parts)


def test_tom_relationships_omit_lineage_while_ontology_objects_keep_it(small_plan):
    parts = build_definition(small_plan, "Example", "", "host", "sql")
    assert "lineageTag:" not in parts["relationships.tmdl"]
    assert "lineageTag:" in parts["entityRelationships.tmdl"]
    assert "lineageTag:" in parts["expressions.tmdl"]
    assert "lineageTag:" in parts["entities/O'Brien Node.tmdl"]
    assert "lineageTag:" in parts["tables/rel_part_of.tmdl"]


def test_legacy_decimal_annotations_are_emitted_as_double(small_plan):
    small_plan.entities[0].properties[-1].dataType = "decimal"
    parts = build_definition(small_plan, "Example", "", "host", "sql")
    assert "dataType: decimal" not in "".join(parts.values())
    assert "column count\n\t\tdataType: double" in parts["tables/node.tmdl"]
    assert "property count\n\t\tdataType: double" in parts["entities/O'Brien Node.tmdl"]


def test_staged_snapshots_keep_table_identity_and_move_only_the_partition_schema(small_plan):
    """Live service rule: an update that keeps a table's name but changes its lineage tag is rejected
    ("No element with lineage tag ... in DataSources"), so a staged run must only move the partition."""
    import re
    from ontology_ingest.plan import PublicationPlan

    def staged(run_id):
        plan = copy.deepcopy(small_plan)
        plan.runId = run_id
        plan.publication = PublicationPlan("staged", "raw", "dbo")
        plan.rawSchema, plan.bindingSchema = plan.publication.schemas(run_id)
        return plan
    in_place = copy.deepcopy(small_plan)
    in_place.bindingSchema = "dbo"
    parts = {name: build_definition(plan, "X", "", "host", "id") for name, plan in
             (("in_place", in_place), ("run_a", staged("run-a")), ("run_b", staged("run-b")))}
    tags = lambda text: re.findall(r"lineageTag: (\S+)", text)
    schema = lambda text: re.search(r"schemaName: (\S+)", text).group(1)
    for table in [name for name in parts["run_a"] if name.startswith("tables/")]:
        assert tags(parts["run_a"][table]) == tags(parts["run_b"][table]) == tags(parts["in_place"][table])
        assert schema(parts["in_place"][table]) == "dbo"
        assert schema(parts["run_a"][table]) != schema(parts["run_b"][table])
        assert schema(parts["run_a"][table]).startswith("dbo_run_a_")
