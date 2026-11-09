// Azure Maps tokens and the GDAL/PROJ spatial service.
// Map tiles: the browser never holds a key. Signed-in users get a Microsoft Entra token from this app, obtained with
// a managed identity whose only permission is Azure Maps render read (Learn: how-to-secure-webapp-users).
// Spatial answers (cross-sections, "what's here", datum transforms) come from the internal spatial service, which is
// reachable only from inside the Container Apps environment.
import { AzureCliCredential, ManagedIdentityCredential, type AccessToken, type TokenCredential } from "@azure/identity";
import { cfg } from "./config";
import { LICENCE } from "./licence";
import type { SpatialHere } from "@/lib/pack";

export class SpatialError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let mapsCred: TokenCredential | null = null;
let cached: AccessToken | null = null;
let pending: Promise<AccessToken> | null = null;

export async function mapsToken(): Promise<{ token: string; expiresOn: number; clientId: string; domain: string }> {
  const m = cfg.maps;
  if (!m.accountClientId) throw new SpatialError(503, "Azure Maps isn't configured for this deployment.");
  // Renewed ten minutes before expiry, so the browser never receives a token that is about to lapse.
  if (!cached || cached.expiresOnTimestamp - Date.now() < 10 * 60_000) {
    pending ??= (async () => {
      mapsCred ??= process.env.IDENTITY_ENDPOINT ? new ManagedIdentityCredential({ clientId: m.identityClientId }) : new AzureCliCredential();
      const t = await mapsCred.getToken("https://atlas.microsoft.com/.default");
      if (!t) throw new Error("Azure Maps token unavailable");
      return t;
    })().finally(() => { pending = null; });
    cached = await pending;
  }
  return { token: cached.token, expiresOn: cached.expiresOnTimestamp, clientId: m.accountClientId, domain: m.domain };
}

// Each request takes milliseconds, but the service is shared, so one person can't monopolise it. The library search by
// place (geo.ts) shares the same allowance.
const recent = new Map<string, number[]>();
function allow(user: string): boolean {
  const now = Date.now();
  const hits = (recent.get(user) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= cfg.caps.spatialPerUserPerMinute) { recent.set(user, hits); return false; }
  hits.push(now);
  recent.set(user, hits);
  if (recent.size > 5_000) for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  return true;
}
export function takeSpatial(user: string): void {
  if (!allow(user)) throw new SpatialError(429, "Too many map requests in the last minute. Please wait a moment.");
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const lonOk = (v: unknown) => finite(v) && v >= 100 && v <= 170;
const latOk = (v: unknown) => finite(v) && v >= -50 && v <= 0;
const point = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && lonOk(v[0]) && latOk(v[1]);
const MAX_TRANSFORM_POINTS = 2_000; // what fits in the API's 64 KB request limit

async function call(path: string, body: unknown, user: string): Promise<unknown> {
  if (!cfg.spatialUrl) throw new SpatialError(503, "The spatial service isn't configured for this deployment.");
  takeSpatial(user);
  let r: Response;
  try {
    r = await fetch(`${cfg.spatialUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutsMs.spatial) });
  } catch {
    throw new SpatialError(503, "The spatial service didn't answer in time.");
  }
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (r.status === 400 && j?.error) throw new SpatialError(400, j.error);
  if (!r.ok || !j) throw new SpatialError(502, "The spatial service couldn't complete that request.");
  return j;
}

export function spatialSection(b: Record<string, unknown>, user: string) {
  if (!point(b.a) || !point(b.b)) throw new SpatialError(400, "a and b must each be [longitude, latitude] within the Australian basins.");
  const widthKm = b.widthKm ?? 10;
  if (!finite(widthKm) || widthKm < 0.1 || widthKm > 50) throw new SpatialError(400, "widthKm must be between 0.1 and 50.");
  return call("/section", { a: b.a, b: b.b, widthKm }, user);
}

export async function spatialHere(b: Record<string, unknown>, user: string) {
  if (!lonOk(b.lon) || !latOk(b.lat)) throw new SpatialError(400, "lon and lat must be a point within the Australian basins.");
  const here = await call("/here", { lon: b.lon, lat: b.lat }, user) as SpatialHere;
  return { ...here, wells: here.wells.filter((w) => !LICENCE.isWithheldWell(w.id)) };
}

export function spatialTransform(b: Record<string, unknown>, user: string) {
  if (!Number.isInteger(b.from) || !Number.isInteger(b.to)) throw new SpatialError(400, "from and to must be EPSG codes.");
  const pts = b.points;
  if (!Array.isArray(pts) || pts.length > MAX_TRANSFORM_POINTS || !pts.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])))
    throw new SpatialError(400, `points must be a list of at most ${MAX_TRANSFORM_POINTS} [x, y] pairs.`);
  return call("/transform", { from: b.from, to: b.to, points: pts }, user);
}
