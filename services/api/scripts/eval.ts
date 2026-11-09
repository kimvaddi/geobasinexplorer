// Runs the cloud answer pipeline against the live Azure resources (operator sign-in) and scores it like the offline
// tests: label, validation outcome, expected source, key facts, latency per stage and tokens.
//   node build.mjs --script scripts/eval.ts && node dist/scripts/eval.mjs benchmarks|all|"<question>" [out.json]
import fs from "node:fs";
import path from "node:path";
import { PACK } from "@/lib/pack";
import { autoCheck } from "@/lib/autocheck";
import { askCloud, type CloudAnswer } from "../src/answer";
import { cfg } from "../src/config";
import { keys, take } from "../src/usage";
import { blockedEvaluationRow, evaluationBenchmarks, evaluationSummary, type EvaluationItem } from "../src/live/serving-evaluation";

const arg = process.argv[2] ?? "benchmarks";
const outFile = process.argv[3];
const user = { id: "operator-eval", name: "operator (evaluation)", roles: [], owner: true };
const questionsFile = process.env.GBX_QUESTIONS_FILE ?? path.resolve(process.cwd(), "../../tests/answers/questions.json");
const extra: string[] = arg === "all" ? JSON.parse(fs.readFileSync(questionsFile, "utf8")) : [];
// Withheld benchmarks stay visible as BLOCKED, including when their answer keys were stripped from the bundle.
const benchmarks = evaluationBenchmarks(PACK.benchmarks);
const items: EvaluationItem[] =
  arg === "benchmarks" ? benchmarks
  : arg === "all" ? [...benchmarks, ...extra.map((q, i) => ({ id: `R${String(i + 1).padStart(2, "0")}`, q }))]
  : [{ id: "Q1", q: arg }];

await take(keys.evalRuns, 1, cfg.caps.evalRunsPerDay, "evaluation runs");
const stage = (a: CloudAnswer, s: string) => a.trace?.find((t) => t.step.startsWith(s))?.ms ?? null;
const rows: Record<string, unknown>[] = [];
for (const it of items) {
  if (it.blocked) { const row = blockedEvaluationRow(it); rows.push(row); console.log(`${it.id}  BLOCKED  ${it.blocked}`); continue; }
  let a: CloudAnswer;
  try { a = await askCloud(it.q, user, { evaluation: true }); }
  catch (e) { rows.push({ id: it.id, q: it.q, benchmark: !!it.benchmark, error: (e as Error).message }); console.log(`${it.id}  ERROR  ${(e as Error).message}`); continue; }
  const text = a.paragraphs.join(" ");
  const citeOrNotFound = (a.citations.length > 0 || (a.label === "Not found" && (a.status === "unsupported" || a.status === "declined"))) && !!a.label;
  const c = it.bench ? autoCheck(it.bench, a) : null;
  const row = {
    id: it.id, q: it.q, benchmark: !!it.benchmark, label: a.label, validation: a.validation?.status, removed: a.validation?.removed.length ?? 0, citeOrNotFound,
    source: c?.source ?? null, facts: c?.facts ?? null, ms: a.ms, search: stage(a, "Searched"), write: stage(a, "Wrote"), validate: stage(a, "Validated"), tokens: a.tokens,
    answer: text.slice(0, 600), cites: a.citations.map((x) => `${x.doc}${x.page ? ` p.${x.page}` : ""}`),
  };
  rows.push(row);
  console.log(`${it.id}  ${a.label.padEnd(11)} ${String(a.validation?.status).padEnd(10)} ${String(a.ms).padStart(6)} ms  src:${c?.source ?? "-"} facts:${c?.facts ? c.facts.join("/") : "-"}  ${it.q.slice(0, 70)}`);
}
const summary = evaluationSummary(rows);
console.log(JSON.stringify(summary, null, 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 1));
