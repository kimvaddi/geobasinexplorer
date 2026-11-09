import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchClient } from "@azure/search-documents";
import { libraryCoverage, makeEvidenceSearch } from "./serving-evidence";
import { bothManifestFixture, liveHit, manifestFixture } from "./serving.test-fixtures";
import { LIVE_INDEX_FIELDS, type LiveEvidenceRecord } from "./contracts";
import type { Passage } from "../azure";
test("Search adapter selects valid v2 fields, passes caller filter and abort signal, and bounds iteration", async () => {
  const signal = AbortSignal.timeout(1000); let calls = 0;
  const live = { search: async (q: string, o: { filter: string; top: number; select: string[]; abortSignal: AbortSignal; queryType: string }) => {
    calls++; assert.equal(q, "Toolachee"); assert.equal(o.filter, "scoped filter"); assert.equal(o.top, 2); assert.equal(o.queryType, "simple"); assert.equal(o.abortSignal, signal);
    assert.ok(o.select.every((f) => (LIVE_INDEX_FIELDS as readonly string[]).includes(f))); assert.ok(!o.select.includes("vector"));
    return { results: (async function* () { for (let n = 0; n < 3; n++) yield { document: liveHit({ id: `c${n}` }) }; })() };
  } } as unknown as Pick<SearchClient<LiveEvidenceRecord>, "search">;
  const packaged = { search: async () => { throw new Error("Wrong lane"); } } as unknown as Pick<SearchClient<Passage>, "search">;
  const r = await makeEvidenceSearch(() => live, () => packaged).live("Toolachee", "scoped filter", 2, signal); assert.equal(calls, 1); assert.equal(r.length, 2);
});
const index = (name: string, calls: string[], fail = false) => ({ search: async () => {
  calls.push(name); if (fail) throw new Error("index unavailable");
  return { results: (async function* () { yield { document: liveHit({ id: name }) }; })() };
} }) as unknown as Pick<SearchClient<LiveEvidenceRecord>, "search">;
const unusedPackaged = () => ({ search: async () => { throw new Error("Wrong lane"); } }) as unknown as Pick<SearchClient<Passage>, "search">;
test("the library index answers only while it covers the publication, and any failure falls back to the push index", async () => {
  const calls: string[] = [], signal = AbortSignal.timeout(1000);
  for (const [covered, fail, expected] of [[true, false, ["library"]], [false, false, ["push"]], [true, true, ["library", "push"]]] as const) {
    calls.length = 0;
    const search = makeEvidenceSearch(() => index("push", calls), unusedPackaged, { client: () => index("library", calls, fail), covered: async () => covered });
    const hits = await search.live("Toolachee", "scoped filter", 2, signal);
    assert.deepEqual(calls, expected); assert.equal(hits[0].id, expected.at(-1));
  }
  calls.length = 0;
  const broken = makeEvidenceSearch(() => index("push", calls), unusedPackaged, { client: () => index("library", calls), covered: async () => { throw new Error("count failed"); } });
  assert.equal((await broken.live("q", "f", 1, signal))[0].id, "push");
});
test("library coverage counts the publication's tuples once, retries an uncovered one after a minute, and recounts a new manifest", async () => {
  let manifest = manifestFixture(1), indexed = 799, clock = 0; const filters: string[] = [];
  const covered = libraryCoverage(async () => manifest, async (filter) => { filters.push(filter); return indexed; }, { now: () => clock });
  const signal = AbortSignal.timeout(1000);
  assert.equal(await covered(signal), false); assert.match(filters[0], /sourceId eq 'peps-sa-marabooka-1' and sha256 eq '/);
  indexed = 800; clock = 30_000; assert.equal(await covered(signal), false); assert.equal(filters.length, 1);
  clock = 61_000; assert.equal(await covered(signal), true); assert.equal(filters.length, 2);
  clock = 999_000; assert.equal(await covered(signal), true); assert.equal(filters.length, 2);
  manifest = bothManifestFixture(2); indexed = 840; assert.equal(await covered(signal), true); assert.equal(filters.length, 3);
  assert.equal(await libraryCoverage(async () => null, async () => 0)(signal), false);
});
