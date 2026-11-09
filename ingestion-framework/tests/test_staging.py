import json
from types import SimpleNamespace

import pyarrow as pa
import pytest

from ontology_ingest.delta import InMemoryWriter, LocalDeltaWriter
from ontology_ingest.plan import OntologyPlan
from ontology_ingest.prepare import run
from ontology_ingest.storage import MemoryStorage
from ontology_ingest.workflow import publish_plan


class TrackedWriter(InMemoryWriter):
    def __init__(self):
        super().__init__()
        self.writes = []
        self.deleted = []
        self.fail_table = None

    def write(self, schema, table, data):
        if table == self.fail_table:
            raise RuntimeError("write failed")
        self.writes.append((schema, table))
        super().write(schema, table, data)

    def delete_schema(self, schema):
        self.deleted.append(schema)
        super().delete_schema(schema)


class Fabric:
    workspace_id = "ws"
    http = SimpleNamespace(base_url="https://fabric.invalid")

    def __init__(self):
        self.parts = None
        self.events = []
        self.fail_publish = False
        self.fail_verify = False

    def get_lakehouse(self, item):
        return {"properties": {"sqlEndpointProperties": {"connectionString": "host", "id": "sql"}}}

    def refresh_sql_endpoint_metadata(self, endpoint, required_tables=None):
        self.events.append(("refresh", required_tables))

    def upsert_ontology(self, name, parts, description):
        self.events.append(("publish", name))
        if self.fail_publish:
            raise RuntimeError("publish failed")
        self.parts = dict(parts)
        return {"id": name}

    def get_ontology_definition(self, item):
        self.events.append(("verify", item))
        if self.fail_verify:
            return {}
        return self.parts


def stage(writer, files, run_id, value=1):
    landing = MemoryStorage({"d/entities/T.csv": f"id,label,value\na,A,{value}\n".encode()})
    summary = run(landing, writer, run_id, output=files, output_dir=f"_ontology_ingest/{run_id}")
    return summary, OntologyPlan.from_json(files.read_bytes(summary["planPath"]))


def stage_copied(writer, files, run_id, value=1):
    """A run whose ingest pipeline has already copied the entity file into raw_<run id>; the relationship file was not copied."""
    landing = MemoryStorage({"d-1/entities/T.csv": f"id,label,properties_json\na,From file,{{}}\n".encode(),
                             "d-1/relationships/links.csv": b"source_id,source_type,target_id,target_type\na,T,a,T\n"})
    writer.write(f"raw_{run_id}", "d_1__e_t", pa.table({"id": ["a"], "label": ["From table"],
                                                        "properties_json": [json.dumps({"basin": "Galilee", "value": value})]}))
    summary = run(landing, writer, run_id, output=files, output_dir=f"_ontology_ingest/{run_id}", copied_raw=(writer, f"raw_{run_id}"))
    return summary, OntologyPlan.from_json(files.read_bytes(summary["planPath"]))


def test_staged_is_default_and_failed_next_run_cannot_mutate_previous_tables():
    files, writer = MemoryStorage(), TrackedWriter()
    summary, previous = stage(writer, files, "r1")
    assert previous.bindingSchema != "dbo" and previous.rawSchema != "raw"
    before = dict(writer.tables)
    writer.fail_table = "t"
    with pytest.raises(RuntimeError, match="write failed"):
        stage(writer, files, "r2", 2)
    assert all(writer.tables[key].equals(value) for key, value in before.items())
    assert json.loads(files.read_bytes("_ontology_ingest/r2/prepare-status.json"))["state"] == "failed"
    with pytest.raises(ValueError, match="not complete"):
        publish_plan(Fabric(), files, "lh", "_ontology_ingest/r2/ontology-plan.json", "Ontology", tables=writer)


def test_completed_staged_snapshot_is_immutable_and_idempotent():
    files, writer = MemoryStorage(), TrackedWriter()
    summary, original = stage(writer, files, "Run-1")
    writes = len(writer.writes)
    again, restored = stage(writer, files, "Run-1")
    assert again == summary and restored == original and len(writer.writes) == writes
    with pytest.raises(ValueError, match="immutable|snapshot|run_id"):
        stage(writer, files, "Run-1", 2)
    assert len(writer.writes) == writes
    _, alternate = stage(writer, files, "Run_1", 2)
    assert alternate.bindingSchema != original.bindingSchema


def test_staged_prepare_refuses_an_existing_unowned_schema():
    files, writer = MemoryStorage(), TrackedWriter()
    _, plan = stage(writer, files, "r")
    before = len(writer.writes)
    with pytest.raises(ValueError, match="ownership|existing|snapshot"):
        stage(writer, MemoryStorage(), "r", 2)
    assert len(writer.writes) == before


def test_in_place_is_explicit_and_preserves_its_old_schema_names():
    writer = InMemoryWriter()
    landing = MemoryStorage({"d/entities/T.csv": b"id,label\na,A\n"})
    summary = run(landing, writer, "r", publish_mode="in_place")
    plan = OntologyPlan.from_json(landing.read_bytes(summary["planPath"]))
    assert plan.bindingSchema == "dbo" and plan.rawSchema == "raw"
    assert writer.count_rows("dbo", "t") == 1


def test_retention_runs_only_after_successful_publish_and_verification():
    files, writer, fabric = MemoryStorage(), TrackedWriter(), Fabric()
    plans = []
    for number in range(1, 4):
        summary, plan = stage(writer, files, f"r{number}", number)
        publish_plan(fabric, files, "lh", summary["planPath"], "Ontology", tables=writer)
        plans.append(plan)
    assert set(writer.deleted) == {plans[0].bindingSchema, plans[0].rawSchema}
    assert writer.schema_exists(plans[1].bindingSchema) and writer.schema_exists(plans[2].bindingSchema)
    assert fabric.events[-3][0] == "refresh" and all(name.startswith(plans[2].bindingSchema + ".") for name in fabric.events[-3][1])
    before = list(writer.deleted)
    summary, fourth = stage(writer, files, "r4", 4)
    fabric.fail_publish = True
    with pytest.raises(RuntimeError, match="publish failed"):
        publish_plan(fabric, files, "lh", summary["planPath"], "Ontology", tables=writer)
    assert writer.deleted == before
    fabric.fail_publish, fabric.fail_verify = False, True
    with pytest.raises(ValueError):
        publish_plan(fabric, files, "lh", summary["planPath"], "Ontology", tables=writer)
    assert writer.deleted == before and writer.schema_exists(plans[1].bindingSchema)


def test_pipeline_copied_runs_read_their_raw_tables_and_retention_owns_the_unhashed_schema():
    files, writer, fabric = MemoryStorage(), TrackedWriter(), Fabric()
    plans = []
    for number in range(1, 4):
        summary, plan = stage_copied(writer, files, f"p{number}", number)
        publish_plan(fabric, files, "lh", summary["planPath"], "Ontology", tables=writer)
        plans.append(plan)
    latest = plans[2]
    assert (latest.rawSchema, latest.publication.rawSchemaNaming) == ("raw_p3", "pipeline")
    assert writer.tables[latest.bindingSchema, "t"].to_pylist() == [
        {"id": "a", "label": "From table", "basin": "Galilee", "value": 3, "source_datasets": "d-1"}]
    assert writer.writes.count(("raw_p3", "d_1__e_t")) == 1  # only the pipeline's copy; prepare never rewrote it
    assert ("raw_p3", "d_1__r_links") in writer.writes  # a file the pipeline did not copy is still loaded
    report = json.loads(files.read_bytes(summary["qualityPath"]))
    assert {path: entry["rawSource"] for path, entry in report["datasets"]["d-1"]["files"].items()} == {
        "d-1/entities/T.csv": "pipeline copy", "d-1/relationships/links.csv": "file"}
    assert set(writer.deleted) == {plans[0].bindingSchema, "raw_p1"}
    with pytest.raises(ValueError, match="raw schema is 'raw_p4'"):
        run(MemoryStorage({"d/entities/T.csv": b"id,label\na,A\n"}), writer, "p4", output=files, copied_raw=(writer, "raw_other"))


def test_framework_runs_keep_their_publication_record_shape():
    summary, plan = stage(InMemoryWriter(), MemoryStorage(), "r1")
    assert plan.publication.to_dict() == {"mode": "staged", "rawSchemaBase": "raw", "bindingSchemaBase": "dbo"}


def test_row_counts_are_verified_before_switching_a_staged_ontology():
    files, writer, fabric = MemoryStorage(), TrackedWriter(), Fabric()
    summary, plan = stage(writer, files, "r")
    writer.tables[plan.bindingSchema, "t"] = writer.tables[plan.bindingSchema, "t"].slice(0, 0)
    with pytest.raises(ValueError, match="row-count"):
        publish_plan(fabric, files, "lh", summary["planPath"], "Ontology", tables=writer)
    assert not any(event[0] == "publish" for event in fabric.events) and not writer.deleted


def test_retention_protects_a_snapshot_referenced_by_another_ontology():
    files, writer, fabric = MemoryStorage(), TrackedWriter(), Fabric()
    summary, shared = stage(writer, files, "r1")
    publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    publish_plan(fabric, files, "lh", summary["planPath"], "B", tables=writer)
    for number in (2, 3):
        summary, _ = stage(writer, files, f"r{number}", number)
        publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    assert writer.schema_exists(shared.bindingSchema) and shared.bindingSchema not in writer.deleted


def test_local_staged_schema_cleanup_never_removes_the_tables_root(tmp_path):
    writer, files = LocalDeltaWriter(tmp_path, use_delta=False), MemoryStorage()
    _, plan = stage(writer, files, "r")
    writer.delete_schema(plan.bindingSchema)
    assert not writer.schema_exists(plan.bindingSchema)
    assert writer.schema_exists(plan.rawSchema)
    with pytest.raises(ValueError):
        writer.delete_schema("../")


def test_retention_failures_remain_pending_and_are_retried_without_touching_retained_runs():
    files, writer, fabric = MemoryStorage(), TrackedWriter(), Fabric()
    summary, old = stage(writer, files, "r1")
    publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    summary, second = stage(writer, files, "r2")
    publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    original_delete = writer.delete_schema
    def fail_raw(schema):
        if schema == old.rawSchema:
            raise RuntimeError("cleanup unavailable")
        original_delete(schema)
    writer.delete_schema = fail_raw
    summary, current = stage(writer, files, "r3")
    result = publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    assert result["cleanup"]["pendingRuns"] == ["r1"] and result["cleanup"]["errors"]
    assert writer.schema_exists(second.bindingSchema) and writer.schema_exists(current.bindingSchema)
    writer.delete_schema = original_delete
    result = publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    assert not result["cleanup"]["pendingRuns"] and not result["cleanup"]["errors"]
    with pytest.raises(ValueError, match="no longer available"):
        stage(writer, files, "r1")


def test_retention_rejects_unowned_schema_names_in_a_catalog():
    files, writer, fabric = MemoryStorage(), TrackedWriter(), Fabric()
    for number in (1, 2):
        summary, _ = stage(writer, files, f"r{number}", number)
        publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    catalog_path = next(path for path in files.files if path.startswith("_ontology_ingest/_publications/"))
    catalog = json.loads(files.read_bytes(catalog_path))
    catalog["runs"][-1]["bindingSchema"] = "dbo"
    files.write_bytes(catalog_path, json.dumps(catalog).encode())
    summary, _ = stage(writer, files, "r3", 3)
    result = publish_plan(fabric, files, "lh", summary["planPath"], "A", tables=writer)
    assert result["cleanup"]["errors"] and "dbo" not in writer.deleted


def test_failed_staged_write_can_resume_only_with_the_same_inputs():
    files, writer = MemoryStorage(), TrackedWriter()
    writer.fail_table = "t"
    with pytest.raises(RuntimeError):
        stage(writer, files, "r")
    with pytest.raises(ValueError, match="immutable snapshot"):
        stage(writer, files, "r", 2)
    writer.fail_table = None
    summary, plan = stage(writer, files, "r")
    assert writer.count_rows(plan.bindingSchema, "t") == 1
    assert json.loads(files.read_bytes(summary["statusPath"]))["state"] == "complete"
