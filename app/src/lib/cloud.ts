// Cloud mode: the same app, built with `vite build --mode cloud` and served by the GeoBasin service on Azure.
// Answers, uploads, reviews and feedback go to the service; the map, knowledge graph and images still run in the browser
// on the bundled public data. The offline single-file build never takes these paths.
import type { Answer5, Validation } from "@/lib/answer5";
import type { LogEntry, ReviewState } from "@/lib/score";
import type { IngestResult } from "@/lib/ingest";
import type { LonLat } from "@/lib/basins";
import type { Section } from "@/lib/section";
import type { NearResult, SpatialHere } from "@/lib/pack";

export const CLOUD = (import.meta as { env?: { MODE?: string } }).env?.MODE === "cloud";
/* The source licence gate (lib/licence.ts) is always on: this edition carries only sources whose reuse terms allow
   redistribution, and the build (vite.config.ts) strips anything the licence registry withholds. */
export const GATED = true;

export class CloudError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export function signIn(): never {
  const back = `${location.pathname}${location.search}${location.hash}`;
  location.assign(`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(back)}`);
  throw new CloudError("Signing you in…", 401);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = init.body && !(init.body instanceof FormData);
  const r = await fetch(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  if (r.status === 401) signIn();
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new CloudError(body.error ?? `The GeoBasin service returned ${r.status}.`, r.status);
  return body as T;
}

export interface Me { name: string; id: string; owner: boolean; liveSources?: string[]; ai?: boolean; uploads?: boolean; models?: { writer: string; checker: string }; scientists?: boolean }
/* While the Foundry scientists work: how long it has taken, how many sources they have read, the latest few by name. */
export interface AskProgress { elapsedMs: number; sources: number; latest: string[] }
export interface JobStatus {
  jobId: string; status: "queued" | "scanning" | "reading" | "done" | "rejected" | "failed"; detail: string; fileName: string; bytes: number;
  metrics: { pages: number; readPages: number; blankOrFailed: number; meanConfidence: number | null; worstPageConfidence: number | null; msScanWait: number; msOcr: number; msExtract: number; msIndex: number; msTotal: number } | null;
  result: (IngestResult & { pageQuality?: { n: number; conf: number | null }[]; scan?: string }) | null;
}

export interface MapsToken { token: string; expiresOn: number; clientId: string; domain: string }
/* Esri base maps, relayed by this app (services/api/src/esri.ts). Each style lists its tile layers and the data credits
   Esri requires on the map; the tiles come from /api/basemap/esri/<layer>/{z}/{y}/{x}. */
export interface EsriTiles { id: string; size: 256 | 512; maxZoom: number; overlay: boolean }
export interface EsriStyle { id: string; label: string; tiles: EsriTiles[]; credits: string }
export interface EsriStatus { enabled: boolean; reason?: string; styles: EsriStyle[] }
/* Planetary Computer Pro overlays, relayed by this app (services/api/src/planetary.ts) and offered only with an Esri base
   map. Each lists the notice its licensor requires on the map; tiles come from /api/overlay/planetary/<layer>/{z}/{x}/{y}. */
export interface PlanetaryLayer {
  id: string; label: string; size: 512; minZoom: number; maxZoom: number; bounds: [number, number, number, number]; credits: string;
  legend?: { title: string; min: string; max: string; colors: string[] };
}
export interface PlanetaryStatus { enabled: boolean; reason?: string; layers: PlanetaryLayer[] }
/* "What we know in this area" for an outline drawn on the map: the library's sources geotagged inside it
   (services/api/src/geo.ts) and what Planetary Computer Pro holds there, with its licensors' notices (planetary.ts). */
export interface AreaSource { id: string; doc: string; page: number; pages: number[]; passages: number; heading: string; place: string; how: string; lon: number; lat: number; yours: boolean }
export interface AreaSources { matched: number; documents: number; sources: AreaSource[]; basins: { id: string; name: string; passages: number }[]; ms: number; method: string }
export interface PlanetaryArea {
  covered: boolean;
  elevation: { min: number; max: number; mean: number; samples: number; tiles: number } | null;
  elevationNote?: string;
  scenes: { id: string; date: string; cloud: number | null; tile: string | null }[];
  credits: { elevation: string; imagery: string };
  ms: number; method: string;
}

export const cloud = {
  me: () => api<Me>("/api/me"),
  /* near: limit the answer to sources geotagged near a place (or about the basin around it as a whole). */
  /* In version 2 an answer from the Foundry scientists can take a minute or more, so the service
     returns a handle at once and the answer is polled for until it is ready (services/api/src/v2/copilot.ts). Each poll
     reports what the scientists have read so far, which the copilot shows while it waits. */
  ask: async (q: string, basin: string | null, near?: { lon: number; lat: number; km: number }, onProgress?: (p: AskProgress) => void) => {
    let a = await api<Answer5>("/api/ask", { method: "POST", body: JSON.stringify({ q, basin, ...(near ? { near } : {}) }) });
    const t0 = Date.now();
    while (a.pending) {
      onProgress?.({ elapsedMs: a.pending.elapsedMs ?? Date.now() - t0, sources: a.pending.progress?.sources ?? 0, latest: a.pending.progress?.latest ?? [] });
      await new Promise((r) => setTimeout(r, 3000));
      if (Date.now() - t0 > 8 * 60_000) throw new CloudError("The Foundry scientists took longer than eight minutes. Please ask again.", 504);
      a = await api<Answer5>("/api/v2/ask/status", { method: "POST", body: JSON.stringify({ handle: a.pending.handle }) });
    }
    return a;
  },
  reviews: () => api<{ review: ReviewState; log: LogEntry[] }>("/api/reviews"),
  decide: (entityId: string, status: "accepted" | "rejected" | "edited" | "clear", label?: string) => api<{ version: number }>("/api/reviews", { method: "POST", body: JSON.stringify({ entityId, status, label }) }),
  feedback: (b: { answerId: string; question: string; vote: string; reason: string; citations: string[]; label: string }) => api<{ note: string }>("/api/feedback", { method: "POST", body: JSON.stringify(b) }),
  upload: (file: File) => { const fd = new FormData(); fd.append("file", file, file.name); return api<{ jobId: string; status: string; detail: string }>("/api/ingest", { method: "POST", body: fd }); },
  job: (id: string) => api<JobStatus>(`/api/ingest/${encodeURIComponent(id)}`),
  // Azure Maps and the GDAL/PROJ spatial service (internal; the API validates and forwards).
  mapsToken: () => api<MapsToken>("/api/maps/token"),
  esri: () => api<EsriStatus>("/api/basemap/esri"),
  planetary: () => api<PlanetaryStatus>("/api/overlay/planetary"),
  section: (a: LonLat, b: LonLat) => api<Section>("/api/spatial/section", { method: "POST", body: JSON.stringify({ a, b, widthKm: 10 }) }),
  here: (lon: number, lat: number) => api<SpatialHere>("/api/spatial/here", { method: "POST", body: JSON.stringify({ lon, lat }) }),
  near: (lon: number, lat: number, km: number) => api<NearResult>("/api/search/near", { method: "POST", body: JSON.stringify({ lon, lat, km }) }),
  areaSources: (ring: LonLat[]) => api<AreaSources>("/api/search/area", { method: "POST", body: JSON.stringify({ ring }) }),
  planetaryArea: (ring: LonLat[]) => api<PlanetaryArea>("/api/overlay/planetary/area", { method: "POST", body: JSON.stringify({ ring }) }),
};

/* A failure becomes an honest "Not found" answer, so the conversation never shows a fabricated reply. */
export function failureAnswer(q: string, e: unknown): Answer5 {
  const msg = e instanceof Error ? e.message : "The GeoBasin service could not be reached.";
  const validation: Validation = { status: "not-run", validator: "", checked: 0, supported: 0, removed: [], note: msg };
  return {
    id: `err-${Date.now().toString(36)}`, question: q, status: "unsupported", basin: null, paragraphs: [`No answer this time. ${msg}`],
    provenance: [], citations: [], focus: null, focusBasin: null, highlight: [], followUps: [], why: { terms: [], rule: "", scores: [] },
    label: "Not found", hits: [], reason: "Service unavailable", engine: "azure", validation,
  };
}

/* One sentence describing the independent check, for the answer card, the copilot and "Show your work". */
export function validationText(a: Answer5): string | null {
  const v = a.validation;
  if (!a.engine || !v) return null;
  if (v.status === "passed") return `Checked by ${v.validator}: ${v.supported} of ${v.checked} statement${v.checked === 1 ? "" : "s"} confirmed${v.removed.length ? `, ${v.removed.length} removed before you saw it` : ""}.`;
  if (v.status === "blocked") return `${v.validator} could not confirm any statement, so none is shown.`;
  if (v.status === "incomplete") return "Validation incomplete, so no answer is shown.";
  return v.note || "No statement needed checking.";
}
