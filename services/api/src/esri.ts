// Esri base maps for the cloud map, the alternative to the Azure Maps base map that the requirements allow ("Azure Maps or Esri
// ArcGIS"). The browser asks this app for tiles and the app relays them from ArcGIS Location
// Platform, so the Esri key never reaches the browser, only signed-in users can draw on the account, and the usage caps
// apply. Tiles are passed through and never stored here, and browsers may keep them only as long as Esri's own caching
// headers allow (tileCacheControl).
// Tile services: World Imagery and World Hillshade (Dark), 256-pixel map tiles listed in
// https://developers.arcgis.com/rest/basemap-styles/service-data/, and the imagery place labels, 512-pixel tiles from
// https://developers.arcgis.com/rest/static-basemap-tiles/. The static tiles service takes the key in the Authorization
// header, as Esri recommends (https://developers.arcgis.com/documentation/security-and-authentication/reference/http-authorization-headers/).
// The two map tile services on ibasemaps-api answer that header with error 499 "Token Required" (probed 3 Nov 2026), so
// they get the key as the token parameter their documentation shows. Either way the key goes only from this server to
// Esri, never to the browser and never into a log: the relay logs no URLs and scrubs the key from Esri's messages, and
// fetch calls aren't traced (otel.ts instruments the http module, which fetch doesn't use). Esri requires
// "Powered by Esri" and each layer's data credits on the map
// (https://developers.arcgis.com/documentation/esri-and-data-attribution/), so a layer is offered only while its
// credits are known.

export class EsriError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export type EsriLayerId = "imagery" | "hillshade" | "labels";
interface LayerDef { tiles: string; info: string; size: 256 | 512; maxZoom: number; keyIn: "header" | "token" }
const IBASEMAPS = "https://ibasemaps-api.arcgis.com/arcgis/rest/services";
const STATIC = "https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1";
export const ESRI_LAYERS: Record<EsriLayerId, LayerDef> = {
  imagery: { tiles: `${IBASEMAPS}/World_Imagery/MapServer/tile`, info: `${IBASEMAPS}/World_Imagery/MapServer?f=json`, size: 256, maxZoom: 23, keyIn: "token" },
  hillshade: { tiles: `${IBASEMAPS}/Elevation/World_Hillshade_Dark/MapServer/tile`, info: `${IBASEMAPS}/Elevation/World_Hillshade_Dark/MapServer?f=json`, size: 256, maxZoom: 23, keyIn: "token" },
  labels: { tiles: `${STATIC}/arcgis/imagery/labels/static/tile`, info: `${STATIC}/arcgis/imagery/labels/static`, size: 512, maxZoom: 22, keyIn: "header" },
};
const LAYER_IDS = Object.keys(ESRI_LAYERS) as EsriLayerId[];
// Each style is a background with Esri's place labels on top, when the labels' credits are known.
const STYLES: { id: string; label: string; base: EsriLayerId }[] = [
  { id: "esri-imagery", label: "Imagery", base: "imagery" },
  { id: "esri-relief", label: "Relief", base: "hillshade" },
];

export interface EsriTileSpec { id: EsriLayerId; size: 256 | 512; maxZoom: number; overlay: boolean }
export interface EsriStyle { id: string; label: string; tiles: EsriTileSpec[]; credits: string }
export interface EsriStatus { enabled: boolean; reason?: string; styles: EsriStyle[] }
export interface EsriTile { type: string; body: Buffer; cacheControl: string }

export interface EsriDeps {
  key: () => string;
  fetch: typeof fetch;
  /* Books n tiles for this user against the caps, or throws. */
  book: (user: string, n: number) => Promise<void>;
  timeoutMs: number;
  now: () => number;
  warn?: (message: string) => void;
}

const CREDITS_TTL_MS = 24 * 3600_000, RETRY_MS = 5 * 60_000, MAX_TILE_BYTES = 2 * 1024 * 1024;
const COORD = /^\d{1,8}$/;

/* The ArcGIS Location Platform Agreement (E204, revised 21 Nov 2025) allows results to be cached only "as permitted by
   the caching headers ... returned by Location Services", so each tile carries Esri's own lifetime, made private so no
   shared cache keeps it (Front Door caches nothing on this route anyway). A tile without an explicit lifetime from Esri,
   or one Esri marks no-store or no-cache, is not kept at all. */
const KEEP = /^(?:(?:max-age|stale-while-revalidate|stale-if-error)=\d{1,9}|must-revalidate|immutable|no-transform)$/;
export function tileCacheControl(upstream: string | null): string {
  const parts = [...new Set((upstream ?? "").toLowerCase().split(",").map((d) => d.trim().replace(/\s*=\s*/, "=")).filter(Boolean))];
  if (parts.includes("no-store") || parts.includes("no-cache") || !parts.some((d) => /^max-age=\d{1,9}$/.test(d))) return "no-store";
  return ["private", ...parts.filter((d) => KEEP.test(d))].join(", ");
}

/* The credit line in a service's metadata: copyrightText on a map tile service, or an attribution field in the
   static tiles' style information. Links are skipped, and so are error responses. */
export function findCredit(v: unknown, depth = 0, inCredit = false): string | null {
  if (depth > 5 || v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return inCredit && s && !/^https?:\/\//i.test(s) ? s.slice(0, 1000) : null;
  }
  if (Array.isArray(v)) {
    const parts = v.map((x) => findCredit(x, depth + 1, inCredit)).filter((x): x is string => !!x);
    return parts.length ? [...new Set(parts)].join(", ") : null;
  }
  if (typeof v === "object") {
    if (depth === 0 && "error" in v) return null;
    for (const [k, x] of Object.entries(v)) {
      const f = findCredit(x, depth + 1, inCredit || /^(copyright(text)?|attribution(text)?)$/i.test(k));
      if (f) return f;
    }
  }
  return null;
}

export function esriRelay(d: EsriDeps) {
  let credits: { at: number; byLayer: Partial<Record<EsriLayerId, string>> } | null = null;
  let loading: Promise<void> | null = null;

  function call(def: LayerDef, url: string): Promise<Response> {
    const signal = AbortSignal.timeout(d.timeoutMs);
    if (def.keyIn === "header") return d.fetch(url, { headers: { Authorization: `Bearer ${d.key()}` }, signal });
    const u = new URL(url);
    u.searchParams.set("token", d.key());
    return d.fetch(u.toString(), { signal });
  }
  /* Esri's reason for a reply that isn't usable, for the log: its error code and message, never the key. */
  function explain(status: number, body: unknown): string {
    const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const s = e ? `HTTP ${status}, Esri error ${String(e.code ?? "?")}: ${String(e.message ?? "")}` : `HTTP ${status}, no credit line in the reply`;
    const k = d.key();
    return (k ? s.split(k).join("<key>") : s).replace(/\s+/g, " ").slice(0, 200);
  }
  const json = async (r: Response): Promise<unknown> => { try { return JSON.parse(await r.text()); } catch { return null; } };

  async function readCredit(id: EsriLayerId): Promise<string | null> {
    let r: Response;
    try { r = await call(ESRI_LAYERS[id], ESRI_LAYERS[id].info); } catch { d.warn?.(`Esri credits unavailable for ${id}: no answer in time`); return null; }
    const body = await json(r);
    const credit = r.ok ? findCredit(body) : null;
    if (!credit) d.warn?.(`Esri credits unavailable for ${id}: ${explain(r.status, body)}`);
    return credit;
  }
  async function load(): Promise<void> {
    const found = await Promise.all(LAYER_IDS.map(async (id) => [id, await readCredit(id)] as const));
    const byLayer: Partial<Record<EsriLayerId, string>> = {};
    for (const [id, c] of found) if (c) byLayer[id] = c;
    credits = { at: d.now(), byLayer };
  }

  async function known(): Promise<Partial<Record<EsriLayerId, string>>> {
    const n = credits ? Object.keys(credits.byLayer).length : 0;
    if (!credits || d.now() - credits.at > (n === LAYER_IDS.length ? CREDITS_TTL_MS : RETRY_MS)) {
      loading ??= load().finally(() => { loading = null; });
      await loading;
    }
    return credits!.byLayer;
  }

  async function status(): Promise<EsriStatus> {
    if (!d.key()) return { enabled: false, reason: "Esri isn't connected to this deployment yet.", styles: [] };
    const by = await known();
    const spec = (id: EsriLayerId, overlay: boolean): EsriTileSpec => ({ id, size: ESRI_LAYERS[id].size, maxZoom: ESRI_LAYERS[id].maxZoom, overlay });
    const styles = STYLES.filter((s) => by[s.base]).map((s): EsriStyle => {
      const tiles = [spec(s.base, false), ...(by.labels ? [spec("labels", true)] : [])];
      return { id: s.id, label: s.label, tiles, credits: [...new Set(tiles.map((t) => by[t.id]!))].join("; ") };
    });
    return styles.length ? { enabled: true, styles } : { enabled: false, reason: "Esri's base maps couldn't be confirmed just now.", styles: [] };
  }

  function layerOf(id: string): LayerDef | null {
    return Object.hasOwn(ESRI_LAYERS, id) ? ESRI_LAYERS[id as EsriLayerId] : null;
  }

  async function tile(p: { layer: string; z: string; y: string; x: string }, user: string): Promise<EsriTile> {
    if (!d.key()) throw new EsriError(404, "Esri base maps aren't connected to this deployment.");
    const def = layerOf(p.layer);
    if (!def) throw new EsriError(404, "No such Esri layer.");
    if (![p.z, p.y, p.x].every((v) => COORD.test(v))) throw new EsriError(400, "Tile coordinates must be whole numbers.");
    const [z, y, x] = [Number(p.z), Number(p.y), Number(p.x)];
    if (z > def.maxZoom || y >= 2 ** z || x >= 2 ** z) throw new EsriError(400, "That tile is outside the map.");
    if (!(await known())[p.layer as EsriLayerId]) throw new EsriError(503, "That Esri layer's data credits aren't confirmed, so it isn't shown.");
    await d.book(user, 1);
    let r: Response;
    try {
      r = await call(def, `${def.tiles}/${z}/${y}/${x}`);
    } catch {
      throw new EsriError(504, "Esri didn't answer in time.");
    }
    if (r.status === 404) throw new EsriError(404, "Esri has no tile here.");
    // ArcGIS reports a rejected key as JSON, sometimes with status 200, so only an image counts as a tile.
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(png|jpeg|webp)$/.test(type)) {
      d.warn?.(`Esri tile refused for ${p.layer}: ${explain(r.status, await json(r))}`);
      throw new EsriError(502, "Esri couldn't supply that tile.");
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_TILE_BYTES) throw new EsriError(502, "Esri sent an unexpectedly large tile.");
    return { type, body, cacheControl: tileCacheControl(r.headers.get("cache-control")) };
  }

  return { status, tile };
}

/* Booking every tile in Table storage would cost a write per tile, so tiles are booked in blocks: a block is charged to
   the person's daily allowance first and then to the shared daily and monthly allowances, before any tile from it is
   served. Each replica keeps at most one open block per person, and what is left of a block at midnight is dropped, so
   errors and restarts only make the caps stricter. */
export function blockBooker(o: {
  block: number;
  now: () => number;
  takeUser: (user: string, n: number) => Promise<unknown>;
  takeShared: (n: number) => Promise<unknown>;
}) {
  const open = new Map<string, { day: string; left: number }>();
  const pending = new Map<string, Promise<void>>();
  const today = () => new Date(o.now()).toISOString().slice(0, 10);
  return async function book(user: string, n: number): Promise<void> {
    if (n > o.block) throw new Error("A booking can't be larger than a block.");
    for (;;) {
      const day = today();
      const b = open.get(user);
      if (b && b.day === day && b.left >= n) { b.left -= n; return; }
      let p = pending.get(user);
      if (!p) {
        p = (async () => {
          await o.takeUser(user, o.block);
          await o.takeShared(o.block);
          open.set(user, { day, left: o.block });
          if (open.size > 2_000) for (const [k, v] of open) if (v.day !== day) open.delete(k);
        })().finally(() => pending.delete(user));
        pending.set(user, p);
      }
      await p;
    }
  };
}
