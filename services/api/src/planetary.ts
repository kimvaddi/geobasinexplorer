// Microsoft Planetary Computer Pro overlays for the cloud map's Esri option. While an Esri
// base map is chosen, a person can lay one overlay over the Cooper Basin: Sentinel-2 imagery from 2025, or elevation or
// hillshade from the Copernicus DEM. The Azure Maps option never shows them. The data sit in the GeoBasin GeoCatalog
// (infra/bicep/geo.bicep), copied from the open Planetary Computer and clipped to the basin (infra/scripts/planetary_load.py). The
// browser asks this app for tiles and the app relays them from the catalog's mosaic tiler with its own managed identity,
// which holds only GeoCatalog Reader on that catalog, so no token reaches the browser, only signed-in users can draw on
// the catalog, and the usage caps apply. Planetary Computer Pro accepts only Microsoft Entra tokens (Learn:
// build-web-application, manage-access). Tile paths follow the Planetary Computer Pro REST reference for api-version
// 2026-04-15, the render options are TiTiler query parameters (Learn: render-configuration), and a mosaic answers 424 or
// 404 outside its data ("expected, handle gracefully", Learn: build-web-application), which becomes a transparent tile
// here, unless the catalog reports a rendering failure of its own. Copernicus data must carry the licensor's notice
// wherever it is shown (DATA_SOURCES.md), so each layer's credits go to the map with it.
import { AzureCliCredential, ManagedIdentityCredential, type AccessToken, type TokenCredential } from "@azure/identity";

export class PlanetaryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export type PlanetaryLayerId = "imagery" | "elevation" | "hillshade";
export type Bounds = [number, number, number, number];
interface Legend { title: string; min: string; max: string; colors: string[] }
/* coverage: where the layer has data everywhere. A tile wholly inside it is sent as JPEG, about a sixth the size of PNG;
   any other tile is PNG, so the map shows through where there's no data. The catalog's tiler can't write WebP (it
   answered 424 "Could not encode ... using WEBP driver" on 4 Nov 2026). */
interface LayerDef { label: string; collection: string; options: string; coverage: Bounds; minZoom: number; maxZoom: number; credits: string; legend?: Legend }

export const API_VERSION = "2026-04-15";
// The Cooper Basin outline's extent (app/src/data/basins-pack.json): the catalog holds data only here.
export const COOPER_BOUNDS: Bounds = [139.37, -29.419, 143.965, -24.523];
// The 30 one-degree Copernicus DEM tiles copied cover this block whole.
const DEM_BLOCK: Bounds = [139, -30, 144, -24];
export const COLLECTIONS = { dem: "gbx-cop-dem-glo-30", s2: "gbx-sentinel-2-l2a" } as const;
// The licensors' required notices, word for word (Copernicus WorldDEM-30 licence, articles 6(b) and 6(c); Legal notice on
// the use of Copernicus Sentinel Data and Service Information).
const DEM_CREDIT = "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.";
const S2_CREDIT = "Contains modified Copernicus Sentinel data 2025";
const HILLSHADE = `algorithm=hillshade&buffer=3&algorithm_params=${encodeURIComponent(JSON.stringify({ azimuth: 315, angle_altitude: 45 }))}`;
// The catalog's own per-tile item limit is far lower than one basin needs: with it, a tile over the basin drew 75 to 80%
// of the data, and with items_limit=100 all of it (4 Nov 2026). time_limit keeps a slow tile whole rather than partial.
const LIMITS = "items_limit=100&time_limit=10";

export const PC_LAYERS: Record<PlanetaryLayerId, LayerDef> = {
  // "highest" keeps the brighter pixel where scenes overlap, which hides the dark compression fringe at each scene's edge
  // that nodata=0 doesn't catch. Imagery starts a zoom later than the DEM, since a zoom 6 tile took 3.7 s to draw.
  imagery: { label: "Sentinel-2 imagery, 2025", collection: COLLECTIONS.s2, options: `assets=visual&asset_bidx=visual|1,2,3&nodata=0&pixel_selection=highest&${LIMITS}`, coverage: COOPER_BOUNDS, minZoom: 7, maxZoom: 13, credits: S2_CREDIT },
  // Elevations over the basin run from -5 to 543 m, and 98% of the ground lies below about 300 m.
  elevation: {
    label: "Elevation, Copernicus DEM", collection: COLLECTIONS.dem, options: `assets=data&colormap_name=schwarzwald&rescale=0,300&${LIMITS}`, coverage: DEM_BLOCK, minZoom: 6, maxZoom: 12, credits: DEM_CREDIT,
    legend: { title: "Elevation, Copernicus DEM", min: "0 m", max: "300 m and above", colors: ["#adeed4", "#dcf9b1", "#6ec14a", "#2e853d", "#c9af1d", "#bf4a02", "#770f02", "#6c290a", "#896045", "#b1b1b1", "#e4e2e4"] },
  },
  hillshade: { label: "Hillshade, Copernicus DEM", collection: COLLECTIONS.dem, options: `assets=data&colormap_name=gray&${HILLSHADE}&${LIMITS}`, coverage: DEM_BLOCK, minZoom: 6, maxZoom: 12, credits: DEM_CREDIT },
};
const LAYER_IDS = Object.keys(PC_LAYERS) as PlanetaryLayerId[];

export interface PlanetaryLayer { id: PlanetaryLayerId; label: string; size: 512; minZoom: number; maxZoom: number; bounds: Bounds; credits: string; legend?: Legend }
export interface PlanetaryStatus { enabled: boolean; reason?: string; layers: PlanetaryLayer[] }
export interface PlanetaryTile { type: string; body: Buffer; cacheControl: string }
/* What the catalog holds for an outline drawn on the map: ground height from the Copernicus DEM and the Sentinel-2 scenes
   that cover it, with the notices their licensors require wherever the data are shown. */
export interface PlanetaryArea {
  covered: boolean;
  elevation: { min: number; max: number; mean: number; samples: number; tiles: number } | null;
  elevationNote?: string;
  scenes: { id: string; date: string; cloud: number | null; tile: string | null }[];
  credits: { elevation: string; imagery: string };
  ms: number; method: string;
}

export interface PlanetaryDeps {
  /* The catalog's address without a trailing slash; empty turns the overlays off. */
  catalog: () => string;
  /* The registered mosaic (search ID) of each collection. */
  searches: () => Readonly<Record<string, string>>;
  token: () => Promise<string>;
  fetch: typeof fetch;
  /* Books n tiles for this user against the caps, or throws. */
  book: (user: string, n: number) => Promise<void>;
  /* Books one area summary for this user against its caps, or throws. */
  bookArea?: (user: string) => Promise<void>;
  timeoutMs: number;
  warn?: (message: string) => void;
  cacheBytes?: number;
}

/* collection=searchid pairs, as in the PC_SEARCHES setting. Anything malformed is refused, so a typo can't point a layer
   at another mosaic. */
export function parseSearches(value = ""): Record<string, string> {
  const known = new Set<string>(Object.values(COLLECTIONS));
  const out: Record<string, string> = {};
  for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9-]+)=([A-Za-z0-9]{8,64})$/.exec(part);
    if (!m || !known.has(m[1]) || out[m[1]]) throw new Error(`PC_SEARCHES has an unusable entry: ${part.slice(0, 80)}`);
    out[m[1]] = m[2];
  }
  return out;
}

const COORD = /^\d{1,8}$/;
const MAX_TILE_BYTES = 4 * 1024 * 1024;
// The data never change once loaded, so browsers may keep a tile for a few hours, privately.
const KEEP = "private, max-age=21600";
// 1 by 1 transparent PNG: what the map draws where the mosaic has no data.
export const EMPTY_TILE: PlanetaryTile = { type: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=", "base64"), cacheControl: KEEP };

/* Web Mercator tile z/x/y's extent as [west, south, east, north]. */
function tileBounds(z: number, x: number, y: number): Bounds {
  const k = 2 ** z, lon = (i: number) => (i / k) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / k))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
/* Whether Web Mercator tile z/x/y overlaps the bounds. */
export function tileTouches(z: number, x: number, y: number, [w, s, e, n]: Bounds): boolean {
  const t = tileBounds(z, x, y);
  return t[0] < e && t[2] > w && t[1] < n && t[3] > s;
}
/* Whether tile z/x/y lies wholly inside the bounds. */
export function tileWithin(z: number, x: number, y: number, [w, s, e, n]: Bounds): boolean {
  const t = tileBounds(z, x, y);
  return t[0] >= w && t[2] <= e && t[1] >= s && t[3] <= n;
}

/* Most recently used tiles up to a byte budget, shared by everyone on this replica: the overlays cover one basin, so the
   same tiles come back often, and a tile served from here costs the catalog nothing. */
function tileCache(maxBytes: number) {
  const m = new Map<string, PlanetaryTile>();
  let bytes = 0;
  return {
    get(k: string) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
    set(k: string, v: PlanetaryTile) {
      if (v.body.length > maxBytes) return;
      const old = m.get(k);
      if (old) { bytes -= old.body.length; m.delete(k); }
      m.set(k, v); bytes += v.body.length;
      for (const [key, t] of m) { if (bytes <= maxBytes) break; m.delete(key); bytes -= t.body.length; }
    },
  };
}

export function planetaryRelay(d: PlanetaryDeps) {
  const cache = tileCache(d.cacheBytes ?? 48 * 1024 * 1024);
  const areas = areaCache();

  function status(): PlanetaryStatus {
    if (!d.catalog()) return { enabled: false, reason: "Planetary Computer isn't connected to this deployment yet.", layers: [] };
    const searches = d.searches();
    const layers = LAYER_IDS.filter((id) => searches[PC_LAYERS[id].collection]).map((id): PlanetaryLayer => {
      const l = PC_LAYERS[id];
      return { id, label: l.label, size: 512, minZoom: l.minZoom, maxZoom: l.maxZoom, bounds: COOPER_BOUNDS, credits: l.credits, ...(l.legend ? { legend: l.legend } : {}) };
    });
    return layers.length ? { enabled: true, layers } : { enabled: false, reason: "The Planetary Computer overlays aren't loaded yet.", layers: [] };
  }

  async function tile(p: { layer: string; z: string; x: string; y: string }, user: string): Promise<PlanetaryTile> {
    const catalog = d.catalog();
    if (!catalog) throw new PlanetaryError(404, "Planetary Computer overlays aren't connected to this deployment.");
    const def = Object.hasOwn(PC_LAYERS, p.layer) ? PC_LAYERS[p.layer as PlanetaryLayerId] : null;
    if (!def) throw new PlanetaryError(404, "No such overlay.");
    const search = d.searches()[def.collection];
    if (!search) throw new PlanetaryError(404, "That overlay isn't loaded yet.");
    if (![p.z, p.x, p.y].every((v) => COORD.test(v))) throw new PlanetaryError(400, "Tile coordinates must be whole numbers.");
    const [z, x, y] = [Number(p.z), Number(p.x), Number(p.y)];
    if (z < def.minZoom || z > def.maxZoom || x >= 2 ** z || y >= 2 ** z) throw new PlanetaryError(400, "That tile is outside the overlay's zoom range or the map.");
    // Nothing is held outside the basin, so those tiles are answered here, unbooked.
    if (!tileTouches(z, x, y, COOPER_BOUNDS)) return EMPTY_TILE;
    const key = `${p.layer}/${z}/${x}/${y}`;
    const hit = cache.get(key);
    if (hit) return hit;
    await d.book(user, 1);
    let token: string;
    try { token = await d.token(); } catch (e) {
      d.warn?.(`Planetary Computer token unavailable: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}`);
      throw new PlanetaryError(503, "Planetary Computer couldn't be signed in to just now.");
    }
    const format = tileWithin(z, x, y, def.coverage) ? "jpeg" : "png";
    const url = `${catalog}/data/mosaic/searches/${search}/tiles/WebMercatorQuad/${z}/${x}/${y}@2x.${format}?api-version=${API_VERSION}&${def.options}`;
    let r: Response;
    try {
      r = await d.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(d.timeoutMs) });
    } catch {
      throw new PlanetaryError(504, "Planetary Computer didn't answer in time.");
    }
    // No data here: the mosaic answers 404 "No assets found for tile", and Learn adds 424 for a tile outside the data. The
    // catalog also uses 424 for its own rendering failures (code ServerError), which must not pass for an empty tile.
    const detail = r.ok ? "" : (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const serverError = r.status === 424 && /"code"\s*:\s*"ServerError"/.test(detail);
    if (r.status === 404 || r.status === 204 || (r.status === 424 && !serverError)) { cache.set(key, EMPTY_TILE); return EMPTY_TILE; }
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(png|jpeg)$/.test(type)) {
      d.warn?.(`Planetary Computer tile refused for ${p.layer}: HTTP ${r.status} ${detail || type}`);
      throw new PlanetaryError(r.status === 429 ? 503 : 502, "Planetary Computer couldn't supply that tile.");
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_TILE_BYTES) throw new PlanetaryError(502, "Planetary Computer sent an unexpectedly large tile.");
    const t = { type, body, cacheControl: KEEP };
    cache.set(key, t);
    return t;
  }

  /* A drawn outline's summary: one STAC search per collection for the items it touches (Learn: Stac Search - Create), then
     the Copernicus DEM's statistics inside the outline from each DEM tile it touches (Learn: Mosaic Items Geo Json
     Statistics - Get), combined by pixel count. Each tile's statistics are read at most 512 pixels across, about 150 m
     for an outline a degree wide. The outline arrives checked and counterclockwise (geo.ts, parseArea). An outline
     clear of the catalog's data is answered here, unbooked, and a repeated one comes from this replica's memory. */
  async function area(ring: [number, number][], user: string): Promise<PlanetaryArea> {
    const catalog = d.catalog();
    if (!catalog) throw new PlanetaryError(404, "Planetary Computer isn't connected to this deployment.");
    const searches = d.searches();
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const bb: Bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const meets = (b: Bounds) => bb[0] <= b[2] && bb[2] >= b[0] && bb[1] <= b[3] && bb[3] >= b[1];
    const demOn = !!searches[COLLECTIONS.dem] && meets(DEM_BLOCK), s2On = !!searches[COLLECTIONS.s2] && meets(COOPER_BOUNDS);
    const credits = { elevation: DEM_CREDIT, imagery: S2_CREDIT };
    if (!demOn && !s2On) return { covered: false, elevation: null, scenes: [], credits, ms: 0, method: AREA_METHOD };
    const key = JSON.stringify(ring);
    const hit = areas.get(key);
    if (hit) return hit;
    const t0 = Date.now();
    await d.bookArea?.(user);
    let token: string;
    try { token = await d.token(); } catch (e) {
      d.warn?.(`Planetary Computer token unavailable: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}`);
      throw new PlanetaryError(503, "Planetary Computer couldn't be signed in to just now.");
    }
    const geometry = { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    const post = async (path: string, body: unknown): Promise<{ status: number; json: unknown; detail: string }> => {
      let r: Response;
      try {
        r = await d.fetch(`${catalog}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(d.timeoutMs) });
      } catch { throw new PlanetaryError(504, "Planetary Computer didn't answer in time."); }
      if (!r.ok) {
        const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
        d.warn?.(`Planetary Computer refused ${path.split("?")[0]}: HTTP ${r.status} ${detail.slice(0, 200)}`);
        return { status: r.status, json: null, detail };
      }
      return { status: r.status, json: await r.json().catch(() => null), detail: "" };
    };
    const search = async (collection: string, include: string[]) => {
      const r = await post(`/stac/search?api-version=${API_VERSION}`, { collections: [collection], intersects: geometry, limit: 100, fields: { include, exclude: ["assets", "links", "geometry"] } });
      const features = (r.json as { features?: unknown } | null)?.features;
      if (r.status !== 200 || !Array.isArray(features)) throw new PlanetaryError(r.status === 429 ? 503 : 502, "Planetary Computer couldn't search its catalog for this area.");
      return features as { id?: unknown; properties?: Record<string, unknown> }[];
    };
    const [dem, s2] = await Promise.all([
      demOn ? search(COLLECTIONS.dem, ["id"]) : [],
      s2On ? search(COLLECTIONS.s2, ["id", "properties.datetime", "properties.eo:cloud_cover", "properties.s2:mgrs_tile"]) : [],
    ]);
    const tiles = dem.map((f) => f.id).filter((id): id is string => typeof id === "string" && ITEM_ID.test(id));
    let elevation: PlanetaryArea["elevation"] = null, elevationNote: string | undefined, skipped = 0;
    if (tiles.length > MAX_DEM_TILES) elevationNote = `This area touches ${tiles.length} one-degree Copernicus DEM tiles. Ground height is summarised for areas that touch ${MAX_DEM_TILES} or fewer, so draw a smaller one for it.`;
    else if (tiles.length) {
      const stats: BandStats[] = [];
      for (let i = 0; i < tiles.length; i += 4) {
        stats.push(...await Promise.all(tiles.slice(i, i + 4).map(async (id) => {
          const r = await post(`/data/mosaic/collections/${COLLECTIONS.dem}/items/${encodeURIComponent(id)}/statistics?api-version=${API_VERSION}&assets=data&max_size=512`, { type: "Feature", geometry, properties: {} });
          // A tile that the outline only grazes can hold no pixel inside it, which the tiler reports as no data: 404, or 424
          // without the catalog's own rendering-failure code (ServerError), which is a failure here, as it is for tiles.
          if (r.status === 404 || (r.status === 424 && !/"code"\s*:\s*"ServerError"/.test(r.detail))) { skipped++; return null; }
          const band = Object.values((r.json as { properties?: { statistics?: Record<string, BandStats> } } | null)?.properties?.statistics ?? {})[0];
          if (r.status !== 200 || !band) throw new PlanetaryError(r.status === 429 ? 503 : 502, "Planetary Computer couldn't measure the ground height in this area.");
          return band;
        })).then((b) => b.filter((x): x is BandStats => !!x)));
      }
      let n = 0, sum = 0, min = Infinity, max = -Infinity, used = 0;
      for (const s of stats) {
        const v = Number(s.valid_pixels ?? s.count ?? 0);
        if (!(v > 0) || !Number.isFinite(s.mean) || !Number.isFinite(s.min) || !Number.isFinite(s.max)) continue;
        n += v; sum += s.mean * v; min = Math.min(min, s.min); max = Math.max(max, s.max); used++;
      }
      if (n > 0) elevation = { min, max, mean: sum / n, samples: n, tiles: used };
    }
    const scenes = s2.map((f) => {
      const p = f.properties ?? {};
      const cloud = typeof p["eo:cloud_cover"] === "number" ? p["eo:cloud_cover"] as number : null;
      return { id: String(f.id ?? ""), date: typeof p.datetime === "string" ? p.datetime.slice(0, 10) : "", cloud, tile: typeof p["s2:mgrs_tile"] === "string" ? p["s2:mgrs_tile"] as string : null };
    }).filter((s) => s.id && /^\d{4}-\d{2}-\d{2}$/.test(s.date)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const out: PlanetaryArea = { covered: true, elevation, ...(elevationNote ? { elevationNote } : {}), scenes, credits, ms: Date.now() - t0, method: AREA_METHOD };
    // A tile skipped as holding no data might have been a passing refusal, so only a complete answer is remembered.
    if (!skipped) areas.set(key, out);
    return out;
  }

  return { status, tile, area };
}
interface BandStats { min: number; max: number; mean: number; count?: number; valid_pixels?: number }
const MAX_DEM_TILES = 12;
const ITEM_ID = /^[A-Za-z0-9._-]{1,200}$/;
const AREA_METHOD = "Microsoft Planetary Computer Pro: a STAC search of each collection for the items the outline touches, and the Copernicus DEM's statistics inside the outline from each DEM tile, read at most 512 pixels across and combined by pixel count";
/* The last hundred area summaries, so a repeated outline costs the catalog nothing. */
function areaCache() {
  const m = new Map<string, PlanetaryArea>();
  return {
    get(k: string) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
    set(k: string, v: PlanetaryArea) { m.delete(k); m.set(k, v); if (m.size > 100) m.delete(m.keys().next().value!); },
  };
}

/* GeoCatalog tokens from the relay's own managed identity, renewed ten minutes before they expire, as the Azure Maps
   token is (maps.ts). A local run uses the operator's Azure CLI sign-in. */
export function catalogToken(clientId: string): () => Promise<string> {
  let cred: TokenCredential | null = null, cached: AccessToken | null = null, pending: Promise<AccessToken> | null = null;
  return async () => {
    if (!cached || cached.expiresOnTimestamp - Date.now() < 10 * 60_000) {
      pending ??= (async () => {
        cred ??= process.env.IDENTITY_ENDPOINT ? new ManagedIdentityCredential({ clientId }) : new AzureCliCredential();
        const t = await cred.getToken("https://geocatalog.spatio.azure.com/.default");
        if (!t) throw new Error("no GeoCatalog token");
        return t;
      })().finally(() => { pending = null; });
      cached = await pending;
    }
    return cached.token;
  };
}
