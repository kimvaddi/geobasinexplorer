import { BASINS, basinById } from "@/lib/basins";
import { PACK, WELLS, type Passage5 } from "@/lib/pack";
import { factorFor } from "@/lib/feedback";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

/* In-browser keyword search (BM25) over every bundled text: report passages, glossary, metadata statements,
   reference lists, the scanned reports' OCR text and the values extracted from scans. It finds words, not
   meanings: a reworded question can miss. Results always carry document and page. */

const STOP = new Set(("a an the of in on at to for from by with and or is are was were be been it its this that these those what which who whom how why when where " +
  "do does did can could would should will about into than then there their them they we you your our i me my as if not no yes any all some per vs " +
  "tell show give list find me please basin basins region data much many one according use used uses using also cite citing state sure justify explain describe provide evidence rank please " +
  "say says said mention mentions mentioned discuss discusses discussed").split(" "));
export function stem(w: string) {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("e")) return w.slice(0, -1);
  return w;
}
/* Abbreviations geoscientists use, expanded on both sides of the search. */
const EXPAND: [RegExp, string][] = [[/\bco2\b/g, "co2 carbon dioxide"], [/\bch4\b/g, "ch4 methane"], [/\bbht\b/g, "bht bottom-hole temperature"], [/\bkb\b/g, "kb kelly bushing"],
  [/\bmsl\b/g, "msl sea level"], [/\btwt\b/g, "twt two-way time"], [/\bsubsea\b/g, "subsea below sea level"], [/\bsp\b/g, "sp shotpoint"], [/\bshot ?points?\b/g, "shotpoint"]];
/* The same tokens with the words as typed, for display: [word, search stem]. */
export function tokenizePairs(s: string): [string, string][] {
  let x = s.toLowerCase().replace(/co₂/g, "co2"); for (const [re, to] of EXPAND) x = x.replace(re, to);
  return x.replace(/[^a-z0-9.-]+/g, " ").split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, "").replace(/,/g, "")).filter((t) => t.length > 1 && !STOP.has(t)).map((t): [string, string] => [t, stem(t)]);
}
export function tokenize(s: string): string[] {
  let x = s.toLowerCase().replace(/co₂/g, "co2"); for (const [re, to] of EXPAND) x = x.replace(re, to);
  return x.replace(/[^a-z0-9.-]+/g, " ").split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, "").replace(/,/g, "")).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}
export interface IndexedPassage extends Passage5 { basin?: string }
interface Doc { p: IndexedPassage; tf: Map<string, number>; len: number; low: string }
interface Index { docs: Doc[]; df: Map<string, number>; avg: number; ms: number; count: number; terms: number }
let IDX: Index | null = null;
export function index(): Index {
  if (IDX) return IDX;
  const t0 = performance.now();
  const all: IndexedPassage[] = [];
  for (const b of BASINS) for (const p of b.passages) all.push({ ...p, basin: b.id, kind: "report" });
  for (const p of PACK.extraPassages) all.push({ ...p, basin: p.basin ?? (p.well ? WELLS.find((w) => w.siteId === p.well)?.basinId === "cooper-basin" ? "cooper" : undefined : undefined) });
  const docs: Doc[] = []; const df = new Map<string, number>(); let tot = 0;
  for (const p of all) {
    if (GATED && LICENCE.isWithheldPassage(p)) continue;
    const toks = tokenize(`${p.doc} ${p.h} ${p.t}`); const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ p, tf, len: toks.length, low: `${p.doc} ${p.h} ${p.t}`.toLowerCase() }); tot += toks.length;
  }
  IDX = { docs, df, avg: tot / Math.max(1, docs.length), ms: performance.now() - t0, count: docs.length, terms: df.size };
  return IDX;
}
export interface Hit { p: IndexedPassage; score: number; coverage: number; matched: string[]; fb?: number }
export interface SearchResult { terms: string[]; hits: Hit[]; scanned: number; candidates: number; boosted: number; demoted: number }
const GENERIC = new Set(tokenize("sandstone sandstones formation member group beds bed shale shales coal coals measures limestone siltstone mudstone volcanics play basin trough ridge high fault zone north south east west upper lower middle creek lake river sub-basin supergroup undifferentiated equivalent unit"));
let ENT: Set<string> | null = null;
/* Tokens of named things (units, plays, features, basins, legacy wells): a passage must share one when the question names one. */
export function entityTokens(): Set<string> {
  if (ENT) return ENT;
  const names: string[] = [];
  for (const b of BASINS) { names.push(b.name, b.short); for (const u of b.units) names.push(u.n); for (const f of b.features) names.push(f.n); }
  for (const p of PACK.plays) names.push(p.play.replace(/ Play$/, ""));
  for (const w of WELLS) names.push(w.name);
  ENT = new Set(names.flatMap((n) => tokenize(n)).filter((t) => !GENERIC.has(t) && t.length > 2 && !/^\d/.test(t)));
  return ENT;
}
export function search(q: string, opts: { limit?: number; basin?: string | null; doc?: string | null } = {}): SearchResult {
  const I = index(); const terms = [...new Set(tokenize(q))];
  const required = terms.filter((t) => entityTokens().has(t));
  const wantsNumber = /\b(how many|how much|number of|how deep|how thick|how old|what (depth|age|thickness))\b/i.test(q);
  if (!terms.length) return { terms, hits: [], scanned: I.docs.length, candidates: 0, boosted: 0, demoted: 0 };
  const N = I.docs.length, k1 = 1.2, b = 0.75;
  const idf = new Map(terms.map((t) => [t, Math.log(1 + (N - (I.df.get(t) ?? 0) + 0.5) / ((I.df.get(t) ?? 0) + 0.5))]));
  const totalIdf = terms.reduce((s, t) => s + (idf.get(t) ?? 0), 0) || 1;
  const words = q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const bigrams = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  const out: Hit[] = []; let boosted = 0, demoted = 0;
  for (const d of I.docs) {
    if (opts.doc && d.p.doc !== opts.doc) continue;
    let s = 0; const matched: string[] = []; let cov = 0;
    for (const t of terms) {
      const f = d.tf.get(t); if (!f) continue;
      matched.push(t); cov += idf.get(t) ?? 0;
      s += (idf.get(t) ?? 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / I.avg)));
    }
    if (!s) continue;
    if (required.length && !required.some((t) => d.tf.has(t))) continue;
    for (const bg of bigrams) if (d.low.includes(bg)) s += 1.5;
    if (wantsNumber && matched.some((t) => new RegExp(`\\b\\d[\\d,.]*\\s+(?:[a-z-]+\\s+){0,2}${t.slice(0, 5)}`).test(d.low))) s += 3;
    if (opts.basin && d.p.basin === opts.basin) s *= 1.15;
    const fb = factorFor(d.p.id, terms);
    if (fb.n) { s *= fb.factor; if (fb.factor > 1) boosted++; else if (fb.factor < 1) demoted++; }
    out.push({ p: d.p, score: s, coverage: cov / totalIdf, matched, fb: fb.n ? fb.factor : undefined });
  }
  out.sort((x, y) => y.score - x.score);
  return { terms, hits: out.slice(0, opts.limit ?? 6), scanned: I.docs.length, candidates: out.length, boosted, demoted };
}
export const FOUND_GATE = { minScore: 3, minCoverage: 0.5, longQuestionCoverage: 0.4, longQuestionTerms: 8 };
/* A passage is shown only when it scores and matches enough of the question; long questions get a slightly lower bar. */
export const passes = (h: Hit, nTerms: number) => h.score >= FOUND_GATE.minScore && h.coverage >= (nTerms >= FOUND_GATE.longQuestionTerms ? FOUND_GATE.longQuestionCoverage : FOUND_GATE.minCoverage);
export function sentencesFor(text: string, terms: string[], max = 2): string {
  const sents = text.replace(/\s+/g, " ").split(/(?<=[.!?])(?<!\b(?:No|Nos|Fig|Figs|approx|ca|vs|Mt|St|Pty|Ltd|Co|Vol|Vols|Encl|Dr|Mr|e\.g|i\.e|et al)\.)\s+(?=[A-Z0-9“"(])/);
  const scored = sents.map((s, i) => ({ s, i, n: terms.filter((t) => s.toLowerCase().includes(t)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i);
  return (scored.length ? scored.map((x) => x.s).join(" ") : text.slice(0, 320)).slice(0, 600);
}

/* Places named in a passage, for map hits. */
export interface MapHit { lon: number; lat: number; label: string; kind: "feature" | "borehole" | "well" | "basin" }
let NAMES: { re: RegExp; low: string; hit: MapHit }[] | null = null;
function names() {
  if (NAMES) return NAMES;
  const list: { re: RegExp; low: string; hit: MapHit }[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const b of BASINS) {
    list.push({ re: new RegExp(`\\b${esc(b.name)}\\b`, "i"), low: b.name.toLowerCase(), hit: { lon: b.center[0], lat: b.center[1], label: b.name, kind: "basin" } });
    for (const f of b.features) if (f.n.length > 4) { const n = f.n.replace(/ \(unnamed\)/, ""); list.push({ re: new RegExp(`\\b${esc(n)}\\b`, "i"), low: n.toLowerCase(), hit: { lon: f.lon, lat: f.lat, label: f.n, kind: "feature" } }); }
    for (const w of b.boreholes) if (w.name && w.major && w.name.length > 5) list.push({ re: new RegExp(`\\b${esc(w.name)}\\b`, "i"), low: w.name.toLowerCase(), hit: { lon: w.lon, lat: w.lat, label: w.name, kind: "borehole" } });
  }
  for (const w of WELLS) list.push({ re: new RegExp(`\\b${esc(w.name)}\\b`, "i"), low: w.name.toLowerCase(), hit: { lon: w.lon, lat: w.lat, label: w.name, kind: "well" } });
  NAMES = list; return list;
}
export function mapHits(texts: string[], max = 8): MapHit[] {
  const seen = new Set<string>(); const out: MapHit[] = [];
  for (const t of texts) { const low = t.toLowerCase(); for (const n of names()) {
    if (out.length >= max) return out;
    if (seen.has(n.hit.label) || !low.includes(n.low) || !n.re.test(t)) continue;
    seen.add(n.hit.label); out.push(n.hit);
  } }
  return out;
}
export const basinLabel = (id?: string | null) => (id ? basinById(id)?.name ?? id : "");
/* Measured in this browser: builds the index on first call. */
export function searchStats() { const I = index(); return { ms: Math.round(I.ms), passages: I.count, terms: I.terms }; }
export function libraryStats() { const I = index(); return { passages: I.docs.length, documents: new Set(I.docs.map((d) => d.p.doc)).size }; }

/* How many bundled passages mention both a named thing and a property word. Used to say "not found" precisely. */
export function passagesWithBoth(name: string, word: string): number {
  const n = name.toLowerCase(); const w = word.toLowerCase();
  return index().docs.filter((d) => d.low.includes(n) && d.low.includes(w)).length;
}

/* Documents a reviewer adds in this session ("Add a document"): their pages join the same index. */
export const ADDED_TITLES = new Set<string>();
export function addPassages(list: IndexedPassage[]): number {
  if (GATED) list = LICENCE.filterPassages(list);
  const I = index(); let tot = I.avg * I.docs.length;
  for (const p of list) ADDED_TITLES.add(p.doc);
  for (const p of list) {
    const toks = tokenize(`${p.doc} ${p.h} ${p.t}`); const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) I.df.set(t, (I.df.get(t) ?? 0) + 1);
    I.docs.push({ p, tf, len: toks.length, low: `${p.doc} ${p.h} ${p.t}`.toLowerCase() }); tot += toks.length;
  }
  I.avg = tot / Math.max(1, I.docs.length); I.count = I.docs.length; I.terms = I.df.size;
  return list.length;
}
export const ADDED_DOC = (id: string) => /^user:/.test(id);
