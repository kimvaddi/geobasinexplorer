import { inflateRawSync } from "node:zlib";
import { boundedResponse } from "./pipeline-http";
import { PipelineError } from "./pipeline-config";
import { crc32 } from "./pipeline-zip";

// Reads one PDF member out of a publisher's ZIP with HTTP range requests, so a multi-gigabyte data package is never
// downloaded whole: the tail (end of central directory, and the ZIP64 records when present), the central directory, the
// member's local header and its compressed bytes. The member's name is pinned in code beside the archive URL
// (SOURCE_ARTIFACTS); its size and CRC-32 are checked here, and landing checks its SHA-256 against the pin.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const TAIL = 22 + 65_535 + 20, DIRECTORY_BYTES = 16 * 1024 * 1024, ENTRIES = 100_000;
const bad = (message: string, status = 422): never => { throw new PipelineError(status, message); };

// One byte range, refused unless the publisher returns exactly the window asked for, out of the same archive (the same
// length and ETag) as the tail, so a short, shifted or replaced response is never parsed as ZIP structure. A suffix
// request (`from` null) asks for the last `length` bytes, or the whole archive when it is shorter (RFC 9110, 14.1.2).
async function range(url: string, from: number | null, length: number, archive: { total: number; tag: string | null } | null, signal: AbortSignal, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, { redirect: "error", signal, headers: { Range: `bytes=${from === null ? `-${length}` : `${from}-${from + length - 1}`}`, "Accept-Encoding": "identity" } });
  const refuse = async (message: string): Promise<never> => { await response.body?.cancel().catch(() => {}); return bad(message, 502); };
  if (response.status !== 206) return refuse("The publisher did not honour a byte-range request.");
  const m = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(response.headers.get("content-range") ?? "");
  if (!m) return refuse("The publisher's byte range is malformed.");
  const [start, end, total] = m.slice(1).map(Number), tag = response.headers.get("etag");
  if (archive && (total !== archive.total || tag !== archive.tag)) return refuse("The publisher's archive changed between byte ranges.");
  if (start !== (from ?? Math.max(0, total - length)) || end !== (from === null ? total - 1 : from + length - 1)) return refuse("The publisher returned a different byte range from the one requested.");
  const bytes = await boundedResponse(response, end - start + 1);
  if (bytes.length !== end - start + 1) bad("The publisher's byte range does not match its content.", 502);
  return { bytes, start, total, tag };
}

export async function fetchArchiveMember(url: string, member: string, maxBytes: number, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const tail = await range(url, null, TAIL, null, signal, fetchImpl), t = tail.bytes, base = tail.start;
  const read = async (from: number, length: number) => (await range(url, from, length, tail, signal, fetchImpl)).bytes;
  let eocd = -1;
  for (let i = t.length - 22; i >= 0; i--) if (t.readUInt32LE(i) === 0x06054b50 && i + 22 + t.readUInt16LE(i + 20) === t.length) { eocd = i; break; }
  if (eocd < 0) bad("ZIP directory not found.");
  if (t.readUInt16LE(eocd + 4) || t.readUInt16LE(eocd + 6)) bad("Split archives are refused.");
  let count = t.readUInt16LE(eocd + 10), size = t.readUInt32LE(eocd + 12), offset = t.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || t.readUInt32LE(locator) !== 0x07064b50 || t.readUInt32LE(locator + 4) || t.readUInt32LE(locator + 16) !== 1) bad("ZIP64 locator missing or split.");
    const at = Number(t.readBigUInt64LE(locator + 8));
    if (!Number.isSafeInteger(at) || at + 56 > tail.total) bad("ZIP64 directory record out of bounds.");
    const record = at >= base ? t.subarray(at - base, at - base + 56) : await read(at, 56);
    if (record.length !== 56 || record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20)) bad("Invalid ZIP64 directory record.");
    count = Number(record.readBigUInt64LE(32)); size = Number(record.readBigUInt64LE(40)); offset = Number(record.readBigUInt64LE(48));
  }
  if (![count, size, offset].every(Number.isSafeInteger) || count < 1 || count > ENTRIES || size < 46 || size > DIRECTORY_BYTES || offset + size > tail.total) bad("ZIP directory out of bounds.");
  const directory = offset >= base ? t.subarray(offset - base, offset - base + size) : await read(offset, size);
  const wanted = Buffer.from(member, "utf8");
  for (let p = 0, n = 0; n < count; n++) {
    if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) bad("Malformed ZIP central entry.");
    const flags = directory.readUInt16LE(p + 8), method = directory.readUInt16LE(p + 10), crc = directory.readUInt32LE(p + 16);
    let compressed = directory.readUInt32LE(p + 20), bytes = directory.readUInt32LE(p + 24), local = directory.readUInt32LE(p + 42);
    const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) bad("Malformed ZIP central entry.");
    if (directory.subarray(p + 46, p + 46 + nameLength).equals(wanted)) {
      // ZIP64 extended information: each value appears only when its 32-bit field is saturated, in this order.
      for (let q = p + 46 + nameLength, end = q + extraLength; q + 4 <= end;) {
        const id = directory.readUInt16LE(q), length = directory.readUInt16LE(q + 2);
        if (q + 4 + length > end) bad("Malformed ZIP extra field.");
        if (id === 1) {
          let at = q + 4;
          const take = () => { if (at + 8 > q + 4 + length) bad("Malformed ZIP64 extra field."); const v = Number(directory.readBigUInt64LE(at)); at += 8; return v; };
          if (bytes === 0xffffffff) bytes = take();
          if (compressed === 0xffffffff) compressed = take();
          if (local === 0xffffffff) local = take();
        }
        q += 4 + length;
      }
      if (flags & 1) bad("Encrypted archive members are refused.");
      if (method !== 0 && method !== 8) bad("Unsupported archive compression.");
      if (![bytes, compressed, local].every(Number.isSafeInteger) || bytes < 1 || compressed < 1) bad("Invalid archive member sizes.");
      if (bytes > maxBytes || compressed > maxBytes) bad("The archive member exceeds its registered bound.", 413);
      if (local + 30 + nameLength > offset) bad("The archive member escapes its payload.");
      const header = await read(local, 30 + nameLength);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== method || header.readUInt16LE(26) !== nameLength || !header.subarray(30).equals(wanted)) bad("ZIP local header mismatch.");
      const start = local + 30 + nameLength + header.readUInt16LE(28);
      if (start + compressed > offset) bad("The archive member escapes its payload.");
      const payload = await read(start, compressed);
      let data: Buffer;
      try { data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: bytes }); } catch { return bad("Archive member inflation failed or exceeded its declared size."); }
      if (data.length !== bytes || crc32(data) !== crc) bad("Archive member length or CRC mismatch.");
      return data;
    }
    p = next;
  }
  return bad("The registered archive member was not found.");
}
