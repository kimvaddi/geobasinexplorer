import { randomUUID } from "node:crypto";
import { GeographyPoint } from "@azure/search-documents";
import { cfg } from "../config";
import { liveScanVerdict, sha256Of, type ScannedBuffer } from "../scan-verdict";
import type { PipelineJob } from "./pipeline-registry";
import { LICENCE } from "../licence";
import { LIVE_TABLES, CURRENT_MANIFEST_BLOB, LIVE_INDEX_NAME, LIVE_VECTOR_DIMENSIONS, manifestBlobName, pageImageBlobName, validateManifest,
  type ExtractionRef, type LineageRow, type LiveEvidenceRecord, type ManifestSource, type PublicationManifest, type SilverChunkRecord, type SilverPageRecord, type StewardDecisionRecord } from "./contracts";
import { PIPELINE_TABLES, PIPELINE_LIMITS, PipelineError, statusOf } from "./pipeline-config";
import { allowedSource, queueJob, sourceBytesFor } from "./pipeline-registry";
import { extractionPrefix } from "./pipeline-layout";
import { parallelBounded, readJson } from "./pipeline-artifacts";
import type { ExtractionBundle, PipelineReviewRow, PipelineServices } from "./pipeline-types";
import type { PipelineStore, Row } from "./pipeline-store";
export const reviewKey = (ref: ExtractionRef) => `${ref.sha256}_${ref.extractionVersion}`;
export const sameExtraction = (a: ExtractionRef, b: ExtractionRef) => a.sourceId === b.sourceId && a.sha256 === b.sha256 && a.extractionVersion === b.extractionVersion;
export async function reviewRow(store: PipelineStore, ref: ExtractionRef, signal?: AbortSignal) {
  const row = await store.get<PipelineReviewRow>(LIVE_TABLES.reviews, ref.sourceId, reviewKey(ref), signal);
  if (!row || !sameExtraction(row, ref)) throw new PipelineError(404, "No matching source review."); return row;
}
export async function currentManifest(store: PipelineStore, signal?: AbortSignal) {
  const file = await store.read("manifests", CURRENT_MANIFEST_BLOB, 2 * 1024 * 1024, signal);
  if (!file) return null;
  return { manifest: validateManifest(JSON.parse(file.buffer.toString("utf8"))), etag: file.info.etag };
}
async function approvedSource(store: PipelineStore, ref: ExtractionRef, signal: AbortSignal) {
  const { source, etag } = await allowedSource(store, ref.sourceId, signal), review = await reviewRow(store, ref, signal);
  if (source.expectedSha256 !== ref.sha256 || review.registryEtag !== etag || review.status !== "approved") throw new PipelineError(409, "Current registry and steward approval are required for this exact extraction.");
  const approval = JSON.parse(review.decisionJson) as StewardDecisionRecord;
  if (!approval || !sameExtraction(approval, ref) || approval.decision !== "approved" || !approval.by || !approval.at) throw new PipelineError(409, "Invalid steward decision record.");
  return { source, review, approval };
}
function validChunk(chunk: SilverChunkRecord, ref: ExtractionRef, documentSha256: string, pageCount: number) {
  if (!sameExtraction(chunk, ref) || chunk.documentSha256 !== documentSha256 || !Number.isInteger(chunk.page) || chunk.page < 1 || chunk.page > pageCount
    || !chunk.id.startsWith(`${ref.sourceId}_${ref.sha256}_${ref.extractionVersion}_${documentSha256}_c`) || !chunk.text?.trim()
    || chunk.visibility !== "public" || chunk.owner !== "" || !chunk.vector || chunk.vector.length !== LIVE_VECTOR_DIMENSIONS
    || chunk.vector.some((n) => !Number.isFinite(n)) || LICENCE.isWithheldPassage(chunk)) throw new Error("Invalid or unauthorized silver chunk.");
}
// Retain approved extraction chunks. manifestVersion is provenance of the first staging, NOT a serving filter or an index-key component.
// A rollback changes only the manifest's tuple selection; it never deletes or duplicates an approved extraction.
export async function publishExtraction(store: PipelineStore, services: PipelineServices, ref: ExtractionRef, outerSignal: AbortSignal, verified?: ScannedBuffer): Promise<number> {
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(PIPELINE_LIMITS.publicationMs)]);
  const lock = await store.get<Row>(PIPELINE_TABLES.jobs, "lease", "publication", signal), leaseId = randomUUID();
  if (lock && (!Number.isSafeInteger(lock.leaseUntil) || Number(lock.leaseUntil) < 0 || typeof lock.leaseId !== "string")) throw new Error("Invalid publication lease record.");
  if (lock && Number(lock.leaseUntil) > Date.now()) throw new PipelineError(409, "Another publication holds the lease.");
  await store.put(PIPELINE_TABLES.jobs, { partitionKey: "lease", rowKey: "publication", leaseId, leaseUntil: Date.now() + PIPELINE_LIMITS.publicationMs + 60_000 }, lock?.etag, signal);
  try {
    const initial = await currentManifest(store, signal);
    const { source, review, approval } = await approvedSource(store, ref, signal);
    const job = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", review.jobId, signal);
    if (!job || !sameExtraction({ ...job, extractionVersion: job.extractionVersion ?? "" }, ref)) throw new Error("Publication job identity mismatch.");
    const active = initial?.manifest.sources.find((s) => s.sourceId === ref.sourceId);
    if (!active || !sameExtraction(active, ref)) {
      if (job.publicationMode === "republish") {
        if (job.expectedManifestVersion !== (initial?.manifest.manifestVersion ?? 0)) throw new PipelineError(409, "Republish baseline changed; repeat the explicit rollback operation.");
      } else if (review.publishedManifestVersion !== undefined || (active && !(Date.parse(approval.at) > Date.parse(active.approval.at)))) {
        throw new PipelineError(409, "An older approved tuple requires explicit republish or rollback authorization.");
      }
    }
    const scanned = verified ?? await services.scan(job.blob, ref.sha256, signal, sourceBytesFor(job.sourceId));
    liveScanVerdict(scanned.tags, cfg.live.scan);
    if (scanned.sha256 !== ref.sha256 || sha256Of(scanned.buffer) !== ref.sha256) throw new Error("Publication scan hash mismatch.");
    const bundle = await readJson<ExtractionBundle>(store, `${extractionPrefix(ref)}/extraction.json`, signal);
    if (!bundle || !sameExtraction(bundle, ref) || bundle.registryEtag !== review.registryEtag || bundle.jobId !== review.jobId || !bundle.documents.length) throw new Error("Extraction checkpoint is missing or not bound to the review.");
    const chunks: SilverChunkRecord[] = [];
    for (const doc of bundle.documents) {
      if (!sameExtraction(doc.record, ref) || doc.pages.length !== doc.record.pageCount || doc.chunks.length !== doc.record.chunkCount) throw new Error("Incomplete silver document inventory.");
      await parallelBounded(doc.pages, 12, async (path, i) => {
        const page = await readJson<SilverPageRecord>(store, path, signal);
        if (!page || !sameExtraction(page, ref) || page.documentSha256 !== doc.record.documentSha256 || page.page !== i + 1
          || page.imageBlob !== pageImageBlobName({ sourceId: ref.sourceId, sha256: doc.record.documentSha256, extractionVersion: ref.extractionVersion, page: i + 1 })) throw new Error("Invalid page identity.");
        const image = await store.stat("pages", page.imageBlob, signal);
        if (!image || image.bytes < 24 || image.bytes > PIPELINE_LIMITS.imageBytes || image.contentType !== "image/png" || image.metadata.sourceid !== ref.sourceId
          || image.metadata.documentsha256 !== doc.record.documentSha256 || image.metadata.extractionversion !== ref.extractionVersion || image.metadata.page !== String(page.page)
          || !/^[a-f0-9]{64}$/.test(image.metadata.sha256 ?? "")) throw new Error("Page image readiness failed; manifest stays unchanged.");
      });
      const records = await parallelBounded(doc.chunks, 8, async (path) => {
        const chunk = await readJson<SilverChunkRecord>(store, path, signal); if (!chunk) throw new Error("Missing silver chunk.");
        validChunk(chunk, ref, doc.record.documentSha256, doc.record.pageCount);
        if (chunk.licence !== source.licence || chunk.attribution !== source.attribution) throw new Error("Chunk licence differs from approved registry.");
        if (source.wellLocation && (chunk.geotag !== "point" || !chunk.points.some((p) => p.longitude === source.wellLocation!.lon && p.latitude === source.wellLocation!.lat))) throw new Error("Marabooka live geotag readiness failed.");
        return chunk;
      });
      chunks.push(...records);
    }
    if (!chunks.length || new Set(chunks.map((c) => c.id)).size !== chunks.length || chunks.length !== review.chunkCount) throw new Error("Chunk inventory mismatch.");
    const retained = initial?.manifest.sources.filter((s) => s.sourceId !== source.sourceId) ?? [];
    for (const s of retained) {
      await approvedSource(store, s, signal);
      const indexed = await store.indexed(s, signal);
      if (indexed.length !== s.documents.reduce((n, d) => n + d.chunkCount, 0) || indexed.some((c) => c.publishAllowed !== true || c.visibility !== "public")) throw new Error("Retained source index is not ready.");
      for (const d of s.documents) {
        if (indexed.filter((c) => c.documentSha256 === d.sha256).length !== d.chunkCount) throw new Error("Retained document index inventory differs.");
        await parallelBounded(Array.from({ length: d.pageCount }, (_, i) => i + 1), 12, async (page) => {
          const image = await store.stat("pages", pageImageBlobName({ sourceId: s.sourceId, sha256: d.sha256, extractionVersion: s.extractionVersion, page }), signal);
          if (!image || image.contentType !== "image/png" || image.bytes < 45 || image.metadata.documentsha256 !== d.sha256 || image.metadata.extractionversion !== s.extractionVersion) throw new Error("Retained page image is not ready.");
        });
      }
    }
    const entry: ManifestSource = { sourceId: source.sourceId as ManifestSource["sourceId"], sha256: ref.sha256, extractionVersion: ref.extractionVersion,
      publisher: source.publisher, title: source.title, url: source.url, licence: source.licence, attribution: source.attribution, licenceBasis: source.licenceBasis,
      publishAllowed: true, visibility: "public", v1DocIds: source.v1DocIds, wellLocation: source.wellLocation,
      documents: bundle.documents.map(({ record: d }) => ({ docId: d.docId, sha256: d.documentSha256, title: d.title, pageCount: d.pageCount, chunkCount: d.chunkCount })),
      approval: { ...approval, sourceId: source.sourceId as ManifestSource["sourceId"], decision: "approved" } };
    let version = (initial?.manifest.manifestVersion ?? 0) + 1;
    validateManifest({ schemaVersion: 1, manifestVersion: version, createdAt: new Date().toISOString(), indexName: LIVE_INDEX_NAME, sources: [...retained, entry] }, initial?.manifest.manifestVersion ?? 0);
    const alreadyActive = initial?.manifest.sources.some((s) => sameExtraction(s, ref)) ?? false;
    const existing = await store.indexed(ref, signal), existingIds = new Set(existing.map((c) => c.id));
    if (existing.some((c) => !chunks.some((s) => s.id === c.id))) throw new Error("Unexpected indexed chunks for this extraction.");
    const added = chunks.filter((c) => !existingIds.has(c.id)).length;
    const total = await store.countIndex(signal);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(cfg.caps.indexPassages) || cfg.caps.indexPassages < 1) throw new PipelineError(503, "Live index capacity could not be verified.");
    if (total + added > cfg.caps.indexPassages) throw new PipelineError(507, "Live index cap reached.");
    const stagedVersion = review.indexedManifestVersion ?? version;
    if (!review.indexedManifestVersion) await store.put(LIVE_TABLES.reviews, { partitionKey: ref.sourceId, rowKey: reviewKey(ref), indexedManifestVersion: stagedVersion }, review.etag, signal);
    const records: LiveEvidenceRecord[] = chunks.map(({ boundingRegions: _regions, points, ...c }) => ({ ...c, points: points.map((p) => new GeographyPoint(p)), vector: c.vector!, visibility: "public", publishAllowed: true, manifestVersion: stagedVersion }));
    // Do not touch an already indexed approved extraction during rollback; verify it instead.
    if (added) for (let i = 0; i < records.length; i += 64) await store.upload(records.slice(i, i + 64), signal);
    const until = Date.now() + 60_000;
    let indexed: Awaited<ReturnType<PipelineStore["indexed"]>> = [];
    do {
      indexed = await store.indexed(ref, signal);
      if (indexed.length === records.length && indexed.every((c) => records.some((r) => r.id === c.id && r.text === c.text && r.page === c.page && r.documentSha256 === c.documentSha256 && c.publishAllowed === true && c.visibility === "public"))) break;
      if (Date.now() >= until) throw new Error("Indexed chunks did not become ready; manifest stays unchanged.");
      await new Promise((resolve) => setTimeout(resolve, 500)); signal.throwIfAborted();
    } while (true);
    const lineage = await store.get<LineageRow>(LIVE_TABLES.lineage, ref.sourceId, reviewKey(ref), signal);
    if (!lineage) throw new Error("Missing lineage enforcement record.");
    if (alreadyActive) version = initial!.manifest.manifestVersion;
    else {
      // A crashed publication can leave immutable history ahead of current. Skip occupied versions without rewriting them.
      let found = false;
      for (let i = 0; i < 32; i++, version++) {
        if (await store.stat("manifests", manifestBlobName(version), signal)) continue;
        if (cfg.live.purview) await services.catalogue(source, lineage, version, signal);
        for (const retainedSource of retained) {
          const retainedLineage = await store.get<LineageRow>(LIVE_TABLES.lineage, retainedSource.sourceId, reviewKey(retainedSource), signal);
          if (!retainedLineage) throw new Error("Retained source lineage is absent.");
          if (cfg.live.purview) await services.catalogue((await allowedSource(store, retainedSource.sourceId, signal)).source, retainedLineage, version, signal);
        }
        const candidate: PublicationManifest = { schemaVersion: 1, manifestVersion: version, createdAt: new Date().toISOString(), indexName: LIVE_INDEX_NAME, sources: [...retained, entry] };
        validateManifest(candidate, initial?.manifest.manifestVersion ?? 0);
        const bytes = Buffer.from(JSON.stringify(candidate));
        try { await store.write("manifests", manifestBlobName(version), bytes, { ifNoneMatch: "*" }, "application/json", {}, signal); }
        catch (e) { if ([409, 412].includes(statusOf(e) ?? 0)) continue; throw e; }
        liveScanVerdict(scanned.tags, cfg.live.scan);
        await approvedSource(store, ref, signal);
        for (const s of retained) await approvedSource(store, s, signal);
        await store.write("manifests", CURRENT_MANIFEST_BLOB, bytes, initial ? { ifMatch: initial.etag } : { ifNoneMatch: "*" }, "application/json", {}, signal);
        found = true; break;
      }
      if (!found) throw new Error("Manifest version reservation cap reached.");
    }
    // If acknowledgement was lost, replay detects the active tuple and repairs these projection records.
    const freshReview = await reviewRow(store, ref, signal);
    await store.put(LIVE_TABLES.reviews, { partitionKey: ref.sourceId, rowKey: reviewKey(ref), publicationStatus: "published", publishedManifestVersion: version, detail: `Published in manifest v${version}; consult current.json for active selection.` }, freshReview.etag, signal);
    await store.put(LIVE_TABLES.lineage, { partitionKey: ref.sourceId, rowKey: reviewKey(ref), indexName: LIVE_INDEX_NAME, manifestVersion: version, publicationStatus: "published",
      publicationScanTagsJson: JSON.stringify(scanned.tags) }, lineage.etag, signal);
    for (const s of retained) {
      const row = await store.get<LineageRow>(LIVE_TABLES.lineage, s.sourceId, reviewKey(s), signal);
      if (!row) throw new Error("Retained lineage disappeared after activation.");
      await store.put(LIVE_TABLES.lineage, { partitionKey: s.sourceId, rowKey: reviewKey(s), indexName: LIVE_INDEX_NAME, manifestVersion: version, publicationStatus: "published" }, row.etag, signal);
    }
    return version;
  } finally {
    const cleanup = AbortSignal.timeout(10_000);
    const lock = await store.get<Row>(PIPELINE_TABLES.jobs, "lease", "publication", cleanup).catch(() => null);
    if (lock?.leaseId === leaseId) await store.put(PIPELINE_TABLES.jobs, { partitionKey: "lease", rowKey: "publication", leaseUntil: 0 }, lock.etag, cleanup).catch(() => {});
  }
}

// Separate operator intent, bound to the current manifest generation; steward POST retries cannot set this intent.
export async function queueApprovedRepublish(store: PipelineStore, ref: ExtractionRef, signal: AbortSignal) {
  const { review } = await approvedSource(store, ref, signal), current = await currentManifest(store, signal);
  if (current?.manifest.sources.some((s) => sameExtraction(s, ref))) return { queued: false, alreadyActive: true, manifestVersion: current.manifest.manifestVersion };
  const job = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", review.jobId, signal);
  if (!job || !sameExtraction({ ...job, extractionVersion: job.extractionVersion ?? "" }, ref) || Number(job.leaseUntil) > Date.now()) throw new PipelineError(409, "Republish job is absent, mismatched or still leased.");
  await store.put(PIPELINE_TABLES.jobs, { partitionKey: "job", rowKey: job.rowKey, status: "queued", attempts: 0, leaseUntil: 0,
    publicationMode: "republish", expectedManifestVersion: current?.manifest.manifestVersion ?? 0 }, job.etag, signal);
  await queueJob(store, job, signal);
  return { queued: true, alreadyActive: false, baselineManifestVersion: current?.manifest.manifestVersion ?? 0 };
}
