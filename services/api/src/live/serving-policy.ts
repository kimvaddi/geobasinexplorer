import type { Answer5 } from "@/lib/answer5";
import type { Citation } from "@/lib/ask";
import { searchDocumentId } from "@/lib/licence";
import type { Passage } from "../azure";
import { cfg, type LiveRoute } from "../config";
import type { PublicationManifest } from "./contracts";
import { PHASE1A_V1_DOC_IDS, livePlace } from "./source-policy";

export const PACKAGED_LABEL = "packaged snapshot" as const;
// Version 2's curated records from the Fabric knowledge graph (v2/knowledge.ts) are neither live pages nor the snapshot.
export const KNOWLEDGE_LABEL = "knowledge graph" as const;
export const configuredLiveSources = (): readonly string[] => cfg.live?.sources ?? [];
export const configuredLiveRoute = (): LiveRoute => cfg.live?.route ?? "matched";
export function liveSources(manifest: PublicationManifest | null, configured = configuredLiveSources()) {
  return (manifest?.sources ?? []).filter((source) => configured.includes(source.sourceId));
}
export function projectLiveManifest(manifest: PublicationManifest | null, configured = configuredLiveSources()): PublicationManifest | null {
  const sources = liveSources(manifest, configured);
  return manifest && sources.length ? { ...manifest, sources } : null;
}
export const hasLiveSources = (manifest: PublicationManifest | null, configured = configuredLiveSources()): boolean => liveSources(manifest, configured).length > 0;
export function unavailableSourceIds(manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return configured.filter((id) => !manifest?.sources.some((s) => s.sourceId === id));
}
export function unavailableV1DocIds(manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return unavailableSourceIds(manifest, configured).flatMap((id) => [...(PHASE1A_V1_DOC_IDS[id as keyof typeof PHASE1A_V1_DOC_IDS] ?? [])]);
}
export function excludedV1DocIds(manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return [...new Set([...liveSources(manifest, configured).flatMap((s) => s.v1DocIds), ...unavailableV1DocIds(manifest, configured)])];
}
// With an empty lane this clause is OMITTED, preserving the 0.12.0 query rather than filtering all slice families.
// https://learn.microsoft.com/azure/search/search-query-odata-search-in-function
export function packagedExclusion(manifest: PublicationManifest | null, configured = configuredLiveSources()): string {
  const ids = excludedV1DocIds(manifest, configured);
  return ids.length ? `(docId eq null or not search.in(docId, '${ids.join("|").replace(/'/g, "''")}', '|'))` : "";
}
export function packagedFilter(filter: string, manifest: PublicationManifest | null, configured = configuredLiveSources()): string {
  const exclusion = packagedExclusion(manifest, configured);
  return exclusion ? `${filter} and ${exclusion}` : filter;
}
export function packagedAllowed(p: Pick<Passage, "docId" | "doc">, manifest: PublicationManifest | null, configured = configuredLiveSources()): boolean {
  const ids = excludedV1DocIds(manifest, configured);
  return !ids.includes(p.docId) && !ids.includes(searchDocumentId(p.doc));
}
const citesSource = (prepared: Answer5, sourceId: string, docIds: readonly string[]) => prepared.citations.some((c) =>
  c.live?.sourceId === sourceId || docIds.includes(searchDocumentId(c.doc)));
export function requiredLiveSources(prepared: Answer5, manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return liveSources(manifest, configured).filter((s) => citesSource(prepared, s.sourceId, s.v1DocIds)).map((s) => s.sourceId);
}
/* The live source that now publishes a prepared answer's cited passage, matched exactly as requiredLiveSources matches it. */
export function liveSourceOf(c: Pick<Citation, "doc" | "live">, manifest: PublicationManifest | null, configured = configuredLiveSources()) {
  return liveSources(manifest, configured).find((s) => c.live?.sourceId === s.sourceId || s.v1DocIds.includes(searchDocumentId(c.doc))) ?? null;
}
export function unavailablePreparedSources(prepared: Answer5, manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return unavailableSourceIds(manifest, configured).filter((id) => citesSource(prepared, id, PHASE1A_V1_DOC_IDS[id as keyof typeof PHASE1A_V1_DOC_IDS] ?? []));
}
// A library question the prepared rules don't cover would lose a migrated document's content, because the library
// leaves it out. When one of its best matches comes from such a document, the live agent answers it instead.
export function migratedLiveSources(best: Pick<Passage, "docId" | "doc">[], manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return liveSources(manifest, configured).filter((s) => best.some((p) => s.v1DocIds.includes(p.docId) || s.v1DocIds.includes(searchDocumentId(p.doc)))).map((s) => s.sourceId);
}
// "Habanero 1", "Habanero-1", "Habanero No. 1", or the bare name when no other well number follows it.
export function namesWell(question: string, well: string): boolean {
  const m = /^(.*\S)\s+(\d{1,3})$/.exec(well);
  if (!m) return false;
  const name = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+"), gap = "[\\s-]*(?:no\\.?\\s*)?";
  return new RegExp(`\\b${name}(?:${gap}${m[2]}\\b|\\b(?!${gap}\\d))`, "i").test(question);
}
// Under the default route, a live source with no packaged documents (Habanero 1) is reachable only this way.
export function wellLiveSources(question: string, manifest: PublicationManifest | null, configured = configuredLiveSources()): string[] {
  return liveSources(manifest, configured).filter((s) => { const well = livePlace(s.sourceId)?.well; return !!well && namesWell(question, well); }).map((s) => s.sourceId);
}
// The live sources a question the prepared rules don't cover is routed to; none leaves it with the library. "matched"
// (GBX_LIVE_ROUTE's default) routes it when it names a live source's well or a migrated document is among its best
// matches. "all" routes every such question while a live publication with configured sources exists, so a live-only
// source is reachable from any question. No source is mandatory either way.
export function routedLiveSources(question: string, best: Pick<Passage, "docId" | "doc">[], manifest: PublicationManifest | null, route = configuredLiveRoute(), configured = configuredLiveSources()): string[] {
  if (route === "all") return liveSources(manifest, configured).map((s) => s.sourceId);
  return [...new Set([...wellLiveSources(question, manifest, configured), ...migratedLiveSources(best, manifest, configured)])];
}
export function labelPackaged<T extends Answer5>(answer: T, manifest: PublicationManifest | null, configured = configuredLiveSources()): T {
  if (!hasLiveSources(manifest, configured)) return answer;
  return { ...answer, citations: answer.citations.map((c) => ({ ...c, provenanceLabel: c.live ? "live" as const : c.provenanceLabel === KNOWLEDGE_LABEL ? KNOWLEDGE_LABEL : PACKAGED_LABEL })) };
}
