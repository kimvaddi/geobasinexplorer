import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { fetchArchiveMember } from "./archive-member";
import { crc32 } from "./pipeline-zip";

interface Entry { name: string; data: Buffer; method?: 0 | 8; flags?: number; localName?: string; compressed?: number; local?: number }
interface Shape { zip64?: boolean; comment?: number; disks?: [number, number]; locator?: [number, number] }
interface Layout { directory: number; size: number; record: number; members: Record<string, { local: number; data: number; compressed: number }> }
// A ZIP built in memory, with the layout a reader should find. zip64 saturates the classic end-of-directory fields and
// every entry's sizes and local offset, and writes the ZIP64 end record, locator and extra fields (central and local) that
// large publisher archives use. An entry can misstate its local name, compressed size or local offset, and the archive its disks.
function zip(entries: Entry[], { zip64 = false, comment = 0, disks = [0, 0], locator: [locatorDisk, diskCount] = [0, 1] }: Shape = {}) {
  const parts: Buffer[] = [], central: Buffer[] = [], members: Layout["members"] = {}; let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8, body = method === 8 ? deflateRawSync(e.data) : e.data, name = Buffer.from(e.name), crc = crc32(e.data);
    const compressed = e.compressed ?? body.length, local = Buffer.alloc(30), localExtra = Buffer.alloc(zip64 ? 20 : 0);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(45, 4); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : body.length, 18); local.writeUInt32LE(zip64 ? 0xffffffff : e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localExtra.length, 28);
    if (zip64) { localExtra.writeUInt16LE(1, 0); localExtra.writeUInt16LE(16, 2); localExtra.writeBigUInt64LE(BigInt(e.data.length), 4); localExtra.writeBigUInt64LE(BigInt(body.length), 12); }
    const head = Buffer.alloc(46), extra = Buffer.alloc(zip64 ? 28 : 0);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(45, 4); head.writeUInt16LE(45, 6); head.writeUInt16LE(e.flags ?? 0, 8); head.writeUInt16LE(method, 10); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(zip64 ? 0xffffffff : compressed, 20); head.writeUInt32LE(zip64 ? 0xffffffff : e.data.length, 24); head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(extra.length, 30); head.writeUInt32LE(zip64 ? 0xffffffff : e.local ?? offset, 42);
    if (zip64) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(e.data.length), 4); extra.writeBigUInt64LE(BigInt(compressed), 12); extra.writeBigUInt64LE(BigInt(e.local ?? offset), 20); }
    parts.push(local, Buffer.from(e.localName ?? e.name), localExtra, body); central.push(head, name, extra);
    members[e.name] = { local: offset, data: offset + 30 + name.length + localExtra.length, compressed: body.length };
    offset += 30 + name.length + localExtra.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), record = Buffer.alloc(56), locator = Buffer.alloc(20);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(disks[0], 4); end.writeUInt16LE(disks[1], 6); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16); end.writeUInt16LE(comment, 20);
  record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32); record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
  locator.writeUInt32LE(0x07064b50, 0); locator.writeUInt32LE(locatorDisk, 4); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(diskCount, 16);
  const archive = Buffer.concat([...parts, directory, ...(zip64 ? [record, locator] : []), end, Buffer.alloc(comment, 0x20)]);
  return { archive, layout: { directory: offset, size: directory.length, record: offset + directory.length, members } satisfies Layout };
}
interface Reply { start: number; end: number; total: number; body: Buffer; etag: string | null }
// A publisher that answers byte-range requests the way CloudFront does (206, Content-Range and a strong ETag) and records
// what it was asked for. `tamper` rewrites its reply to the n-th request, for a publisher that misbehaves.
function publisher(archive: Buffer, tamper: (reply: Reply, n: number) => Reply = (r) => r, ignoreRange = false) {
  const ranges: string[] = []; let served = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.redirect, "error");
    const range = new Headers(init?.headers).get("range") ?? ""; ranges.push(range);
    if (ignoreRange) return new Response(new Uint8Array(archive), { status: 200, headers: { "content-length": String(archive.length) } });
    const suffix = /^bytes=-(\d+)$/.exec(range), span = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = suffix ? Math.max(0, archive.length - Number(suffix[1])) : Number(span![1]), end = suffix ? archive.length - 1 : Math.min(Number(span![2]), archive.length - 1);
    const r = tamper({ start, end, total: archive.length, body: archive.subarray(start, end + 1), etag: '"v1"' }, ranges.length - 1); served += r.body.length;
    const headers: Record<string, string> = { "content-range": `bytes ${r.start}-${r.end}/${r.total}`, "content-length": String(r.body.length), ...(r.etag ? { etag: r.etag } : {}) };
    return new Response(new Uint8Array(r.body), { status: 206, headers });
  }) as typeof fetch;
  return { fetchImpl, ranges, served: () => served };
}
const shift = (archive: Buffer, by: number) => (r: Reply): Reply => ({ ...r, start: r.start + by, end: r.end + by, body: archive.subarray(r.start + by, r.end + by + 1) });
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);
const signal = () => AbortSignal.timeout(5_000);
async function refused(archive: Buffer, refusal: RegExp, { name = "r.pdf", maxBytes = 60_000_000, tamper = undefined as ((r: Reply, n: number) => Reply) | undefined } = {}) {
  const p = publisher(archive, tamper);
  await assert.rejects(fetchArchiveMember("https://example.test/r.zip", name, maxBytes, signal(), p.fetchImpl), refusal);
  return p.ranges.length;
}

test("one stored or deflated PDF member is read by byte ranges, never by downloading the archive", async () => {
  const grids = randomBytes(3 * 1024 * 1024), report = pdf("inversion report ".repeat(2_000)), guide = pdf("user guide");
  const { archive } = zip([{ name: "grids/conductivity.ers", data: grids, method: 0 }, { name: "reports/HSK_Inversion_Report.pdf", data: report }, { name: "reports/guide.pdf", data: guide, method: 0 }]);
  for (const [name, expected] of [["reports/HSK_Inversion_Report.pdf", report], ["reports/guide.pdf", guide]] as const) {
    const p = publisher(archive);
    assert.deepEqual(await fetchArchiveMember("https://example.test/a.zip", name, 60_000_000, signal(), p.fetchImpl), expected);
    assert.ok(p.ranges.every((r) => r.startsWith("bytes=")), "every request is a byte range");
    assert.ok(p.served() < 200_000, `served ${p.served()} bytes of a ${archive.length}-byte archive`);
  }
});
test("a ZIP64 archive behind a full-length comment is read through its ZIP64 records and local extra fields, with exactly the ranges it needs", async () => {
  const report = pdf("isostatic residual ".repeat(3_000)), guide = pdf("user guide");
  const { archive, layout } = zip([{ name: "grids/residual.ers", data: randomBytes(100_000), method: 0 }, { name: "IsostaticResidualAustraliaReport_2111.pdf", data: report },
    { name: "guide.pdf", data: guide, method: 0 }], { zip64: true, comment: 65_535 });
  for (const [name, expected] of [["IsostaticResidualAustraliaReport_2111.pdf", report], ["guide.pdf", guide]] as const) {
    const p = publisher(archive), m = layout.members[name];
    assert.deepEqual(await fetchArchiveMember("https://example.test/b.zip", name, 60_000_000, signal(), p.fetchImpl), expected);
    // The comment fills the tail, so the ZIP64 end record and the directory each need their own range.
    assert.deepEqual(p.ranges, ["bytes=-65577", `bytes=${layout.record}-${layout.record + 55}`, `bytes=${layout.directory}-${layout.directory + layout.size - 1}`,
      `bytes=${m.local}-${m.local + 30 + name.length - 1}`, `bytes=${m.data}-${m.data + m.compressed - 1}`]);
  }
});
test("a publisher that ignores, shortens, shifts or swaps a byte range is refused before its bytes are parsed", async () => {
  const { archive } = zip([{ name: "padding.bin", data: randomBytes(100_000), method: 0 }, { name: "r.pdf", data: pdf("report ".repeat(500)) }]);
  const p = publisher(archive, undefined, true);
  await assert.rejects(fetchArchiveMember("https://example.test/c.zip", "r.pdf", 60_000_000, signal(), p.fetchImpl), /did not honour a byte-range request/);
  // Request 0 is the tail, which holds this directory; 1 is the member's local header and 2 its compressed bytes.
  const cases: [(r: Reply, n: number) => Reply, RegExp][] = [
    [(r, n) => n === 0 ? shift(archive, -10)(r) : r, /different byte range/],
    [(r, n) => n === 1 ? { ...r, end: r.start + 9, body: r.body.subarray(0, 10) } : r, /different byte range/],
    [(r, n) => n === 2 ? shift(archive, 10)(r) : r, /different byte range/],
    [(r, n) => n === 2 ? { ...r, start: r.start + 10, body: r.body.subarray(10) } : r, /different byte range/],
    [(r, n) => n === 2 ? { ...r, body: r.body.subarray(1) } : r, /does not match its content/],
    [(r, n) => n === 1 ? { ...r, total: r.total + 1 } : r, /changed between byte ranges/],
    [(r, n) => n === 2 ? { ...r, etag: '"v2"' } : r, /changed between byte ranges/],
  ];
  for (const [tamper, refusal] of cases) await refused(archive, refusal, { tamper });
});
test("a missing, corrupted, encrypted, oversized or misdescribed member, or a split archive, is refused", async () => {
  const report = pdf("report ".repeat(500)), entry = { name: "r.pdf", data: report }, padding = { name: "padding.bin", data: randomBytes(60_000), method: 0 as const };
  const ok = zip([entry]).archive, corrupt = Buffer.from(ok); corrupt[40] ^= 0xff;
  await refused(ok, /was not found/, { name: "other.pdf" });
  await refused(corrupt, /inflation failed|CRC mismatch/);
  await refused(zip([{ ...entry, flags: 1 }]).archive, /Encrypted/);
  // Size bounds are decided from the directory, before any of the member is read.
  assert.equal(await refused(ok, /exceeds its registered bound/, { maxBytes: 100 }), 1);
  assert.equal(await refused(zip([{ ...entry, compressed: 50_000 }, padding]).archive, /exceeds its registered bound/, { maxBytes: 10_000 }), 1);
  // Neither a local header nor compressed bytes may reach into the central directory.
  assert.equal(await refused(zip([{ ...entry, local: 1_000_000 }]).archive, /escapes its payload/), 1);
  await refused(zip([{ ...entry, compressed: deflateRawSync(report).length + 30 }]).archive, /escapes its payload/);
  await refused(zip([{ ...entry, localName: "s.pdf" }]).archive, /local header mismatch/);
  for (const disks of [[1, 0], [0, 1]] as const) await refused(zip([entry], { disks: [...disks] }).archive, /Split archives/);
  for (const locator of [[1, 1], [0, 2]] as const) await refused(zip([entry], { zip64: true, locator: [...locator] }).archive, /ZIP64 locator missing or split/);
});
