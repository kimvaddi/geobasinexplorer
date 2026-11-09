"""Step 6: connect the generated ontology to a Microsoft Foundry agent through the Fabric IQ tool.

    python -m foundry_agent connect --config config/geobasin.json --foundry config/geobasin-foundry.json
    python -m foundry_agent agent   --config config/geobasin.json --foundry config/geobasin-foundry.json
    python -m foundry_agent ask     --config config/geobasin.json --foundry config/geobasin-foundry.json "Which Adavale Basin units are tight-gas reservoirs?"

The workspace and ontology come from the framework configuration; the Foundry settings come from their own file. The
connection is a RemoteTool connection that passes the signed-in user's Microsoft Entra token to the ontology's MCP
endpoint (authType UserEntraToken, audience Power BI), so every query runs with the caller's own Fabric permissions.
Questions run in background mode by default, because Foundry stops a synchronous MCP tool call after 100 seconds and an
ontology query can take longer; the ontology endpoint supports the MCP tasks capability that background mode needs.
Requires `pip install "azure-ai-projects>=2.2.0" azure-identity` and an Azure CLI sign-in.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import quote

ARM = "https://management.azure.com"
CONNECTION_API = "2025-10-01-preview"
POWER_BI = "https://analysis.windows.net/powerbi/api"
FOUNDRY_KEYS = ("subscriptionId", "resourceGroup", "account", "project", "connectionName", "agentName", "model")
# The account becomes the host name that receives the Azure AI token, so it must be a single DNS label; the other names
# become URL path segments and must each be one Azure resource name.
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")
_RESOURCE_NAME = re.compile(r"[\w.()-]{1,90}")

INSTRUCTIONS = """You are the GeoBasin ontology explorer. You answer questions about Australian sedimentary basins, wells,
rock units, play intervals, structures, stress and temperature measurements, documents and their sources by querying the
GeoBasin ontology through the Fabric IQ tool. Always query the ontology before answering; never answer from memory.
Pass the tool a focused request: the user's question in plain words, plus any interpretation you need it to apply. Do not
ask the tool for extra fields, explanations or formatting beyond what the question needs, because long requests make it slow.
In your answer, report numbers with their units exactly as the data gives them, name the entities you used, and say briefly
which relationships or properties the tool reported relying on. When asked for a dominant or most common category, leave
unknown or placeholder values (such as stress regime U or "not recorded") out unless the user asks for them. If the
ontology does not contain the information, say so plainly instead of guessing. When a question is ambiguous, state the
interpretation you used. Keep answers concise."""
POLL_SECONDS = 5
BACKGROUND_LIMIT_SECONDS = 1800


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would copy the Authorization header to the new location."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def az_token(resource: str) -> str:
    return subprocess.check_output(["az", "account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"], text=True).strip()


def load_config(framework_path: Path, foundry_path: Path) -> dict:
    """Combine the framework configuration (workspace and ontology) with the Foundry settings."""
    from ontology_ingest.cli import load_config as load_framework_config
    framework = load_framework_config(framework_path)
    f = json.loads(foundry_path.read_text(encoding="utf-8"))
    missing = [k for k in FOUNDRY_KEYS if not isinstance(f.get(k), str) or not f[k].strip()]
    if missing:
        raise SystemExit(f"{foundry_path} is missing: {', '.join(missing)}")
    validate_foundry(f)
    return {"workspaceId": framework.workspace_id, "ontologyName": framework.ontology_name, "foundry": f}


def validate_foundry(f: dict) -> None:
    try:
        uuid.UUID(f["subscriptionId"])
    except (TypeError, ValueError):
        raise SystemExit("subscriptionId must be a GUID") from None
    _account(f)
    for key in ("resourceGroup", "project", "connectionName", "agentName"):
        value = f[key]
        if not isinstance(value, str) or not _RESOURCE_NAME.fullmatch(value) or value.startswith(".") or value.endswith("."):
            raise SystemExit(f"{key} must be one name made of letters, digits, periods, underscores, hyphens or parentheses")


def _account(f: dict) -> str:
    account = f.get("account")
    if not isinstance(account, str) or not _DNS_LABEL.fullmatch(account):
        raise SystemExit("account must be the Foundry resource name: letters, digits and hyphens, at most 63 characters")
    return account


def _segment(value: str) -> str:
    return quote(value, safe="")


def ontology_endpoint(cfg: dict, ontology_id: str) -> str:
    return (f"https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/{_segment(cfg['workspaceId'])}"
            f"/items/{_segment(ontology_id)}/ontologyEndpoint")


def find_ontology_id(cfg: dict, fabric=None) -> str:
    """The ontology's item id, looked up through the framework's client, which follows every page of the item list."""
    if fabric is None:
        from ontology_ingest.auth import FABRIC_RESOURCE, AzureCliTokenProvider
        from ontology_ingest.fabric import FabricClient
        fabric = FabricClient(cfg["workspaceId"], AzureCliTokenProvider(FABRIC_RESOURCE))
    item = fabric.find_item(cfg["ontologyName"], "Ontology")
    if not item or not item.get("id"):
        raise SystemExit(f"ontology {cfg['ontologyName']!r} not found in workspace {cfg['workspaceId']}; run the framework first")
    return item["id"]


def connection_id(f: dict) -> str:
    return (f"/subscriptions/{f['subscriptionId']}/resourceGroups/{f['resourceGroup']}/providers/Microsoft.CognitiveServices"
            f"/accounts/{f['account']}/projects/{f['project']}/connections/{f['connectionName']}")


def connection_url(f: dict) -> str:
    return (f"{ARM}/subscriptions/{_segment(f['subscriptionId'])}/resourceGroups/{_segment(f['resourceGroup'])}"
            f"/providers/Microsoft.CognitiveServices/accounts/{_segment(_account(f))}/projects/{_segment(f['project'])}"
            f"/connections/{_segment(f['connectionName'])}?api-version={CONNECTION_API}")


def project_endpoint(f: dict) -> str:
    return f"https://{_account(f)}.services.ai.azure.com/api/projects/{_segment(f['project'])}"


def connect(cfg: dict) -> dict:
    f = cfg["foundry"]
    target = ontology_endpoint(cfg, find_ontology_id(cfg))
    # With UserEntraToken every caller still queries with their own Fabric permissions, so sharing grants no data access.
    shared = f.get("shareConnection", True)
    if not isinstance(shared, bool):
        raise SystemExit("shareConnection must be true or false")
    body = {"properties": {"category": "RemoteTool", "authType": "UserEntraToken", "target": target, "audience": POWER_BI, "isSharedToAll": shared,
                           "metadata": {"description": f"Fabric IQ ontology {cfg['ontologyName']} (ontology ingestion framework)"}}}
    req = urllib.request.Request(connection_url(f), data=json.dumps(body).encode(), method="PUT",
                                 headers={"Authorization": "Bearer " + az_token(ARM + "/"), "Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=120) as r:
            out = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"connection PUT failed with {e.code}: {e.read().decode(errors='replace')[:1000]}")
    props = out.get("properties", {})
    return {"connection": connection_id(f), "target": props.get("target"), "authType": props.get("authType"), "category": props.get("category")}


def _client(f: dict):
    from azure.ai.projects import AIProjectClient
    from azure.identity import AzureCliCredential
    return AIProjectClient(endpoint=project_endpoint(f), credential=AzureCliCredential())


def _latest_tools(project, agent_name: str) -> list[dict] | None:
    """Tools of the agent's latest version, or None when no agent of that name exists."""
    from azure.core.exceptions import ResourceNotFoundError
    try:
        details = project.agents.get(agent_name=agent_name).as_dict()
    except ResourceNotFoundError:
        return None
    return (((details.get("versions") or {}).get("latest") or {}).get("definition") or {}).get("tools") or []


def create_agent(cfg: dict, force: bool = False) -> dict:
    from azure.ai.projects.models import FabricIQPreviewTool, PromptAgentDefinition
    f = cfg["foundry"]
    tool = FabricIQPreviewTool(project_connection_id=connection_id(f), server_label=f.get("serverLabel", "geobasin-ontology"), require_approval="never")
    with _client(f) as project:
        tools = _latest_tools(project, f["agentName"])
        ours = tools is not None and any(t.get("type") == "fabric_iq_preview" and t.get("project_connection_id") == connection_id(f) for t in tools)
        if tools is not None and not ours and not force:
            raise SystemExit(f"agent {f['agentName']!r} already exists in project {f['project']} and is not wired to this ontology's "
                             "connection; refusing to add a version to it (use another agentName, or --force if you are sure)")
        agent = project.agents.create_version(agent_name=f["agentName"], definition=PromptAgentDefinition(
            model=f["model"], instructions=f.get("instructions") or INSTRUCTIONS, tools=[tool]))
        return {"agent": agent.name, "version": agent.version, "id": agent.id, "model": f["model"], "project": f["project"]}


def ask(cfg: dict, question: str, background: bool = True) -> dict:
    """Ask the agent. Background mode keeps long ontology queries alive past the 100-second synchronous MCP tool timeout."""
    f = cfg["foundry"]
    started = time.monotonic()
    with _client(f) as project, project.get_openai_client(agent_name=f["agentName"]) as openai:
        response = openai.responses.create(input=question, background=background)
        while getattr(response, "status", None) in ("queued", "in_progress"):
            if time.monotonic() - started > BACKGROUND_LIMIT_SECONDS:
                openai.responses.cancel(response.id)
                raise SystemExit(f"the agent did not finish within {BACKGROUND_LIMIT_SECONDS} seconds; the response was cancelled")
            time.sleep(POLL_SECONDS)
            response = openai.responses.retrieve(response.id)
        calls = [{"type": getattr(o, "type", ""), "name": getattr(o, "name", None), "server": getattr(o, "server_label", None),
                  "arguments": (getattr(o, "arguments", None) or "")[:600]} for o in (response.output or []) if getattr(o, "type", "") != "message"]
        error = getattr(response, "error", None)
        return {"question": question, "answer": response.output_text, "tool_calls": calls, "status": getattr(response, "status", None),
                "error": getattr(error, "message", None) if error else None, "seconds": round(time.monotonic() - started, 1),
                "mode": "background" if background else "synchronous"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m foundry_agent", description="Connect the ontology to a Foundry agent and query it.")
    ap.add_argument("command", choices=("connect", "agent", "ask"))
    ap.add_argument("question", nargs="?", help="question for the ask command")
    ap.add_argument("--config", type=Path, required=True, help="framework configuration (workspace and ontology)")
    ap.add_argument("--foundry", type=Path, required=True, help="Foundry settings (subscription, account, project, connection, agent, model)")
    ap.add_argument("--sync", action="store_true", help="ask without background mode (MCP tool calls then time out after 100 seconds)")
    ap.add_argument("--force", action="store_true", help="allow adding a version to an existing agent that is not wired to this ontology")
    args = ap.parse_intermixed_args(argv)
    cfg = load_config(args.config, args.foundry)
    if args.command == "connect":
        out = connect(cfg)
    elif args.command == "agent":
        out = create_agent(cfg, force=args.force)
    else:
        if not args.question:
            ap.error("ask needs a question")
        out = ask(cfg, args.question, background=not args.sync)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    if args.command == "ask" and (out.get("status") != "completed" or out.get("error")):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
