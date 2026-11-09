// Drawn areas: an outline someone draws on the map, and what the app's own data hold inside it. The
// browser counts the map's layers here, and the cloud service uses the same checks and measures before it searches the
// library or Planetary Computer Pro for the same outline, so both accept and measure an outline alike. Coordinates are
// GDA94 longitude and latitude (EPSG:4283), like every layer. Areas and lengths are on a sphere of mean radius
// 6,371.0088 km, which is within about half a percent of the GRS80 ellipsoid here, and the outline's sides are straight
// in longitude and latitude, as the map draws them. The GDAL/PROJ spatial service doesn't measure areas yet.
import { BASINS, basinAt, depthAt, haversineKm, inRings, type Borehole, type LonLat } from "@/lib/basins";
import { PACK, WELLS } from "@/lib/pack";

export const AREA_MAX_POINTS = 60;
export const AREA_MAX_KM2 = 500_000;
export type Bounds = [number, number, number, number];
const R = 6371.0088;
const RAD = Math.PI / 180;

/* The corners as drawn, without repeated corners or a closing corner that repeats the first. */
export function openRing(pts: readonly LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push([p[0], p[1]]); }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/* A list of [longitude, latitude] corners from a request body, or null when it isn't one. */
export function parseRing(v: unknown): LonLat[] | null {
  if (!Array.isArray(v) || v.length > AREA_MAX_POINTS + 1) return null;
  const out: LonLat[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    out.push([p[0], p[1]]);
  }
  return openRing(out);
}

export const bboxOf = (ring: readonly LonLat[]): Bounds => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [w, s, e, n];
};
export const touches = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const inRing = (lon: number, lat: number, ring: readonly LonLat[]) => inRings(lon, lat, [ring as LonLat[]]);

const turn = (o: LonLat, a: LonLat, b: LonLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const within = (p: LonLat, q: LonLat, r: LonLat) => Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
function meet(p1: LonLat, p2: LonLat, p3: LonLat, p4: LonLat): boolean {
  const d1 = turn(p3, p4, p1), d2 = turn(p3, p4, p2), d3 = turn(p1, p2, p3), d4 = turn(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && within(p3, p1, p4)) || (d2 === 0 && within(p3, p2, p4)) || (d3 === 0 && within(p1, p3, p2)) || (d4 === 0 && within(p1, p4, p2));
}
/* Whether any two sides cross or touch, other than neighbours at their shared corner, or a side doubles straight back
   along the one before it. Search and the catalog both refuse such an outline. */
export function selfIntersects(ring: readonly LonLat[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n], b = ring[i], c = ring[(i + 1) % n];
    if (turn(a, b, c) === 0 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) return true;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (meet(b, c, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/* Area on the sphere (Chamberlain and Duquette, "Some algorithms for polygons on a sphere", 2007). */
export function areaKm2(ring: readonly LonLat[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += (ring[(i + 1) % n][0] - ring[(i + n - 1) % n][0]) * RAD * Math.sin(ring[i][1] * RAD);
  return Math.abs((s * R * R) / 2);
}
export function perimeterKm(ring: readonly LonLat[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; s += haversineKm(a[0], a[1], b[0], b[1]); }
  return s;
}
/* The same corners in counterclockwise order (east as x, north as y), as Azure AI Search requires of a polygon. */
export function counterClockwise(ring: readonly LonLat[]): LonLat[] {
  let s = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; s += x1 * y2 - x2 * y1; }
  return s >= 0 ? ring.map((p): LonLat => [p[0], p[1]]) : ring.map((p): LonLat => [p[0], p[1]]).reverse();
}
/* A GeoJSON polygon of the outline: closed and counterclockwise (RFC 7946). */
export const geoJsonPolygon = (ring: readonly LonLat[]) => {
  const ccw = counterClockwise(ring);
  return { type: "Polygon" as const, coordinates: [[...ccw, ccw[0]]] };
};

/* Why an outline can't be used, in words for the person drawing it, or null when it can. */
export function areaProblem(ring: readonly LonLat[]): string | null {
  if (ring.length < 3) return "An area needs at least three corners.";
  if (ring.length > AREA_MAX_POINTS) return `An area can have at most ${AREA_MAX_POINTS} corners.`;
  if (ring.some(([x, y]) => !(x >= 100 && x <= 170 && y >= -50 && y <= 0))) return "Every corner must lie on the map of the Australian basins.";
  if (selfIntersects(ring)) return "The outline crosses itself. Draw it again without crossing a side.";
  const a = areaKm2(ring);
  if (a < 0.01) return "That area is too small to measure.";
  if (a > AREA_MAX_KM2) return `That area is larger than ${AREA_MAX_KM2.toLocaleString("en-US")} km². Draw a smaller one.`;
  return null;
}

/* Where segment a-b crosses segment c-d, as a fraction of the way from a to b, or null. */
function crossAt(a: LonLat, b: LonLat, c: LonLat, d: LonLat): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
/* Length in km of a line's parts inside the outline: each segment is cut where it crosses a side, and the pieces whose
   middles lie inside are measured. */
export function lengthInsideKm(line: readonly LonLat[], ring: readonly LonLat[], bb: Bounds = bboxOf(ring)): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    if (Math.max(a[0], b[0]) < bb[0] || Math.min(a[0], b[0]) > bb[2] || Math.max(a[1], b[1]) < bb[1] || Math.min(a[1], b[1]) > bb[3]) continue;
    const ts = [0, 1];
    for (let j = 0; j < ring.length; j++) { const t = crossAt(a, b, ring[j], ring[(j + 1) % ring.length]); if (t != null) ts.push(t); }
    ts.sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1], t1 = ts[k];
      if (t1 - t0 < 1e-12) continue;
      const at = (t: number): LonLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const m = at((t0 + t1) / 2);
      if (!inRing(m[0], m[1], ring)) continue;
      const p = at(t0), q = at(t1);
      km += haversineKm(p[0], p[1], q[0], q[1]);
    }
  }
  return km;
}

/* A regular grid of points over the outline's extent, each weighted by the cosine of its latitude so that equal weight
   means equal ground: which basins the area lies in, and the GA depth to basin floor across it. */
export interface AreaSample { basins: { id: string; name: string; share: number }[]; outside: number; depth: { min: number; max: number; mean: number } | null }
export function sampleArea(ring: readonly LonLat[], n = 96, bb: Bounds = bboxOf(ring)): AreaSample {
  const by = new Map<string, number>();
  let inside = 0, outside = 0, dmin = Infinity, dmax = -Infinity, dsum = 0, dw = 0;
  const dx = (bb[2] - bb[0]) / n, dy = (bb[3] - bb[1]) / n;
  for (let r = 0; r < n; r++) {
    const lat = bb[1] + (r + 0.5) * dy, w = Math.cos(lat * RAD);
    for (let c = 0; c < n; c++) {
      const lon = bb[0] + (c + 0.5) * dx;
      if (!inRing(lon, lat, ring)) continue;
      inside += w;
      const b = basinAt(lon, lat);
      if (!b) { outside += w; continue; }
      by.set(b.id, (by.get(b.id) ?? 0) + w);
      const d = depthAt(b, lon, lat);
      if (d != null) { dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); dsum += d * w; dw += w; }
    }
  }
  if (!inside) return { basins: [], outside: 1, depth: null };
  const basins = [...by].map(([id, w]) => ({ id, name: BASINS.find((b) => b.id === id)?.name ?? id, share: w / inside })).sort((a, b) => b.share - a.share);
  return { basins, outside: outside / inside, depth: dw ? { min: dmin, max: dmax, mean: dsum / dw } : null };
}

/* What the app's own layers hold inside the outline, counted in the browser from the data the map draws. */
export interface AreaBorehole { key: string; name: string; td: number | null; year: number | null; lon: number; lat: number }
export interface AreaFacts {
  ring: LonLat[]; bbox: Bounds; centre: LonLat; areaKm2: number; perimeterKm: number;
  basins: AreaSample["basins"]; outside: number; depth: AreaSample["depth"];
  boreholes: { n: number; named: number; deepest: number | null; years: [number, number] | null; filtered: number | null; keys: string[]; list: AreaBorehole[] };
  wells: { id: string; name: string; year: number | null }[];
  seismic: { lines: number; km: number }; faults: { n: number; km: number };
  stress: { n: number; good: number; azimuth: number | null; regime: string | null };
  features: { name: string; kind: string }[];
  ms: number;
}
/* match: the map's borehole filter, when one is on, so the card can say how many of the boreholes inside it shows. */
export function areaFacts(ring: readonly LonLat[], match?: ((b: Borehole) => boolean) | null): AreaFacts {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const bb = bboxOf(ring);
  const inBox = (lon: number, lat: number) => lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3];
  const inside = (lon: number, lat: number) => inBox(lon, lat) && inRing(lon, lat, ring);

  const holes: Borehole[] = [];
  for (const b of BASINS) for (const w of b.boreholes) if (inside(w.lon, w.lat)) holes.push(w);
  const years = holes.map((w) => w.year).filter((y): y is number => y != null);
  const tds = holes.map((w) => w.td).filter((d): d is number => d != null);
  const named = holes.filter((w) => w.name);
  const list = (named.length ? named : holes).slice().sort((a, b) => (b.td ?? -1) - (a.td ?? -1)).slice(0, 6)
    .map((w): AreaBorehole => ({ key: w.key, name: w.name ?? "Unnamed borehole", td: w.td, year: w.year, lon: w.lon, lat: w.lat }));

  let seismicLines = 0, seismicKm = 0;
  for (const lines of Object.values(PACK.seismic2d)) for (const ln of lines) { const k = lengthInsideKm(ln, ring, bb); if (k > 0) { seismicLines++; seismicKm += k; } }
  let faults = 0, faultKm = 0;
  for (const b of BASINS) for (const f of b.faults) { const k = lengthInsideKm(f, ring, bb); if (k > 0) { faults++; faultKm += k; } }

  // SHmax is an axis, not a direction, so its mean is taken on doubled angles. The better records (quality A to C) set it
  // when there are any.
  const recs = BASINS.flatMap((b) => b.stress).filter((s) => inside(s[0], s[1]));
  const good = recs.filter((s) => "ABC".includes(s[3]));
  const use = good.length ? good : recs;
  let cs = 0, sn = 0;
  for (const s of use) { cs += Math.cos(2 * s[2] * RAD); sn += Math.sin(2 * s[2] * RAD); }
  const azimuth = use.length && Math.hypot(cs, sn) > 1e-9 ? (((Math.atan2(sn, cs) / RAD / 2) % 180) + 180) % 180 : null;
  const regimes = new Map<string, number>();
  for (const s of use) if (s[4]) regimes.set(s[4], (regimes.get(s[4]) ?? 0) + 1);
  const regime = [...regimes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const sample = sampleArea(ring, 96, bb);
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return {
    ring: ring.map((p): LonLat => [p[0], p[1]]), bbox: bb, centre: [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length],
    areaKm2: areaKm2(ring), perimeterKm: perimeterKm(ring), basins: sample.basins, outside: sample.outside, depth: sample.depth,
    boreholes: { n: holes.length, named: named.length, deepest: tds.length ? Math.max(...tds) : null, years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      filtered: match ? holes.filter(match).length : null, keys: holes.map((w) => w.key), list },
    wells: WELLS.filter((w) => inside(w.lon, w.lat)).map((w) => ({ id: w.siteId, name: w.name, year: w.spudYear ?? null })),
    seismic: { lines: seismicLines, km: seismicKm }, faults: { n: faults, km: faultKm },
    stress: { n: recs.length, good: good.length, azimuth, regime },
    features: BASINS.flatMap((b) => b.features).filter((f) => inside(f.lon, f.lat)).map((f) => ({ name: f.n, kind: f.t })),
    ms: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0),
  };
}
