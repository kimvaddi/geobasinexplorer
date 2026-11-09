import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { BUDGET_NOTICE } from "../live/agent-tools";
import { evidenceFixture, liveHit, manifestFixture } from "../live/serving.test-fixtures";
import type { EvidenceSearch } from "../live/serving-evidence";
import { MemoryRunStore } from "./run-store";
import { issueRunTicket, ticketKey, verifyRunTicket, type RunTicket } from "./run-ticket";
import { EXCERPT_CHARS, MCP_PATH, NO_LIVE_NOTICE, PROTOCOL_VERSIONS, TICKET_HEADER, excerpt, registerToolServer, type ToolServerDeps } from "./tool-server";

const key = ticketKey(Buffer.alloc(32, 7).toString("base64"));
const claims = (over: Partial<RunTicket> = {}): Omit<RunTicket, "iat" | "exp"> => ({ run: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", sub: "person-1", name: "tester@contoso.com",
  roles: ["GeoBasin.Tester"], owner: false, conversation: "", booking: "", near: null, requiredSourceIds: ["peps-sa-marabooka-1"], ...over });

test("run tickets round-trip and refuse tampering, another key, expiry, long lives and unknown claims", () => {
  const now = 1_800_000_000_000, ticket = issueRunTicket(claims(), key, 600_000, now);
  assert.equal(verifyRunTicket(ticket, key, now + 1000).sub, "person-1");
  const [p, payload, sig] = ticket.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "someone-else" })).toString("base64url");
  assert.throws(() => verifyRunTicket(`${p}.${forged}.${sig}`, key, now), /Invalid/);
  assert.throws(() => verifyRunTicket(ticket, ticketKey(Buffer.alloc(32, 8).toString("base64")), now), /Invalid/);
  assert.throws(() => verifyRunTicket(ticket, key, now + 600_001), /Expired/);
  assert.throws(() => issueRunTicket(claims(), key, 16 * 60_000, now), /fifteen minutes/);
  assert.throws(() => issueRunTicket({ ...claims(), extra: true } as never, key, 60_000, now), /Invalid/);
  assert.throws(() => issueRunTicket(claims({ near: { lon: 0, lat: 51, km: 10 } }), key, 60_000, now), /Invalid/);
  assert.throws(() => ticketKey(Buffer.alloc(16).toString("base64")), /32 random bytes/);
});

function server(over: Partial<ToolServerDeps> = {}) {
  const app = Fastify(), store = new MemoryRunStore();
  const deps: ToolServerDeps = { reader: evidenceFixture(), manifest: async () => manifestFixture(), store, ticketKey: () => key,
    allowedCallers: () => ["agent-1"], caller: () => ({ id: "agent-1", name: "gbx-copilot", roles: [], owner: false }), ...over };
  registerToolServer(app, deps);
  let n = 0;
  const rpc = async (method: string, params: unknown = {}, headers: Record<string, string> = { [TICKET_HEADER]: issueRunTicket(claims(), key) }) => {
    const r = await app.inject({ method: "POST", url: MCP_PATH, payload: { jsonrpc: "2.0", id: ++n, method, params }, headers });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const call = async (name: string, args: unknown, headers?: Record<string, string>) => {
    const r = await rpc("tools/call", { name, arguments: args }, headers);
    return { ...r, text: r.body?.result?.content?.[0]?.text as string | undefined, isError: r.body?.result?.isError as boolean | undefined };
  };
  return { app, store, rpc, call };
}

test("the handshake follows MCP: version negotiation, notifications, read-only tools, no streams, sessions or batches", async () => {
  const { app, rpc } = server();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, {});
  assert.equal(init.status, 200); assert.equal(init.body.result.protocolVersion, "2025-06-18"); assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await rpc("initialize", { protocolVersion: "2099-01-01" }, {})).body.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  const note = await app.inject({ method: "POST", url: MCP_PATH, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.statusCode, 202); assert.equal(note.body, "");
  const list = await rpc("tools/list", {}, {});
  assert.deepEqual(list.body.result.tools.map((t: { name: string }) => t.name), ["search_live_evidence", "search_packaged_evidence", "open_page", "convert_depth_kb_to_subsea",
    "knowledge_basin", "knowledge_unit", "knowledge_well", "knowledge_play", "read_evidence", "record_fabric_iq"]);
  assert.ok(list.body.result.tools.every((t: { annotations: { readOnlyHint: boolean }; inputSchema: { additionalProperties: boolean } }) => t.annotations.readOnlyHint && t.inputSchema.additionalProperties === false));
  assert.equal((await rpc("resources/list", {}, {})).body.error.code, -32601);
  assert.equal((await app.inject({ method: "GET", url: MCP_PATH })).statusCode, 405);
  assert.equal((await app.inject({ method: "DELETE", url: MCP_PATH })).statusCode, 405);
  assert.equal((await app.inject({ method: "POST", url: MCP_PATH, payload: [{ jsonrpc: "2.0", id: 1, method: "ping" }] })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: MCP_PATH, payload: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { "mcp-protocol-version": "1999-01-01" } })).statusCode, 400);
});

test("only an allowlisted agent identity may call, never a browser, and every tool call needs a valid ticket", async () => {
  const stranger = server({ caller: () => ({ id: "someone", name: "x", roles: [], owner: false }) });
  assert.equal((await stranger.rpc("tools/list", {}, {})).status, 403);
  const anonymous = server({ caller: () => null });
  assert.equal((await anonymous.rpc("ping", {}, {})).status, 403);
  const { app, call } = server();
  assert.equal((await app.inject({ method: "POST", url: MCP_PATH, payload: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await call("search_live_evidence", { query: "Toolachee" }, {})).status, 403);
  assert.equal((await call("search_live_evidence", { query: "Toolachee" }, { [TICKET_HEADER]: "gbx1.e30.AAAA" })).status, 403);
  const expired = issueRunTicket(claims(), key, 1, Date.now() - 10_000);
  assert.equal((await call("search_live_evidence", { query: "Toolachee" }, { [TICKET_HEADER]: expired })).status, 403);
  const unknown = await call("delete_blob", {});
  assert.equal(unknown.body.error.code, -32602);
});

test("evidence gets stable IDs in the run's register, repeats register once, and the conversion reads its inputs from it", async () => {
  const { call, store } = server();
  const first = await call("search_live_evidence", { query: "Toolachee KB" });
  assert.equal(first.isError, false);
  const rows = JSON.parse(first.text!);
  assert.equal(rows.length, 1); assert.match(rows[0].id, /^L[0-9a-f]{10}$/); assert.equal(rows[0].citation, undefined);
  const again = JSON.parse((await call("search_live_evidence", { query: "Toolachee" })).text!);
  assert.equal(again[0].id, rows[0].id); assert.equal(await store.count(claims().run), 1);
  const conversion = await call("convert_depth_kb_to_subsea", { depthBelowKbFt: 6326, kbElevationFt: 181.9, depthEvidenceId: rows[0].id, kbEvidenceId: rows[0].id });
  const out = JSON.parse(conversion.text!);
  assert.equal(out.computation.output.value, 6144.1); assert.match(out.id, /^T[0-9a-f]{10}$/);
  assert.deepEqual(out.computation.sourceIds, [rows[0].id]); assert.equal(out.computation.inputs[0].evidenceId, rows[0].id);
  assert.equal(await store.count(claims().run), 2);
  const [stored] = await store.get(claims().run, [rows[0].id]);
  assert.equal(stored.citation?.live?.documentSha256, "b".repeat(64)); assert.equal(stored.citation?.text, stored.text);
  // Another run has its own register, so the same IDs are unknown there.
  const other = { [TICKET_HEADER]: issueRunTicket(claims({ run: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }), key) };
  const refused = await call("convert_depth_kb_to_subsea", { depthBelowKbFt: 6326, kbElevationFt: 181.9, depthEvidenceId: rows[0].id, kbEvidenceId: rows[0].id }, other);
  assert.equal(refused.isError, true); assert.match(refused.text!, /source evidence/);
});

test("the ticket's person and place scope every search, and model arguments can't widen them", async () => {
  let filter = "";
  const reader: EvidenceSearch = { ...evidenceFixture(), live: async (_q, f) => { filter = f; return [liveHit()]; } };
  const { call } = server({ reader });
  const near = { [TICKET_HEADER]: issueRunTicket(claims({ sub: "O'Brien", near: { lon: 140.6, lat: -28.1, km: 50 } }), key) };
  await call("search_live_evidence", { query: "Toolachee" }, near);
  assert.ok(filter.includes("O''Brien")); assert.match(filter, /geo.distance/);
  const widened = await call("search_live_evidence", { query: "x", owner: "admin" });
  assert.equal(widened.isError, true); assert.equal(widened.text, "Invalid tool arguments");
});

test("without a publication the live tools say so and packaged search still runs; a full register answers with the budget notice", async () => {
  let packaged = 0;
  const reader: EvidenceSearch = { live: async () => { throw new Error("live search must not run"); }, packaged: async () => { packaged++; return []; } };
  const { call } = server({ manifest: async () => null, reader });
  assert.equal((await call("search_live_evidence", { query: "Toolachee" })).text, NO_LIVE_NOTICE);
  assert.equal((await call("search_packaged_evidence", { query: "Toolachee" })).text, "[]"); assert.equal(packaged, 1);
  const full = server({ evidenceLimit: 1 });
  await full.call("search_live_evidence", { query: "Toolachee" });
  assert.equal((await full.call("search_live_evidence", { query: "Toolachee" })).text, BUDGET_NOTICE);
});

test("read_evidence returns only this run's registered records and names unknown IDs as missing", async () => {
  const { call } = server();
  const [row] = JSON.parse((await call("search_live_evidence", { query: "Toolachee" })).text!);
  const read = JSON.parse((await call("read_evidence", { ids: [row.id, "Lffffffffff"] })).text!);
  assert.deepEqual(read.evidence.map((e: { id: string }) => e.id), [row.id]); assert.equal(read.evidence[0].text, liveHit().text);
  assert.deepEqual(read.missing, ["Lffffffffff"]);
  const elsewhere = { [TICKET_HEADER]: issueRunTicket(claims({ run: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }), key) };
  assert.deepEqual(JSON.parse((await call("read_evidence", { ids: [row.id] }, elsewhere)).text!).missing, [row.id]);
  for (const bad of [{ ids: ["L1"] }, { ids: row.id }, { ids: [row.id], extra: 1 }]) {
    const refused = await call("read_evidence", bad);
    assert.equal(refused.isError, true); assert.equal(refused.text, "Invalid tool arguments");
  }
});

test("a search shows the model an excerpt around its words, while the register keeps the whole passage", async () => {
  const long = `${"Drilling continued without incident through the Triassic section. ".repeat(40)}Top Toolachee 6326 ft below KB, picked on the gamma log. ${"Casing was run and cemented. ".repeat(40)}`;
  const reader: EvidenceSearch = { ...evidenceFixture(), live: async () => [liveHit({ text: long })] };
  const { call } = server({ reader });
  const [row] = JSON.parse((await call("search_live_evidence", { query: "Toolachee top KB" })).text!);
  assert.ok(row.text.length <= EXCERPT_CHARS + 4 && row.text.includes("Top Toolachee 6326 ft below KB") && row.text.startsWith("… "));
  assert.match(row.excerpt, /open_page/);
  const read = JSON.parse((await call("read_evidence", { ids: [row.id] })).text!);
  assert.equal(read.evidence[0].text, long);
  assert.equal(excerpt("Short passage.", "anything"), "Short passage.");
});

test("a changed copy of a registered record fails closed, and provider messages never reach the model", async () => {
  let text = liveHit().text;
  const reader: EvidenceSearch = { ...evidenceFixture(), live: async () => [liveHit({ text })] };
  const { call } = server({ reader });
  await call("search_live_evidence", { query: "Toolachee" });
  text = "Top Toolachee 9999 ft below KB.";
  const changed = await call("search_live_evidence", { query: "Toolachee" });
  assert.equal(changed.isError, true); assert.equal(changed.text, "Conflicting immutable evidence records");
  const leaky = server({ reader: { ...evidenceFixture(), live: async () => { throw new Error("index gbx-secret refused query 'Toolachee'"); } } });
  const failed = await leaky.call("search_live_evidence", { query: "Toolachee" });
  assert.equal(failed.isError, true); assert.doesNotMatch(failed.text!, /gbx-secret|Toolachee/);
});

test("Fabric IQ's answers are registered as K records the run can cite, and an answer naming a withheld source is refused", async () => {
  const { call, store } = server();
  const answer = "For the Toolachee Formation in the Cooper Basin the knowledge graph records an age range of 257.7 to 252.5 Ma, sandstone with coal, fluviolacustrine.";
  const out = JSON.parse((await call("record_fabric_iq", { question: "What does the graph record for the Toolachee Formation?", answer })).text!);
  assert.equal(out.records.length, 1);
  const [r] = out.records;
  assert.match(r.id, /^K[0-9a-f]{10}$/); assert.equal(r.label, "Fabric IQ: What does the graph record for the Toolachee Formation?");
  assert.match(r.text, /signed-in person's own permissions, answered: For the Toolachee Formation/);
  const again = JSON.parse((await call("record_fabric_iq", { question: "What does the graph record for the Toolachee Formation?", answer })).text!);
  assert.equal(again.records[0].id, r.id); assert.equal(await store.count(claims().run), 1);
  const [stored] = await store.get(claims().run, [r.id]);
  assert.equal(stored.citation?.doc, "GeoBasin knowledge ontology, through Fabric IQ");
  // The typed tools drop Innamincka 1's rows while its report's reuse terms aren't confirmed, so its answers are refused too.
  const withheld = JSON.parse((await call("record_fabric_iq", { question: "How deep is Innamincka 1?", answer: "Innamincka 1 reached a total depth of 3,000 m." })).text!);
  assert.deepEqual(withheld.records, []); assert.match(withheld.notice, /reuse terms aren't confirmed/); assert.equal(await store.count(claims().run), 1);
  for (const bad of [{ question: "x", answer }, { question: "What?", answer: "" }, { question: "What is it?", answer, extra: 1 }]) {
    const refused = await call("record_fabric_iq", bad);
    assert.equal(refused.isError, true); assert.equal(refused.text, "Invalid tool arguments");
  }
});
