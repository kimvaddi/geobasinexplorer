import { BASINS, haversineKm } from "@/lib/basins";
import { PACK, WELLS } from "@/lib/pack";

/* Spatial checks, computed in the browser from the data in this file. */
export interface LayerCheck { basin: string; total: number; inside: number; noDepth: number; noYear: number; firstYear: number | null; lastYear: number | null; deepest: number | null }
export interface WellCheck { well: string; check: string; document: string; layer: string; ok: boolean; note: string }
export interface Checks { layers: LayerCheck[]; wells: WellCheck[]; claims: { claim: string; computed: string; ok: boolean }[]; names: { title: string; detail: string; fix: string }[]; crs: { crs: string; datasets: number }[]; ms: number }
let C: Checks | null = null;
export function spatialChecks(): Checks {
  if (C) return C;
  const t0 = performance.now();
  const layers: LayerCheck[] = BASINS.map((b) => {
    const yrs = b.boreholes.map((w) => w.year).filter((y): y is number => y != null);
    const tds = b.boreholes.map((w) => w.td).filter((d): d is number => d != null);
    return { basin: b.name, total: b.boreholes.length, inside: b.boreholes.filter((w) => w.inside).length, noDepth: b.boreholes.length - tds.length, noYear: b.boreholes.length - yrs.length,
      firstYear: yrs.length ? Math.min(...yrs) : null, lastYear: yrs.length ? Math.max(...yrs) : null, deepest: tds.length ? Math.max(...tds) : null };
  });
  const wells: WellCheck[] = [];
  for (const w of WELLS) {
    const key = w.name.toUpperCase();
    const ga = BASINS.flatMap((b) => b.boreholes).find((x) => (x.name ?? "").toUpperCase() === key);
    if (!ga) { wells.push({ well: w.name, check: "In the borehole layer", document: "Report", layer: "Not found", ok: false, note: "No borehole with this name in the layer." }); continue; }
    void haversineKm;
    if (w.spudYear) wells.push({ well: w.name, check: "Year drilled", document: `Spudded ${w.spudYear}`, layer: ga.year ? String(ga.year) : "Not given", ok: ga.year === w.spudYear, note: ga.year === w.spudYear ? "Agrees" : ga.year ? `${Math.abs(ga.year - w.spudYear)} years apart. The report is the primary source.` : "Year missing in the layer" });
    if (w.totalDepthM) wells.push({ well: w.name, check: "Total depth", document: `${Math.round(w.totalDepthM).toLocaleString("en-US")} m`, layer: ga.td ? `${ga.td.toLocaleString("en-US")} m` : "Not given", ok: ga.td != null && Math.abs(ga.td - w.totalDepthM) <= 2, note: ga.td != null && Math.abs(ga.td - w.totalDepthM) <= 2 ? "Agrees" : "Differs" });
  }
  const pos = PACK.positions;
  if (pos) for (const r of pos.rows) wells.push({ well: "Marabooka 1", check: `Printed position: ${r.source}`, document: `${r.printed} (${r.datum})`, layer: "GA layer (GDA94)", ok: r.kmFromGA < 0.05, note: r.kmFromGA < 0.05 ? "Within 50 m after datum conversion" : `${r.kmFromGA.toFixed(2)} km away after datum conversion` });
  const claims = PACK.checks.validation.map((v) => ({ claim: v.claim, computed: v.computed, ok: v.match === true }));
  const names = PACK.checks.findings.map((f) => ({ title: f.title, detail: f.detail, fix: f.fix }));
  const crsCount = new Map<string, number>();
  for (const d of PACK.datasets) { const k = /4283/.test(d.crs) ? "GDA94, geographic (EPSG:4283)" : /^n\/?a$/i.test(d.crs.trim()) ? "No geometry (table or document)" : d.crs; crsCount.set(k, (crsCount.get(k) ?? 0) + 1); }
  C = { layers, wells, claims, names, crs: [...crsCount.entries()].map(([crs, datasets]) => ({ crs, datasets })), ms: Math.round(performance.now() - t0) };
  return C;
}
