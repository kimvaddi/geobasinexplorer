import type { Citation } from "@/lib/ask";
import type { User } from "../auth";
import { greatCircleKm, placeFilter, searchScope, type Near } from "../geo";
import { LICENCE } from "../licence";
import { deterministicCheck } from "../validate";
import { activePage } from "./serving-pages";
import { packagedAllowed, packagedFilter, PACKAGED_LABEL } from "./serving-policy";
import { AGENT_TOOLS } from "./agent-definition";
import type { PublicationManifest } from "./contracts";
import type { EvidenceSearch, LiveEvidenceHit } from "./serving-evidence";

export const EVIDENCE_LIMIT = 48, TOOL_OUTPUT_CHARS = 64_000;
// Runtime-authored output for a tool call that returns nothing new because one of the answer's evidence budgets is spent.
// A Wave 4 agent that searched each named dataset separately reached the evidence limit and the transcript budget on live
// Q6 and Q9 (5 Nov 2026); ending the run there withheld answers that the evidence already returned could support.
export const BUDGET_NOTICE = JSON.stringify({ notice: "The evidence budget for this answer is used, so this call returned nothing new. Answer now from the evidence already returned, citing it, or set answerable to false and list what is missing." });
export type SpentBudget = "evidence" | "transcript" | "calls";
const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));
// A record is prepared (redacted, identity-checked and given the ID it will get) before it is registered, so a tool can
// measure what it would return and register only what the model actually receives.
interface Prepared { entry: AgentEvidence; key: string; fresh: boolean }

export interface ToolComputation {
  tool: "convert_depth_kb_to_subsea"; formula: "depthBelowKbFt - kbElevationFt";
  inputs: { name: string; value: number; unit: "ft"; evidenceId: string }[];
  output: { value: number; unit: "ft below sea level" }; sourceIds: string[];
}
export interface AgentEvidence { id: string; label: string; text: string; citation?: Citation; computation?: ToolComputation }
// The model receives each passage once, with its evidence ID, label, provenance and page identity. Citation internals
// stay in the server-side registry for validation and rendering; sending them repeated every passage's text and made a
// live Q10 exceed the answer deployment's tokens-per-minute limit (2 Nov 2026).
export function forModel(e: AgentEvidence) {
  const c = e.citation;
  return { id: e.id, label: e.label, ...(c ? { provenance: c.provenanceLabel, page: c.page, ...(c.heading ? { heading: c.heading } : {}) } : {}),
    ...(c?.live ? { sourceId: c.live.sourceId, documentSha256: c.live.documentSha256 } : {}), text: e.text, ...(e.computation ? { computation: e.computation } : {}) };
}
// No basin is part of the context: the agent's searches cover every basin, and only a place the user limits the copilot
// to narrows them (geo.ts searchScope).
export interface ToolContext { user: User; manifest: PublicationManifest; near: Near | null; requiredSourceIds?: string[] }
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
export function liveFilter(manifest: PublicationManifest): string {
  return `publishAllowed eq true and visibility eq 'public' and (${manifest.sources.map((s) =>
    `(sourceId eq ${quote(s.sourceId)} and sha256 eq ${quote(s.sha256)} and extractionVersion eq ${quote(s.extractionVersion)})`).join(" or ")})`;
}
const scoped = (ctx: ToolContext) => `(${searchScope(ctx.user, ctx.near)})`;
// Links and signatures never reach the model or a reader; applied before evidence identities are compared.
export const redactLinks = (text: string) => text.replace(/(?:https?:\/\/|blob:|data:|javascript:)[^\s<>"']+/gi, "[link omitted]").replace(/[?&]sig=[^\s<>"']+/gi, "[signature omitted]");
/* A live passage's citation, or null unless it belongs to the current publication exactly (source, file, extraction and
   page), is public, publishable, not withheld and not empty. The text is returned as stored, before redaction. */
export function liveCitation(p: LiveEvidenceHit, manifest: PublicationManifest): Citation | null {
  const source = manifest.sources.find((s) => s.sourceId === p.sourceId);
  const ref = activePage(manifest, p.sourceId, p.documentSha256, p.page);
  if (!source || !ref || source.sha256 !== p.sha256 || source.extractionVersion !== p.extractionVersion || ref.document.docId !== p.docId
    || p.visibility !== "public" || p.publishAllowed !== true || LICENCE.isWithheldPassage(p) || !p.text?.trim()) return null;
  return { id: p.id, doc: ref.document.title, page: p.page, text: p.text, heading: p.headingPath.join(" / "), basin: p.basin ?? "",
    provenanceLabel: "live", live: { sourceId: p.sourceId, documentSha256: p.documentSha256, extractionVersion: p.extractionVersion, manifestVersion: manifest.manifestVersion } };
}
function withinScope(p: { points?: { longitude: number; latitude: number }[]; geotag?: string; geoBasins?: string[] }, ctx: ToolContext) {
  if (!ctx.near) return true;
  const b = placeFilter(ctx.near).basin;
  return p.points?.some((g) => {
    const raw = g as unknown as { longitude?: number; latitude?: number; coordinates?: number[] };
    const lon = raw.longitude ?? raw.coordinates?.[0], lat = raw.latitude ?? raw.coordinates?.[1];
    return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)
      && greatCircleKm([ctx.near!.lon, ctx.near!.lat], [lon, lat]) <= ctx.near!.km;
  }) || (p.geotag === "basin" && b && p.geoBasins?.includes(b.id));
}
function argsObject(json: string, keys: string[]): Record<string, unknown> {
  if (json.length > 4096) throw new Error("Tool arguments exceed the limit");
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error("Invalid tool arguments");
  return value as Record<string, unknown>;
}
function queryOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f]/.test(value)) throw new Error("Invalid search query");
  return value.trim();
}

export class AgentTools {
  readonly evidence = new Map<string, AgentEvidence>();
  private readonly seen = new Map<string, string>();
  private readonly calls = new Map<string, { signature: string; output: string }>();
  private count = 0;
  // The budget that ended evidence gathering, once one has. The runtime then asks for the answer from evidence already returned.
  spent: SpentBudget | null = null;
  constructor(readonly context: ToolContext, private readonly reader: EvidenceSearch, private readonly maxCalls = 12) {}
  // `pending` counts records prepared ahead of this one in the same all-or-nothing batch, so their IDs stay sequential.
  private prepare(e: Omit<AgentEvidence, "id">, key: string, prefix: string, pending = 0): Prepared {
    if (e.text.length > 24_000) throw new Error("Evidence text exceeds the bounded read");
    // Apply the same redaction to repeated results before comparing immutable evidence identities.
    e = { ...e, label: redactLinks(e.label), text: redactLinks(e.text) };
    if (e.citation) e.citation = { ...e.citation, text: e.text, heading: redactLinks(e.citation.heading), doc: redactLinks(e.citation.doc) };
    const existing = this.seen.get(key);
    if (existing) {
      const prior = this.evidence.get(existing)!;
      if (prior.text !== e.text || prior.label !== e.label) throw new Error("Conflicting immutable evidence records");
      return { entry: prior, key, fresh: false };
    }
    return { entry: { ...e, id: `${prefix}${this.evidence.size + 1 + pending}` }, key, fresh: true };
  }
  private commit(p: Prepared): AgentEvidence {
    if (!p.fresh) return p.entry;
    if (this.evidence.size >= EVIDENCE_LIMIT) throw new Error("Evidence limit reached");
    if (this.evidence.has(p.entry.id) || this.seen.has(p.key)) throw new Error("Conflicting immutable evidence records");
    this.seen.set(p.key, p.entry.id); this.evidence.set(p.entry.id, p.entry); return p.entry;
  }
  private livePrepared(p: LiveEvidenceHit, pending = 0): Prepared | null {
    const citation = withinScope(p, this.context) ? liveCitation(p, this.context.manifest) : null;
    if (!citation) return null;
    return this.prepare({ label: `${citation.doc}, native PDF page ${p.page} (live)`, text: p.text, citation }, p.id.replace(/_v\d+$/, ""), "L", pending);
  }
  // Registers search results one at a time while each still fits: under the evidence limit, and within `room`, the
  // escaped characters this call may add to the conversation transcript. Returns the budget that stopped it, if any.
  private admit(candidates: Iterable<Prepared | null>, room: number, rows: ReturnType<typeof forModel>[], limit = Infinity, repeats = false): SpentBudget | null {
    const ids = new Set<string>();
    for (const p of candidates) {
      if (!p || (!repeats && ids.has(p.entry.id))) continue;
      if (p.fresh && this.evidence.size >= EVIDENCE_LIMIT) return "evidence";
      const row = forModel(p.entry), output = JSON.stringify([...rows, row]);
      if (JSON.stringify(output).length > room) return "transcript";
      // One call's output bound only shortens this result; it does not spend the answer's budget.
      if (output.length > TOOL_OUTPUT_CHARS) break;
      this.commit(p); ids.add(p.entry.id); rows.push(row);
      if (rows.length === limit) break;
    }
    return null;
  }
  async execute(name: string, json: string, callId: string, signal: AbortSignal, room = Number.POSITIVE_INFINITY): Promise<string> {
    signal.throwIfAborted();
    if (!callId || callId.length > 200) throw new Error("Invalid tool call id");
    const signature = `${name}:${json}`, cached = this.calls.get(callId);
    if (cached) { if (cached.signature !== signature) throw new Error("Tool call id reused with different arguments"); return cached.output; }
    if (!TOOL_NAMES.has(name)) throw new Error("Tool is not allowlisted");
    // A spent budget answers the call with the notice and registers nothing; the call is never run.
    const spend = (budget: SpentBudget) => { this.spent ??= budget; this.calls.set(callId, { signature, output: BUDGET_NOTICE }); return BUDGET_NOTICE; };
    const fits = (value: unknown) => JSON.stringify(JSON.stringify(value)).length <= room;
    if (++this.count > this.maxCalls) return spend("calls");
    let result: unknown;
    const ctx = this.context;
    if (name === "search_live_evidence") {
      const args = argsObject(json, ["query"]);
      const records = await this.reader.live(queryOf(args.query), `${scoped(ctx)} and ${liveFilter(ctx.manifest)}`, 24, signal);
      const rows: ReturnType<typeof forModel>[] = [];
      // Lazily prepared, so a record after the stopping point is never redacted, compared or registered.
      const full = this.admit((function* (tools) { for (const record of records) yield tools.livePrepared(record); })(this), room, rows, 8);
      if (full && !rows.length) return spend(full);
      if (full) this.spent ??= full;
      result = rows;
    } else if (name === "search_packaged_evidence") {
      const args = argsObject(json, ["query"]);
      const records = await this.reader.packaged(queryOf(args.query), packagedFilter(scoped(ctx), ctx.manifest), signal);
      const permitted = records.filter((p) => (p.visibility === "public" || p.owner === ctx.user.id) && !LICENCE.isWithheldPassage(p) && packagedAllowed(p, ctx.manifest) && withinScope(p, ctx)).slice(0, 8);
      const rows: ReturnType<typeof forModel>[] = [];
      // Packaged results are returned as found, repeats included, as before.
      const full = this.admit((function* (tools) {
        for (const p of permitted) { yield tools.prepare({ label: `${p.doc}, page ${p.page} (${PACKAGED_LABEL})`, text: p.text.slice(0, 6000),
          citation: { id: p.id, basin: p.basin ?? "", doc: p.doc, page: p.page, heading: p.heading, text: p.text.slice(0, 6000), provenanceLabel: PACKAGED_LABEL } }, `packaged:${p.id}`, "P"); }
      })(this), room, rows, Infinity, true);
      if (full && !rows.length) return spend(full);
      if (full) this.spent ??= full;
      result = rows;
    } else if (name === "open_page") {
      const args = argsObject(json, ["sourceId", "documentSha256", "page"]);
      if (typeof args.sourceId !== "string" || typeof args.documentSha256 !== "string" || typeof args.page !== "number") throw new Error("Invalid page identity");
      const ref = activePage(ctx.manifest, args.sourceId, args.documentSha256, args.page);
      if (!ref) throw new Error("Page is not currently published");
      const filter = `${scoped(ctx)} and ${liveFilter(ctx.manifest)} and sourceId eq ${quote(args.sourceId)} and documentSha256 eq ${quote(args.documentSha256)} and page eq ${args.page}`;
      const records = await this.reader.live("*", filter, 513, signal);
      if (records.length > 512) throw new Error("Page text exceeds the bounded read");
      // A page is returned complete or not at all, so its passages are prepared together and registered only if all fit.
      const batch = new Map<string, Prepared>(); let pending = 0;
      for (const p of records.filter((r) => r.sourceId === args.sourceId && r.documentSha256 === args.documentSha256 && r.page === args.page)
        .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))) {
        const c = this.livePrepared(p, pending); if (!c) continue;
        const twin = batch.get(c.key);
        if (twin) { if (twin.entry.text !== c.entry.text || twin.entry.label !== c.entry.label) throw new Error("Conflicting immutable evidence records"); continue; }
        batch.set(c.key, c); if (c.fresh) pending++;
      }
      const unique = [...batch.values()].map((c) => c.entry);
      if (!unique.length || unique.reduce((n, e) => n + e.text.length, 0) > 24_000) throw new Error("Complete page text unavailable within the limit");
      const page = { sourceId: args.sourceId, documentSha256: args.documentSha256, page: args.page, passages: unique.map((e) => ({ id: e.id, ...(e.citation?.heading ? { heading: e.citation.heading } : {}), text: e.text })) };
      if (this.evidence.size + pending > EVIDENCE_LIMIT) return spend("evidence");
      if (!fits(page)) return spend("transcript");
      for (const c of batch.values()) this.commit(c);
      result = page;
    } else if (name === "convert_depth_kb_to_subsea") {
      const a = argsObject(json, ["depthBelowKbFt", "kbElevationFt", "depthEvidenceId", "kbEvidenceId"]);
      const depth = a.depthBelowKbFt, kb = a.kbElevationFt;
      if (typeof depth !== "number" || !Number.isFinite(depth) || depth < 0 || depth > 50_000 || typeof kb !== "number" || !Number.isFinite(kb) || kb < -2000 || kb > 20_000) throw new Error("Invalid depth or elevation");
      const d = typeof a.depthEvidenceId === "string" ? this.evidence.get(a.depthEvidenceId) : undefined;
      const k = typeof a.kbEvidenceId === "string" ? this.evidence.get(a.kbEvidenceId) : undefined;
      if (!d?.citation || !k?.citation || deterministicCheck(`${depth} ft`, d.text) || deterministicCheck(`${kb} ft`, k.text)) throw new Error("Conversion inputs lack retrieved source evidence");
      const value = Math.round((depth - kb) * 10) / 10;
      const computation: ToolComputation = { tool: "convert_depth_kb_to_subsea", formula: "depthBelowKbFt - kbElevationFt",
        inputs: [{ name: "depthBelowKbFt", value: depth, unit: "ft", evidenceId: d.id }, { name: "kbElevationFt", value: kb, unit: "ft", evidenceId: k.id }],
        output: { value, unit: "ft below sea level" }, sourceIds: [...new Set([d.id, k.id])] };
      const conversion = this.prepare({ label: "Tool-derived depth conversion (verify the source datum)", text: `Depth below KB ${depth} ft minus KB elevation ${kb} ft equals ${value} ft below sea level, rounded to one decimal. Inputs from ${d.id} and ${k.id}.`, computation }, `conversion:${JSON.stringify(computation)}`, "T");
      if (conversion.fresh && this.evidence.size >= EVIDENCE_LIMIT) return spend("evidence");
      if (!fits(forModel(conversion.entry))) return spend("transcript");
      result = forModel(this.commit(conversion));
    } else throw new Error("Tool is not allowlisted");
    signal.throwIfAborted();
    const output = JSON.stringify(result);
    if (output.length > TOOL_OUTPUT_CHARS) throw new Error("Tool output limit reached");
    this.calls.set(callId, { signature, output }); return output;
  }
  expand(ids: string[]): AgentEvidence[] {
    const out = new Map<string, AgentEvidence>();
    for (const id of ids) {
      const e = this.evidence.get(id); if (!e) throw new Error("Answer cited evidence that was not retrieved");
      out.set(id, e);
      for (const sourceId of e.computation?.sourceIds ?? []) { const source = this.evidence.get(sourceId); if (!source?.citation) throw new Error("Missing computation source"); out.set(sourceId, source); }
    }
    return [...out.values()];
  }
}
