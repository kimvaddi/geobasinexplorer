"""Shared orchestration used unchanged by local execution and notebook cells."""
from __future__ import annotations

import hashlib
import json
from pathlib import PurePosixPath
from typing import Any

from .auth import TokenProvider
from .delta import OneLakeDeltaWriter, SchemaManager, TableReader
from .fabric import FabricClient, OntologyMCPClient
from .graphmodel import publish_graph_model
from .http import ApiError
from .lifecycle import optional_json, record_publication, validate_retention, verify_row_counts
from .onelake import OneLakeClient, OneLakeFiles
from .plan import OntologyPlan
from .prepare import run, validate_run_id
from .storage import Storage
from .tmdl import build_definition, verify_definition


def report_directory(run_id: str) -> str:
    return "_ontology_ingest/" + validate_run_id(run_id)


def plan_path(run_id: str) -> str:
    return report_directory(run_id) + "/ontology-plan.json"


def published_plan_path(run_id: str) -> str:
    return report_directory(run_id) + "/published-plan.json"


def prepare_remote(workspace_id: str, lakehouse_id: str, landing_dir: str, run_id: str, *,
                   storage_token: TokenProvider, raw_schema: str = "raw", binding_schema: str = "dbo",
                   publish_mode: str = "staged", raw_tables_schema: str = "") -> dict[str, Any]:
    """Prepare a landed run. With ``raw_tables_schema``, read the raw tables an ingest pipeline copied into that schema."""
    client = OneLakeClient(workspace_id, lakehouse_id, storage_token)
    tables = OneLakeDeltaWriter(workspace_id, lakehouse_id, storage_token, client=client)
    return run(OneLakeFiles(client, landing_dir), tables, run_id,
               raw_schema=raw_schema, binding_schema=binding_schema, output=OneLakeFiles(client),
               output_dir=report_directory(run_id), publish_mode=publish_mode,
               copied_raw=(tables, raw_tables_schema) if raw_tables_schema else None)


def publish_run_graph(fabric: FabricClient, files: Storage, tables: SchemaManager, run_id: str, graph_model_name: str,
                      description: str, workspace_id: str, lakehouse_id: str) -> dict[str, Any]:
    """Point the graph model at a published run's binding tables, reload it and verify it (the ontology graph workaround)."""
    try:
        plan = OntologyPlan.from_json(files.read_bytes(published_plan_path(run_id)))
    except (FileNotFoundError, KeyError):
        raise ValueError(f"Run {run_id} has no published plan; run generate first") from None
    except ApiError as error:
        if error.status != 404:
            raise
        raise ValueError(f"Run {run_id} has no published plan; run generate first") from None
    if plan.runId != run_id:
        raise ValueError("The published plan does not belong to this run")
    if not tables.schema_exists(plan.bindingSchema):
        raise ValueError(f"Run {run_id}'s binding tables ({plan.bindingSchema}) no longer exist; publish the graph from a retained run")
    return publish_graph_model(fabric, plan, graph_model_name, description, workspace_id, lakehouse_id)


def graph_remote(workspace_id: str, lakehouse_id: str, run_id: str, graph_model_name: str, description: str = "", *,
                 fabric_token: TokenProvider, storage_token: TokenProvider) -> dict[str, Any]:
    client = OneLakeClient(workspace_id, lakehouse_id, storage_token)
    return publish_run_graph(FabricClient(workspace_id, fabric_token), OneLakeFiles(client),
                             OneLakeDeltaWriter(workspace_id, lakehouse_id, storage_token, client=client),
                             run_id, graph_model_name, description, workspace_id, lakehouse_id)


def _read_prepared_plan(files: Storage, path: str) -> OntologyPlan:
    status_path = str(PurePosixPath(path).with_name("prepare-status.json"))
    status = optional_json(files, status_path)
    if status is not None and status.get("state") != "complete":
        raise ValueError("Preparation is not complete; refusing to publish or verify a potentially stale plan")
    plan_bytes = files.read_bytes(path)
    plan = OntologyPlan.from_json(plan_bytes)
    if status is None:
        if plan.publication is not None:
            raise ValueError("A managed preparation is not complete without its completion marker")
        return plan
    if status.get("runId") != plan.runId or status.get("planSha256") != hashlib.sha256(plan_bytes).hexdigest():
        raise ValueError("Prepared plan does not match its completion marker")
    return plan


def publish_plan(fabric: FabricClient, files: Storage, lakehouse_id: str, path: str,
                 ontology_name: str, description: str = "", *, tables: SchemaManager | None = None, retain_runs: int = 2) -> dict[str, Any]:
    validate_retention(retain_runs)
    plan = _read_prepared_plan(files, path)
    if plan.publication is not None and tables is None:
        raise ValueError("Managed publication requires a table reader for pre-publication verification")
    if tables is not None:
        verify_row_counts(tables, plan)
    lakehouse = fabric.get_lakehouse(lakehouse_id)
    endpoint = lakehouse.get("properties", {}).get("sqlEndpointProperties", {})
    host, endpoint_id = endpoint.get("connectionString"), endpoint.get("id")
    if not host or not endpoint_id:
        raise ValueError("Lakehouse SQL endpoint is not ready; connectionString and id are required")
    required_tables = [f"{plan.bindingSchema}.{entity.table}" for entity in plan.entities] + [f"{plan.bindingSchema}.{rel.table}" for rel in plan.relationships]
    fabric.refresh_sql_endpoint_metadata(endpoint_id, required_tables)
    plan.sqlEndpoint = {"host": host, "id": endpoint_id}
    parts = build_definition(plan, ontology_name, description, host, endpoint_id)
    for name, text in parts.items():
        files.write_bytes(report_directory(plan.runId) + "/definition/" + name, text.encode("utf-8"))
    item = fabric.upsert_ontology(ontology_name, parts, description)
    verification = verify_definition(plan, fabric.get_ontology_definition(item["id"]))
    if tables is not None:
        verify_row_counts(tables, plan)
    files.write_bytes(published_plan_path(plan.runId), plan.to_json().encode("utf-8"))
    cleanup = record_publication(files, tables, plan, item["id"], ontology_name, retain_runs) if tables is not None and plan.publication is not None else None
    return {"cleanup": cleanup, "runId": plan.runId, "ontologyId": item["id"], "ontologyName": ontology_name, "planPath": path,
            **verification, "graphMaterialization": "manual-portal-step",
            "ontologyEndpoint": fabric.http.base_url + f"/v1/mcp/dataPlane/workspaces/{fabric.workspace_id}/items/{item['id']}/ontologyEndpoint"}


def generate_remote(workspace_id: str, lakehouse_id: str, path: str, ontology_name: str, description: str = "", *,
                    fabric_token: TokenProvider, storage_token: TokenProvider, retain_runs: int = 2) -> dict[str, Any]:
    client = OneLakeClient(workspace_id, lakehouse_id, storage_token)
    return publish_plan(FabricClient(workspace_id, fabric_token), OneLakeFiles(client),
                        lakehouse_id, path, ontology_name, description, retain_runs=retain_runs,
                        tables=OneLakeDeltaWriter(workspace_id, lakehouse_id, storage_token, client=client))


def verify_remote(fabric: FabricClient, files: Storage, writer: TableReader, path: str, ontology_name: str,
                  *, mcp: OntologyMCPClient | None = None, smoke_call: dict[str, Any] | None = None) -> dict[str, Any]:
    plan = _read_prepared_plan(files, path)
    item = fabric.find_item(ontology_name, "Ontology")
    if not item:
        raise ValueError(f"Ontology {ontology_name!r} does not exist")
    counts = verify_row_counts(writer, plan)
    structure = verify_definition(plan, fabric.get_ontology_definition(item["id"]))
    result: dict[str, Any] = {"ontologyId": item["id"], "rowCounts": counts, "definition": structure}
    if mcp is not None:
        result["mcp"] = mcp.list_tools()
        if smoke_call:
            result["mcp"]["smokeResult"] = mcp.call_tool(smoke_call["name"], smoke_call.get("arguments", {}))
    return result
