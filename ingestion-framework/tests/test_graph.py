import json

import pytest

from ontology_ingest import cli, graph
from ontology_ingest.auth import StaticTokenProvider
from ontology_ingest.fabric import FabricClient
from ontology_ingest.http import ApiError, Response
from tests.fakes import FakeTransport, response

ONTOLOGY = {"id": "11111111-2222-4333-8444-555555555555", "type": "Ontology", "displayName": "geobasin_knowledge"}
GRAPH = {"id": "graph-1", "type": "GraphModel", "displayName": "geobasin_knowledge_graph_11111111222243338444555555555555"}
OTHER = {"id": "66666666-7777-4888-9999-aaaaaaaaaaaa", "type": "Ontology", "displayName": "geobasin_exploration"}
OTHER_GRAPH = {"id": "graph-2", "type": "GraphModel", "displayName": "geobasin_exploration_graph_66666666777748889999aaaaaaaaaaaa"}
NOT_QUERYABLE = {"requestId": "r", "errorCode": "GraphNotQueryable", "isRetriable": False,
                 "message": "The graph is not yet ready for querying. Wait for the initial load to complete."}


def client(fake):
    return FabricClient("ws", StaticTokenProvider("test-token"), transport=fake, sleep=lambda _: None)


def items(*values):
    return response({"value": list(values or (OTHER, OTHER_GRAPH, ONTOLOGY, GRAPH))})


def test_status_finds_the_ontologys_own_graph_and_reports_the_portal_step_before_materialization():
    fake = FakeTransport(items(), Response(204, {}, b""))
    result = graph.status(client(fake), "geobasin_knowledge")
    assert result["graphModel"] == {"id": "graph-1", "name": GRAPH["displayName"]}
    assert result["queryable"] is False and "Manage graph" in result["hint"]
    assert fake.requests[1].url == "https://api.fabric.microsoft.com/v1/workspaces/ws/graphModels/graph-1/getQueryableGraphType?beta=true"


def test_status_lists_node_and_edge_labels_across_pages():
    first = {"nodeTypes": [{"alias": "a", "labels": ["Wellbore"], "primaryKeyProperties": ["id"], "properties": [{"name": "id"}, {"name": "label"}]}],
             "edgeTypes": [], "continuationToken": "next/1"}
    second = {"nodeTypes": [{"alias": "b", "labels": ["Basin"], "primaryKeyProperties": ["id"], "properties": []}],
              "edgeTypes": [{"alias": "e", "labels": ["locatedIn_Wellbore_Basin"], "sourceNodeType": {"alias": "a"},
                             "destinationNodeType": {"alias": "b"}, "properties": []}]}
    fake = FakeTransport(items(), response(first), response(second))
    result = graph.status(client(fake), "geobasin_knowledge")
    assert result["queryable"] is True
    assert result["nodeTypes"] == [{"labels": ["Basin"], "keys": ["id"], "properties": 0},
                                   {"labels": ["Wellbore"], "keys": ["id"], "properties": 2}]
    assert result["edgeTypes"] == [{"labels": ["locatedIn_Wellbore_Basin"], "from": "Wellbore", "to": "Basin"}]
    assert fake.requests[2].url.endswith("getQueryableGraphType?beta=true&continuationToken=next%2F1")


def test_a_graph_model_of_another_ontology_is_never_used():
    with pytest.raises(ValueError, match="has no graph model"):
        graph.find_graph_model(client(FakeTransport(items(OTHER, OTHER_GRAPH, ONTOLOGY))), "geobasin_knowledge")


def test_status_uses_the_named_graph_model_and_its_own_hint_when_configured():
    named = {"id": "graph-3", "type": "GraphModel", "displayName": "geobasin_graph"}
    fake = FakeTransport(items(ONTOLOGY, GRAPH, named), Response(204, {}, b""))
    result = graph.status(client(fake), "geobasin_knowledge", "geobasin_graph")
    assert result == {"graphModel": {"id": "graph-3", "name": "geobasin_graph"}, "queryable": False, "hint": graph.GRAPH_MODEL_HINT}
    assert fake.requests[1].url.endswith("/graphModels/graph-3/getQueryableGraphType?beta=true")


def test_query_returns_rows_and_explains_graph_not_queryable_without_hiding_other_errors():
    page = {"status": {"code": "00000", "description": "ok"},
            "result": {"kind": "TABLE", "columns": [{"name": "well", "gqlType": "STRING"}], "data": [{"well": "Log Creek 1"}]}}
    fake = FakeTransport(items(), response(page))
    result = graph.query(client(fake), "geobasin_knowledge", "MATCH (w:Wellbore) RETURN w.label AS well LIMIT 1")
    assert result["rowCount"] == 1 and result["rows"] == [{"well": "Log Creek 1"}] and result["graphModel"]["id"] == "graph-1"
    assert fake.requests[1].json() == {"query": "MATCH (w:Wellbore) RETURN w.label AS well LIMIT 1"}
    with pytest.raises(graph.GraphNotQueryable, match="not queryable yet.*Manage graph"):
        graph.query(client(FakeTransport(items(), response(NOT_QUERYABLE, 400))), "geobasin_knowledge", "MATCH (n) RETURN n")
    with pytest.raises(ApiError) as caught:
        graph.query(client(FakeTransport(items(), response({"errorCode": "ItemNotFound"}, 404))), "geobasin_knowledge", "MATCH (n) RETURN n")
    assert not isinstance(caught.value, graph.GraphNotQueryable)


def test_cli_graph_exits_3_with_the_portal_step_when_the_graph_is_not_materialized(tmp_path, monkeypatch, capsys):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"workspace_id": "11111111-1111-1111-1111-111111111111", "lakehouse_name": "lh",
                                  "ontology_name": "geobasin_knowledge", "landing_root": "landing"}))
    query = tmp_path / "deepest.gql"
    query.write_text("MATCH (w:Wellbore) RETURN w.label AS well LIMIT 1")
    fake = FakeTransport(items(), response(NOT_QUERYABLE, 400))
    monkeypatch.setattr(cli, "FabricClient", lambda *args, **kwargs: client(fake))
    assert cli.main(["graph", "--config", str(config), "--query-file", str(query)]) == 3
    captured = capsys.readouterr()
    assert "Manage graph" in captured.err and not captured.out
    assert fake.requests[1].json() == {"query": "MATCH (w:Wellbore) RETURN w.label AS well LIMIT 1"}
    assert not (tmp_path / "output").exists()
