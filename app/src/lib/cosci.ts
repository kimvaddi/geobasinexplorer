import { testHypothesis, testCustom, VERDICT_RULE, DEFAULT_CTX, HYPOTHESES, type HDef, type HItem, type HResult, type Verdict } from "@/lib/hypothesis";
import { search, passes, sentencesFor } from "@/lib/search";
import { BASINS, basinById, fmt, inRings } from "@/lib/basins";
import { getKG, type KNode } from "@/lib/kg";
import { imagesForPlays, type ImageHit } from "@/lib/images";
import type { Weights } from "@/lib/analog";

/* Co-Scientist: the hypothesis test shown as a team of agents. Each agent is a tool that runs rules
   over the bundled data and cites what it used. A critic collects what argues against the statement
   and what is missing. Nothing is generated: every line is computed or quoted, and the geoscientist
   makes the call. */

export type AgentId = "literature" | "stratigraphy" | "spatial" | "rock" | "stress" | "critic";
export const AGENTS: { id: AgentId; name: string; tool: string; does: string }[] = [
  { id: "literature", name: "Literature", tool: "Search over the bundled reports", does: "Finds passages that bear on the statement" },
  { id: "stratigraphy", name: "Stratigraphy", tool: "Play and framework tables", does: "Compares ages, settings, rock types, flags and roles" },
  { id: "spatial", name: "Spatial", tool: "Depth grids, boreholes and positions", does: "Checks depths, distances and positions" },
  { id: "rock", name: "Rock", tool: "Core photos", does: "Brings the core images for the units and plays involved" },
  { id: "stress", name: "Stress", tool: "World Stress Map 2025", does: "Summarises present-day stress where it matters" },
  { id: "critic", name: "Critic", tool: "Reads every finding", does: "Lists what argues against the statement and what is missing" },
];
export interface AgentOut { id: AgentId; items: HItem[]; images: ImageHit[]; ms: number; note: string }
export interface CoSciRun {
  statement: string; prepared: HDef["id"] | null; label: "Precomputed" | "Retrieved" | "Not found"; agents: AgentOut[]; verdict: Verdict; rule: string;
  change: string[]; next: HResult["next"]; ms: number; entities: KNode[]; counts: { for: number; against: number; missing: number };
  /* Set when the Foundry scientists ran it (lib/scientists.ts); lead holds checked statements no single scientist cited. */
  engine?: { status: string; label: string; judged: number; supported: number; removed: number; session: string | null;
    tally: { for: number; against: number; context: number; missing: number }; lead: HItem[] };
}
const agentOf = (src: string): AgentId =>
  /play-interval|framework|play table/i.test(src) ? "stratigraphy" : /World Stress Map/i.test(src) ? "stress" : /core photo/i.test(src) ? "rock"
    : /depth-to-basement|grid|borehole layer|velocity chart|position|This file/i.test(src) ? "spatial" : "literature";

function literature(statement: string, max = 3): HItem[] {
  const { terms, hits } = search(statement, { limit: 8 });
  const src = (h: (typeof hits)[number]) => `${h.p.doc}${h.p.page ? `, p. ${h.p.page}` : ""}`;
  const strict = hits.filter((h) => passes(h, terms.length)).slice(0, max);
  if (strict.length) return strict.map((h) => ({ stance: "context" as const, text: sentencesFor(h.p.t, terms), source: src(h) }));
  // Nothing clears the evidence bar: show the closest passages that share the named things, marked for the geoscientist to judge.
  return hits.filter((h) => h.matched.length >= 2 && h.score >= 2 && !/metadata|references|glossary/i.test(h.p.doc)).slice(0, 2).map((h) => ({ stance: "judge" as const, text: `Related, not strong enough to count: ${sentencesFor(h.p.t, terms)}`, source: src(h) }));
}
/* Entities named in a typed statement, found by label in the knowledge graph. */
export function entitiesIn(text: string, max = 6): KNode[] {
  const g = getKG({ ccs: false, lowc: false }); const s = ` ${text.toLowerCase()} `; const out: KNode[] = [];
  const cands = [...g.nodes.values()].filter((n) => ["unit", "play", "basin", "borehole", "feature"].includes(n.type) && n.label.length >= 5)
    .sort((a, b) => b.label.length - a.label.length);
  for (const n of cands) { const l = n.label.toLowerCase(); if (s.includes(l) && !out.some((o) => o.label.toLowerCase().includes(l))) out.push(n); if (out.length >= max) break; }
  return out;
}
const prop = (n: KNode, k: string) => n.props.find(([a]) => a === k)?.[1];

export function runCoSci(input: { id?: HDef["id"]; text?: string }, ctx: { refId: string; weights: Weights } = DEFAULT_CTX): CoSciRun {
  const t0 = performance.now();
  const outs = new Map<AgentId, AgentOut>(); for (const a of AGENTS) outs.set(a.id, { id: a.id, items: [], images: [], ms: 0, note: "" });
  const timed = (id: AgentId, f: () => void) => { const t = performance.now(); f(); outs.get(id)!.ms = Math.round((performance.now() - t) * 10) / 10; };
  let statement = ""; let verdict: Verdict = "Not judged"; let change: string[] = []; let next: HResult["next"] = []; let label: CoSciRun["label"] = "Precomputed"; let entities: KNode[] = [];
  if (input.id) {
    const r = testHypothesis(input.id, ctx); statement = r.statement; verdict = r.verdict; change = r.change; next = r.next;
    entities = entitiesIn(statement);
    for (const it of r.items) outs.get(agentOf(it.source))!.items.push(it);
    timed("literature", () => { const seen = new Set(outs.get("literature")!.items.map((i) => i.text)); for (const it of literature(statement)) if (!seen.has(it.text)) outs.get("literature")!.items.push(it); });
    timed("rock", () => { outs.get("rock")!.images = r.images.length ? r.images : imagesForPlays(entities.filter((e) => e.type === "play" || e.type === "unit").map((e) => e.label), entities.map((e) => e.basin ?? "").filter(Boolean)); });
  } else {
    statement = (input.text ?? "").trim();
    const r = testCustom(statement); entities = entitiesIn(statement);
    timed("literature", () => { outs.get("literature")!.items = r.items; });
    timed("stratigraphy", () => {
      for (const e of entities.filter((x) => x.type === "unit" || x.type === "play")) outs.get("stratigraphy")!.items.push({ stance: "context",
        text: `${e.label}: ${[prop(e, "Age"), prop(e, "Lithology"), prop(e, "Depositional environment"), prop(e, "Resource flag") ?? prop(e, "Resource flags")].filter((x) => x && !/not recorded|^none$/.test(x)).join("; ")}.`, source: e.source.title });
    });
    timed("spatial", () => {
      for (const e of entities) {
        if (e.type === "basin") { const b = basinById(e.basin); if (b) outs.get("spatial")!.items.push({ stance: "context", text: `${b.name}: basin floor from ${fmt(b.depth.min)} to ${fmt(b.depth.max)} m; ${fmt(b.boreholes.length)} boreholes in the layer.`, source: "GA depth-to-basement grids and borehole layer" }); }
        if (e.type === "feature" || e.type === "borehole") outs.get("spatial")!.items.push({ stance: "context", text: `${e.label}: ${e.props.filter(([k]) => /Basin floor|Total depth|Position|Year/.test(k)).map(([k, v]) => `${k.toLowerCase()} ${v}`).join("; ")}.`, source: e.source.title });
      }
    });
    timed("rock", () => { outs.get("rock")!.images = imagesForPlays(entities.filter((e) => e.type === "play" || e.type === "unit").map((e) => e.label), entities.map((e) => e.basin ?? "").filter(Boolean)); });
    timed("stress", () => {
      for (const e of entities.filter((x) => x.type === "basin" && x.basin)) {
        const b = BASINS.find((x) => x.id === e.basin); if (!b) continue;
        const inside = b.stress.filter((s) => inRings(s[0], s[1], b.outline) && "ABC".includes(s[3])); const stated = inside.filter((s) => s[4] !== "U");
        if (b.stressSum.mean_azi_ABC != null) outs.get("stress")!.items.push({ stance: "context", text: `${b.name}: mean SHmax N${fmt(b.stressSum.mean_azi_ABC)}°E from ${inside.length} quality A–C records; ${stated.length} state a regime.`, source: "World Stress Map 2025" });
      }
    });
    label = [...outs.values()].some((o) => o.items.length) ? "Retrieved" : "Not found";
  }
  // critic: everything against or missing, plus what would change the call
  timed("critic", () => {
    const crit = outs.get("critic")!;
    for (const o of outs.values()) if (o.id !== "critic") for (const it of o.items) if (it.stance === "against" || it.stance === "missing") crit.items.push(it);
    if (!input.id) crit.items.unshift({ stance: "context", text: "No verdict for a typed statement. Read each finding and decide.", source: "Co-Scientist rule" });
    if (!crit.items.length) crit.items.push({ stance: "context", text: "Nothing argues against the statement in the data here, and nothing obvious is missing.", source: "Co-Scientist rule" });
  });
  for (const o of outs.values()) if (o.id !== "critic" && !o.items.length && !o.images.length) o.note = o.id === "stress" ? "Not needed for this statement" : "Nothing in this file for this statement";
  const all = [...outs.values()].filter((o) => o.id !== "critic").flatMap((o) => o.items);
  const counts = { for: all.filter((i) => i.stance === "for").length, against: all.filter((i) => i.stance === "against").length, missing: all.filter((i) => i.stance === "missing").length };
  return { statement, prepared: input.id ?? null, label, agents: AGENTS.map((a) => outs.get(a.id)!), verdict, rule: input.id ? VERDICT_RULE : "Typed statements get findings and no verdict.", change, next, ms: Math.round(performance.now() - t0), entities, counts };
}
export const PREPARED = HYPOTHESES;
