import packRaw from "@/data/basins-pack.json?raw";

/* Basin data model: four Geoscience Australia basin packages (Cooper, Adavale,
   Galilee, North Bowen), the World Stress Map 2025 records and a Natural Earth
   basemap, decoded once at load. Depths are metres below sea level (positive down). */

export type LonLat = [number, number];
export type FeatureStats = [number, number, number, number, number, string, number];

export interface Feature { n: string; t: string; k: string; lon: number; lat: number; fst: FeatureStats | null; approx: boolean; zone: string | null }
export interface Zone { n: string; c: LonLat; r: number; area: number; max: number; mean: number; p90: number; bh: number; src: string }
export interface Unit {
  n: string; rank: string; parent: string; age: string; top: number | null; base: number | null;
  lith: string; env: string; pet: string | null; unc: string | null; hydro: string | null; play: string | null; prov: string; ccs?: boolean;
}
export interface Passage { id: string; doc: string; page: number; h: string; t: string }
export interface Play { n: string; top: number | null; base: number | null; interval: string; stage: string }
export interface StressSum {
  n_in: number; n_ABC_in: number; n_buffer: number; n_ABC_buffer: number; mean_azi_ABC: number | null; circ_std: number | null;
  dominant_regime: string | null; mean_azi_ABC_buffer: number | null; nearest_km: number | null; nearest_km_if_none: number | null;
}
export type StressRec = [number, number, number, string, string, number, string];

interface RawBasin {
  id: string; name: string; short: string; state: string; age: string;
  catalogue: { title: string; doi: string; year: number; licence: string; ecat: number };
  bbox: [number, number, number, number]; center: LonLat; labelAt: LonLat;
  outline: LonLat[][]; faults: LonLat[][]; folds: { k: string; n: string; p: LonLat[] }[];
  features: Feature[]; zones: Zone[];
  depth: { w: number; h: number; x0: number; y0: number; dx: number; dy: number; min: number; max: number; title: string; b64: string };
  bh: { n: number; bb: [number, number, number, number]; b64: string; names: [number, string, string, string][] };
  units: Unit[]; plays: Play[]; passages: Passage[]; table1: { f: string; v: string }[];
  stats: Record<string, number | null>; stress: StressRec[]; stressSum: StressSum;
}
interface RawPack {
  basins: RawBasin[]; types: string[];
  basemap: { relief: { src: string; bbox: [number, number, number, number] }; coast: LonLat[][]; states: LonLat[][]; stateLabels: { name: string; abbr: string; lon: number; lat: number }[] };
  meta: { built: string; sources: { id: string; title: string; publisher: string; licence: string; credit: string; doi: string }[] };
}

export interface Borehole {
  key: string; basin: string; lon: number; lat: number; td: number | null; type: string; year: number | null;
  inside: boolean; major: boolean; name: string | null; operator: string; result: string;
}
export interface Basin extends Omit<RawBasin, "bh" | "depth"> {
  depth: RawBasin["depth"] & { grid: Int16Array };
  boreholes: Borehole[];
  passagesWithBasin: (Passage & { basin: string })[];
}

const NODATA = -32768;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeBasin(r: RawBasin, types: string[]): Basin {
  const db = b64ToBytes(r.depth.b64);
  const grid = new Int16Array(db.buffer, db.byteOffset, Math.floor(db.byteLength / 2));
  const hb = b64ToBytes(r.bh.b64);
  const u = new Uint16Array(hb.buffer, hb.byteOffset, Math.floor(hb.byteLength / 2));
  const [bx0, by0, bx1, by1] = r.bh.bb;
  const sx = (bx1 - bx0) / 65535, sy = (by1 - by0) / 65535;
  const named = new Map(r.bh.names.map((n) => [n[0], n]));
  const boreholes: Borehole[] = [];
  for (let i = 0; i < r.bh.n; i++) {
    const f = u[i * 4 + 3];
    const yr = f >> 8;
    const nm = named.get(i);
    boreholes.push({
      key: `${r.id}:${i}`, basin: r.id,
      lon: bx0 + u[i * 4] * sx, lat: by0 + u[i * 4 + 1] * sy,
      td: u[i * 4 + 2] > 0 ? u[i * 4 + 2] : null,
      type: types[f & 63] ?? "UNKNOWN", year: yr > 0 ? 1850 + yr : null,
      inside: (f & 64) !== 0, major: (f & 128) !== 0,
      name: nm ? nm[1] : null, operator: nm ? nm[2] : "", result: nm ? nm[3] : "",
    });
  }
  const { bh: _bh, depth, ...rest } = r;
  void _bh;
  return {
    ...rest,
    depth: { ...depth, grid },
    boreholes,
    passagesWithBasin: r.passages.map((p) => ({ ...p, basin: r.id })),
  };
}

const RAW = JSON.parse(packRaw) as RawPack;
export const BASINS: Basin[] = RAW.basins.map((b) => decodeBasin(b, RAW.types));
export const BASEMAP = RAW.basemap;
export const SOURCES = RAW.meta.sources;
export const basinById = (id: string | null | undefined) => BASINS.find((b) => b.id === id) ?? null;

/* ---------- geometry ---------- */
const RAD = Math.PI / 180;
export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function inRings(lon: number, lat: number, rings: LonLat[][]) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
export function basinAt(lon: number, lat: number): Basin | null {
  for (const b of BASINS) {
    const [x0, y0, x1, y1] = b.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (inRings(lon, lat, b.outline)) return b;
  }
  return null;
}
/** Bilinear depth (m, positive down) from a basin's GA depth-to-base grid; null outside data. */
export function depthAt(b: Basin, lon: number, lat: number): number | null {
  const g = b.depth;
  const fx = (lon - g.x0) / g.dx - 0.5, fy = (lat - g.y0) / g.dy - 0.5;
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  let s = 0, ws = 0;
  for (let k = 0; k < 4; k++) {
    const c = c0 + (k & 1), r = r0 + (k >> 1);
    if (c < 0 || r < 0 || c >= g.w || r >= g.h) continue;
    const v = g.grid[r * g.w + c];
    if (v === NODATA) continue;
    const w = (1 - Math.abs(fx - c)) * (1 - Math.abs(fy - r));
    s += w * v; ws += w;
  }
  return ws > 0.25 ? s / ws : null;
}
export const isNoData = (v: number) => v === NODATA;

/* ---------- presentation helpers ---------- */
export const fmt = (n: number | null | undefined, digits = 0) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-AU", { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const round10 = (n: number) => Math.round(n / 10) * 10;
export function depthLabel(m: number | null) {
  if (m == null) return "—";
  if (m < 0) return `≈ ${fmt(round10(-m))} m above sea level`;
  return `${fmt(round10(m))} m`;
}
export function azimuthLabel(a: number | null | undefined) {
  return a == null ? "—" : `N${Math.round(((a % 180) + 180) % 180)}°E`;
}
export const REGIME: Record<string, string> = { NF: "normal faulting", SS: "strike-slip", TF: "thrust faulting", NS: "normal to strike-slip", TS: "thrust to strike-slip", U: "regime not determined" };
export function regimeLabel(r: string | null | undefined) { return r ? REGIME[r] ?? r : "—"; }

/** Published GA Table 1 value for a field (matched loosely), if the package reports one. */
export function tableValue(b: Basin, pattern: RegExp): string | null {
  const row = b.table1.find((t) => pattern.test(t.f));
  return row ? row.v : null;
}
export function unitRoles(u: Unit): string[] {
  const pet = (u.pet ?? "").toLowerCase().replace(/\(seal above\)/g, "");
  const out: string[] = [];
  if (/reservoir/.test(pet)) out.push("reservoir");
  if (/\bseal\b/.test(pet)) out.push("seal");
  if (/source/.test(pet)) out.push("source");
  return out;
}
export function ownUnits(b: Basin): Unit[] {
  const own = b.units.filter((u) => u.prov === "cooper-basin" || u.prov === b.name);
  return (own.length ? own : b.units).slice().sort((a, z) => (a.top ?? 0) - (z.top ?? 0));
}
/* depth colour ramp (square-root scale, 0–10 km) shared by the map and its legend */
const RAMP: [number, [number, number, number]][] = [[0, [207, 237, 253]], [0.3, [161, 221, 252]], [0.65, [59, 47, 143]], [1, [18, 10, 46]]];
export function ramp(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, a] = RAMP[i - 1], [t1, b] = RAMP[i];
      const k = (t - t0) / (t1 - t0);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return RAMP[RAMP.length - 1][1];
}
export const DEPTH_STOPS = RAMP.map(([t, c]) => ({ t, color: `rgb(${c.join(",")})` }));
export const depthToT = (m: number) => Math.sqrt(Math.max(0, m) / 10000);
export const DOI_URL = (doi: string) => `https://doi.org/${doi}`;
