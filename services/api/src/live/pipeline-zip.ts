import { inflateRawSync } from "node:zlib";
import { sha256Of } from "../scan-verdict";
import { PIPELINE_LIMITS, PipelineError } from "./pipeline-config";
import type { ArchiveMember } from "./contracts";
const bad = (message: string): never => { throw new PipelineError(422, message); };
const table = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
export function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const b of bytes) crc = table[(crc ^ b) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
export interface ExtractedPdf { name: string; buffer: Buffer; sha256: string }
export function extractPdfs(buffer: Buffer, originalName: string): { documents: ExtractedPdf[]; members: ArchiveMember[] } {
  if (buffer.subarray(0, 5).toString() === "%PDF-") return { documents: [{ name: originalName, buffer, sha256: sha256Of(buffer) }], members: [] };
  if (buffer.length < 22 || buffer.length > PIPELINE_LIMITS.sourceBytes) bad("Invalid archive size.");
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  if (end < 0) bad("ZIP directory not found.");
  const count = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16), size = buffer.readUInt32LE(end + 12);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count
    || count < 1 || count > PIPELINE_LIMITS.archiveEntries || offset + size !== end) bad("Split, ZIP64 or oversized ZIP directory refused.");
  let cursor = offset, expanded = 0;
  const documents: ExtractedPdf[] = [], members: ArchiveMember[] = [], names = new Set<string>(), ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) bad("Malformed ZIP central entry.");
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), bytes = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32), local = buffer.readUInt32LE(cursor + 42), mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    if (cursor + 46 + nameLen + extra + comment > end || flags & 1 || ![0, 8].includes(method) || bytes > PIPELINE_LIMITS.sourceBytes || compressed > buffer.length
      || buffer.readUInt16LE(cursor + 34) || (mode & 0xf000) === 0xa000 || (expanded += bytes) > PIPELINE_LIMITS.expandedBytes) bad("Encrypted, linked, unsupported or oversized ZIP entry.");
    let name: string; try { name = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(cursor + 46, cursor + 46 + nameLen)); } catch { return bad("Invalid ZIP filename encoding."); }
    if (!/^[A-Za-z0-9][A-Za-z0-9_. /-]{0,199}$/.test(name) || name.includes("\\") || name.split("/").some((x, n, a) => x === ".." || x === "." || (!x && n !== a.length - 1)) || names.has(name.toLowerCase())) bad("Unsafe or duplicate ZIP path.");
    names.add(name.toLowerCase());
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) bad("ZIP local header mismatch.");
    const localNameLen = buffer.readUInt16LE(local + 26), start = local + 30 + localNameLen + buffer.readUInt16LE(local + 28), finish = start + compressed;
    if (start > offset || finish > offset || buffer.subarray(local + 30, local + 30 + localNameLen).toString("utf8") !== name
      || ranges.some(([a, b]) => local < b && finish > a)) bad("ZIP entry overlaps or escapes its payload.");
    ranges.push([local, finish]);
    const payload = buffer.subarray(start, finish);
    let data: Buffer; try { data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: Math.max(1, Math.min(bytes, PIPELINE_LIMITS.sourceBytes)) }); } catch { return bad("ZIP inflation failed or exceeded its declared bound."); }
    if (data.length !== bytes || crc32(data) !== crc) bad("ZIP member length or CRC mismatch.");
    const sha256 = sha256Of(data); members.push({ name, sha256, bytes });
    if (name.endsWith("/")) { if (bytes) bad("Nonempty archive directory."); }
    else if (!/\.pdf$/i.test(name) || data.subarray(0, 5).toString() !== "%PDF-") bad("Every non-directory member must be a PDF in the live lane; nothing was silently omitted.");
    else documents.push({ name, buffer: data, sha256 });
    cursor += 46 + nameLen + extra + comment;
  }
  if (cursor !== end || !documents.length || new Set(documents.map((d) => d.sha256)).size !== documents.length) bad("Archive has ambiguous or missing PDF members.");
  return { documents, members };
}
