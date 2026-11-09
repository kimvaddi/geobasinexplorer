import { LIVE_TABLES } from "./contracts";
import { PIPELINE_TABLES, PipelineError } from "./pipeline-config";
import { allowedSource, queueJob, sourceBlobName, type PipelineJob } from "./pipeline-registry";
import { reviewKey } from "./pipeline-publish";
import type { PipelineReviewRow } from "./pipeline-types";
import type { PipelineStore } from "./pipeline-store";
// Operator-only retry of incomplete processing. It cannot select an already reviewed extraction for publication.
export async function queueProcessingRetry(store: PipelineStore, jobId: string, signal: AbortSignal) {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new PipelineError(400, "Invalid processing job ID.");
  const job = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", jobId, signal);
  if (!job || !["failed", "queued", "processing"].includes(job.status) || Number(job.leaseUntil) > Date.now()) throw new PipelineError(409, "Processing job is absent, complete or still leased.");
  const { source } = await allowedSource(store, job.sourceId, signal);
  if (source.expectedSha256 !== job.sha256 || job.blob !== sourceBlobName(job.sourceId, job.sha256)) throw new PipelineError(409, "Retry source is no longer authorized.");
  if (job.extractionVersion) {
    const review = await store.get<PipelineReviewRow>(LIVE_TABLES.reviews, job.sourceId, reviewKey({ ...job, extractionVersion: job.extractionVersion }), signal);
    if (review) throw new PipelineError(409, "This extraction already has a steward review; use review or explicit republish, not processing retry.");
  }
  await store.put(PIPELINE_TABLES.jobs, { partitionKey: "job", rowKey: jobId, status: "queued", attempts: 0, leaseUntil: 0,
    publicationMode: "approval", detail: "Explicit processing retry queued through a fresh scan; existing checkpoints retained." }, job.etag, signal);
  await queueJob(store, job, signal);
  return { jobId, queued: true, sourceId: job.sourceId, extractionVersion: job.extractionVersion ?? null };
}
