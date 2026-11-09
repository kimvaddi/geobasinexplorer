// The isolated ingestion job (Container Apps job, started by the queue). One execution handles one message:
//  wait for the Defender scan verdict -> only "No threats found" continues -> Document Intelligence OCR (checkpointed)
//  -> the same extraction code as the offline app -> embeddings -> index as private to the uploader -> metrics.
// Anything else (Malicious, Error, Not scanned, no verdict in time) fails the job explicitly. Nothing is silently dropped.
import "./otel";
import { getDocumentProxy } from "unpdf";
import { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";
import { getKG } from "@/lib/kg";
import { extractFromPages, type IngestResult, type PageText } from "@/lib/ingest";
import { blobs, docIntel, embed, queue, search, table, type Passage } from "./azure";
import { geoFields } from "./geo";
import { cfg } from "./config";
import { CapError, keys, record, takeBoth } from "./usage";
import { claimJob, jobStatusOf, setJob, TERMINAL } from "./jobs";
import { KINDS } from "./ingest-api";
import { LICENCE } from "./licence";

const log = (m: string, x: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), m, ...x }));
const keyOf = (id: string) => Buffer.from(id, "utf8").toString("base64url");
const SCAN_WAIT_MS = 10 * 60_000;

async function scanVerdict(blob: string): Promise<string | null> {
  const c = blobs().getContainerClient("quarantine").getBlobClient(blob);
  const t0 = Date.now();
  while (Date.now() - t0 < SCAN_WAIT_MS) {
    const { tags } = await c.getTags();
    const k = Object.keys(tags).find((x) => /scan result/i.test(x));
    if (k) return tags[k];
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return null;
}

async function pdfPages(buf: Buffer): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 } as never);
  return pdf.numPages;
}

/* Pages in a TIFF: walk the chain of image directories. Returns -1 for a damaged file or a loop. */
function tiffPages(buf: Buffer): number {
  if (buf.length < 8) return -1;
  const le = buf[0] === 0x49;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const seen = new Set<number>();
  let off = u32(4), n = 0;
  while (off) {
    if (seen.has(off) || off + 2 > buf.length || n > 10_000) return -1;
    seen.add(off);
    const count = u16(off);
    if (off + 2 + count * 12 + 4 > buf.length) return -1;
    n += 1;
    off = u32(off + 2 + count * 12);
  }
  return n;
}

async function ocr(jobId: string, buf: Buffer, contentType: string) {
  const ck = blobs().getContainerClient("processed").getBlockBlobClient(`${jobId}/analyze.json`);
  if (await ck.exists()) { log("ocr checkpoint reused", { jobId }); return { result: JSON.parse((await ck.downloadToBuffer()).toString("utf8")), ms: 0, reused: true }; }
  const t0 = Date.now();
  const init = await docIntel().path("/documentModels/{modelId}:analyze", "prebuilt-read").post({ contentType: contentType as "application/octet-stream", body: buf });
  if (isUnexpected(init)) throw new Error(`Document Intelligence refused the file: ${JSON.stringify(init.body).slice(0, 200)}`);
  const done = await getLongRunningPoller(docIntel(), init).pollUntilDone();
  const result = (done.body as { analyzeResult?: unknown }).analyzeResult;
  await ck.uploadData(Buffer.from(JSON.stringify(result)), { blobHTTPHeaders: { blobContentType: "application/json" } });
  return { result, ms: Date.now() - t0, reused: false };
}

interface DiPage { pageNumber: number; lines?: { content: string }[]; words?: { confidence: number }[] }

async function rejectLicence(msg: { jobId: string; blob: string }, detail: string) {
  // Delete both locations on every licence rejection, including a resumed OCR checkpoint. A failure at one
  // location must not prevent the other attempt. Soft-delete retention remains a storage-account policy.
  const targets = [["quarantine", msg.blob], ["processed", `${msg.jobId}/analyze.json`]] as const;
  await Promise.all(targets.map(async ([container, name]) => {
    try {
      await blobs().getContainerClient(container).getBlobClient(name).deleteIfExists({ deleteSnapshots: "include" });
      log("licence cleanup completed", { jobId: msg.jobId, container, blob: name });
    } catch (e) { log("licence cleanup failed", { jobId: msg.jobId, container, blob: name, error: (e as Error).message }); }
  }));
  await setJob(msg.jobId, { status: "rejected", detail, leaseUntil: "" });
}

export async function processJob(msg: { jobId: string; blob: string; owner: string }) {
  const { jobId, blob, owner } = msg;
  const row = await table("ingestjobs").getEntity<{ fileName: string; kind: string; status: string }>("job", jobId);
  // A message delivered again after the job finished (its acknowledgement was lost) must not start it over, and a
  // duplicate of a message another execution is working on must not run alongside it.
  const claim = await claimJob(jobId, { status: "scanning", detail: "Waiting for the Microsoft Defender malware scan." });
  if (claim !== "claimed") { log(claim === "finished" ? "already finished" : "another execution holds this job", { jobId, status: row.status }); return; }
  if (LICENCE.isWithheldDocument(row.fileName) || LICENCE.isWithheldAsset(row.fileName)) {
    await rejectLicence(msg, "This source is withheld until its reuse terms are confirmed."); return;
  }
  const t0 = Date.now();
  const verdict = await scanVerdict(blob);
  const scanMs = Date.now() - t0;
  if (verdict === null) throw new Error("No malware-scan verdict arrived in time.");
  if (verdict.toLowerCase() !== "no threats found") {
    await setJob(jobId, { status: "rejected", detail: `Malware scan result: ${verdict}. The file was not read and stays in quarantine.` });
    log("rejected by scan", { jobId, verdict });
    return;
  }

  const qb = blobs().getContainerClient("quarantine").getBlobClient(blob);
  const buf = await qb.downloadToBuffer();
  const kind = KINDS.find((k) => k.test(buf));
  if (!kind) { await setJob(jobId, { status: "failed", detail: "The file's content is not a supported type." }); return; }
  // Pages are counted before anything is read, so the page caps and the page limit apply to every format.
  const totalPages = kind.kind === "pdf" ? await pdfPages(buf).catch(() => -1) : kind.kind === "tiff" ? tiffPages(buf) : 1;
  if (totalPages < 0) { await setJob(jobId, { status: "failed", detail: `The ${kind.kind.toUpperCase()} could not be opened (damaged or encrypted).` }); return; }
  if (totalPages > cfg.caps.maxPages) { await setJob(jobId, { status: "failed", detail: `The file has ${totalPages} pages; this prototype reads at most ${cfg.caps.maxPages}.` }); return; }
  await takeBoth(keys.ocrPages, totalPages, cfg.caps.ocrPagesPerDay, cfg.caps.ocrPagesPerMonth, "OCR pages");

  await setJob(jobId, { status: "reading", detail: `Reading ${totalPages} page${totalPages === 1 ? "" : "s"} with Document Intelligence.` });
  const { result, ms: ocrMs, reused } = await ocr(jobId, buf, kind.mime);
  const diPages = ((result as { pages?: DiPage[] }).pages ?? []);
  // If Document Intelligence read more pages than were counted, those pages are already billed: count them, and stop
  // if the file turns out to be over the page limit.
  if (diPages.length > totalPages) {
    await record(keys.ocrPages, diPages.length - totalPages);
    if (diPages.length > cfg.caps.maxPages) { await setJob(jobId, { status: "failed", detail: `The file has ${diPages.length} pages; this prototype reads at most ${cfg.caps.maxPages}.` }); return; }
  }

  // Page accounting: every page is either read with a confidence, or listed as blank or failed.
  const pages: (PageText & { chars: number; ms: number; conf: number | null; p10: number | null; lowShare: number | null })[] = [];
  const failures: string[] = [];
  for (let n = 1; n <= Math.max(totalPages, diPages.length); n++) {
    const p = diPages.find((x) => x.pageNumber === n);
    const text = (p?.lines ?? []).map((l) => l.content).join("\n").trim();
    const conf = (p?.words ?? []).map((w) => w.confidence).sort((a, b) => a - b);
    const mean = conf.length ? conf.reduce((s, c) => s + c, 0) / conf.length : null;
    const p10 = conf.length ? conf[Math.floor(conf.length * 0.1)] : null;
    const low = conf.length ? conf.filter((c) => c < 0.8).length / conf.length : null;
    if (!p) failures.push(`Page ${n}: not returned by OCR.`);
    else if (!text) failures.push(`Page ${n}: blank or no readable text.`);
    pages.push({ n, text, ocr: false, chars: text.length, ms: diPages.length ? Math.round(ocrMs / diPages.length) : 0, conf: mean, p10, lowShare: low });
  }

  if (pages.some((p) => LICENCE.isWithheldPassage({ doc: row.fileName, text: p.text, visibility: "private" }))) {
    await rejectLicence(msg, "This document contains a source withheld until its reuse terms are confirmed."); return;
  }
  const tExtract = Date.now();
  const title = row.fileName.replace(/\.(pdf|png|jpe?g|tiff?)$/i, "").replace(/[_]+/g, " ").trim() || "Your document";
  const x = extractFromPages(pages, getKG({ ccs: false, lowc: false }), title, jobId);
  if (LICENCE.isWithheldIngestResult({ title, fileName: row.fileName, passageList: x.passages, entities: x.entities })) {
    await rejectLicence(msg, "This document contains evidence withheld until its reuse terms are confirmed."); return;
  }
  const extractMs = Date.now() - tExtract;

  const tIndex = Date.now();
  const inputs = x.passages.map((p) => `${p.h}\n${p.t}`);
  // Embedding tokens count against the same token caps as answers (about four characters a token).
  if (inputs.length) await takeBoth(keys.tokens, Math.ceil(inputs.reduce((n, t) => n + t.length, 0) / 4), cfg.caps.tokensPerDay, cfg.caps.tokensPerMonth, "AI tokens");
  const vectors = inputs.length ? await embed(inputs) : [];
  const docs: Passage[] = x.passages.map((p, i) => ({
    key: keyOf(p.id), id: p.id, doc: title, page: p.page ?? 0, heading: p.h, text: p.t, basin: p.basin ?? null, well: null, kind: "user",
    visibility: "private", owner, docId: jobId, source: `Uploaded by a signed-in tester; original kept at raw/${blob}`, vector: vectors[i],
    // Geotagged like the bundled library, so the upload shows up in place searches (normalize and geotag).
    ...geoFields({ id: p.id, doc: title, heading: p.h, text: p.t, basin: p.basin ?? null, well: null }),
  }));
  for (let i = 0; i < docs.length; i += 100) {
    const r = await search().mergeOrUploadDocuments(docs.slice(i, i + 100));
    const bad = r.results.filter((y) => !y.succeeded);
    if (bad.length) throw new Error(`Indexing failed for ${bad.length} passages: ${bad[0].errorMessage}`);
  }
  const indexMs = Date.now() - tIndex;

  // Keep the immutable original out of quarantine once it has been read. The quarantine copy is deleted last, after the
  // result and the finished status are saved, so a crash part-way can always be retried from the start.
  const raw = blobs().getContainerClient("raw").getBlockBlobClient(blob);
  await raw.uploadData(buf, { blobHTTPHeaders: { blobContentType: kind.mime }, metadata: { jobid: jobId, owner } });

  const confs = pages.map((p) => p.conf).filter((c): c is number => c != null);
  const metrics = {
    pages: Math.max(totalPages, diPages.length), readPages: pages.filter((p) => p.text).length, blankOrFailed: failures.length,
    meanConfidence: confs.length ? +(confs.reduce((s, c) => s + c, 0) / confs.length).toFixed(3) : null,
    worstPageConfidence: confs.length ? +Math.min(...confs).toFixed(3) : null,
    msScanWait: scanMs, msOcr: ocrMs, ocrReusedFromCheckpoint: reused, msExtract: extractMs, msIndex: indexMs, msTotal: Date.now() - t0,
    entities: x.entities.length, places: x.places.length, passages: x.passages.length,
  };
  const out: IngestResult & { metrics: typeof metrics; pageQuality: { n: number; conf: number | null; p10: number | null; lowShare: number | null }[]; scan: string } = {
    docId: jobId, title, fileName: row.fileName, bytes: buf.length, totalPages: Math.max(totalPages, diPages.length), pages: pages.map(({ n, chars, ms, ocr: o }) => ({ n, chars, ms, ocr: o })),
    entities: x.entities, proposed: x.proposed, places: x.places, ages: x.ages, failures: [...new Set([...failures, ...x.failures])],
    passages: x.passages.length, passageList: x.passages, docPoints: x.docPoints,
    ms: { read: ocrMs, extract: extractMs, index: indexMs, total: Date.now() - t0 }, metrics,
    pageQuality: pages.map(({ n, conf, p10, lowShare }) => ({ n, conf: conf == null ? null : +conf.toFixed(3), p10: p10 == null ? null : +p10.toFixed(3), lowShare: lowShare == null ? null : +lowShare.toFixed(3) })),
    scan: verdict,
  };
  await blobs().getContainerClient("processed").getBlockBlobClient(`${jobId}/result.json`).uploadData(Buffer.from(JSON.stringify(out)), { blobHTTPHeaders: { blobContentType: "application/json" } });
  await setJob(jobId, { status: "done", detail: `Read ${metrics.readPages} of ${metrics.pages} pages; ${x.passages.length} passages added, visible only to you.`, metrics: JSON.stringify(metrics), leaseUntil: "" });
  log("done", { jobId, ...metrics });
  await qb.delete().catch((e) => log("quarantine copy not deleted", { jobId, error: (e as Error).message }));
}

export async function runWorker() {
  // One message per execution. The message stays hidden a little longer than the job's 30-minute replica timeout,
  // so a second execution can't pick it up while the first is still working on it. Retries and holds send a fresh copy
  // with a delay (the job's identity may send and process messages, not update them) and then delete this one. The attempt
  // count travels in the message; a message redelivered after a crash counts its deliveries too, so retries stay bounded.
  const [m] = (await queue().receiveMessages({ numberOfMessages: 1, visibilityTimeout: 32 * 60 })).receivedMessageItems;
  if (!m) { log("no message"); return; }
  let msg: { jobId: string; blob: string; owner: string; attempt?: number };
  try { msg = JSON.parse(Buffer.from(m.messageText, "base64").toString("utf8")); }
  catch { log("unreadable message deleted"); await queue().deleteMessage(m.messageId, m.popReceipt); return; }
  const ack = () => queue().deleteMessage(m.messageId, m.popReceipt).catch((e) => log("acknowledgement failed; a later delivery will find the job as it is", { jobId: msg.jobId, error: (e as Error).message }));
  const requeue = async (next: typeof msg, delaySeconds: number) => {
    await queue().sendMessage(Buffer.from(JSON.stringify(next)).toString("base64"), { visibilityTimeout: delaySeconds });
    await ack();
  };
  if (TERMINAL.includes(await jobStatusOf(msg.jobId).catch(() => ""))) { log("already finished", { jobId: msg.jobId }); await ack(); return; }
  if (!cfg.aiEnabled) {
    // The kill switch is on: read nothing. The message comes back in an hour without counting as an attempt, and the
    // file stays in quarantine until reading is switched back on.
    await setJob(msg.jobId, { status: "queued", detail: "Document reading is switched off for now. The file is kept in quarantine and will be read when it is switched back on." }).catch(() => {});
    await requeue({ ...msg }, 3600);
    log("held: AI switched off", { jobId: msg.jobId });
    return;
  }
  const attempt = Math.max(msg.attempt ?? 1, m.dequeueCount ?? 1);
  let failure: Error | null = null;
  try { await processJob(msg); } catch (e) { failure = e as Error; }
  if (!failure) { await ack(); return; }
  // Processing failed (the acknowledgement is handled separately above, so a lost acknowledgement never lands here).
  log("job error", { jobId: msg.jobId, error: failure.message, attempt });
  // Transient problems (scan verdict late, service busy) are tried three times in all; a cap stops at once.
  if (attempt >= 3 || failure instanceof CapError) {
    await setJob(msg.jobId, { status: "failed", detail: `Stopped after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${failure.message}`, leaseUntil: "" }).catch(() => {});
    await ack();
  } else {
    // Release the lease so the retry can claim the job.
    await setJob(msg.jobId, { status: "queued", detail: `Will retry: ${failure.message}`, leaseUntil: "" }).catch(() => {});
    await requeue({ ...msg, attempt: attempt + 1 }, 60);
  }
  return;
}
