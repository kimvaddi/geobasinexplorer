import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import { sha256Of } from "../scan-verdict";
import { PIPELINE_LIMITS, PipelineError } from "./pipeline-config";
export const LAYOUT_API_VERSION = "2024-11-30";
export const LAYOUT_MODEL = "prebuilt-layout";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface AnalysisSubmission {
  schemaVersion: 1; inputSha256: string; pages: number; modelId: typeof LAYOUT_MODEL; apiVersion: typeof LAYOUT_API_VERSION;
  requestId: string; submittedAt: string;
}
export interface AnalysisOperation extends AnalysisSubmission { resultId: string }
export interface AnalysisCheckpoint {
  submission(): Promise<AnalysisSubmission | null>;
  operation(): Promise<AnalysisOperation | null>;
  saveSubmission(value: AnalysisSubmission): Promise<void>;
  saveOperation(value: AnalysisOperation): Promise<void>;
}
export interface AnalysisTransport {
  bookPages(pages: number): Promise<void>;
  submit(bytes: Buffer, requestId: string, signal: AbortSignal): Promise<string>;
  result(resultId: string, signal: AbortSignal): Promise<{ status: string; result?: AnalyzeResultOutput; retryAfterMs?: number }>;
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}
function validate(checkpoint: AnalysisSubmission, sha256: string, pages: number) {
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.inputSha256 !== sha256 || checkpoint.pages !== pages
    || checkpoint.modelId !== LAYOUT_MODEL || checkpoint.apiVersion !== LAYOUT_API_VERSION || !uuid.test(checkpoint.requestId)
    || !Number.isFinite(Date.parse(checkpoint.submittedAt))) throw new PipelineError(409, "Analysis checkpoint is not bound to these bytes and recipe.");
}
// Operation-Location yields a result ID. Never follow an arbitrary saved URL or POST again on an uncertain submit.
// https://learn.microsoft.com/rest/api/aiservices/document-models/analyze-document?view=rest-aiservices-v4.0%20(2024-11-30)
// https://learn.microsoft.com/rest/api/aiservices/document-models/get-analyze-result?view=rest-aiservices-v4.0%20(2024-11-30)
export function analysisResultId(location: string | undefined, endpoint: string): string {
  if (!location) throw new PipelineError(502, "Analysis response has no operation location; submission outcome is uncertain.");
  const url = new URL(location), trusted = new URL(endpoint);
  const match = /^\/documentintelligence\/documentModels\/prebuilt-layout\/analyzeResults\/([^/]+)$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.origin !== trusted.origin || url.username || url.password || !match || !uuid.test(match[1])
    || url.searchParams.get("api-version") !== LAYOUT_API_VERSION) throw new PipelineError(502, "Unexpected analysis operation location.");
  return match[1];
}
export async function analyzeOnce(bytes: Buffer, pages: number, checkpoint: AnalysisCheckpoint, transport: AnalysisTransport, outerSignal: AbortSignal): Promise<AnalyzeResultOutput> {
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(PIPELINE_LIMITS.analysisMs)]), hash = sha256Of(bytes);
  if (!bytes.length || !Number.isSafeInteger(pages) || pages < 1 || pages > PIPELINE_LIMITS.pages) throw new PipelineError(422, "Invalid OCR page count or input.");
  signal.throwIfAborted();
  let submission = await checkpoint.submission(), operation = await checkpoint.operation();
  if (submission) validate(submission, hash, pages);
  if (operation) {
    validate(operation, hash, pages);
    if (!submission || operation.requestId !== submission.requestId || !uuid.test(operation.resultId)) throw new PipelineError(409, "Analysis operation checkpoint is inconsistent.");
  } else {
    if (submission) throw new PipelineError(409, "Analysis submission outcome is unknown. Reconcile the saved request ID; automatic resubmission and re-billing are forbidden.");
    await transport.bookPages(pages);
    signal.throwIfAborted();
    submission = { schemaVersion: 1, inputSha256: hash, pages, modelId: LAYOUT_MODEL, apiVersion: LAYOUT_API_VERSION, requestId: randomUUID(), submittedAt: new Date().toISOString() };
    await checkpoint.saveSubmission(submission);
    signal.throwIfAborted();
    const resultId = await transport.submit(bytes, submission.requestId, signal);
    if (!uuid.test(resultId)) throw new PipelineError(502, "Invalid analysis result ID; no resubmission is permitted.");
    operation = { ...submission, resultId };
    try { await checkpoint.saveOperation(operation); }
    catch (e) {
      console.error(JSON.stringify({ event: "live-analysis-operation-checkpoint-failed", requestId: submission.requestId, resultId, inputSha256: hash }));
      throw e;
    }
  }
  for (;;) {
    signal.throwIfAborted();
    const polled = await transport.result(operation.resultId, signal);
    if (polled.status === "succeeded") {
      if (!polled.result) throw new PipelineError(502, "Completed analysis has no result.");
      return polled.result;
    }
    if (polled.status === "failed" || polled.status === "canceled") throw new PipelineError(422, "Analysis failed; the saved operation will not be resubmitted.");
    if (!["running", "notStarted"].includes(polled.status)) throw new PipelineError(502, "Unexpected analysis status.");
    const wait = polled.retryAfterMs ?? 2000;
    if (!Number.isFinite(wait) || wait < 0 || wait > 300_000) throw new PipelineError(502, "Unexpected analysis retry interval.");
    if (transport.wait) await transport.wait(wait, signal); else await delay(wait, undefined, { signal });
  }
}
