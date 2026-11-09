// Geo fields in Azure AI Search. Every passage is stored with the geotags the app shows
// on the map and under answers (app/src/lib/geotag.ts): a point for each place named in its text and for its
// document's well, the basins it belongs to, and whether it is tied to a place at all. Search can then filter by
// place, and every result says where it is or that it isn't tied to one.
// Coordinates are GDA94 (EPSG:4283), stored as given. Search treats points as WGS 84; GDA94 to WGS 84 is a null
// transformation accurate to about 3 m (EPSG:1150), far below the kilometre distances used here.
import { GeographyPoint } from "@azure/search-documents";
import { AREA_MAX_POINTS, areaProblem, counterClockwise, inRing, openRing, parseRing, sampleArea } from "@/lib/area";
import { basinAt, type LonLat } from "@/lib/basins";
import { geotagPassage, wellOf } from "@/lib/geotag";
import { search, type Passage } from "./azure";
import type { User } from "./auth";
import { cfg } from "./config";
import { SpatialError, takeSpatial } from "./maps";
import { CLOUD_LICENCE_FILTER, LICENCE } from "./licence";
import { liveManifest } from "./live/serving-manifest";
import { packagedAllowed, packagedFilter } from "./live/serving-policy";
import type { PublicationManifest } from "./live/contracts";

export type GeoTagKind = "point" | "basin" | "general" | "none";
export interface GeoFields { points: GeographyPoint[]; places: string[]; placeHow: string[]; geoBasins: string[]; geotag: GeoTagKind }

/* "point": at least one place on the map. "basin": tied to a basin as a whole. "general": a glossary or reference list,
   not about a place. "none": no place could be found in it. */
export function geoFields(p: { id: string; doc: string; heading: string; text: string; basin: string | null; well: string | null }): GeoFields {
  const r = geotagPassage({ doc: p.doc, h: p.heading, t: p.text, basin: p.basin ?? undefined, well: p.well ?? wellOf(p.id) });
  const pts = r.tags.filter((t) => t.kind === "point");
  const basins = [...new Set(r.tags.filter((t) => t.kind === "polygon" && t.basin).map((t) => t.basin as string))];
  return {
    points: pts.map((t) => new GeographyPoint({ longitude: t.lon, latitude: t.lat })),
    places: pts.map((t) => t.label), placeHow: pts.map((t) => t.method), geoBasins: basins,
    geotag: pts.length ? "point" : basins.length ? "basin" : r.general ? "general" : "none",
  };
}

/* Passages the caller may see: the public library plus their own uploads. */
export const accessFilter = (user: User) => `(visibility eq 'public' or owner eq '${user.id.replace(/'/g, "''")}') and ${CLOUD_LICENCE_FILTER}`;

export interface Near { lon: number; lat: number; km: number }
export const NEAR_KM = 50;
const MAX_KM = 300;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function parseNear(v: unknown): Near {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  if (!finite(o.lon) || o.lon < 100 || o.lon > 170 || !finite(o.lat) || o.lat < -50 || o.lat > 0) throw new SpatialError(400, "lon and lat must be a point within the Australian basins.");
  const km = o.km ?? NEAR_KM;
  if (!finite(km) || km < 1 || km > MAX_KM) throw new SpatialError(400, `km must be between 1 and ${MAX_KM}.`);
  return { lon: o.lon, lat: o.lat, km };
}
const literal = (n: Near) => `geography'POINT(${n.lon.toFixed(6)} ${n.lat.toFixed(6)})'`;
const within = (n: Near) => `points/any(g: geo.distance(g, ${literal(n)}) le ${n.km})`;

/* The filter for answers limited to a place: passages with a place within the radius, and passages about the
   basin around the point as a whole. */
export function placeFilter(n: Near): { filter: string; basin: { id: string; name: string } | null } {
  const b = basinAt(n.lon, n.lat);
  return { filter: b ? `(${within(n)} or (geotag eq 'basin' and geoBasins/any(x: x eq '${b.id}')))` : within(n), basin: b ? { id: b.id, name: b.name } : null };
}
/* The passages a search may return, for the library search and the live agent's tools alike: everything the caller may
   see, narrowed only when they limit the copilot to a place. No basin narrows a search, whether it is the one selected on
   the map or one named in the question, because evidence about a formation or well often sits in another basin's
   documents (the Hutton Sandstone's porosity is described only in a Cooper Basin well report). */
export const searchScope = (user: User, near: Near | null) => near ? `${accessFilter(user)} and ${placeFilter(near).filter}` : accessFilter(user);
export const placeText = (n: Near, basin: { name: string } | null) =>
  `geotagged within ${n.km} km of ${Math.abs(n.lat).toFixed(4)}°S ${n.lon.toFixed(4)}°E${basin ? `, or tagged to the ${basin.name} as a whole` : ""}`;

const RAD = Math.PI / 180;
/* Great-circle distance on a sphere of mean radius, used only to order and label nearby sources. */
export function greatCircleKm(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/* The SDK may hand back a GeographyPoint or the raw GeoJSON. */
const coords = (g: unknown): [number, number] | null => {
  const o = g as { longitude?: unknown; latitude?: unknown; coordinates?: unknown[] } | null;
  if (o && finite(o.longitude) && finite(o.latitude)) return [o.longitude, o.latitude];
  if (o && Array.isArray(o.coordinates) && finite(o.coordinates[0]) && finite(o.coordinates[1])) return [o.coordinates[0], o.coordinates[1]];
  return null;
};

export interface NearSource { id: string; doc: string; page: number; pages: number[]; passages: number; heading: string; place: string; how: string; lon: number; lat: number; km: number; yours: boolean }
export interface NearResult {
  lon: number; lat: number; km: number; matched: number; sources: NearSource[]; nearest: NearSource | null;
  basin: { id: string; name: string; passages: number } | null; ms: number; method: string;
}

const timed = <T>(p: Promise<T>) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new SpatialError(503, "The library search didn't answer in time.")), cfg.timeoutsMs.spatial))]);
async function query(filter: string, top: number, select: string[]) {
  try { return await timed(search().search("*", { filter, top, select, includeTotalCount: true } as never)) as unknown as { count?: number; results: AsyncIterable<{ document: Passage }> }; }
  catch (e) { throw e instanceof SpatialError ? e : new SpatialError(503, "The library search couldn't complete that request."); }
}

/* Each passage with a place within the radius, at the distance of its place nearest to the point, nearest first. */
async function passagesWithin(n: Near, user: User, manifest: PublicationManifest | null): Promise<{ matched: number; list: NearSource[] }> {
  const res = await query(packagedFilter(`${accessFilter(user)} and ${within(n)}`, manifest), 1000, ["id", "doc", "docId", "source", "well", "text", "visibility", "page", "heading", "owner", "points", "places", "placeHow"]);
  const list: NearSource[] = [];
  for await (const r of res.results) {
    const d = r.document;
    if (LICENCE.isWithheldPassage(d) || !packagedAllowed(d, manifest)) continue;
    let best: NearSource | null = null;
    (d.points ?? []).forEach((g, i) => {
      const c = coords(g);
      if (!c) return;
      const km = greatCircleKm([n.lon, n.lat], c);
      if (!best || km < best.km) best = { id: d.id, doc: d.doc, page: d.page, pages: d.page ? [d.page] : [], passages: 1, heading: d.heading, place: d.places?.[i] ?? "", how: d.placeHow?.[i] ?? "", lon: c[0], lat: c[1], km, yours: d.owner === user.id };
    });
    if (best) list.push(best);
  }
  return { matched: list.length, list: list.sort((a, b) => a.km - b.km) };
}

/* One entry per document, at the distance of its passage nearest to the point, with every page that matched. */
function byDocument(list: NearSource[]): NearSource[] {
  const docs = new Map<string, NearSource>();
  for (const s of list) {
    const k = `${s.yours ? "own" : "public"}|${s.doc}`;
    const cur = docs.get(k);
    if (!cur) { docs.set(k, { ...s, pages: [...s.pages] }); continue; }
    cur.passages++;
    for (const p of s.pages) if (!cur.pages.includes(p)) cur.pages.push(p);
  }
  return [...docs.values()].map((s) => ({ ...s, pages: s.pages.sort((a, b) => a - b) }));
}

/* "Sources near here": the library's documents with passages tagged to places near a point, nearest first, the
   nearest one further out when none is close, and how many passages are about the surrounding basin as a whole. */
export async function sourcesNear(body: unknown, user: User): Promise<NearResult> {
  const n = parseNear(body);
  takeSpatial(user.id);
  const t0 = Date.now();
  const { manifest } = await liveManifest.read();
  const { matched, list } = await passagesWithin(n, user, manifest);
  const sources = byDocument(list).slice(0, 8);
  const nearest = sources.length ? null : byDocument((await passagesWithin({ ...n, km: MAX_KM }, user, manifest)).list)[0] ?? null;
  const b = basinAt(n.lon, n.lat);
  let basin: NearResult["basin"] = null;
  if (b) {
    const res = await query(packagedFilter(`${accessFilter(user)} and geotag eq 'basin' and geoBasins/any(x: x eq '${b.id}')`, manifest), 1000, ["id", "doc", "docId", "source", "well", "text", "visibility"]);
    let passages = 0;
    for await (const r of res.results) if (!LICENCE.isWithheldPassage(r.document) && packagedAllowed(r.document, manifest)) passages++;
    basin = { id: b.id, name: b.name, passages };
  }
  return { lon: n.lon, lat: n.lat, km: n.km, matched, sources, nearest, basin, ms: Date.now() - t0, method: "Azure AI Search geo filter over each passage's geotags; distances are great-circle on a 6,371 km sphere" };
}

/* An outline drawn on the map ("What we know in this area"), checked with the same rules the browser uses (lib/area.ts).
   Corners are kept to six decimals, about 0.1 m, the precision of the search filter below. */
export function parseArea(v: unknown): LonLat[] {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const raw = parseRing(o.ring);
  if (!raw) throw new SpatialError(400, `ring must be a list of up to ${AREA_MAX_POINTS} [longitude, latitude] corners.`);
  const ring = openRing(raw.map(([x, y]): LonLat => [Number(x.toFixed(6)), Number(y.toFixed(6))]));
  const problem = areaProblem(ring);
  if (problem) throw new SpatialError(400, problem);
  return ring;
}
/* Azure AI Search takes a polygon as a closed ring of points in counterclockwise order; listed clockwise, it would mean
   everything outside the outline (Learn: search-query-odata-geo-spatial-functions). */
export function polygonLiteral(ring: readonly LonLat[]): string {
  const c = counterClockwise(ring);
  return `geography'POLYGON((${[...c, c[0]].map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(", ")}))'`;
}
export const areaFilter = (ring: readonly LonLat[]) => `points/any(g: geo.intersects(g, ${polygonLiteral(ring)}))`;

export interface AreaSource { id: string; doc: string; page: number; pages: number[]; passages: number; heading: string; place: string; how: string; lon: number; lat: number; yours: boolean }
export interface AreaSources {
  matched: number; documents: number; sources: AreaSource[];
  basins: { id: string; name: string; passages: number }[]; ms: number; method: string;
}

/* "Sources in this area": the library's documents with passages tagged to places inside the outline, the documents with
   the most such passages first, and how many passages are about each basin the area lies in as a whole. */
export async function sourcesInArea(body: unknown, user: User): Promise<AreaSources> {
  const ring = parseArea(body);
  takeSpatial(user.id);
  const t0 = Date.now();
  const { manifest } = await liveManifest.read();
  const res = await query(packagedFilter(`${accessFilter(user)} and ${areaFilter(ring)}`, manifest), 1000, ["id", "doc", "docId", "source", "well", "text", "visibility", "page", "heading", "owner", "points", "places", "placeHow"]);
  const list: AreaSource[] = [];
  for await (const r of res.results) {
    const d = r.document;
    if (LICENCE.isWithheldPassage(d) || !packagedAllowed(d, manifest)) continue;
    // Search matched at least one of the passage's places; the first inside the outline names it.
    const i = (d.points ?? []).findIndex((g) => { const c = coords(g); return !!c && inRing(c[0], c[1], ring); });
    const c = i >= 0 ? coords(d.points![i]) : null;
    if (!c) continue;
    list.push({ id: d.id, doc: d.doc, page: d.page, pages: d.page ? [d.page] : [], passages: 1, heading: d.heading, place: d.places?.[i] ?? "", how: d.placeHow?.[i] ?? "", lon: c[0], lat: c[1], yours: d.owner === user.id });
  }
  const docs = new Map<string, AreaSource>();
  for (const s of list) {
    const k = `${s.yours ? "own" : "public"}|${s.doc}`;
    const cur = docs.get(k);
    if (!cur) { docs.set(k, { ...s, pages: [...s.pages] }); continue; }
    cur.passages++;
    for (const p of s.pages) if (!cur.pages.includes(p)) cur.pages.push(p);
  }
  const sources = [...docs.values()].map((s) => ({ ...s, pages: s.pages.sort((a, b) => a - b) })).sort((a, b) => b.passages - a.passages || a.doc.localeCompare(b.doc));
  const basins = await Promise.all(sampleArea(ring, 40).basins.map(async (b) => {
    const r = await query(packagedFilter(`${accessFilter(user)} and geotag eq 'basin' and geoBasins/any(x: x eq '${b.id}')`, manifest), 1000, ["id", "doc", "docId", "source", "well", "text", "visibility"]);
    let passages = 0;
    for await (const x of r.results) if (!LICENCE.isWithheldPassage(x.document) && packagedAllowed(x.document, manifest)) passages++;
    return { id: b.id, name: b.name, passages };
  }));
  return { matched: list.length, documents: sources.length, sources: sources.slice(0, 10), basins, ms: Date.now() - t0, method: "Azure AI Search geo.intersects filter over each passage's geotags, with the drawn outline as the polygon" };
}
