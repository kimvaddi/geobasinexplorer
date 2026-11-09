"""Step six: the Foundry module never follows redirects with a token, guards existing agents and validates its config."""
from __future__ import annotations

import json
import sys
import types
import urllib.request

import pytest

import foundry_agent.__main__ as fa
from ontology_ingest.auth import StaticTokenProvider
from ontology_ingest.fabric import FabricClient
from tests.fakes import FakeTransport, response

FOUNDRY = {"subscriptionId": "00000000-0000-0000-0000-000000000001", "resourceGroup": "rg", "account": "acct", "project": "proj",
           "connectionName": "conn", "agentName": "explorer", "model": "m"}


def test_token_bearing_requests_never_follow_redirects():
    req = urllib.request.Request("https://api.fabric.microsoft.com/v1/x", headers={"Authorization": "Bearer t"})
    assert fa._NoRedirect().redirect_request(req, None, 302, "Found", {}, "https://evil.example/") is None
    assert any(isinstance(h, fa._NoRedirect) for h in fa._OPENER.handlers)


@pytest.mark.parametrize("key, value", [("account", "outside.invalid/unused"), ("account", "evil.example"), ("account", "-acct"),
                                        ("subscriptionId", "s"), ("project", "proj/../../other"), ("connectionName", "conn?x=1"),
                                        ("resourceGroup", "rg#x"), ("agentName", ".")])
def test_foundry_settings_cannot_route_a_token_to_another_host_or_path(key, value):
    with pytest.raises(SystemExit, match=key):
        fa.validate_foundry({**FOUNDRY, key: value})


def test_hosts_and_paths_are_built_only_from_checked_names():
    with pytest.raises(SystemExit, match="account"):
        fa.project_endpoint({**FOUNDRY, "account": "outside.invalid/unused"})
    assert fa.project_endpoint(FOUNDRY) == "https://acct.services.ai.azure.com/api/projects/proj"
    assert fa.connection_url({**FOUNDRY, "project": "a/b"}).startswith(
        "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/"
        "Microsoft.CognitiveServices/accounts/acct/projects/a%2Fb/connections/conn?api-version=")


def test_the_ontology_lookup_follows_every_page_of_items():
    fake = FakeTransport(response({"value": [{"id": "lh", "type": "Lakehouse", "displayName": "onto"}], "continuationToken": "p2"}),
                         response({"value": [{"id": "ont-1", "type": "Ontology", "displayName": "onto"}]}))
    fabric = FabricClient("ws", StaticTokenProvider("t"), transport=fake, sleep=lambda _: None)
    assert fa.find_ontology_id({"workspaceId": "ws", "ontologyName": "onto"}, fabric) == "ont-1"
    assert len(fake.requests) == 2 and "continuationToken=p2" in fake.requests[1].url


def test_an_answer_that_did_not_complete_exits_nonzero(monkeypatch, capsys):
    monkeypatch.setattr(fa, "load_config", lambda framework, foundry: {"foundry": FOUNDRY})
    args = ["ask", "--config", "c.json", "--foundry", "f.json", "How deep is the Taroom Trough?"]
    monkeypatch.setattr(fa, "ask", lambda cfg, question, background=True: {"status": "failed", "error": "tool call timed out"})
    assert fa.main(args) == 1
    monkeypatch.setattr(fa, "ask", lambda cfg, question, background=True: {"status": "completed", "error": None})
    assert fa.main(args) == 0


class FakeAgents:
    def __init__(self, tools):
        self.tools, self.created = tools, []

    def get(self, agent_name):
        if self.tools is None:
            raise sys.modules["azure.core.exceptions"].ResourceNotFoundError("missing")
        return types.SimpleNamespace(as_dict=lambda: {"versions": {"latest": {"definition": {"tools": self.tools}}}})

    def create_version(self, agent_name, definition):
        self.created.append(definition)
        return types.SimpleNamespace(name=agent_name, version="2", id=agent_name + ":2")


@pytest.fixture
def fake_sdk(monkeypatch):
    models = types.ModuleType("azure.ai.projects.models")
    models.FabricIQPreviewTool = lambda **kw: {"type": "fabric_iq_preview", **kw}
    models.PromptAgentDefinition = lambda **kw: kw
    exceptions = types.ModuleType("azure.core.exceptions")
    exceptions.ResourceNotFoundError = type("ResourceNotFoundError", (Exception,), {})
    for name, module in {"azure": types.ModuleType("azure"), "azure.ai": types.ModuleType("azure.ai"),
                         "azure.ai.projects": types.ModuleType("azure.ai.projects"), "azure.ai.projects.models": models,
                         "azure.core": types.ModuleType("azure.core"), "azure.core.exceptions": exceptions}.items():
        monkeypatch.setitem(sys.modules, name, module)

    def install(tools):
        agents = FakeAgents(tools)
        project = types.SimpleNamespace(agents=agents, __enter__=None)

        class Ctx:
            def __enter__(self):
                return project

            def __exit__(self, *exc):
                return False
        monkeypatch.setattr(fa, "_client", lambda f: Ctx())
        return agents
    return install


def test_new_agent_and_our_own_agent_get_a_version(fake_sdk):
    cfg = {"foundry": dict(FOUNDRY)}
    agents = fake_sdk(None)
    assert fa.create_agent(cfg)["version"] == "2"
    tool = agents.created[0]["tools"][0]
    assert tool["project_connection_id"].endswith("/projects/proj/connections/conn") and tool["require_approval"] == "never"
    agents = fake_sdk([{"type": "fabric_iq_preview", "project_connection_id": fa.connection_id(cfg["foundry"])}])
    fa.create_agent(cfg)
    assert len(agents.created) == 1


def test_an_unrelated_existing_agent_is_not_overwritten(fake_sdk):
    cfg = {"foundry": dict(FOUNDRY)}
    agents = fake_sdk([{"type": "mcp", "server_label": "other"}])
    with pytest.raises(SystemExit, match="refusing"):
        fa.create_agent(cfg)
    assert not agents.created
    fa.create_agent(cfg, force=True)
    assert len(agents.created) == 1


def test_foundry_config_requires_every_setting(tmp_path, monkeypatch):
    framework = types.SimpleNamespace(workspace_id="ws", ontology_name="onto")
    monkeypatch.setattr("ontology_ingest.cli.load_config", lambda path: framework)
    path = tmp_path / "foundry.json"
    path.write_text(json.dumps({**FOUNDRY, "model": " "}))
    with pytest.raises(SystemExit, match="model"):
        fa.load_config(tmp_path / "framework.json", path)
    path.write_text(json.dumps(FOUNDRY))
    assert fa.load_config(tmp_path / "framework.json", path) == {"workspaceId": "ws", "ontologyName": "onto", "foundry": FOUNDRY}
