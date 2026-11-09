// Answer-engine check: every answer must cite a source or say "not found", and carry a label.
// Run from the repo root: node tools/run-ts.mjs tests/answers/entry.ts tests/answers/questions.json
import fs from "node:fs";
import path from "node:path";
import { answer5 } from "@/lib/answer5";
import { PACK } from "@/lib/pack";
import { STARTERS } from "@/lib/ask";
import { BASINS } from "@/lib/basins";
import { LENSES } from "@/lib/lenses";
import { PLACE_STARTERS } from "@/lib/place-answer";
import { BASIN_QUESTIONS, QUESTION_BASINS, suggestedQuestions } from "@/lib/suggest";

const file = process.argv[2] ?? "tests/answers/questions.json";
const extra: string[] = JSON.parse(fs.readFileSync(file, "utf8"));
const questions = [...PACK.benchmarks.map((b) => b.q), ...extra];
// A case is a question, or a question asked with a basin chosen in the app.
type Case = string | { q: string; basin: string };
const read = (name: string): Case[] => JSON.parse(fs.readFileSync(path.join(path.dirname(file), name), "utf8"));
// No prepared rule covers the first set: each once drew an unrelated prepared answer, so a Precomputed label fails. The
// second set must keep its prepared answer, so that guarding against the first can't take it away.
const unprepared = read("not-prepared.json"), stillPrepared = read("still-prepared.json");
let bad = 0;
function run(list: Case[], expect: "any" | "unprepared" | "prepared") {
  const labels: Record<string, number> = {};
  for (const c of list) {
    const q = typeof c === "string" ? c : c.q, basin = typeof c === "string" ? null : c.basin;
    const a = answer5(q, { basin });
    const text = a.paragraphs.join(" ");
    const ok = (a.citations.length > 0 || /Not found in the data|outside what this file holds/.test(text)) && !!a.label
      && (expect === "any" || (expect === "prepared") === (a.label === "Precomputed"));
    labels[a.label] = (labels[a.label] ?? 0) + 1;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} [${a.label}] ${String(a.ms).padStart(3)} ms  cites:${a.citations.length}  ${basin ? `(${basin}) ` : ""}${q.slice(0, 90)}`);
  }
  return labels;
}
const labels = run(questions, "any"), failed = bad, others = run(unprepared, "unprepared"), failedOthers = bad - failed, kept = run(stillPrepared, "prepared");
console.log(`\n${questions.length} questions (${PACK.benchmarks.length} benchmarks + ${extra.length} extra). Labels: ${JSON.stringify(labels)}. Failures: ${failed}.`);
console.log(`${unprepared.length} questions no prepared rule covers. Labels: ${JSON.stringify(others)}. Failures: ${failedOthers}.`);
console.log(`${stillPrepared.length} phrasings that keep their prepared answer. Labels: ${JSON.stringify(kept)}. Failures: ${bad - failed - failedOthers}.`);

// Suggested questions follow the copilot's context (lib/suggest.ts): every role and general question says which basins
// answer it, a basin never suggests another basin's questions, a place starts with the point's own questions, and every
// question a basin suggests has an answer.
const before = bad, fail = (why: string) => { bad++; console.log(`FAIL suggestions: ${why}`); };
const roleLists = LENSES.map((l) => [...new Set([...l.questions, ...STARTERS])]);
for (const q of new Set(roleLists.flat())) if (!(q in QUESTION_BASINS)) fail(`"${q}" doesn't say which basins answer it`);
for (const b of BASINS) {
  for (const role of roleLists) {
    const s = suggestedQuestions(role, { basin: b.id, place: false });
    for (const q of s) { const owners = QUESTION_BASINS[q]; if (owners?.length && !owners.includes(b.id)) fail(`the ${b.name} suggests "${q}"`); }
    if (s.slice(0, 4).some((q) => !(QUESTION_BASINS[q]?.includes(b.id) || BASIN_QUESTIONS[b.id].includes(q)))) fail(`the ${b.name}'s first suggestions aren't all about it`);
    const p = suggestedQuestions(role, { basin: b.id, place: true });
    if (JSON.stringify(p) !== JSON.stringify([...PLACE_STARTERS, BASIN_QUESTIONS[b.id][0]])) fail(`a place in the ${b.name} suggests ${JSON.stringify(p)}`);
  }
  for (const q of BASIN_QUESTIONS[b.id]) {
    const a = answer5(q, { basin: null });
    if (a.label === "Not found" || !a.citations.length) fail(`"${q}" has no answer (${a.label})`);
    console.log(`${a.label === "Not found" ? "FAIL" : "ok  "} [${a.label}] suggested for the ${b.name}: ${q.slice(0, 90)}`);
  }
}
console.log(`${BASINS.length} basins and ${roleLists.length} roles of suggested questions. Failures: ${bad - before}.`);
process.exit(bad ? 1 : 0);
