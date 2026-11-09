// Upload side of ingestion: the API only accepts, checks and queues. Reading happens in the isolated
// ingestion job, and only after Microsoft Defender for Storage has scanned the file (docs/SECURITY.md).
import type { MultipartFile } from "@fastify/multipart";
import { blobs, queue, search, table } from "./azure";
import { cfg } from "./config";
import type { User } from "./auth";
import { keys, take } from "./usage";
import { LICENCE } from "./licence";

export const KINDS: { kind: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { kind: "pdf", mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { kind: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: "jpeg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: "tiff", mime: "image/tiff", test: (b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a) },
];
const safeName = (s: string) => s.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "_").slice(0, 120) || "document";

// Index statistics need a control-plane role (Learn, search-security-rbac), so the size guard counts passages with the
// read-only query role the web identity already holds.
async function libraryPassages(): Promise<number> {
  try { return await search().getDocumentsCount(); }
  catch { throw new Error("Library size could not be checked, so the upload was refused."); }
}

export async function startIngest(file: MultipartFile, user: User): Promise<{ status: number; body: unknown }> {
  if (LICENCE.isWithheldDocument(file.filename) || LICENCE.isWithheldAsset(file.filename)) { file.file.resume(); return { status: 400, body: { error: "This source is withheld in the cloud build until its reuse terms are confirmed." } }; }
  // The kill switch stops document reading too (OCR and embeddings are model calls).
  if (!cfg.aiEnabled) { file.file.resume(); return { status: 503, body: { error: "Adding documents is switched off for now. Please try again later." } }; }
  // Nothing unscanned is read or published, so with malware scanning paused nothing is accepted at all.
  if (!cfg.malwareScan) { file.file.resume(); return { status: 503, body: { error: "Adding documents is paused while malware scanning is switched off during the build-out. Nothing uploaded now could be checked, so nothing is accepted." } }; }
  const buf = await file.toBuffer();
  if (file.file.truncated) return { status: 413, body: { error: `Files can be at most ${Math.round(cfg.caps.uploadBytes / 1048576)} MB.` } };
  const kind = KINDS.find((k) => k.test(buf));
  if (!kind) return { status: 415, body: { error: "Only PDF, PNG, JPEG and TIFF files are accepted (checked by content, not by name)." } };
  if ((await libraryPassages()) >= cfg.caps.indexPassages) return { status: 507, body: { error: "The library is full for this prototype, so new documents can't be added. Ask the owner." } };
  await take(keys.userUploads(user.id), 1, cfg.caps.uploadsPerUserPerDay, "uploads per person");

  const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const name = safeName(file.filename);
  const blob = `uploads/${jobId}/${name}`;
  await blobs().getContainerClient("quarantine").getBlockBlobClient(blob).uploadData(buf, {
    blobHTTPHeaders: { blobContentType: kind.mime },
    metadata: { jobid: jobId, owner: user.id, kind: kind.kind },
  });
  const at = new Date().toISOString();
  await table("ingestjobs").createEntity({ partitionKey: "job", rowKey: jobId, owner: user.id, ownerName: user.name, fileName: file.filename.slice(0, 200), blob, kind: kind.kind, bytes: buf.length, status: "queued", detail: "Waiting for the malware scan.", createdAt: at, updatedAt: at });
  await queue().sendMessage(Buffer.from(JSON.stringify({ jobId, blob, owner: user.id })).toString("base64"));
  return { status: 202, body: { jobId, status: "queued", detail: "Uploaded to quarantine. It is read only after the malware scan finds no threats." } };
}

export async function jobStatus(id: string, user: User) {
  let row: Record<string, unknown>;
  try { row = await table("ingestjobs").getEntity("job", id); } catch { return null; }
  if (row.owner !== user.id && !user.owner) return null;
  if (LICENCE.isWithheldDocument(row.fileName) || LICENCE.isWithheldAsset(String(row.fileName ?? ""))) return null;
  let result: unknown = null;
  if (row.status === "done") {
    try {
      const b = await blobs().getContainerClient("processed").getBlobClient(`${id}/result.json`).downloadToBuffer();
      result = JSON.parse(b.toString("utf8"));
    } catch { result = null; }
  }
  if (result && LICENCE.isWithheldIngestResult(result)) return null;
  return { jobId: id, status: row.status, detail: row.detail, fileName: row.fileName, bytes: row.bytes, createdAt: row.createdAt, updatedAt: row.updatedAt, metrics: row.metrics ? JSON.parse(String(row.metrics)) : null, result };
}
