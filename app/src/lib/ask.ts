import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";
import { inRings,
  BASINS, basinById, depthAt, depthLabel, fmt, round10, azimuthLabel, regimeLabel, unitRoles, ownUnits, tableValue, haversineKm,
  type Basin, type Borehole, type Passage, type Unit,
} from "@/lib/basins";

/* Question answering over the four basin packages: intent rules compute numbers from the
   GA grids, borehole tables and World Stress Map records; everything else is ranked
   retrieval (BM25 + phrase boost) over the published report text, with page citations. */

export type Provenance = "published" | "computed" | "extracted" | "rule";
export interface Citation {
  id: string; basin: string; doc: string; page: number; heading: string; text: string;
  provenanceLabel?: "live" | "packaged snapshot" | "knowledge graph";
  live?: { sourceId: string; documentSha256: string; extractionVersion: string; manifestVersion: number };
}
export interface MapFocus { lon: number; lat: number; zoom: number; ringKm?: number; label?: string }
export interface Answer {
  id: string;
  question: string;
  status: "answered" | "declined" | "unsupported";
  basin: string | null;
  paragraphs: string[];
  provenance: Provenance[];
  citations: Citation[];
  focus: MapFocus | null;
  focusBasin: string | null;
  highlight: string[];
  table?: { columns: string[]; rows: string[][] };
  layers?: Partial<{ depth: boolean; faults: boolean; boreholes: boolean; stress: boolean }>;
  followUps: string[];
  why: { terms: string[]; rule: string; scores: { id: string; score: number }[] };
  site?: string | null;
  
}

export const STARTERS = [
  "Which plays are analogs to the Cooper Basin Patchawarra Play?",
  "Which Adavale units are reservoirs?",
  "How deep is the Taroom Trough?",
  "What is the SHmax orientation in the Cooper Basin?",
  "Tell me about the Toolachee Formation",
  "What is a play interval?",
  "What was the DST 10 shut-in pressure in Innamincka 1?",
  "Compare the four basins",
  "How many Galilee boreholes are deeper than 2,000 m?",
  "How old is the North Bowen Basin?",
].filter((q) => !GATED || !LICENCE.referencesWithheld(q));

/* ---------- text processing ---------- */
const STOP = new Set(("a an the of in on at to for from by with and or is are was were be been it its this that these those what which who whom how why when where " +
  "do does did can could would should will about into than then there their them they we you your our i me my as if not no yes any all some per vs " +
  "tell show give list find me please basin basins region data").split(" "));
function stem(w: string) {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}
export function tokens(s: string, keepStop = false) {
  return s.toLowerCase().replace(/co₂/g, "co2").split(/[^a-z0-9]+/).filter((w) => w && (keepStop || !STOP.has(w))).map(stem);
}
const SYN: Record<string, string[]> = { well: ["borehole"], borehole: ["well"], deep: ["depth", "deepest"], old: ["age"], thick: ["thickness"] };

interface Doc { p: Passage & { basin: string }; tf: Map<string, number>; len: number; bigrams: Set<string>; lower: string }
let INDEX: { docs: Doc[]; df: Map<string, number>; avg: number } | null = null;
function index() {
  if (INDEX) return INDEX;
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  for (const b of BASINS) for (const p of b.passagesWithBasin) {
    const toks = tokens(`${p.h} ${p.t}`);
    const tf = new Map<string, number>();
    toks.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
    tf.forEach((_, t) => df.set(t, (df.get(t) ?? 0) + 1));
    const bigrams = new Set<string>();
    for (let i = 1; i < toks.length; i++) bigrams.add(toks[i - 1] + " " + toks[i]);
    docs.push({ p, tf, len: toks.length, bigrams, lower: `${p.h} ${p.t}`.toLowerCase() });
  }
  INDEX = { docs, df, avg: docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length) };
  return INDEX;
}
function search(q: string, basin: string | null, limit = 4) {
  const ix = index();
  const terms = tokens(q);
  const expanded = terms.flatMap((t) => (SYN[t] ?? []).map(stem));
  const bigrams: string[] = [];
  for (let i = 1; i < terms.length; i++) bigrams.push(terms[i - 1] + " " + terms[i]);
  const N = ix.docs.length;
  const scored = ix.docs
    .filter((d) => !basin || d.p.basin === basin)
    .map((d) => {
      let s = 0;
      const score = (t: string, w: number) => {
        const f = d.tf.get(t);
        if (!f) return;
        const n = ix.df.get(t) ?? 1;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += w * idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / ix.avg))));
      };
      terms.forEach((t) => score(t, 1));
      expanded.forEach((t) => score(t, 0.5));
      bigrams.forEach((bg) => { if (d.bigrams.has(bg)) s += 1.5; });
      const covered = terms.filter((t) => d.tf.has(t) || (SYN[t] ?? []).some((x) => d.tf.has(stem(x)))).length;
      return { d, s, coverage: terms.length ? covered / terms.length : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, z) => z.s - a.s)
    .slice(0, limit);
  return { terms, scored };
}
const cite = (p: Passage & { basin: string }): Citation => ({ id: p.id, basin: p.basin, doc: p.doc, page: p.page, heading: p.h, text: p.t });
const docRank = (doc: string) => (/report$/i.test(doc) ? 0 : /glossary/i.test(doc) ? 3 : /catalogue/i.test(doc) ? 4 : /metadata/i.test(doc) ? 2 : 1);
function passagesMentioning(name: string, basin: string | null, limit = 2) {
  const key = name.toLowerCase();
  return index().docs
    .filter((d) => (!basin || d.p.basin === basin) && d.lower.includes(key))
    .sort((a, z) => docRank(a.p.doc) - docRank(z.p.doc))
    .slice(0, limit).map((d) => cite(d.p));
}
function uniqueCites(list: Citation[]) {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
export function areaShort(b: Basin) {
  const v = tableValue(b, /area/i);
  const m = v?.match(/^[~≈>]?\s*[\d,.]+\s*km(²|2)/);
  return m ? m[0].replace(/km2$/, "km²") : `${fmt(b.stats.area_km2)} km²`;
}
const firstNumber = (v: string | null) => { const m = v?.match(/[\d,]+(\.\d+)?/); return m ? parseFloat(m[0].replace(/,/g, "")) : null; };
const RESOURCE_FLAG: Record<string, string> = { CCS: "geological storage of carbon", CSG: "coal seam gas" };
export const resourceFlag = (unc: string) => RESOURCE_FLAG[unc] ?? unc.toLowerCase();
function bestSentences(text: string, terms: string[], max = 2) {
  const sents = text.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter((s) => s.length > 30);
  const ranked = sents.map((s, i) => ({ s, i, k: tokens(s).filter((t) => terms.includes(t)).length })).sort((a, z) => z.k - a.k || a.i - z.i).slice(0, max);
  return ranked.sort((a, z) => a.i - z.i).map((x) => x.s).join(" ");
}

/* ---------- entity detection ---------- */
function detectBasins(q: string): Basin[] {
  const s = q.toLowerCase();
  const out: Basin[] = [];
  if (/\bcooper\b/.test(s)) out.push(basinById("cooper")!);
  if (/\badavale\b/.test(s)) out.push(basinById("adavale")!);
  if (/\bgalilee\b/.test(s)) out.push(basinById("galilee")!);
  if (/\b(north\s+)?bowen\b/.test(s)) out.push(basinById("northbowen")!);
  return out;
}
// Words the four basin packages are named with. A question that capitalises any other word ("AusAEM", "Honeysuckle
// Creek") outside a sentence's first word names something these packages don't hold.
const PACKAGE_WORDS = new Set(["cooper", "adavale", "galilee", "north", "bowen", "basin", "basins", "tegi", "ga", "geoscience", "australia", "australian", "queensland", "south"]);
function namesOtherThings(q: string): boolean {
  for (const m of q.matchAll(/[A-Za-z][A-Za-z0-9'’-]*/g)) {
    const before = q.slice(0, m.index).trimEnd();
    if (!before || /[.?!:;]$/.test(before) || m[0] === "I" || !/[A-Z]/.test(m[0])) continue;
    if (!PACKAGE_WORDS.has(m[0].toLowerCase().replace(/['’]s$/, ""))) return true;
  }
  return false;
}
interface NamedPlace { name: string; basin: Basin; lon: number; lat: number; max: number | null; mean: number | null; p90: number | null; radius: number; approx: boolean; labelLon: number; labelLat: number; labelMax: number | null; labelMean: number | null }
function places(): NamedPlace[] {
  const out: NamedPlace[] = [];
  for (const b of BASINS) {
    for (const f of b.features) {
      const z = b.zones.find((zz) => zz.n === f.n || zz.n === f.zone);
      out.push({
        name: f.n, basin: b, lon: z ? z.c[0] : f.lon, lat: z ? z.c[1] : f.lat,
        max: z ? z.max : f.fst ? f.fst[0] : null, mean: z ? z.mean : f.fst ? f.fst[1] : null, p90: z ? z.p90 : f.fst ? f.fst[2] : null,
        radius: z ? z.r : f.fst ? f.fst[4] : 25, approx: f.approx, labelLon: f.lon, labelLat: f.lat,
        labelMax: f.fst ? f.fst[0] : null, labelMean: f.fst ? f.fst[1] : null,
      });
    }
    for (const z of b.zones) {
      if (/unnamed/i.test(z.n) || out.some((o) => o.name === z.n)) continue;
      out.push({ name: z.n, basin: b, lon: z.c[0], lat: z.c[1], max: z.max, mean: z.mean, p90: z.p90, radius: z.r, approx: false, labelLon: z.c[0], labelLat: z.c[1], labelMax: null, labelMean: null });
    }
  }
  return out;
}
let PLACES: NamedPlace[] | null = null;
function findPlace(q: string): NamedPlace | null {
  PLACES ??= places();
  const s = ` ${q.toLowerCase().replace(/[^a-z0-9 ]/g, " ")} `;
  let best: NamedPlace | null = null;
  for (const p of PLACES) {
    const n = p.name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, " ").trim();
    const first = n.split(/\s+/)[0];
    const hit = s.includes(` ${n} `) || (first.length >= 5 && !["north", "south", "western", "eastern", "folded", "basin"].includes(first) && s.includes(` ${first} `));
    if (hit && (!best || n.length > best.name.length)) best = p;
  }
  return best;
}
function findUnit(q: string, prefer: Basin | null): { u: Unit; b: Basin; also: Basin[] } | null {
  const s = ` ${q.toLowerCase().replace(/[^a-z0-9 -]/g, " ")} `;
  const hits: { u: Unit; b: Basin; len: number }[] = [];
  for (const b of BASINS) for (const u of b.units) {
    const n = u.n.toLowerCase();
    // "Lower" or "upper" alone names no unit ("the Lower Macquarie" is not the lower Aldebaran Formation), so such a
    // name also needs its next word, anywhere in the question ("the lower part of the Aldebaran").
    const words = n.split(/[\s–-]+/), key = /^(?:lower|middle|upper)$/.test(words[0]) && words[1] ? words.slice(0, 2) : [words[0]], first = key.join(" ");
    if (s.includes(` ${n} `) || (first.length >= 5 && key.every((w) => s.includes(` ${w} `)) && !/basin|undifferentiated|unnamed/.test(first))) hits.push({ u, b, len: n.length });
  }
  if (!hits.length) return null;
  hits.sort((a, z) => z.len - a.len);
  const top = hits.filter((h) => h.u.n === hits[0].u.n);
  const pick = (prefer && top.find((h) => h.b.id === prefer.id)) || top[0];
  return { u: pick.u, b: pick.b, also: top.filter((h) => h.b.id !== pick.b.id).map((h) => h.b) };
}

/* ---------- answer builders ---------- */
let SEQ = 0;
function base(question: string): Answer {
  SEQ += 1;
  return { id: `a${Date.now().toString(36)}${SEQ}`, question, status: "answered", basin: null, paragraphs: [], provenance: [], citations: [], focus: null, focusBasin: null, highlight: [], followUps: [], why: { terms: tokens(question), rule: "", scores: [] } };
}
const OUT_OF_SCOPE: [RegExp, string][] = [
  [/\b(price|prices|stock|share price|market|revenue|profit|dollars?|brent|wti|valuation|npv|commodity)\b/i, "market prices or financials"],
  [/\b(today|yesterday|tomorrow|this (week|month)|right now|latest news|news|headlines?)\b/i, "news or live information"],
  [/\b(weather|forecast|cyclones?|rain(fall)?)\b/i, "weather"],
  [/\b(workshops?|meetings?|confidential|proposals?|budgets?|contracts?|salary|salaries|commercial terms?|company strategy)\b/i, "company, commercial or meeting matters"],
  [/\b(ceo|chief executive|chair(man|woman|person)?|president|who (is|was|runs|owns)|phone|email address|employees?|staff)\b/i, "information about people or organisations"],
];
function declined(a: Answer, what: string) {
  a.status = "declined";
  a.paragraphs = [
    "That's outside what this file holds. It covers published geology for four Australian basins.",
    `It has no ${what}: only Geoscience Australia reports, maps, boreholes and depth grids, plus World Stress Map records, for the Cooper, Adavale, Galilee and North Bowen basins.`,
  ];
  a.followUps = [STARTERS[0], STARTERS[2], STARTERS[4]];
  a.why.rule = `Declined: question is about ${what}`;
  return a;
}

function placeAnswer(a: Answer, p: NamedPlace): Answer {
  const b = p.basin;
  a.basin = b.id; a.provenance = ["computed", "published"];
  const off = haversineKm(p.lon, p.lat, p.labelLon, p.labelLat);
  if (p.max != null) {
    a.paragraphs.push(`In the **${p.name}** (${b.name}) the basin floor reaches **${depthLabel(p.max)}** (mean ${depthLabel(p.mean)}, P90 ${depthLabel(p.p90)}) within ${fmt(p.radius)} km of ${off > 15 ? "its computed deepest point" : "the feature"}, sampled from Geoscience Australia's depth-to-base grid.`);
    if (off > 15 && p.labelMean != null) a.paragraphs.push(`Around the GA label point itself the floor averages ${depthLabel(p.labelMean)} (max ${depthLabel(p.labelMax)}); the label marks the feature, the depocentre marks its deepest part.`);
  } else a.paragraphs.push(`The **${p.name}** is mapped in the ${b.name}, but the depth grid has no coverage around it.`);
  if (p.approx) a.paragraphs.push("Position is approximate: the feature is named in the report text only.");
  a.citations = passagesMentioning(p.name, b.id, 2);
  a.focus = { lon: p.lon, lat: p.lat, zoom: 7.6, ringKm: p.radius, label: p.name };
  a.followUps = [`How many ${b.short} boreholes are deeper than 2,000 m?`, `What is the SHmax orientation in the ${b.name}?`];
  a.why.rule = "Named feature: depth statistics from the GA grid";
  return a;
}

function countAnswer(a: Answer, basins: Basin[], depth: number): Answer {
  const list = basins.length ? basins : BASINS;
  a.provenance = ["computed"]; a.basin = list.length === 1 ? list[0].id : null;
  const rows: string[][] = [];
  let deepest: Borehole[] = [];
  for (const b of list) {
    const inside = b.boreholes.filter((w) => w.inside);
    const deep = inside.filter((w) => (w.td ?? 0) > depth);
    const noTd = inside.filter((w) => w.td == null).length;
    rows.push([b.name, fmt(inside.length), fmt(deep.length), fmt(noTd)]);
    deepest = deepest.concat(deep);
    if (list.length === 1) {
      a.paragraphs.push(`**${fmt(deep.length)}** of ${fmt(inside.length)} public boreholes inside the ${b.name} outline have a total depth greater than **${fmt(depth)} m**.`);
      if (noTd) a.paragraphs.push(`${fmt(noTd)} boreholes have no recorded total depth, so the true count could be higher.`);
    }
  }
  deepest.sort((x, y) => (y.td ?? 0) - (x.td ?? 0));
  if (list.length > 1) a.paragraphs.push(`Across the ${list.length === BASINS.length ? "four basins" : "selected basins"}, **${fmt(deepest.length)}** public boreholes inside the outlines have a total depth greater than **${fmt(depth)} m**.`);
  const named = deepest.filter((w) => w.name).slice(0, 4);
  if (named.length) a.paragraphs.push(`The deepest named wells are ${named.map((w) => `**${w.name}** (${fmt(w.td)} m)`).join(", ")}.`);
  if (list.length === 1 && list[0].id === "galilee" && named.some((w) => BASINS.find((o) => o.id === "adavale" && w.lon >= o.bbox[0] && w.lon <= o.bbox[2] && w.lat >= o.bbox[1] && w.lat <= o.bbox[3])))
    a.paragraphs.push("Several of these also sit inside the Adavale Basin outline. The basins are stacked, so the deepest wells may target the older basin below.");
  if (list.length > 1) a.table = { columns: ["Basin", "Boreholes inside", `Deeper than ${fmt(depth)} m`, "No recorded depth"], rows };
  a.highlight = deepest.slice(0, 400).map((w) => w.key);
  a.layers = { boreholes: true };
  if (list.length === 1) { a.focusBasin = list[0].id; a.citations = passagesMentioning("borehole", list[0].id, 1); }
  a.followUps = [`How deep is the ${list[0].name} floor?`, "Compare the four basins"];
  a.why.rule = `Count of boreholes with total depth > ${depth} m (inside each basin outline)`;
  return a;
}

function depthAnswer(a: Answer, b: Basin): Answer {
  a.basin = b.id; a.provenance = ["computed", "published"];
  const zones = b.zones.slice().sort((x, y) => y.max - x.max);
  const z = zones[0];
  a.paragraphs.push(`On Geoscience Australia's depth-to-base grid the ${b.name} floor lies between **${depthLabel(b.stats.depth_min_m ?? b.depth.min)}** and **${depthLabel(b.stats.depth_max_m ?? b.depth.max)}**.`);
  if (z) a.paragraphs.push(`The deepest area is **${z.n.replace(/ \(unnamed\)/, "")}**: up to ${depthLabel(z.max)}, mean ${depthLabel(z.mean)} within ${fmt(z.r)} km.`);
  const pub = tableValue(b, /maximum depth|depth to base/i);
  const pubN = firstNumber(pub), gridN = b.stats.depth_max_m ?? null;
  if (pub && pubN != null && gridN != null) a.paragraphs.push(Math.abs(pubN - gridN) / Math.max(1, pubN) < 0.02
    ? `That matches the maximum depth to base in the GA report (Table 1: ${pub}).`
    : `The GA report gives a maximum depth to base of ${pub} (Table 1); the grid maximum differs because the report rounds and the grid is sampled cell by cell.`);
  a.citations = uniqueCites(passagesMentioning("depocentre", b.id, 1).concat(passagesMentioning("maximum", b.id, 1))).slice(0, 2);
  if (z) a.focus = { lon: z.c[0], lat: z.c[1], zoom: 7, ringKm: z.r, label: z.n };
  a.focusBasin = b.id;
  a.followUps = [`How many ${b.short} boreholes are deeper than 2,000 m?`, `How old is the ${b.name}?`];
  a.why.rule = "Basin depth: grid minimum/maximum and computed depocentres";
  return a;
}

function compareAnswer(a: Answer): Answer {
  a.provenance = ["computed", "published"];
  const rows = BASINS.map((b) => [
    b.name,
    areaShort(b),
    depthLabel(b.stats.depth_max_m ?? b.depth.max),
    fmt(b.boreholes.filter((w) => w.inside).length),
    fmt(b.faults.length),
    `${fmt(b.stressSum.n_ABC_in)} of ${fmt(b.stressSum.n_in)}`,
  ]);
  a.table = { columns: ["Basin", "Area", "Deepest floor", "Boreholes", "Faults mapped", "Stress records (A–C)"], rows };
  const deepest = BASINS.slice().sort((x, y) => (y.stats.depth_max_m ?? 0) - (x.stats.depth_max_m ?? 0))[0];
  const dense = BASINS.slice().sort((x, y) => y.boreholes.filter((w) => w.inside).length / (y.stats.area_km2 ?? 1) - x.boreholes.filter((w) => w.inside).length / (x.stats.area_km2 ?? 1))[0];
  const per1000 = (b: Basin) => (1000 * b.boreholes.filter((w) => w.inside).length) / (b.stats.area_km2 ?? 1);
  a.paragraphs.push(deepest.id === dense.id
    ? `The **${deepest.name}** is both the deepest (to ${depthLabel(deepest.stats.depth_max_m ?? null)}) and the most densely drilled (${fmt(per1000(dense), 1)} boreholes per 1,000 km²).`
    : `The **${deepest.name}** is the deepest (to ${depthLabel(deepest.stats.depth_max_m ?? null)}); the **${dense.name}** is the most densely drilled (${fmt(per1000(dense), 1)} boreholes per 1,000 km²).`);
  a.paragraphs.push("Fault counts reflect different mapping scales and sources, so compare them with care.");
  a.followUps = [STARTERS[3], STARTERS[4]];
  a.why.rule = "Comparison across the four basin packages";
  return a;
}

function stressAnswer(a: Answer, basins: Basin[]): Answer {
  const list = basins.length ? basins : BASINS;
  a.provenance = ["computed"];
  for (const b of list) {
    const s = b.stressSum;
    if (!s.n_in) {
      a.paragraphs.push(`**No.** The World Stress Map 2025 has no stress records inside the ${b.name}. The nearest lies about ${fmt(s.nearest_km_if_none ?? s.nearest_km)} km from the basin centre; ${fmt(s.n_ABC_buffer)} quality A–C records within ${list.length === 1 ? "150 km" : "the buffer"} give a mean SHmax of ${azimuthLabel(s.mean_azi_ABC_buffer)}.`);
      a.paragraphs.push("Any geomechanics here needs an assumed stress orientation. Treat it as a scenario until there are measurements.");
    } else {
      const abc = b.stress.filter((r) => inRings(r[0], r[1], b.outline) && "ABC".includes(r[3]));
      const stated = abc.filter((r) => r[4] !== "U"); const reg: Record<string, number> = {}; for (const r of stated) reg[r[4]] = (reg[r[4]] ?? 0) + 1;
      a.paragraphs.push(`The World Stress Map 2025 holds **${fmt(s.n_in)}** records inside the ${b.name}, ${fmt(s.n_ABC_in)} of quality A–C. Their mean SHmax is **${azimuthLabel(s.mean_azi_ABC)}** (circular s.d. ${fmt(s.circ_std)}°).`);
      if (abc.length) a.paragraphs.push(stated.length ? `Only ${stated.length} of those ${abc.length} records state a regime: ${Object.entries(reg).map(([k, v]) => `${v} ${regimeLabel(k)}`).join(", ")}. Treat the regime as weakly constrained.` : "None of those records state a regime.");
      if (s.n_ABC_in < 10) a.paragraphs.push(`That is thin data. Treat the ${b.short} orientation as indicative.`);
    }
  }
  if (list.length === 1) { a.basin = list[0].id; a.focusBasin = list[0].id; }
  a.followUps = list.length === 1 ? [`How deep is the ${list[0].name} floor?`, "Compare the four basins"] : [STARTERS[4]];
  a.layers = { stress: true };
  a.why.rule = "Stress: World Stress Map 2025 records (axial mean of quality A–C)";
  return a;
}

function rolesAnswer(a: Answer, b: Basin, role: string): Answer {
  a.basin = b.id; a.focusBasin = b.id; a.provenance = ["published"];
  const units = ownUnits(b);
  const withRole = units.filter((u) => unitRoles(u).includes(role));
  if (withRole.length) {
    a.paragraphs.push(`The GA framework for the ${b.name} marks **${withRole.length}** ${role} unit${withRole.length > 1 ? "s" : ""}: ${withRole.map((u) => `**${u.n}**`).join(", ")}.`);
    const other = (["reservoir", "seal", "source"] as const).filter((r) => r !== role).map((r) => [r, units.filter((u) => unitRoles(u).includes(r))] as const).filter(([, l]) => l.length);
    if (other.length) a.paragraphs.push(`Other roles in the same framework: ${other.map(([r, l]) => `${r}s: ${l.map((u) => u.n).join(", ")}`).join("; ")}.`);
    a.paragraphs.push("The framework classifies roles; it does not rank a main one.");
  } else {
    a.paragraphs.push(`The ${b.name} package doesn't assign a ${role} role to any unit: its framework lists ${units.length} units with age and environment, but no reservoir, seal or source classification.`);
    const unc = units.filter((u) => u.unc);
    if (unc.length) a.paragraphs.push(`What it does record: ${unc.length} unit${unc.length > 1 ? "s" : ""} flagged for unconventional resources: ${unc.slice(0, 6).map((u) => `**${u.n}** (${u.unc})`).join(", ")}.`);
  }
  a.citations = uniqueCites(passagesMentioning("petroleum systems", b.id, 1).concat(passagesMentioning(role, b.id, 1))).slice(0, 2);
  a.followUps = [`How old is the ${b.name}?`, `How deep is the ${b.name} floor?`];
  a.why.rule = `Unit roles (${role}) from the GA stratigraphic framework`;
  return a;
}

function unitAnswer(a: Answer, hit: { u: Unit; b: Basin; also: Basin[] }): Answer {
  const { u, b } = hit;
  a.basin = b.id; a.focusBasin = b.id; a.provenance = ["published"];
  const bits = [u.rank, u.age && `${u.age}${u.top != null && u.base != null ? ` (${fmt(u.top, 1)}–${fmt(u.base, 1)} Ma)` : ""}`, u.lith && u.lith.toLowerCase(), u.env && u.env.toLowerCase()].filter(Boolean);
  a.paragraphs.push(`**${u.n}** (${b.name}): ${bits.join(", ")}.`);
  const roles = unitRoles(u);
  if (roles.length || u.unc || u.hydro) a.paragraphs.push([roles.length && `Petroleum role: ${roles.join(", ")}.`, u.unc && `Resource flag: ${resourceFlag(u.unc)}.`, u.hydro && `Hydrostratigraphy: ${u.hydro}.`].filter(Boolean).join(" "));
  if (u.play) a.paragraphs.push(`Play interval: ${/play/i.test(u.play) ? u.play : u.play.replace(/-/g, "–").replace(/\b\w/g, (c) => c.toUpperCase()) + " Play"}.`);
  if (hit.also.length) a.paragraphs.push(`The same unit is also mapped in the ${hit.also.map((x) => x.name).join(" and ")}.`);
  a.citations = uniqueCites(passagesMentioning(u.n, b.id, 4).concat(passagesMentioning(u.n.split(/\s+/)[0], b.id, 4)))
    .sort((x, y) => docRank(x.doc) - docRank(y.doc)).slice(0, 2);
  a.followUps = [`Which ${b.short} units are reservoirs?`, `How old is the ${b.name}?`];
  a.why.rule = "Stratigraphic unit: GA framework attributes";
  return a;
}

function ageAnswer(a: Answer, b: Basin): Answer {
  a.basin = b.id; a.focusBasin = b.id; a.provenance = ["published"];
  const age = tableValue(b, /^age/i) ?? b.age;
  a.paragraphs.push(`The ${b.name} spans **${age}** (GA report, Table 1).`);
  const own = ownUnits(b);
  if (own.length) a.paragraphs.push(`Its framework runs from the **${own[own.length - 1].n}** (oldest) to the **${own[0].n}** (youngest), ${own.length} units in all.`);
  a.citations = passagesMentioning("Table 1", b.id, 1);
  a.followUps = [`Which ${b.short} units are reservoirs?`, `How deep is the ${b.name} floor?`];
  a.why.rule = "Basin age: GA Table 1";
  return a;
}

function definitionAnswer(a: Answer, term: string): Answer | null {
  const t = term.toLowerCase().replace(/[?.!]+$/, "").trim();
  const gloss = index().docs.filter((d) => /glossary/i.test(d.p.doc));
  const termOf = (d: Doc) => d.p.h.replace(/^Glossary:\s*/i, "").toLowerCase();
  const hit = gloss.find((d) => termOf(d) === t) ?? gloss.filter((d) => t.includes(termOf(d)) && termOf(d).length >= 3).sort((x, y) => termOf(y).length - termOf(x).length)[0];
  if (!hit) return null;
  a.provenance = ["published"];
  a.paragraphs.push(hit.p.t.replace(/^([^:]{2,60}):/, "**$1**:"));
  if (/play/.test(t)) {
    const counts = BASINS.map((b) => `${b.short} ${b.plays.filter((pl) => !/basement/i.test(pl.n)).length}`);
    a.paragraphs.push(`The four packages define play intervals as follows: ${counts.join(", ")}.`);
    a.provenance.push("computed");
  }
  a.citations = [cite(hit.p)];
  a.followUps = ["Which Adavale units are reservoirs?", "Compare the four basins"];
  a.why.rule = "Definition: GA TEGI glossary entry";
  return a;
}

let NAMED: { w: Borehole; key: string }[] | null = null;
function findBorehole(q: string): Borehole | null {
  NAMED ??= BASINS.flatMap((b) => b.boreholes.filter((w) => w.name && /\d/.test(w.name)).map((w) => ({ w, key: ` ${(w.name as string).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} ` })));
  const s = ` ${q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const hits = NAMED.filter((n) => n.key.length > 5 && s.includes(n.key)).sort((x, y) => y.key.length - x.key.length);
  return hits[0]?.w ?? null;
}
function boreholeAnswer(a: Answer, w: Borehole): Answer {
  const b = basinById(w.basin) as Basin;
  a.basin = b.id; a.provenance = ["published", "computed"];
  const floor = depthAt(b, w.lon, w.lat);
  const type = w.type.toLowerCase();
  a.paragraphs.push(`**${w.name}** is a ${type === "unknown" ? "" : type + " "}borehole in the ${b.name}${w.inside ? "" : " area (just outside the basin outline)"}${w.year ? `, drilled in ${w.year}` : ""}${w.td ? `, to a total depth of **${fmt(w.td)} m**` : ""}.`);
  if (w.operator || w.result) a.paragraphs.push([w.operator && `Operator: ${w.operator}.`, w.result && `Result: ${w.result}.`].filter(Boolean).join(" "));
  if (floor != null) a.paragraphs.push(`The GA depth grid puts the basin floor here at about ${depthLabel(floor)}${w.td ? `. The well ${w.td >= floor ? "reaches" : "stops above"} it` : ""}.`);
  a.citations = passagesMentioning((w.name as string).split(/\s+/)[0], b.id, 2);
  a.focus = { lon: w.lon, lat: w.lat, zoom: 9, label: w.name as string };
  a.highlight = [w.key]; a.layers = { boreholes: true };
  a.followUps = [`How many ${b.short} boreholes are deeper than 2,000 m?`, `How deep is the ${b.name} floor?`];
  a.why.rule = "Named borehole: GA borehole table + depth grid at its location";
  return a;
}
function faultsAnswer(a: Answer, b: Basin): Answer {
  a.basin = b.id; a.focusBasin = b.id; a.provenance = ["computed", "published"]; a.layers = { faults: true };
  let sx = 0, sy = 0, total = 0;
  for (const f of b.faults) {
    for (let i = 1; i < f.length; i++) {
      const [x1, y1] = f[i - 1], [x2, y2] = f[i];
      const dx = (x2 - x1) * Math.cos(((y1 + y2) / 2) * Math.PI / 180), dy = y2 - y1;
      const len = haversineKm(x1, y1, x2, y2); total += len;
      const th = 2 * Math.atan2(dx, dy); sx += len * Math.sin(th); sy += len * Math.cos(th);
    }
  }
  const strike = ((Math.atan2(sx, sy) / 2) * 180 / Math.PI + 180) % 180;
  const r = Math.hypot(sx, sy) / Math.max(1, total);
  const km = b.stats.fault_km ?? total;
  a.paragraphs.push(`The ${b.name} package maps **${fmt(b.faults.length)}** faults with about ${fmt(km)} km of traces${b.folds.length ? `, plus ${fmt(b.folds.length)} fold axes` : ""}.`);
  a.paragraphs.push(r > 0.25
    ? `Their length-weighted mean strike is about **${azimuthLabel(strike)}**: ${strike < 30 || strike > 150 ? "a dominantly north–south grain" : strike < 60 ? "a north-east grain" : strike < 120 ? "a dominantly east–west grain" : "a north-west grain"} (computed from the mapped traces).`
    : "Their strikes are widely spread, with no single dominant trend (computed from the mapped traces).");
  a.citations = passagesMentioning("fault", b.id, 2);
  a.followUps = [`What is the SHmax orientation in the ${b.name}?`, `How deep is the ${b.name} floor?`];
  a.why.rule = "Faults: mapped GA fault traces (count, length, axial mean strike)";
  return a;
}
function overviewAnswer(a: Answer, b: Basin): Answer {
  a.basin = b.id; a.focusBasin = b.id; a.provenance = ["published", "computed"];
  const age = tableValue(b, /^age/i) ?? b.age;
  const keys = tableValue(b, /key structures/i);
  a.paragraphs.push(`The **${b.name}** (${b.state}) spans ${age}. It covers about ${areaShort(b)}; on the GA grid its floor reaches ${depthLabel(b.stats.depth_max_m ?? null)}.`);
  a.paragraphs.push(`${fmt(b.boreholes.filter((w) => w.inside).length)} public boreholes and ${fmt(b.faults.length)} mapped faults fall inside its outline; the World Stress Map has ${b.stressSum.n_in ? `${fmt(b.stressSum.n_in)} stress records there` : "no stress records there"}.`);
  if (keys) a.paragraphs.push(`Key structures (GA Table 1): ${keys}.`);
  const summary = index().docs.find((d) => d.p.basin === b.id && /report$/i.test(d.p.doc) && /summary/i.test(d.p.h));
  a.citations = summary ? [cite(summary.p)] : passagesMentioning(b.name, b.id, 1);
  a.followUps = [`Which ${b.short} units are reservoirs?`, `How deep is the ${b.name} floor?`, `What is the SHmax orientation in the ${b.name}?`];
  a.why.rule = "Basin overview: GA Table 1 + computed counts";
  return a;
}

function retrieve(a: Answer, q: string, basin: Basin | null): Answer {
  const { terms, scored } = search(q, basin?.id ?? null, 4);
  a.why.terms = terms;
  a.why.scores = scored.map((x) => ({ id: x.d.p.id, score: Math.round(x.s * 10) / 10 }));
  const top = scored[0];
  if (!top || top.coverage < 0.5 || top.s < 2) {
    a.status = "unsupported";
    a.paragraphs = [`I couldn't find support for “${q}” in the published report text, so I won't guess.`, "Try a basin, formation, borehole or named feature, or one of the suggested questions."];
    a.followUps = [STARTERS[0], STARTERS[6], STARTERS[2]];
    a.why.rule = "Retrieval gate: top passage did not cover most of the question's key terms";
    return a;
  }
  a.provenance = ["published"];
  a.basin = basin?.id ?? top.d.p.basin;
  a.focusBasin = a.basin;
  a.paragraphs.push(bestSentences(top.d.p.t, terms, 2) || top.d.p.t.slice(0, 400));
  a.citations = scored.filter((x) => x.coverage >= 0.5).slice(0, 3).map((x) => cite(x.d.p));
  a.followUps = [STARTERS[2], `How deep is the ${basinById(a.basin)?.name ?? "Cooper Basin"} floor?`];
  a.why.rule = "Ranked retrieval over published report text (BM25 + phrase boost)";
  return a;
}

export function answer(question: string, context: { basin: string | null }): Answer {
  const q = question.trim();
  const a = base(q);
  if (!q) return retrieve(a, q, null);
  for (const [re, what] of OUT_OF_SCOPE) if (re.test(q)) return declined(a, what);
  const s = q.toLowerCase();
  const basins = detectBasins(q);
  const ctxBasin = basins[0] ?? null;
  const count = s.match(/(how many|number of|count)\b.*\b(boreholes?|wells?)\b.*?(deeper than|more than|over|greater than|exceeding|beyond|>)\s*([\d,.]+)\s*(km|m|metres|meters)?/);
  if (count) {
    const v = parseFloat(count[4].replace(/,/g, ""));
    return countAnswer(a, basins, count[5] === "km" ? v * 1000 : v);
  }
  const well = findBorehole(q);
  if (well) return boreholeAnswer(a, well);
  const place = /\b(trough|depression|ridge|syncline|anticline|arch|shelf|embayment|fault|monocline|block|zone|high|platform)\b/.test(s) || /how deep|depth/.test(s) ? findPlace(q) : null;
  if (place) return placeAnswer(a, place);
  // The comparison covers the four basin packages. It answers a question that names a basin, asks about basins or the
  // four of them, or names nothing else; one that compares other named things ("AusAEM") isn't asking for it.
  if (/\b(compare|comparison|versus|vs\.?|side by side|all (four|4) basins|the (four|4) basins|which basin)\b/.test(s)
    && (basins.length || /\bbasins?\b|\b(all|the) (four|4)\b|\bside by side\b/.test(s) || !namesOtherThings(q))) return compareAnswer(a);
  const def = s.match(/^(?:what is|what's|what are|define|definition of|meaning of)\s+(?:an?\s+|the\s+)?(.+?)\??$/);
  if (def && !basins.length && def[1].trim().split(/\s+/).length <= 3) { const d = definitionAnswer(a, def[1]); if (d) return d; }
  if (/\b(stress|shmax|sh max|breakouts?|stress regime|world stress)\b/.test(s)) return stressAnswer(a, basins);
  const role = s.match(/\b(reservoirs?|seals?|source rocks?|source beds?|source units?|cap ?rocks?)\b/);
  if (role && ctxBasin) return rolesAnswer(a, ctxBasin, role[1].startsWith("reservoir") ? "reservoir" : role[1].startsWith("seal") || role[1].startsWith("cap") ? "seal" : "source");
  if (/\b(how old|what age|age of|when did)\b/.test(s) && ctxBasin) return ageAnswer(a, ctxBasin);
  if (/\b(how deep|deepest|depth|thickest|thickness)\b/.test(s) && ctxBasin) return depthAnswer(a, ctxBasin);
  if (/\bfaults?\b|\bstructur(e|al)\b/.test(s) && ctxBasin && !/\b(fault|zone|thrust)\b.*\b(named|called)\b/.test(s)) return faultsAnswer(a, ctxBasin);
  if (/\b(tell me about|overview|summar(y|ise|ize)|describe|introduc(e|tion))\b/.test(s) && ctxBasin) {
    const u = findUnit(q, ctxBasin);
    return u ? unitAnswer(a, u) : overviewAnswer(a, ctxBasin);
  }
  const unit = findUnit(q, ctxBasin ?? basinById(context.basin));
  if (unit) return unitAnswer(a, unit);
  return retrieve(a, q, ctxBasin);
}

export const round = round10;
