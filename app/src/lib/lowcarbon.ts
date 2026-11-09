import { LOWCARBON_DATA, LICENCE } from "@/lib/licensed-data";
import { GATED } from "@/lib/cloud";
import { fmt } from "@/lib/basins";

/* Low-carbon evidence pack: four public wells whose old reports were read page by page
   (values carry page citations, a confidence level and a review flag), the OZTemp
   temperature layer, published CO2-storage context, and the screening rules the app
   applies. Rules quote their source; where no published pass mark exists the app says
   the rule is still needed instead of inventing one. */

export type Lens = "explore" | "co2" | "geo";
export type Confidence = "high" | "medium" | "low";
export type Readability = "good" | "fair" | "poor";

export interface SiteDoc { docId: string; file: string; title: string; kind: string; year?: number; pages: number; format: string; readability: Readability; note?: string }
export interface SitePage { pageId: string; docId: string; page: number; file: string; w: number; h: number; caption: string; readability: Readability; crop?: string }
export interface OcrBaseline { status: "match" | "partial" | "garbled" | "missing"; text?: string }
export interface SiteField {
  fieldId: string; group: string; label: string; value: number | string; unit?: string;
  valueSI?: number; unitSI?: string; conversion?: string; depthM?: number; depthRef?: string; formation?: string;
  docId: string; page: number; pageId?: string; quote: string; method: "text-layer" | "vision-read" | "computed";
  confidence: Confidence; confidenceWhy: string; needsReview: boolean; ocrBaseline?: OcrBaseline;
}
export interface Finding { findingId: string; topic: "co2" | "geothermal" | "integrity" | "general"; text: string; quote: string; docId: string; page: number; confidence: Confidence }
export interface Curve { curveId: string; label: string; unit: string; depthUnit: "m"; points: [number, number][]; docId: string; note: string }
export interface SiteStats {
  docsInPackage: number; docsSampled: number; pagesSampled: number; pagesReadable: number; fieldsTotal: number; fieldsNeedReview: number;
  ocrCompared: number; ocrMatch: number; ocrPartial: number; ocrGarbled: number; ocrMissing: number;
}
export interface Num { value: number; label: string; fieldIds: string[]; depthM?: number; note?: string }
export interface Range { min: number; max: number; label: string; fieldIds: string[] }
export interface ScreenInputs {
  targetDepthM?: Num; fracGradKPaM?: Num; porePressureMPa?: Num; tdsMgL?: Num; porosityPct?: Range; permMd?: Range;
  sealFindings?: string[]; integrityFindings?: string[]; verdictFindings?: string[];
  maxTempC?: Num; gradientCPerKm?: Num; oz5kmC?: { value: number; note: string };
}
export interface Site {
  siteId: string; name: string; role: string; basinId: string; lat: number; lon: number; positionSource: string;
  spudYear?: number; operator?: string; totalDepthM?: number;
  source: { publisher: string; report: string; url: string; licence: string; credit: string };
  documents: SiteDoc[]; pages: SitePage[]; fields: SiteField[]; findings: Finding[]; curves?: Curve[]; stats: SiteStats; notes: string[];
  kind: "co2" | "geo" | "legacy"; tag: string; headline: string; lenses: Lens[]; inputs: ScreenInputs; identityIssue?: string; scanned?: boolean;
}
export interface ContextPoint { id: string; name: string; lon: number; lat: number; tag: string; positionNote?: string; facts: { text: string; source: string; url: string }[] }
export interface OzTemp {
  image: string; bounds: [number, number, number, number]; legend: { tempC: number; color: string }[]; legendNote: string;
  sampled: { site: string; lon: number; lat: number; tempC: number; note: string }[];
  points: [string, number, number, number, number, string][]; pointCount: number; credit: string; notes: string[];
  grid?: { w: number; h: number; x0: number; y0: number; dx: number; dy: number; b64: string };
}
export interface Pack { built: string; sites: Site[]; oztemp: OzTemp; context: ContextPoint[] }

const PACK = LOWCARBON_DATA;
export const SITES: Site[] = PACK.sites;
export const OZTEMP = PACK.oztemp;
export const CONTEXT = PACK.context;
export const siteById = (id: string | null | undefined) => SITES.find((s) => s.siteId === id) ?? null;
export const docById = (s: Site, id: string) => s.documents.find((d) => d.docId === id) ?? null;
export const fieldById = (s: Site, id: string) => s.fields.find((f) => f.fieldId === id) ?? null;
export const findingById = (s: Site, id: string) => s.findings.find((f) => f.findingId === id) ?? null;

const IMGS = import.meta.glob("../assets/evidence/**/*.webp", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
export function imgUrl(folder: string, file: string): string | null {
  if (GATED && LICENCE.isWithheldAsset(`${folder}/${file}`)) return null;
  return IMGS[`../assets/evidence/${folder}/${file.replace(/^img\//, "")}`] ?? null;
}
export const OZTEMP_URL = imgUrl("oztemp", OZTEMP.image);
export const TEMP_POINTS = OZTEMP.points.map(([name, lon, lat, depthM, tempC, kind]) => ({ name, lon, lat, depthM, tempC, kind }));

/* 5 km temperature at a point, from the OZTemp grid (°C; null outside the layer). */
const GRID = (() => {
  const g = OZTEMP.grid; if (!g) return null;
  const bin = atob(g.b64); const a = new Int16Array(bin.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
  return { ...g, a };
})();
export function temp5kmAt(lon: number, lat: number): number | null {
  if (!GRID) return null;
  const c = Math.floor((lon - GRID.x0) / GRID.dx), r = Math.floor((lat - GRID.y0) / GRID.dy);
  if (c < 0 || r < 0 || c >= GRID.w || r >= GRID.h) return null;
  const v = GRID.a[r * GRID.w + c];
  return v <= -999 ? null : v;
}

/* OzTemp is a continental-scale illustration, so values are shown as 25 °C bands. */
export function ozBand(t: number): string {
  if (t >= 235) return "235 °C or more";
  if (t <= 85) return "85 °C or less";
  const lo = 85 + Math.floor((t - 85) / 25) * 25;
  return `${lo}–${lo + 25} °C`;
}

/* ---------- display helpers ---------- */
export const CONFIDENCE: Record<Confidence, { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-emerald-700 text-white" },
  medium: { label: "Medium", cls: "bg-amber-600 text-black" },
  low: { label: "Low", cls: "bg-red-700 text-white" },
};
export const OCR_LABEL: Record<OcrBaseline["status"], { label: string; cls: string }> = {
  match: { label: "OCR matches", cls: "border-emerald-700 text-emerald-800 dark:text-emerald-300" },
  partial: { label: "OCR partly right", cls: "border-amber-600 text-amber-800 dark:text-amber-300" },
  garbled: { label: "OCR garbled", cls: "border-red-700 text-red-800 dark:text-red-300" },
  missing: { label: "OCR missed it", cls: "border-red-700 text-red-800 dark:text-red-300" },
};
export function fieldValue(f: SiteField): string {
  const v = typeof f.value === "number" ? fmt(f.value, Math.min((String(f.value).split(".")[1] ?? "").length, 3)) : f.value;
  return f.unit ? `${v} ${f.unit}` : String(v);
}
export function fieldSI(f: SiteField): string | null {
  if (f.valueSI == null || !f.unitSI) return null;
  if (f.unit && f.unitSI === f.unit) return null;
  const d = Math.abs(f.valueSI) >= 100 ? 0 : Math.abs(f.valueSI) >= 10 ? 1 : 2;
  return `${fmt(f.valueSI, d)} ${f.unitSI}`;
}
export const docLabel = (s: Site, docId: string, page: number) => `${docById(s, docId)?.title ?? docId} · p. ${page}`;

/* ---------- screening ---------- */
export type ScreenStatus = "meets" | "fails" | "info" | "rule-needed" | "evidence" | "no-data";
export const STATUS: Record<ScreenStatus, { label: string; cls: string }> = {
  meets: { label: "Meets rule", cls: "bg-emerald-700 text-white" },
  fails: { label: "Does not meet", cls: "bg-red-700 text-white" },
  info: { label: "Computed", cls: "bg-slate-700 text-white" },
  "rule-needed": { label: "Your rule needed", cls: "bg-amber-500 text-black" },
  evidence: { label: "Evidence cited", cls: "bg-sky-700 text-white" },
  "no-data": { label: "Not in sampled pages", cls: "bg-muted text-foreground" },
};
export interface Rule { title: string; text: string; source: string; url?: string }
export const RULES: Record<string, Rule> = {
  depth: { title: "Deep enough for dense-phase CO₂", text: "Below about 800–1,000 m, CO₂ is supercritical with a liquid-like density, which makes storage efficient.", source: "IPCC Special Report on CO₂ Capture and Storage (2005)", url: "https://www.ipcc.ch/report/carbon-dioxide-capture-and-storage/" },
  pressure: { title: "Injection pressure limit", text: "Injection pressure may not exceed 90% of the injection zone's fracture pressure.", source: "US EPA Class VI rule, 40 CFR 146.88(a)", url: "https://www.ecfr.gov/current/title-40/chapter-I/subchapter-D/part-146/subpart-H/section-146.88" },
  usdw: { title: "Formation water is not drinking-water quality", text: "An aquifer with fewer than 10,000 mg/L total dissolved solids can count as an underground source of drinking water, which must be protected.", source: "US EPA, 40 CFR 144.3", url: "https://www.ecfr.gov/current/title-40/chapter-I/subchapter-D/part-144/subpart-A/section-144.3" },
  quality: { title: "Reservoir quality", text: "No published pass mark applies; your team supplies its own porosity and permeability cut-offs.", source: "Your screening rules (to be supplied)" },
  seal: { title: "Seal above the store", text: "A low-permeability unit must cap the storage interval; the app cites what the report says.", source: "Report evidence" },
  integrity: { title: "Old wells as leak paths", text: "Wells that penetrate the store need casing, cement and plug records reviewed.", source: "Report evidence" },
  verdict: { title: "Published conclusion (known answer)", text: "What the original study concluded, used to check the screen against a known result.", source: "Report evidence" },
  power: { title: "Hot enough for power generation", text: "Geothermal power plants need very hot water or steam, from 300 °F to 700 °F (149–371 °C).", source: "U.S. Energy Information Administration — Geothermal power plants", url: "https://www.eia.gov/energyexplained/geothermal/geothermal-power-plants.php" },
  gradient: { title: "Geothermal gradient", text: "Average temperature increase with depth over the logged interval.", source: "Computed from the well's temperature records" },
  regional: { title: "Regional temperature at 5 km", text: "Geoscience Australia's interpreted temperature at 5 km, shown as a 25 °C band: GA built it as a continental-scale illustration and advises against site-scale use.", source: "Geoscience Australia OzTemp (CC BY 3.0 AU)" },
  heatIntegrity: { title: "Well integrity at temperature", text: "Casing condition in a hot well, from inspection logs.", source: "Report evidence" },
};
export interface ScreenRow { id: string; rule: Rule; status: ScreenStatus; value: string; short?: string; detail?: string; fieldIds: string[]; findingIds: string[] }
const HYDRO = 9.81; // kPa/m, fresh-water hydrostatic gradient (stated assumption)

export function screen(s: Site, lens: "co2" | "geo"): ScreenRow[] {
  const i = s.inputs; const rows: ScreenRow[] = [];
  if (lens === "co2") {
    const d = i.targetDepthM;
    rows.push(d
      ? { id: "depth", rule: RULES.depth, status: d.value >= 800 ? "meets" : "fails", value: `${fmt(d.value)} m — ${d.label}`, detail: d.value >= 800 ? "Within the dense-phase window." : "Shallower than the dense-phase window.", fieldIds: d.fieldIds, findingIds: [] }
      : { id: "depth", rule: RULES.depth, status: "no-data", value: "No storage interval depth in the sampled pages", fieldIds: [], findingIds: [] });
    const g = i.fracGradKPaM;
    if (g && d) {
      const frac = (g.value * d.value) / 1000; const cap = 0.9 * frac;
      const pore = i.porePressureMPa?.value ?? (HYDRO * d.value) / 1000;
      const head = cap - pore;
      rows.push({
        id: "pressure", rule: RULES.pressure, status: head > 0 ? "info" : "fails",
        value: `${fmt(head, 1)} MPa headroom at ${fmt(d.value)} m`, short: `${fmt(head, 1)} MPa headroom`,
        detail: `Fracture pressure ${fmt(frac, 1)} MPa (${fmt(g.value, 1)} kPa/m × ${fmt(d.value)} m) → 90% cap ${fmt(cap, 1)} MPa, minus ${i.porePressureMPa ? "measured" : "assumed fresh-water hydrostatic"} pore pressure ${fmt(pore, 1)} MPa.${g.note ? ` ${g.note}` : ""}`,
        fieldIds: [...g.fieldIds, ...(i.porePressureMPa?.fieldIds ?? [])], findingIds: [],
      });
    } else rows.push({ id: "pressure", rule: RULES.pressure, status: "no-data", value: g ? "No storage depth to apply it at" : "No leak-off or fracture test in the sampled pages", fieldIds: g?.fieldIds ?? [], findingIds: [] });
    const t = i.tdsMgL;
    rows.push(t
      ? { id: "usdw", rule: RULES.usdw, status: t.value >= 10000 ? "meets" : "fails", value: `${fmt(t.value)} mg/L — ${t.label}`, detail: t.value >= 10000 ? "Above the 10,000 mg/L limit." : "Below 10,000 mg/L: this water could be protected as a drinking-water source.", fieldIds: t.fieldIds, findingIds: [] }
      : { id: "usdw", rule: RULES.usdw, status: "no-data", value: "No formation-water salinity in the sampled pages", fieldIds: [], findingIds: [] });
    const por = i.porosityPct, perm = i.permMd;
    rows.push(por || perm
      ? { id: "quality", rule: RULES.quality, status: "rule-needed", value: [por && `Porosity ${rng(por)} %`, perm && `permeability ${rng(perm)} mD`].filter(Boolean).join(", "), detail: [por?.label, perm?.label].filter(Boolean).join(" · "), fieldIds: [...(por?.fieldIds ?? []), ...(perm?.fieldIds ?? [])], findingIds: [] }
      : { id: "quality", rule: RULES.quality, status: "no-data", value: "No core porosity or permeability in the sampled pages", fieldIds: [], findingIds: [] });
    rows.push(evidenceRow("seal", RULES.seal, s, i.sealFindings));
    rows.push(evidenceRow("integrity", RULES.integrity, s, i.integrityFindings));
    if (i.verdictFindings?.length) rows.push(evidenceRow("verdict", RULES.verdict, s, i.verdictFindings));
  } else {
    const m = i.maxTempC;
    rows.push(m
      ? { id: "power", rule: RULES.power, status: m.value >= 149 ? "meets" : "fails", value: `${fmt(m.value)} °C${m.depthM ? ` at ${fmt(m.depthM)} m` : ""} — ${m.label}`, detail: m.note, fieldIds: m.fieldIds, findingIds: [] }
      : { id: "power", rule: RULES.power, status: "no-data", value: "No measured temperature in the sampled pages", fieldIds: [], findingIds: [] });
    const gr = i.gradientCPerKm;
    rows.push(gr
      ? { id: "gradient", rule: RULES.gradient, status: "info", value: `${fmt(gr.value, 1)} °C/km — ${gr.label}`, short: `${fmt(gr.value, 1)} °C/km`, detail: gr.note, fieldIds: gr.fieldIds, findingIds: [] }
      : { id: "gradient", rule: RULES.gradient, status: "no-data", value: "No temperature profile to compute it from", fieldIds: [], findingIds: [] });
    rows.push(i.oz5kmC
      ? { id: "regional", rule: RULES.regional, status: "info", value: `${ozBand(i.oz5kmC.value)} at 5 km`, short: ozBand(i.oz5kmC.value), detail: i.oz5kmC.note, fieldIds: [], findingIds: [] }
      : { id: "regional", rule: RULES.regional, status: "no-data", value: "Outside the OZTemp layer", fieldIds: [], findingIds: [] });
    rows.push(evidenceRow("heatIntegrity", RULES.heatIntegrity, s, i.integrityFindings));
  }
  return rows;
}
const dp = (v: number) => (v < 1 ? 2 : v < 10 ? 1 : 0);
function rng(r: Range) { return r.min === r.max ? fmt(r.min, dp(r.min)) : `${fmt(r.min, dp(r.min))}–${fmt(r.max, dp(r.max))}`; }
function evidenceRow(id: string, rule: Rule, s: Site, ids?: string[]): ScreenRow {
  const fs = (ids ?? []).map((x) => findingById(s, x)).filter((f): f is Finding => !!f);
  return fs.length
    ? { id, rule, status: "evidence", value: fs[0].text, detail: fs.length > 1 ? `${fs.length} statements cited` : undefined, fieldIds: [], findingIds: fs.map((f) => f.findingId) }
    : { id, rule, status: "no-data", value: "Nothing on this in the sampled pages", fieldIds: [], findingIds: [] };
}

/* ---------- knockout tests on the public sample ---------- */
export type KoStatus = "pass" | "watch" | "blocked";
export interface Knockout { id: string; test: string; result: string; status: KoStatus; next: string }
export const KO_STATUS: Record<KoStatus, { label: string; cls: string }> = {
  pass: { label: "Not a knockout", cls: "bg-emerald-700 text-white" },
  watch: { label: "Watch", cls: "bg-amber-500 text-black" },
  blocked: { label: "Needs your input", cls: "bg-sky-700 text-white" },
};
export function knockouts(): Knockout[] {
  const sum = (k: keyof SiteStats) => SITES.reduce((a, s) => a + (s.stats[k] ?? 0), 0);
  const scan = SITES.filter((x) => x.scanned), digi = SITES.filter((x) => !x.scanned);
  const tally = (xs: Site[]) => [xs.reduce((a, x) => a + x.stats.pagesReadable, 0), xs.reduce((a, x) => a + x.stats.pagesSampled, 0)] as const;
  const [readable, pages] = tally(scan); const [dRead, dPages] = tally(digi);
  const fields = SITES.flatMap((s) => s.fields);
  const low = fields.filter((f) => f.confidence === "low").length, review = fields.filter((f) => f.needsReview).length;
  const conv = fields.filter((f) => f.conversion && f.method !== "computed").length;
  const noDatum = fields.filter((f) => f.depthM != null && (!f.depthRef || /not stated/i.test(f.depthRef))).length;
  const ocr = { n: sum("ocrCompared"), match: sum("ocrMatch"), bad: sum("ocrGarbled") + sum("ocrMissing") + sum("ocrPartial") };
  const curves = SITES.flatMap((s) => (s.curves ?? []).map((c) => ({ s, c })));
  const digitised = curves.filter(({ c }) => /digitis|digitiz|vision/i.test(c.note));
  const idIssues = SITES.filter((x) => x.identityIssue);
  const ocrSites = SITES.filter((x) => x.stats.ocrCompared > 0).map((x) => `${x.name}: ${x.stats.ocrMatch} of ${x.stats.ocrCompared}`).join("; ");
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
  return [
    { id: "read", test: "Readability floor", result: `Scanned reports (${scan.map((x) => x.name).join(", ")}): ${readable} of ${pages} sampled pages readable without guessing (${pct(readable, pages)}%). Born-digital files: ${dRead} of ${dPages}.`, status: pct(readable, pages) >= 80 ? "pass" : "watch", next: "Run the same count on your 20–50 hardest pages." },
    { id: "accuracy", test: "Accuracy per field", result: `${fields.length} values read; ${low} low-confidence, ${review} flagged for review. Accuracy needs an answer key.`, status: "blocked", next: "An expert answer key for the sample pages." },
    { id: "ocr", test: "Beat the existing OCR", result: ocr.n ? `The Government's OCR text had ${ocr.match} of ${ocr.n} checked values right (${ocrSites}). Most of the other ${ocr.bad} sit on pages it never covered — appendices, lab sheets and logs.` : "No OCR baseline available in this sample.", status: ocr.n ? "pass" : "watch", next: "Compare against the OCR you use today, on your team's own worst pages." },
    { id: "logs", test: "Paper logs to curves", result: digitised.length ? `${digitised.map(({ s, c }) => `${s.name}: ${c.points.length} points read from ${/table/i.test(c.note) ? "a scanned table" : "a log image"}`).join("; ")}. Digital logs (LAS) need no digitising.` : "Digital LAS logs used where available; scanned log curves not digitised in this sample.", status: "watch", next: "Decide which curves matter; pair AI with a log-digitising tool and a human check." },
    { id: "identity", test: "Well identity", result: `${SITES.length} of ${SITES.length} packages matched to a named well.${idIssues.length ? ` ${idIssues.length} disagree with the public borehole layer: ${idIssues.map((x) => `${x.name} (${x.identityIssue})`).join("; ")}.` : ""}`, status: idIssues.length ? "watch" : "pass", next: "Match your documents to their well master (UWI) list; let the documents correct the master where they disagree." },
    { id: "units", test: "Units and depth datums", result: `${conv} values converted (feet, psi, °F to SI); ${noDatum} depths with no stated datum.`, status: noDatum ? "watch" : "pass", next: "Agree datum and unit rules; flag every conversion for review." },
    { id: "scale", test: "Cost and archive size", result: `${sum("docsInPackage")} files in ${GATED ? `the ${SITES.length} retained public packages` : "the four public packages"}. Cost per 1,000 pages is set by page count and analyzer choice.`, status: "blocked", next: "Your archive size (pages, images) to size cost and consumption." },
    { id: "residency", test: "Data residency", result: "A design point, not tested on this sample: the production design keeps documents, extracted values and reviews inside your own cloud tenant and chosen region.", status: "blocked", next: "Confirm region, labelling and access rules with your data owners and IT." },
  ];
}

/* ---------- how it is built: capability → Microsoft service → partner options ---------- */
export type Fit = "Out of the box" | "Configure" | "Custom";
export interface Stage { id: string; step: string; capability: string; inApp: string; microsoft: { name: string; fit: Fit }[]; partners: string[]; custom: string }
export const STAGES: Stage[] = [
  { id: "read", step: "Read", capability: "Read scans, PDFs, logs and images, with page citations and confidence", inApp: "Values were extracted from the scanned pages in advance and stored with page, quote, confidence and review flag.",
    microsoft: [{ name: "Azure AI Content Understanding", fit: "Configure" }, { name: "Azure AI Document Intelligence (layout and tables)", fit: "Out of the box" }],
    partners: ["Raster log digitising (for example Neuralog)", "Existing OCR and records-management tools"], custom: "Geoscience field schema, unit and datum rules, review queue" },
  { id: "land", step: "Land and govern", capability: "Store records once, keep lineage, labels and access", inApp: "Every value keeps its source file, page and licence; reviews are saved to the notebook with their source page.",
    microsoft: [{ name: "Microsoft Fabric OneLake", fit: "Out of the box" }, { name: "Azure Data Manager for Energy (OSDU)", fit: "Configure" }, { name: "Microsoft Purview", fit: "Configure" }, { name: "Microsoft Entra ID", fit: "Out of the box" }],
    partners: ["OSDU-compatible interpretation and data-management apps"], custom: "OSDU manifests for your document types; legal tags and access groups" },
  { id: "connect", step: "Connect", capability: "Link wells, formations, tests and documents in one model", inApp: "Sites, documents, values and findings follow the GeoBasin ontology, extended for CO₂ storage and geothermal.",
    microsoft: [{ name: "Fabric IQ ontology (preview)", fit: "Configure" }, { name: "Fabric graph", fit: "Configure" }],
    partners: [], custom: "Storage site, seal, leak-off test, temperature record and well-integrity entity types" },
  { id: "reason", step: "Ask and screen", capability: "Answer with citations; apply your screening rules; challenge the result", inApp: "Answers and screening run locally from the evidence pack; rules quote their source.",
    microsoft: [{ name: "Foundry IQ / Azure AI Search", fit: "Configure" }, { name: "Microsoft Foundry Agent Service", fit: "Custom" }, { name: "Microsoft 365 Copilot and Teams", fit: "Out of the box" }],
    partners: [], custom: "Screening agent with your rules, a critic step and an evaluation set" },
  { id: "simulate", step: "Simulate", capability: "Run plume, pressure and heat-extraction models at scale", inApp: "The app computes injection-pressure headroom and gradients; full simulation is not run here.",
    microsoft: [{ name: "Azure HPC (HBv5 / HX virtual machines)", fit: "Out of the box" }, { name: "Azure CycleCloud and Batch", fit: "Configure" }],
    partners: ["GEOS (open source)", "CMG GEM", "SLB Petrel and INTERSECT", "tNavigator", "TOUGH (for geothermal)"], custom: "Job orchestration and results written back with lineage" },
  { id: "act", step: "Map and decide", capability: "See every site, layer and decision on one map; hand off to specialist tools", inApp: "Custom map in this app; human sign-off is saved to the notebook.",
    microsoft: [{ name: "Fabric Maps / Azure Maps", fit: "Out of the box" }, { name: "Power BI", fit: "Out of the box" }],
    partners: ["Esri ArcGIS", "SLB Petrel / DELFI via OSDU"], custom: "Map-first screening app and review workflow" },
];
export const ASKS = [
  "20–50 of your hardest pages: typed, handwritten, faded, skewed and stamped well reports, P&A, casing and cement records, mud logs",
  "5–10 images: paper logs, core photos, cement-bond logs, wellbore diagrams",
  "An answer key: what your expert pulls from those pages",
  "The 5–10 screening rules your team uses for go / no-go",
  "Constraints: data sensitivity, archive size, formats, today's OCR",
];

/* ---------- guided demo ---------- */
export type Tab = "ask" | "evidence" | "screen" | "build" | "notebook";
export type TourBadge = "real" | "read" | "computed" | "rule" | "human" | "design";
export const TOUR_BADGE: Record<TourBadge, { label: string; cls: string }> = {
  real: { label: "Public data", cls: "bg-[#E0F2FE] text-[#0b2a4a]" },
  read: { label: "AI-extracted in advance", cls: "bg-[#BAE6FD] text-[#0b2a4a]" },
  computed: { label: "Calculated", cls: "bg-[#e9e3ff] text-[#2b1d6b]" },
  rule: { label: "Example rule set", cls: "bg-[#FEF3C7] text-[#4a2a00]" },
  human: { label: "Expert review", cls: "bg-[#DCFCE7] text-[#0d3b1c]" },
  design: { label: "Target design", cls: "bg-white text-brand ring-1 ring-brand/30" },
};
export interface TourStep {
  id?: string; title: string; body: string; badges: TourBadge[]; target?: string;
  lens: Lens; site: string | null; tab: Tab; screenLens?: "co2" | "geo"; view?: { lon: number; lat: number; zoom: number };
  focusField?: string; reveal?: boolean; buildSection?: "stages" | "knockouts";
}
const ALL_TOUR: TourStep[] = [
  {
    title: "Screen CO₂ storage and geothermal on one map",
    body: GATED ? "Switch between Explore, CO₂ storage and Geothermal to compare the retained well evidence with the published screening tests." : "Switch between Explore, CO₂ storage and Geothermal to change the layers and wells on the map. Four public wells in the Cooper and Bowen basins carry evidence read from their original reports, and the table compares them against the same screening tests.",
    badges: ["real"], target: '[data-tour="lens"]',
    lens: "co2", site: null, tab: "screen", view: { lon: 144.6, lat: -25.6, zoom: 5.3 },
  },
  {
    title: "Geothermal screening",
    body: "The geothermal view adds Geoscience Australia's interpreted temperature at 5 km and 1,152 measured well temperatures. Habanero 1's digital logs reach 245 °C at 4.3 km, above the 149 °C power threshold; its records also show a packer that failed its pressure test and a 2016 plug and abandonment.",
    badges: ["real", "computed"], target: '[data-tour="temp"]',
    lens: "geo", site: "habanero-1", tab: "screen", screenLens: "geo",
  },
  {
    title: "From prototype to production",
    body: "Each capability — read, store and govern, connect, ask and screen, simulate, map and decide — maps to Microsoft services and partner tools, marked out of the box, configure or custom. The “How it's built” switch shows the same mapping on any screen.",
    badges: ["design"], target: '[data-tour="stages"]',
    lens: "geo", site: null, tab: "build", buildSection: "stages", reveal: true,
  },
  {
    title: "Early knockout tests",
    body: "Readability, OCR coverage, log digitising, well identity and units are tested on the public sample. Accuracy and cost are confirmed on your own documents, with an expert answer key and your screening rules.",
    badges: ["computed", "design"], target: '[data-tour="knockouts"]',
    lens: "co2", site: null, tab: "build", buildSection: "knockouts", reveal: true,
  },
];

export const TOUR = GATED ? ALL_TOUR.filter((s) => !LICENCE.referencesWithheld(s)) : ALL_TOUR;
