import pytest

from ontology_ingest.pipeline import build_copy_pipeline, build_ingest_pipeline

SETTINGS = {"framework_zip": "_framework/abc/ontology_ingest.zip", "framework_hash": "abc", "ontology_name": "Test",
            "ontology_description": "", "raw_schema": "raw", "binding_schema": "dbo", "publish_mode": "staged",
            "retain_runs": "2", "graph_model_name": "Test graph", "graph_model_description": ""}
RAW_SCHEMA = "@concat('raw', '_', pipeline().parameters.run_id)"


def _by_name(activities):
    return {activity["name"]: activity for activity in activities}


def test_ingest_pipeline_copies_every_dataset_folder_then_runs_the_notebooks_in_order():
    content = build_ingest_pipeline("ws", "lh", copy_pipeline_id="copy-id",
                                    notebooks={"prepare": "nb-p", "generate": "nb-g", "graph": "nb-q"}, settings=SETTINGS)
    activities = content["properties"]["activities"]
    assert [activity["type"] for activity in activities] == [
        "IfCondition", "GetMetadata", "Filter", "ForEach", "TridentNotebook", "TridentNotebook", "TridentNotebook"]
    each = _by_name(activities)["Copy each dataset"]["typeProperties"]
    child = each["activities"][0]["typeProperties"]
    assert child["pipeline"] == {"referenceName": "copy-id", "type": "PipelineReference"} and child["waitOnCompletion"]
    assert child["parameters"]["dataset"]["value"] == "@item().name"
    assert child["parameters"]["raw_schema"]["value"] == RAW_SCHEMA
    notebooks = activities[4:]
    assert [activity["typeProperties"]["notebookId"] for activity in notebooks] == ["nb-p", "nb-g", "nb-q"]
    assert [activity["dependsOn"][0]["activity"] for activity in notebooks] == [
        "Copy each dataset", "Expand JSON and build tables", "Create ontology and bindings"]
    parameters = notebooks[0]["typeProperties"]["parameters"]
    assert parameters["raw_tables_schema"]["value"] == {"value": RAW_SCHEMA, "type": "Expression"}
    assert parameters["raise_errors"] == {"value": "true", "type": "string"}
    assert parameters["framework_hash"] == {"value": "abc", "type": "string"}


def test_an_in_place_pipeline_copies_into_the_base_raw_schema_and_skips_an_unnamed_graph():
    content = build_ingest_pipeline("ws", "lh", copy_pipeline_id="copy-id", notebooks={"prepare": "nb-p", "generate": "nb-g"},
                                    settings=dict(SETTINGS, publish_mode="in_place"))
    activities = _by_name(content["properties"]["activities"])
    assert "Build graph model" not in activities
    child = activities["Copy each dataset"]["typeProperties"]["activities"][0]["typeProperties"]
    assert child["parameters"]["raw_schema"]["value"] == "raw"
    with pytest.raises(ValueError):
        build_ingest_pipeline("ws", "lh", copy_pipeline_id="c", notebooks={}, settings=dict(SETTINGS, raw_schema="Raw Schema"))


def test_copy_pipeline_skips_a_missing_folder_and_overwrites_each_table_in_place():
    activities = _by_name(build_copy_pipeline("ws", "lh")["properties"]["activities"])
    for label in ("entity", "relationship"):
        assert activities[f"List {label} files"]["typeProperties"]["fieldList"] == ["exists", "childItems"]
        # GetMetadata omits childItems for a missing folder; ?. turns that into null instead of an expression error.
        assert "output?.childItems" in activities[f"Keep {label} CSV files"]["typeProperties"]["items"]["value"]
        copy = activities[f"Copy {label} files"]["typeProperties"]["activities"][0]["typeProperties"]
        # The documented value; an undocumented "Overwrite" left a <table>_backup_<guid> copy beside every rewritten table.
        assert copy["sink"]["tableActionOption"] == "OverwriteSchema"
        assert copy["sink"]["datasetSettings"]["typeProperties"]["schema"]["value"] == "@pipeline().parameters.raw_schema"
