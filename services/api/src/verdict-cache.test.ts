import assert from "node:assert/strict";
import { test } from "node:test";
import type { TableClient } from "@azure/data-tables";
import { MemoryVerdictStore, TableVerdictStore, VERDICT_MAX_AGE_MS, verdictKey } from "./verdict-cache";

const claims = [{ text: "The GA framework for the Adavale Basin marks 5 reservoir units.", computed: true }];
const evidence = [{ id: "computation", label: "Computation record (method only)", text: "Unit roles (reservoir) from the GA stratigraphic framework" },
  { id: "ga-147462-4", label: "Adavale Basin regional geology (GA 147462) p. 4", text: "Reservoir units: Buckabie, Etonvale, Lissoy, Eastwood, Gumbardo." }];
const check = (at: string) => ({ verdicts: [{ verdict: "supported", reason: "stated" }], checkedAt: at, tokens: 3214 });

test("a check is reused only for the same validator, statements and evidence, and only for seven days", async () => {
  const key = verdictKey("Grok 4.1 Fast", claims, evidence);
  assert.equal(verdictKey("Grok 4.1 Fast", claims, evidence), key);
  assert.notEqual(verdictKey("Grok 4.1 Fast", [{ ...claims[0], text: claims[0].text.replace("5", "6") }], evidence), key);
  assert.notEqual(verdictKey("Grok 4.1 Fast", claims, [evidence[0], { ...evidence[1], text: `${evidence[1].text} Revised.` }]), key);
  assert.notEqual(verdictKey("another validator", claims, evidence), key);
  let now = Date.parse("2026-11-08T17:00:00Z");
  const store = new MemoryVerdictStore(2, () => now);
  await store.put(key, check("2026-11-08T17:00:00Z"));
  assert.equal((await store.get(key))?.tokens, 3214);
  now += VERDICT_MAX_AGE_MS;
  assert.equal(await store.get(key), null);
  now = Date.parse("2026-11-08T17:00:00Z");
  await store.put("b", check("2026-11-08T17:00:00Z")); await store.put("c", check("2026-11-08T17:00:00Z"));
  assert.equal(await store.get(key), null, "the oldest check is dropped past the limit");
});

test("the table store keeps one row per check and treats a missing row as no check", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  let created = 0;
  const client = {
    createTable: async () => { created++; if (created > 1) throw Object.assign(new Error("exists"), { statusCode: 409 }); },
    getEntity: async (pk: string, rk: string) => { const r = rows.get(`${pk}/${rk}`); if (!r) throw Object.assign(new Error("missing"), { statusCode: 404 }); return r; },
    upsertEntity: async (e: Record<string, unknown>) => { rows.set(`${e.partitionKey}/${e.rowKey}`, e); },
  } as unknown as TableClient;
  const store = new TableVerdictStore(client, () => Date.parse("2026-11-08T18:00:00Z"));
  assert.equal(await store.get("k"), null);
  await store.put("k", check("2026-11-08T17:00:00Z"));
  assert.deepEqual(await store.get("k"), check("2026-11-08T17:00:00Z"));
  assert.equal(created, 1);
});
