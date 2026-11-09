import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { User } from "../auth";
import { cfg } from "../config";
import { LIVE_ROUTES, LIVE_TABLES, LIVE_SOURCE_IDS, validateStewardDecision, ManifestValidationError, pageImageBlobName,
  type SourceReview, type SourceRegistryRow, type SilverChunkRecord, type SilverPageRecord, type ExtractionRef } from "./contracts";
import { PIPELINE_TABLES, PIPELINE_LIMITS, PipelineError } from "./pipeline-config";
import { allowedSource, landArtifact, queueJob, sourceFromRow, type PipelineJob } from "./pipeline-registry";
import { extractionPrefix } from "./pipeline-layout";
import { currentManifest, reviewKey, reviewRow, sameExtraction } from "./pipeline-publish";
import { readJson } from "./pipeline-artifacts";
import { requirePng } from "./pipeline-native";
import { azurePipelineStore, type PipelineStore } from "./pipeline-store";
import type { ExtractionBundle, PipelineReviewRow } from "./pipeline-types";

export const reviewView = (row: PipelineReviewRow): SourceReview => ({ sourceId: row.sourceId, sha256: row.sha256, extractionVersion: row.extractionVersion,
  status: row.status, createdAt: row.createdAt, pageCount: row.pageCount, chunkCount: row.chunkCount, confidence: JSON.parse(row.confidenceJson),
  sampleChunkIds: JSON.parse(row.sampleChunkIdsJson), decision: JSON.parse(row.decisionJson) });
const publication = (row: PipelineReviewRow) => ({ status: row.publicationStatus, ...(row.publishedManifestVersion ? { manifestVersion: row.publishedManifestVersion } : {}), ...(row.detail ? { detail: row.detail } : {}) });
const routeRef = (request: FastifyRequest) => {
  const p = request.params as Record<string, string>;
  return { sourceId: p.sourceId, sha256: p.sha256, extractionVersion: p.extractionVersion };
};
export async function reviewDetail(store: PipelineStore, ref: ExtractionRef, signal?: AbortSignal) {
  const { source } = await allowedSource(store, ref.sourceId, signal), row = await reviewRow(store, ref, signal);
  const bundle = await readJson<ExtractionBundle>(store, `${extractionPrefix(ref)}/extraction.json`, signal);
  if (!bundle || !sameExtraction(bundle, ref) || bundle.jobId !== row.jobId) throw new PipelineError(404, "Review artifacts are not available.");
  const samples: SilverChunkRecord[] = [];
  for (const doc of bundle.documents) for (const path of doc.chunks.slice(0, 3)) {
    const chunk = await readJson<SilverChunkRecord>(store, path, signal);
    if (!chunk || !sameExtraction(chunk, ref)) throw new Error("Review sample identity mismatch.");
    const { vector: _vector, ...sample } = chunk; samples.push(sample);
  }
  return { review: reviewView(row), source, documents: bundle.documents.map((d) => d.record), samples, etag: row.etag, publication: publication(row) };
}
export async function decideSourceReview(store: PipelineStore, ref: ExtractionRef, body: unknown, user: User, ifMatch: string | undefined, signal?: AbortSignal) {
  if (!user.owner) throw new PipelineError(403, "Only an owner can act as steward.");
  const decision = validateStewardDecision(body);
  if (!sameExtraction(decision, ref)) throw new PipelineError(409, "Decision and route identities differ.");
  if (!ifMatch || ifMatch === "*") throw new PipelineError(428, "The current review ETag is required in If-Match.");
  const { source, etag: registryEtag } = await allowedSource(store, ref.sourceId, signal);
  let row = await reviewRow(store, ref, signal);
  if (row.etag !== ifMatch || row.registryEtag !== registryEtag || source.expectedSha256 !== ref.sha256) throw new PipelineError(409, "Review or registry changed; reload before deciding.");
  if (row.status !== "pending") {
    const old = JSON.parse(row.decisionJson);
    if (row.status !== decision.decision || old.reason !== decision.reason) throw new PipelineError(409, "Steward decisions are immutable; create a new extraction instead.");
    if (decision.decision === "approved") {
      const current = await currentManifest(store, signal), active = current?.manifest.sources.find((s) => s.sourceId === ref.sourceId);
      if (active && sameExtraction(active, ref)) return { review: reviewView(row), etag: row.etag,
        publication: { status: "published" as const, manifestVersion: current!.manifest.manifestVersion, detail: "Already active; no publication was queued." } };
      if (row.publishedManifestVersion !== undefined || (active && !(Date.parse(old.at) > Date.parse(active.approval.at)))) {
        throw new PipelineError(409, "An older approved extraction requires an explicit republish or rollback operation, not a retried steward decision.");
      }
    }
  } else {
    await store.put(LIVE_TABLES.reviews, { partitionKey: ref.sourceId, rowKey: reviewKey(ref), status: decision.decision,
      decisionJson: JSON.stringify({ ...decision, by: user.id, at: new Date().toISOString() }), publicationStatus: decision.decision === "approved" ? "queued" : "pending" }, row.etag, signal);
  }
  row = await reviewRow(store, ref, signal);
  if (decision.decision === "approved") {
    const job = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", row.jobId, signal);
    if (!job || job.extractionVersion !== ref.extractionVersion || job.sha256 !== ref.sha256 || job.sourceId !== ref.sourceId) throw new Error("Missing bound pipeline job.");
    if (Number(job.leaseUntil) > Date.now()) throw new PipelineError(409, "The processing job is still finishing; retry this approval shortly.");
    await store.put(PIPELINE_TABLES.jobs, { partitionKey: "job", rowKey: job.rowKey, status: "queued", leaseUntil: 0, attempts: 0, publicationMode: "approval" }, job.etag, signal);
    // Queue bodies never authorize publication. A fresh scan is required, even for an old approved extraction/rollback.
    try { await queueJob(store, job, signal); }
    catch (e) { await store.put(LIVE_TABLES.reviews, { partitionKey: ref.sourceId, rowKey: reviewKey(ref), publicationStatus: "failed", detail: "Approval saved, but enqueue failed. Retry the same decision with the latest ETag." }, row.etag).catch(() => {}); throw e; }
    await store.put(LIVE_TABLES.reviews, { partitionKey: ref.sourceId, rowKey: reviewKey(ref), publicationStatus: "queued", detail: "Approved; scan and publication queued. Not yet published." }, row.etag, signal);
    row = await reviewRow(store, ref, signal);
  }
  return { review: reviewView(row), etag: row.etag, publication: publication(row) };
}
export async function registerLiveAdminRoutes(parent: FastifyInstance, who: (request: FastifyRequest) => User, store = azurePipelineStore()) {
  await parent.register(async (app) => {
    const error = (reply: FastifyReply, e: unknown) => reply.code(e instanceof PipelineError ? e.status : e instanceof ManifestValidationError ? 400 : 503)
      .send({ error: e instanceof PipelineError || e instanceof ManifestValidationError ? e.message : "Live pipeline request failed closed. Inspect the operator log and retry." });
    app.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try { if (!who(request).owner) return reply.code(403).send({ error: "Owner access is required." }); }
      catch (e) { return error(reply, e); }
    });
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: PIPELINE_LIMITS.sourceBytes }, (_req, body, done) => done(null, body));
    app.put(LIVE_ROUTES.sourceContent.path, { bodyLimit: PIPELINE_LIMITS.sourceBytes, onRequest: async (req, reply) => {
      try { if (!cfg.aiEnabled) throw new PipelineError(503, "AI processing is switched off."); await allowedSource(store, (req.params as { id: string }).id, AbortSignal.timeout(15_000)); }
      catch (e) { return error(reply, e); }
    } }, async (request, reply) => {
      try {
        if (request.headers["content-type"] !== "application/octet-stream" || !Buffer.isBuffer(request.body)) throw new PipelineError(415, "Send raw application/octet-stream bytes, not multipart or JSON.");
        const result = await landArtifact(store, (request.params as { id: string }).id, request.body, who(request).id, AbortSignal.timeout(90_000));
        return reply.code(202).send(result);
      } catch (e) { return error(reply, e); }
    });
    app.get(LIVE_ROUTES.reviews.path, async (_request, reply) => {
      try {
        const reviews: SourceReview[] = [], registry = [], signal = AbortSignal.timeout(30_000);
        for (const id of LIVE_SOURCE_IDS) {
          const source = await store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, "source", id, signal);
          if (source) registry.push(sourceFromRow(source));
          for (const row of await store.list<PipelineReviewRow>(LIVE_TABLES.reviews, id, 100, signal)) reviews.push(reviewView(row));
        }
        return { reviews: reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), registry };
      } catch (e) { return error(reply, e); }
    });
    app.get(LIVE_ROUTES.review.path, async (request, reply) => {
      try { const result = await reviewDetail(store, routeRef(request), AbortSignal.timeout(30_000)); reply.header("ETag", result.etag); return result; } catch (e) { return error(reply, e); }
    });
    app.post(LIVE_ROUTES.reviewDecision.path, async (request, reply) => {
      try {
        const result = await decideSourceReview(store, routeRef(request), request.body, who(request), request.headers["if-match"], AbortSignal.timeout(30_000));
        reply.header("ETag", result.etag); return reply.code(result.publication.status === "queued" ? 202 : 200).send(result);
      } catch (e) { return error(reply, e); }
    });
    app.get(LIVE_ROUTES.reviewPage.path, async (request, reply) => {
      try {
        const ref = routeRef(request), p = request.params as { documentSha256: string; page: string }, n = Number(p.page), signal = AbortSignal.timeout(30_000);
        await allowedSource(store, ref.sourceId, signal); await reviewRow(store, ref, signal);
        const bundle = await readJson<ExtractionBundle>(store, `${extractionPrefix(ref)}/extraction.json`, signal);
        const doc = bundle?.documents.find((d) => d.record.documentSha256 === p.documentSha256);
        if (!bundle || !sameExtraction(bundle, ref) || !doc || !Number.isInteger(n) || n < 1 || n > doc.record.pageCount) throw new PipelineError(404, "No page belongs to this review.");
        const page = await readJson<SilverPageRecord>(store, doc.pages[n - 1], signal), name = pageImageBlobName({ ...ref, sha256: p.documentSha256, page: n });
        if (!page || !sameExtraction(page, ref) || page.documentSha256 !== p.documentSha256 || page.page !== n || page.imageBlob !== name) throw new PipelineError(404, "No matching review page.");
        const image = await store.read("pages", name, PIPELINE_LIMITS.imageBytes, signal); if (!image || image.info.contentType !== "image/png") throw new PipelineError(404, "Review page image unavailable.");
        requirePng(image.buffer); return reply.type("image/png").send(image.buffer);
      } catch (e) { return error(reply, e); }
    });
  });
}
