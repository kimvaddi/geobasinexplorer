"""The Foundry brain's wrap-up, and Fabric IQ asked as the person with the typed knowledge tools as its fallback."""
import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from agent_framework import Content, Message

from gbx_scientists.contracts import FindingReport, Statement
from gbx_scientists.ports import FABRIC_IQ_RECORD, FABRIC_IQ_TOOL, KNOWLEDGE_TOOLS, FabricIq, FoundryBrain
from gbx_scientists.settings import Settings

EVIDENCE = '[{"id": "P00000000b1", "label": "Cooper guide, page 4", "text": "The Toolachee Formation is a Permian fluvial unit."}]'
REPORT = FindingReport(statements=[Statement(kind="fact", stance="context", text="The Toolachee Formation is a Permian fluvial unit.", cites=["P00000000b1"])], missing=[])


class FakeAgent:
    calls: list = []

    def __init__(self, client, name, instructions):
        pass

    async def run(self, prompt, tools=None, options=None):
        FakeAgent.calls.append((prompt, tools))
        if tools:  # the tool-call limit stops the run before any report is written
            return SimpleNamespace(value=None, text="", messages=[Message("tool", [Content.from_function_result(call_id="c1", result=EVIDENCE)])],
                                   usage_details={"input_token_count": 900, "output_token_count": 50, "total_token_count": 950})
        return SimpleNamespace(value=None, text=REPORT.model_dump_json(), messages=[], usage_details={"input_token_count": 400, "output_token_count": 80})


class FakeTool:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_a_tool_run_without_a_report_gets_one_wrap_up_from_its_own_evidence(monkeypatch):
    monkeypatch.setattr("agent_framework.Agent", FakeAgent)
    FakeAgent.calls = []
    brain = object.__new__(FoundryBrain)
    brain.router = brain.grok = brain.specialists = object()
    brain.tools, brain.settings, brain.trace = (lambda allowed: FakeTool()), Settings(project_endpoint="x", tool_url="y"), []
    brain.usage = {"input": 0, "output": 0, "total": 0, "runs": 0}
    report = await brain.ask("literature", "instructions", "Where is the Toolachee?", FindingReport, tools=True)
    assert report == REPORT
    assert len(FakeAgent.calls) == 2 and FakeAgent.calls[1][1] is None
    assert "P00000000b1" in FakeAgent.calls[1][0] and "tool budget is used" in FakeAgent.calls[1][0]
    assert brain.usage == {"input": 1300, "output": 130, "total": 1430, "runs": 2}


class FakeToolbox:
    """Fabric IQ behind the toolbox: answers, fails or takes its time."""

    def __init__(self, answer="", error=None, delay=0.0):
        self.answer, self.error, self.delay, self.calls = answer, error, delay, []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def call_tool(self, tool_name, **arguments):
        self.calls.append((tool_name, arguments))
        await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.answer


class FakeServer(FakeTool):
    """The tool server through the run's MCP connection: record_fabric_iq and the typed knowledge tools."""

    def __init__(self, withheld=False):
        self.withheld, self.calls, self.allowed = withheld, [], []

    def __call__(self, allowed):
        self.allowed.append(list(allowed))
        return self

    async def call_tool(self, tool_name, **arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == FABRIC_IQ_RECORD:
            return json.dumps({"notice": "withheld", "records": []} if self.withheld else {"records": [{"id": "K0123456789", "label": "Fabric IQ: q", "text": "t"}]})
        if arguments.get("name") == "Innamincka 1":
            return json.dumps({"records": []})
        return json.dumps({"records": [{"id": f"K{len(self.calls):010d}", "label": f"Knowledge graph: {tool_name}", "text": "t"}]})


SETTINGS = Settings(project_endpoint="x", tool_url="y", toolbox_url="https://aif.example/toolboxes/gbx-knowledge/versions/1/mcp")
ANSWER = "The Toolachee Formation spans 257.7 to 252.5 Ma, sandstone with coal, fluviolacustrine."


@pytest.mark.asyncio
async def test_fabric_iq_answers_are_registered_once_and_shared_by_specialists_asking_the_same_question():
    toolbox, server = FakeToolbox(ANSWER, delay=0.01), FakeServer()
    fabric = FabricIq(SETTINGS, None, server, toolbox=lambda: toolbox)
    first, second = await asyncio.gather(fabric.ask("What does the graph record for the Toolachee Formation?"),
                                         fabric.ask("  what does the graph record for the  Toolachee Formation? "))
    assert first == second and json.loads(first)["records"][0]["id"] == "K0123456789"
    assert toolbox.calls == [(FABRIC_IQ_TOOL, {"request": "What does the graph record for the Toolachee Formation?"})]
    assert server.allowed == [[FABRIC_IQ_RECORD]] and server.calls == [(FABRIC_IQ_RECORD, {"question": "What does the graph record for the Toolachee Formation?", "answer": ANSWER})]
    report = fabric.report()
    assert (report["asked"], report["answered"], report["fallback"], report["typed"]) == (1, 1, "", 0)


@pytest.mark.asyncio
async def test_a_failing_slow_refused_or_spent_fabric_iq_hands_the_question_to_the_typed_tools_for_the_names_it_gave():
    server = FakeServer()
    failing = FabricIq(SETTINGS, None, server, toolbox=lambda: FakeToolbox(error=RuntimeError("403 Forbidden")))
    out = json.loads(await failing.ask("Which plays does the Cooper Basin hold?", {"basin": "Cooper Basin"}))
    assert "notice" not in out and len(out["records"]) == 2
    assert server.calls == [("knowledge_basin", {"name": "Cooper Basin"}), ("knowledge_play", {"basin": "Cooper Basin"})]
    assert server.allowed == [KNOWLEDGE_TOOLS] and failing.report()["fallback"] == "RuntimeError" and failing.report()["typed"] == 2
    server = FakeServer()
    slow = FabricIq(replace(SETTINGS, fabric_iq_seconds=0.05), None, server, toolbox=lambda: FakeToolbox(ANSWER, delay=1))
    out = json.loads(await slow.ask("How old is the Toolachee Formation?", {"unit": "Toolachee Formation", "basin": "Cooper Basin"}))
    assert len(out["records"]) == 1 and slow.report()["fallback"] == "TimeoutError"
    assert server.calls == [("knowledge_unit", {"name": "Toolachee Formation", "basin": "Cooper Basin"})]
    server = FakeServer(withheld=True)
    withheld = FabricIq(SETTINGS, None, server, toolbox=lambda: FakeToolbox("Innamincka 1 reached 3,000 m."))
    out = json.loads(await withheld.ask("How deep is Innamincka 1?", {"well": "Innamincka 1"}))
    assert out["records"] == [] and "reuse terms aren't confirmed" in out["notice"]
    assert (withheld.report()["answered"], withheld.report()["fallback"]) == (0, "withheld")
    toolbox, server = FakeToolbox(ANSWER), FakeServer()
    limited = FabricIq(SETTINGS, None, server, toolbox=lambda: toolbox, limit=1)
    await limited.ask("First question about the Cooper Basin?")
    out = json.loads(await limited.ask("Which plays does the Patchawarra hold?", {"play": "Patchawarra Play"}))
    assert len(toolbox.calls) == 1 and len(out["records"]) == 1 and server.calls[-1] == ("knowledge_play", {"name": "Patchawarra Play"})
    nothing = FabricIq(SETTINGS, None, FakeServer(), toolbox=lambda: FakeToolbox(error=RuntimeError("down")))
    assert "named no basin, unit, well or play" in json.loads(await nothing.ask("What is in the graph?"))["notice"]


@pytest.mark.asyncio
async def test_where_fabric_iq_is_offered_the_typed_tools_are_its_fallback_only(monkeypatch):
    monkeypatch.setattr("agent_framework.Agent", FakeAgent)
    for fabric, names, typed in ((None, [], True), (FabricIq(SETTINGS, None, FakeServer(), toolbox=lambda: FakeToolbox(ANSWER)), ["ask_knowledge_graph"], False)):
        FakeAgent.calls, allowed = [], []
        brain = object.__new__(FoundryBrain)
        brain.router = brain.grok = brain.specialists = object()
        brain.tools, brain.settings, brain.trace, brain.fabric = (lambda a: allowed.append(a) or FakeTool()), SETTINGS, [], fabric
        brain.usage = {"input": 0, "output": 0, "total": 0, "runs": 0}
        await brain.ask("literature", "instructions", "Which plays?", FindingReport, tools=True)
        assert [t.name for t in FakeAgent.calls[0][1][1:]] == names
        assert all(t in allowed[0] for t in KNOWLEDGE_TOOLS) == typed and "search_live_evidence" in allowed[0]


def test_the_toolbox_waits_as_long_as_fabric_iq_may_take(monkeypatch):
    seen = {}
    monkeypatch.setattr("agent_framework.foundry.FoundryToolbox", lambda credential, **kwargs: seen.update(kwargs) or object())
    from gbx_scientists.ports import _foundry_toolbox
    _foundry_toolbox(None, SETTINGS.toolbox_url, SETTINGS.fabric_iq_seconds)
    assert seen["request_timeout"] > SETTINGS.fabric_iq_seconds and seen["timeout"] > SETTINGS.fabric_iq_seconds
    assert seen["tool_result_content"] == "content_first"


def test_fabric_iq_answers_lose_their_closing_offers_of_more_help():
    from gbx_scientists.ports import answer_text
    raw = "For the Toolachee Formation the graph records 257.7 to 252.5 Ma.\n\n- Lithology: sandstone with coal\n\nIf you want, I can also compare it with another formation."
    assert answer_text(raw) == "For the Toolachee Formation the graph records 257.7 to 252.5 Ma.\n\n- Lithology: sandstone with coal"
    assert answer_text("Would you like more?") == ""
