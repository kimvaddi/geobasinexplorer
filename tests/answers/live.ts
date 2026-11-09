// node tools/run-ts.mjs tests/answers/live.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { livePagePath, liveMapMarkers, parseClientManifest, routePath, liveMapStatus, EMPTY_LIVE, reviewReasonError, REVIEW_REASON_MAX_LENGTH, liveApi } from "@/lib/live";

import { manifestFixture, documentHash, extractionVersion } from "../../services/api/src/live/serving.test-fixtures";
import { validateStewardDecision } from "../../services/api/src/live/contracts";
import type { Citation } from "@/lib/ask";
const clientManifest = (m: ReturnType<typeof manifestFixture>) => ({ requiredSourceIds: m.sources.map((s) => s.sourceId), enabled: true, manifestVersion: m.manifestVersion, createdAt: m.createdAt, sources: m.sources });
const cite = (): Citation => ({ id: "l1", doc: "Report", page: 25, heading: "Test", text: "Source", basin: "cooper", live: { sourceId: "peps-sa-marabooka-1", documentSha256: documentHash, extractionVersion, manifestVersion: 1 } });
test("live citations resolve only to same-origin API pages, never storage or supplied URLs", () => {
  assert.equal(livePagePath(cite()), `/api/pages/peps-sa-marabooka-1/${documentHash}/25`);
  assert.equal(livePagePath({ ...cite(), live: undefined }), null); assert.equal(livePagePath({ ...cite(), page: 0 }), null);
  assert.equal(livePagePath({ ...cite(), live: { ...cite().live!, sourceId: "../private" } }), null);
  assert.throws(() => routePath("https://storage.example/:sha256", { sha256: documentHash }), /same-origin/);
});
test("published marker uses manifest coordinates; an uncommitted empty lane keeps the packaged marker", () => {
  const markers = [{ id: "marabooka-1", label: "Marabooka", lon: 0, lat: 0, kind: "legacy" as const, tag: "report" }, { id: "other", label: "Other", lon: 141, lat: -28, kind: "legacy" as const, tag: "report" }];
  const m = parseClientManifest(clientManifest(manifestFixture())); const live = liveMapMarkers(markers, m);
  assert.equal(live.find((s) => s.id === "marabooka-1")?.lon, 140.6102); assert.match(live[0].tag, /packaged snapshot/);
  assert.equal(liveMapMarkers(markers, EMPTY_LIVE), markers);
  assert.equal(liveMapStatus(EMPTY_LIVE), null);
  const missing = { ...EMPTY_LIVE, requiredSourceIds: ["peps-sa-marabooka-1"] };
  assert.deepEqual(liveMapMarkers(markers, missing).map((s) => s.id), ["other"]);
  assert.ok(!JSON.stringify(liveMapMarkers(markers, missing)).includes("packaged snapshot"));
  assert.equal(liveMapStatus(missing), "Live publication unavailable.");
});
test("bad client manifest coordinates and hashes fail closed", () => {
  const m = clientManifest(manifestFixture()); assert.equal(parseClientManifest({ enabled: false }).enabled, false);
  if (!m.enabled) throw new Error("Missing fixture"); m.sources[0].wellLocation!.lon = NaN; assert.throws(() => parseClientManifest(m));
});

test("a different published source labels but does not remove an unmigrated Marabooka marker", () => {
  const m = clientManifest(manifestFixture());
  m.sources[0] = { ...m.sources[0], sourceId: "ga-147461", wellLocation: null }; m.requiredSourceIds = ["ga-147461"];
  const markers = [{ id: "marabooka-1", label: "Marabooka", lon: 140.6, lat: -28.1, kind: "legacy" as const, tag: "report" }];
  const visible = liveMapMarkers(markers, parseClientManifest(m)); assert.equal(visible.length, 1);
  assert.equal(visible[0].lon, markers[0].lon); assert.match(visible[0].tag, /packaged snapshot/);
});

test("an existing client publication with no commitments cannot replace the packaged marker or add labels", () => {
  const view = { ...clientManifest(manifestFixture()), requiredSourceIds: [] };
  const decoded = parseClientManifest(view); assert.equal(decoded.enabled, false); assert.deepEqual(decoded.sources, []);
  const markers = [{ id: "marabooka-1", label: "Marabooka", lon: 140.6, lat: -28.1, kind: "legacy" as const, tag: "report" }];
  assert.equal(liveMapMarkers(markers, view), markers); assert.equal(liveMapStatus(view), null);
});

test("the shared review reason limit accepts 500 and rejects 501 in both client and contract", async () => {
  assert.equal(REVIEW_REASON_MAX_LENGTH, 500);
  const ref = { sourceId: "peps-sa-marabooka-1", sha256: "a".repeat(64), extractionVersion, decision: "approved" as const };
  assert.equal(reviewReasonError("x".repeat(500)), null);
  assert.match(reviewReasonError("x".repeat(501))!, /500/);
  assert.equal(validateStewardDecision({ ...ref, reason: "x".repeat(500) }).reason.length, 500);
  assert.throws(() => validateStewardDecision({ ...ref, reason: "x".repeat(501) }));
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(JSON.parse(String(init?.body)).reason.length, 500); return new Response("{}", { status: 200 }); };
  try {
    await liveApi.decide({ ...ref, reason: "x".repeat(500) }, 'W/"review"');
    assert.throws(() => liveApi.decide({ ...ref, reason: "x".repeat(501) }, 'W/"review"'), /500/);
    assert.equal(calls, 1, "A 501-character reason must not be sent");
  } finally { globalThis.fetch = original; }
});
