"""Hosts the scientists as a Foundry hosted agent through the Responses protocol (docs/FOUNDRY_AGENTS.md).

The workflow is hosted natively, with a request-aware factory that builds a fresh graph, fresh clients and fresh MCP
connections for every request, as Microsoft Learn requires when an integration carries request identity (Foundry Hosted
Agents with Agent Framework). The app sends the question as the input text and the run ticket in the request metadata,
split over the keys gbx_ticket_0 to gbx_ticket_3 because a metadata value holds at most 512 characters; the ticket only
ever becomes a header on the tool server calls, and no model sees it. GBX_SCIENTIST_MODE makes this package gbx-copilot or
gbx-coscientist.
"""
import json

from azure.identity import DefaultAzureCredential, get_bearer_token_provider

from agent_framework_foundry_hosting import CheckpointStoreProvider, HostedResponseRequest, ResponsesHostServer, WorkflowTurn

from .contracts import CHECKPOINT_TYPES, Ask
from .ports import FabricIq, FoundryBrain, McpEvidence, ToolFactory
from .settings import Settings
from .workflow import build_workflow

TICKET_PARTS = 4
_credential: DefaultAzureCredential | None = None


def ticket_of(request: HostedResponseRequest) -> str:
    metadata = request.request.get("metadata") or {}
    return "".join(str(metadata.get(f"gbx_ticket_{i}") or "") for i in range(TICKET_PARTS))


def required_of(request: HostedResponseRequest) -> list[str]:
    """The live documents the app says the answer must cite, from the metadata key gbx_required, as "title (source id)"."""
    metadata = request.request.get("metadata") or {}
    try:
        items = json.loads(str(metadata.get("gbx_required") or "[]"))
    except ValueError:
        return []
    if not isinstance(items, list):
        return []
    return [f"{i['title'][:160]} (source {i['id'][:60]})" for i in items
            if isinstance(i, dict) and isinstance(i.get("id"), str) and isinstance(i.get("title"), str) and i["id"] and i["title"]][:8]


def as_person(request: HostedResponseRequest) -> bool:
    """True when the app started this run with the person's own token (metadata gbx_identity), so Fabric IQ can act as them;
    a run the app started with its own identity uses the typed knowledge tools."""
    metadata = request.request.get("metadata") or {}
    return str(metadata.get("gbx_identity") or "") == "person"


def _shared_credential() -> DefaultAzureCredential:
    # The hosted agent's own identity, the same for every request, so one credential and its token cache serve them all.
    global _credential
    if _credential is None:
        _credential = DefaultAzureCredential()
    return _credential


def build(request: HostedResponseRequest):
    settings = Settings.from_env()
    credential = _shared_credential()
    token = get_bearer_token_provider(credential, f"{settings.tool_audience}/.default") if settings.tool_audience else None
    tools = ToolFactory(settings, ticket_of(request), token)
    fabric = FabricIq(settings, credential, tools) if settings.toolbox_url and as_person(request) else None
    return build_workflow(FoundryBrain(settings, credential, tools, fabric), McpEvidence(tools))


async def parse_response(request: HostedResponseRequest) -> WorkflowTurn[Ask]:
    text = (await request.get_input_text() or "").strip()
    return WorkflowTurn(input=Ask(question=text[:4000], mode=Settings.from_env().mode, required=required_of(request)))


def main() -> None:
    allowed = [f"{t.__module__}:{t.__qualname__}" for t in CHECKPOINT_TYPES]
    ResponsesHostServer(workflow=build, parse_response=parse_response, checkpoint_store_provider=CheckpointStoreProvider(allowed_checkpoint_types=allowed)).run()


if __name__ == "__main__":
    main()
