import hashlib
import io
import json
import os
import subprocess
import sys
import types
import zipfile
from pathlib import Path

import pytest

from ontology_ingest import cli
from ontology_ingest.contract import DatasetWriter
from ontology_ingest.delta import InMemoryWriter
from ontology_ingest.notebooks import DEFAULT_KERNEL_METADATA, build_framework_zip, build_notebook, notebook_definition
from ontology_ingest.plan import OntologyPlan
from ontology_ingest.storage import MemoryStorage
from ontology_ingest.tmdl import build_definition
from ontology_ingest.workflow import publish_plan, verify_remote


@pytest.mark.parametrize("step", ["prepare", "generate", "graph"])
def test_notebook_cells_parameters_kernel_and_definition(step, monkeypatch):
    notebook = build_notebook(step, workspace_id="ws", lakehouse_id="lh", lakehouse_name="Lake",
                              parameters={"run_id": "r", "landing_dir": "landing/r", "ontology_name": "Test", "plan_path": "plan.json"})
    assert len(notebook["cells"]) == 4 and notebook["cells"][0]["cell_type"] == "markdown"
    assert notebook["cells"][1]["metadata"]["tags"] == ["parameters"]
    assert notebook["metadata"]["kernel_info"]["jupyter_kernel_name"] == "python3.11"
    assert notebook["metadata"]["kernelspec"] == {"name": "jupyter", "display_name": "Jupyter"}
    assert notebook["metadata"]["dependencies"]["lakehouse"]["default_lakehouse"] == "lh"
    for index, cell in enumerate(notebook["cells"][1:]):
        compile("".join(cell["source"]), f"cell_{index}", "exec")
        assert cell["metadata"]["microsoft"]["language_group"] == "jupyter_python"
    loader = "".join(notebook["cells"][2]["source"])
    assert "from ontology_ingest" not in loader and 'Path(".ontology_ingest")' in loader
    assert "/tmp" not in loader
    assert "sha256" in loader and "sys.path.insert" in loader
    events = []
    fake = types.ModuleType("ontology_ingest.workflow")
    fake.prepare_remote = lambda *a, **k: (events.append((a, k)) or {"runId": "r"})
    fake.generate_remote = lambda *a, **k: (events.append((a, k)) or {"runId": "r"})
    fake.graph_remote = lambda *a, **k: (events.append((a, k)) or {"runId": "r"})
    monkeypatch.setitem(sys.modules, "ontology_ingest.workflow", fake)
    namespace = {"notebookutils": types.SimpleNamespace(notebook=types.SimpleNamespace(exit=lambda text: events.append(json.loads(text))))}
    exec("".join(notebook["cells"][1]["source"]), namespace)
    exec("".join(notebook["cells"][3]["source"]), namespace)
    assert events[0][0][:2] == ("ws", "lh") and events[1] == {"runId": "r"}
    definition = notebook_definition(notebook, "Test")
    assert definition["format"] == "ipynb"
    assert {part["path"] for part in definition["parts"]} == {".platform", "artifact.content.ipynb"}


@pytest.mark.parametrize("step", ["prepare", "generate"])
def test_notebook_failure_exits_with_a_structured_error(step, monkeypatch):
    notebook = build_notebook(step, workspace_id="ws", lakehouse_id="lh", lakehouse_name="Lake", parameters={"run_id": "r"})

    def boom(*args, **kwargs):
        raise ValueError("The field Description must be a string with a maximum length of '256'.")
    fake = types.ModuleType("ontology_ingest.workflow")
    fake.prepare_remote = fake.generate_remote = boom
    monkeypatch.setitem(sys.modules, "ontology_ingest.workflow", fake)
    exits = []
    namespace = {"notebookutils": types.SimpleNamespace(notebook=types.SimpleNamespace(exit=lambda text: exits.append(json.loads(text))))}
    exec("".join(notebook["cells"][1]["source"]), namespace)
    exec("".join(notebook["cells"][3]["source"]), namespace)
    assert len(exits) == 1 and exits[0]["runId"] == "r"
    assert exits[0]["error"]["type"] == "ValueError" and "256" in exits[0]["error"]["message"]
    assert "Traceback" in exits[0]["error"]["traceback"]


def test_a_pipeline_notebook_raises_so_its_activity_fails(monkeypatch):
    notebook = build_notebook("graph", workspace_id="ws", lakehouse_id="lh", lakehouse_name="Lake",
                              parameters={"run_id": "r", "raise_errors": "true"})

    def boom(*args, **kwargs):
        raise RuntimeError("graph refresh failed")
    fake = types.ModuleType("ontology_ingest.workflow")
    fake.graph_remote = boom
    monkeypatch.setitem(sys.modules, "ontology_ingest.workflow", fake)
    exits = []
    namespace = {"notebookutils": types.SimpleNamespace(notebook=types.SimpleNamespace(exit=exits.append))}
    exec("".join(notebook["cells"][1]["source"]), namespace)
    with pytest.raises(RuntimeError, match="graph refresh failed"):
        exec("".join(notebook["cells"][3]["source"]), namespace)
    assert exits == []


def test_kernel_override_does_not_mutate_shared_metadata():
    custom = {"kernel_info": {"name": "custom"}}
    notebook = build_notebook("prepare", workspace_id="w", lakehouse_id="l", lakehouse_name="L", kernel_metadata=custom)
    notebook["metadata"]["kernel_info"]["name"] = "mutated"
    assert custom == {"kernel_info": {"name": "custom"}}
    assert DEFAULT_KERNEL_METADATA["kernel_info"]["name"] == "jupyter"


def test_framework_archive_reproducibility_and_zipimport(tmp_path):
    archive, digest = build_framework_zip()
    second, same_digest = build_framework_zip()
    assert archive == second and digest == same_digest == hashlib.sha256(archive).hexdigest()[:12]
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        names = bundle.namelist()
        assert names == sorted(names) and all(name.startswith("ontology_ingest/") and name.endswith(".py") for name in names)
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in bundle.infolist())
    path = tmp_path / "framework.zip"
    path.write_bytes(archive)
    command = "import ontology_ingest; from ontology_ingest.naming import snake; print(snake('TestCase')); print(ontology_ingest.__file__)"
    result = subprocess.run([sys.executable, "-c", command], cwd=tmp_path, env={**os.environ, "PYTHONPATH": str(path)}, capture_output=True, text=True, check=True)
    assert result.stdout.splitlines()[0] == "test_case"
    assert str(path) in result.stdout.splitlines()[1]


def test_framework_archive_refuses_sync_conflict_copies(tmp_path):
    package = tmp_path / "pkg"
    (package / "sub").mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "sub" / "__init__.py").write_text("")
    (package / "fabric.py").write_text("x = 1\n")
    build_framework_zip(package)
    (package / "fabric 2.py").write_text("x = 2\n")
    with pytest.raises(ValueError, match="fabric 2.py"):
        build_framework_zip(package)


@pytest.fixture
def config_file(tmp_path):
    writer = DatasetWriter(tmp_path / "landing/d", name="d")
    writer.add_entity("Node", id="a", label="Alpha", properties={"height": "1,234 m"})
    writer.add_entity("Node", id="b", label="Beta", properties={"height": "2,345 m"})
    writer.add_relationship("parent", "b", "Node", "a", "Node")
    writer.close()
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"workspace_id": "11111111-1111-1111-1111-111111111111",
        "lakehouse_id": "22222222-2222-2222-2222-222222222222", "ontology_name": "Test",
        "landing_root": "landing", "output_dir": "artifacts", "run_id": "offline"}))
    return path


@pytest.mark.parametrize("placement", ["before", "after"])
def test_cli_dry_run_writes_real_tmdl_without_constructing_clients(config_file, placement, monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        raise AssertionError("A dry run must not construct authenticated clients")
    monkeypatch.setattr(cli, "Runner", forbidden)
    args = ["--config", str(config_file), "run", "--dry-run"] if placement == "before" else ["run", "--config", str(config_file), "--dry-run"]
    assert cli.main(args) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["dryRun"] and result["sqlEndpointIsPlaceholder"]
    root = Path(result["definitionDirectory"])
    assert (root / "entities/Node.tmdl").is_file() and (root / "entityRelationships.tmdl").is_file()
    assert "isActive: false" in (root / "relationships.tmdl").read_text()
    plan = OntologyPlan.from_json((root.parent / "ontology-plan.json").read_bytes())
    assert plan.entities[0].rowCount == 2 and plan.relationships[0].edgeCount == 1
    assert any(prop.name == "height_m" for prop in plan.entities[0].properties)
    assert result["graphModelDefinitionDirectory"] is None


def test_cli_dry_run_writes_the_graph_model_definition_when_named(config_file, capsys):
    config = json.loads(config_file.read_text())
    config["graph_model_name"] = "Test graph"
    config_file.write_text(json.dumps(config))
    assert cli.main(["--config", str(config_file), "--dry-run", "graph-model"]) == 0
    graph_type = json.loads((Path(json.loads(capsys.readouterr().out)["graphModelDefinitionDirectory"]) / "graphType.json").read_text())
    assert [node["labels"] for node in graph_type["nodeTypes"]] == [["Node"]] and len(graph_type["edgeTypes"]) == 1


def test_cli_module_entrypoint_is_offline_and_accepts_explicit_endpoint(config_file):
    config = json.loads(config_file.read_text())
    config["sql_endpoint"] = {"host": "endpoint.invalid", "id": "sql"}
    config_file.write_text(json.dumps(config))
    result = subprocess.run([sys.executable, "-m", "ontology_ingest", "--config", str(config_file), "--dry-run", "generate"], capture_output=True, text=True, check=True)
    summary = json.loads(result.stdout)
    assert not summary["sqlEndpointIsPlaceholder"]
    assert 'Sql.Database("endpoint.invalid", "sql")' in (Path(summary["definitionDirectory"]) / "expressions.tmdl").read_text()


@pytest.mark.parametrize("mutation", [
    {"workspace_id": "not-guid"}, {"workspace_id": 4}, {"password": "never-a-real-secret"},
    {"binding_schema": "bad space"}, {"raw_schema": "dbo"}, {"mcp_smoke": {"arguments": {}}},
    {"notebooks": {"prepare": "Same", "generate": "same"}}, {"sql_endpoint": {"host": "x"}},
    {"output_dir": "landing/output"}, {"graph_model_name": "test"},
    {"pipelines": {"ingest": "Ingest"}}, {"notebooks": {"prepare": "P", "generate": "G", "publish": "X"}},
])
def test_cli_configuration_errors_are_friendly(config_file, mutation, capsys):
    data = json.loads(config_file.read_text())
    data.update(mutation)
    config_file.write_text(json.dumps(data))
    assert cli.main(["--config", str(config_file), "run", "--dry-run"]) == 2
    captured = capsys.readouterr()
    assert "ontology-ingest:" in captured.err and not captured.out
    assert "never-a-real-secret" not in captured.err


def test_cli_run_executes_all_stages_in_order(config_file, monkeypatch, capsys):
    events = []

    class FakeRunner:
        def __init__(self, config, run_id):
            assert run_id == "offline"
        def land(self):
            events.append("land")
        def deploy_notebooks(self):
            events.append("deploy")
        def prepare(self, engine):
            events.append("prepare:" + engine)
        def generate(self, engine):
            events.append("generate:" + engine)
        def verify(self, smoke):
            events.append("verify:" + str(smoke))
    monkeypatch.setattr(cli, "Runner", FakeRunner)
    assert cli.main(["--config", str(config_file), "run", "--engine", "local"]) == 0
    assert events == ["land", "deploy", "prepare:local", "generate:local", "verify:False"]
    json.loads(capsys.readouterr().out)


def test_cli_pipeline_engine_lands_deploys_runs_and_verifies(config_file, monkeypatch, capsys):
    events = []

    class FakeRunner:
        def __init__(self, config, run_id):
            events.append(run_id)
        def land(self):
            events.append("land")
        def deploy_pipeline(self):
            events.append("deploy-pipeline")
        def run_pipeline(self):
            events.append("run-pipeline")
        def verify(self, smoke):
            events.append("verify:" + str(smoke))
    monkeypatch.setattr(cli, "Runner", FakeRunner)
    assert cli.main(["--config", str(config_file), "run", "--engine", "pipeline", "--mcp-smoke"]) == 0
    assert events == ["offline", "land", "deploy-pipeline", "run-pipeline", "verify:True"]
    capsys.readouterr()
    assert cli.main(["--config", str(config_file), "--run-id", "Live-6", "run-pipeline"]) == 2
    assert "lowercase" in capsys.readouterr().err and len(events) == 5


def test_cli_dry_run_writes_both_pipeline_definitions(config_file, capsys):
    assert cli.main(["--config", str(config_file), "--dry-run", "run", "--engine", "pipeline"]) == 0
    directory = Path(json.loads(capsys.readouterr().out)["pipelineDefinitionDirectory"])
    copy = json.loads((directory / "copy.json").read_text())
    ingest = json.loads((directory / "ingest.json").read_text())
    assert sorted(copy["properties"]["parameters"]) == ["dataset", "landing_dir", "raw_schema"]
    assert [activity["name"] for activity in ingest["properties"]["activities"] if activity["type"] == "TridentNotebook"] == [
        "Expand JSON and build tables", "Create ontology and bindings"]


def test_publish_workflow_refreshes_before_binding_and_round_trips(small_plan):
    calls = []
    files = MemoryStorage({"plan.json": small_plan.to_json().encode()})

    class Fabric:
        workspace_id = "ws"
        http = types.SimpleNamespace(base_url="https://fabric.invalid")
        def get_lakehouse(self, item):
            return {"properties": {"sqlEndpointProperties": {"connectionString": "host", "id": "sql"}}}
        def refresh_sql_endpoint_metadata(self, endpoint, required_tables=None):
            calls.append("refresh")
            self.required = required_tables
        def upsert_ontology(self, name, parts, description):
            calls.append("publish")
            self.parts = parts
            return {"id": "ont"}
        def get_ontology_definition(self, item):
            calls.append("read-back")
            return self.parts
        def find_item(self, name, item_type):
            return {"id": "ont"}
    fabric = Fabric()
    result = publish_plan(fabric, files, "lh", "plan.json", "Test")
    assert calls == ["refresh", "publish", "read-back"]
    assert fabric.required == [f"dbo.{e.table}" for e in small_plan.entities] + [f"dbo.{r.table}" for r in small_plan.relationships]
    assert result["ontologyId"] == "ont" and result["graphMaterialization"] == "manual-portal-step"
    assert OntologyPlan.from_json(files.read_bytes("_ontology_ingest/golden/published-plan.json")).sqlEndpoint == {"host": "host", "id": "sql"}
    assert any(path.endswith("definition/.platform") for path in files.files)

    class Counts:
        def count_rows(self, schema, name):
            return 2 if name == "node" else 1
    verified = verify_remote(fabric, files, Counts(), "plan.json", "Test")
    assert verified["rowCounts"] == {"node": 2, "rel_part_of": 1}

    class WrongCounts:
        def count_rows(self, schema, name):
            return 999
    with pytest.raises(ValueError, match="expected 2, found 999"):
        verify_remote(fabric, files, WrongCounts(), "plan.json", "Test")


def test_land_persists_content_versioned_snapshot_and_refuses_changed_run(config_file, monkeypatch):
    from ontology_ingest.http import ApiError
    from ontology_ingest.storage import Entry
    config = cli.load_config(config_file)
    runner = cli.Runner(config, "offline")
    remote = {}
    writes = []

    class Files:
        def read_bytes(self, path):
            if path not in remote:
                raise ApiError(404, "fake", "Not found")
            return remote[path]
        def list(self, root):
            return [Entry(path) for path in remote if path.startswith(root + "/")]
        def write_bytes(self, path, data):
            writes.append(path)
            remote[path] = data
    client = Files()
    monkeypatch.setattr(runner, "_files", lambda: (config.lakehouse_id, client, None))
    result = runner.land()
    assert result["files"] == 3
    assert result["frameworkZip"].startswith("_framework/" + result["frameworkHash"])
    manifest = json.loads(remote["landing/offline/_landing-manifest.json"])
    assert all(hashlib.sha256(remote["landing/offline/" + name]).hexdigest() == digest for name, digest in manifest.items())
    assert json.loads(runner.local.read_bytes("state.json"))["frameworkHash"] == result["frameworkHash"]
    assert result["uploaded"] == 3
    before = len(writes)
    again = runner.land()
    assert again == {**result, "uploaded": 0}
    assert writes[before:] == [result["frameworkZip"]]
    changed = config.landing_root / "d/entities/Node.csv"
    changed.write_bytes(changed.read_bytes() + b"c,Gamma,{}\n")
    before = len(writes)
    with pytest.raises(ValueError, match="different landed snapshot"):
        runner.land()
    assert len(writes) == before


def test_notebook_exit_summary_must_match_requested_run(config_file, monkeypatch):
    runner = cli.Runner(cli.load_config(config_file), "offline")
    runner.state["notebookIds"] = {"prepare": "nb"}
    monkeypatch.setattr(runner, "_parameters", lambda: {})
    monkeypatch.setattr(runner.fabric, "run_notebook_job", lambda *a: {"exitValue": '{"runId":"another"}'})
    with pytest.raises(ValueError, match="identify this run"):
        runner.prepare("fabric")
    monkeypatch.setattr(runner.fabric, "run_notebook_job", lambda *a: {"exitValue": None})
    with pytest.raises(ValueError, match="JSON exitValue"):
        runner.prepare("fabric")
    failed = {"runId": "offline", "error": {"type": "ApiError", "message": "HTTP 400 InvalidInput", "traceback": "Traceback ..."}}
    monkeypatch.setattr(runner.fabric, "run_notebook_job", lambda *a: {"exitValue": json.dumps(failed)})
    with pytest.raises(RuntimeError, match="prepare notebook failed with ApiError: HTTP 400 InvalidInput"):
        runner.prepare("fabric")


def test_item_descriptions_are_limited_to_256_characters(config_file):
    from ontology_ingest.tmdl import platform_metadata
    data = json.loads(config_file.read_text())
    data["ontology_description"] = "x" * 257
    config_file.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="limited to 256"):
        cli.load_config(config_file)
    assert json.loads(platform_metadata("Test", "y" * 256))["metadata"]["description"] == "y" * 256
    with pytest.raises(ValueError, match="limited to 256"):
        platform_metadata("Test", "y" * 257)


def test_land_uploads_snapshot_concurrently_and_publishes_manifest_last(config_file, monkeypatch):
    import threading
    from ontology_ingest.http import ApiError
    runner = cli.Runner(cli.load_config(config_file), "offline")
    barrier = threading.Barrier(3)
    lock = threading.Lock()
    written = []
    workers = set()

    class Files:
        def read_bytes(self, path):
            raise ApiError(404, "fake", "not found")
        def list(self, path):
            return []
        def write_bytes(self, path, data):
            if path.startswith("landing/") and not path.endswith("_landing-manifest.json"):
                with lock:
                    workers.add(threading.get_ident())
                barrier.wait(timeout=2)
            with lock:
                written.append(path)
    monkeypatch.setattr(runner, "_files", lambda: (runner.config.lakehouse_id, Files(), None))
    assert runner.land()["uploaded"] == 3
    assert len(workers) == 3 and written[-1] == "landing/offline/_landing-manifest.json"


def test_land_does_not_publish_a_manifest_when_any_worker_fails(config_file, monkeypatch):
    from ontology_ingest.http import ApiError
    runner = cli.Runner(cli.load_config(config_file), "offline")
    writes = []

    class Files:
        def read_bytes(self, path):
            raise ApiError(404, "fake", "not found")
        def list(self, path):
            return []
        def write_bytes(self, path, data):
            if path.endswith("Node.csv"):
                raise RuntimeError("upload failed")
            writes.append(path)
    monkeypatch.setattr(runner, "_files", lambda: (runner.config.lakehouse_id, Files(), None))
    with pytest.raises(RuntimeError, match="upload failed"):
        runner.land()
    assert not any(path.endswith("_landing-manifest.json") for path in writes)


def test_repeated_dry_runs_are_ephemeral_and_default_to_staged(config_file, capsys):
    args = ["--config", str(config_file), "run", "--dry-run"]
    assert cli.main(args) == 0
    first = json.loads(capsys.readouterr().out)
    assert first["summary"]["bindingSchema"] != "dbo" and first["summary"]["rawSchema"] != "raw"
    assert cli.main(args) == 0
    second = json.loads(capsys.readouterr().out)
    assert first["summary"]["bindingSchema"] == second["summary"]["bindingSchema"]


@pytest.mark.parametrize("values", [{"publish_mode": "bad"}, {"publish_mode": []}, {"retain_runs": 0}, {"retain_runs": True}, {"retain_runs": "2"}])
def test_publish_mode_and_retention_are_validated(config_file, values):
    config = json.loads(config_file.read_text())
    config.update(values)
    config_file.write_text(json.dumps(config))
    with pytest.raises(ValueError, match="publish_mode|retain_runs"):
        cli.load_config(config_file)
