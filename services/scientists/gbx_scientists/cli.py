"""Runs the scientists once on this computer against the version 2 models and a tool server, and prints the result.

    export FOUNDRY_PROJECT_ENDPOINT=https://<foundry-account>.services.ai.azure.com/api/projects/<project>
    export GBX_TOOL_SERVER_URL=http://127.0.0.1:8787/api/mcp
    python -m gbx_scientists --ticket "$TICKET" "Which formations hold gas in the Cooper Basin?"
    python -m gbx_scientists --ticket "$TICKET" --mode coscientist "The Toolachee Formation is a gas reservoir at Marabooka 1."

Sign in with the Azure CLI first; the operator needs Foundry User on the version 2 account. A local tool server and its
ticket come from services/api (GBX_TOOL_SERVER=on, and scripts/v2-dev-ticket.ts).
"""
import argparse
import asyncio
import json
import os
import time
from dataclasses import replace

from azure.identity import AzureCliCredential

from .contracts import Ask
from .ports import FoundryBrain, McpEvidence, ToolFactory
from .settings import Settings
from .workflow import build_workflow


async def run(question: str, mode: str, ticket: str) -> dict:
    settings = replace(Settings.from_env(), mode=mode)  # type: ignore[arg-type]
    tools = ToolFactory(settings, ticket)
    brain = FoundryBrain(settings, AzureCliCredential(), tools)
    started = time.monotonic()
    outcome = await build_workflow(brain, McpEvidence(tools)).run(Ask(question=question, mode=mode))  # type: ignore[arg-type]
    outputs = outcome.get_outputs()
    return {"seconds": round(time.monotonic() - started, 1), "steps": brain.trace, "result": json.loads(outputs[-1]) if outputs else None}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("question")
    p.add_argument("--mode", choices=["copilot", "coscientist"], default=os.environ.get("GBX_SCIENTIST_MODE", "copilot"))
    p.add_argument("--ticket", default=os.environ.get("GBX_RUN_TICKET", ""), help="a run ticket the tool server accepts")
    a = p.parse_args()
    print(json.dumps(asyncio.run(run(a.question, a.mode, a.ticket)), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
