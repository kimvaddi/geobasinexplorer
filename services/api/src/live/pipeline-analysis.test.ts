import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import { analyzeOnce, analysisResultId, LAYOUT_API_VERSION, type AnalysisCheckpoint, type AnalysisOperation, type AnalysisSubmission, type AnalysisTransport } from "./pipeline-analysis";
const bytes = Buffer.from("%PDF-test"), resultId = "11111111-2222-4333-8444-555555555555";
const result = { modelId: "prebuilt-layout", apiVersion: LAYOUT_API_VERSION, content: "text" } as AnalyzeResultOutput;
function fixture() {
  let submission: AnalysisSubmission | null = null, operation: AnalysisOperation | null = null;
  const events: string[] = [];
  const checkpoint: AnalysisCheckpoint = { submission: async () => submission, operation: async () => operation,
    saveSubmission: async (value) => { assert.equal(submission, null); submission = structuredClone(value); events.push("submission-saved"); },
    saveOperation: async (value) => { assert.equal(operation, null); operation = structuredClone(value); events.push("operation-saved"); } };
  const transport: AnalysisTransport = { bookPages: async (pages) => { assert.equal(pages, 420); events.push("book"); },
    submit: async (_bytes, requestId) => { assert.equal(submission?.requestId, requestId); events.push("POST"); return resultId; },
    result: async (id) => { assert.equal(id, resultId); events.push("GET"); return { status: "succeeded", result }; }, wait: async () => {} };
  return { checkpoint, transport, events, submission: () => submission, operation: () => operation };
}
test("durable operation is saved before polling and results resume without a second POST or quota booking", async () => {
  const f = fixture(); f.transport.result = async () => { f.events.push("GET-failed"); throw new Error("interrupted polling"); };
  await assert.rejects(analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)), /interrupted/);
  assert.deepEqual(f.events, ["book", "submission-saved", "POST", "operation-saved", "GET-failed"]);
  f.transport.result = async () => { f.events.push("GET-resumed"); return { status: "succeeded", result }; };
  assert.equal(await analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)), result);
  assert.equal(f.events.filter((e) => e === "POST").length, 1); assert.equal(f.events.filter((e) => e === "book").length, 1);
});
test("an ambiguous submission is never silently resubmitted or re-billed", async () => {
  const f = fixture(); f.transport.submit = async () => { f.events.push("POST"); throw new Error("lost acknowledgement"); };
  await assert.rejects(analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)));
  await assert.rejects(analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)), /outcome is unknown/);
  assert.equal(f.events.filter((e) => e === "POST").length, 1); assert.equal(f.events.filter((e) => e === "book").length, 1);
});
test("a quota failure sends no POST and creates no ambiguous submission marker", async () => {
  const f = fixture(); f.transport.bookPages = async () => { throw new Error("OCR daily cap"); };
  await assert.rejects(analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)), /cap/);
  assert.equal(f.submission(), null); assert.equal(f.operation(), null); assert.equal(f.events.includes("POST"), false);
});
test("saved operations cannot be rebound to changed bytes or a different page count", async () => {
  const f = fixture(); await analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000));
  await assert.rejects(analyzeOnce(Buffer.from("changed"), 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)), /not bound/);
  await assert.rejects(analyzeOnce(bytes, 419, f.checkpoint, f.transport, AbortSignal.timeout(1000)), /not bound/);
  assert.equal(f.events.filter((e) => e === "POST").length, 1);
});
test("running operations poll the same ID; failed or missing results never submit again", async () => {
  const f = fixture(); let polls = 0;
  f.transport.result = async () => ++polls === 1 ? { status: "running", retryAfterMs: 1 } : { status: "succeeded", result };
  await analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)); assert.equal(polls, 2);
  f.transport.result = async () => ({ status: "failed" });
  await assert.rejects(analyzeOnce(bytes, 420, f.checkpoint, f.transport, AbortSignal.timeout(1000)), /will not be resubmitted/);
  assert.equal(f.events.filter((e) => e === "POST").length, 1);
});
test("operation URLs are HTTPS, same-endpoint, version-pinned result IDs only", () => {
  const endpoint = "https://example.cognitiveservices.azure.com", path = `/documentintelligence/documentModels/prebuilt-layout/analyzeResults/${resultId}?api-version=${LAYOUT_API_VERSION}`;
  assert.equal(analysisResultId(endpoint + path, endpoint), resultId);
  for (const bad of [undefined, "http://example.cognitiveservices.azure.com" + path, "https://other.invalid" + path, endpoint + path.replace(LAYOUT_API_VERSION, "2023-01-01"), endpoint + path.replace(resultId, "../escape")]) {
    assert.throws(() => analysisResultId(bad, endpoint));
  }
});
