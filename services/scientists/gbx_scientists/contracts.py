"""Messages between the scientists, and the structured outputs each model returns (docs/FOUNDRY_AGENTS.md).

The structured-output models have no defaults and forbid extra keys, so they compile to strict JSON schemas; every limit
the models must respect is checked again in code after parsing, because strict schemas accept few constraints.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SPECIALISTS: tuple[str, ...] = ("literature", "stratigraphy", "spatial", "rock", "stress")
Specialist = Literal["literature", "stratigraphy", "spatial", "rock", "stress"]
Mode = Literal["copilot", "coscientist"]
EVIDENCE_ID = r"^[LPTK][0-9a-f]{10}$"
MAX_STATEMENTS = 14


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Structured outputs ------------------------------------------------------------------------------------------------
class Routing(Strict):
    specialists: list[Specialist]
    reason: str


class Statement(Strict):
    kind: Literal["fact", "interpretation"]
    stance: Literal["for", "against", "context"]
    text: str
    cites: list[str]


class FindingReport(Strict):
    statements: list[Statement]
    missing: list[str]


class AnswerDraft(Strict):
    answerable: bool
    sentences: list[Statement]
    missing: list[str]


class Problem(Strict):
    # The number of the draft statement the problem concerns, or 0 when it concerns the draft as a whole.
    statement: int
    problem: str


class Critique(Strict):
    block: bool
    problems: list[Problem]
    missing: list[str]


class Verdict(Strict):
    statement: int
    verdict: Literal["supported", "partial", "unsupported"]
    reason: str


class Verdicts(Strict):
    verdicts: list[Verdict]


# Messages between executors ------------------------------------------------------------------------------------------
class Ask(Strict):
    question: str = Field(min_length=1, max_length=4000)
    mode: Mode = "copilot"
    # The live documents the answer's facts must cite, as "title (source id)", which the app sends when the question
    # needs them; a knowledge-graph record or the packaged snapshot can't stand in for them (answer.ts, required sources).
    required: list[str] = Field(default_factory=list, max_length=8)


class Plan(BaseModel):
    ask: Ask
    chosen: list[str]
    reason: str


class Finding(BaseModel):
    specialist: str
    ask: Ask
    chosen: bool
    statements: list[Statement] = []
    missing: list[str] = []
    error: str | None = None
    ms: int = 0


class Draft(BaseModel):
    ask: Ask
    findings: list[Finding]
    answer: AnswerDraft
    rebutted: bool = False
    failed: bool = False
    critiques: list[Critique] = []
    notes: list[str] = []
    # Statements the critic still objected to after the revision, removed with its reason before validation.
    struck: list[dict[str, str]] = []


class RebuttalRequest(BaseModel):
    draft: Draft
    critique: Critique


class Reviewed(BaseModel):
    draft: Draft
    critique: Critique | None = None


class FindingSummary(BaseModel):
    """What one specialist found, as the Co-Scientist workspace shows it; the lead's answer alone is validated."""
    specialist: str
    chosen: bool
    statements: list[Statement] = []
    missing: list[str] = []
    error: str | None = None
    ms: int = 0


class Result(BaseModel):
    """What a run returns: an answer that passed validation, "Not found", "Validation incomplete", or the critic's dissent."""
    status: Literal["answered", "not_found", "validation_incomplete", "blocked"]
    mode: Mode
    sentences: list[Statement] = []
    missing: list[str] = []
    dissent: list[str] = []
    verdicts: list[Verdict] = []
    tally: dict[str, int] | None = None
    specialists: list[str] = []
    findings: list[FindingSummary] = []
    evidence_ids: list[str] = []
    notes: list[str] = []
    # The problems the critic raised when it sent a draft back, and whether the lead then revised it.
    critique: list[str] = []
    rebutted: bool = False
    # Tokens spent by every model call in the run, the validator's included, which the app books against its caps.
    usage: dict[str, int] | None = None
    # How the run asked Fabric IQ as the person: questions asked and answered, milliseconds, and why it last
    # fell back to the typed knowledge tools; absent where Fabric IQ wasn't offered.
    knowledge: dict[str, int | str] | None = None
    # Statements removed before anyone saw them, with the reason and who removed them ("critic" or "validator"), which the
    # app lists as version 1 does.
    removed: list[dict[str, str]] = []


CHECKPOINT_TYPES = [Ask, Plan, Finding, Statement, AnswerDraft, Problem, Critique, Draft, RebuttalRequest, Reviewed, Verdict, FindingSummary, Result]
