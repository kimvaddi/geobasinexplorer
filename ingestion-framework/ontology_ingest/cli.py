"""Command-line orchestration. Dry runs never construct an authenticated client."""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .auth import AzureCliTokenProvider, FABRIC_RESOURCE, POWER_BI_RESOURCE, STORAGE_RESOURCE
from .delta import InMemoryWriter, OneLakeDeltaWriter
from .fabric import FabricClient, OntologyMCPClient
from .graph import GraphNotQueryable, query as graph_query, status as graph_status
from .graphmodel import build_graph_model_definition
from .http import ApiError
from .lifecycle import validate_retention
from .naming import validate_table_name
from .notebooks import build_framework_zip, build_notebook
from .onelake import OneLakeClient, OneLakeFiles
from .pipeline import build_copy_pipeline, build_ingest_pipeline, validate_pipeline_run_id
from .plan import OntologyPlan, _name
from .prepare import run as prepare_run, validate_run_id
from .storage import LocalFolder, MemoryStorage
from .tmdl import ITEM_DESCRIPTION_LIMIT, build_definition
from .workflow import plan_path, prepare_remote, publish_plan, publish_run_graph, verify_remote


@dataclass
class Config:
    workspace_id: str
    ontology_name: str
    landing_root: Path
    output_dir: Path
    lakehouse_id: str = ""
    lakehouse_name: str = ""
    ontology_description: str = ""
    run_id: str = ""
    raw_schema: str = "raw"
    binding_schema: str = "dbo"
    publish_mode: str = "staged"
    retain_runs: int = 2
    notebooks: dict[str, str] = field(default_factory=dict)
    pipelines: dict[str, str] = field(default_factory=dict)
    sql_endpoint: dict[str, str] | None = None
    notebook_kernel_metadata: dict[str, Any] | None = None
    mcp_smoke: bool | dict[str, Any] = False
    graph_model_name: str = ""

    def graph_model_description(self) -> str:
        return f"Graph of the {self.ontology_name} ontology tables, published by the ontology ingestion framework."[:ITEM_DESCRIPTION_LIMIT]


def load_config(path: str | Path) -> Config:
    path = Path(path).resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read configuration {path}: {error}") from error
    if not isinstance(data, dict):
        raise ValueError("Configuration must be a JSON object")
    unknown = set(data) - set(Config.__dataclass_fields__)
    if unknown:
        raise ValueError(f"Unknown configuration keys (secrets are not supported): {', '.join(sorted(unknown))}")
    for key in ("workspace_id", "ontology_name", "landing_root"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ValueError(f"Configuration requires a nonempty {key}")
    for key in ("workspace_id", "lakehouse_id"):
        value = data.get(key, "")
        if value:
            try:
                data[key] = str(uuid.UUID(value))
            except (ValueError, TypeError, AttributeError) as error:
                raise ValueError(f"{key} must be a GUID") from error
        elif key in data and not isinstance(value, str):
            raise ValueError(f"{key} must be a GUID string")
    if not data.get("lakehouse_id") and not data.get("lakehouse_name"):
        raise ValueError("Configuration requires lakehouse_id or lakehouse_name")
    for key in ("ontology_description", "lakehouse_name", "run_id", "graph_model_name"):
        if key in data and not isinstance(data[key], str):
            raise ValueError(f"{key} must be a string")
    if len(data.get("ontology_description", "")) > ITEM_DESCRIPTION_LIMIT:
        raise ValueError(f"ontology_description has {len(data['ontology_description'])} characters; Fabric item descriptions "
                         f"are limited to {ITEM_DESCRIPTION_LIMIT}")
    _name(data["ontology_name"], "ontology")
    if data.get("lakehouse_name"):
        _name(data["lakehouse_name"], "lakehouse")
    if data.get("graph_model_name"):
        _name(data["graph_model_name"], "graph model")
        if data["graph_model_name"].casefold() == data["ontology_name"].casefold():
            raise ValueError("graph_model_name must differ from ontology_name")
    for key, default in (("raw_schema", "raw"), ("binding_schema", "dbo")):
        validate_table_name(data.get(key, default))
    if data.get("raw_schema", "raw") == data.get("binding_schema", "dbo"):
        raise ValueError("raw_schema and binding_schema must differ")
    if not isinstance(data.get("publish_mode", "staged"), str) or data.get("publish_mode", "staged") not in {"staged", "in_place"}:
        raise ValueError("publish_mode must be staged or in_place")
    validate_retention(data.get("retain_runs", 2))
    if data.get("run_id"):
        validate_run_id(data["run_id"])
    for key, default in (("landing_root", None), ("output_dir", "output")):
        value = data.get(key, default)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{key} must be a nonempty filesystem path")
        data[key] = (path.parent / value).resolve()
    if data["output_dir"].is_relative_to(data["landing_root"]):
        raise ValueError("output_dir must not be inside landing_root")
    notebooks = data.get("notebooks")
    if notebooks is None:
        notebooks = {"prepare": data["ontology_name"] + " prepare", "generate": data["ontology_name"] + " generate"}
    if not isinstance(notebooks, dict) or set(notebooks) - {"graph"} != {"prepare", "generate"}:
        raise ValueError("notebooks must contain prepare and generate display names, and optionally graph")
    notebooks = {"graph": data["ontology_name"] + " graph", **notebooks}
    pipelines = data.get("pipelines")
    if pipelines is None:
        pipelines = {"ingest": data["ontology_name"] + " ingest", "copy": data["ontology_name"] + " copy dataset"}
    if not isinstance(pipelines, dict) or set(pipelines) != {"ingest", "copy"}:
        raise ValueError("pipelines must contain exactly ingest and copy display names")
    for value in [*notebooks.values(), *pipelines.values()]:
        _name(value, "notebook or pipeline")
    for names, kind in ((notebooks, "notebook"), (pipelines, "pipeline")):
        if len({value.casefold() for value in names.values()}) != len(names):
            raise ValueError(f"The {kind} names must differ from one another")
    data["notebooks"], data["pipelines"] = notebooks, pipelines
    endpoint = data.get("sql_endpoint")
    if endpoint is not None and (not isinstance(endpoint, dict) or set(endpoint) != {"host", "id"}
                                 or not all(isinstance(value, str) and value for value in endpoint.values())):
        raise ValueError("sql_endpoint must contain nonempty host and id strings")
    kernel = data.get("notebook_kernel_metadata")
    if kernel is not None and not isinstance(kernel, dict):
        raise ValueError("notebook_kernel_metadata must be an object")
    smoke = data.get("mcp_smoke", False)
    if not isinstance(smoke, (bool, dict)):
        raise ValueError("mcp_smoke must be a boolean or an object with name and arguments")
    if isinstance(smoke, dict) and (set(smoke) - {"name", "arguments"} or not isinstance(smoke.get("name"), str)
                                   or not smoke.get("name") or not isinstance(smoke.get("arguments", {}), dict)):
        raise ValueError("mcp_smoke requires a tool name and an arguments object")
    return Config(**data)


def pipeline_settings(config: Config, framework_zip: str, framework_hash: str) -> dict[str, str]:
    """The notebooks' fixed parameters as the ingest pipeline passes them; the run's own values are pipeline expressions."""
    settings = {"framework_zip": framework_zip, "framework_hash": framework_hash, "ontology_name": config.ontology_name,
                "ontology_description": config.ontology_description, "raw_schema": config.raw_schema,
                "binding_schema": config.binding_schema, "publish_mode": config.publish_mode, "retain_runs": str(config.retain_runs)}
    if config.graph_model_name:
        settings.update(graph_model_name=config.graph_model_name, graph_model_description=config.graph_model_description())
    return settings


class Runner:
    def __init__(self, config: Config, run_id: str):
        self.config, self.run_id = config, validate_run_id(run_id)
        self.local = LocalFolder(config.output_dir / run_id)
        try:
            self.state = json.loads(self.local.read_bytes("state.json"))
        except FileNotFoundError:
            self.state = {}
        if self.state and (self.state.get("workspaceId") != config.workspace_id or self.state.get("ontologyName") != config.ontology_name):
            raise ValueError("Saved run state belongs to another workspace or ontology; use another run_id")
        if config.lakehouse_id and self.state.get("lakehouseId", config.lakehouse_id) != config.lakehouse_id:
            raise ValueError("Saved run state uses another lakehouse; use another run_id")
        self.fabric_token = AzureCliTokenProvider(FABRIC_RESOURCE)
        self.storage_token = AzureCliTokenProvider(STORAGE_RESOURCE)
        self.fabric = FabricClient(config.workspace_id, self.fabric_token)

    def _save(self) -> None:
        self.state.update(workspaceId=self.config.workspace_id, ontologyName=self.config.ontology_name, runId=self.run_id)
        self.local.write_bytes("state.json", (json.dumps(self.state, sort_keys=True, indent=2) + "\n").encode("utf-8"))

    def _lakehouse(self) -> tuple[str, str]:
        item_id = self.config.lakehouse_id or self.state.get("lakehouseId", "")
        name = self.config.lakehouse_name or self.state.get("lakehouseName", "")
        if not item_id:
            item = self.fabric.find_item(name, "Lakehouse") or self.fabric.create_lakehouse(name)
            item_id = item["id"]
        if not name:
            name = self.fabric.get_lakehouse(item_id).get("displayName", item_id)
        self.state.update(lakehouseId=item_id, lakehouseName=name)
        self._save()
        return item_id, name

    def _files(self) -> tuple[str, OneLakeClient, OneLakeFiles]:
        item_id, _ = self._lakehouse()
        client = OneLakeClient(self.config.workspace_id, item_id, self.storage_token)
        return item_id, client, OneLakeFiles(client)

    def land(self) -> dict[str, Any]:
        local = LocalFolder(self.config.landing_root)
        file_entries = [entry for entry in local.list_paths() if not entry.is_dir]
        if not file_entries:
            raise ValueError("The local landing folder is empty")
        if any(entry.path == "_landing-manifest.json" for entry in file_entries):
            raise ValueError("_landing-manifest.json is reserved for the framework snapshot marker")
        payloads = {entry.path: local.read_bytes(entry.path) for entry in file_entries}
        manifest = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
        _, client, _ = self._files()
        landing_dir = f"landing/{self.run_id}"
        manifest_path = landing_dir + "/_landing-manifest.json"
        try:
            previous = json.loads(client.read_bytes(manifest_path))
        except ApiError as error:
            if error.status != 404:
                raise
            previous = None
        if previous is not None and previous != manifest:
            raise ValueError("This run_id already has a different landed snapshot; use a new run_id")
        archive, digest = build_framework_zip()
        framework_zip = f"_framework/{digest}/ontology_ingest.zip"
        if previous is None:
            try:
                existing = client.list(landing_dir)
            except ApiError as error:
                if error.status != 404:
                    raise
                existing = []
            allowed = {landing_dir + "/" + name for name in manifest}
            if any(not entry.is_dir and entry.path not in allowed for entry in existing):
                raise ValueError("The remote run folder contains stale files; choose a fresh run_id")
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(client.write_bytes, landing_dir + "/" + name, data) for name, data in sorted(payloads.items())]
                for future in futures:
                    future.result()
            client.write_bytes(framework_zip, archive)
            # The manifest is written only after every upload succeeds.
            client.write_bytes(manifest_path, json.dumps(manifest, sort_keys=True).encode("utf-8"))
            uploaded = len(payloads)
        else:
            uploaded = 0
            client.write_bytes(framework_zip, archive)
        count = len(payloads)
        result = {"landingDir": landing_dir, "frameworkZip": framework_zip, "frameworkHash": digest, "files": count, "uploaded": uploaded}
        self.state.update(result)
        self._save()
        return result

    def _parameters(self) -> dict[str, str]:
        if not self.state.get("frameworkZip"):
            raise ValueError("Run land first so notebook jobs use a published framework archive")
        item_id, _ = self._lakehouse()
        return {"workspace_id": self.config.workspace_id, "lakehouse_id": item_id,
                "landing_dir": self.state.get("landingDir", f"landing/{self.run_id}"), "run_id": self.run_id,
                "framework_zip": self.state["frameworkZip"], "framework_hash": self.state["frameworkHash"],
                "ontology_name": self.config.ontology_name, "ontology_description": self.config.ontology_description,
                "raw_schema": self.config.raw_schema, "binding_schema": self.config.binding_schema,
                "publish_mode": self.config.publish_mode, "retain_runs": str(self.config.retain_runs),
                "plan_path": self.state.get("planPath", plan_path(self.run_id))}

    def deploy_notebooks(self) -> dict[str, str]:
        parameters = self._parameters()
        item_id, name = self._lakehouse()
        notebooks = {}
        steps = ("prepare", "generate", "graph") if self.config.graph_model_name else ("prepare", "generate")
        if self.config.graph_model_name:
            parameters = dict(parameters, graph_model_name=self.config.graph_model_name,
                              graph_model_description=self.config.graph_model_description())
        for step in steps:
            notebook = build_notebook(step, workspace_id=self.config.workspace_id, lakehouse_id=item_id, lakehouse_name=name,
                                      parameters=parameters, kernel_metadata=self.config.notebook_kernel_metadata)
            item = self.fabric.upsert_notebook(self.config.notebooks[step], notebook, f"Ontology ingestion: {step}.")
            notebooks[step] = item["id"]
        self.state["notebookIds"] = notebooks
        self._save()
        return notebooks

    def pipeline_settings(self) -> dict[str, str]:
        if not self.state.get("frameworkZip"):
            raise ValueError("Run land first so the pipeline's notebooks use a published framework archive")
        return pipeline_settings(self.config, self.state["frameworkZip"], self.state["frameworkHash"])

    def deploy_pipeline(self) -> dict[str, Any]:
        """Deploy the notebooks and both pipelines. Run land first: the pipeline passes the landed framework archive's hash."""
        notebooks = self.deploy_notebooks()
        item_id, _ = self._lakehouse()
        copy = self.fabric.upsert_pipeline(self.config.pipelines["copy"], build_copy_pipeline(self.config.workspace_id, item_id),
                                           "Copies one landed dataset's entity and relationship CSV files into raw tables.")
        content = build_ingest_pipeline(self.config.workspace_id, item_id, copy_pipeline_id=copy["id"], notebooks=notebooks,
                                        settings=self.pipeline_settings())
        ingest = self.fabric.upsert_pipeline(self.config.pipelines["ingest"], content,
                                             "Lands a run's files as raw tables, then builds the typed tables, the ontology and its graph.")
        self.state["pipelineIds"] = {"copy": copy["id"], "ingest": ingest["id"]}
        self._save()
        return {"notebooks": notebooks, "pipelines": self.state["pipelineIds"]}

    def _pipeline_steps(self, job_id: str, after: str, before: str) -> list[dict[str, Any]]:
        """One line per activity run, with each copied file's rows and each notebook's summary, children included."""
        steps: list[dict[str, Any]] = []
        for run in self.fabric.pipeline_activity_runs(job_id, after=after, before=before):
            output = run.get("output") if isinstance(run.get("output"), dict) else {}
            error = run.get("error") if isinstance(run.get("error"), dict) else {}
            step = {"activity": run.get("activityName"), "type": run.get("activityType"), "status": run.get("status"),
                    "seconds": round((run.get("durationInMs") or 0) / 1000)}
            if error.get("message"):
                step["error"] = str(error["message"])[:2000]
            if run.get("activityType") == "Copy":
                step.update(rowsCopied=output.get("rowsCopied"), file=(run.get("input") or {}).get("source", {}).get("datasetSettings", {})
                            .get("typeProperties", {}).get("location", {}).get("fileName"))
            if run.get("activityType") == "TridentNotebook":
                exit_value = (output.get("result") or {}).get("exitValue") if isinstance(output.get("result"), dict) else None
                try:
                    step["summary"] = json.loads(exit_value) if exit_value else None
                except ValueError:
                    step["summary"] = exit_value
            steps.append(step)
            child = output.get("pipelineRunId")
            if run.get("activityType") == "ExecutePipeline" and child:
                steps.extend(dict(item, parent=step["activity"]) for item in self._pipeline_steps(child, after, before))
        return steps

    def run_pipeline(self) -> dict[str, Any]:
        """Run the deployed ingest pipeline for this run id, wait for it and report every activity, child runs included."""
        validate_pipeline_run_id(self.run_id)
        pipeline_id = self.state.get("pipelineIds", {}).get("ingest")
        if not pipeline_id:
            item = self.fabric.find_item(self.config.pipelines["ingest"], "DataPipeline")
            if not item:
                raise ValueError("The ingest pipeline is not deployed; run deploy-pipeline first")
            pipeline_id = item["id"]
        started = datetime.now(timezone.utc)
        job = self.fabric.run_pipeline(pipeline_id, {"run_id": self.run_id})
        window = ((started - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  (datetime.now(timezone.utc) + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        steps = self._pipeline_steps(job["id"], *window)
        result = {"pipelineId": pipeline_id, "jobId": job["id"], "status": job["status"],
                  "minutes": round((datetime.now(timezone.utc) - started).total_seconds() / 60, 1),
                  "filesCopied": sum(1 for step in steps if step["type"] == "Copy" and step["status"] == "Succeeded"),
                  "rowsCopied": sum(step.get("rowsCopied") or 0 for step in steps if step["type"] == "Copy"), "steps": steps}
        self.local.write_bytes("pipeline-run.json", (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        if job["status"].casefold() != "completed":
            failed = [f"{step['activity']}: {step.get('error', step['status'])}" for step in steps
                      if step["status"] not in {"Succeeded", "Skipped"} and step["type"] not in {"ForEach", "ExecutePipeline"}]
            reason = job.get("failureReason") or {}
            message = "; ".join(failed[:5]) or (reason.get("message", "") if isinstance(reason, dict) else str(reason))
            raise RuntimeError(f"Pipeline run {job['status']}: {message}".rstrip(": "))
        self.state["planPath"] = plan_path(self.run_id)
        self._save()
        return result

    def _notebook(self, step: str) -> dict[str, Any]:
        item_id = self.state.get("notebookIds", {}).get(step)
        if not item_id:
            item = self.fabric.find_item(self.config.notebooks[step], "Notebook")
            if not item:
                raise ValueError(f"The {step} notebook is not deployed; run deploy-notebooks first")
            item_id = item["id"]
        job = self.fabric.run_notebook_job(item_id, self._parameters())
        try:
            summary = json.loads(job["exitValue"])
        except (ValueError, TypeError) as error:
            raise ValueError("Notebook completed without a JSON exitValue on the notebook execute-instance endpoint") from error
        if not isinstance(summary, dict) or summary.get("runId") != self.run_id:
            raise ValueError("Notebook exitValue does not identify this run")
        failure = summary.get("error")
        if failure:
            detail = failure.get("message", "") if isinstance(failure, dict) else str(failure)
            kind = failure.get("type", "Error") if isinstance(failure, dict) else "Error"
            trace = failure.get("traceback", "") if isinstance(failure, dict) else ""
            raise RuntimeError(f"The {step} notebook failed with {kind}: {detail}\n{trace}".rstrip())
        return summary

    def prepare(self, engine: str) -> dict[str, Any]:
        if engine == "fabric":
            summary = self._notebook("prepare")
        else:
            item_id, _ = self._lakehouse()
            summary = prepare_remote(self.config.workspace_id, item_id, self.state.get("landingDir", f"landing/{self.run_id}"), self.run_id,
                                      storage_token=self.storage_token, raw_schema=self.config.raw_schema, binding_schema=self.config.binding_schema,
                                      publish_mode=self.config.publish_mode)
        self.state["planPath"] = summary["planPath"]
        self._save()
        return summary

    def generate(self, engine: str) -> dict[str, Any]:
        if engine == "fabric":
            summary = self._notebook("generate")
        else:
            item_id, client, files = self._files()
            summary = publish_plan(self.fabric, files, item_id, self.state.get("planPath", plan_path(self.run_id)),
                                    self.config.ontology_name, self.config.ontology_description, retain_runs=self.config.retain_runs,
                                    tables=OneLakeDeltaWriter(self.config.workspace_id, item_id, self.storage_token, client=client))
        self.state["ontologyId"] = summary["ontologyId"]
        self._save()
        return summary

    def verify(self, mcp_smoke: bool = False) -> dict[str, Any]:
        item_id, _, files = self._files()
        mcp = None
        if mcp_smoke or self.config.mcp_smoke:
            ontology = self.fabric.find_item(self.config.ontology_name, "Ontology")
            if not ontology:
                raise ValueError("Cannot smoke-test an ontology that does not exist")
            mcp = OntologyMCPClient(self.config.workspace_id, ontology["id"], AzureCliTokenProvider(POWER_BI_RESOURCE))
        smoke_call = self.config.mcp_smoke if isinstance(self.config.mcp_smoke, dict) else None
        result = verify_remote(self.fabric, files, OneLakeDeltaWriter(self.config.workspace_id, item_id, self.storage_token),
                               self.state.get("planPath", plan_path(self.run_id)), self.config.ontology_name, mcp=mcp, smoke_call=smoke_call)
        self.local.write_bytes("verification.json", (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        return result

    def graph_model(self) -> dict[str, Any]:
        """Publish the standalone graph model over this run's published binding tables, reload it and verify its counts."""
        if not self.config.graph_model_name:
            raise ValueError("Set graph_model_name in the configuration to publish a graph model")
        item_id, client, files = self._files()
        result = publish_run_graph(self.fabric, files, OneLakeDeltaWriter(self.config.workspace_id, item_id, self.storage_token, client=client),
                                   self.run_id, self.config.graph_model_name, self.config.graph_model_description(),
                                   self.config.workspace_id, item_id)
        self.state["graphModelId"] = result["graphModelId"]
        self._save()
        return result


def dry_run(config: Config, run_id: str, command: str) -> dict[str, Any]:
    output = LocalFolder(config.output_dir / run_id / "dry-run")
    reports = MemoryStorage()
    summary = prepare_run(LocalFolder(config.landing_root), InMemoryWriter(), run_id,
                          raw_schema=config.raw_schema, binding_schema=config.binding_schema, output=reports, output_dir="",
                          publish_mode=config.publish_mode)
    for path, data in reports.files.items():
        output.write_bytes(path, data)
    plan = OntologyPlan.from_json(reports.read_bytes(summary["planPath"]))
    endpoint = config.sql_endpoint or {"host": "unresolved.invalid", "id": "00000000-0000-0000-0000-000000000000"}
    plan.sqlEndpoint = endpoint
    parts = build_definition(plan, config.ontology_name, config.ontology_description, endpoint["host"], endpoint["id"])
    for name, text in parts.items():
        output.write_bytes("definition/" + name, text.encode("utf-8"))
    output.write_bytes("published-plan.json", plan.to_json().encode("utf-8"))
    graph_directory = None
    if config.graph_model_name:
        lakehouse = config.lakehouse_id or "00000000-0000-0000-0000-000000000000"
        graph_parts = build_graph_model_definition(plan, config.graph_model_name, config.graph_model_description(),
                                                   config.workspace_id, lakehouse)
        for name, text in graph_parts.items():
            output.write_bytes("graph-model/" + name, text.encode("utf-8"))
        graph_directory = str(output.root / "graph-model")
    placeholder = "00000000-0000-0000-0000-000000000000"
    lakehouse = config.lakehouse_id or placeholder
    steps = ("prepare", "generate", "graph") if config.graph_model_name else ("prepare", "generate")
    ingest = build_ingest_pipeline(config.workspace_id, lakehouse, copy_pipeline_id=placeholder,
                                   notebooks={step: placeholder for step in steps},
                                   settings=pipeline_settings(config, "_framework/<hash>/ontology_ingest.zip", "<hash>"))
    for name, content in (("copy.json", build_copy_pipeline(config.workspace_id, lakehouse)), ("ingest.json", ingest)):
        output.write_bytes("pipelines/" + name, (json.dumps(content, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    actions = ["Upload the landing snapshot and framework archive.", "Create or update prepare and generate notebooks.",
               "Prepare managed Delta tables and the ontology plan.", "Refresh SQL metadata, publish the ontology and check its definition.",
               "Compare binding row counts and optionally smoke-test MCP.",
               "With graph_model_name set, publish the graph model over the same tables, reload it and compare its node and "
               "edge counts with the plan; the graph command then queries it, and foundry_agent connects the ontology to a "
               "Foundry agent."]
    return {"dryRun": True, "requestedCommand": command, "actions": actions, "summary": summary,
            "sqlEndpointIsPlaceholder": config.sql_endpoint is None, "definitionDirectory": str(output.root / "definition"),
            "graphModelDefinitionDirectory": graph_directory, "pipelineDefinitionDirectory": str(output.root / "pipelines")}


def graph(config: Config, query: str | None = None, query_file: Path | None = None, max_pages: int = 1000) -> dict[str, Any]:
    """Step 5: report whether the ontology's graph can be queried, or run a GQL query against it. Writes no run state."""
    fabric = FabricClient(config.workspace_id, AzureCliTokenProvider(FABRIC_RESOURCE))
    if query_file is not None:
        try:
            query = query_file.read_text(encoding="utf-8-sig")
        except OSError as error:
            raise ValueError(f"Cannot read the query file {query_file}: {error}") from error
    if query is None:
        return graph_status(fabric, config.ontology_name, config.graph_model_name or None)
    return graph_query(fabric, config.ontology_name, query, max_pages=max_pages, graph_model_name=config.graph_model_name or None)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare and publish a Fabric IQ ontology from contract-v1 datasets")
    parser.add_argument("--config", type=Path, help="Path to a JSON configuration file")
    parser.add_argument("--run-id", help="Override the configured run id")
    parser.add_argument("--dry-run", action="store_true", help="Offline planning only; write local TMDL parts")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("land", "deploy-notebooks", "prepare", "generate", "verify", "graph-model", "deploy-pipeline", "run-pipeline", "run"):
        command = commands.add_parser(name)
        command.add_argument("--config", type=Path, default=argparse.SUPPRESS)
        command.add_argument("--run-id", default=argparse.SUPPRESS)
        command.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS)
        if name in {"prepare", "generate"}:
            command.add_argument("--engine", choices=("fabric", "local"), default="fabric")
        if name == "run":
            command.add_argument("--engine", choices=("fabric", "local", "pipeline"), default="fabric")
        if name in {"verify", "run"}:
            command.add_argument("--mcp-smoke", action="store_true")
    command = commands.add_parser("graph", help="Report whether the graph can be queried, or run a GQL query against it")
    command.add_argument("--config", type=Path, default=argparse.SUPPRESS)
    source = command.add_mutually_exclusive_group()
    source.add_argument("--query", help="GQL query to run")
    source.add_argument("--query-file", type=Path, help="File holding the GQL query to run")
    command.add_argument("--max-pages", type=int, default=1000, help="Most result pages to collect")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.config is None:
        parser.error("--config is required")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        config = load_config(args.config)
        if args.command == "graph":
            if args.dry_run:
                raise ValueError("graph has no dry run; it only reads the graph model")
            result = graph(config, args.query, args.query_file, args.max_pages)
            print(json.dumps(result, sort_keys=True, indent=2, ensure_ascii=False))
            return 0
        pipeline_run = args.command == "run-pipeline" or (args.command == "run" and args.engine == "pipeline")
        default_id = datetime.now(timezone.utc).strftime("%Y%m%dt%H%M%Sz" if pipeline_run else "%Y%m%dT%H%M%SZ")
        run_id = validate_run_id(args.run_id or config.run_id or default_id)
        if pipeline_run:
            validate_pipeline_run_id(run_id)
        if args.dry_run:
            result = dry_run(config, run_id, args.command)
        else:
            runner = Runner(config, run_id)
            if args.command == "run" and args.engine == "pipeline":
                result = {"land": runner.land(), "deploy": runner.deploy_pipeline(), "pipeline": runner.run_pipeline(),
                          "verify": runner.verify(args.mcp_smoke)}
            elif args.command == "run":
                result = {"land": runner.land(), "notebooks": runner.deploy_notebooks(), "prepare": runner.prepare(args.engine),
                          "generate": runner.generate(args.engine), "verify": runner.verify(args.mcp_smoke)}
                if config.graph_model_name:
                    result["graphModel"] = runner.graph_model()
            elif args.command == "land":
                result = runner.land()
            elif args.command == "deploy-notebooks":
                result = runner.deploy_notebooks()
            elif args.command == "deploy-pipeline":
                result = runner.deploy_pipeline()
            elif args.command == "run-pipeline":
                result = runner.run_pipeline()
            elif args.command in {"prepare", "generate"}:
                result = getattr(runner, args.command)(args.engine)
            elif args.command == "graph-model":
                result = runner.graph_model()
            else:
                result = runner.verify(args.mcp_smoke)
        print(json.dumps(result, sort_keys=True, indent=2, ensure_ascii=False))
        return 0
    except GraphNotQueryable as error:
        print(f"ontology-ingest: {error}", file=sys.stderr)
        return 3
    except (ValueError, RuntimeError, OSError, TypeError) as error:
        print(f"ontology-ingest: {error}", file=sys.stderr)
        return 2
