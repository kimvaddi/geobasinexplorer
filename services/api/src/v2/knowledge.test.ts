import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { evidenceFixture, manifestFixture } from "../live/serving.test-fixtures";
import { KNOWLEDGE_UNAVAILABLE, KnowledgeUnavailable, cleanName, knowledgeTool, type KnowledgeGraph } from "./knowledge";
import { MemoryRunStore } from "./run-store";
import { issueRunTicket, ticketKey } from "./run-ticket";
import { MCP_PATH, TICKET_HEADER, registerToolServer } from "./tool-server";

const COOPER = { k_id: "basin:cooper", k_name: "Cooper Basin", k_age: "Carboniferous Gzhelian (304 Ma) to Triassic Ladinian (237 Ma)", k_area_km2: 130196.0, k_setting: "Polyphase",
  k_depth_max_m: 4799.0, k_boreholes: 4881, k_regime: "SS", k_shmax_deg: 99.7, k_stress_ac: 73, k_from: "Cooper Basin regional geology" };

/* A scripted graph: answers each query by the first rule whose pattern it matches, and records every query it was sent. */
function graph(rules: [RegExp, Record<string, unknown>[] | Error][]): KnowledgeGraph & { sent: string[] } {
  const sent: string[] = [];
  return { sent, async query(gql) { sent.push(gql); const r = rules.find(([re]) => re.test(gql)); if (!r) return []; if (r[1] instanceof Error) throw r[1]; return r[1]; } };
}
const signal = () => AbortSignal.timeout(1000);

test("names are cleaned before they reach a query, so nothing a model writes becomes GQL syntax", async () => {
  assert.equal(cleanName("Cooper Basin"), "COOPER BASIN");
  assert.equal(cleanName("x' RETURN 1 //"), "X RETURN 1 //");
  assert.equal(cleanName("Toolachee`) MATCH (n"), "TOOLACHEE MATCH N");
  assert.equal(cleanName("a"), null);
  const g = graph([[/MATCH \(b:Basin\)/, [COOPER]]]);
  await knowledgeTool("knowledge_basin", { name: "Cooper' OR 1=1 --" }, g, signal());
  assert.match(g.sent[0], /CONTAINS 'COOPER OR 1 1 --'/);
  assert.ok(!g.sent[0].includes("''"));
  await assert.rejects(knowledgeTool("knowledge_basin", { name: "Cooper", extra: 1 }, g, signal()), /Invalid tool arguments/);
  await assert.rejects(knowledgeTool("knowledge_unit", {}, g, signal()), /Invalid tool arguments/);
});

test("a basin becomes one cited record, with its numbers as reports print them and its stress regime spelt out", async () => {
  const r = await knowledgeTool("knowledge_basin", { name: "Cooper" }, graph([[/MATCH \(b:Basin\)/, [COOPER]]]), signal());
  assert.equal(r.evidence.length, 1);
  const e = r.evidence[0];
  assert.equal(e.text, "Basin Cooper Basin (GeoBasin knowledge graph in Microsoft Fabric, from Cooper Basin regional geology): age Carboniferous Gzhelian (304 Ma) to Triassic Ladinian (237 Ma); area 130,196 km²; tectonic setting Polyphase; depth to basement up to 4,799 m; boreholes inside its outline 4,881; dominant present-day stress regime SS (strike-slip faulting); mean SHmax azimuth 99.7°; stress records of quality A to C inside its outline 73.");
  assert.deepEqual([e.citation?.id, e.citation?.basin, e.citation?.doc, e.citation?.page, e.citation?.provenanceLabel], ["kg:basin:cooper", "cooper", "Cooper Basin regional geology", 0, "knowledge graph"]);
});

test("a well is matched exactly before loosely, a unit joins its basin and play, and withheld sources are dropped", async () => {
  const g = graph([
    [/MATCH \(w:Wellbore\) WHERE upper\(w.`label`\) = 'MARABOOKA 1'/, [{ k_id: "bh:marabooka-1", k_name: "Marabooka 1", k_td_m: 2154.0, k_drilled: 1971, k_lat: -28.2, k_lon: 140.6, k_crs: "GDA94" }]],
    [/-\[:locatedIn\]->\(b:Basin\) WHERE upper\(w.`label`\) = 'MARABOOKA 1'/, [{ k_id: "bh:marabooka-1", k_basin: "Cooper Basin", k_basin_id: "basin:cooper" }]],
    [/MATCH \(u:StratigraphicUnit\) WHERE/, [{ k_id: "unit:toolachee", k_name: "Toolachee Formation", k_age: "Wuchiapingian", k_top_ma: 252.5, k_base_ma: 257.7, k_lithology: "Sandstone with coal", k_from: "Cooper Basin regional geology" },
      { k_id: "unit:x", k_name: "Toolachee lookalike", k_from: "Innamincka 1 well completion report" }]],
    [/belongsToBasin/, [{ k_id: "unit:toolachee", k_basin: "Cooper Basin", k_basin_id: "basin:cooper" }, { k_id: "unit:x", k_basin: "Cooper Basin", k_basin_id: "basin:cooper" }]],
    [/assignedToPlay/, [{ k_id: "unit:toolachee", k_play: "Toolachee Play" }]],
  ]);
  const well = await knowledgeTool("knowledge_well", { name: "Marabooka 1" }, g, signal());
  assert.equal(well.evidence[0].text, "Well Marabooka 1 (GeoBasin knowledge graph in Microsoft Fabric, from GeoBasin's public basin datasets): total depth 2,154 m; drilled 1971; position -28.2, 140.6 (latitude, longitude, GDA94); basin Cooper Basin.");
  assert.ok(!g.sent.some((q) => /CONTAINS 'MARABOOKA 1'/.test(q)), "the exact match was enough");
  const unit = await knowledgeTool("knowledge_unit", { name: "Toolachee", basin: "Cooper" }, g, signal());
  // Both rows are in the Cooper Basin; the one from the withheld Innamincka 1 report is dropped by the licence gate alone.
  assert.deepEqual(unit.evidence.map((e) => e.citation?.heading), ["Stratigraphic unit Toolachee Formation"]);
  assert.match(unit.evidence[0].text, /basin Cooper Basin; age Wuchiapingian; top 252.5 Ma; base 257.7 Ma; lithology Sandstone with coal; play Toolachee Play\.$/);
  assert.equal((await knowledgeTool("knowledge_unit", { name: "Toolachee", basin: "Galilee" }, g, signal())).evidence.length, 0);
});

test("a paused capacity, a timeout or no connection returns a notice instead of failing the scientist", async () => {
  assert.deepEqual(await knowledgeTool("knowledge_basin", { name: "Cooper" }, graph([[/./, new KnowledgeUnavailable("HTTP 400 CapacityNotActive")]]), signal()), { notice: KNOWLEDGE_UNAVAILABLE, evidence: [] });
  const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
  assert.equal((await knowledgeTool("knowledge_play", { basin: "Cooper" }, graph([[/./, timeout]]), signal())).notice, KNOWLEDGE_UNAVAILABLE);
  assert.match((await knowledgeTool("knowledge_well", { name: "Marabooka 1" }, null, signal())).notice!, /isn't connected/);
});

test("the tool server registers knowledge records under stable K IDs that read_evidence returns", async () => {
  const key = ticketKey(Buffer.alloc(32, 3).toString("base64")), store = new MemoryRunStore(), app = Fastify();
  registerToolServer(app, { reader: evidenceFixture(), manifest: async () => manifestFixture(), store, ticketKey: () => key, allowedCallers: () => ["agent-1"],
    caller: () => ({ id: "agent-1", name: "gbx-copilot", roles: [], owner: false }), knowledge: graph([[/MATCH \(b:Basin\)/, [COOPER]]]) });
  const ticket = issueRunTicket({ run: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", sub: "person-1", name: "p", roles: [], owner: false, conversation: "", booking: "", near: null, requiredSourceIds: [] }, key);
  const call = async (name: string, args: unknown) => JSON.parse((await app.inject({ method: "POST", url: MCP_PATH, headers: { [TICKET_HEADER]: ticket },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).body).result;
  const first = JSON.parse((await call("knowledge_basin", { name: "Cooper" })).content[0].text);
  const again = JSON.parse((await call("knowledge_basin", { name: "Cooper Basin" })).content[0].text);
  assert.match(first.records[0].id, /^K[0-9a-f]{10}$/);
  assert.equal(again.records[0].id, first.records[0].id);
  assert.equal(await store.count("6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"), 1);
  const read = JSON.parse((await call("read_evidence", { ids: [first.records[0].id] })).content[0].text);
  assert.match(read.evidence[0].text, /mean SHmax azimuth 99.7°/);
  const listed = JSON.parse((await app.inject({ method: "POST", url: MCP_PATH, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } })).body).result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(listed.filter((n: string) => n.startsWith("knowledge_")), ["knowledge_basin", "knowledge_unit", "knowledge_well", "knowledge_play"]);
});
