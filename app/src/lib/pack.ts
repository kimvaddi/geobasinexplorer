import { APP_DATA, LICENCE } from "@/lib/licensed-data";
import { GATED } from "@/lib/cloud";
import { BASINS, basinAt, type LonLat } from "@/lib/basins";
import type { Site } from "@/lib/wells";

/* GeoBasin Explorer AI data pack: real public layers, legacy-scan extractions, review entities, benchmark
   questions, analog play features and measured metrics. Nothing in this pack is synthetic. */

export type DataType = "born-digital" | "structured" | "legacy-scan";
export const DATA_TYPES: { id: DataType; label: string; hint: string }[] = [
  { id: "born-digital", label: "Born-digital documents", hint: "Reports, glossaries, metadata statements" },
  { id: "structured", label: "Structured data", hint: "Logs (LAS), rasters, tables, seismic images" },
  { id: "legacy-scan", label: "Legacy scans", hint: "Scanned reports, tables and charts" },
];
export type Level = "Find" | "Locate" | "Interpret" | "Map" | "Integrate" | "Reason";
export const LEVELS: { id: Level; hint: string }[] = [
  { id: "Find", hint: "Right document" },
  { id: "Locate", hint: "Right figure, section, table or log" },
  { id: "Interpret", hint: "Geological entities" },
  { id: "Map", hint: "Spatial" },
  { id: "Integrate", hint: "Across documents and datasets" },
  { id: "Reason", hint: "Supports a hypothesis" },
];
export interface Grid { w: number; h: number; x0: number; y0: number; dx: number; dy: number; b64: string; nodata: number; src: string; scale: string }
export interface Dataset { basin: string; name: string; fmt?: string; records?: number | string; crs: string; licence: string; file?: string }
export interface Panel { id: string; title: string; code: string; play?: string; w: number; h: number; scale: number; img: string; basin: string; file: string }
export interface Strip { id: string; panel: string; unit: string; well: string; top: string; base: string; box: number[]; thumb: string; tw: number; th: number }
export interface Photo { id: string; file: string; formation: string; play?: string; wells?: string[] | string; code?: string; regions?: string; w: number; h: number; img: string; depths_m?: number[] | null }
export interface Chart { id: string; basin: string; title: string; w: number; h: number; img: string }
export interface ReportPage { doc: string; page: number; w: number; h: number; img: string }
export interface Passage5 { id: string; doc: string; page: number; h: string; t: string; kind?: string; well?: string; confidence?: string; basin?: string }
export interface PlayUnit { n: string; rank: string; age: string; lith: string; env: string; pet: string; unc: string; basin: string }
export interface Play5 {
  id: string; play: string; province: string; top: number | null; base: number | null; interval: string; stage: string; basins: string[]; units: PlayUnit[];
  ecat: number; env: string[]; lith: string[]; res: string[]; roles: string[]; period: string | null; passages: string[];
}
export interface Entity { id: string; type: "basin" | "play" | "formation" | "age" | "well" | "interval"; label: string; attrs: Record<string, string | number | null>; source: string; method: string; confidence: string; basin: string | null; lonlat: LonLat | null; crs: string | null }
export interface Bench { id: string; dataType: DataType; level: Level; q: string; key: string; evidence: { doc: string; page: number; passage?: string }[]; custom?: boolean }
export interface RealRow { item: string; status: "Real" | "Computed" | "Extracted" | "Illustrative" | "Proposed" | "Not included"; source: string; note: string }
export interface MapRow { capability: string; inFile: string; service: string; tag: "Out of the box" | "Configured" | "Custom" | "Research"; partner?: string }
export interface Metric { group: string; label: string; value: string; how: string }
export interface VelocityRow { cells: (string | null)[]; confidence: string; needsReview: boolean; note?: string }
export interface VelocityValue { valueId: string; label: string; value: string; unit?: string; confidence: string; needsReview: boolean; quote: string; note?: string }
export interface VelocityItem {
  itemId: string; file: string; title: string; kind: string; scan: { w: number; h: number; bits: string; readability: string; note: string };
  timing: { elapsedSec: number; note: string }; headers?: string[]; datum?: string; rows?: VelocityRow[]; values?: VelocityValue[];
  curvePoints?: { depthFtMSL: number; twtSec: number; confidence: string }[]; failures: { where: string; what: string; why: string }[];
  crossChecks: { check: string; result: string; formula?: string; agrees: boolean | null }[]; images: { file: string; caption: string; w: number; h: number; crop?: string; img: string }[];
  stats: { cellsOrValuesAttempted: number; readHigh: number; readMedium: number; readLow: number; unreadable: number };
}
export interface LasCurve { mnem: string; unit: string; descr: string; min: number | null; max: number | null; nulls: number; samples: number; pts: [number, number][] }
export interface LasPack {
  well: string; file: string; source: string; version: string; wrap: string; nullValue: number; depthUnit: string; start: number; stop: number; step: number;
  header: { section: string; mnem: string; unit: string; value: string; descr: string }[]; curves: LasCurve[];
  issues: { where: string; what: string; severity: "info" | "warning" | "failure" }[]; tops: { name: string; depth: number; source: string }[]; parseMs: number;
}
export interface FigureItem {
  doc: string; page: number; title: string; caption: string; img: string; w: number; h: number;
  extracted: { label: string; value: string; confidence: string; note?: string }[]; failures: { where: string; what: string; why: string }[]; legend: { label: string; colour?: string; confidence: string }[];
  timing?: { elapsedSec: number; note: string }; extraImages?: { img: string; w: number; h: number; caption: string }[];
}
export interface Pack {
  built: string; conf: Record<string, { boreholes: Grid; seismic: Grid }>; confOverlay: { src: string; bounds: [number, number, number, number]; stops: string[] } | null;
  seismic2d: Record<string, LonLat[][]>; datasets: Dataset[]; core: { panels: Panel[]; strips: Strip[]; photos: Photo[] }; charts: Chart[]; reportPages: ReportPage[];
  checks: { validation: { claim: string; src: string; computed: string; match: boolean | string }[]; findings: { id: string; kind: string; severity: string; title: string; detail: string; fix: string }[] };
  positions: { well: string; ga: { lat: number; lon: number; source: string }; rows: { source: string; printed: string; datum: string; lat: number; lon: number; kmFromGA: number; how: string; confidence: string }[]; note: string } | null;
  wells: Site[]; velocity: { well: string; source: { publisher: string; licence: string; report: string }; items: VelocityItem[] } | null; las: LasPack | null; figures: FigureItem[];
  extraPassages: Passage5[]; plays: Play5[]; defaultRef: string; weights: Record<string, number>; entities: Entity[]; benchmarks: Bench[];
  realness: RealRow[]; removed: string[]; mapping: MapRow[]; metrics: Metric[]; learning: { date: string; trigger: string; change: string; effect: string }[]; learningNote: string; docs: { id: string; title: string; dataType: DataType; pages: number | string; source: string; licence: string }[];
}
export const PACK = APP_DATA;
export const WELLS = PACK.wells;
export const wellById = (id: string | null | undefined) => WELLS.find((w) => w.siteId === id) ?? null;

/* ---------- grids ---------- */
const decoded = new Map<Grid, Uint8Array>();
function bytes(g: Grid) {
  let a = decoded.get(g);
  if (!a) { a = Uint8Array.from(atob(g.b64), (ch) => ch.charCodeAt(0)); decoded.set(g, a); }
  return a;
}
export function gridAt(g: Grid, lon: number, lat: number): number | null {
  const c = Math.floor((lon - g.x0) / g.dx), r = Math.floor((lat - g.y0) / g.dy);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return null;
  const v = bytes(g)[r * g.w + c];
  return v === g.nodata ? null : v;
}
const pctCache = new Map<Grid, number[]>();
/* Share of the basin's valid cells with a lower value (0–100). */
export function percentile(g: Grid, v: number): number {
  let sorted = pctCache.get(g);
  if (!sorted) { sorted = Array.from(bytes(g)).filter((x) => x !== g.nodata).sort((a, b) => a - b); pctCache.set(g, sorted); }
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  let eq = lo; while (eq < sorted.length && sorted[eq] === v) eq++;
  return Math.round((100 * (lo + (eq - lo) / 2)) / Math.max(1, sorted.length));
}

/* ---------- "What we know here" ---------- */
const R_EARTH = 6371;
export function km(lon1: number, lat1: number, lon2: number, lat2: number) {
  const p = Math.PI / 180, a = Math.sin(((lat2 - lat1) * p) / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}
function segKm(lon: number, lat: number, a: LonLat, b: LonLat) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.57;
  const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
export interface HereInfo {
  lon: number; lat: number; basin: string | null; basinName: string | null; depth: number | null;
  boreholes: { name: string; km: number; td: number | null; year: number | null; key: string; lon: number; lat: number }[]; within10: number;
  stress: { km: number; azi: number; quality: string; regime: string } | null; seismicKm: number | null;
  ga: { boreholes: number | null; seismic: number | null; boreholesSrc: string | null; seismicSrc: string | null };
  features: { name: string; km: number; kind: string }[]; wells: { id: string; name: string; km: number }[];
  uncertainty: "Low" | "Medium" | "High"; reasons: string[]; crs: { item: string; crs: string }[];
  /* Cloud build only: the GDAL/PROJ spatial service's answer for this point, while it is pending, or why it failed. */
  geo?: { method: string; versions: { gdal: string; proj: string }; gda2020: SpatialHere["gda2020"]; mga: SpatialHere["mga"]; ms: number };
  checking?: boolean; geoError?: string;
  /* Cloud build only: library sources geotagged near this point (Azure AI Search geo fields), pending, or why not. */
  sources?: NearResult; sourcesChecking?: boolean; sourcesError?: string;
}
/* What the service returns for "Sources near here" (services/api/src/geo.ts). Distances are great-circle. */
export const NEAR_KM = 50;
export interface NearSource { id: string; doc: string; page: number; pages: number[]; passages: number; heading: string; place: string; how: string; lon: number; lat: number; km: number; yours: boolean }
export interface NearResult {
  lon: number; lat: number; km: number; matched: number; sources: NearSource[]; nearest: NearSource | null;
  basin: { id: string; name: string; passages: number } | null; ms: number; method: string;
}
/* What the spatial service returns for "What we know here" (services/spatial/server.py): geodesic distances on GRS80. */
export interface SpatialHere {
  lon: number; lat: number; basin: string | null; basinName: string | null; depth: number | null;
  boreholes: HereInfo["boreholes"]; within10: number; stress: HereInfo["stress"]; seismicKm: number | null;
  features: HereInfo["features"]; wells: HereInfo["wells"];
  gda2020: { lon: number; lat: number; shiftM: number };
  mga: { zone: number; gda94: { epsg: number; easting: number; northing: number }; gda2020: { epsg: number; easting: number; northing: number } };
  ms: number; engine: "gdal"; method: string; versions: { gdal: string; proj: string };
}
function rate(near: number, ga: HereInfo["ga"], bid: string | null): Pick<HereInfo, "uncertainty" | "reasons"> {
  const reasons: string[] = [];
  let score = 0;
  if (near <= 5) { score += 2; reasons.push(`nearest borehole ${near.toFixed(1)} km away`); } else if (near <= 20) { score += 1; reasons.push(`nearest borehole ${near.toFixed(0)} km away`); } else reasons.push(near === Infinity ? "no borehole within about 100 km" : `nearest borehole ${near.toFixed(0)} km away`);
  if (ga.boreholes != null) { if (ga.boreholes >= 67) score += 1; else if (ga.boreholes < 33) score -= 1; reasons.push(`GA borehole confidence higher than ${ga.boreholes}% of this basin`); }
  if (ga.seismic != null) { if (ga.seismic >= 67) score += 1; else if (ga.seismic < 33) score -= 1; reasons.push(`GA seismic confidence higher than ${ga.seismic}% of this basin`); }
  if (!bid) { score -= 1; reasons.push("outside the four basin outlines"); }
  return { uncertainty: score >= 3 ? "Low" : score >= 1 ? "Medium" : "High", reasons };
}
/* Replaces the browser's distances with the spatial service's geodesic ones and adds the GDA2020 and MGA positions.
   The GA confidence percentiles stay as computed here: they are grid look-ups on the same bundled data. */
export function withSpatial(h: HereInfo, s: SpatialHere): HereInfo {
  const { uncertainty, reasons } = rate(s.boreholes[0]?.km ?? Infinity, h.ga, s.basin);
  const lat = `${Math.abs(s.gda2020.lat).toFixed(6)}°S ${s.gda2020.lon.toFixed(6)}°E`;
  const crs = h.crs.map((c) => (c.item === "This point" ? { item: c.item, crs: `Shown in GDA94. In GDA2020 it is ${lat}, ${s.gda2020.shiftM.toFixed(2)} m away (transformed with PROJ ${s.versions.proj})` } : c));
  return { ...h, basin: s.basin, basinName: s.basinName, depth: s.depth, boreholes: s.boreholes, within10: s.within10, stress: s.stress, seismicKm: s.seismicKm,
    features: s.features, wells: s.wells.filter((w) => !GATED || !LICENCE.isWithheldWell(w.id)), uncertainty, reasons, crs, checking: false, geoError: undefined,
    geo: { method: s.method, versions: s.versions, gda2020: s.gda2020, mga: s.mga, ms: s.ms } };
}
export function whatHere(lon: number, lat: number, depthAt: (bid: string, lon: number, lat: number) => number | null): HereInfo {
  const b = basinAt(lon, lat);
  const bid = b?.id ?? null;
  const all: HereInfo["boreholes"] = [];
  for (const bb of BASINS) for (const w of bb.boreholes) {
    if (Math.abs(w.lat - lat) > 1 || Math.abs(w.lon - lon) > 1.2) continue;
    all.push({ name: w.name ?? "Unnamed borehole", km: km(lon, lat, w.lon, w.lat), td: w.td, year: w.year, key: w.key, lon: w.lon, lat: w.lat });
  }
  all.sort((x, y) => x.km - y.km);
  let stress: HereInfo["stress"] = null;
  for (const bb of BASINS) for (const s of bb.stress) {
    const d = km(lon, lat, s[0], s[1]);
    if (!stress || d < stress.km) stress = { km: d, azi: s[2], quality: s[3], regime: s[4] };
  }
  let seismicKm: number | null = null;
  for (const lines of Object.values(PACK.seismic2d)) for (const ln of lines) for (let i = 1; i < ln.length; i++) {
    if (Math.abs(ln[i][1] - lat) > 1.5 || Math.abs(ln[i][0] - lon) > 1.5) continue;
    const d = segKm(lon, lat, ln[i - 1], ln[i]);
    if (seismicKm == null || d < seismicKm) seismicKm = d;
  }
  const g = bid ? PACK.conf[bid] : null;
  const gb = g ? gridAt(g.boreholes, lon, lat) : null, gs = g ? gridAt(g.seismic, lon, lat) : null;
  const ga = { boreholes: gb == null || !g ? null : percentile(g.boreholes, gb), seismic: gs == null || !g ? null : percentile(g.seismic, gs), boreholesSrc: g?.boreholes.src ?? null, seismicSrc: g?.seismic.src ?? null };
  const features: HereInfo["features"] = [];
  for (const bb of BASINS) for (const f of bb.features) { const d = km(lon, lat, f.lon, f.lat); if (d < 60) features.push({ name: f.n, km: d, kind: f.t }); }
  features.sort((x, y) => x.km - y.km);
  const wells = WELLS.map((w) => ({ id: w.siteId, name: w.name, km: km(lon, lat, w.lon, w.lat) })).filter((w) => w.km < 80).sort((x, y) => x.km - y.km);
  const within10 = all.filter((w) => w.km <= 10).length;
  const { uncertainty, reasons } = rate(all[0]?.km ?? Infinity, ga, bid);
  const ds = bid ? PACK.datasets.filter((d) => d.basin === bid) : [];
  const crsOf = (re: RegExp, fallback: string) => ds.find((d) => re.test(d.name))?.crs ?? fallback;
  const crs = [
    { item: "Basin outline and depth grid", crs: crsOf(/extent|depth/i, "GDA94 (EPSG:4283)") },
    { item: "Boreholes", crs: crsOf(/borehole/i, "GDA94 (EPSG:4283)") },
    { item: "Data-confidence grids", crs: crsOf(/confidence/i, "GDA94 (EPSG:4283)") },
    { item: "Stress records", crs: "WGS84 (World Stress Map 2025)" },
    { item: "This point", crs: "Shown in GDA94; GDA2020 differs by about 1.8 m here (not transformed)" },
  ];
  return { lon, lat, basin: bid, basinName: b?.name ?? null, depth: bid ? depthAt(bid, lon, lat) : null, boreholes: all.slice(0, 5), within10, stress: stress && stress.km < 150 ? stress : null,
    seismicKm, ga, features: features.slice(0, 4), wells, uncertainty, reasons, crs };
}

/* ---------- labels ---------- */
export const STATUS_CLS: Record<RealRow["status"], string> = {
  Real: "bg-emerald-700 text-white", Computed: "bg-violet-700 text-white", Extracted: "bg-sky-700 text-white", Illustrative: "bg-amber-400 text-black", Proposed: "bg-slate-200 text-slate-900 border border-slate-400 dark:bg-slate-700 dark:text-white", "Not included": "bg-muted text-foreground",
};
export const TAG_CLS: Record<MapRow["tag"], string> = {
  "Out of the box": "bg-[#E0F2FE] text-[#0b2a4a]", Configured: "bg-[#BAE6FD] text-[#0b2a4a]", Custom: "bg-[#DCFCE7] text-[#0d3b1c]", Research: "bg-[#FEF3C7] text-[#4a2a00]",
};
