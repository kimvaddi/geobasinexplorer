import { randomUUID } from "node:crypto";
import type { AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import { LICENCE } from "../licence";
import { cfg } from "../config";
import { liveScanVerdict, sha256Of } from "../scan-verdict";
import { LIVE_TABLES, LIVE_VECTOR_DIMENSIONS, pageImageBlobName, type DocumentRef, type LineageRow, type SilverDocumentRecord, type SilverPageRecord, type ProcessJobMessage } from "./contracts";
import { PIPELINE_LIMITS, PIPELINE_TABLES, recipe, PipelineError, statusOf } from "./pipeline-config";
import { SOURCE_ARTIFACTS, allowedSource, isArchiveArtifact, sourceBlobName, sourceBytesFor, type PipelineJob } from "./pipeline-registry";
import { MEMBER_TITLES, SHARED_ARCHIVE_MEMBERS, type LiveSourceId } from "./source-policy";
import { documentPrefix, extractionKey, extractionPrefix, normalizeLayout } from "./pipeline-layout";
import type { AnalysisOperation, AnalysisSubmission } from "./pipeline-analysis";
import { requirePng } from "./pipeline-native";
import { extractPdfs } from "./pipeline-zip";
import { immutableBlob, immutableJson, immutableRow, parallelBounded, readJson } from "./pipeline-artifacts";
import { publishExtraction, reviewKey, sameExtraction } from "./pipeline-publish";
import type { ExtractionBundle, PipelineReviewRow, PipelineServices } from "./pipeline-types";
import type { PipelineStore } from "./pipeline-store";

// Only a fully verified immutable PNG is a render checkpoint. Corruption is not repaired by overwriting history.
export async function missingRenderedPages(store: PipelineStore, pages: SilverPageRecord[], signal: AbortSignal): Promise<SilverPageRecord[]> {
  const missing = await parallelBounded(pages, 8, async (page) => {
    const expected = pageImageBlobName({ sourceId: page.sourceId, sha256: page.documentSha256, extractionVersion: page.extractionVersion, page: page.page });
    if (page.imageBlob !== expected) throw new PipelineError(409, "Page image checkpoint name is not bound to this extraction.");
    const stored = await store.read("pages", expected, PIPELINE_LIMITS.imageBytes, signal);
    if (!stored) return page;
    requirePng(stored.buffer);
    const meta = stored.info.metadata;
    if (stored.info.contentType !== "image/png" || stored.info.bytes !== stored.buffer.length || meta.sha256 !== sha256Of(stored.buffer)
      || meta.sourceid !== page.sourceId || meta.documentsha256 !== page.documentSha256 || meta.extractionversion !== page.extractionVersion || meta.page !== String(page.page)) {
      throw new PipelineError(409, "Page image checkpoint integrity or identity differs; no overwrite was attempted.");
    }
    return null;
  });
  return missing.filter((page): page is SilverPageRecord => page !== null);
}

export function decodeProcessMessage(text: string): ProcessJobMessage {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) || !text || text.length > 65536) throw new PipelineError(400, "Invalid queue encoding.");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "base64"));
  let at = 0;
  const white = () => { while (/\s/.test(json[at] ?? "") && at < json.length) at++; };
  const string = () => {
    white(); const start = at; if (json[at++] !== '"') throw new PipelineError(400, "Queue fields must be strings.");
    for (; at < json.length; at++) {
      if (json[at] === "\\") { at++; continue; }
      if (json[at] === '"') { at++; return JSON.parse(json.slice(start, at)) as string; }
    }
    throw new PipelineError(400, "Unterminated queue field.");
  };
  white(); if (json[at++] !== "{") throw new PipelineError(400, "Queue body must be an object.");
  const value: Record<string, string> = Object.create(null);
  for (;;) {
    const key = string(); white(); if (json[at++] !== ":" || Object.hasOwn(value, key)) throw new PipelineError(400, "Duplicate or malformed queue field.");
    value[key] = string(); white(); const separator = json[at++]; if (separator === "}") break;
    if (separator !== ",") throw new PipelineError(400, "Malformed queue object.");
  }
  white(); if (at !== json.length) throw new PipelineError(400, "Trailing queue content.");
  if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== "blob,jobId,owner,route" || value.route !== "process-jobs"
    || typeof value.jobId !== "string" || !/^[a-f0-9-]{36}$/.test(value.jobId) || typeof value.owner !== "string" || !value.owner.trim()
    || typeof value.blob !== "string" || !/^[A-Za-z0-9/_.-]{1,200}$/.test(value.blob) || value.blob.includes("..") || value.blob.startsWith("/")) throw new PipelineError(400, "Invalid processing message.");
  return { jobId: value.jobId, blob: value.blob, owner: value.owner, route: "process-jobs" };
}
// A member another live source already publishes byte-for-byte stays in lineage but is not extracted twice.
export function publishableMembers<T extends { sha256: string }>(sourceId: string, documents: T[], shared: Readonly<Record<string, string>> = SHARED_ARCHIVE_MEMBERS) {
  const own = (pdf: T) => !Object.hasOwn(shared, pdf.sha256) || shared[pdf.sha256] === sourceId;
  return { documents: documents.filter(own), shared: documents.filter((pdf) => !own(pdf)) };
}
export function documentTitle(sourceId: string, memberName: string, sourceTitle: string): string {
  const base = memberName.split("/").pop() ?? memberName, titles = MEMBER_TITLES[sourceId as LiveSourceId];
  if (titles && Object.hasOwn(titles, base)) return titles[base];
  return /glossary/i.test(base) ? "TEGI glossary" : /acknowledg/i.test(base) ? "TEGI acknowledgements" : sourceTitle;
}
async function patchJob(store: PipelineStore, jobId: string, patch: Record<string, unknown>, leaseId?: string, signal?: AbortSignal) {
  const row = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", jobId, signal);
  if (!row || (leaseId && row.leaseId !== leaseId)) throw new Error("Lost pipeline job lease.");
  await store.put(PIPELINE_TABLES.jobs, { partitionKey: "job", rowKey: jobId, ...patch }, row.etag, signal);
}
export async function processLiveJob(store: PipelineStore, services: PipelineServices, message: ProcessJobMessage, signal = AbortSignal.timeout(PIPELINE_LIMITS.jobMs)): Promise<"done" | "busy"> {
  if (!cfg.aiEnabled) throw new PipelineError(503, "AI is switched off; no source is processed or published.");
  let job = await store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", message.jobId, signal);
  if (!job || job.blob !== message.blob || job.owner !== message.owner || job.blob !== sourceBlobName(job.sourceId, job.sha256)) throw new PipelineError(409, "Message is not bound to an authorized landing job.");
  if (["published", "rejected"].includes(job.status)) return "done";
  if (job.status === "review" && job.extractionVersion) {
    const existing = await store.get<PipelineReviewRow>(LIVE_TABLES.reviews, job.sourceId, reviewKey({ ...job, extractionVersion: job.extractionVersion }), signal);
    if (existing?.status === "pending") return "done";
  }
  if (Number(job.leaseUntil) > Date.now()) return "busy";
  const leaseId = randomUUID();
  try { await store.put(PIPELINE_TABLES.jobs, { partitionKey: "job", rowKey: job.rowKey, status: "processing", leaseId, leaseUntil: Date.now() + PIPELINE_LIMITS.leaseMs, attempts: job.attempts + 1 }, job.etag, signal); }
  catch (e) { if (statusOf(e) === 412) return "busy"; throw e; }
  try {
    const { source, etag: registryEtag } = await allowedSource(store, job.sourceId, signal);
    if (source.expectedSha256 !== job.sha256) throw new PipelineError(409, "Landing version is no longer authorized.");
    const scanned = await services.scan(job.blob, job.sha256, signal, sourceBytesFor(job.sourceId));
    if (scanned.sha256 !== job.sha256 || sha256Of(scanned.buffer) !== job.sha256) throw new Error("Scanner did not return the authorized bytes.");
    const scanVerdict = liveScanVerdict(scanned.tags, cfg.live.scan);
    let ref = job.extractionVersion ? { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion } : null;
    const existing = ref ? await store.get<PipelineReviewRow>(LIVE_TABLES.reviews, job.sourceId, reviewKey(ref), signal) : null;
    if (existing) {
      if (!sameExtraction(existing, ref!)) throw new Error("Review identity mismatch.");
      if (existing.status === "approved") {
        const version = await publishExtraction(store, services, ref!, signal, scanned);
        await patchJob(store, job.rowKey, { status: "published", manifestVersion: version, leaseUntil: 0 }, leaseId, signal);
      } else await patchJob(store, job.rowKey, { status: existing.status === "rejected" ? "rejected" : "review", leaseUntil: 0 }, leaseId, signal);
      return "done";
    }
    const recipeJson = JSON.stringify(recipe(await services.rendererVersion(signal)));
    if (job.recipeJson && job.recipeJson !== recipeJson) throw new Error("Recipe changed during an extraction. Land a new job instead of changing its identity.");
    if (!ref) {
      ref = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: `layout-v1-${sha256Of(Buffer.from(recipeJson))}-${randomUUID()}` };
      await patchJob(store, job.rowKey, { extractionVersion: ref.extractionVersion, recipeJson }, leaseId, signal);
      job = { ...job, ...ref, recipeJson };
    }
    const raw = await immutableBlob(store, "raw", job.blob, scanned.buffer, isArchiveArtifact(job.sourceId) ? "application/zip" : "application/pdf", { sourceid: job.sourceId }, signal);
    if (!raw.versionId) throw new Error("Raw blob versioning is required.");
    const archive = extractPdfs(scanned.buffer, SOURCE_ARTIFACTS[job.sourceId].name);
    if (archive.documents.some((pdf) => LICENCE.isWithheldAsset(pdf.name) || LICENCE.isWithheldDocument(pdf.name))) throw new PipelineError(403, "An archive member identifies withheld evidence.");
    const { documents, shared } = publishableMembers(job.sourceId, archive.documents);
    if (!documents.length) throw new PipelineError(422, "Every archive member is already published by another source.");
    const counts: number[] = [];
    for (const pdf of documents) counts.push(await services.countPages(pdf.buffer, signal));
    if (counts.some((n) => !Number.isSafeInteger(n) || n < 1) || counts.reduce((a, b) => a + b, 0) > PIPELINE_LIMITS.pages) throw new PipelineError(413, "Extraction page cap reached.");
    await patchJob(store, job.rowKey, { pageCount: counts.reduce((a, b) => a + b, 0), pageInventoryJson: JSON.stringify(documents.map((pdf, i) => ({ name: pdf.name, documentSha256: pdf.sha256, pages: counts[i] }))),
      sharedMembersJson: JSON.stringify(shared.map((pdf) => ({ name: pdf.name, documentSha256: pdf.sha256, publishedBy: SHARED_ARCHIVE_MEMBERS[pdf.sha256] }))) }, leaseId, signal);
    const bundle: ExtractionBundle = { ...ref, registryEtag, jobId: job.rowKey, createdAt: job.createdAt, documents: [] };
    let pageCount = 0, chunkCount = 0, measured = 0, weighted = 0, minimum: number | null = null, low = 0;
    const samples: string[] = [];
    for (let i = 0; i < documents.length; i++) {
      const pdf = documents[i];
      const docRef: DocumentRef = { ...ref, documentSha256: pdf.sha256, docId: `${job.sourceId}-${pdf.sha256}` };
      const prefix = documentPrefix(docRef), layoutBlob = `${prefix}/layout.json`, title = documentTitle(job.sourceId, pdf.name, source.title);
      let layout = await readJson<AnalyzeResultOutput>(store, layoutBlob, signal);
      if (!layout) {
        layout = await services.analyze(pdf.buffer, counts[i], signal, {
          submission: () => readJson<AnalysisSubmission>(store, `${prefix}/analysis-submission.json`, signal),
          operation: () => readJson<AnalysisOperation>(store, `${prefix}/analysis-operation.json`, signal),
          saveSubmission: async (value) => { await immutableJson(store, `${prefix}/analysis-submission.json`, value, signal); },
          saveOperation: async (value) => { await immutableJson(store, `${prefix}/analysis-operation.json`, value, signal); },
        });
        await immutableJson(store, layoutBlob, layout, signal);
      }
      const normalized = normalizeLayout(layout, counts[i], docRef, source, title);
      const vectors: number[][] = [];
      for (let offset = 0; offset < normalized.chunks.length; offset += 32) {
        const batch = normalized.chunks.slice(offset, offset + 32), checkpoint = `${prefix}/embeddings/${offset}.json`;
        let values = await readJson<number[][]>(store, checkpoint, signal);
        if (!values) {
          values = await services.embeddings(batch.map((c) => c.text), signal);
          if (values.length !== batch.length || values.some((v) => !Array.isArray(v) || v.length !== LIVE_VECTOR_DIMENSIONS || v.some((n) => !Number.isFinite(n)))) throw new Error("Invalid embedding result.");
          await immutableJson(store, checkpoint, values, signal);
        }
        if (values.length !== batch.length || values.some((v) => !Array.isArray(v) || v.length !== LIVE_VECTOR_DIMENSIONS || v.some((n) => !Number.isFinite(n)))) throw new Error("Embedding checkpoint mismatch.");
        vectors.push(...values);
      }
      const record: SilverDocumentRecord = { ...docRef, title, originalName: SOURCE_ARTIFACTS[job.sourceId].name, memberName: archive.members.length ? pdf.name : null,
        rawBlob: job.blob, rawBlobVersionId: raw.versionId, layoutBlob, pageCount: counts[i], chunkCount: normalized.chunks.length,
        confidence: normalized.confidence, licence: source.licence, attribution: source.attribution };
      const entry = { record, blob: `${prefix}/document.json`, pages: [] as string[], chunks: [] as string[] };
      const pagesToRender = await missingRenderedPages(store, normalized.pages, signal);
      if (pagesToRender.length) await services.render(pdf.buffer, pagesToRender, async (page, png) => {
        requirePng(png);
        await immutableBlob(store, "pages", page.imageBlob, png, "image/png", { sourceid: ref!.sourceId, documentsha256: pdf.sha256, extractionversion: ref!.extractionVersion, page: String(page.page) }, signal);
      }, signal);
      for (const page of normalized.pages) {
        const path = `${prefix}/pages/${page.page}.json`; entry.pages.push(path); await immutableJson(store, path, page, signal);
        await immutableRow(store, LIVE_TABLES.pages, { ...docRef, partitionKey: extractionKey(ref), rowKey: `${docRef.docId}_p${page.page}`, page: page.page, recordBlob: path, imageBlob: page.imageBlob }, signal);
      }
      for (let n = 0; n < normalized.chunks.length; n++) {
        const chunk = { ...normalized.chunks[n], vector: vectors[n] }, path = `${prefix}/chunks/${n}.json`; entry.chunks.push(path);
        await immutableJson(store, path, chunk, signal);
        await immutableRow(store, LIVE_TABLES.chunks, { ...docRef, partitionKey: extractionKey(ref), rowKey: chunk.id, id: chunk.id, page: chunk.page, recordBlob: path }, signal);
        if (samples.length < 6) samples.push(chunk.id);
      }
      await immutableJson(store, entry.blob, record, signal);
      await immutableRow(store, LIVE_TABLES.documents, { ...docRef, partitionKey: extractionKey(ref), rowKey: docRef.docId, recordBlob: entry.blob, pageCount: record.pageCount, chunkCount: record.chunkCount }, signal);
      bundle.documents.push(entry); pageCount += record.pageCount; chunkCount += record.chunkCount;
      measured += record.confidence.measuredPages; weighted += (record.confidence.mean ?? 0) * record.confidence.measuredPages; low += record.confidence.lowConfidencePages;
      if (record.confidence.minimum !== null) minimum = Math.min(minimum ?? 1, record.confidence.minimum);
    }
    if (chunkCount > PIPELINE_LIMITS.chunks) throw new PipelineError(507, "Extraction chunk cap reached.");
    await immutableJson(store, `${extractionPrefix(ref)}/extraction.json`, bundle, signal);
    const lineage: LineageRow = { ...ref, partitionKey: ref.sourceId, rowKey: reviewKey(ref), rawBlob: job.blob, rawBlobVersionId: raw.versionId,
      scanVerdict, scanSha256: scanned.sha256, scanTagsJson: JSON.stringify(scanned.tags), archiveMembersJson: JSON.stringify(archive.members),
      extractionRunId: job.rowKey, chunkCount, purviewQualifiedName: `geobasin://${ref.sourceId}/${ref.sha256}/${ref.extractionVersion}` };
    const priorLineage = await store.get<LineageRow>(LIVE_TABLES.lineage, ref.sourceId, reviewKey(ref), signal);
    if (priorLineage) {
      if (!sameExtraction(priorLineage, ref) || priorLineage.rawBlobVersionId !== raw.versionId || priorLineage.scanVerdict !== scanVerdict
        || priorLineage.scanSha256 !== ref.sha256 || priorLineage.extractionRunId !== job.rowKey || priorLineage.chunkCount !== chunkCount
        || priorLineage.archiveMembersJson !== lineage.archiveMembersJson || priorLineage.manifestVersion !== undefined) throw new Error("Existing extraction lineage differs from this retry.");
    } else await immutableRow(store, LIVE_TABLES.lineage, { ...lineage }, signal);
    const pending: PipelineReviewRow = { ...ref, partitionKey: ref.sourceId, rowKey: reviewKey(ref), jobId: job.rowKey, registryEtag,
      status: "pending", createdAt: job.createdAt, pageCount, chunkCount, confidenceJson: JSON.stringify({ minimum, mean: measured ? weighted / measured : null, measuredPages: measured, lowConfidencePages: low }),
      sampleChunkIdsJson: JSON.stringify(samples), decisionJson: "null", publicationStatus: "pending" };
    await immutableRow(store, LIVE_TABLES.reviews, pending, signal);
    if (cfg.live.purview) await services.catalogue(source, priorLineage ?? lineage, undefined, signal);
    await patchJob(store, job.rowKey, { status: "review", detail: "Extraction complete; awaiting owner review. Nothing is indexed.", leaseUntil: 0 }, leaseId, signal);
    return "done";
  } catch (e) {
    await patchJob(store, job.rowKey, { status: "failed", detail: e instanceof PipelineError ? e.message : "Processing failed closed; inspect the job log.", leaseUntil: 0 }, leaseId).catch(() => {});
    if (job.extractionVersion) {
      const ref = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion };
      const row = await store.get<PipelineReviewRow>(LIVE_TABLES.reviews, job.sourceId, reviewKey(ref)).catch(() => null);
      if (row && row.publicationStatus !== "published") await store.put(LIVE_TABLES.reviews, { partitionKey: job.sourceId, rowKey: reviewKey(ref), publicationStatus: "failed", detail: "Processing or publication failed closed; retry the same approval after investigating." }, row.etag).catch(() => {});
    }
    throw e;
  }
}
