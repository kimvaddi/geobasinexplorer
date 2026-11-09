import assert from "node:assert/strict";
import { test } from "node:test";
import { cfg, parseAgentToolCalls } from "../config";
import { AgentTools, BUDGET_NOTICE, EVIDENCE_LIMIT, liveFilter } from "./agent-tools";
import { contextFixture, evidenceFixture, liveHit, documentHash, artifactHash } from "./serving.test-fixtures";
import type { Passage } from "../azure";
import { accessFilter, searchScope } from "../geo";
const signal = () => AbortSignal.timeout(1000);
const search = (tools: AgentTools, call = "s1") => tools.execute("search_live_evidence", '{"query":"Toolachee KB"}', call, signal());
test("live search is tuple-scoped, caller-filtered, licence-filtered and post-filtered", async () => {
  const ctx = contextFixture(); ctx.user.id = "O'Brien"; let filter = "";
  const tools = new AgentTools(ctx, { ...evidenceFixture(), live: async (_q, f) => { filter = f; return [liveHit(), liveHit({ id: "wrong", sha256: "f".repeat(64) }), liveHit({ id: "private", visibility: "private" as never }), liveHit({ id: "badPage", page: 421 }), liveHit({ id: "withheld", sourceId: "gsq-cr000407" })]; } });
  const raw = await search(tools), rows = JSON.parse(raw); assert.equal(rows.length, 1); assert.equal(rows[0].provenance, "live");
  assert.ok(filter.includes("O''Brien")); assert.ok(filter.includes(liveFilter(ctx.manifest))); assert.match(filter, /not search.in\(docId/);
  assert.equal(rows[0].documentSha256, documentHash); assert.notEqual(rows[0].documentSha256, artifactHash); assert.equal(rows[0].sourceId, "peps-sa-marabooka-1");
  // The model sees each passage once and no citation internals; the server-side registry keeps the full citation.
  assert.equal(rows[0].citation, undefined); assert.equal(raw.split(rows[0].text).length - 1, 1);
  assert.equal(tools.evidence.get(rows[0].id)!.citation!.live!.documentSha256, documentHash);
});
test("packaged search excludes migrated/withheld/private records and labels permitted evidence", async () => {
  const previous = cfg.live.sources; cfg.live.sources = ["peps-sa-marabooka-1"];
  try {
  const allowed: Passage = { id: "p1", docId: "adavale-report", doc: "Adavale report", page: 1, heading: "Test", text: "Permitted source", basin: null, well: null, kind: "report", source: "Geoscience Australia", visibility: "public", owner: "" };
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), packaged: async (_q, filter) => { assert.match(filter, /marabooka-1-completion-report/); return [allowed, { ...allowed, id: "private", visibility: "private", owner: "other" }, { ...allowed, id: "live", docId: "marabooka-1-completion-report" }, { ...allowed, id: "withheld", source: "gsq-cr000407" }]; } });
  const out = JSON.parse(await tools.execute("search_packaged_evidence", '{"query":"evidence"}', "p1", signal())); assert.equal(out.length, 1); assert.equal(out[0].provenance, "packaged snapshot"); assert.equal(out[0].citation, undefined);
  } finally { cfg.live.sources = previous; }
});
test("open_page checks active PDF identity and server-side source/hash/page filters", async () => {
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async (_q, filter) => { assert.match(filter, new RegExp(`documentSha256 eq '${documentHash}'`)); assert.match(filter, /page eq 25/); return [liveHit(), liveHit({ id: "otherPage", page: 26 })]; } });
  const out = JSON.parse(await tools.execute("open_page", JSON.stringify({ sourceId: "peps-sa-marabooka-1", documentSha256: documentHash, page: 25 }), "page1", signal())); assert.equal(out.passages.length, 1);
  await assert.rejects(tools.execute("open_page", JSON.stringify({ sourceId: "peps-sa-marabooka-1", documentSha256: artifactHash, page: 25 }), "page2", signal()), /published/);
});
test("depth tool records auditable sourced inputs, formula, units and exact 6144.1 result", async () => {
  const tools = new AgentTools(contextFixture(), evidenceFixture()); await search(tools);
  const out = JSON.parse(await tools.execute("convert_depth_kb_to_subsea", JSON.stringify({ depthBelowKbFt: 6326, kbElevationFt: 181.9, depthEvidenceId: "L1", kbEvidenceId: "L1" }), "d1", signal()));
  assert.equal(out.computation.output.value, 6144.1); assert.equal(out.computation.formula, "depthBelowKbFt - kbElevationFt"); assert.equal(out.computation.inputs.length, 2);
  assert.deepEqual(tools.expand([out.id]).map((e) => e.id), [out.id, "L1"]);
  await assert.rejects(tools.execute("convert_depth_kb_to_subsea", JSON.stringify({ depthBelowKbFt: 9000, kbElevationFt: 181.9, depthEvidenceId: "L1", kbEvidenceId: "L1" }), "d2", signal()), /source evidence/);
});
for (const [name, json] of [["delete_blob", "{}"], ["search_live_evidence", '{"query":"x","owner":"admin"}'], ["search_live_evidence", '{"query":""}'], ["search_live_evidence", "null"], ["convert_depth_kb_to_subsea", '{"depthBelowKbFt":1e309,"kbElevationFt":0,"depthEvidenceId":"L1","kbEvidenceId":"L1"}']]) test(`rejects unallowlisted tool or invalid exact argument schema: ${name} ${json}`, async () => { const tools = new AgentTools(contextFixture(), evidenceFixture()); await assert.rejects(tools.execute(name, json, "bad", signal())); });
test("replayed call_ids are idempotent and changed arguments under the same id are rejected", async () => {
  let calls = 0; const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => { calls++; return [liveHit()]; } });
  assert.equal(await search(tools), await search(tools)); assert.equal(calls, 1);
  await assert.rejects(tools.execute("search_live_evidence", '{"query":"changed"}', "s1", signal()), /reused/);
});
test("near filters cannot be widened by model arguments or bad backend records", async () => {
  const ctx = contextFixture(); ctx.near = { lon: 140.6, lat: -28.1, km: 50 };
  const tools = new AgentTools(ctx, { ...evidenceFixture(), live: async (_q, f) => { assert.match(f, /geo.distance/); return [liveHit({ geotag: "none", points: [], geoBasins: [] })]; } });
  assert.deepEqual(JSON.parse(await search(tools)), []);
});
test("conflicting copies of immutable tuples and fabricated citation IDs fail closed", async () => {
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => [liveHit(), liveHit({ id: "live_c1_v2", text: "Different text" })] });
  await assert.rejects(search(tools), /Conflicting/); assert.throws(() => tools.expand(["L999"]), /not retrieved/);
});

test("tool budget caps execution and search never registers evidence it did not return to the model", async () => {
  let requests = 0;
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => { requests++; return Array.from({ length: 24 }, (_, i) => liveHit({ id: `c${i}_v1` })); } });
  const result = JSON.parse(await search(tools)); assert.equal(result.length, 8); assert.equal(tools.evidence.size, 8); assert.throws(() => tools.expand(["L9"]));
  for (let i = 1; i < 12; i++) await search(tools, `s${i + 1}`);
  // The call past the budget is not run: it gets the notice, so the runtime can ask for the answer instead of failing.
  assert.equal(await search(tools, "s13"), BUDGET_NOTICE); assert.equal(requests, 12); assert.equal(tools.spent, "calls");
  assert.equal(await search(tools, "s13"), BUDGET_NOTICE); assert.equal(requests, 12);
  await assert.rejects(tools.execute("delete_blob", "{}", "s14", signal()), /allowlisted/);
});
test("GBX_AGENT_TOOL_CALLS sets the tool budget, 12 by default, and refuses a limit that is not a whole number from 1 to 48", async () => {
  let requests = 0; const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => { requests++; return [liveHit()]; } }, 3);
  for (let i = 1; i <= 3; i++) await search(tools, `s${i}`);
  assert.equal(await search(tools, "s4"), BUDGET_NOTICE); assert.equal(requests, 3);
  assert.equal(parseAgentToolCalls(), 12); assert.equal(parseAgentToolCalls(" 16 "), 16); assert.equal(parseAgentToolCalls("48"), 48);
  for (const bad of ["0", "49", "1.5", "twelve", "-3"]) assert.throws(() => parseAgentToolCalls(bad), /GBX_AGENT_TOOL_CALLS/, bad);
});
test("the evidence limit ends a search at 48 passages, returning everything it registered, and later searches get the notice", async () => {
  let n = 0;
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => { n++; return Array.from({ length: 7 }, (_, i) => liveHit({ id: `s${n}c${i}_v1`, text: `Passage ${n}.${i} on the Toolachee top.` })); } });
  const returned = new Set<string>();
  for (let i = 1; i <= 6; i++) for (const row of JSON.parse(await search(tools, `s${i}`))) returned.add(row.id);
  assert.equal(tools.evidence.size, 42); assert.equal(tools.spent, null);
  const seventh = JSON.parse(await search(tools, "s7")); assert.equal(seventh.length, 6); assert.equal(tools.spent, "evidence");
  for (const row of seventh) returned.add(row.id);
  assert.equal(tools.evidence.size, EVIDENCE_LIMIT); assert.deepEqual([...tools.evidence.keys()].sort(), [...returned].sort());
  assert.equal(await search(tools, "s8"), BUDGET_NOTICE); assert.equal(tools.evidence.size, EVIDENCE_LIMIT);
});
test("a search returns only the passages that fit its transcript room and registers nothing it did not return", async () => {
  const reader = { ...evidenceFixture(), live: async () => Array.from({ length: 8 }, (_, i) => liveHit({ id: `c${i}_v1`, text: `Passage ${i} `.padEnd(1_000, "x") })) };
  const all = JSON.parse(await new AgentTools(contextFixture(), reader).execute("search_live_evidence", '{"query":"Toolachee KB"}', "s1", signal()));
  const tools = new AgentTools(contextFixture(), reader), room = JSON.stringify(JSON.stringify(all.slice(0, 3))).length;
  assert.deepEqual(JSON.parse(await tools.execute("search_live_evidence", '{"query":"Toolachee KB"}', "s1", signal(), room)), all.slice(0, 3));
  assert.deepEqual([...tools.evidence.keys()], ["L1", "L2", "L3"]); assert.equal(tools.spent, "transcript");
  const none = new AgentTools(contextFixture(), reader);
  assert.equal(await none.execute("search_live_evidence", '{"query":"Toolachee KB"}', "s1", signal(), 100), BUDGET_NOTICE); assert.equal(none.evidence.size, 0); assert.equal(none.spent, "transcript");
  // Long passages stop at one call's output bound instead of failing the call; that bound alone doesn't spend the budget.
  const long = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => Array.from({ length: 8 }, (_, i) => liveHit({ id: `c${i}_v1`, text: `Passage ${i} `.padEnd(20_000, "x") })) });
  const rows = JSON.parse(await search(long)); assert.equal(rows.length, 3); assert.equal(long.evidence.size, 3); assert.equal(long.spent, null);
});
test("open_page returns the complete page or, when the page does not fit a budget, the notice with nothing registered", async () => {
  const page = [liveHit(), liveHit({ id: "live_c2_v1", text: "Second passage on page 25." })];
  let n = 0; const reader = { ...evidenceFixture(), live: async (q: string) => { if (q === "*") return page; n++; return Array.from({ length: n <= 5 ? 8 : 7 }, (_, i) => liveHit({ id: `s${n}c${i}_v1` })); } };
  const args = JSON.stringify({ sourceId: "peps-sa-marabooka-1", documentSha256: documentHash, page: 25 });
  const small = new AgentTools(contextFixture(), reader);
  assert.equal(await small.execute("open_page", args, "p1", signal(), 200), BUDGET_NOTICE); assert.equal(small.evidence.size, 0); assert.equal(small.spent, "transcript");
  const whole = new AgentTools(contextFixture(), reader);
  assert.deepEqual(JSON.parse(await whole.execute("open_page", args, "p1", signal())).passages.map((p: { id: string }) => p.id), ["L1", "L2"]); assert.equal(whole.spent, null);
  // With 47 passages registered, a page that would add two more is refused whole rather than cut short.
  const crowded = new AgentTools(contextFixture(), reader);
  for (let i = 1; i <= 6; i++) await search(crowded, `s${i}`);
  assert.equal(crowded.evidence.size, 47);
  assert.equal(await crowded.execute("open_page", args, "p2", signal()), BUDGET_NOTICE); assert.equal(crowded.evidence.size, 47); assert.equal(crowded.spent, "evidence");
});

test("storage URLs and SAS fragments in untrusted page text/headings are never returned, even on repeat search", async () => {
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => [liveHit({ text: "Source https://account.blob.core.windows.net/private/page?sig=secret and ?sig=extra", headingPath: ["https://account.blob.core.windows.net/header?sig=secret"] })] });
  for (const id of ["redact1", "redact2"]) { const out = await search(tools, id); assert.ok(!out.includes("blob.core")); assert.ok(!out.includes("sig=")); }
});

test("near post-filter accepts both the SDK point and its raw GeoJSON representation", async () => {
  const ctx = contextFixture(); ctx.near = { lon: 140.6102, lat: -28.176, km: 50 };
  const tools = new AgentTools(ctx, { ...evidenceFixture(), live: async () => [liveHit({ geotag: "point", points: [{ type: "Point", coordinates: [140.6102, -28.176] } as never], geoBasins: [] })] });
  assert.equal(JSON.parse(await search(tools)).length, 1);
});
test("without a place, a search covers every basin: no basin filter is sent and passages from other basins are kept", async () => {
  let filter = "";
  const galilee = liveHit({ id: "live_c2_v1", text: "Galilee passage.", basin: "galilee", geoBasins: ["galilee"], points: [{ longitude: 145.1, latitude: -23.7 }] as never });
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async (_q, f) => { filter = f; return [liveHit(), galilee]; } });
  const rows = JSON.parse(await search(tools));
  assert.doesNotMatch(filter, /\bbasin eq\b/);
  assert.deepEqual(rows.map((r: { text: string }) => r.text), [liveHit().text, "Galilee passage."]);
  const user = contextFixture().user;
  assert.equal(searchScope(user, null), accessFilter(user));
  assert.match(searchScope(user, { lon: 140.6102, lat: -28.176, km: 50 }), /geo\.distance/);
});
