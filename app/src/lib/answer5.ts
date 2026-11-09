import { answer as computed, type Answer, type Citation } from "@/lib/ask";
import { basinById, BASINS, fmt } from "@/lib/basins";
import { search, sentencesFor, mapHits, passes, tokenize, tokenizePairs, stem, entityTokens, FOUND_GATE, passagesWithBoth, ADDED_DOC, ADDED_TITLES, type MapHit, type Hit } from "@/lib/search";
import { PACK, WELLS, type Play5 } from "@/lib/pack";
import { rank, rationale, DEFAULT_WEIGHTS, playById } from "@/lib/analog";
import { docById, fieldValue, fieldSI, type Site, type SiteField } from "@/lib/wells";
import { imagesFor, type ImageHit } from "@/lib/images";
import { geotagPassage, wellOf as WELL_OF, type Geotag } from "@/lib/geotag";
import type { HDef } from "@/lib/hypothesis";

/* Every answer is labelled: Precomputed (deterministic rules over data prepared before the session),
   Retrieved (found by searching the bundled text at question time) or Not found. Nothing is generated. */
export type AnswerLabel = "Precomputed" | "Retrieved" | "Not found";
export interface TraceStep { step: string; detail: string; ms: number }
export interface SearchInfo { scanned: number; candidates: number; passed: number; docs: number; boosted: number; demoted: number; uncovered: string[] }
/* Cloud answers carry the independent check's outcome; offline answers have no engine field. */
export interface Validation { status: "passed" | "blocked" | "incomplete" | "not-run"; validator: string; checked: number; supported: number; removed: { text: string; why: string }[]; note: string }
/* placeNote: for a question asked about a place ("Ask about this place"), which evidence the answer drew on and why. */
export interface Answer5 extends Answer { label: AnswerLabel; hits: MapHit[]; reason: string; analogRef?: string; fieldRef?: { site: string; field: string }; images?: ImageHit[]; geo?: Record<string, Geotag[]>; ms?: number; hypothesisRef?: HDef["id"]; trace?: TraceStep[]; searchInfo?: SearchInfo; terms?: string[]; engine?: "azure"; validation?: Validation; tokens?: number; placeNote?: string;
  /* Cloud only: the Foundry scientists are still writing this answer; the app polls with the handle (lib/cloud.ts). */
  pending?: { handle: string; elapsedMs?: number; progress?: { sources: number; latest: string[] } } }
const plainCite = (c: Citation) => `${c.doc}${c.page ? ` · p. ${c.page}` : ""}`;
export function sourceList(a: Answer5): string[] { return a.citations.map(plainCite); }

/* ---------- datasets behind computed answers ---------- */
const DS = {
  wsm: { id: "ds:wsm", basin: "", doc: "World Stress Map 2025 database (dataset)", page: 0, heading: "Dataset", text: "Maximum horizontal stress (SHmax) orientation records with quality A–E; World Stress Map 2025, CC BY 4.0." },
  bh: { id: "ds:boreholes", basin: "", doc: "GA borehole layers, four basin packages (dataset)", page: 0, heading: "Dataset", text: "Borehole locations, names, total depths and years from the Geoscience Australia TEGI basin packages (eCat 147459–147462), CC BY 4.0." },
  depth: { id: "ds:depth", basin: "", doc: "GA depth-to-basement grids (dataset)", page: 0, heading: "Dataset", text: "Depth to basin floor grids from the Geoscience Australia TEGI basin packages, CC BY 4.0; values sampled from the grid." },
  pkg: { id: "ds:tegi", basin: "", doc: "GA TEGI basin packages 147459–147462 (dataset)", page: 0, heading: "Dataset", text: "Outlines, units, plays, boreholes, faults and depth grids for the four basins; Geoscience Australia, CC BY 4.0." },
} satisfies Record<string, Citation>;
function datasetCites(a: Answer5): Citation[] {
  const r = `${a.why.rule} ${a.paragraphs.join(" ")}`;
  if (/stress|shmax/i.test(r)) return [DS.wsm];
  const out: Citation[] = [];
  if (/borehole/i.test(r)) out.push(DS.bh);
  if (/depth|deep|floor|grid/i.test(r)) out.push(DS.depth);
  return out.length ? out : [DS.pkg];
}

export function dedupeHits(h: MapHit[]): MapHit[] {
  const seen = new Map<string, MapHit>();
  for (const x of h) { const k = x.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); const prev = seen.get(k); if (!prev || (x.kind === "well" && prev.kind !== "well")) seen.set(k, x); }
  return [...seen.values()];
}

/* ---------- legacy-well values (extracted from the scanned reports) ---------- */
const WELL_RE: [RegExp, string][] = [[/\binnamincka\b/i, "innamincka-1"], [/\bmarabooka\b/i, "marabooka-1"]];
const SYN: Record<string, string[]> = { drill: ["operator"], drilled: ["operator"], deep: ["total", "depth"], td: ["total", "depth"], highest: ["maximum"], hottest: ["maximum", "temperature"], max: ["maximum"], spud: ["spud"], elevation: ["elevation"], perforation: ["perf"] };
const NOISE = new Set(["innamincka", "marabooka", "1", "report", "well", "1960", "1959", "1980", "1981", "record", "text", "value", "say", "what", "page"]);
const DATUM = new Set(["below", "kelly", "bush", "bushing", "kb", "sea", "level", "msl", "subsea", "ft", "feet", "metre", "meter", "m", "datum"]);
function fieldMatch(q: string): { site: Site; f: SiteField; cov: number; wantsSea: boolean } | null {
  const wid = WELL_RE.find(([re]) => re.test(q))?.[1]; const site = wid ? WELLS.find((w) => w.siteId === wid) : null;
  if (!site) return null;
  const toks = tokenize(q).filter((t) => !NOISE.has(t));
  const content = toks.filter((t) => !DATUM.has(t));
  const wantsSea = /\b(sea level|subsea|msl|ss)\b/i.test(q);
  if (!content.length) return null;
  let best: { f: SiteField; n: number; s: number } | null = null;
  for (const f of site.fields) {
    const lt = tokenize(f.label); const ft = new Set([...lt, ...tokenize(f.formation ?? "")]);
    let n = 0; for (const t of content) if (ft.has(t) || (SYN[t] ?? []).some((x) => ft.has(x))) n++;
    if (!n) continue;
    const form = tokenize(f.formation ?? "").filter((t) => t !== "formation");
    const formHit = form.length > 0 && form.every((t) => content.includes(t));
    const lead = lt.slice(0, 3).filter((t) => content.includes(t)).length;
    const s = n + (formHit ? 0.6 : 0) + 0.2 * lead + 0.1 * (n / lt.length) + (f.confidence === "high" ? 0.05 : 0);
    if (!best || s > best.s) best = { f, n, s };
  }
  if (!best) return null;
  const cov = best.n / content.length;
  return cov >= 0.6 || (content.length <= 2 && best.n >= 1) ? { site, f: best.f, cov, wantsSea } : null;
}
function fieldAnswer(a: Answer5, m: { site: Site; f: SiteField; wantsSea: boolean }): Answer5 {
  const { site, f } = m; const doc = docById(site, f.docId); const si = fieldSI(f);
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["extracted"];
  a.reason = "Value extracted from the scanned report before packaging, with its page and confidence";
  const depthNote = f.depthM != null && f.unit !== "ft" ? ` at about ${Math.round(f.depthM).toLocaleString("en-US")} m (${Math.round(f.depthM / 0.3048).toLocaleString("en-US")} ft)` : "";
  const unitNote = /\(unit implied\)/.test(f.unit ?? "") ? " The page prints only the degree sign. The unit comes from the log headers." : "";
  const valueText = fieldValue(f).replace(/\s*\(unit implied\)/, "");
  a.paragraphs = [`**${f.label}**: ${valueText}${si ? ` (${si})` : ""}${depthNote}${f.depthRef && !/not stated/i.test(f.depthRef) && typeof f.value === "number" && f.unit === "ft" ? `, measured from ${f.depthRef}` : ""}.`,
    `Read from the ${doc?.title ?? f.docId}, page ${f.page}, with ${f.confidence} confidence${f.needsReview ? "; flagged for expert review" : ""}.${unitNote} Source text: “${f.quote}”`];
  if (f.note) a.paragraphs.splice(1, 0, f.note);
  if (/\bthick(ness)?\b/i.test(a.question) && typeof f.value === "number" && /^Top /.test(f.label)) {
    const v0 = f.value;
    const next = site.fields.filter((x) => /^Top /.test(x.label) && typeof x.value === "number" && (x.value as number) > v0 && x.unit === f.unit).sort((x, y) => (x.value as number) - (y.value as number))[0];
    if (next) a.paragraphs.push(`Thickness: **${((next.value as number) - v0).toLocaleString("en-US")} ${f.unit}** (computed: next top listed in the report, ${next.label.replace(/^Top /, "")} at ${(next.value as number).toLocaleString("en-US")} ${f.unit}, page ${next.page}). Check the source row: some reports print thickness directly.`);
  }
  if (m.wantsSea && typeof f.value === "number" && f.unit === "ft") {
    const kb = site.fields.find((x) => /kelly bushing elevation|rotary table/i.test(x.label) && typeof x.value === "number");
    if (kb && typeof kb.value === "number") {
      const ss = Math.round((f.value - kb.value) * 10) / 10;
      a.paragraphs.push(`Below sea level: **${ss.toLocaleString("en-US")} ft** (computed: ${f.value.toLocaleString("en-US")} ft − ${kb.value} ft ${/kelly/i.test(kb.label) ? "kelly bushing" : "rotary table"} elevation, page ${kb.page}).`);
      const name = (f.formation ?? "").split(" ")[0].toUpperCase();
      const tz = name ? PACK.velocity?.items.find((i) => i.itemId === "tz-diagram")?.values?.find((v) => v.valueId.startsWith("tz-top-") && v.label.toUpperCase().includes(name)) : null;
      if (tz) {
        const diff = Math.round((Number(tz.value) - ss) * 10) / 10; const datum = Math.round((kb.value - 179) * 10) / 10;
        a.paragraphs.push(Math.abs(diff - datum) <= 1
          ? `The velocity chart (Enclosure 2) shows this top at **${tz.value} ft below sea level**. The ${diff} ft difference equals the datum difference (survey kelly bushing 179 ft vs ${kb.value} ft), so the sources agree.`
          : `The velocity chart (Enclosure 2) shows this top at **${tz.value} ft below sea level**, ${Math.abs(diff)} ft ${diff > 0 ? "deeper" : "shallower"}. That is more than the ${datum} ft datum difference, so the two documents use different picks: check both pages.`);
      }
    }
  }
  a.citations = [{ id: `${site.siteId}:${f.fieldId}`, basin: "cooper", doc: `${site.name} · ${doc?.title ?? f.docId}`, page: f.page, heading: f.label, text: `“${f.quote}”` }];
  a.why = { terms: tokenize(a.question), rule: "Legacy-well question: values extracted from the scanned report (best label match)", scores: [] };
  a.hits = [{ lon: site.lon, lat: site.lat, label: site.name, kind: "well" }];
  a.focus = { lon: site.lon, lat: site.lat, zoom: 8.2, label: site.name }; a.basin = "cooper"; a.focusBasin = "cooper";
  a.fieldRef = { site: site.siteId, field: f.fieldId };
  a.followUps = [`Open ${site.name} evidence`];
  return a;
}

function wellOverview(a: Answer5, site: Site): Answer5 {
  const pick = site.fields.filter((f) => ["depth", "reservoir", "pressure", "temperature"].includes(f.group) && f.confidence !== "low").slice(0, 5);
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["extracted"]; a.reason = "Summary of values extracted from the scanned report";
  a.paragraphs = [`**${site.name}**: ${site.role}. ${[site.operator, site.spudYear && `spudded ${site.spudYear}`, site.totalDepthM && `total depth ${Math.round(site.totalDepthM).toLocaleString("en-US")} m`].filter(Boolean).join(", ")}.`,
    `${site.fields.length} values were extracted from ${site.stats.pagesSampled} pages; ${site.stats.fieldsNeedReview} are flagged for expert review. Examples:`,
    ...pick.map((f) => `- ${f.label}: ${fieldValue(f)} (p. ${f.page}, ${f.confidence} confidence)`)];
  a.citations = pick.slice(0, 4).map((f) => ({ id: `${site.siteId}:${f.fieldId}`, basin: "cooper", doc: `${site.name} · ${docById(site, f.docId)?.title ?? f.docId}`, page: f.page, heading: f.label, text: `“${f.quote}”` }));
  a.why = { terms: [], rule: "Legacy-well overview: extracted values with pages", scores: [] };
  a.hits = [{ lon: site.lon, lat: site.lat, label: site.name, kind: "well" }]; a.focus = { lon: site.lon, lat: site.lat, zoom: 8.2, label: site.name };
  a.fieldRef = { site: site.siteId, field: pick[0]?.fieldId ?? "" }; a.followUps = [`Open ${site.name} evidence`];
  return a;
}

function coreAnswer(a: Answer5, q: string): Answer5 | null {
  const s = q.toLowerCase();
  const photos = PACK.core.photos.filter((p) => [p.formation, p.play ?? ""].some((n) => { const k = n.toLowerCase().replace(/ play interval$| formation$| sandstone$| beds$| group$| coal measures$/i, "").split(/[ -]/)[0]; return k.length > 3 && s.includes(k); }));
  const strips = PACK.core.strips.filter((x) => { const k = x.unit.toLowerCase().split(/[ -]/)[0]; return k.length > 3 && s.includes(k); });
  if (!photos.length && !strips.length) return null;
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["published"]; a.reason = "Core photograph catalogue from the GA packages";
  a.paragraphs = [];
  if (strips.length) { const by = new Map<string, string[]>(); strips.forEach((x) => by.set(x.well, [...(by.get(x.well) ?? []), `${x.top}–${x.base}`])); a.paragraphs.push(`Cooper Basin core photo panels for **${strips[0].unit}**: ${[...by.entries()].map(([w, d]) => `${w} (${d.slice(0, 3).join(", ")}${d.length > 3 ? " …" : ""})`).join("; ")}.`); }
  if (photos.length) a.paragraphs.push(...photos.map((p) => `**${p.formation}** (${p.play ?? "play not given"}): ${(Array.isArray(p.wells) ? p.wells : [p.wells]).filter(Boolean).join(", ") || "well not given"}${Array.isArray(p.depths_m) && p.depths_m.length ? `, ${Math.min(...p.depths_m)}–${Math.max(...p.depths_m)} m` : ""}.`));
  a.paragraphs.push("Open the core photographs in Evidence to see them.");
  a.citations = [{ id: "ds:core", basin: "", doc: "GA core photography, TEGI basin packages (dataset)", page: 0, heading: "Dataset", text: "Core photographs of selected intervals, with wells and depths, Geoscience Australia (CC BY 4.0)." }];
  a.why = { terms: [], rule: "Core photo question: GA core photo catalogue", scores: [] };
  a.followUps = ["Open the core photographs in Evidence"];
  return a;
}
function flagAnswer(a: Answer5, flag: string): Answer5 {
  const f = flag.toLowerCase().replace(/^csg$/, "coal seam gas").replace(/^shale (gas|oil|resource)s?$/, "shale resources");
  const plays = PACK.plays.filter((p) => p.res.includes(f));
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["published"]; a.reason = "Resource flags in the GA play-interval tables";
  a.paragraphs = plays.length ? [`Plays flagged for **${f}** in the GA play-interval tables: ${plays.map((p) => `${p.play} (${p.province})`).join("; ")}.`, "Flags mark resource types the tables record; they are not assessments of size or prospectivity."]
    : [`Not found in the data: no play in the GA tables carries a ${f} flag.`];
  a.citations = [{ id: "ds:plays", basin: "", doc: "GA play-interval tables, four basin packages (dataset)", page: 0, heading: "Dataset", text: "Resource flags (tight gas, shale resources, coal seam gas) as tabulated by Geoscience Australia (CC BY 4.0)." }];
  a.why = { terms: [], rule: "Resource-flag question: GA play tables", scores: [] };
  a.hits = mapHits(plays.map((p) => p.province), 4); a.followUps = ["Which plays are analogs to the Jericho Play?"];
  return a;
}
function whereBasin(a: Answer5, name: string): Answer5 {
  const id = name.toLowerCase().replace(" ", ""); const e = PACK.entities.find((x) => x.id === `basin:${id}`); const b = basinById(id);
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["published"]; a.reason = "Basin outline and attributes from the GA package";
  a.paragraphs = [`The **${b?.name ?? name}** lies in ${e?.attrs.state ?? "eastern Australia"}${e?.lonlat ? `, centred near ${Math.abs(e.lonlat[1]).toFixed(1)}°S ${e.lonlat[0].toFixed(1)}°E (GDA94)` : ""}${e?.attrs["area km²"] ? `, covering about ${Number(e.attrs["area km²"]).toLocaleString("en-US")} km²` : ""}.`, e?.attrs.age ? `Age: ${e.attrs.age}.` : ""].filter(Boolean);
  a.citations = [{ ...DS.pkg, doc: `${e?.source ?? "GA TEGI package"} (dataset)` }];
  a.why = { terms: [], rule: "Where is a basin: GA outline and attributes", scores: [] };
  if (e?.lonlat) { a.focus = { lon: e.lonlat[0], lat: e.lonlat[1], zoom: 6, label: b?.name }; a.hits = [{ lon: e.lonlat[0], lat: e.lonlat[1], label: b?.name ?? name, kind: "basin" }]; }
  a.basin = id; a.focusBasin = id; a.followUps = [`How deep is the ${b?.name ?? name} floor?`];
  return a;
}

/* ---------- analogs ---------- */
export function findPlay(q: string): Play5 | null {
  const s = q.toLowerCase().replace(/[–—-]/g, " ");
  let best: Play5 | null = null; let bestLen = 0;
  for (const p of PACK.plays) {
    const name = p.play.toLowerCase().replace(/ play$/, "").replace(/[–—-]/g, " ");
    if (name === "cenozoic" || !s.includes(name)) continue;
    const prov = p.province.toLowerCase().replace(/ basin$/, "");
    const len = name.length + (s.includes(prov) ? 100 : 0);
    if (len > bestLen) { best = p; bestLen = len; }
  }
  return best;
}
function analogAnswer(a: Answer5, ref: Play5, named: boolean): Answer5 {
  const r = rank(ref, DEFAULT_WEIGHTS).slice(0, 5);
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["computed"];
  a.reason = "Analog ranking: deterministic similarity over the Geoscience Australia play-interval tables";
  a.paragraphs = [
    `${named ? "" : "No play was named, so this uses the default reference. "}Closest analogs to the **${ref.play} (${ref.province})**, scored on age, environment, lithology, resource type and petroleum roles (weights ${Object.values(DEFAULT_WEIGHTS).join("/")}). Coverage shows how much of the weighting had data on both sides:`,
    ...r.map((x, i) => `${i + 1}. **${x.play.play}** (${x.play.province}): score ${x.score}, coverage ${x.coverage}%`),
    `Why **${r[0].play.play}** ranks first: ${rationale(ref, r[0]).join(" ")}`,
    "This ranking uses only the attributes in the tables, so treat it as a first screen. Open Analogs to change the weights and read the evidence.",
  ];
  const ids = [...ref.passages, ...r.slice(0, 3).flatMap((x) => x.play.passages)];
  a.citations = ids.map((id) => { for (const b of BASINS) { const p = b.passages.find((pp) => pp.id === id); if (p) return { id: p.id, basin: b.id, doc: p.doc, page: p.page, heading: p.h, text: p.t }; } return null; }).filter((c): c is NonNullable<typeof c> => !!c).slice(0, 3);
  a.citations.push({ id: "ds:plays", basin: "", doc: `GA play-interval tables, eCat ${[...new Set([ref.ecat, ...r.slice(0, 3).map((x) => x.play.ecat)])].join(", ")} (dataset)`, page: 0, heading: "Dataset", text: "Play intervals with age, depositional environment, lithology, resource flags and roles, as tabulated by Geoscience Australia (CC BY 4.0)." });
  a.why = { terms: [], rule: "Analog question: ranking over the play tables with the default weights", scores: r.map((x) => ({ id: x.play.id, score: x.score })) };
  a.hits = mapHits(r.map((x) => `${x.play.province} ${x.play.play}`), 6);
  a.basin = null; a.focusBasin = null;
  a.followUps = ["Open Analogs to change the weights", `Tell me about the ${r[0].play.play.replace(/ Play$/, "")} in the ${r[0].play.province}`];
  a.analogRef = ref.id;
  return a;
}

/* ---------- same-age plays (play tables) ---------- */
const SAME_AGE = /\b(same[- ]age|counterparts?|equivalents?|time[- ]equivalents?|coeval|contemporaneous|age[- ]equivalents?|same time)\b/i;
const PROVINCES: [RegExp, string][] = [[/\bcooper\b/i, "Cooper Basin"], [/\badavale\b/i, "Adavale Basin"], [/\bgalilee\b/i, "Galilee Basin"], [/\b(north )?bowen\b/i, "North Bowen Basin"], [/\beromanga\b/i, "Eromanga Basin"]];
const PERIODS = ["Carboniferous", "Permian", "Triassic", "Jurassic", "Cretaceous", "Devonian"];
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const ageOverlap = (a: Play5, b: Play5) => (a.top == null || b.top == null || a.base == null || b.base == null ? null : Math.round((Math.min(a.base, b.base) - Math.max(a.top, b.top)) * 10) / 10);
const ageRange = (p: Play5) => (p.top != null && p.base != null ? `${p.top}–${p.base} Ma` : "age not recorded");
const prov = (p: string) => p.replace(/ Basin$/, "");
function playOfUnit(q: string): Play5 | null {
  const s = q.toLowerCase(); let best: Play5 | null = null; let len = 0;
  for (const p of PACK.plays) for (const u of p.units) { const n = u.n.toLowerCase(); if (n.length >= 6 && n.length > len && s.includes(n)) { best = p; len = n.length; } }
  return best;
}
function sameAgeAnswer(a: Answer5, q: string): Answer5 | null {
  const named = PROVINCES.filter(([re]) => re.test(q)).map(([, p]) => p);
  const one = findPlay(q) ?? playOfUnit(q);
  const notes: string[] = [];
  let refs: Play5[] = [];
  if (one) refs = [one];
  else {
    const m = q.match(/\b(cooper|adavale|galilee|north bowen|bowen|eromanga)(?: basin(?:'s)?)?\s+(?:[\w-]+\s+){0,2}plays?\b/i);
    const home = m ? PROVINCES.find(([re]) => re.test(m[1]))?.[1] : named.length === 1 ? named[0] : undefined;
    if (!home) return null;
    const period = PERIODS.find((x) => new RegExp(`\\b${x}\\b`, "i").test(q));
    refs = PACK.plays.filter((p) => p.province === home && (!period || p.period === period));
    if (!refs.length) return null;
    if (/\brift/i.test(q)) notes.push(`The play tables don't record tectonic stage, such as rift or sag, so this uses ${period ? `every ${period} play` : "every play"} in the ${home}.`);
  }
  refs.sort((x, y) => (x.top ?? 0) - (y.top ?? 0));
  const homes = new Set(refs.map((r) => r.province));
  const targets = named.filter((p) => !homes.has(p));
  const pool = PACK.plays.filter((p) => !homes.has(p.province) && !/^Cenozoic/.test(p.province) && (!targets.length || targets.includes(p.province)));
  const where = targets.length ? `the ${listOf(targets.map(prov))} tables` : "the other basins' tables";
  const used: Play5[] = [];
  const lines = refs.slice(0, 6).map((r) => {
    const same = pool.filter((o) => (ageOverlap(r, o) ?? -1) >= 1).sort((x, y) => (ageOverlap(r, y) ?? 0) - (ageOverlap(r, x) ?? 0));
    const edge = pool.filter((o) => { const v = ageOverlap(r, o); return v != null && v >= 0 && v < 1; });
    used.push(...same);
    const head = `**${r.play}** (${prov(r.province)}, ${ageRange(r)}): `;
    const body = same.length ? `${listOf(same.map((o) => `${o.play} (${prov(o.province)}, ${ageRange(o)}, ${fmt(ageOverlap(r, o)!, 1)} Myr shared)`))}.` : `no same-age play in ${where}.`;
    const tail = edge.length ? ` ${listOf(edge.map((o) => o.play))} only ${edge.length === 1 ? "touches" : "touch"} it at a stage boundary.` : "";
    return head + body + tail;
  });
  if (refs.length > 6) notes.push(`Showing the 6 youngest of ${refs.length} plays. Name one play to see its matches.`);
  a.status = "answered"; a.label = "Precomputed"; a.provenance = ["computed"];
  a.reason = "Same-age plays: overlap of the tabulated age ranges in the Geoscience Australia play-interval tables";
  a.paragraphs = [`Same-age plays in ${where}, from the Geoscience Australia play-interval tables. A pair counts when the age ranges share 1 Myr or more.`, ...lines, ...notes,
    "Same age alone doesn't make an analog. Rank analogs to weigh setting and rock type too."];
  const ids = [...refs.flatMap((r) => r.passages), ...used.flatMap((p) => p.passages)];
  a.citations = [...new Set(ids)].map((id) => { for (const b of BASINS) { const p = b.passages.find((pp) => pp.id === id); if (p) return { id: p.id, basin: b.id, doc: p.doc, page: p.page, heading: p.h, text: p.t }; } return null; }).filter((c): c is NonNullable<typeof c> => !!c).slice(0, 3);
  a.citations.push({ id: "ds:plays", basin: "", doc: `GA play-interval tables, eCat ${[...new Set([...refs, ...used].map((p) => p.ecat))].join(", ")} (dataset)`, page: 0, heading: "Dataset", text: "Play intervals with age range, depositional environment, lithology, resource flags and roles, as tabulated by Geoscience Australia (CC BY 4.0)." });
  a.why = { terms: [], rule: "Same-age question: overlap of tabulated age ranges (≥ 1 Myr) across the play tables", scores: [] };
  a.hits = mapHits([...new Set([...refs, ...used].map((p) => p.province))], 6);
  a.basin = null; a.focusBasin = null; a.table = undefined;
  a.followUps = [`Which plays are analogs to the ${refs[0].play.replace(/ Play$/, "")} Play?`];
  return a;
}

/* ---------- retrieval ---------- */
const BASIN_RE: [RegExp, string][] = [[/\bcooper\b/i, "cooper"], [/\badavale\b/i, "adavale"], [/\bgalilee\b/i, "galilee"], [/\b(north )?bowen\b/i, "northbowen"]];
/* Best passage per document first, so an answer draws on several documents when they agree. */
function diversify(hits: Hit[], n: number): Hit[] {
  const out: Hit[] = []; const docs = new Set<string>();
  for (const h of hits) { if (out.length >= n) break; if (!docs.has(h.p.doc)) { out.push(h); docs.add(h.p.doc); } }
  for (const h of hits) { if (out.length >= n) break; if (!out.includes(h)) out.push(h); }
  return out;
}
function retrieve(a: Answer5, q: string, ctxBasin: string | null, doc: string | null = null): { a: Answer5; top: Hit | null; found: boolean } {
  const named = BASIN_RE.filter(([re]) => re.test(q)).map(([, id]) => id);
  const basin = named.length === 1 ? named[0] : ctxBasin;
  const res = search(q, { basin, limit: 12, doc });
  const { terms, hits } = res;
  let good = hits.filter((h) => passes(h, terms.length));
  if (good.length > 1) good = good.filter((h) => h.score >= 0.55 * good[0].score);
  if (named.length === 1 && good.some((h) => h.p.basin === named[0])) good = good.filter((h) => h.p.basin === named[0] || !h.p.basin);
  a.why = { terms, rule: `Keyword search (BM25) over all bundled text; a passage is shown when it scores ≥ ${FOUND_GATE.minScore} and matches ≥ ${Math.round(FOUND_GATE.minCoverage * 100)}% of the question's weighted terms (${Math.round(FOUND_GATE.longQuestionCoverage * 100)}% for questions with ${FOUND_GATE.longQuestionTerms}+ terms)`, scores: hits.map((h) => ({ id: h.p.id, score: Math.round(h.score * 10) / 10 })) };
  a.hits = [];
  const picked = diversify(good, 3);
  const used = new Set(picked.flatMap((h) => h.matched));
  // Words that point at the source itself (shows, page, guide, figure) are not parts of the question left unanswered.
  // Show the word as the user typed it ("guide"), not its search stem ("guid").
  // Expanded abbreviations (KB to kelly bushing) are skipped: only words the user typed are listed.
  const META = new Set(["show", "page", "guid", "report", "document", "figur", "tabl", "sourc", "record", "chart", "photo", "imag"]);
  const words = (q.match(/[A-Za-z0-9][A-Za-z0-9.-]*/g) ?? []).map((w) => w.replace(/[.-]+$/, ""));
  const uncovered = [...new Set(terms.filter((t) => !used.has(t) && t.length > 3 && !/^\d/.test(t) && !META.has(t))
    .map((t) => words.find((w) => stem(w.toLowerCase()) === t)).filter((w): w is string => !!w))].slice(0, 4);
  const nDocs = new Set(picked.map((h) => h.p.doc)).size;
  a.searchInfo = { scanned: res.scanned, candidates: res.candidates, passed: good.length, docs: nDocs, boosted: res.boosted, demoted: res.demoted, uncovered };
  if (!good.length) {
    a.status = "unsupported"; a.label = "Not found"; a.reason = "No passage passed the search gate";
    a.provenance = []; a.citations = []; a.table = undefined;
    a.focus = null; a.focusBasin = null;
    a.paragraphs = ["Not found in the data. No passage in this file matches enough of the question to answer it.",
      hits.length ? `Closest passages, too weak to use: ${hits.slice(0, 2).map((h) => `${h.p.doc}${h.p.page ? ` p. ${h.p.page}` : ""}`).join("; ")}.` : "No passage shares its key terms.",
      "Try naming a basin, formation, well or feature."];
    a.followUps = [];
    return { a, top: hits[0] ?? null, found: false };
  }
  a.status = "answered"; a.label = "Retrieved"; a.reason = "Matched passages from the bundled documents"; a.table = undefined;
  a.provenance = ["published"];
  a.basin = basin ?? picked[0].p.basin ?? null; a.focusBasin = a.basin;
  a.paragraphs = [
    ...(picked.length > 1 ? [`From ${picked.length} passages in ${nDocs} document${nDocs === 1 ? "" : "s"}:`] : []),
    ...picked.map((h) => `**${h.p.doc}${h.p.page ? ` · p. ${h.p.page}` : ""}${ADDED_DOC(h.p.id) ? " (added by you)" : ""}:** ${sentencesFor(h.p.t, terms)}`),
    ...(uncovered.length ? [`Not in these passages: ${uncovered.join(", ")}. Treat those parts of the question as unanswered.`] : []),
  ];
  a.citations = picked.map((h) => ({ id: h.p.id, basin: h.p.basin ?? "", doc: h.p.doc, page: h.p.page, heading: h.p.h, text: h.p.t }));
  for (const h of good.slice(0, 5)) if (!a.citations.some((c) => c.id === h.p.id) && a.citations.length < 4) a.citations.push({ id: h.p.id, basin: h.p.basin ?? "", doc: h.p.doc, page: h.p.page, heading: h.p.h, text: h.p.t });
  a.hits = dedupeHits(mapHits(picked.map((h) => `${h.p.h} ${h.p.t}`), 8));
  a.focus = a.hits[0] ? { lon: a.hits[0].lon, lat: a.hits[0].lat, zoom: a.hits[0].kind === "basin" ? 6 : 7.4, label: a.hits[0].label } : null;
  a.followUps = a.basin ? [`Where is the ${basinById(a.basin)?.name ?? "basin"} deepest?`] : [];
  return { a, top: good[0], found: true };
}

const ATTR = /\b(porosity|permeability|saturation|toc|total organic carbon|vitrinite|maturity|net pay|net[- ]to[- ]gross|pressure|temperature|salinity|thickness|velocity|two-way time|twt|shotpoint)\b/i;
function flagsParagraph(basinId: string | null): string | null {
  const b = basinById(basinId); if (!b) return null;
  const by = new Map<string, string[]>();
  for (const u of b.units) { const f = (u as { unc?: string | null }).unc; if (f) by.set(f, [...(by.get(f) ?? []), u.n]); }
  return by.size ? `Resource flags in the same table: ${[...by.entries()].map(([k, v]) => `${k.toLowerCase()}: ${v.join(", ")}`).join("; ")}.` : `No resource flags are recorded for the ${b.name} units.`;
}

function answerCore(q: string, ctx: { basin: string | null }): Answer5 {
  const base = () => ({ ...(computed(q, ctx) as Answer5), hits: [] as MapHit[], label: "Precomputed" as AnswerLabel, reason: "" });
  const a0 = base();
  if (a0.status === "declined") { a0.label = "Not found"; a0.reason = "Outside what this file holds"; return a0; }
  // a question about a document added this session searches that document only
  const added = [...ADDED_TITLES].find((t) => q.toLowerCase().includes(t.toLowerCase()));
  if (added) { const i = q.toLowerCase().indexOf(added.toLowerCase()); const r = retrieve(base(), `${q.slice(0, i)} ${q.slice(i + added.length)}`, ctx.basin, added); r.a.reason = `Searched only the document you added (${added})`; return r.a; }
  // analog questions
  if (/\banalog(ue)?s?\b|\bsimilar (plays?|to)\b/i.test(q)) {
    const named = findPlay(q); const ref = named ?? playById(PACK.defaultRef);
    if (ref) return analogAnswer(a0, ref, !!named);
  }
  // same-age plays
  if (SAME_AGE.test(q)) { const sa = sameAgeAnswer(a0, q); if (sa) return sa; }
  // core photographs by formation or play
  if (/\bcores?\b/i.test(q) && /\b(photo|photograph|image|picture)s?\b/i.test(q)) { const c = coreAnswer(a0, q); if (c) return c; }
  // plays or units carrying a resource flag
  const flag = q.match(/\b(tight gas|shale (?:gas|oil|resources?)|coal seam gas|csg)\b/i)?.[1];
  if (flag && /\b(which|what|list)\b/i.test(q) && /\b(plays?|units?|formations?|intervals?)\b/i.test(q)) return flagAnswer(a0, flag);
  // where is a basin
  const wb = q.match(/^\s*where (?:is|are) (?:the )?(cooper|adavale|galilee|north bowen)(?: basin)?(?: located)?\s*\??\s*$/i)?.[1];
  if (wb) return whereBasin(a0, wb);
  // legacy wells: extracted values first, then report search; never the generic borehole summary
  if (WELL_RE.some(([re]) => re.test(q))) {
    if (/\b(tell me about|summar\w*|overview|describe|what is known|what do we know)\b/i.test(q)) { const w = WELLS.find((x) => new RegExp(`\\b${x.name.split(" ")[0]}\\b`, "i").test(q)); if (w) return wellOverview(base(), w); }
    const m = fieldMatch(q);
    const r = retrieve(base(), q, ctx.basin);
    if (m && (!r.found || m.cov >= (r.top?.coverage ?? 0) - 0.15)) return fieldAnswer(base(), m);
    if (r.found) return r.a;
    if (m) return fieldAnswer(base(), m);
    if (!ATTR.test(q) && /\b(where|location|located|position|who|when|how deep|total depth)\b/i.test(q) && a0.status === "answered") { a0.citations = a0.citations.length ? a0.citations : datasetCites(a0); a0.label = "Precomputed"; a0.reason = a0.why.rule; return a0; }
    return r.a;
  }
  const generic = a0.status !== "answered" || /^Ranked retrieval/.test(a0.why.rule);
  const text = a0.paragraphs.join(" ").toLowerCase();
  const attr = q.match(ATTR)?.[1]?.toLowerCase();
  const missesAttr = !!attr && !text.includes(attr.split(" ")[0]);
  if (!generic && !missesAttr) {
    const a = a0; a.label = "Precomputed"; a.reason = a.why.rule;
    if (/^Unit roles/.test(a.why.rule) && /\b(tight|shale|coal seam|csg|flag|unconventional)\b/i.test(q)) { const fp = flagsParagraph(a.basin); if (fp) a.paragraphs.push(fp); }
    if (!a.citations.length) a.citations = datasetCites(a); else if (/borehole|depth|grid|stress|compar/i.test(a.why.rule)) a.citations = [...a.citations, ...datasetCites(a)].slice(0, 4);
    a.hits = dedupeHits(mapHits(a.citations.map((c) => c.text).concat(a.paragraphs), 6));
    return a;
  }
  const r = retrieve(base(), q, ctx.basin);
  if (!r.found && attr && a0.status === "answered") {
    const thing = a0.paragraphs[0]?.match(/^\*\*(.+?)\*\*/)?.[1];
    if (thing && !passagesWithBoth(thing, attr.split(" ")[0])) r.a.paragraphs.splice(1, 0, `The file does describe the ${thing} (age, rock type and setting), but nothing in it gives a ${attr} for it.`);
  }
  return r.a;
}

/* Every answer, whatever produced it, gets: pictures that match it, a place on the map for each source,
   a link to a related hypothesis test, and the time it took in this browser. */
function hypothesisFor(q: string, a: Answer5): HDef["id"] | undefined {
  if (a.analogRef) return "analog";
  if (/communicat/i.test(q) && /marabooka|toolachee|patchawarra/i.test(q)) return "communication";
  if (/\b(rift|counterparts?|same[- ]age|continu\w*|equivalents?)\b/i.test(q) && /galilee|bowen/i.test(q) && /cooper/i.test(q)) return "rift";
  if (/\b(stress|shmax|strike-slip)\b/i.test(q) && /cooper/i.test(q)) return "stress";
  return undefined;
}
/* Shorter report names in answers. The Evidence panel keeps the full titles. */
const SHORT: [RegExp, string][] = [
  [/Marabooka 1 · Marabooka No\. 1 Well Completion Report \(Env\. 4324[^)]*\)/g, "Marabooka 1 completion report"],
  [/Marabooka No\. 1 Well Completion Report \(Env\. 4324[^)]*\)/g, "Marabooka 1 completion report"],
  [/Innamincka 1 · Well Completion Report, D\.F\.S\. Innamincka No\. 1 \(report body\)/g, "Innamincka 1 completion report"],
  [/Well Completion Report, D\.F\.S\. Innamincka No\. 1 \(report body\)/g, "Innamincka 1 completion report"],
  [/Innamincka 1 · Appendix (\d+) - ([^(]+?)\s*(\([^)]*\))?(?=[,.;:]| ·|$)/g, "Innamincka 1, Appendix $1 ($2)"],
  [/Innamincka 1 · Government OCR text/g, "Innamincka 1, government OCR text"],
  [/Marabooka 1 · (completion report|checkshot table|velocity chart)/g, "Marabooka 1 $1"],
];
export const shortDoc = (t: string) => SHORT.reduce((x, [re, to]) => x.replace(re, to), t);
export function answer5(q: string, ctx: { basin: string | null }): Answer5 {
  const t0 = performance.now(); let tl = t0;
  const lap = () => { const t = performance.now(); const d = Math.round((t - tl) * 10) / 10; tl = t; return d; };
  const trace: TraceStep[] = [];
  const terms = [...new Set(tokenize(q))]; const named = terms.filter((t) => entityTokens().has(t));
  // Show the words as typed ("boreholes"), not the search stems ("borehol").
  const surf = new Map<string, string>(); for (const [w, st] of tokenizePairs(q)) if (!surf.has(st)) surf.set(st, w);
  const shown = (t: string) => surf.get(t) ?? t;
  trace.push({ step: "Read the question", detail: terms.length ? `${terms.length} search term${terms.length === 1 ? "" : "s"}: ${terms.slice(0, 8).map(shown).join(", ")}${named.length ? `. Named: ${named.slice(0, 6).map(shown).join(", ")}` : ""}` : "No search terms", ms: lap() });
  const a = answerCore(q, ctx);
  a.terms = terms;
  const si = a.searchInfo;
  if (a.status === "declined") trace.push({ step: "Checked the scope", detail: "Outside what this file holds, so it is declined", ms: lap() });
  else if (si && (a.label === "Retrieved" || a.label === "Not found")) trace.push({ step: "Searched the library", detail: `${si.scanned.toLocaleString("en-US")} passages scanned; ${si.candidates.toLocaleString("en-US")} share a term; ${si.passed} passed the evidence bar (score ≥ ${FOUND_GATE.minScore}, ≥ ${Math.round(FOUND_GATE.minCoverage * 100)}% of key terms)`, ms: lap() });
  else trace.push({ step: "Used a prepared rule", detail: a.why.rule || "Rule over the bundled tables", ms: lap() });
  if (si && (si.boosted || si.demoted)) trace.push({ step: "Applied earlier feedback", detail: `${si.boosted} source${si.boosted === 1 ? "" : "s"} ranked higher, ${si.demoted} lower, from thumbs up or down in this browser`, ms: 0 });
  a.paragraphs = a.paragraphs.map(shortDoc);
  for (const c of a.citations) c.doc = shortDoc(c.doc);
  const found = a.label !== "Not found";
  const docs = new Set(a.citations.map((c) => c.doc)).size;
  trace.push({ step: "Built the answer", detail: found ? `${a.citations.length} source${a.citations.length === 1 ? "" : "s"} cited from ${docs} document${docs === 1 ? "" : "s"} or dataset${docs === 1 ? "" : "s"}. No text is generated: the answer quotes or computes from the data.` : "Nothing passed the bar, so the answer says Not found", ms: lap() });
  a.images = found ? imagesFor(q, [...a.paragraphs, ...a.citations.map((c) => c.heading)].join(" "), a.citations, a.basin) : [];
  if (found) trace.push({ step: "Matched images", detail: `${a.images.length} image${a.images.length === 1 ? "" : "s"} matched by formation, well, basin or cited page`, ms: lap() });
  a.geo = {};
  for (const c of a.citations) {
    if (/^ds:/.test(c.id)) { const b = basinById(a.basin); a.geo[c.id] = b ? [{ label: b.name, kind: "polygon", lon: b.labelAt[0], lat: b.labelAt[1], basin: b.id, method: "From the document's basin" }] : []; continue; }
    a.geo[c.id] = geotagPassage({ doc: c.doc, h: c.heading, t: c.text, basin: c.basin || undefined, well: WELL_OF(c.id) }).tags;
  }
  if (found) { const all = Object.values(a.geo).flat(); trace.push({ step: "Placed it on the map", detail: `${all.filter((g) => g.kind === "point").length} point${all.filter((g) => g.kind === "point").length === 1 ? "" : "s"} and ${all.filter((g) => g.kind === "polygon").length} basin outline${all.filter((g) => g.kind === "polygon").length === 1 ? "" : "s"}, GDA94`, ms: lap() }); }
  a.hypothesisRef = a.status !== "declined" ? hypothesisFor(q, a) : undefined;
  a.ms = Math.round((performance.now() - t0) * 10) / 10;
  a.trace = trace;
  return a;
}
