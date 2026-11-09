// Version 2's typed knowledge tools over the Fabric knowledge graph (docs/FOUNDRY_AGENTS.md, Tools).
// The scientists ask for a basin, a stratigraphic unit, a well or a play by name, never in GQL: each tool fills a fixed,
// read-only GQL query with a cleaned name, runs it on the graph model geobasin_graph through Fabric's Execute Query API
// with the site's own managed identity (Microsoft Learn, Items - Execute Query (beta)), and returns one evidence
// record per entity, which the tool server registers under a stable ID beginning with K, as it registers passages. The
// validator and the app's gate check K records like any other, and a row from a source whose reuse terms aren't
// confirmed is dropped (lib/licence.ts). While the shared capacity is paused overnight or throttled, or the graph doesn't
// answer in time, a tool returns a notice instead, and the scientists answer from passages and say the graph was unavailable.
// These tools stand in for Fabric IQ, which the scientists ask first as the person (ports.py FabricIq).
import { createHash } from "node:crypto";
import { LICENCE } from "../licence";
import type { AgentEvidence } from "../live/agent-tools";
import { KNOWLEDGE_LABEL } from "../live/serving-policy";

export const KNOWLEDGE_UNAVAILABLE = "GeoBasin's knowledge graph didn't answer, most likely because its Fabric capacity is paused or overloaded. Answer from the passages, and say under missing that structured knowledge was unavailable.";
const FABRIC = "https://api.fabric.microsoft.com";
const RECORD = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const NAME = { type: "string", minLength: 2, maxLength: 60 };

export const KNOWLEDGE_TOOLS = [
  { name: "knowledge_basin", description: "Curated facts about one basin from GeoBasin's knowledge graph: age, area, tectonic setting, depth to basement, boreholes inside its outline, and its present-day stress regime, mean SHmax azimuth and stress record count. Name the basin, for example Cooper Basin.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: NAME } }, annotations: RECORD },
  { name: "knowledge_unit", description: "Curated facts about a stratigraphic unit (formation, group or member) from GeoBasin's knowledge graph: age, age range in Ma, lithology, depositional environment, petroleum role, resource flag, basin and play. Name the unit, for example Toolachee Formation; add a basin to narrow it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: NAME, basin: NAME } }, annotations: RECORD },
  { name: "knowledge_well", description: "Curated facts about a well or borehole from GeoBasin's knowledge graph: total depth, year drilled, type, result, operator, position and basin. Name the well, for example Marabooka 1; an exact name is matched first.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: NAME } }, annotations: RECORD },
  { name: "knowledge_play", description: "Curated facts about petroleum play intervals from GeoBasin's knowledge graph: period, age, lithology, depositional environment, petroleum roles, resource flags, units and basin. Name a play, a basin, or both.",
    inputSchema: { type: "object", additionalProperties: false, properties: { name: NAME, basin: NAME } }, annotations: RECORD },
] as const;
export const KNOWLEDGE_NAMES: ReadonlySet<string> = new Set(KNOWLEDGE_TOOLS.map((t) => t.name));

export class KnowledgeUnavailable extends Error {}
export interface KnowledgeGraph { query(gql: string, signal: AbortSignal): Promise<Record<string, unknown>[]> }

/* The graph model through Fabric's REST API. A long-running query answers 202 and is followed to its result. */
export function fabricGraph(o: { workspaceId: string; graphModelId: string; token: () => Promise<string> }): KnowledgeGraph {
  const url = `${FABRIC}/v1/workspaces/${encodeURIComponent(o.workspaceId)}/graphModels/${encodeURIComponent(o.graphModelId)}/executeQuery?beta=true`;
  return {
    async query(gql, signal) {
      const headers = async () => ({ Authorization: `Bearer ${await o.token()}`, "Content-Type": "application/json" });
      let r = await fetch(url, { method: "POST", headers: await headers(), body: JSON.stringify({ query: gql }), signal }).catch((e) => { throw new KnowledgeUnavailable((e as Error).name); });
      for (let i = 0; r.status === 202 && i < 30; i++) {
        const next = r.headers.get("location");
        if (!next) break;
        await new Promise((done) => setTimeout(done, Math.min(5, Number(r.headers.get("retry-after")) || 2) * 1000));
        r = await fetch(next, { headers: await headers(), signal }).catch((e) => { throw new KnowledgeUnavailable((e as Error).name); });
      }
      const body = (await r.json().catch(() => null)) as { status?: { code?: string; description?: string }; result?: { data?: Record<string, unknown>[] }; errorCode?: string; message?: string } | null;
      const code = body?.status?.code ?? "";
      if (r.status !== 200 || !/^0[0-2]/.test(code)) throw new KnowledgeUnavailable(`HTTP ${r.status} ${body?.errorCode ?? code} ${body?.message ?? body?.status?.description ?? ""}`.trim());
      return body?.result?.data ?? [];
    },
  };
}

// Queries -----------------------------------------------------------------------------------------------------------
/* Letters, digits, spaces and a few separators, upper-cased for the graph's case-insensitive match; anything else goes,
   so nothing a model writes can reach the query as syntax. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").replace(/[^\p{L}\p{N} .\-/&]/gu, " ").replace(/\s+/g, " ").trim().toUpperCase();
  return s.length >= 2 && s.length <= 60 ? s : null;
}
const L = "`label`";
const like = (v: string, name: string) => `upper(${v}.${L}) CONTAINS '${name}'`;
const exact = (v: string, name: string) => `upper(${v}.${L}) = '${name}'`;
// Column names start with k_ because GQL reserves words such as age, year, type and source.
const BASIN = (where: string) => `MATCH (b:Basin) WHERE ${where} RETURN b.id AS k_id, b.${L} AS k_name, b.age AS k_age, b.area_km2 AS k_area_km2, b.tectonic_setting AS k_setting, b.depth_max_m AS k_depth_max_m, b.boreholes_inside AS k_boreholes, b.dominant_stress_regime AS k_regime, b.mean_shmax_azimuth_deg AS k_shmax_deg, b.stress_records_a_to_c_inside AS k_stress_ac, b.source_title AS k_from LIMIT 3`;
const UNIT = (where: string) => `MATCH (u:StratigraphicUnit) WHERE ${where} RETURN u.id AS k_id, u.${L} AS k_name, u.age AS k_age, u.age_top_ma AS k_top_ma, u.age_base_ma AS k_base_ma, u.lithology AS k_lithology, u.depositional_environment AS k_environment, u.petroleum_role AS k_role, u.resource_flag AS k_flag, u.source_title AS k_from LIMIT 5`;
const UNIT_BASINS = (where: string) => `MATCH (u:StratigraphicUnit)-[:belongsToBasin]->(b:Basin) WHERE ${where} RETURN u.id AS k_id, b.${L} AS k_basin, b.id AS k_basin_id LIMIT 25`;
const UNIT_PLAYS = (where: string) => `MATCH (u:StratigraphicUnit)-[:assignedToPlay]->(p:PlayInterval) WHERE ${where} RETURN u.id AS k_id, p.${L} AS k_play LIMIT 25`;
const WELL = (where: string) => `MATCH (w:Wellbore) WHERE ${where} RETURN w.id AS k_id, w.${L} AS k_name, w.total_depth_m AS k_td_m, w.\`year\` AS k_drilled, w.\`type\` AS k_kind, w.result AS k_result, w.operator AS k_operator, w.lat AS k_lat, w.lon AS k_lon, w.crs AS k_crs, w.source_title AS k_from LIMIT 5`;
const WELL_BASINS = (where: string) => `MATCH (w:Wellbore)-[:locatedIn]->(b:Basin) WHERE ${where} RETURN w.id AS k_id, b.${L} AS k_basin, b.id AS k_basin_id LIMIT 25`;
const PLAY = (match: string, where: string) => `${match} WHERE ${where} RETURN p.id AS k_id, p.${L} AS k_name, p.period AS k_period, p.age AS k_age, p.lithology AS k_lithology, p.depositional_environment AS k_environment, p.petroleum_roles AS k_roles, p.resource_flags AS k_flags, p.units_in_play AS k_units, p.basins AS k_basins, p.source_title AS k_from LIMIT 12`;

// Records -----------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
/* Whole numbers of a thousand or more get separators, as reports print them; years and decimals stay as stored. */
const num = (v: unknown) => typeof v === "number" ? (Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(v)) : String(v);
const REGIMES: Record<string, string> = { NF: "normal faulting", NS: "normal faulting with strike-slip", SS: "strike-slip faulting", TS: "thrust faulting with strike-slip", TF: "thrust faulting", U: "unknown" };
function parts(list: [string, unknown, ((v: unknown) => string)?][]): string {
  return list.filter(([, v]) => has(v)).map(([k, v, f]) => `${k} ${(f ?? num)(v)}`).join("; ");
}
function record(kind: string, row: Row, body: string, basin: string | null): AgentEvidence {
  const from = has(row.k_from) ? String(row.k_from) : "GeoBasin's public basin datasets";
  const name = String(row.k_name);
  const text = `${kind} ${name} (GeoBasin knowledge graph in Microsoft Fabric, from ${from}): ${body}.`;
  return { id: "K", label: `Knowledge graph: ${kind.toLowerCase()} ${name}, from ${from}`, text,
    citation: { id: `kg:${row.k_id}`, basin: basin ?? "", doc: from, page: 0, heading: `${kind} ${name}`, text, provenanceLabel: KNOWLEDGE_LABEL } };
}
const keep = (rows: Row[]) => rows.filter((r) => has(r.k_id) && has(r.k_name) && !LICENCE.isWithheldSource(r.k_from) && !LICENCE.isWithheldSource(r.k_name));

/* The scientists ask the knowledge ontology through Fabric IQ as the signed-in person, and their own code,
   never a model, registers each answer with this tool (services/scientists ports.py FabricIq), which the models aren't
   offered. The answer becomes one K record, which the validator and the app's gate check like any other; an answer that
   mentions a source whose reuse terms aren't confirmed is refused, as the typed tools drop such rows. */
export const FABRIC_IQ_RECORD = "record_fabric_iq";
export const FABRIC_IQ_WITHHELD = "Fabric IQ's answer draws on a source whose reuse terms aren't confirmed, so it can't be cited. Use knowledge_basin, knowledge_unit, knowledge_well and knowledge_play, which leave such sources out.";
export const FABRIC_IQ_TOOL_DEFINITION = {
  name: FABRIC_IQ_RECORD, description: "Register an answer that Fabric IQ gave from GeoBasin's knowledge ontology, so statements can cite it. Called by the scientists' code, not offered to models.",
  inputSchema: { type: "object", additionalProperties: false, required: ["question", "answer"],
    properties: { question: { type: "string", minLength: 3, maxLength: 300 }, answer: { type: "string", minLength: 1, maxLength: 8000 } } },
  annotations: RECORD,
} as const;
export function fabricIqEvidence(args: Record<string, unknown>): { notice?: string; evidence: AgentEvidence[] } {
  const question = typeof args.question === "string" ? args.question.replace(/\s+/g, " ").trim() : "";
  const answer = typeof args.answer === "string" ? args.answer.trim() : "";
  if (Object.keys(args).some((k) => k !== "question" && k !== "answer") || question.length < 3 || question.length > 300 || !answer || answer.length > 8000) throw new Error("Invalid tool arguments");
  if (LICENCE.isWithheldSource(answer)) return { notice: FABRIC_IQ_WITHHELD, evidence: [] };
  const text = `Fabric IQ, asked "${question}" of GeoBasin's knowledge ontology in Microsoft Fabric with the signed-in person's own permissions, answered: ${answer}`;
  const id = createHash("sha256").update(`${question}\n${answer}`).digest("hex").slice(0, 16);
  return { evidence: [{ id: "K", label: `Fabric IQ: ${question.slice(0, 120)}`, text,
    citation: { id: `fiq:${id}`, basin: "", doc: "GeoBasin knowledge ontology, through Fabric IQ", page: 0, heading: "Fabric IQ answer", text, provenanceLabel: KNOWLEDGE_LABEL } }] };
}
const shortBasin = (id: unknown) => typeof id === "string" ? id.replace(/^basin:/, "") : null;
function joined(rows: Row[], key: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) if (has(r[key])) out.set(String(r.k_id), [...new Set([...(out.get(String(r.k_id)) ?? []), String(r[key])])]);
  return out;
}

/* Runs one knowledge tool. Its records get their stable IDs from the tool server; the model sees them as evidence. */
export async function knowledgeTool(tool: string, args: Record<string, unknown>, graph: KnowledgeGraph | null, signal: AbortSignal): Promise<{ notice?: string; evidence: AgentEvidence[] }> {
  const allowed = new Set(Object.keys(KNOWLEDGE_TOOLS.find((t) => t.name === tool)?.inputSchema.properties ?? {}));
  if (!KNOWLEDGE_NAMES.has(tool) || Object.keys(args).some((k) => !allowed.has(k))) throw new Error("Invalid tool arguments");
  const name = args.name === undefined ? null : cleanName(args.name), basin = args.basin === undefined ? null : cleanName(args.basin);
  if ((args.name !== undefined && !name) || (args.basin !== undefined && !basin) || (tool !== "knowledge_play" && !name) || (!name && !basin)) throw new Error("Invalid tool arguments");
  if (!graph) return { notice: "GeoBasin's knowledge graph isn't connected on this site. Answer from the passages, and say under missing that structured knowledge was unavailable.", evidence: [] };
  try {
    if (tool === "knowledge_basin") {
      const rows = keep(await graph.query(BASIN(like("b", name!)), signal));
      return { evidence: rows.map((r) => record("Basin", r, parts([["age", r.k_age, String], ["area", r.k_area_km2, (v) => `${num(v)} km²`], ["tectonic setting", r.k_setting, String],
        ["depth to basement up to", r.k_depth_max_m, (v) => `${num(v)} m`], ["boreholes inside its outline", r.k_boreholes],
        ["dominant present-day stress regime", r.k_regime, (v) => `${v}${REGIMES[String(v)] ? ` (${REGIMES[String(v)]})` : ""}`],
        ["mean SHmax azimuth", r.k_shmax_deg, (v) => `${num(v)}°`], ["stress records of quality A to C inside its outline", r.k_stress_ac]]), shortBasin(r.k_id))) };
    }
    if (tool === "knowledge_unit") {
      const where = like("u", name!);
      const [units, basins, plays] = await Promise.all([graph.query(UNIT(where), signal), graph.query(UNIT_BASINS(where), signal), graph.query(UNIT_PLAYS(where), signal)]);
      const inBasin = joined(basins, "k_basin"), basinIds = joined(basins, "k_basin_id"), inPlay = joined(plays, "k_play");
      const rows = keep(units).filter((r) => !basin || (inBasin.get(String(r.k_id)) ?? []).some((b) => b.toUpperCase().includes(basin)));
      return { evidence: rows.map((r) => record("Stratigraphic unit", r, parts([["basin", inBasin.get(String(r.k_id))?.join(", ")], ["age", r.k_age, String],
        ["top", r.k_top_ma, (v) => `${num(v)} Ma`], ["base", r.k_base_ma, (v) => `${num(v)} Ma`], ["lithology", r.k_lithology, String],
        ["depositional environment", r.k_environment, String], ["petroleum role", r.k_role, String], ["resource flag", r.k_flag, String],
        ["play", inPlay.get(String(r.k_id))?.join(", ")]]), shortBasin(basinIds.get(String(r.k_id))?.[0]))) };
    }
    if (tool === "knowledge_well") {
      // "Marabooka 1" must not also return Marabooka 10 to 19, so an exact name is tried first.
      let where = exact("w", name!), wells = await graph.query(WELL(where), signal);
      if (!wells.length) wells = await graph.query(WELL(where = like("w", name!)), signal);
      const basins = await graph.query(WELL_BASINS(where), signal);
      const inBasin = joined(basins, "k_basin"), basinIds = joined(basins, "k_basin_id");
      return { evidence: keep(wells).map((r) => record("Well", r, parts([["total depth", r.k_td_m, (v) => `${num(v)} m`], ["drilled", r.k_drilled, String], ["type", r.k_kind, String],
        ["result", r.k_result, String], ["operator", r.k_operator, String],
        ["position", has(r.k_lat) && has(r.k_lon) ? `${r.k_lat}, ${r.k_lon}` : null, (v) => `${v} (latitude, longitude${has(r.k_crs) ? `, ${r.k_crs}` : ""})`],
        ["basin", inBasin.get(String(r.k_id))?.join(", ")]]), shortBasin(basinIds.get(String(r.k_id))?.[0]))) };
    }
    const match = basin ? "MATCH (p:PlayInterval)-[:belongsToBasin]->(b:Basin)" : "MATCH (p:PlayInterval)";
    const where = [name ? like("p", name) : "", basin ? like("b", basin) : ""].filter(Boolean).join(" AND ");
    const rows = keep(await graph.query(PLAY(match, where), signal));
    return { evidence: rows.map((r) => record("Play", r, parts([["basin", r.k_basins, String], ["period", r.k_period, String], ["age", r.k_age, String],
      ["lithology", r.k_lithology, String], ["depositional environment", r.k_environment, String], ["petroleum roles", r.k_roles, String],
      ["resource flags", r.k_flags, String], ["units assigned", r.k_units]]), null)) };
  } catch (e) {
    if (e instanceof KnowledgeUnavailable || (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") {
      console.info(JSON.stringify({ m: "knowledge graph unavailable", tool, reason: (e as Error).message.slice(0, 400) }));
      return { notice: KNOWLEDGE_UNAVAILABLE, evidence: [] };
    }
    throw e;
  }
}
