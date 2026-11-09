"""Offline tests of the scientist workflow: scripted models and a scripted register, no network."""
import json
from types import SimpleNamespace

import pytest

from gbx_scientists.contracts import AnswerDraft, Ask, Critique, FindingReport, Problem, Routing, Statement, Verdict, Verdicts
from gbx_scientists.host import as_person, required_of, ticket_of
from gbx_scientists.workflow import build_workflow

L1, L2, P1 = "L00000000a1", "L00000000a2", "P00000000b1"
EVIDENCE = {
    L1: {"id": L1, "label": "Marabooka 1 report, page 25", "text": "Top Toolachee 6326 ft below KB. Report KB elevation 181.9 ft."},
    L2: {"id": L2, "label": "Marabooka 1 report, page 31", "text": "The Toolachee Formation flowed gas on test."},
    P1: {"id": P1, "label": "Cooper guide, page 4", "text": "The Toolachee Formation is a Permian fluvial unit of the Cooper Basin."},
}


def fact(text: str, *cites: str, stance: str = "context") -> Statement:
    return Statement(kind="fact", stance=stance, text=text, cites=list(cites))


class FakeBrain:
    """Answers each role from a script: a list is consumed in order, a callable sees the prompt."""

    def __init__(self, **script):
        self.script, self.calls = script, []
        self.usage = {"input": 0, "output": 0, "total": 0, "runs": 0}

    async def ask(self, role, instructions, prompt, schema, *, tools=False, validator=False):
        self.calls.append(role)
        self.usage = {**self.usage, "input": self.usage["input"] + 100, "output": self.usage["output"] + 10, "total": self.usage["total"] + 110, "runs": self.usage["runs"] + 1}
        step = self.script[role]
        value = step.pop(0) if isinstance(step, list) else step(prompt) if callable(step) else step
        if isinstance(value, Exception):
            raise value
        assert isinstance(value, schema), f"{role} returned {type(value).__name__}, expected {schema.__name__}"
        assert tools == (role not in ("lead", "critic", "validator")), f"{role} tools={tools}"
        assert validator == (role == "validator")
        return value


class FakeEvidence:
    def __init__(self, records=EVIDENCE):
        self.records, self.reads = records, []

    async def read(self, ids):
        self.reads.append(ids)
        return {i: self.records[i] for i in ids if i in self.records}, [i for i in ids if i not in self.records]


def supported(n: int) -> Verdicts:
    return Verdicts(verdicts=[Verdict(statement=i, verdict="supported", reason="stated") for i in range(1, n + 1)])


def no_problem() -> Critique:
    return Critique(block=False, problems=[], missing=[])


async def run(brain, evidence=None, question="Where is the Toolachee top at Marabooka 1?", mode="copilot"):
    result = await build_workflow(brain, evidence or FakeEvidence()).run(Ask(question=question, mode=mode))
    outputs = result.get_outputs()
    assert len(outputs) == 1
    return json.loads(outputs[0])


@pytest.mark.asyncio
async def test_the_lead_chooses_specialists_and_the_others_stand_down():
    brain = FakeBrain(
        lead=[Routing(specialists=["stratigraphy", "literature"], reason="formation tops"),
              AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1), fact("The Toolachee Formation is a Permian fluvial unit.", P1)], missing=[])],
        literature=FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[]),
        stratigraphy=FindingReport(statements=[fact("The Toolachee Formation is a Permian fluvial unit.", P1)], missing=["unit ages from the ontology"]),
        critic=no_problem(), validator=supported(2))
    out = await run(brain)
    assert out["status"] == "answered" and len(out["sentences"]) == 2
    assert out["specialists"] == ["literature", "stratigraphy"]
    assert sorted(brain.calls) == sorted(["lead", "literature", "stratigraphy", "lead", "critic", "validator"])
    assert out["evidence_ids"] == [L1, P1] and out["tally"] is None


@pytest.mark.asyncio
async def test_a_blocked_draft_gets_one_rebuttal_then_passes():
    brain = FakeBrain(
        lead=[Routing(specialists=["literature"], reason="r"),
              AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB and it is oil-bearing.", L1)], missing=[]),
              AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1), fact("The Toolachee Formation flowed gas on test.", L2)], missing=[])],
        literature=FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1), fact("The Toolachee Formation flowed gas on test.", L2)], missing=[]),
        critic=[Critique(block=True, problems=[Problem(statement=1, problem="Statement 1 says oil-bearing, but L00000000a2 says gas.")], missing=[]), no_problem()],
        validator=supported(2))
    out = await run(brain)
    assert out["status"] == "answered" and [s["text"] for s in out["sentences"]][1] == "The Toolachee Formation flowed gas on test."
    assert brain.calls.count("critic") == 2 and brain.calls.count("lead") == 3
    assert out["rebutted"] and out["critique"] == ["Statement 1 says oil-bearing, but L00000000a2 says gas."]
    assert any("sent the first draft back (1 problem)" in n for n in out["notes"])
    assert out["usage"] == {"input": 700, "output": 70, "total": 770, "runs": 7}


@pytest.mark.asyncio
async def test_a_draft_still_blocked_as_a_whole_after_the_rebuttal_ends_with_the_dissent():
    problem = Critique(block=True, problems=[Problem(statement=0, problem="The draft leaves out L00000000a2, which contradicts it.")], missing=["a test report"])
    brain = FakeBrain(
        lead=[Routing(specialists=["literature"], reason="r")] + [AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[])] * 2,
        literature=FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[]),
        critic=[problem, problem], validator=supported(1))
    out = await run(brain)
    assert out["status"] == "blocked" and out["sentences"] == [] and out["dissent"] == ["The draft leaves out L00000000a2, which contradicts it."]
    assert "a test report" in out["missing"] and "validator" not in brain.calls
    assert out["rebutted"] and out["critique"] == ["The draft leaves out L00000000a2, which contradicts it."]


@pytest.mark.asyncio
async def test_a_statement_the_critic_still_rejects_after_the_rebuttal_is_removed_and_the_rest_validated():
    # The 8 November 2026 Honeysuckle Creek run: one true fact cited to the wrong survey's records blocked the whole answer.
    sentences = [fact("Top Toolachee 6326 ft below KB.", L1), fact("The Toolachee Formation flowed gas on test.", P1),
                 fact("The Toolachee Formation is a Permian fluvial unit.", P1)]
    problem = Critique(block=True, problems=[Problem(statement=2, problem="Statement 2 cites P00000000b1, which says nothing about a gas test.")], missing=[])
    prompts: list[str] = []

    def critic(prompt: str) -> Critique:
        prompts.append(prompt)
        return problem
    validated: list[str] = []

    def validator(prompt: str) -> Verdicts:
        validated.append(prompt)
        return supported(2)
    brain = FakeBrain(
        lead=[Routing(specialists=["literature"], reason="r")] + [AnswerDraft(answerable=True, sentences=sentences, missing=[])] * 2,
        literature=FindingReport(statements=sentences, missing=[]), critic=critic, validator=validator)
    out = await run(brain)
    assert '"number": 2' in prompts[0] and len(prompts) == 2
    assert out["status"] == "answered" and [s["text"] for s in out["sentences"]] == ["Top Toolachee 6326 ft below KB.", "The Toolachee Formation is a Permian fluvial unit."]
    assert "flowed gas" not in validated[0] and out["dissent"] == []
    assert out["removed"] == [{"text": "The Toolachee Formation flowed gas on test.", "by": "critic",
                               "why": "the critic still objected after the revision: Statement 2 cites P00000000b1, which says nothing about a gas test"}]
    assert any("still objected to 1 statement of the revision" in n for n in out["notes"])


@pytest.mark.asyncio
async def test_a_run_whose_chosen_specialists_all_failed_is_incomplete_not_not_found():
    brain = FakeBrain(lead=[Routing(specialists=["literature", "spatial"], reason="r")],
                      literature=[RuntimeError("429 Too Many Requests")], spatial=[RuntimeError("429 Too Many Requests")])
    out = await run(brain)
    assert out["status"] == "validation_incomplete" and out["sentences"] == []
    assert brain.calls.count("lead") == 1 and "critic" not in brain.calls and "validator" not in brain.calls
    assert "every chosen specialist failed, so nothing was searched or checked" in out["notes"]


@pytest.mark.asyncio
async def test_the_validator_removes_unsupported_numbers_unknown_evidence_and_partial_statements():
    sentences = [fact("Top Toolachee 6326 ft below KB.", L1), fact("Top Toolachee 6144 ft below sea level.", L1),
                 fact("The Toolachee Formation flowed gas on test.", L2), fact("The Toolachee Formation is a Permian fluvial unit.", P1)]
    brain = FakeBrain(
        lead=[Routing(specialists=["literature"], reason="r"), AnswerDraft(answerable=True, sentences=sentences, missing=[])],
        literature=FindingReport(statements=sentences, missing=[]), critic=no_problem(),
        validator=Verdicts(verdicts=[Verdict(statement=1, verdict="supported", reason="ok"), Verdict(statement=2, verdict="supported", reason="ok"),
                                     Verdict(statement=3, verdict="supported", reason="ok"), Verdict(statement=4, verdict="partial", reason="age only")]))
    # The register never saw L2, so its statement goes too.
    out = await run(brain, FakeEvidence({k: v for k, v in EVIDENCE.items() if k != L2}))
    assert out["status"] == "answered" and [s["text"] for s in out["sentences"]] == ["Top Toolachee 6326 ft below KB."]
    notes = " ".join(out["notes"])
    assert "6144 is not in its cited evidence" in notes and "never returned (L00000000a2)" in notes and "found it partial" in notes
    assert [(r["text"][:28], r["why"][:30]) for r in out["removed"]] == [
        ("Top Toolachee 6144 ft below ", "6144 is not in its cited evide"), ("The Toolachee Formation flow", "it cites evidence the run's to"),
        ("The Toolachee Formation is a", "the validator found it partial")]
    assert out["removed"][2]["why"] == "the validator found it partial: age only"


@pytest.mark.asyncio
async def test_validation_that_keeps_no_fact_or_fails_shows_nothing_unchecked():
    brain = FakeBrain(
        lead=[Routing(specialists=["literature"], reason="r"), AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[])],
        literature=FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[]), critic=no_problem(),
        validator=Verdicts(verdicts=[Verdict(statement=1, verdict="unsupported", reason="no")]))
    out = await run(brain)
    assert out["status"] == "validation_incomplete" and out["sentences"] == []
    failing = FakeBrain(
        lead=[Routing(specialists=["literature"], reason="r"), AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[])],
        literature=FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[]), critic=no_problem(), validator=[TimeoutError()])
    out = await run(failing)
    assert out["status"] == "validation_incomplete" and out["sentences"] == [] and "validation failed (TimeoutError)" in out["notes"]


@pytest.mark.asyncio
async def test_no_evidence_means_not_found_without_asking_the_lead_or_the_validator():
    brain = FakeBrain(lead=[Routing(specialists=["literature", "rock"], reason="r")],
                      literature=FindingReport(statements=[], missing=["no completion report for this well"]),
                      rock=[RuntimeError("tool server down")])
    out = await run(brain)
    assert out["status"] == "not_found" and "no completion report for this well" in out["missing"]
    assert brain.calls.count("lead") == 1 and "critic" not in brain.calls and "validator" not in brain.calls
    assert "the rock specialist failed (RuntimeError)" in out["notes"]


@pytest.mark.asyncio
async def test_the_lead_can_only_cite_what_the_specialists_found_and_routing_failure_falls_back():
    brain = FakeBrain(
        lead=[RuntimeError("router busy"),
              AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1), fact("An invented fact.", "Lfffffffff0")], missing=[])],
        literature=FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[]), critic=no_problem(), validator=supported(1))
    out = await run(brain)
    assert out["status"] == "answered" and len(out["sentences"]) == 1 and out["specialists"] == ["literature"]
    assert any("An invented fact" in n for n in out["notes"])


@pytest.mark.asyncio
async def test_co_scientist_mode_tallies_the_evidence_for_and_against():
    sentences = [fact("The Toolachee Formation flowed gas on test.", L2, stance="for"), fact("Top Toolachee 6326 ft below KB.", L1, stance="context")]
    brain = FakeBrain(lead=[Routing(specialists=["literature"], reason="r"), AnswerDraft(answerable=True, sentences=sentences, missing=["pressure data"])],
                      literature=FindingReport(statements=sentences, missing=[]), critic=no_problem(), validator=supported(2))
    out = await run(brain, question="The Toolachee Formation is a gas reservoir at Marabooka 1.", mode="coscientist")
    assert out["status"] == "answered" and out["tally"] == {"for": 1, "against": 0, "context": 1, "missing": 1}
    literature = next(f for f in out["findings"] if f["specialist"] == "literature")
    assert literature["chosen"] and [s["cites"] for s in literature["statements"]] == [[L2], [L1]]
    assert all(not f["chosen"] for f in out["findings"] if f["specialist"] != "literature")


def test_the_ticket_is_read_from_its_metadata_parts_only():
    request = SimpleNamespace(request={"metadata": {"gbx_ticket_0": "gbx1.abc", "gbx_ticket_1": ".def", "other": "x"}})
    assert ticket_of(request) == "gbx1.abc.def"
    assert ticket_of(SimpleNamespace(request={})) == ""


def test_fabric_iq_is_offered_only_for_a_run_the_app_started_as_the_person():
    assert as_person(SimpleNamespace(request={"metadata": {"gbx_identity": "person"}}))
    assert not as_person(SimpleNamespace(request={"metadata": {"gbx_identity": "app"}}))
    assert not as_person(SimpleNamespace(request={}))


@pytest.mark.asyncio
async def test_required_live_sources_come_from_the_metadata_and_reach_the_specialists():
    meta = {"gbx_required": json.dumps([{"id": "peps-sa-marabooka-1", "title": "Marabooka 1 well completion report"}, {"id": 7}])}
    required = required_of(SimpleNamespace(request={"metadata": meta}))
    assert required == ["Marabooka 1 well completion report (source peps-sa-marabooka-1)"]
    assert required_of(SimpleNamespace(request={"metadata": {"gbx_required": "not json"}})) == []
    seen = []

    def literature(prompt):
        seen.append(prompt)
        return FindingReport(statements=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[])

    brain = FakeBrain(lead=[Routing(specialists=["literature"], reason="well report"), AnswerDraft(answerable=True, sentences=[fact("Top Toolachee 6326 ft below KB.", L1)], missing=[])],
                      literature=literature, critic=no_problem(), validator=supported(1))
    result = await build_workflow(brain, FakeEvidence()).run(Ask(question="Where is the Toolachee top at Marabooka 1?", required=required))
    assert json.loads(result.get_outputs()[0])["status"] == "answered"
    assert "Required live sources: Marabooka 1 well completion report (source peps-sa-marabooka-1)" in seen[0]
    assert "can't stand in for them" in seen[0]
