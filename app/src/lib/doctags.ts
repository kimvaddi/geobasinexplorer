import { index } from "@/lib/search";
import { geotagPassage, wellOf as WELL_OF } from "@/lib/geotag";
import { WELLS } from "@/lib/pack";

/* Tagged documents layer: every searchable passage placed on the map with the same geotags the
   answers use. Points are grouped where several passages name the same place. */
export interface DocPoint { id: string; lon: number; lat: number; label: string; n: number; passages: string[]; how: string }
export interface DocLayer { points: DocPoint[]; byBasin: Record<string, string[]>; general: number; total: number; ms: number }
let CACHE: DocLayer | null = null;
export function docLayerSync(): DocLayer | null { return CACHE; }
export async function docLayer(): Promise<DocLayer> {
  if (CACHE) return CACHE;
  const t0 = performance.now(); const docs = index().docs; const pts = new Map<string, DocPoint>(); const byBasin: Record<string, string[]> = {}; let general = 0;
  for (let i = 0; i < docs.length; i++) {
    const p = docs[i].p; const r = geotagPassage({ doc: p.doc, h: p.h, t: p.t, basin: p.basin, well: p.well ?? WELL_OF(p.id) });
    if (r.general) general++;
    for (const t of r.tags) {
      if (t.kind === "point") { const k = `${t.lon.toFixed(2)}|${t.lat.toFixed(2)}`; const e = pts.get(k); if (e) { if (!e.passages.includes(p.id)) { e.passages.push(p.id); e.n++; } } else pts.set(k, { id: k, lon: t.lon, lat: t.lat, label: t.label, n: 1, passages: [p.id], how: t.method }); }
      else if (t.basin) { const l = (byBasin[t.basin] ??= []); if (!l.includes(p.id)) l.push(p.id); }
    }
    if (i % 40 === 39) await new Promise((r2) => setTimeout(r2, 0));
  }
  CACHE = { points: [...pts.values()].sort((a, b) => b.n - a.n), byBasin, general, total: docs.length, ms: Math.round(performance.now() - t0) };
  return CACHE;
}
export const wellsWithReports = WELLS.map((w) => w.siteId);
