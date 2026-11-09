// node tools/run-ts.mjs tests/answers/offline-fingerprint.ts
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { answer5 } from "@/lib/answer5";
import { PACK } from "@/lib/pack";

const questions = [...PACK.benchmarks.map((b) => b.q), ...JSON.parse(fs.readFileSync("tests/answers/questions.json", "utf8")) as string[]];
const actual = questions.map((question) => {
  const { id: _id, ms: _ms, trace, ...answer } = answer5(question, { basin: null });
  const stable = { ...answer, trace: trace?.map(({ ms: _time, ...step }) => step) };
  return { question, label: answer.label, citations: answer.citations.length, sha256: createHash("sha256").update(JSON.stringify(stable)).digest("hex") };
});
const file = "tests/answers/offline-fingerprints.json";
if (process.argv.includes("--capture")) {
  if (fs.existsSync(file)) throw new Error("Refusing to overwrite an existing offline baseline.");
  fs.writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
} else {
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, "utf8")));
}
console.log(`${actual.length} offline answer fingerprints. Failures: 0.`);
