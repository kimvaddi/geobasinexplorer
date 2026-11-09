"""Settings for the scientists, read from the environment. Foundry's hosting platform sets FOUNDRY_PROJECT_ENDPOINT for a
hosted agent; the rest come from the agent definition (agent.yaml) or, for a local run, from the shell."""
import os
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Settings:
    project_endpoint: str
    tool_url: str
    router: str = "gbx2-router"
    validator: str = "gbx2-validator"
    # The specialists' own deployment, empty for the lead's router; a Cost-mode router can be tried here alone
    # (Microsoft Learn, How model router works: change one routing lever at a time).
    specialist: str = ""
    # The toolbox gbx-knowledge's MCP endpoint, through which the specialists ask Fabric IQ as the person;
    # empty leaves them on the typed knowledge tools. Fabric IQ's ontology endpoint answers synchronously, in 16 to 63
    # seconds on 8 November 2026, so a question that takes longer falls back to the typed tools.
    toolbox_url: str = ""
    fabric_iq_seconds: float = 75
    tool_audience: str = ""
    mode: Literal["copilot", "coscientist"] = "copilot"
    step_seconds: float = 90
    tool_step_seconds: float = 150

    @classmethod
    def from_env(cls) -> "Settings":
        mode = os.environ.get("GBX_SCIENTIST_MODE", "copilot")
        if mode not in ("copilot", "coscientist"):
            raise ValueError("GBX_SCIENTIST_MODE must be copilot or coscientist")
        return cls(project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"], tool_url=os.environ["GBX_TOOL_SERVER_URL"],
                   router=os.environ.get("GBX_ROUTER_DEPLOYMENT", "gbx2-router"), validator=os.environ.get("GBX_VALIDATOR_DEPLOYMENT", "gbx2-validator"),
                   specialist=os.environ.get("GBX_SPECIALIST_DEPLOYMENT", ""), toolbox_url=os.environ.get("GBX_TOOLBOX_URL", ""),
                   fabric_iq_seconds=float(os.environ.get("GBX_FABRIC_IQ_SECONDS") or 75),
                   tool_audience=os.environ.get("GBX_TOOL_AUDIENCE", ""), mode=mode)  # type: ignore[arg-type]
