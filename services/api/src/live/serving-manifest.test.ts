import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { BlobClient } from "@azure/storage-blob";
import { ManifestReader, clientManifest, manifestDownloadFrom, boundedBytes, MAX_MANIFEST_BYTES, type ManifestDownload } from "./serving-manifest";
import { manifestFixture, bothManifestFixture } from "./serving.test-fixtures";

const response = (version = 1) => ({ status: 200 as const, etag: `"e${version}"`, bytes: Buffer.from(JSON.stringify(manifestFixture(version))) });
const committed = () => ["peps-sa-marabooka-1"];
const readerWithCommitment = (download: ManifestDownload) => new ManifestReader(download, committed);
test("committed manifest reads are strictly validated, cloned and conditionally revalidated every time", async () => {
  let count = 0; const etags: (string | null)[] = [];
  const reader = readerWithCommitment(async (tag) => { etags.push(tag); return ++count === 1 ? response() : { status: 304 }; });
  const first = await reader.read(); assert.equal(first.manifest?.manifestVersion, 1);
  first.manifest!.sources[0].title = "mutated"; assert.notEqual((await reader.read()).manifest!.sources[0].title, "mutated");
  assert.equal(count, 2); assert.deepEqual(etags, [null, '"e1"']);
});
test("empty commitments return null without a first download or a forced refresh", async () => {
  let downloads = 0; const reader = new ManifestReader(async () => { downloads++; return response(); }, () => []);
  for (const options of [{}, { fresh: true }, { fresh: false }, {}]) assert.deepEqual(await reader.read(options), { manifest: null, etag: null });
  assert.equal(downloads, 0);
});
test("clearing commitments hides a cached publication without further storage calls", async () => {
  let configured = committed(), downloads = 0;
  const reader = new ManifestReader(async () => { downloads++; return response(); }, () => configured);
  assert.equal((await reader.read()).manifest?.manifestVersion, 1); configured = [];
  assert.deepEqual(await reader.read({ fresh: true }), { manifest: null, etag: null }); assert.equal(downloads, 1);
});
test("only the committed intersection is returned, while conditional reads validate the complete manifest", async () => {
  const full = bothManifestFixture(), etags: (string | null)[] = []; let configured = ["ga-147461"];
  const reader = new ManifestReader(async (etag) => { etags.push(etag); return etag ? { status: 304 } : { status: 200, etag: '"both"', bytes: Buffer.from(JSON.stringify(full)) }; }, () => configured);
  assert.deepEqual((await reader.read()).manifest?.sources.map((s) => s.sourceId), ["ga-147461"]);
  configured = committed(); assert.deepEqual((await reader.read()).manifest?.sources.map((s) => s.sourceId), configured);
  assert.deepEqual(etags, [null, '"both"']);
});
test("a listed but absent source is closed despite another valid published source", async () => {
  const reader = new ManifestReader(async () => response(), () => ["ga-147461"]);
  assert.deepEqual(await reader.read(), { manifest: null, etag: null });
});
for (const failure of ["missing", "invalid", "access", "truncated", "304-without-cache"]) test(`manifest failure disables rather than retaining last-good content: ${failure}`, async () => {
  let n = 0;
  const reader = readerWithCommitment(async () => {
    if (++n === 1) return response();
    if (failure === "invalid") return { ...response(2), bytes: Buffer.from('{"manifestVersion":2}') };
    if (failure === "truncated") return { ...response(2), bytes: Buffer.from('{') };
    throw { statusCode: failure === "missing" ? 404 : 403 };
  });
  await reader.read(); const closed = await reader.read({ fresh: true }); assert.deepEqual(closed, { manifest: null, etag: null });
  if (failure === "304-without-cache") assert.equal((await readerWithCommitment(async () => ({ status: 304 })).read()).manifest, null);
});
test("rollback requires a higher generation and a same-generation rewrite is refused", async () => {
  let next = response(3); const reader = readerWithCommitment(async () => next);
  await reader.read(); next = response(2); assert.equal((await reader.read({ fresh: true })).manifest, null);
  next = response(3); const manifest = manifestFixture(3); manifest.sources[0].title = "rewritten"; next.bytes = Buffer.from(JSON.stringify(manifest));
  assert.equal((await reader.read({ fresh: true })).manifest, null); next = response(4); assert.equal((await reader.read({ fresh: true })).manifest?.manifestVersion, 4);
});
test("client view removes approval identity and contains no storage path", () => { const client = clientManifest(manifestFixture(), committed()); assert.equal(client.enabled, true); assert.ok(!JSON.stringify(client).includes("owner-test")); assert.ok(!JSON.stringify(client).includes("approval")); assert.equal(clientManifest(null).enabled, false); });
test("manifest downloader observes the real SDK offset/count/conditions/abort contract", async () => {
  const invocations: unknown[][] = [];
  const fake = { download: async (...args: unknown[]) => {
    invocations.push(args); const [offset, count, opts] = args as [number, number, { conditions: { ifNoneMatch?: string }; abortSignal: AbortSignal; maxRetryRequests: number }];
    assert.equal(offset, 0); assert.equal(count, MAX_MANIFEST_BYTES + 1); assert.ok(opts.abortSignal); assert.equal(opts.maxRetryRequests, 0);
    if (opts.conditions.ifNoneMatch) throw { statusCode: 304 };
    return { etag: '"e1"', readableStreamBody: Readable.from(response().bytes) };
  } } as unknown as Pick<BlobClient, "download">;
  const download = manifestDownloadFrom(fake), signal = AbortSignal.timeout(1000);
  assert.equal((await download(null, signal)).status, 200); assert.equal((await download('"e1"', signal)).status, 304); assert.equal(invocations.length, 2);
});
test("bounded body rejects overflow, absent streams and cancellation", async () => {
  await assert.rejects(boundedBytes(Readable.from(Buffer.alloc(10)), 9, AbortSignal.timeout(1000)), /limit/);
  await assert.rejects(boundedBytes(undefined, 9, AbortSignal.timeout(1000)), /Missing/);
  const c = new AbortController(); c.abort(); await assert.rejects(boundedBytes(Readable.from("a"), 9, c.signal));
});
test("concurrent readers share one conditional refresh", async () => { let n = 0; const download: ManifestDownload = async () => { n++; await new Promise((r) => setTimeout(r, 2)); return response(); }; const reader = readerWithCommitment(download); await Promise.all([reader.read(), reader.read(), reader.read()]); assert.equal(n, 1); });
