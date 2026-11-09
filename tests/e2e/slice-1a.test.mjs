import assert from "node:assert/strict";
import { test } from "node:test";
import { selfTest, parseOptions, assertRollback, assertBlocked, assertPackagedQ10, forbiddenStorageRequest, assertStageHealth, assertDocumentInventory, assertPagePng, pageReferences, verifyPageImages, verifyPublishedStage } from "./slice-1a.mjs";
test("slice fact checks cannot pass on the alternate velocity datum", selfTest);
test("acceptance runner is read-only and refuses insecure origins", () => { for (const arg of ["--deploy", "--approve", "--start-job"]) assert.throws(() => parseOptions([arg])); assert.throws(() => parseOptions(["--site", "http://example.test"])); });
test("rollback requires the new generation, changed revision and matching source commitments", () => {
  const manifest = { requiredSourceIds: ["test"], enabled: true, manifestVersion: 1, sources: [{ sourceId: "test", sha256: "a", extractionVersion: "run1", documents: [{ docId: "doc", sha256: "b", pageCount: 2 }] }] };
  const target = { health: { revision: "old" }, manifest }, previous = { health: { revision: "new" }, manifest: { ...manifest, manifestVersion: 2 } };
  const current = { health: { revision: "rollback" }, manifest: { ...manifest, manifestVersion: 3 } };
  assertRollback(current, previous, target, "rollback"); assert.throws(() => assertRollback({ ...current, manifest: { ...current.manifest, requiredSourceIds: [] } }, previous, target, "rollback")); assert.throws(() => assertRollback({ ...current, health: previous.health }, previous, target, "new")); assert.throws(() => assertRollback({ ...current, manifest }, previous, target, "rollback"));
});
test("withheld answer must contain no leaked derivatives", () => {
  const a = { label: "Not found", reason: "Reuse terms not confirmed", citations: [], hits: [] }; assertBlocked(a); assert.throws(() => assertBlocked({ ...a, table: { rows: [["value"]] } }));
});

test("pre-publication acceptance requires the packaged 0.12.0 answer, never Not found or a live citation", () => {
  const a = { label: "Precomputed", status: "answered", paragraphs: ["6326 ft below KB; KB 181.9 ft gives 6144.1 ft below sea level."], citations: [{ id: "legacy" }] };
  assertPackagedQ10(a); assert.throws(() => assertPackagedQ10({ ...a, label: "Not found" }));
  assert.throws(() => assertPackagedQ10({ ...a, citations: [{ id: "live", live: { sourceId: "peps-sa-marabooka-1" } }] }));
});

test("network gate allows ordinary Atlas URLs but blocks every storage host and case-insensitive SAS signature", () => {
  assert.equal(forbiddenStorageRequest("https://us.atlas.microsoft.com/map/tile?zoom=5"), false);
  for (const url of ["https://a.blob.core.windows.net/p/1.png", "https://a.privatelink.blob.core.windows.net/p/1.png", "https://a.dfs.core.windows.net/p/1.png", "https://us.atlas.microsoft.com/map/tile?sig=secret", "https://example.test/api/pages/1?SIG=secret"]) assert.equal(forbiddenStorageRequest(url), true);
});

function liveFixtures() {
  const extractionVersion = "layout-fixture";
  const doc = (docId, title, pages, char) => ({ docId, title, pageCount: pages, chunkCount: pages * 2, sha256: char.repeat(64) });
  const report = doc("marabooka-report", "Marabooka 1 report", 420, "d"), guide = doc("cooper-guide", "TEGI_GEOLOGY-Cooper_Basin_Region.pdf", 5, "b");
  const manifest = { enabled: true, manifestVersion: 3, requiredSourceIds: ["ga-147461", "peps-sa-marabooka-1"], sources: [
    { sourceId: "peps-sa-marabooka-1", sha256: "e".repeat(64), extractionVersion, documents: [report] },
    { sourceId: "ga-147461", sha256: "f".repeat(64), extractionVersion, documents: [doc("glossary", "TEGI glossary", 11, "c"), doc("ga-ack", "Geoscience Australia acknowledgements", 3, "a"), guide] },
  ] };
  const citation = (id, sourceId, document, page) => ({ id, page, live: { sourceId, documentSha256: document.sha256, extractionVersion, manifestVersion: 3 } });
  const q10 = { label: "Retrieved", validation: { status: "passed" }, paragraphs: ["Top is 6326 ft below KB; minus KB elevation 181.9 ft gives 6144.1 ft below sea level."],
    citations: [citation("mar-25", "peps-sa-marabooka-1", report, 25)],
    computations: [{ tool: "convert_depth_kb_to_subsea", formula: "depthBelowKbFt - kbElevationFt", output: { value: 6144.1 }, inputs: [
      { name: "depthBelowKbFt", value: 6326, unit: "ft", evidenceId: "mar-25" }, { name: "kbElevationFt", value: 181.9, unit: "ft", evidenceId: "mar-25" }], sourceIds: ["mar-25"] }],
    trace: [{ step: "Computed from source evidence", detail: "6326 - 181.9 = 6144.1" }] };
  const q01 = { label: "Retrieved", validation: { status: "passed" }, paragraphs: ["The guide uses 16 play intervals."], citations: [citation("guide-1", "ga-147461", guide, 1)] };
  const q11 = { reason: "Validation incomplete", validation: { status: "incomplete" }, citations: [] };
  return { manifest, answers: { Q10: q10, Q01: q01, Q11: q11 } };
}
const pngResult = (r) => ({ status: 200, path: r.path, contentType: "image/png", cacheControl: "private, no-store", signature: "89504e470d0a1a0a", bytes: 100, width: 1, height: 1 });

test("every stage requires health ai to be the boolean true", () => {
  for (const stage of ["before", "after", "rollback"]) {
    assertStageHealth({ ai: true }, stage);
    for (const ai of [false, undefined, "true", 1]) assert.throws(() => assertStageHealth({ ai }, stage), /ai: true/);
  }
});
test("inventory matches all four PDFs by title or docId, independent of order", () => {
  const { manifest } = liveFixtures(), docs = assertDocumentInventory(manifest);
  assert.deepEqual(docs.map((d) => [d.kind, d.pageCount]), [["acknowledgement", 3], ["cooper-guide", 5], ["glossary", 11], ["marabooka-report", 420]]);
  manifest.sources.reverse(); for (const s of manifest.sources) s.documents.reverse();
  assert.deepEqual(assertDocumentInventory(manifest), docs);
  manifest.sources.find((s) => s.sourceId === "ga-147461").documents.find((d) => d.docId === "cooper-guide").title = "Scanned PDF";
  assert.equal(assertDocumentInventory(manifest).find((d) => d.kind === "cooper-guide").pageCount, 5);
});
test("missing, additional, duplicate or wrong-sized PDFs fail the complete inventory gate", () => {
  for (const change of [
    (m) => m.sources[1].documents.pop(),
    (m) => m.sources[1].documents.push({ ...m.sources[1].documents[0], docId: "extra" }),
    (m) => { m.sources[1].documents[1] = { ...m.sources[1].documents[0] }; },
    (m) => { m.sources[0].documents[0].pageCount = 419; },
    (m) => { m.sources[1].documents.find((d) => d.docId === "cooper-guide").pageCount = 40; },
    (m) => { m.sources[1].documents.find((d) => d.docId === "glossary").pageCount = 10; },
    (m) => { m.sources[1].documents.find((d) => d.docId === "ga-ack").pageCount = 2; },
  ]) { const { manifest } = liveFixtures(); change(manifest); assert.throws(() => assertDocumentInventory(manifest)); }
});
test("after publication all 439 page images must reopen, including each document's last page", async () => {
  const { manifest, answers } = liveFixtures(), inventory = assertDocumentInventory(manifest), seen = [];
  const proof = await verifyPageImages(inventory, Object.values(answers), async (r) => { seen.push(r); return pngResult(r); }, true);
  assert.equal(seen.length, 439); assert.equal(new Set(seen.map((r) => r.path)).size, 439);
  for (const d of inventory) assert.ok(seen.some((r) => r.kind === d.kind && r.page === d.pageCount));
  assert.deepEqual(proof.map((d) => d.verifiedPages.length), [3, 5, 11, 420]);
  await assert.rejects(verifyPageImages(inventory, Object.values(answers), async (r) => ({ ...pngResult(r), status: r.kind === "glossary" && r.page === 11 ? 404 : 200 }), true), /glossary page 11/);
});
test("rollback reopens real answer citations and a manifest-bound page for otherwise uncited PDFs", async () => {
  const { manifest, answers } = liveFixtures(), inventory = assertDocumentInventory(manifest);
  const refs = pageReferences(inventory, Object.values(answers), false);
  assert.equal(refs.length, 4); assert.equal(refs.find((r) => r.kind === "marabooka-report").page, 25);
  assert.equal(refs.find((r) => r.kind === "marabooka-report").basis, "answer citation");
  assert.equal(refs.find((r) => r.kind === "acknowledgement").basis, "manifest page citation");
  assert.ok(refs.every((r) => r.path === `/api/pages/${r.sourceId}/${r.documentSha256}/${r.page}`));
  const proof = await verifyPageImages(inventory, Object.values(answers), async (r) => pngResult(r), false);
  assert.ok(proof.every((d) => d.verifiedPages.length >= 1));
  for (const change of [{ status: 404 }, { contentType: "text/html" }, { signature: "not png" }, { width: 0 }, { path: "/wrong" }, { cacheControl: "public, max-age=3600" }]) assert.throws(() => assertPagePng({ ...pngResult(refs[0]), ...change }, refs[0]));
});
test("an answer cannot reopen a different extraction, unknown document or out-of-range page", () => {
  for (const change of [(c) => { c.live.documentSha256 = "f".repeat(64); }, (c) => { c.live.extractionVersion = "stale"; }, (c) => { c.page = 421; }]) {
    const { manifest, answers } = liveFixtures(); change(answers.Q10.citations[0]);
    assert.throws(() => pageReferences(assertDocumentInventory(manifest), Object.values(answers), false));
  }
});
for (const stage of ["after", "rollback"]) test(`${stage} executes Q10, Q11, Q01 and image checks, not just metadata`, async () => {
  const { manifest, answers } = liveFixtures(), asked = [], reopened = [];
  const result = await verifyPublishedStage(stage, manifest, { ask: async (id) => { asked.push(id); return { data: answers[id], elapsed: 10 }; }, reopen: async (r) => { reopened.push(r); return pngResult(r); } });
  assert.deepEqual(asked, ["Q10", "Q11", "Q01"]); assert.equal(result.inventory.length, 4);
  assert.equal(reopened.length, stage === "after" ? 439 : 4);
  for (const id of ["Q10", "Q01"]) {
    const broken = structuredClone(answers); broken[id].paragraphs = [id === "Q10" ? "6147 ft at KB 179 ft." : "There are 15 play intervals."];
    await assert.rejects(verifyPublishedStage(stage, manifest, { ask: async (qid) => ({ data: broken[qid], elapsed: 10 }), reopen: async (r) => pngResult(r) }));
  }
});
