"""Build a standalone Fabric graph model over the published binding tables, refresh it and check what it loaded.

An ontology can project its own graph only for tables bound in the Fabric portal. The portal writes reserved ONT_*
connection annotations on every partition, and the public definition API removes them on create and update, so an
ontology published by this framework reports every entity type as an "Unsupported Datasource" in Manage graph. This
module therefore publishes an ordinary graph model item through the documented Graph Model definition instead: one node
type per entity type and one edge type per relationship type, read straight from the same Delta tables.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .fabric import FabricClient
from .graph import GraphNotQueryable, describe, queryable_graph_type
from .plan import EntityPlan, OntologyPlan, validate_plan
from .tmdl import platform_metadata

SCHEMA_BASE = "https://developer.microsoft.com/json-schemas/fabric/item/graphIndex/definition/"
GRAPH_TYPES = {"string": "STRING", "int64": "INT", "double": "FLOAT", "boolean": "BOOLEAN", "dateTime": "DATETIME"}
OPEN_ONCE_HINT = ("A graph model created through the REST API cannot load data until it has been opened once in the graph "
                  "model editor in the Fabric portal. Open the graph model in the portal, then run graph-model again.")
GRID_COLUMNS = 6
LAKEHOUSE_REFERENCE = "lakehouse"


def _identifier(value: str, kind: str) -> str:
    """A GQL-friendly name: identifiers pass through unchanged, anything else keeps only letters, digits and underscores."""
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", value):
        return value
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    if not cleaned:
        raise ValueError(f"Cannot derive a graph {kind} from {value!r}")
    return cleaned if cleaned[0].isalpha() else "n_" + cleaned


def _names(values: list[str], kind: str) -> dict[str, str]:
    result: dict[str, str] = {}
    owners: dict[str, str] = {}
    for value in values:
        name = _identifier(value, kind)
        if name.casefold() in owners and owners[name.casefold()] != value:
            raise ValueError(f"Graph {kind} {name!r} would be shared by {owners[name.casefold()]!r} and {value!r}")
        owners[name.casefold()] = value
        result[value] = name
    return result


def _guid(value: str, kind: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError(f"{kind} must be a GUID") from error


def table_path(schema: str, table: str) -> str:
    """Path of a binding table relative to the lakehouse item; dataSources 1.1.0 rejects sources without referenceName."""
    return f"Tables/{schema}/{table}"


def _ordered(entity: EntityPlan) -> list[Any]:
    return sorted(entity.properties, key=lambda prop: (prop.name != entity.keyProperty, prop.name))


def _json(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def graph_shape(plan: OntologyPlan) -> dict[str, Any]:
    """Node labels, edge labels and aliases derived from the plan, shared by the definition and the verification."""
    validate_plan(plan)
    labels = _names([entity.name for entity in plan.entities], "node label")
    edge_names = _names([rel.name for rel in plan.relationships], "edge type")
    relations = {rel.name: _identifier(rel.relation, "edge label") for rel in plan.relationships}
    return {"nodeLabels": labels, "nodeAliases": {name: label + "_node" for name, label in labels.items()},
            "edgeLabels": relations, "edgeAliases": {name: alias + "_edge" for name, alias in edge_names.items()}}


def build_graph_model_definition(plan: OntologyPlan, name: str, description: str, workspace_id: str, lakehouse_id: str) -> dict[str, str]:
    shape = graph_shape(plan)
    entities = sorted(plan.entities, key=lambda entity: entity.name)
    relationships = sorted(plan.relationships, key=lambda rel: rel.name)
    tables = sorted([entity.table for entity in entities] + [rel.table for rel in relationships])
    data_sources = {"$schema": SCHEMA_BASE + "dataSources/1.1.0/schema.json",
                    "itemReferences": [{"name": LAKEHOUSE_REFERENCE,
                                        "item": {"workspaceId": _guid(workspace_id, "workspace_id"),
                                                 "itemId": _guid(lakehouse_id, "lakehouse_id")}}],
                    "dataSources": [{"name": table, "type": "DeltaTable",
                                     "properties": {"referenceName": LAKEHOUSE_REFERENCE, "path": table_path(plan.bindingSchema, table)}}
                                    for table in tables]}
    node_types, node_tables = [], []
    for entity in entities:
        alias = shape["nodeAliases"][entity.name]
        properties = _names([prop.name for prop in entity.properties], f"property of {entity.name}")
        node_types.append({"alias": alias, "labels": [shape["nodeLabels"][entity.name]],
                           "primaryKeyProperties": [properties[entity.keyProperty]],
                           "properties": [{"name": properties[prop.name], "type": GRAPH_TYPES[prop.dataType]} for prop in _ordered(entity)]})
        node_tables.append({"id": alias + "_table", "nodeTypeAlias": alias, "dataSourceName": entity.table,
                            "propertyMappings": [{"propertyName": properties[prop.name], "sourceColumn": prop.column}
                                                 for prop in _ordered(entity)]})
    edge_types, edge_tables = [], []
    for rel in relationships:
        alias = shape["edgeAliases"][rel.name]
        edge_types.append({"alias": alias, "labels": [shape["edgeLabels"][rel.name]],
                           "sourceNodeType": {"alias": shape["nodeAliases"][rel.fromEntity]},
                           "destinationNodeType": {"alias": shape["nodeAliases"][rel.toEntity]}, "properties": []})
        edge_tables.append({"id": alias + "_table", "edgeTypeAlias": alias, "dataSourceName": rel.table,
                            "sourceNodeKeyColumns": [rel.fromColumn], "destinationNodeKeyColumns": [rel.toColumn],
                            "propertyMappings": []})
    positions = {node["alias"]: {"x": (index % GRID_COLUMNS) * 240, "y": (index // GRID_COLUMNS) * 180}
                 for index, node in enumerate(node_types)}
    styling = {"$schema": SCHEMA_BASE + "stylingConfiguration/1.0.0/schema.json",
               "modelLayout": {"positions": positions,
                               "styles": {alias: {"size": 30} for alias in [*positions, *(edge["alias"] for edge in edge_types)]},
                               "pan": {"x": 0, "y": 0}, "zoomLevel": 1}}
    return {".platform": platform_metadata(name, description, "GraphModel"),
            "dataSources.json": _json(data_sources),
            "graphDefinition.json": _json({"$schema": SCHEMA_BASE + "graphDefinition/1.0.0/schema.json",
                                           "nodeTables": node_tables, "edgeTables": edge_tables}),
            "graphType.json": _json({"$schema": SCHEMA_BASE + "graphType/1.0.0/schema.json",
                                     "nodeTypes": node_types, "edgeTypes": edge_types}),
            "stylingConfiguration.json": _json(styling)}


def _count(fabric: FabricClient, graph_model_id: str, query: str) -> int:
    rows = fabric.graph_execute_query(graph_model_id, query)["rows"]
    if len(rows) != 1 or not isinstance(rows[0], dict) or not isinstance(rows[0].get("c"), int):
        raise ValueError(f"Count query returned an unexpected result: {query}")
    return rows[0]["c"]


def verify_graph_model(fabric: FabricClient, graph_model_id: str, plan: OntologyPlan, *, counts: bool = True) -> dict[str, Any]:
    """Check that the loaded graph has exactly the planned node and edge types and, optionally, the planned counts."""
    shape = graph_shape(plan)
    loaded = queryable_graph_type(fabric, graph_model_id)
    if loaded is None:
        raise GraphNotQueryable("The graph model has no loaded graph yet. " + OPEN_ONCE_HINT)
    described = describe(loaded)
    labels = shape["nodeLabels"]
    expected_nodes = sorted(labels.values())
    expected_edges = sorted((shape["edgeLabels"][rel.name], labels[rel.fromEntity], labels[rel.toEntity]) for rel in plan.relationships)
    actual_nodes = sorted("&".join(node["labels"]) for node in described["nodeTypes"])
    actual_edges = sorted(("&".join(edge["labels"]), edge["from"], edge["to"]) for edge in described["edgeTypes"])
    if actual_nodes != expected_nodes or actual_edges != expected_edges:
        raise ValueError(f"Loaded graph type differs from the plan: missing nodes {sorted(set(expected_nodes) - set(actual_nodes))}, "
                         f"unexpected nodes {sorted(set(actual_nodes) - set(expected_nodes))}, "
                         f"missing edges {sorted(set(expected_edges) - set(actual_edges))}, "
                         f"unexpected edges {sorted(set(actual_edges) - set(expected_edges))}")
    result: dict[str, Any] = {"nodeTypes": len(actual_nodes), "edgeTypes": len(actual_edges)}
    if counts:
        mismatches: list[str] = []
        nodes = edges = 0
        for entity in plan.entities:
            found = _count(fabric, graph_model_id, f"MATCH (n:`{labels[entity.name]}`) RETURN count(n) AS c")
            nodes += found
            if found != entity.rowCount:
                mismatches.append(f"{labels[entity.name]} nodes {found} != {entity.rowCount}")
        for rel in plan.relationships:
            found = _count(fabric, graph_model_id, f"MATCH (:`{labels[rel.fromEntity]}`)-[e:`{shape['edgeLabels'][rel.name]}`]->"
                                                   f"(:`{labels[rel.toEntity]}`) RETURN count(e) AS c")
            edges += found
            if found != rel.edgeCount:
                mismatches.append(f"{rel.name} edges {found} != {rel.edgeCount}")
        if mismatches:
            raise ValueError("Graph counts differ from the plan: " + "; ".join(mismatches))
        result.update(nodes=nodes, edges=edges)
    return result


def publish_graph_model(fabric: FabricClient, plan: OntologyPlan, name: str, description: str, workspace_id: str,
                        lakehouse_id: str, *, verify_counts: bool = True) -> dict[str, Any]:
    """Create or update the graph model for this plan, reload its data and verify the loaded graph against the plan."""
    parts = build_graph_model_definition(plan, name, description, workspace_id, lakehouse_id)
    item = fabric.upsert_graph_model(name, parts, description)
    refresh = fabric.run_graph_refresh(item["id"])
    if refresh["status"].casefold() != "completed":
        reason = refresh.get("failureReason") or {}
        message = reason.get("message", "") if isinstance(reason, dict) else str(reason)
        raise RuntimeError(f"Graph refresh {refresh['status']}: {message}".rstrip() + " " + OPEN_ONCE_HINT)
    verification = verify_graph_model(fabric, item["id"], plan, counts=verify_counts)
    return {"graphModelId": item["id"], "graphModelName": name, "runId": plan.runId, "bindingSchema": plan.bindingSchema,
            "refreshJobId": refresh["id"], **verification}
