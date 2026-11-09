import type { AnswerLabel } from "@/lib/answer5";
import { PACK, type Bench, type DataType, type Level, type Entity } from "@/lib/pack";
import type { TestRun } from "@/lib/autocheck";

export type Mark = "Correct" | "Partial" | "Wrong";
export interface ScoreEntry { mark?: Mark; level?: Level; evidence?: string; notes?: string; label?: AnswerLabel | "Not asked"; markedAt?: string; revealed?: boolean }
export type ScoreState = Record<string, ScoreEntry>;
export interface ReviewEntry { status: "accepted" | "rejected" | "edited"; label?: string; note?: string; at: string; by: string }
export type ReviewState = Record<string, ReviewEntry>;
export interface LogEntry { at: string; by: string; entity: string; action: string; before: string; after: string; note: string }
export const allQuestions = (custom: Bench[]): Bench[] => [...PACK.benchmarks, ...custom];

/* Column schema shared by the in-file export and the Excel template. */
export const SHEETS = {
  Scorecard: ["Question ID", "Source", "Data type", "Target level", "Question", "Answer key", "Answer label", "Mark", "Highest level reached", "Evidence used", "Reviewer", "Notes", "Marked at"],
  Summary: ["Data type", "Questions", "Marked", "Correct", "Partial", "Wrong", "% correct of marked", "Find", "Locate", "Interpret", "Map", "Integrate", "Reason"],
  "Entity review": ["Entity ID", "Type", "Label", "Status", "Edited label", "Note", "Source", "Method", "Extraction confidence", "Reviewer", "Updated at"],
  "Change log": ["Time", "Reviewer", "Entity ID", "Action", "Before", "After", "Note"],
  "Test run": ["Question ID", "Question", "Answer label", "Expected source cited", "Key facts found", "Answer time (ms)", "Run at"],
} as const;
/* Wording shared by the export's About sheet and the Excel template. */
export const ABOUT_TEXT = {
  labels: "Precomputed: worked out from the data in advance. Retrieved: found by search when you ask. Not found: nothing in the data supports an answer.",
  levels: "Find: right document. Locate: right figure, section, table or log. Interpret: geological entities. Map: spatial. Integrate: across documents and datasets. Reason: supports a hypothesis.",
  marks: "Correct: matches the answer key and cites the right source. Partial: right source or part of the answer, but incomplete or imprecise. Wrong: wrong, unsupported or misleading. A correct Not found, for a question the data can't answer, counts as Correct.",
} as const;
export const DT_LABEL: Record<DataType, string> = { "born-digital": "Born-digital documents", structured: "Structured data", "legacy-scan": "Legacy scans" };
export const LEVEL_ORDER: Level[] = ["Find", "Locate", "Interpret", "Map", "Integrate", "Reason"];

export function summary(qs: Bench[], s: ScoreState) {
  const rows = (["born-digital", "structured", "legacy-scan"] as DataType[]).map((dt) => row(DT_LABEL[dt], qs.filter((q) => q.dataType === dt), s));
  return [...rows, row("All questions", qs, s)];
}
function row(name: string, qs: Bench[], s: ScoreState) {
  const marked = qs.filter((q) => s[q.id]?.mark);
  const c = marked.filter((q) => s[q.id]?.mark === "Correct").length, p = marked.filter((q) => s[q.id]?.mark === "Partial").length, w = marked.filter((q) => s[q.id]?.mark === "Wrong").length;
  const lv = Object.fromEntries(LEVEL_ORDER.map((l) => [l, marked.filter((q) => s[q.id]?.level === l).length])) as Record<Level, number>;
  return { name, questions: qs.length, marked: marked.length, correct: c, partial: p, wrong: w, pct: marked.length ? Math.round((100 * c) / marked.length) : null, levels: lv };
}
export function exportRows(qs: Bench[], s: ScoreState, reviewer: string, review: ReviewState, log: LogEntry[], ents: Entity[], run?: TestRun | null) {
  const score = qs.map((q) => { const e = s[q.id] ?? {}; return [q.id, q.custom ? "Added by reviewer" : "Benchmark", DT_LABEL[q.dataType], q.level, q.q, q.key || "", e.label ?? "Not asked", e.mark ?? "", e.level ?? "", e.evidence ?? "", reviewer, e.notes ?? "", e.markedAt ?? ""]; });
  const sum = summary(qs, s).map((r) => [r.name, r.questions, r.marked, r.correct, r.partial, r.wrong, r.pct == null ? "" : r.pct, ...LEVEL_ORDER.map((l) => r.levels[l])]);
  const byId = new Map(ents.map((e) => [e.id, e]));
  const rev = Object.entries(review).map(([id, r]) => { const e = byId.get(id); return [id, e?.type ?? "", e?.label ?? "", r.status, r.label ?? "", r.note ?? "", e?.source ?? "", e?.method ?? "", e?.confidence ?? "", r.by, r.at]; });
  const lg = log.map((l) => [l.at, l.by, l.entity, l.action, l.before, l.after, l.note]);
  const tr = (run?.rows ?? []).map((r) => [r.id, r.q, r.label, r.source == null ? "No expected source" : r.source ? "Yes" : "No", r.facts ? `${r.facts[0]} of ${r.facts[1]}` : "No answer key", r.ms, run!.at]);
  return { Scorecard: score, Summary: sum, "Entity review": rev, "Change log": lg, "Test run": tr };
}
