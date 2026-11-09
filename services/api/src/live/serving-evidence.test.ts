import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchClient } from "@azure/search-documents";
import { makeEvidenceSearch } from "./serving-evidence";
import { liveHit } from "./serving.test-fixtures";
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
