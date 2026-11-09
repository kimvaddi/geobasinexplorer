from __future__ import annotations

import os
import shutil
import socket
import subprocess
from pathlib import Path

import pytest

from ontology_ingest.plan import EntityPlan, OntologyPlan, PropertyPlan, RelationshipPlan


def pytest_configure(config):
    root = Path(__file__).parent / ".pytest-work"
    root.mkdir(exist_ok=True)
    config.option.basetemp = str(root / str(os.getpid()))


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(session.config.option.basetemp, ignore_errors=True)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Tests must not open network connections")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    original_popen = subprocess.Popen

    def no_azure_cli(args, *positional, **kwargs):
        if isinstance(args, (list, tuple)) and args and Path(args[0]).name == "az":
            raise AssertionError("Tests must not acquire live Azure CLI tokens")
        return original_popen(args, *positional, **kwargs)
    monkeypatch.setattr(subprocess, "Popen", no_azure_cli)


@pytest.fixture
def small_plan():
    return OntologyPlan(runId="golden", createdAt="2026-01-01T00:00:00+00:00", entities=[
        EntityPlan("O'Brien Node", "node", description="A node.\nA second description line.", synonyms=["Test node", "vertex"], rowCount=2,
                   properties=[PropertyPlan("id", "id", "string", "The unique key."),
                               PropertyPlan("label", "label", "string", "The display name."),
                               PropertyPlan("count", "count", "int64", "An observation count.")])],
        relationships=[RelationshipPlan("part of", "part of", "O'Brien Node", "O'Brien Node", "rel_part_of",
                                         description="Connect a node to its parent.", synonyms=["parent link"], edgeCount=1)])
