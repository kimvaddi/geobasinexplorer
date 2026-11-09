import { BASINS, basinAt, depthAt, type LonLat } from "@/lib/basins";
import { km } from "@/lib/pack";

/* Cross-section along a line drawn on the map: the GA depth-to-basement surface sampled every few
   kilometres, boreholes within 10 km of the line, mapped faults it crosses and the basins it passes
   through. Basin floor only: the bundled packages hold no horizon grids. */
export interface SectionPoint { d: number; lon: number; lat: number; depth: number | null; basin: string | null }
export interface Section {
  a: LonLat; b: LonLat; lengthKm: number; pts: SectionPoint[]; maxDepth: number | null;
  boreholes: { name: string; d: number; off: number; td: number | null; year: number | null; key: string }[];
  faults: { d: number }[]; basins: { id: string; name: string; d0: number; d1: number }[]; features: { name: string; d: number; off: number }[]; ms: number;
  /* Cloud build: "gdal" when the spatial service measured it (geodesic on GRS80); "browser" when it fell back to this file. */
  engine?: "gdal" | "browser"; method?: string; versions?: { gdal: string; proj: string };
  /* The prototype's reference method on the same line, kept so the locked reference fixture can be rerun (260 km, 464 boreholes). */
  reference?: { lengthKm: number; boreholes: number; method: string };
  fallback?: string;
}
export const PRESETS: { id: string; label: string; a: LonLat; b: LonLat; note: string }[] = [
  { id: "cooper-we", label: "West to east across the Cooper Basin", a: [139.55, -28.05], b: [142.2, -27.95], note: "Crosses the Patchawarra and Nappamerri troughs" },
  { id: "cooper-sn", label: "South to north across the Nappamerri Trough", a: [140.6, -28.75], b: [140.85, -26.9], note: "Across the deepest part of the Cooper Basin" },
  { id: "galilee-bowen", label: "Galilee Basin to the North Bowen Basin", a: [144.6, -22.9], b: [149.2, -23.4], note: "Links two basins with same-age Permian plays" },
];
const kx = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
export function computeSection(a: LonLat, b: LonLat, n = 260): Section {
  const t0 = performance.now(); const L = km(a[0], a[1], b[0], b[1]);
  const pts: SectionPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n; const lon = a[0] + (b[0] - a[0]) * t, lat = a[1] + (b[1] - a[1]) * t;
    const bs = basinAt(lon, lat); pts.push({ d: L * t, lon, lat, depth: bs ? depthAt(bs, lon, lat) : null, basin: bs?.id ?? null });
  }
  const valid = pts.map((p) => p.depth).filter((x): x is number => x != null);
  const maxDepth = valid.length ? Math.max(...valid) : null;
  // local projection: x along the line, y across it (km)
  const midLat = (a[1] + b[1]) / 2; const ux = (b[0] - a[0]) * kx(midLat), uy = (b[1] - a[1]) * 110.57; const ul = Math.hypot(ux, uy) || 1;
  const proj = (lon: number, lat: number) => { const x = (lon - a[0]) * kx(midLat), y = (lat - a[1]) * 110.57; return { along: (x * ux + y * uy) / ul, off: Math.abs(x * uy - y * ux) / ul }; };
  const boreholes: Section["boreholes"] = [];
  const bb = [Math.min(a[0], b[0]) - 0.2, Math.min(a[1], b[1]) - 0.2, Math.max(a[0], b[0]) + 0.2, Math.max(a[1], b[1]) + 0.2];
  for (const bs of BASINS) for (const w of bs.boreholes) {
    if (w.lon < bb[0] || w.lon > bb[2] || w.lat < bb[1] || w.lat > bb[3]) continue;
    const p = proj(w.lon, w.lat); if (p.off > 10 || p.along < 0 || p.along > L) continue;
    boreholes.push({ name: w.name ?? "Unnamed", d: p.along, off: p.off, td: w.td, year: w.year, key: w.key });
  }
  boreholes.sort((x, y) => x.d - y.d);
  const faults: { d: number }[] = [];
  const cross = (p1: LonLat, p2: LonLat) => {
    const d1 = (b[0] - a[0]) * (p1[1] - a[1]) - (b[1] - a[1]) * (p1[0] - a[0]); const d2 = (b[0] - a[0]) * (p2[1] - a[1]) - (b[1] - a[1]) * (p2[0] - a[0]);
    const d3 = (p2[0] - p1[0]) * (a[1] - p1[1]) - (p2[1] - p1[1]) * (a[0] - p1[0]); const d4 = (p2[0] - p1[0]) * (b[1] - p1[1]) - (p2[1] - p1[1]) * (b[0] - p1[0]);
    if (d1 * d2 < 0 && d3 * d4 < 0) { const t = d3 / (d3 - d4); faults.push({ d: L * t }); }
  };
  for (const bs of BASINS) for (const f of bs.faults) for (let i = 1; i < f.length; i++) {
    const p1 = f[i - 1], p2 = f[i];
    if (Math.max(p1[0], p2[0]) < bb[0] || Math.min(p1[0], p2[0]) > bb[2] || Math.max(p1[1], p2[1]) < bb[1] || Math.min(p1[1], p2[1]) > bb[3]) continue;
    cross(p1, p2);
  }
  faults.sort((x, y) => x.d - y.d);
  const basins: Section["basins"] = [];
  for (const p of pts) {
    const last = basins[basins.length - 1];
    if (p.basin && last && last.id === p.basin && p.d - last.d1 < (L / n) * 1.5) last.d1 = p.d;
    else if (p.basin) basins.push({ id: p.basin, name: BASINS.find((x) => x.id === p.basin)!.name, d0: p.d, d1: p.d });
  }
  const features: Section["features"] = [];
  for (const bs of BASINS) for (const f of bs.features) { const p = proj(f.lon, f.lat); if (p.off <= 15 && p.along >= 0 && p.along <= L) features.push({ name: f.n, d: p.along, off: p.off }); }
  features.sort((x, y) => x.d - y.d);
  return { a, b, lengthKm: L, pts, maxDepth, boreholes, faults, basins, features, ms: Math.round(performance.now() - t0) };
}
