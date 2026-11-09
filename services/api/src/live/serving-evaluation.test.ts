import assert from "node:assert/strict";
import { test } from "node:test";
import { PACK } from "@/lib/pack";
import { blockedEvaluationRow, evaluationBenchmarks, evaluationSummary } from "./serving-evaluation";
test("cloud-stripped evaluation still lists all twelve with Q08/Q09 BLOCKED", () => {
  const items = evaluationBenchmarks(PACK.benchmarks); assert.equal(items.length, 12);
  const blocked = items.filter((i) => i.blocked); assert.deepEqual(blocked.map((i) => i.id), ["Q08", "Q09"]);
  assert.ok(blocked.every((i) => !i.bench && i.blocked === "Reuse terms not confirmed"));
});
test("blocked cases remain in summary denominators, counts and NOT MET gate", () => {
  const items = evaluationBenchmarks(PACK.benchmarks);
  const rows = items.map((i) => i.blocked ? blockedEvaluationRow(i) : { id: i.id, benchmark: true, source: true, label: "Retrieved", validation: "passed", facts: [5, 5], citeOrNotFound: true, ms: 10, tokens: 1 });
  const s = evaluationSummary(rows); assert.equal(s.questions, 12); assert.equal(s.blocked, 2); assert.equal(s.labels.BLOCKED, 2); assert.equal(s.expectedSource, "10/12"); assert.equal(s.citeOrNotFound, "10/12"); assert.equal(s.foundingGate.status, "NOT MET"); assert.equal(s.latencyMs.max, 10);
});
test("errors are not silently dropped and blocked rows never call a model", () => {
  const s = evaluationSummary([{ id: "Q01", benchmark: true, error: "failure" }, blockedEvaluationRow({ id: "Q08", q: "Withheld", blocked: "Reuse terms not confirmed" })]);
  assert.equal(s.questions, 2); assert.equal(s.errors, 1); assert.equal(s.blocked, 1); assert.equal(s.expectedSource, "0/2"); assert.equal(s.tokens, 0);
});
