import { LIVE_ROUTES, LIVE_SOURCE_IDS, SHA256_PATTERN, SOURCE_ID_PATTERN, EXTRACTION_VERSION_PATTERN, REVIEW_REASON_MAX_LENGTH } from "../../../services/api/src/live/contracts";
import type { SourceRegistry, SourceReview, SilverDocumentRecord, SilverChunkRecord, StewardDecision, PublicationManifest } from "../../../services/api/src/live/contracts";
import type { Citation } from "./ask";
import type { SiteMarker } from "@/components/basin-map";
import { api } from "./cloud";

export type LiveClientSource = Pick<PublicationManifest["sources"][number], "sourceId" | "title" | "publisher" | "licence" | "attribution" | "sha256" | "extractionVersion" | "documents" | "wellLocation" | "v1DocIds">;
export interface LiveClientManifest { enabled: boolean; manifestVersion: number | null; createdAt: string | null; sources: LiveClientSource[]; reason?: string; requiredSourceIds?: string[] }
export interface LivePublication { status: "pending" | "queued" | "published" | "failed"; manifestVersion?: number; detail?: string }
export interface LiveReviewDetail { review: SourceReview; source: SourceRegistry; documents: SilverDocumentRecord[]; samples: SilverChunkRecord[]; etag: string; publication: LivePublication }
export const EMPTY_LIVE: LiveClientManifest = { enabled: false, manifestVersion: null, createdAt: null, sources: [], reason: "Live publication unavailable" };
const hash = (s: unknown): s is string => typeof s === "string" && new RegExp(SHA256_PATTERN).test(s);
const source = (s: unknown): s is string => typeof s === "string" && new RegExp(SOURCE_ID_PATTERN).test(s);
const version = (s: unknown): s is string => typeof s === "string" && new RegExp(EXTRACTION_VERSION_PATTERN).test(s);
const nativePage = (p: unknown): p is number => typeof p === "number" && Number.isSafeInteger(p) && p > 0;
const liveSourceId = (id: unknown) => (LIVE_SOURCE_IDS as readonly unknown[]).includes(id);
export function routePath(template: string, values: Record<string, string | number>): string {
  const path = template.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_m, key: string) => {
    if (!(key in values)) throw new Error("Missing API route identity"); return encodeURIComponent(String(values[key]));
  });
  if (!path.startsWith("/api/")) throw new Error("Only same-origin API paths are allowed"); return path;
}
export function livePagePath(c: Citation): string | null {
  const p = c.live;
  if (!p || !source(p.sourceId) || !hash(p.documentSha256) || !version(p.extractionVersion) || !nativePage(c.page)) return null;
  return routePath(LIVE_ROUTES.page.path, { sourceId: p.sourceId, sha256: p.documentSha256, page: c.page });
}
export function reviewPagePath(detail: LiveReviewDetail, chunk: SilverChunkRecord): string | null {
  const r = detail.review;
  if (!source(r.sourceId) || !hash(r.sha256) || !version(r.extractionVersion) || !hash(chunk.documentSha256) || !nativePage(chunk.page)
    || chunk.sourceId !== r.sourceId || chunk.sha256 !== r.sha256 || chunk.extractionVersion !== r.extractionVersion
    || !detail.documents.some((d) => d.documentSha256 === chunk.documentSha256 && d.docId === chunk.docId && d.pageCount >= chunk.page)) return null;
  return routePath(LIVE_ROUTES.reviewPage.path, { sourceId: r.sourceId, sha256: r.sha256, extractionVersion: r.extractionVersion, documentSha256: chunk.documentSha256, page: chunk.page });
}
export function parseClientManifest(value: unknown): LiveClientManifest {
  const m = value as LiveClientManifest | null;
  const requiredSourceIds = m?.requiredSourceIds ?? [];
  if (!Array.isArray(requiredSourceIds) || requiredSourceIds.some((id) => !liveSourceId(id))) throw new Error("Invalid serving revision source commitments");
  if (!requiredSourceIds.length || !m?.enabled) return { ...EMPTY_LIVE, requiredSourceIds: [...requiredSourceIds] };
  if (!nativePage(m.manifestVersion) || typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt)) || !Array.isArray(m.sources) || !m.sources.length || m.sources.length > LIVE_SOURCE_IDS.length) throw new Error("Invalid live publication");
  const ids = new Set<string>();
  for (const s of m.sources) {
    if (!s || !liveSourceId(s.sourceId) || ids.has(s.sourceId) || !hash(s.sha256) || !version(s.extractionVersion)
      || !Array.isArray(s.documents) || !s.documents.length || !Array.isArray(s.v1DocIds)) throw new Error("Invalid live source");
    ids.add(s.sourceId);
    if (s.wellLocation && (!Number.isFinite(s.wellLocation.lon) || s.wellLocation.lon < 100 || s.wellLocation.lon > 170 || !Number.isFinite(s.wellLocation.lat) || s.wellLocation.lat < -50 || s.wellLocation.lat > 0 || s.wellLocation.datum !== "GDA94")) throw new Error("Invalid live geotag");
    if (s.sourceId === "peps-sa-marabooka-1" && !s.wellLocation) throw new Error("Missing live geotag");
    for (const d of s.documents) if (!hash(d.sha256) || !nativePage(d.pageCount) || !nativePage(d.chunkCount) || typeof d.docId !== "string" || typeof d.title !== "string") throw new Error("Invalid live document");
  }
  const sources = m.sources.filter((s) => requiredSourceIds.includes(s.sourceId));
  if (!sources.length) return { ...EMPTY_LIVE, requiredSourceIds: [...requiredSourceIds] };
  // Reconstruct rather than copying unexpected API properties, such as a future private-storage URL.
  return { requiredSourceIds: [...requiredSourceIds], enabled: true, manifestVersion: m.manifestVersion, createdAt: m.createdAt, sources: sources.map(({ sourceId, title, publisher, licence, attribution, sha256, extractionVersion, documents, wellLocation, v1DocIds }) => ({ sourceId, title, publisher, licence, attribution, sha256, extractionVersion, documents: documents.map(({ docId, sha256, title, pageCount, chunkCount }) => ({ docId, sha256, title, pageCount, chunkCount })), wellLocation: wellLocation ? { lon: wellLocation.lon, lat: wellLocation.lat, datum: "GDA94" } : null, v1DocIds: [...v1DocIds] })) };
}
export function liveMapMarkers(packaged: SiteMarker[], manifest: LiveClientManifest): SiteMarker[] {
  const active = manifest.enabled ? manifest.sources.filter((s) => manifest.requiredSourceIds?.includes(s.sourceId)) : [];
  const current = active.find((s) => s.sourceId === "peps-sa-marabooka-1");
  const unavailable = !current && manifest.requiredSourceIds?.includes("peps-sa-marabooka-1");
  if (!active.length && !unavailable) return packaged;
  const rest = packaged.filter((p) => p.id !== "marabooka-1" || (!current && !unavailable))
    .map((p) => active.length ? { ...p, tag: `${p.tag} · packaged snapshot` } : p);
  return current?.wellLocation ? [...rest, { id: "marabooka-1", lon: current.wellLocation.lon, lat: current.wellLocation.lat,
    label: "Marabooka 1", kind: "legacy", tag: `live geotag · publication ${manifest.manifestVersion}` }] : rest;
}
export function liveMapStatus(manifest: LiveClientManifest): string | null {
  const active = manifest.enabled ? manifest.sources.filter((s) => manifest.requiredSourceIds?.includes(s.sourceId)) : [];
  const marabooka = active.some((s) => s.sourceId === "peps-sa-marabooka-1");
  const missing = (manifest.requiredSourceIds ?? []).filter((id) => !active.some((s) => s.sourceId === id));
  if (!active.length) return missing.length ? "Live publication unavailable." : null;
  const marker = marabooka ? `Marabooka 1: live geotag (publication ${manifest.manifestVersion}). `
    : missing.includes("peps-sa-marabooka-1") ? "Marabooka 1: Live publication unavailable. " : "";
  return `${marker}Other map layers: packaged snapshot.`;
}
export { REVIEW_REASON_MAX_LENGTH };
export function reviewReasonError(reason: string): string | null {
  if (!reason.trim()) return "A decision reason is required.";
  return reason.length > REVIEW_REASON_MAX_LENGTH ? `Decision reasons must be ${REVIEW_REASON_MAX_LENGTH} characters or fewer.` : null;
}
const reviewUrl = (r: Pick<SourceReview, "sourceId" | "sha256" | "extractionVersion">) => routePath(LIVE_ROUTES.review.path, r);
export const liveApi = {
  manifest: async (signal?: AbortSignal) => parseClientManifest(await api<unknown>(LIVE_ROUTES.manifest.path, { cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(6_000), ...(signal ? [signal] : [])]) })),
  reviews: () => api<{ reviews: SourceReview[]; registry: SourceRegistry[] }>(LIVE_ROUTES.reviews.path, { cache: "no-store" }),
  review: (r: SourceReview) => api<LiveReviewDetail>(reviewUrl(r), { cache: "no-store" }),
  decide: (decision: StewardDecision, etag: string) => {
    if (!etag) throw new Error("A current review ETag is required");
    const reasonError = reviewReasonError(decision.reason); if (reasonError) throw new Error(reasonError);
    return api<{ review: SourceReview; etag: string; publication: LivePublication }>(routePath(LIVE_ROUTES.reviewDecision.path, { sourceId: decision.sourceId, sha256: decision.sha256, extractionVersion: decision.extractionVersion }), {
      method: "POST", cache: "no-store", headers: { "If-Match": etag }, body: JSON.stringify(decision),
    });
  },
};
