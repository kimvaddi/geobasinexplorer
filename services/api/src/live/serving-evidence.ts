import { SearchClient } from "@azure/search-documents";
import { credential, search, type Passage } from "../azure";
import { cfg } from "../config";
import { LIVE_INDEX_NAME, type LiveEvidenceRecord } from "./contracts";

export type LiveEvidenceHit = Omit<LiveEvidenceRecord, "vector" | "boundingRegionsSummary">;
export interface EvidenceSearch {
  live(query: string, filter: string, top: number, signal: AbortSignal): Promise<LiveEvidenceHit[]>;
  packaged(query: string, filter: string, signal: AbortSignal): Promise<Passage[]>;
}
const LIVE_SELECT = ["id", "sourceId", "sha256", "extractionVersion", "documentSha256", "docId", "page", "headingPath", "text", "basin", "well", "visibility", "owner", "publishAllowed", "manifestVersion", "points", "places", "placeHow", "geoBasins", "geotag", "licence", "attribution"] as const;
let client: SearchClient<LiveEvidenceRecord> | undefined;
// Query parameters remain server-controlled. abortSignal also bounds paged result iteration.
// https://learn.microsoft.com/javascript/api/@azure/search-documents/searchclient#@azure-search-documents-searchclient-search
// https://learn.microsoft.com/azure/search/search-query-odata-filter
export function makeEvidenceSearch(live: () => Pick<SearchClient<LiveEvidenceRecord>, "search">, packaged: () => Pick<SearchClient<Passage>, "search">): EvidenceSearch { return {
  async live(query, filter, top, signal) {
    const result = await live().search(query, { filter, top, select: [...LIVE_SELECT], queryType: "simple", abortSignal: signal });
    const out: LiveEvidenceHit[] = [];
    for await (const r of result.results) { signal.throwIfAborted(); out.push(r.document); if (out.length >= top) break; }
    return out;
  },
  async packaged(query, filter, signal) {
    const result = await packaged().search(query, { filter, top: 32, queryType: "simple", abortSignal: signal,
      select: ["id", "doc", "docId", "page", "heading", "kind", "text", "basin", "well", "visibility", "owner", "source", "points", "places", "placeHow", "geoBasins", "geotag"] });
    const out: Passage[] = [];
    for await (const r of result.results) { signal.throwIfAborted(); out.push(r.document); if (out.length >= 32) break; }
    return out;
  },
}; }
export const evidenceSearch = makeEvidenceSearch(() => client ??= new SearchClient<LiveEvidenceRecord>(cfg.searchEndpoint(), LIVE_INDEX_NAME, credential, { retryOptions: { maxRetries: 0 } }), search);
