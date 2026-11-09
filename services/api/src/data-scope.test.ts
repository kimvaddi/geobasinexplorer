// node build.mjs --script src/data-scope.test.ts && node --test dist/scripts/data-scope.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { counterKeys, parseDataScope, scopedTable } from "./data-scope";

const shared = (k: ReturnType<typeof counterKeys>) => [k.ocrPages, k.userUploads("u1"), k.evalRuns, k.esriTiles, k.userEsriTiles("u1"), k.pcTiles, k.userPcTiles("u1"), k.pcAreas, k.userPcAreas("u1")];

test("without a scope the main app keeps its counter and table names", () => {
  const k = counterKeys("");
  assert.deepEqual([k.questions, k.tokens, k.userQuestions("u1")], ["q-all", "tokens-all", "q-user-u1"]);
  assert.deepEqual(shared(k), ["ocr-pages-all", "up-user-u1", "eval-all", "esri-tiles-all", "esri-tiles-user-u1", "pc-tiles-all", "pc-tiles-user-u1", "pc-areas-all", "pc-areas-user-u1"]);
  assert.deepEqual([scopedTable("", "reviews"), scopedTable("", "feedback")], ["reviews", "feedback"]);
});

test("a scope separates questions, tokens, reviews and feedback but shares the account-wide allowances", () => {
  const k = counterKeys("demo");
  assert.deepEqual([k.questions, k.tokens, k.userQuestions("u1")], ["demo-q-all", "demo-tokens-all", "demo-q-user-u1"]);
  assert.deepEqual(shared(k), shared(counterKeys("")));
  assert.deepEqual([scopedTable("demo", "reviews"), scopedTable("demo", "feedback")], ["demoreviews", "demofeedback"]);
});

test("a scope must be a short lower-case word so table names stay valid", () => {
  assert.equal(parseDataScope(), "");
  assert.equal(parseDataScope(" demo "), "demo");
  for (const bad of ["Demo", "de-mo", "d", "demo1", "averyveryverylongscope"]) assert.throws(() => parseDataScope(bad), /GBX_DATA_SCOPE/);
});
