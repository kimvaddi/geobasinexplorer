"""Step 5: find the graph model, report whether it can be queried, and run GQL against it.

Fabric creates a graph model beside every ontology but loads nothing into it until someone materializes the graph in the
portal (Manage graph in the ontology). Manage graph only accepts tables bound in the portal, so for ontologies published by
this framework the queryable graph is the standalone graph model named by graph_model_name (see graphmodel.py). Until a
graph is loaded, Get Queryable Graph Type answers HTTP 204 with no body and Execute Query fails with GraphNotQueryable, so
this module reports that state in plain words instead of surfacing a raw HTTP 400.
"""
from __future__ import annotations

import json
from typing import Any

from .fabric import FabricClient, _query, _segment
from .http import ApiError

MATERIALIZE_HINT = (
    "The ontology's own graph is materialized in the Fabric portal with Manage graph, but Fabric reports every entity type "
    "that was published through the public API as an Unsupported Datasource there. Set graph_model_name and run graph-model "
    "to publish a graph model over the same tables instead.")
GRAPH_MODEL_HINT = (
    "Run graph-model to load it. A graph model created through the REST API must be opened once in the graph model editor "
    "in the Fabric portal before its first load can succeed.")


class GraphNotQueryable(RuntimeError):
    """The ontology's graph model has no loaded graph to query yet."""


def _item(item: dict[str, Any]) -> dict[str, str]:
    return {"id": str(item.get("id", "")), "name": str(item.get("displayName", ""))}


def find_graph_model(fabric: FabricClient, ontology_name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    items = fabric.list_items()
    ontologies = [item for item in items if item.get("type") == "Ontology" and item.get("displayName") == ontology_name]
    if not ontologies:
        raise ValueError(f"No ontology named {ontology_name!r} in workspace {fabric.workspace_id}")
    if len(ontologies) > 1:
        raise ValueError(f"Multiple ontologies named {ontology_name!r}; use an unambiguous name")
    ontology = ontologies[0]
    ontology_id = str(ontology.get("id", "")).replace("-", "").casefold()
    if not ontology_id:
        raise ValueError(f"Ontology {ontology_name!r} has no item id")
    # Fabric names the child graph model <ontology>_graph_<ontology id without dashes>, so the id suffix tells the
    # ontology's own graph apart from the graphs of other ontologies in the workspace.
    suffix = "_graph_" + ontology_id
    graphs = [item for item in items
              if item.get("type") == "GraphModel" and str(item.get("displayName", "")).casefold().endswith(suffix)]
    if len(graphs) != 1:
        found = "no graph model" if not graphs else f"{len(graphs)} graph models"
        raise ValueError(f"Ontology {ontology_name!r} has {found} named *{suffix}; Fabric creates exactly one with the ontology")
    return ontology, graphs[0]


def find_named_graph_model(fabric: FabricClient, name: str) -> dict[str, Any]:
    graph = fabric.find_item(name, "GraphModel")
    if not graph:
        raise ValueError(f"No graph model named {name!r} in workspace {fabric.workspace_id}; run graph-model first")
    return graph


def _resolve(fabric: FabricClient, ontology_name: str, graph_model_name: str | None) -> tuple[dict[str, Any], str]:
    """The graph to use and the hint for an unloaded graph; a named graph model takes precedence over the ontology's own."""
    if graph_model_name:
        return {"graphModel": _item(find_named_graph_model(fabric, graph_model_name))}, GRAPH_MODEL_HINT
    ontology, graph = find_graph_model(fabric, ontology_name)
    return {"ontology": _item(ontology), "graphModel": _item(graph)}, MATERIALIZE_HINT


def queryable_graph_type(fabric: FabricClient, graph_model_id: str, *, max_pages: int = 100) -> dict[str, list[Any]] | None:
    """The loaded graph's node and edge types, or None while nothing has been loaded."""
    base = fabric.workspace_path + f"/graphModels/{_segment(graph_model_id)}/getQueryableGraphType?beta=true"
    path, visited = base, set()
    node_types: list[Any] = []
    edge_types: list[Any] = []
    for _ in range(max_pages):
        if path in visited:
            raise ValueError("Queryable graph type pagination repeated a continuation")
        visited.add(path)
        response = fabric.http.request("GET", path)
        if response.status == 204 or not response.body.strip():
            if node_types or edge_types:
                raise ValueError("Queryable graph type continuation returned no content")
            return None
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("Queryable graph type response is not an object")
        nodes, edges = body.get("nodeTypes") or [], body.get("edgeTypes") or []
        if not all(isinstance(value, list) and all(isinstance(item, dict) for item in value) for value in (nodes, edges)):
            raise ValueError("Queryable graph type response has invalid nodeTypes or edgeTypes")
        node_types.extend(nodes)
        edge_types.extend(edges)
        if body.get("continuationUri"):
            path = body["continuationUri"]
        elif body.get("continuationToken"):
            path = _query(base, continuationToken=body["continuationToken"])
        else:
            return {"nodeTypes": node_types, "edgeTypes": edge_types}
    raise ValueError(f"Queryable graph type pagination exceeded {max_pages} pages")


def _labels(value: dict[str, Any]) -> list[str]:
    labels = value.get("labels")
    return [str(label) for label in labels] if isinstance(labels, list) else []


def _end(edge: dict[str, Any], end: str, by_alias: dict[str, str]) -> str:
    reference = edge.get(end)
    alias = str(reference.get("alias", "")) if isinstance(reference, dict) else ""
    return by_alias.get(alias, alias)


def describe(graph_type: dict[str, list[Any]]) -> dict[str, list[dict[str, Any]]]:
    """Labels a GQL query can use: node labels with their keys, and edge labels with the node labels they connect."""
    by_alias = {str(node["alias"]): "&".join(_labels(node)) for node in graph_type["nodeTypes"] if node.get("alias") is not None}
    nodes = [{"labels": _labels(node), "keys": list(node.get("primaryKeyProperties") or []),
              "properties": len(node.get("properties") or [])} for node in graph_type["nodeTypes"]]
    edges = [{"labels": _labels(edge), "from": _end(edge, "sourceNodeType", by_alias),
              "to": _end(edge, "destinationNodeType", by_alias)} for edge in graph_type["edgeTypes"]]
    nodes.sort(key=lambda node: node["labels"])
    edges.sort(key=lambda edge: (edge["labels"], edge["from"], edge["to"]))
    return {"nodeTypes": nodes, "edgeTypes": edges}


def status(fabric: FabricClient, ontology_name: str, graph_model_name: str | None = None) -> dict[str, Any]:
    result, hint = _resolve(fabric, ontology_name, graph_model_name)
    loaded = queryable_graph_type(fabric, result["graphModel"]["id"])
    if loaded is None:
        result.update(queryable=False, hint=hint)
    else:
        result.update(queryable=True, **describe(loaded))
    return result


def _error_code(error: ApiError) -> str:
    try:
        body = json.loads(error.body)
    except (TypeError, ValueError):
        return ""
    return str(body.get("errorCode", "")) if isinstance(body, dict) else ""


def query(fabric: FabricClient, ontology_name: str, gql: str, *, max_pages: int = 1000, graph_model_name: str | None = None) -> dict[str, Any]:
    result, hint = _resolve(fabric, ontology_name, graph_model_name)
    graph = result["graphModel"]
    try:
        rows = fabric.graph_execute_query(graph["id"], gql, max_pages=max_pages)
    except ApiError as error:
        if _error_code(error) == "GraphNotQueryable":
            raise GraphNotQueryable(f"The graph model {graph['name'] or graph['id']!r} is not queryable yet. {hint}") from error
        raise
    return {**result, "rowCount": len(rows["rows"]), **rows}
