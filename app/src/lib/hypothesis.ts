import { BASINS, basinById, inRings, fmt } from "@/lib/basins";
import { PACK, WELLS, type Play5 } from "@/lib/pack";
import { rank, DEFAULT_WEIGHTS, playById, type Weights } from "@/lib/analog";
import { search, passes, sentencesFor } from "@/lib/search";
import { imagesForPlays, velocityImage, type ImageHit } from "@/lib/images";
import type { AnswerLabel } from "@/lib/answer5";

/* Hypothesis test: lays out the evidence in this file for and against a statement, plus what is missing.
   Prebuilt hypotheses compute their evidence from the data and cite it. A typed hypothesis gets the
   passages search finds, for the reader to judge. The verdict is a counting rule shown on screen. */
export type Stance = "for" | "against" | "missing" | "context" | "judge";
export interface HItem { stance: Stance; text: string; source: string; conf?: "high" | "medium" | "low" }
export type Verdict = "Supported" | "Supported, with gaps" | "Mixed evidence" | "Open: not enough data" | "More against than for" | "Not supported by this data" | "Not judged";
export interface HResult { id: string; statement: string; label: AnswerLabel; verdict: Verdict; items: HItem[]; change: string[]; next: { label: string; q?: string; open?: "velocity" | "figure" | "core" | "charts" }[]; images: ImageHit[]; ms?: number }
export interface HDef { id: "analog" | "rift" | "communication" | "stress"; title: string }
export const HYPOTHESES: HDef[] = [
  { id: "analog", title: "The top-ranked play is a good analog for the reference play" },
  { id: "rift", title: "The Cooper Basin's Permian plays have same-age counterparts in the Galilee and North Bowen basins" },
  { id: "communication", title: "At Marabooka 1, the Toolachee and Patchawarra reservoirs are in pressure communication" },
  { id: "stress", title: "Present-day stress in the Cooper Basin is strike-slip, with SHmax close to east–west" },
];
export const VERDICT_RULE = "The verdict counts the cited items: for, against and missing. It doesn't weigh them. You do.";
export function verdictOf(items: HItem[]): Verdict {
  const n = (s: Stance) => items.filter((i) => i.stance === s).length;
  const f = n("for"), a = n("against"), m = n("missing");
  if (!f) return "Not supported by this data";
  if (m >= 2 && f <= 1) return "Open: not enough data";
  if (!a && m <= 1) return "Supported";
  if (f > a) return "Supported, with gaps";
  if (f === a) return "Mixed evidence";
  return "More against than for";
}
const tables = (ps: Play5[]) => `GA play-interval tables, eCat ${[...new Set(ps.map((p) => p.ecat))].join(", ")}`;
const range = (p: Play5) => (p.top != null && p.base != null ? `${p.top}–${p.base} Ma` : "age not recorded");
const overlap = (a: Play5, b: Play5) => (a.top == null || b.top == null || a.base == null || b.base == null ? null : Math.min(a.base, b.base) - Math.max(a.top, b.top));
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function analogTest(refId: string, w: Weights): HResult {
  const ref = playById(refId) ?? playById(PACK.defaultRef)!;
  const top = rank(ref, w)[0]; const p = top.play; const src = tables([ref, p]); const items: HItem[] = [];
  const ov = overlap(ref, p);
  if (ov == null) items.push({ stance: "missing", text: `Age is not recorded for the ${ref.top == null ? ref.play : p.play}.`, source: src });
  else if (ov >= 1) items.push({ stance: "for", text: `Same age: the ranges share ${fmt(ov, 1)} Myr (${range(ref)} and ${range(p)}).`, source: src, conf: ov < 2 ? "medium" : "high" });
  else if (ov >= 0) items.push({ stance: "context", text: `Next to each other in age: the ranges only touch at a stage boundary (${range(ref)} and ${range(p)}).`, source: src });
  else if (-ov <= 10) items.push({ stance: "context", text: `Close in age: ${fmt(-ov, 1)} Myr apart (${range(ref)} and ${range(p)}).`, source: src });
  else items.push({ stance: "against", text: `Different ages: ${fmt(-ov, 1)} Myr apart (${range(ref)} and ${range(p)}).`, source: src });
  if (!ref.env.length || !p.env.length) items.push({ stance: "missing", text: `Depositional setting is not recorded for the ${!ref.env.length ? ref.play : p.play}.`, source: src });
  else if (top.shared.env.length) items.push({ stance: "for", text: `Shared setting: ${list(top.shared.env)}.`, source: src });
  else items.push({ stance: "against", text: `No shared setting: ${list(ref.env)} against ${list(p.env)}.`, source: src });
  if (!ref.lith.length || !p.lith.length) items.push({ stance: "missing", text: `Rock type is not recorded for the ${!ref.lith.length ? ref.play : p.play}.`, source: src });
  else if (top.shared.lith.length) items.push({ stance: "for", text: `Shared rock types: ${list(top.shared.lith)}.`, source: src });
  else items.push({ stance: "against", text: `Different rock types: ${list(ref.lith)} against ${list(p.lith)}.`, source: src });
  if (!ref.res.length && !p.res.length) items.push({ stance: "context", text: "Neither play carries a resource flag (tight gas, shale or coal seam gas).", source: src });
  else if (top.shared.res.length) items.push({ stance: "for", text: `Both are flagged for ${list(top.shared.res)}.`, source: src });
  else items.push({ stance: "against", text: `Different resource flags: ${list(ref.res) || "none"} against ${list(p.res) || "none"}.`, source: src });
  if (!ref.roles.length || !p.roles.length) items.push({ stance: "missing", text: `Reservoir, seal and source roles are not recorded for the ${!ref.roles.length ? ref.play : p.play}, so the petroleum system can't be compared.`, source: src });
  const images = imagesForPlays([ref.play, p.play], [...new Set([...ref.basins, ...p.basins])].slice(0, 2));
  const coreFor = (pl: Play5) => images.some((i) => i.why.includes(pl.play.replace(/ Play$/, "")));
  if (coreFor(ref) && coreFor(p)) items.push({ stance: "context", text: "Core photos exist for both. Compare the rocks below.", source: "GA core photography" });
  else items.push({ stance: "missing", text: `No core photo in this file for the ${!coreFor(ref) ? ref.play : p.play}.`, source: "GA core photography" });
  return { id: "analog", statement: `The ${p.play} (${p.province}) is a good analog for the ${ref.play} (${ref.province}).`, label: "Precomputed", verdict: verdictOf(items), items,
    change: ["Porosity and permeability from both plays would test the match beyond age and setting.", "Recorded reservoir, seal and source roles would let you compare the petroleum system."],
    next: [{ label: `Tell me about the ${p.play.replace(/ Play$/, "")} in the ${p.province}`, q: `Tell me about the ${p.play.replace(/ Play$/, "")} in the ${p.province}` }, { label: "Open the core photos", open: "core" }], images };
}

function riftTest(): HResult {
  const cooper = PACK.plays.filter((p) => p.province === "Cooper Basin" && p.period === "Permian").sort((x, y) => (x.top ?? 0) - (y.top ?? 0));
  const others = PACK.plays.filter((p) => /^(Galilee|North Bowen) Basin$/.test(p.province));
  const src = tables([...cooper, ...others]); const items: HItem[] = [];
  const ov = (c: Play5, o: Play5) => { const v = overlap(c, o); return v == null ? null : Math.round(v * 10) / 10; };
  const matches = cooper.map((c) => ({ c, m: others.filter((o) => (ov(c, o) ?? -1) >= 1), edge: others.filter((o) => { const v = ov(c, o); return v != null && v >= 0 && v < 1; }) }));
  for (const { c, m } of matches) {
    if (m.length) items.push({ stance: "for", text: `Same age as the ${c.play} (${range(c)}): ${list(m.map((o) => `${o.play} (${o.province.replace(" Basin", "")}, ${range(o)})`))}.`, source: src });
    else items.push({ stance: "against", text: `No Galilee or North Bowen play shares 1 Myr or more with the ${c.play} (${range(c)}).`, source: src });
  }
  const edges = matches.flatMap((x) => x.edge.map((o) => `${x.c.play.replace(/ Play$/, "")} and ${o.play.replace(/ Play$/, "")} (${fmt(ov(x.c, o)!, 1)} Myr)`));
  if (edges.length) items.push({ stance: "context", text: `Not counted: ${list(edges)}. They share less than 1 Myr, which is likely just a common stage boundary.`, source: src });
  const sameAge = [...new Set(matches.flatMap((x) => x.m))];
  const nonMarine = sameAge.filter((o) => o.env.some((e) => /fluvial|lacustrine/.test(e)));
  if (nonMarine.length) items.push({ stance: "for", text: `Fluvial or lake settings in ${nonMarine.length} of those ${sameAge.length} plays (${list(nonMarine.map((o) => o.play.replace(/ Play$/, "")))}), like the Cooper plays.`, source: src });
  const coal = sameAge.filter((o) => o.lith.includes("coal") || o.res.includes("coal seam gas"));
  const cCoal = cooper.filter((c) => c.lith.includes("coal")).map((c) => c.play.replace(/ Play$/, ""));
  if (coal.length) items.push({ stance: "for", text: `Coal recorded or flagged in ${list(coal.map((o) => o.play.replace(/ Play$/, "")))}, as in the ${list(cCoal)}.`, source: src });
  const marine = sameAge.filter((o) => o.env.includes("marine"));
  if (marine.length) items.push({ stance: "against", text: `Marine influence in ${list(marine.map((o) => o.play.replace(/ Play$/, "")))}. The Cooper plays record none, so the settings were not identical.`, source: src });
  const depth = (id: string) => basinById(id)?.stats.depth_max_m ?? null;
  items.push({ stance: "context", text: `Basin floor reaches about ${fmt(depth("cooper"))} m in the Cooper, ${fmt(depth("galilee"))} m in the Galilee and ${fmt(depth("northbowen"))} m in the North Bowen. Burial history differs.`, source: "GA depth-to-basement grids" });
  items.push({ stance: "missing", text: "No regional cross-section or seismic line in this file links the basins, so continuity between them is not tested.", source: "This file" });
  items.push({ stance: "missing", text: "Reservoir, seal and source roles are not recorded for the Cooper units.", source: tables(cooper) });
  return { id: "rift", statement: HYPOTHESES[1].title + ".", label: "Precomputed", verdict: verdictOf(items), items,
    change: ["A regional cross-section through the Cooper, Galilee and Bowen basins would test continuity directly.", "Seismic or well ties across the basin margins would show whether the intervals connect."],
    next: [{ label: "Rank analogs to the Patchawarra Play", q: "Which plays are analogs to the Cooper Basin Patchawarra Play?" }, { label: "Open the stratigraphic charts", open: "charts" }],
    images: imagesForPlays([], ["cooper", "galilee", "northbowen"]) };
}

function communicationTest(): HResult {
  const site = WELLS.find((w) => w.siteId === "marabooka-1"); const items: HItem[] = [];
  const doc = "Marabooka 1 completion report";
  const k5 = site?.findings.find((f) => f.findingId === "k5-patchawarra");
  if (k5) items.push({ stance: "for", text: "The report offers communication as one possible explanation for the water-wet Patchawarra. It does not test it.", source: `${doc}, p. ${k5.page}`, conf: "medium" });
  const tz = PACK.velocity?.items.find((i) => i.itemId === "tz-diagram")?.values ?? [];
  const top = (k: string) => Number(tz.find((v) => v.valueId === `tz-top-${k}`)?.value ?? NaN);
  const mur = top("murteree"), pat = top("patchawarra");
  if (Number.isFinite(mur) && Number.isFinite(pat)) items.push({ stance: "against", text: `The velocity chart picks a Murteree top ${fmt(pat - mur)} ft above the Patchawarra (${fmt(mur)} and ${fmt(pat)} ft below sea level). If that shale is continuous, it separates the two reservoirs.`, source: "Velocity chart (Enclosure 2)", conf: "medium" });
  const fPat = site?.fields.find((f) => f.fieldId === "f12-patchawarra"); const kb = site?.fields.find((f) => f.fieldId === "f04-kb");
  if (fPat && kb && typeof fPat.value === "number" && typeof kb.value === "number" && Number.isFinite(mur)) {
    const ss = Math.round((fPat.value - kb.value) * 10) / 10;
    items.push({ stance: "missing", text: `Where the Patchawarra starts is uncertain. The report's top (${fmt(ss, 1)} ft below sea level) sits at the chart's Murteree top, ${fmt(Math.abs(pat - ss), 0)} ft above the chart's Patchawarra.`, source: `${doc}, p. ${fPat.page}; velocity chart`, conf: "medium" });
  }
  const sip = site?.fields.find((f) => f.fieldId === "f16-dst6sip");
  if (sip) items.push({ stance: "context", text: `The only pressure in the pages read is from the Toolachee: DST 6 shut-in ${sip.value} (unit not stated, low confidence).`, source: `${doc}, p. ${sip.page}`, conf: "low" });
  items.push({ stance: "missing", text: "No Patchawarra pressure test in the pages read, so the two pressures can't be compared.", source: doc });
  const img = velocityImage();
  return { id: "communication", statement: HYPOTHESES[2].title + ".", label: "Precomputed", verdict: verdictOf(items), items,
    change: ["A Patchawarra pressure (DST or wireline) at the same datum as the Toolachee DST 6 would settle it.", "Logs across the Murteree interval would show whether the shale is there and how thick it is."],
    next: [{ label: "What is the top of the Patchawarra in Marabooka 1 below sea level?", q: "What is the top of the Patchawarra in Marabooka 1 below sea level?" }, { label: "Open the checkshot and velocity chart", open: "velocity" }], images: img ? [img] : [] };
}

function stressTest(): HResult {
  const b = BASINS.find((x) => x.id === "cooper")!; const s = b.stressSum; const items: HItem[] = [];
  const inside = b.stress.filter((r) => inRings(r[0], r[1], b.outline) && "ABC".includes(r[3]));
  const reg: Record<string, number> = {}; for (const r of inside) reg[r[4]] = (reg[r[4]] ?? 0) + 1;
  const stated = inside.filter((r) => r[4] !== "U"); const ss = reg.SS ?? 0;
  const src = "World Stress Map 2025";
  if (s.mean_azi_ABC != null) items.push({ stance: Math.abs(((s.mean_azi_ABC % 180) + 180) % 180 - 90) <= 20 ? "for" : "against", text: `Mean SHmax is N${fmt(s.mean_azi_ABC)}°E from ${fmt(inside.length)} quality A–C records inside the basin (spread ±${fmt(s.circ_std)}°). That is within 20° of east–west.`, source: src, conf: "high" });
  if (ss) items.push({ stance: "for", text: `${ss} of the ${stated.length} A–C records that state a regime are strike-slip.`, source: src, conf: "low" });
  const other = stated.length - ss;
  if (other) items.push({ stance: "against", text: `${other} of those ${stated.length} records ${other === 1 ? "states" : "state"} another regime (${Object.entries(reg).filter(([k]) => k !== "U" && k !== "SS").map(([k, v]) => `${v} ${k === "TF" ? "thrust" : k === "NF" ? "normal" : k}`).join(", ")}).`, source: src, conf: "low" });
  items.push({ stance: "missing", text: `${fmt(inside.length - stated.length)} of the ${fmt(inside.length)} A–C records don't state a regime, so the regime rests on ${stated.length} records.`, source: src });
  items.push({ stance: "missing", text: "No stress magnitudes in this file, so strike-slip can't be tested against thrust from the data here.", source: "This file" });
  return { id: "stress", statement: HYPOTHESES[3].title + ".", label: "Precomputed", verdict: verdictOf(items), items,
    change: ["Stress magnitudes from leak-off tests or image logs would test the regime.", "More records with a stated regime would firm up the call."],
    next: [{ label: "What is the SHmax orientation in the Cooper Basin?", q: "What is the SHmax orientation in the Cooper Basin?" }], images: [] };
}

export function testHypothesis(id: HDef["id"], ctx: { refId: string; weights: Weights }): HResult {
  const t0 = performance.now();
  const r = id === "analog" ? analogTest(ctx.refId, ctx.weights) : id === "rift" ? riftTest() : id === "communication" ? communicationTest() : stressTest();
  r.ms = Math.round(performance.now() - t0); return r;
}
/* A typed hypothesis: the app finds passages; the reader judges them. */
export function testCustom(statement: string): HResult {
  const t0 = performance.now(); const { terms, hits } = search(statement, { limit: 8 });
  const good = hits.filter((h) => passes(h, terms.length)).slice(0, 6);
  const items: HItem[] = good.map((h) => ({ stance: "judge", text: sentencesFor(h.p.t, terms), source: `${h.p.doc}${h.p.page ? `, p. ${h.p.page}` : ""}` }));
  return { id: "custom", statement, label: good.length ? "Retrieved" : "Not found", verdict: "Not judged", items,
    change: [], next: good.length ? [] : [{ label: "Try one of the prepared hypotheses, or name a basin, play, formation or well" }], images: [], ms: Math.round(performance.now() - t0) };
}
export const DEFAULT_CTX = { refId: PACK.defaultRef, weights: DEFAULT_WEIGHTS };
