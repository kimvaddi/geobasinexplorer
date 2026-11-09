import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLiveRoute, parseLiveSources } from "../config";
import { packagedExclusion, packagedFilter, packagedAllowed, labelPackaged, migratedLiveSources, namesWell, requiredLiveSources, routedLiveSources, unavailablePreparedSources, unavailableV1DocIds, wellLiveSources } from "./serving-policy";
import { ManifestReader, clientManifest } from "./serving-manifest";
import { baseAnswer, manifestFixture, bothManifestFixture } from "./serving.test-fixtures";

const committed = ["peps-sa-marabooka-1"];
const cited = (doc = "Marabooka 1 · completion report"): ReturnType<typeof baseAnswer> => ({ ...baseAnswer(), citations: [{ id: "p1", doc, page: 25, text: "test", basin: "cooper", heading: "Test" }] });
test("empty manifest and empty commitment preserve the complete 0.12.0 policy", () => {
  assert.equal(packagedExclusion(null, []), ""); assert.equal(packagedFilter("original filter", null, []), "original filter");
  assert.equal(packagedAllowed({ docId: "cooper-report", doc: "Cooper report" }, null, []), true);
  assert.equal(packagedAllowed({ docId: "marabooka-1-completion-report", doc: "Marabooka 1 · completion report" }, null, []), true);
  assert.deepEqual(requiredLiveSources(cited(), null), []); assert.deepEqual(unavailablePreparedSources(cited(), null, []), []);
  const a = cited(); assert.equal(labelPackaged(a, null), a); assert.equal(a.citations[0].provenanceLabel, undefined);
});
test("one live source excludes only its manifest mappings, not every slice family", () => {
  const m = manifestFixture(); m.sources[0].v1DocIds.push("custom-report");
  assert.match(packagedExclusion(m, committed), /custom-report/); assert.ok(!packagedExclusion(m, committed).includes("cooper-report"));
  assert.equal(packagedAllowed({ docId: "custom-report", doc: "Other" }, m, committed), false);
  assert.equal(packagedAllowed({ docId: "cooper-report", doc: "Cooper report" }, m, committed), true);
  assert.deepEqual(requiredLiveSources(cited(), m, committed), ["peps-sa-marabooka-1"]);
  assert.deepEqual(requiredLiveSources(cited("Cooper report"), m, committed), []);
});
test("question wording alone never skips a prepared answer whose own citations are unrelated", () => {
  const a = cited("Adavale report"); a.question = "Compare Cooper play intervals and Marabooka 1";
  assert.deepEqual(requiredLiveSources(a, manifestFixture(), committed), []);
  assert.deepEqual(unavailablePreparedSources(a, null, ["ga-147461", "peps-sa-marabooka-1"]), []);
});
test("a committed source missing from a partial manifest fails closed without affecting other families", () => {
  const m = manifestFixture();
  assert.deepEqual(unavailablePreparedSources(cited("Cooper report"), m, ["ga-147461"]), ["ga-147461"]);
  assert.deepEqual(unavailablePreparedSources(cited(), m, ["ga-147461"]), []);
  assert.match(packagedExclusion(m, ["ga-147461"]), /cooper-report/);
  assert.deepEqual(requiredLiveSources(cited(), m, ["ga-147461"]), []);
  assert.equal(packagedAllowed({ docId: "marabooka-1-completion-report", doc: "Report" }, m, ["ga-147461"]), true);
  assert.equal(packagedAllowed({ docId: "adavale-report", doc: "Adavale report" }, m, ["ga-147461"]), true);
});
test("missing manifest closes only explicitly committed source families", () => {
  const committed = ["peps-sa-marabooka-1"];
  assert.deepEqual(unavailablePreparedSources(cited(), null, committed), committed);
  assert.deepEqual(requiredLiveSources(cited(), null), []);
  assert.equal(packagedAllowed({ docId: "marabooka-1-completion-report", doc: "Report" }, null, committed), false);
  assert.equal(packagedAllowed({ docId: "cooper-report", doc: "Cooper report" }, null, committed), true);
  assert.ok(unavailableV1DocIds(null, committed).includes("marabooka-1-velocity-chart-enclosure-2"));
  assert.equal(labelPackaged(cited(), null).citations[0].provenanceLabel, undefined);
});
for (const configured of [[], ["peps-sa-marabooka-1"]]) test(`invalid manifest policy honors revision commitments: ${configured.join() || "none"}`, async () => {
  const reader = new ManifestReader(async () => ({ status: 200, etag: '"bad"', bytes: Buffer.from('{"manifestVersion":1}') }), () => configured);
  const { manifest } = await reader.read(); assert.equal(manifest, null);
  assert.equal(packagedExclusion(manifest, configured) !== "", configured.length > 0);
  assert.equal(unavailablePreparedSources(cited(), manifest, configured).length, configured.length);
  assert.deepEqual(requiredLiveSources(cited(), manifest), []);
});
test("snapshot labels appear only while a validated source is live", () => {
  const a = cited("Adavale report"), m = manifestFixture();
  assert.equal(labelPackaged(a, m, committed).citations[0].provenanceLabel, "packaged snapshot"); assert.equal(a.citations[0].provenanceLabel, undefined);
  assert.equal(labelPackaged(a, null), a);
});
test("a knowledge graph record keeps its own label instead of the snapshot's", () => {
  const a = cited("GA play-interval table (eCat 147461)"); a.citations[0].provenanceLabel = "knowledge graph";
  assert.equal(labelPackaged(a, manifestFixture(), committed).citations[0].provenanceLabel, "knowledge graph");
});
test("GBX_LIVE_SOURCES defaults empty, trims and deduplicates, and refuses unknown families", () => {
  assert.deepEqual(parseLiveSources(), []); assert.deepEqual(parseLiveSources(" , "), []);
  assert.deepEqual(parseLiveSources(" ga-147461,peps-sa-marabooka-1,ga-147461 "), ["ga-147461", "peps-sa-marabooka-1"]);
  assert.deepEqual(parseLiveSources("ga-147462,peps-sa-habanero-1"), ["ga-147462", "peps-sa-habanero-1"]);
  assert.throws(() => parseLiveSources("gsq-cr000407"), /GBX_LIVE_SOURCES/);
});
test("client-safe publication view includes commitments even when the manifest is unavailable", () => {
  assert.deepEqual(clientManifest(null, ["peps-sa-marabooka-1"]).requiredSourceIds, ["peps-sa-marabooka-1"]);
  assert.equal(clientManifest(null, []).enabled, false);
});

test("publication alone never excludes or routes uncommitted sources", () => {
  const m = bothManifestFixture(), a = cited();
  assert.equal(packagedExclusion(m, []), ""); assert.equal(packagedFilter("original", m, []), "original");
  assert.deepEqual(requiredLiveSources(a, m, []), []); assert.equal(labelPackaged(a, m, []), a);
  assert.equal(packagedAllowed({ docId: "marabooka-1-completion-report", doc: "Report" }, m, ["ga-147461"]), true);
  assert.deepEqual(requiredLiveSources(a, m, ["ga-147461"]), []);
  assert.deepEqual(clientManifest(m, ["ga-147461"]).sources.map((s) => s.sourceId), ["ga-147461"]);
  assert.equal(clientManifest(m, []).enabled, false);
});
test("library questions whose best matches are now served live route to those configured sources only", () => {
  const m = bothManifestFixture();
  assert.deepEqual(migratedLiveSources([{ docId: "cooper-report", doc: "Cooper report" }], m, ["ga-147461"]), ["ga-147461"]);
  assert.deepEqual(migratedLiveSources([{ docId: "", doc: "Cooper report" }], m, ["ga-147461", "peps-sa-marabooka-1"]), ["ga-147461"]);
  assert.deepEqual(migratedLiveSources([{ docId: "cooper-report", doc: "Cooper report" }], m, ["peps-sa-marabooka-1"]), []);
  assert.deepEqual(migratedLiveSources([{ docId: "adavale-report", doc: "Adavale report" }], m, ["ga-147461"]), []);
});
test("a named live well routes to its source, but another well of the same field does not", () => {
  for (const q of ["Total depth of Habanero 1?", "Habanero-1 temperature", "What was HABANERO No. 1's status?", "Habanero's maximum temperature"]) assert.ok(namesWell(q, "Habanero 1"), q);
  for (const q of ["Total depth of Habanero 3?", "Habanero 10", "Habaneros", "Marabooka 1"]) assert.ok(!namesWell(q, "Habanero 1"), q);
  const m = bothManifestFixture(), habanero = structuredClone(m.sources[0]);
  Object.assign(habanero, { sourceId: "peps-sa-habanero-1", sha256: "9".repeat(64), wellLocation: null, v1DocIds: [],
    documents: [{ docId: "habanero", sha256: "8".repeat(64), title: "Habanero 1 well files", pageCount: 32, chunkCount: 34 }] });
  const all = { ...m, sources: [...m.sources, habanero] }, configured = ["ga-147461", "peps-sa-marabooka-1", "peps-sa-habanero-1"];
  assert.deepEqual(wellLiveSources("What is the total depth of Habanero 1?", all, configured), ["peps-sa-habanero-1"]);
  assert.deepEqual(wellLiveSources("What is the total depth of Habanero 1?", all, ["ga-147461"]), []);
  assert.deepEqual(wellLiveSources("Marabooka 1 kelly bushing elevation", all, configured), ["peps-sa-marabooka-1"]);
});
test("GBX_LIVE_ROUTE defaults to matched and accepts only matched or all", () => {
  assert.equal(parseLiveRoute(), "matched"); assert.equal(parseLiveRoute(" "), "matched"); assert.equal(parseLiveRoute(" matched "), "matched"); assert.equal(parseLiveRoute("all"), "all");
  for (const bad of ["ALL", "every", "none", "matched,all"]) assert.throws(() => parseLiveRoute(bad), /GBX_LIVE_ROUTE/, bad);
});
test("the matched route routes exactly as 0.13.30 did; the all route sends every uncovered question to the configured live sources", () => {
  const m = bothManifestFixture(), configured = ["ga-147461", "peps-sa-marabooka-1"];
  const cases: [string, { docId: string; doc: string }[]][] = [["What is the Toolachee top in Marabooka 1?", []], ["What is the Cooper Basin's area?", [{ docId: "cooper-report", doc: "Cooper report" }]],
    ["How do two airborne electromagnetic surveys compare?", [{ docId: "adavale-report", doc: "Adavale report" }]], ["Anything else", []]];
  for (const [q, best] of cases) {
    assert.deepEqual(routedLiveSources(q, best, m, "matched", configured), [...new Set([...wellLiveSources(q, m, configured), ...migratedLiveSources(best, m, configured)])], q);
    assert.deepEqual(routedLiveSources(q, best, m, "all", configured), ["peps-sa-marabooka-1", "ga-147461"], q);
  }
  assert.deepEqual(routedLiveSources(cases[2][0], cases[2][1], m, "matched", configured), []);
  assert.deepEqual(routedLiveSources("Anything else", [], m, "all", ["ga-147461"]), ["ga-147461"]);
  for (const route of ["matched", "all"] as const) { assert.deepEqual(routedLiveSources("Anything else", [], null, route, configured), []); assert.deepEqual(routedLiveSources("Anything else", [], m, route, []), []); }
});
