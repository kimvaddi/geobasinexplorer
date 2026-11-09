import { cfg } from "../config";
import type { QueueClient } from "@azure/storage-queue";
import type { PipelineStore } from "./pipeline-store";
import type { PipelineServices } from "./pipeline-types";
import { CapError } from "../usage";
import { ScanVerdictError } from "../scan-verdict";
import { LIVE_QUEUES } from "./contracts";
import { PIPELINE_LIMITS, PIPELINE_TABLES, PipelineError } from "./pipeline-config";
import { pipelineQueue, azurePipelineStore } from "./pipeline-store";
import { azurePipelineServices } from "./pipeline-services";
import { decodeProcessMessage, processLiveJob } from "./pipeline-process";
import { liveQueue, type PipelineJob } from "./pipeline-registry";
export async function runLiveWorker(runtime?: { queue: Pick<QueueClient, "receiveMessages" | "deleteMessage">; store: PipelineStore; services: PipelineServices; enabled?: boolean }) {
  const signal = AbortSignal.timeout(PIPELINE_LIMITS.jobMs), queue = runtime?.queue ?? pipelineQueue(LIVE_QUEUES.process), store = runtime?.store ?? azurePipelineStore();
  const enabled = runtime?.enabled ?? cfg.aiEnabled;
  const [message] = (await queue.receiveMessages({ numberOfMessages: 1, visibilityTimeout: enabled ? PIPELINE_LIMITS.queueVisibilitySeconds : 3600, abortSignal: signal })).receivedMessageItems;
  if (!message) return;
  // Hold the original invisible message without consuming processing attempts while the kill switch is on.
  if (!enabled) return;
  let decoded;
  try { decoded = decodeProcessMessage(message.messageText); }
  catch { await queue.deleteMessage(message.messageId, message.popReceipt, { abortSignal: signal }); console.warn(JSON.stringify({ event: "live-invalid-message-discarded", messageId: message.messageId })); return; }
  try {
    const job = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", decoded.jobId, signal);
    if (job && Number(job.leaseUntil) > Date.now()) return;
    if (job && job.attempts >= 3 && !["published", "rejected", "review"].includes(job.status)) {
      await store.put(PIPELINE_TABLES.jobs, { partitionKey: "job", rowKey: decoded.jobId, status: "failed", detail: "Queue retry cap reached; operator intervention required.", leaseUntil: 0 }, job.etag, signal);
    } else if (await processLiveJob(store, runtime?.services ?? azurePipelineServices(), decoded, signal) === "busy") return;
    await queue.deleteMessage(message.messageId, message.popReceipt, { abortSignal: signal });
  } catch (e) {
    console.error(JSON.stringify({ event: "live-processing-failed", jobId: decoded.jobId, error: e instanceof Error ? e.message : "Unknown error" }));
    const current = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", decoded.jobId, AbortSignal.timeout(10_000)).catch(() => null);
    if ((current?.attempts ?? 0) >= 3 || e instanceof CapError || e instanceof ScanVerdictError || (e instanceof PipelineError && [400, 403, 404, 409, 413, 415, 422, 507].includes(e.status))) {
      await queue.deleteMessage(message.messageId, message.popReceipt, { abortSignal: AbortSignal.timeout(10_000) });
    } else if (current && current.status === "failed" && current.attempts > 0 && current.blob === decoded.blob && current.owner === decoded.owner) {
      // Retry the same job/checkpoints through a trusted fresh scan (or straight to processing with the live scan off),
      // not through an 11-hour stale verdict. Send before delete preserves at-least-once delivery if the acknowledgement is lost.
      const retrySignal = AbortSignal.timeout(30_000);
      await store.send(liveQueue(), message.messageText, retrySignal);
      await queue.deleteMessage(message.messageId, message.popReceipt, { abortSignal: retrySignal });
    }
    throw e;
  }
}
