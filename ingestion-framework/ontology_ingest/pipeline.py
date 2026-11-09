"""Fabric pipelines that copy landed contract files into raw tables and then run the framework's notebooks.

The ingest pipeline is metadata-driven. It lists the dataset folders of a landed run and, for each folder, runs the copy
pipeline, which lists that folder's entity and relationship files and copies every CSV file into its own raw table. It
then runs three notebooks: prepare expands the JSON properties and builds the typed binding tables, generate publishes the
ontology with its data bindings, and graph publishes the graph model, the workaround for the ontology's own graph described
in docs/FABRIC_KNOWLEDGE.md. Neither pipeline names a dataset, entity or relationship, so any number of them flows through.
"""
from __future__ import annotations

import json
from typing import Any

from .naming import validate_pipeline_run_id, validate_table_name
from .tmdl import platform_metadata, to_api_definition

__all__ = ["build_copy_pipeline", "build_ingest_pipeline", "pipeline_definition", "validate_pipeline_run_id"]

COPY_PARAMETERS = ("landing_dir", "dataset", "raw_schema")
DATASET_BATCH = 3
FILE_BATCH = 6
# The raw table for one file, built exactly as naming.raw_table_name builds it: the dataset folder with hyphens as
# underscores, a kind marker, and the file name without ".csv", all lowercase.
RAW_TABLE = ("@concat(toLower(replace(pipeline().parameters.dataset, '-', '_')), '__{code}_', "
             "toLower(substring(item().name, 0, sub(length(item().name), 4))))")


def _expr(text: str) -> dict[str, str]:
    return {"value": text, "type": "Expression"}


def _policy(timeout: str) -> dict[str, Any]:
    return {"timeout": timeout, "retry": 0, "retryIntervalInSeconds": 30, "secureOutput": False, "secureInput": False}


def _after(*names: str) -> list[dict[str, Any]]:
    return [{"activity": name, "dependencyConditions": ["Succeeded"]} for name in names]


def _lakehouse(workspace_id: str, lakehouse_id: str, root: str) -> dict[str, Any]:
    return {"name": "lakehouse_" + root.lower(), "properties": {"annotations": [], "type": "Lakehouse",
            "typeProperties": {"workspaceId": workspace_id, "artifactId": lakehouse_id, "rootFolder": root}}}


def _list_folder(name: str, folder: str, workspace_id: str, lakehouse_id: str, *, optional: bool,
                 depends_on: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"name": name, "type": "GetMetadata", "dependsOn": depends_on or [], "policy": _policy("0.00:10:00"),
            "typeProperties": {"fieldList": ["exists", "childItems"] if optional else ["childItems"],
                               "datasetSettings": {"annotations": [], "linkedService": _lakehouse(workspace_id, lakehouse_id, "Files"),
                                                   "type": "Binary", "typeProperties": {
                                                       "location": {"type": "LakehouseLocation", "folderPath": _expr(folder)}}},
                               "storeSettings": {"type": "LakehouseReadSettings", "recursive": False, "enablePartitionDiscovery": False},
                               "formatSettings": {"type": "BinaryReadSettings"}}}


def _filter(name: str, items: str, condition: str, after: str) -> dict[str, Any]:
    return {"name": name, "type": "Filter", "dependsOn": _after(after),
            "typeProperties": {"items": _expr(items), "condition": _expr(condition)}}


def _copy_file(name: str, folder: str, code: str, workspace_id: str, lakehouse_id: str) -> dict[str, Any]:
    source = {"annotations": [], "linkedService": _lakehouse(workspace_id, lakehouse_id, "Files"), "type": "DelimitedText",
              "typeProperties": {"location": {"type": "LakehouseLocation", "folderPath": _expr(folder), "fileName": _expr("@item().name")},
                                 # RFC 4180 quoting: a doubled quote inside a quoted value, as in the properties_json column.
                                 "columnDelimiter": ",", "quoteChar": "\"", "escapeChar": "\"", "firstRowAsHeader": True,
                                 "encodingName": "UTF-8"},
              "schema": []}
    sink = {"annotations": [], "linkedService": _lakehouse(workspace_id, lakehouse_id, "Tables"), "type": "LakehouseTable", "schema": [],
            "typeProperties": {"schema": _expr("@pipeline().parameters.raw_schema"), "table": _expr(RAW_TABLE.format(code=code))}}
    return {"name": name, "type": "Copy", "dependsOn": [], "policy": _policy("0.01:00:00"),
            "typeProperties": {"source": {"type": "DelimitedTextSource",
                                          "storeSettings": {"type": "LakehouseReadSettings", "recursive": False,
                                                            "enablePartitionDiscovery": False},
                                          "formatSettings": {"type": "DelimitedTextReadSettings"}, "datasetSettings": source},
                               "sink": {"type": "LakehouseTableSink", "tableActionOption": "OverwriteSchema", "partitionOption": "None",
                                        "datasetSettings": sink},
                               "enableStaging": False}}


def build_copy_pipeline(workspace_id: str, lakehouse_id: str) -> dict[str, Any]:
    """For one dataset folder: list its entity and relationship files and copy every CSV file into its raw table."""
    activities: list[dict[str, Any]] = []
    for folder_name, code, label in (("entities", "e", "entity"), ("relationships", "r", "relationship")):
        folder = f"@concat(pipeline().parameters.landing_dir, '/', pipeline().parameters.dataset, '/{folder_name}')"
        listing, keep, copy = f"List {label} files", f"Keep {label} CSV files", f"Copy {label} files"
        activities += [
            _list_folder(listing, folder, workspace_id, lakehouse_id, optional=True),
            # A dataset may have no entities or no relationships folder; GetMetadata then reports exists = false and omits
            # childItems, which the null-safe ?. operator turns into null rather than an error.
            _filter(keep, f"@coalesce(activity('{listing}').output?.childItems, json('[]'))",
                    "@and(equals(item().type, 'File'), endswith(toLower(item().name), '.csv'))", listing),
            {"name": copy, "type": "ForEach", "dependsOn": _after(keep),
             "typeProperties": {"items": _expr(f"@activity('{keep}').output.value"), "isSequential": False, "batchCount": FILE_BATCH,
                                "activities": [_copy_file(f"Copy {label} file", folder, code, workspace_id, lakehouse_id)]}}]
    return {"properties": {"description": "Copies one landed dataset's entity and relationship CSV files into raw lakehouse tables.",
                           "parameters": {name: {"type": "string", "defaultValue": ""} for name in COPY_PARAMETERS},
                           "activities": activities}}


def _notebook(name: str, notebook_id: str, workspace_id: str, static: dict[str, str], dynamic: dict[str, str],
              after: str) -> dict[str, Any]:
    parameters = {key: {"value": value, "type": "string"} for key, value in static.items()}
    parameters.update({key: {"value": _expr(value), "type": "string"} for key, value in dynamic.items()})
    return {"name": name, "type": "TridentNotebook", "dependsOn": _after(after), "policy": _policy("0.02:00:00"),
            "typeProperties": {"notebookId": notebook_id, "workspaceId": workspace_id, "parameters": parameters}}


def build_ingest_pipeline(workspace_id: str, lakehouse_id: str, *, copy_pipeline_id: str, notebooks: dict[str, str],
                          settings: dict[str, str]) -> dict[str, Any]:
    """The parent pipeline: check the run id, copy every dataset folder, then prepare, generate and (optionally) graph.

    ``notebooks`` maps prepare, generate and optionally graph to notebook item ids. ``settings`` holds the notebooks' fixed
    parameters, including raw_schema, the base of the run's raw schema, and publish_mode."""
    raw_base = validate_table_name(settings["raw_schema"])
    run_id = "pipeline().parameters.run_id"
    landing = f"@concat('landing/', {run_id})"
    # naming.pipeline_raw_schema for a staged run; an in-place run reuses the base schema (a value without @ is a literal).
    raw_schema = f"@concat('{raw_base}', '_', {run_id})" if settings["publish_mode"] == "staged" else raw_base
    check, listing, keep, each = "Check the run id", "List dataset folders", "Keep dataset folders", "Copy each dataset"
    activities: list[dict[str, Any]] = [
        {"name": check, "type": "IfCondition", "dependsOn": [],
         "typeProperties": {"expression": _expr(f"@or(empty({run_id}), not(equals({run_id}, replace(replace(replace(toLower({run_id}), "
                                                f"'-', '_'), '.', '_'), ' ', '_'))))"),
                            "ifTrueActivities": [{"name": "Reject the run id", "type": "Fail", "dependsOn": [],
                                                  "typeProperties": {"errorCode": "InvalidRunId", "message":
                                                      "run_id must use lowercase letters, digits and underscores, such as live6"}}]}},
        _list_folder(listing, landing, workspace_id, lakehouse_id, optional=False, depends_on=_after(check)),
        _filter(keep, f"@activity('{listing}').output.childItems",
                "@and(equals(item().type, 'Folder'), not(startswith(item().name, '_')))", listing),
        {"name": each, "type": "ForEach", "dependsOn": _after(keep),
         "typeProperties": {"items": _expr(f"@activity('{keep}').output.value"), "isSequential": False, "batchCount": DATASET_BATCH,
                            "activities": [{"name": "Copy dataset files", "type": "ExecutePipeline", "dependsOn": [],
                                            "policy": {"secureInput": False},
                                            "typeProperties": {"pipeline": {"referenceName": copy_pipeline_id, "type": "PipelineReference"},
                                                               "waitOnCompletion": True,
                                                               "parameters": {"landing_dir": _expr(landing), "dataset": _expr("@item().name"),
                                                                              "raw_schema": _expr(raw_schema)}}}]}}]
    static = dict(settings, workspace_id=workspace_id, lakehouse_id=lakehouse_id, raise_errors="true")
    dynamic = {"run_id": "@" + run_id, "landing_dir": landing, "raw_tables_schema": raw_schema,
               "plan_path": f"@concat('_ontology_ingest/', {run_id}, '/ontology-plan.json')"}
    steps = [("prepare", "Expand JSON and build tables"), ("generate", "Create ontology and bindings"), ("graph", "Build graph model")]
    previous = each
    for step, name in steps:
        if step in notebooks:
            activities.append(_notebook(name, notebooks[step], workspace_id, static, dynamic, previous))
            previous = name
    return {"properties": {"description": "Lands a run's files as raw tables, then builds the typed tables, the ontology and its graph.",
                           "parameters": {"run_id": {"type": "string", "defaultValue": ""}}, "activities": activities}}


def pipeline_definition(content: dict[str, Any], name: str, description: str = "") -> dict[str, Any]:
    return to_api_definition({"pipeline-content.json": json.dumps(content, ensure_ascii=False, indent=2) + "\n",
                              ".platform": platform_metadata(name, description, "DataPipeline")})
