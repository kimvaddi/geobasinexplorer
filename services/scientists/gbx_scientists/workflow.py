"""The scientist workflow (docs/FOUNDRY_AGENTS.md, The workflow), a custom Microsoft Agent Framework graph:

    lead-route -> every specialist (fan-out) -> lead-draft (fan-in) -> critic -> validator -> finish
                                                                    critic -> lead-rebuttal -> critic (once)
                                                                    critic -> finish (still blocked: the dissent)

The lead's choice of specialists travels in the plan, and a specialist it didn't choose stands down without calling a
model. A multi-selection edge would send the plan to the chosen ones only, but in Agent Framework 1.25 a fan-in edge then
waits for the others and the run ends with no output (tested 8 November 2026), so every specialist hears the plan.
The critic numbers each problem with the statement it concerns. When it still objects after the lead's one revision, the
statements it names are removed with its reason and the rest go on to the validator, as the validator removes the
statements it can't confirm; only a problem with the draft as a whole, or one that leaves no fact standing, still blocks
it. The validator's step reads the cited records from the run's register on the tool server, removes any statement whose
citations, numbers or verdict fail, as version 1 removes failed sentences, and answers "Validation incomplete" rather
than show an unchecked answer. A run whose chosen specialists all failed is "Validation incomplete" too, never "Not
found", because nothing was searched.
"""
import json
import time
from typing import Never

from agent_framework import Executor, Workflow, WorkflowBuilder, WorkflowContext, handler

from .checks import clean_statements, title_of, unsupported_numbers
from .contracts import (SPECIALISTS, AnswerDraft, Ask, Critique, Draft, Finding, FindingReport, FindingSummary, Plan, Problem, RebuttalRequest, Result,
                        Reviewed, Routing, Statement, Verdicts)
from .ports import Brain, Evidence
from .prompts import CRITIC, LEAD_DRAFT, LEAD_REBUTTAL, LEAD_ROUTE, VALIDATOR, specialist_instructions

EVIDENCE_CHARS = 6_000
EVIDENCE_BUDGET = 120_000


def _ask_block(ask: Ask) -> str:
    label = "Hypothesis to test" if ask.mode == "coscientist" else "Question"
    block = f"Mode: {ask.mode}\n{label}: {ask.question}"
    if ask.required:
        block += ("\nRequired live sources: " + "; ".join(ask.required) + ". The answer's facts must cite the live pages of these "
                  "documents, so search them with search_live_evidence and name the document in the query. A knowledge-graph "
                  "record or the packaged snapshot can't stand in for them, even when it comes from the same dataset.")
    return block


def _findings_block(findings: list[Finding]) -> str:
    return json.dumps([{"specialist": f.specialist, "statements": [s.model_dump() for s in f.statements], "missing": f.missing}
                       for f in findings if f.chosen and (f.statements or f.missing)], ensure_ascii=False)


def _cited(findings: list[Finding]) -> set[str]:
    return {c for f in findings for s in f.statements for c in s.cites}


def _summaries(findings: list[Finding]) -> list[FindingSummary]:
    return [FindingSummary(specialist=f.specialist, chosen=f.chosen, statements=f.statements, missing=f.missing, error=f.error, ms=f.ms) for f in findings]


def _clip(text: str, limit: int) -> str:
    """Shortens at a sentence or word boundary and says so, so no line ends mid-word."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    end = cut.rfind(". ")
    cut = cut[:end + 1] if end >= limit // 2 else cut[:cut.rfind(" ")].rstrip(",;:") if cut.rfind(" ") >= limit // 2 else cut
    return f"{cut}…"


def _numbered(answer: AnswerDraft) -> str:
    """The draft with its statements numbered from 1, the numbers the critic's problems name."""
    return json.dumps({"answerable": answer.answerable, "statements": [{"number": i, **s.model_dump()} for i, s in enumerate(answer.sentences, 1)],
                       "missing": answer.missing}, ensure_ascii=False)


def _raised(critiques: list[Critique]) -> list[str]:
    return list(dict.fromkeys(p.problem for c in critiques for p in c.problems))[:8]


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def _missing(*lists: list[str]) -> list[str]:
    return list(dict.fromkeys(_clip(m, 300) for items in lists for m in items if m.strip()))[:8]


class LeadRoute(Executor):
    def __init__(self, brain: Brain):
        super().__init__(id="lead-route")
        self.brain = brain

    @handler
    async def route(self, ask: Ask, ctx: WorkflowContext[Plan]) -> None:
        try:
            routing = await self.brain.ask("lead", LEAD_ROUTE, _ask_block(ask), Routing)
            chosen = [s for s in SPECIALISTS if s in routing.specialists] or ["literature"]
            reason = _clip(routing.reason, 300)
        except Exception as e:  # noqa: BLE001 - a failed routing still gets the question its most general specialist
            chosen, reason = ["literature"], f"routing failed ({type(e).__name__}), so the literature specialist was asked"
        await ctx.send_message(Plan(ask=ask, chosen=chosen, reason=reason))


class Specialist(Executor):
    def __init__(self, name: str, brain: Brain):
        super().__init__(id=name)
        self.name, self.brain = name, brain

    @handler
    async def work(self, plan: Plan, ctx: WorkflowContext[Finding]) -> None:
        if self.name not in plan.chosen:
            await ctx.send_message(Finding(specialist=self.name, ask=plan.ask, chosen=False))
            return
        started = time.monotonic()
        try:
            report = await self.brain.ask(self.name, specialist_instructions(self.name), _ask_block(plan.ask), FindingReport, tools=True)
            statements, _ = clean_statements(report.statements, limit=8)
            finding = Finding(specialist=self.name, ask=plan.ask, chosen=True, statements=statements, missing=_missing(report.missing))
        except Exception as e:  # noqa: BLE001 - one specialist's failure is reported, and the others still count
            finding = Finding(specialist=self.name, ask=plan.ask, chosen=True, error=type(e).__name__)
        finding.ms = int((time.monotonic() - started) * 1000)
        await ctx.send_message(finding)


class LeadDraft(Executor):
    def __init__(self, brain: Brain):
        super().__init__(id="lead-draft")
        self.brain = brain

    @handler
    async def draft(self, findings: list[Finding], ctx: WorkflowContext[Draft]) -> None:
        findings = sorted(findings, key=lambda f: list(SPECIALISTS).index(f.specialist))
        ask, notes = findings[0].ask, [f"the {f.specialist} specialist failed ({f.error})" for f in findings if f.error]
        missing = _missing(*(f.missing for f in findings))
        chosen = [f for f in findings if f.chosen]
        if chosen and all(f.error for f in chosen):
            # Nothing was searched, so this is no evidence of absence: the run is incomplete, never "Not found".
            await ctx.send_message(Draft(ask=ask, findings=findings, answer=AnswerDraft(answerable=False, sentences=[], missing=missing), failed=True,
                                         notes=notes + ["every chosen specialist failed, so nothing was searched or checked"]))
            return
        if not any(f.statements for f in findings):
            answer = AnswerDraft(answerable=False, sentences=[], missing=missing or ["The evidence tools returned nothing that bears on this."])
            await ctx.send_message(Draft(ask=ask, findings=findings, answer=answer, notes=notes))
            return
        try:
            raw = await self.brain.ask("lead", LEAD_DRAFT, f"{_ask_block(ask)}\nFindings (JSON): {_findings_block(findings)}", AnswerDraft)
        except Exception as e:  # noqa: BLE001
            await ctx.send_message(Draft(ask=ask, findings=findings, answer=AnswerDraft(answerable=False, sentences=[], missing=missing),
                                         failed=True, notes=notes + [f"the lead's draft failed ({type(e).__name__})"]))
            return
        sentences, dropped = clean_statements(raw.sentences, _cited(findings))
        # The lead's own list of what is missing is the answer's; the specialists' lists stand in only when it gives none.
        answer = AnswerDraft(answerable=raw.answerable and bool(sentences), sentences=sentences, missing=_missing(raw.missing) or missing)
        await ctx.send_message(Draft(ask=ask, findings=findings, answer=answer, notes=notes + dropped))


class Critic(Executor):
    def __init__(self, brain: Brain):
        super().__init__(id="critic")
        self.brain = brain

    @handler
    async def review(self, draft: Draft, ctx: WorkflowContext[RebuttalRequest | Reviewed | Result]) -> None:
        if draft.failed or not draft.answer.answerable:
            await ctx.send_message(Reviewed(draft=draft))
            return
        prompt = f"{_ask_block(draft.ask)}\nFindings (JSON): {_findings_block(draft.findings)}\nDraft (JSON): {_numbered(draft.answer)}"
        try:
            critique = await self.brain.ask("critic", CRITIC, prompt, Critique)
        except Exception as e:  # noqa: BLE001 - the validator still checks every statement
            await ctx.send_message(Reviewed(draft=draft.model_copy(update={"notes": draft.notes + [f"the critic did not answer ({type(e).__name__})"]})))
            return
        problems = [Problem(statement=p.statement, problem=_clip(p.problem, 400)) for p in critique.problems if p.problem.strip()][:8]
        if critique.block and problems:
            critique = critique.model_copy(update={"problems": problems})
            if not draft.rebutted:
                await ctx.send_message(RebuttalRequest(draft=draft, critique=critique))
                return
            sentences = draft.answer.sentences
            named: dict[int, str] = {}
            for p in problems:
                if 1 <= p.statement <= len(sentences):
                    named.setdefault(p.statement, p.problem)
            kept = [s for i, s in enumerate(sentences, 1) if i not in named]
            whole = any(not 1 <= p.statement <= len(sentences) for p in problems)
            if whole or not any(s.kind == "fact" for s in kept):
                await ctx.send_message(Result(status="blocked", mode=draft.ask.mode, dissent=[p.problem for p in problems], missing=_missing(critique.missing, draft.answer.missing),
                                              specialists=[f.specialist for f in draft.findings if f.chosen], findings=_summaries(draft.findings), notes=draft.notes,
                                              critique=_raised(draft.critiques), rebutted=True))
                return
            # Every remaining problem names a statement, so those statements go and the validator checks the rest.
            struck = [{"text": sentences[i - 1].text, "why": f"the critic still objected after the revision: {why.rstrip('.')}", "by": "critic"} for i, why in sorted(named.items())]
            answer = draft.answer.model_copy(update={"sentences": kept})
            note = f"the critic still objected to {_plural(len(named), 'statement')} of the revision, removed before validation"
            await ctx.send_message(Reviewed(draft=draft.model_copy(update={"answer": answer, "struck": struck, "notes": draft.notes + [note]}), critique=critique))
            return
        await ctx.send_message(Reviewed(draft=draft, critique=critique))


class LeadRebuttal(Executor):
    def __init__(self, brain: Brain):
        super().__init__(id="lead-rebuttal")
        self.brain = brain

    @handler
    async def revise(self, request: RebuttalRequest, ctx: WorkflowContext[Draft]) -> None:
        draft, critique = request.draft, request.critique
        prompt = (f"{_ask_block(draft.ask)}\nFindings (JSON): {_findings_block(draft.findings)}\nYour draft (JSON): {_numbered(draft.answer)}\n"
                  f"The critic's problems, each with the number of the statement it concerns (0 for the draft as a whole): "
                  f"{json.dumps([p.model_dump() for p in critique.problems], ensure_ascii=False)}\nThe critic's missing evidence: {json.dumps(critique.missing, ensure_ascii=False)}")
        notes: list[str] = []
        try:
            raw = await self.brain.ask("lead", LEAD_REBUTTAL, prompt, AnswerDraft)
            sentences, notes = clean_statements(raw.sentences, _cited(draft.findings))
            answer = AnswerDraft(answerable=raw.answerable and bool(sentences), sentences=sentences, missing=_missing(raw.missing) or draft.answer.missing)
        except Exception as e:  # noqa: BLE001 - the unrevised draft goes back, and the critic decides again
            answer, notes = draft.answer, [f"the lead's rebuttal failed ({type(e).__name__})"]
        sent_back = f"the critic sent the first draft back ({_plural(len(critique.problems), 'problem')}), and the lead revised it"
        await ctx.send_message(draft.model_copy(update={"answer": answer, "rebutted": True, "critiques": [*draft.critiques, critique], "notes": draft.notes + [sent_back] + notes}))


class Validate(Executor):
    def __init__(self, brain: Brain, evidence: Evidence):
        super().__init__(id="validator")
        self.brain, self.evidence = brain, evidence

    @handler
    async def validate(self, reviewed: Reviewed, ctx: WorkflowContext[Result]) -> None:
        draft = reviewed.draft
        base = {"mode": draft.ask.mode, "specialists": [f.specialist for f in draft.findings if f.chosen], "findings": _summaries(draft.findings),
                "critique": _raised(draft.critiques), "rebutted": draft.rebutted}
        notes, statements = list(draft.notes), draft.answer.sentences
        if draft.failed:
            await ctx.send_message(Result(status="validation_incomplete", missing=draft.answer.missing, notes=notes, removed=draft.struck, **base))
            return
        if not draft.answer.answerable:
            await ctx.send_message(Result(status="not_found", missing=draft.answer.missing, notes=notes, **base))
            return
        ids = sorted({c for s in statements for c in s.cites})
        try:
            found, _ = await self.evidence.read(ids)
            verdicts = await self.brain.ask("validator", VALIDATOR, _validation_prompt(statements, found), Verdicts, validator=True)
        except Exception as e:  # noqa: BLE001 - nothing unchecked is shown
            await ctx.send_message(Result(status="validation_incomplete", missing=draft.answer.missing, notes=notes + [f"validation failed ({type(e).__name__})"],
                                          removed=draft.struck, **base))
            return
        by_statement = {v.statement: v for v in verdicts.verdicts}
        kept: list[Statement] = []
        removed: list[dict[str, str]] = list(draft.struck)
        for i, s in enumerate(statements, 1):
            records = [found[c] for c in s.cites if c in found]
            unknown = [c for c in s.cites if c not in found]
            numbers = unsupported_numbers(s.text, "\n".join(r["text"] for r in records), [title_of(r.get("label", "")) for r in records],
                                          [r["page"] for r in records if isinstance(r.get("page"), int)], draft.ask.question)
            verdict = by_statement.get(i)
            quoted = f"statement {i} (\u201c{s.text[:70]}{'…' if len(s.text) > 70 else ''}\u201d)"
            if unknown:
                why = f"it cites evidence the run's tools never returned ({', '.join(unknown)})"
            elif numbers:
                why = f"{', '.join(numbers)} is not in its cited evidence"
            elif not verdict or verdict.verdict != "supported":
                why = f"the validator found it {verdict.verdict if verdict else 'unchecked'}" + (f": {_clip(verdict.reason, 300)}" if verdict and verdict.reason.strip() else "")
            else:
                kept.append(s)
                continue
            notes.append(f"removed {quoted}: {why}")
            removed.append({"text": s.text, "why": why, "by": "validator"})
        answered = any(s.kind == "fact" for s in kept)
        tally = None
        if draft.ask.mode == "coscientist":
            tally = {stance: sum(1 for s in kept if s.stance == stance) for stance in ("for", "against", "context")}
            tally["missing"] = len(draft.answer.missing)
        await ctx.send_message(Result(status="answered" if answered else "validation_incomplete", sentences=kept if answered else [],
                                      missing=draft.answer.missing, verdicts=verdicts.verdicts, tally=tally if answered else None,
                                      evidence_ids=sorted({c for s in kept for c in s.cites}) if answered else [], notes=notes, removed=removed, **base))


def _validation_prompt(statements: list[Statement], found: dict[str, dict]) -> str:
    lines, used = [], 0
    for i, s in enumerate(statements, 1):
        lines.append(f"Statement {i}{' (INTERPRETATION)' if s.kind == 'interpretation' else ''}: {s.text}\nIts evidence: {', '.join(s.cites)}")
    lines.append("\nEvidence records:")
    for evidence_id in sorted({c for s in statements for c in s.cites}):
        record = found.get(evidence_id)
        if not record:
            continue
        text = record["text"][:EVIDENCE_CHARS]
        if used + len(text) > EVIDENCE_BUDGET:
            text = text[:max(0, EVIDENCE_BUDGET - used)]
        used += len(text)
        lines.append(f"[{evidence_id}] {record.get('label', '')}\n{text}")
    return "\n".join(lines)


class Finish(Executor):
    def __init__(self, brain: Brain) -> None:
        super().__init__(id="finish")
        self.brain = brain

    @handler
    async def finish(self, result: Result, ctx: WorkflowContext[Never, str]) -> None:
        usage, fabric = getattr(self.brain, "usage", None), getattr(self.brain, "fabric", None)
        update: dict[str, object] = {}
        if usage:
            update["usage"] = dict(usage)
        if fabric is not None:
            update["knowledge"] = fabric.report()
        await ctx.yield_output((result.model_copy(update=update) if update else result).model_dump_json())


def build_workflow(brain: Brain, evidence: Evidence) -> Workflow:
    """A fresh graph with stable IDs, as the hosting integration requires for every request."""
    lead, draft, critic, rebuttal, validator, finish = LeadRoute(brain), LeadDraft(brain), Critic(brain), LeadRebuttal(brain), Validate(brain, evidence), Finish(brain)
    specialists = [Specialist(name, brain) for name in SPECIALISTS]
    return (WorkflowBuilder(name="gbx-scientists", start_executor=lead, max_iterations=40)
            .add_fan_out_edges(lead, specialists)
            .add_fan_in_edges(specialists, draft)
            .add_edge(draft, critic)
            .add_edge(critic, rebuttal, condition=lambda m: isinstance(m, RebuttalRequest))
            .add_edge(critic, validator, condition=lambda m: isinstance(m, Reviewed))
            .add_edge(critic, finish, condition=lambda m: isinstance(m, Result))
            .add_edge(rebuttal, critic)
            .add_edge(validator, finish)
            .build())
