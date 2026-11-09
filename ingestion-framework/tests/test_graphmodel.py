import json

import pytest

from ontology_ingest import graphmodel
from ontology_ingest.plan import EntityPlan, OntologyPlan, PropertyPlan

WS, LH = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"


def test_definition_maps_entity_types_relationships_and_property_types(small_plan):
    parts = graphmodel.build_graph_model_definition(small_plan, "Example graph", "desc", WS, LH)
    assert sorted(parts) == [".platform", "dataSources.json", "graphDefinition.json", "graphType.json", "stylingConfiguration.json"]
    assert json.loads(parts[".platform"])["metadata"]["type"] == "GraphModel"
    sources = json.loads(parts["dataSources.json"])
    assert sources["itemReferences"] == [{"name": "lakehouse", "item": {"workspaceId": WS, "itemId": LH}}]
    assert [source["properties"] for source in sources["dataSources"]] == [
        {"referenceName": "lakehouse", "path": "Tables/dbo/node"}, {"referenceName": "lakehouse", "path": "Tables/dbo/rel_part_of"}]
    graph_type = json.loads(parts["graphType.json"])
    node, edge = graph_type["nodeTypes"][0], graph_type["edgeTypes"][0]
    assert node["labels"] == ["O_Brien_Node"] and node["primaryKeyProperties"] == ["id"]
    assert node["properties"] == [{"name": "id", "type": "STRING"}, {"name": "count", "type": "INT"}, {"name": "label", "type": "STRING"}]
    assert edge["labels"] == ["part_of"] and edge["sourceNodeType"] == edge["destinationNodeType"] == {"alias": node["alias"]}
    mapping = json.loads(parts["graphDefinition.json"])["edgeTables"][0]
    assert mapping["dataSourceName"] == "rel_part_of" and mapping["edgeTypeAlias"] == edge["alias"]
    assert (mapping["sourceNodeKeyColumns"], mapping["destinationNodeKeyColumns"]) == (["source_id"], ["target_id"])


def test_names_that_collide_after_cleaning_are_rejected():
    def entity(name, table):
        return EntityPlan(name, table, properties=[PropertyPlan("id", "id", "string"), PropertyPlan("label", "label", "string")])
    plan = OntologyPlan(runId="r", entities=[entity("Well bore", "a"), entity("Well_bore", "b")])
    with pytest.raises(ValueError, match="would be shared"):
        graphmodel.build_graph_model_definition(plan, "G", "", WS, LH)


class FakeFabric:
    def __init__(self, counts, refresh="Completed"):
        self.counts, self.refresh, self.queries = list(counts), refresh, []

    def upsert_graph_model(self, name, parts, description):
        self.parts = parts
        return {"id": "graph-9"}

    def run_graph_refresh(self, graph_model_id):
        return {"status": self.refresh, "id": "job-1", "failureReason": {"message": "Graph is not initialized."}}

    def graph_execute_query(self, graph_model_id, query, max_pages=1000):
        self.queries.append(query)
        return {"rows": [{"c": self.counts.pop(0)}]}


@pytest.fixture
def loaded(monkeypatch):
    def from_definition(fabric, graph_model_id):
        return {key: value for key, value in json.loads(fabric.parts["graphType.json"]).items() if key != "$schema"}
    monkeypatch.setattr(graphmodel, "queryable_graph_type", from_definition)


def test_publish_reloads_then_checks_types_and_counts_against_the_plan(small_plan, loaded):
    fabric = FakeFabric([2, 1])
    result = graphmodel.publish_graph_model(fabric, small_plan, "G", "", WS, LH)
    expected = {"graphModelId": "graph-9", "nodes": 2, "edges": 1, "nodeTypes": 1, "edgeTypes": 1}
    assert {key: result[key] for key in expected} == expected
    assert fabric.queries == ["MATCH (n:`O_Brien_Node`) RETURN count(n) AS c",
                              "MATCH (:`O_Brien_Node`)-[e:`part_of`]->(:`O_Brien_Node`) RETURN count(e) AS c"]


def test_publish_fails_on_count_mismatch_and_explains_a_failed_first_refresh(small_plan, loaded):
    with pytest.raises(ValueError, match="part of edges 0 != 1"):
        graphmodel.publish_graph_model(FakeFabric([2, 0]), small_plan, "G", "", WS, LH)
    with pytest.raises(RuntimeError, match="Graph refresh Failed: Graph is not initialized.*opened once"):
        graphmodel.publish_graph_model(FakeFabric([], refresh="Failed"), small_plan, "G", "", WS, LH)
