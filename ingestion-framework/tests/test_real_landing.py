"""Read-only integration against the supplied, real geology producer output."""
import csv
import hashlib
import json
import os
import shutil
from pathlib import Path

import pytest

from ontology_ingest.delta import InMemoryWriter
from ontology_ingest.plan import OntologyPlan
from ontology_ingest.prepare import run
from ontology_ingest.storage import LocalFolder
from ontology_ingest.tmdl import build_definition, to_api_definition, verify_definition


def test_real_fabric_iq_kit_end_to_end_in_memory(tmp_path):
    default = Path(__file__).resolve().parents[3] / "GeoBasin_Explorer_AI_DATA_BUNDLE/processed/geology/fabric-iq-kit"
    source = Path(os.environ.get("ONTOLOGY_INGEST_REAL_LANDING", str(default)))
    if not source.is_dir():
        pytest.skip("Set ONTOLOGY_INGEST_REAL_LANDING to the real fabric-iq-kit folder")
    inputs = sorted(list((source / "entities").glob("*.csv")) + list((source / "relationships").glob("*.csv")))
    fingerprints = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
    copied = tmp_path / "landing/geology"
    shutil.copytree(source / "entities", copied / "entities")
    shutil.copytree(source / "relationships", copied / "relationships")
    if (source / "dataset.json").exists():
        shutil.copyfile(source / "dataset.json", copied / "dataset.json")
    writer = InMemoryWriter()
    reports = LocalFolder(tmp_path / "reports")
    summary = run(LocalFolder(tmp_path / "landing"), writer, "real-kit", output=reports)
    plan = OntologyPlan.from_json(reports.read_bytes(summary["planPath"]))
    quality = json.loads(reports.read_bytes(summary["qualityPath"]))
    ids = {}
    for path in (copied / "entities").glob("*.csv"):
        with path.open(encoding="utf-8-sig", newline="") as stream:
            ids[path.stem] = {row["id"].strip() for row in csv.DictReader(stream) if row["id"].strip()}
    assert summary["entityRows"] == sum(map(len, ids.values()))
    assert len(plan.entities) == len(ids) == 12
    source_edges = set()
    for path in (copied / "relationships").glob("*.csv"):
        with path.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                source_edges.add((path.stem, row["source_type"].strip(), row["source_id"].strip(), row["target_type"].strip(), row["target_id"].strip()))
    valid = {edge for edge in source_edges if edge[2] in ids.get(edge[1], set()) and edge[4] in ids.get(edge[3], set())}
    assert summary["edges"] == len(valid)
    assert summary["edges"] + summary["quarantinedEdges"] == len(source_edges)
    for name in ("isPartOf", "partOfPanel"):
        relation = next(rel for rel in plan.relationships if rel.name == name)
        assert relation.fromEntity == relation.toEntity and relation.edgeCount > 0
        assert writer.count_rows(plan.bindingSchema, relation.table) == relation.edgeCount
    for relation, pairs in (("belongsToBasin", 2), ("locatedIn", 2), ("describes", 2), ("tests", 4)):
        splits = [rel for rel in plan.relationships if rel.relation == relation]
        assert len(splits) == pairs
        assert all(rel.name == f"{relation}_{rel.fromEntity}_{rel.toEntity}" for rel in splits)
        assert all(rel.edgeCount > 0 for rel in splits)
    derived = [prop for entity in plan.entities for prop in entity.properties if prop.derivedFrom]
    assert derived and {"m", "km2", "Ma"} <= {prop.unit for prop in derived}
    for entity in plan.entities:
        data = writer.tables[plan.bindingSchema, entity.table]
        for prop in entity.properties:
            if prop.derivedFrom:
                assert any(row[prop.name] is not None and isinstance(row[prop.derivedFrom], str) for row in data.to_pylist())
    parts = build_definition(plan, "Real landing test", "Offline integration only.", "endpoint.invalid", "sql-id")
    assert verify_definition(plan, parts)["entities"] == 12
    assert parts["relationships.tmdl"].count("\tisActive: false\n") == 2
    assert len(to_api_definition(parts)["parts"]) == len(parts)
    assert not quality["castErrors"]
    assert fingerprints == {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
