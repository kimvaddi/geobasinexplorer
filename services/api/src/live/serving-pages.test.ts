import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { activePage, registerLiveServingRoutes } from "./serving-pages";
import { manifestFixture, bothManifestFixture, documentHash, artifactHash } from "./serving.test-fixtures";

const enabled = () => ["peps-sa-marabooka-1"];
const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
const user = { id: "u", name: "User", roles: [], owner: false };
const url = (hash = documentHash, page = "25") => `/api/pages/peps-sa-marabooka-1/${hash}/${page}`;
test("only a native page of a current manifest PDF is reopenable, not the landed artifact hash", () => {
  const m = manifestFixture(); assert.ok(activePage(m, "peps-sa-marabooka-1", documentHash, 420));
  for (const page of [0, -1, 421, 1.5, Infinity]) assert.equal(activePage(m, "peps-sa-marabooka-1", documentHash, page), null);
  assert.equal(activePage(m, "peps-sa-marabooka-1", artifactHash, 25), null); assert.equal(activePage(null, "peps-sa-marabooka-1", documentHash, 25), null);
});
test("page streams a private PNG through the API and revalidates the manifest before returning", async () => {
  const app = Fastify(); let reads = 0, downloads = 0;
  registerLiveServingRoutes(app, () => user, { read: async (opts) => { assert.equal(opts?.fresh, true); reads++; return { manifest: manifestFixture(), etag: '"a"' }; } }, async (name, signal) => { assert.ok(signal); assert.ok(name.includes(`/${documentHash}/layout-v1-`)); downloads++; return png; }, enabled);
  try { const r = await app.inject(url()); assert.equal(r.statusCode, 200); assert.equal(r.headers["cache-control"], "private, no-store"); assert.match(r.headers["content-type"]!, /image\/png/); assert.deepEqual(r.rawPayload, png); assert.equal(reads, 2); assert.equal(downloads, 1); } finally { await app.close(); }
});
for (const [hash, page] of [[artifactHash, "25"], [documentHash, "0"], [documentHash, "01"], [documentHash, "1e2"], [documentHash, "421"]]) test(`page route rejects invalid document/page ${hash.slice(0, 2)} ${page}`, async () => {
  const app = Fastify(); registerLiveServingRoutes(app, () => user, { read: async () => ({ manifest: manifestFixture(), etag: '"a"' }) }, async () => { throw new Error("Must not download"); }, enabled);
  try { assert.equal((await app.inject(url(hash, page))).statusCode, 404); } finally { await app.close(); }
});
test("a withdrawal during download and a non-PNG body both fail closed", async () => {
  for (const withdraw of [false, true]) {
    const app = Fastify(); let reads = 0;
    registerLiveServingRoutes(app, () => user, { read: async () => ({ manifest: withdraw && ++reads > 1 ? null : manifestFixture(), etag: '"a"' }) }, async () => withdraw ? png : Buffer.from("not a PNG"), enabled);
    try { assert.equal((await app.inject(url())).statusCode, 404); } finally { await app.close(); }
  }
});
test("manifest route is authenticated, client-safe and never cached", async () => {
  const app = Fastify(); let auth = 0; registerLiveServingRoutes(app, () => { auth++; return user; }, { read: async () => ({ manifest: manifestFixture(), etag: '"a"' }) }, undefined, enabled);
  try { const r = await app.inject("/api/live/manifest"); assert.equal(auth, 1); assert.equal(r.statusCode, 200); assert.equal(r.headers["cache-control"], "private, no-store"); assert.equal(r.json().enabled, true); assert.ok(!r.body.includes("owner-test")); } finally { await app.close(); }
});

test("empty commitments do not read storage, expose publication or serve any public page", async () => {
  const app = Fastify(); let reads = 0, downloads = 0;
  registerLiveServingRoutes(app, () => user, { read: async () => { reads++; return { manifest: bothManifestFixture(), etag: '"a"' }; } }, async () => { downloads++; return png; }, () => []);
  try {
    const response = await app.inject("/api/live/manifest"); assert.equal(response.json().enabled, false); assert.deepEqual(response.json().sources, []);
    assert.equal((await app.inject(url())).statusCode, 404); assert.equal(reads, 0); assert.equal(downloads, 0);
  } finally { await app.close(); }
});
test("public pages and client metadata expose only the committed intersection, not every approved document", async () => {
  const app = Fastify(); let downloads = 0;
  registerLiveServingRoutes(app, () => user, { read: async () => ({ manifest: bothManifestFixture(), etag: '"both"' }) }, async () => { downloads++; return png; }, () => ["ga-147461"]);
  try {
    const view = (await app.inject("/api/live/manifest")).json(); assert.deepEqual(view.sources.map((s: { sourceId: string }) => s.sourceId), ["ga-147461"]);
    assert.equal((await app.inject(url())).statusCode, 404); assert.equal(downloads, 0);
    assert.equal((await app.inject(`/api/pages/ga-147461/${"f".repeat(64)}/1`)).statusCode, 200); assert.equal(downloads, 1);
  } finally { await app.close(); }
});
