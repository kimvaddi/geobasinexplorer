import { SearchClient } from "@azure/search-documents";
import { credential, search, type Passage } from "../azure";
import { cfg } from "../config";
import { LIVE_INDEX_NAME, type LiveEvidenceRecord, type PublicationManifest } from "./contracts";
import { liveManifest } from "./serving-manifest";

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
type LiveIndex = Pick<SearchClient<LiveEvidenceRecord>, "search">;
/* Version 2, decision D5 (docs/v2/LIBRARY_ONELAKE.md): the library index is the one the OneLake files indexer fills from gold.
   It answers only once it holds every passage of the current publication, and any failure falls back to the push index. */
export interface LibraryIndex { client: () => LiveIndex; covered: (signal: AbortSignal) => Promise<boolean> }
export function makeEvidenceSearch(live: () => LiveIndex, packaged: () => Pick<SearchClient<Passage>, "search">, library?: LibraryIndex): EvidenceSearch {
  const read = async (index: LiveIndex, query: string, filter: string, top: number, signal: AbortSignal) => {
    const result = await index.search(query, { filter, top, select: [...LIVE_SELECT], queryType: "simple", abortSignal: signal });
    const out: LiveEvidenceHit[] = [];
    for await (const r of result.results) { signal.throwIfAborted(); out.push(r.document); if (out.length >= top) break; }
    return out;
  };
  return {
  async live(query, filter, top, signal) {
    if (library && await library.covered(signal).catch(() => false)) {
      try { return await read(library.client(), query, filter, top, signal); }
      catch (e) { if (signal.aborted) throw e; }
    }
    return read(live(), query, filter, top, signal);
  },
  async packaged(query, filter, signal) {
    const result = await packaged().search(query, { filter, top: 32, queryType: "simple", abortSignal: signal,
      select: ["id", "doc", "docId", "page", "heading", "kind", "text", "basin", "well", "visibility", "owner", "source", "points", "places", "placeHow", "geoBasins", "geotag"] });
    const out: Passage[] = [];
    for await (const r of result.results) { signal.throwIfAborted(); out.push(r.document); if (out.length >= 32) break; }
    return out;
  },
}; }
/* True once the library index holds exactly the current publication's passages, counted with the same tuple selection that
   serving filters by. A covered publication stays covered, because chunk ids are immutable and the index keeps them; a new
   manifest is counted again, and an uncovered one at most once a minute, so a publication the indexer hasn't reached yet
   is served from the push index meanwhile. */
export function libraryCoverage(current: () => Promise<PublicationManifest | null>, count: (filter: string, signal: AbortSignal) => Promise<number>,
  options: { retryMs?: number; now?: () => number } = {}) {
  const retryMs = options.retryMs ?? 60_000, now = options.now ?? Date.now;
  let state: { version: number; covered: boolean; at: number } | null = null, pending: Promise<boolean> | null = null;
  return async (signal: AbortSignal): Promise<boolean> => {
    const manifest = await current();
    if (!manifest) return false;
    if (state?.version === manifest.manifestVersion && (state.covered || now() - state.at < retryMs)) return state.covered;
    pending ??= (async () => {
      const expected = manifest.sources.reduce((n, s) => n + s.documents.reduce((m, d) => m + d.chunkCount, 0), 0);
      let total = 0;
      for (let i = 0; i < manifest.sources.length; i += 20) total += await count(selection(manifest.sources.slice(i, i + 20)), signal);
      const covered = total === expected;
      if (state?.covered !== covered || state.version !== manifest.manifestVersion) console.log(JSON.stringify({ event: "live-evidence-index",
        index: covered ? "library" : "push", manifestVersion: manifest.manifestVersion, expected, indexed: total }));
      state = { version: manifest.manifestVersion, covered, at: now() };
      return state.covered;
    })().finally(() => { pending = null; });
    return pending;
  };
}
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const selection = (sources: PublicationManifest["sources"]) => sources.map((s) =>
  `(sourceId eq ${quote(s.sourceId)} and sha256 eq ${quote(s.sha256)} and extractionVersion eq ${quote(s.extractionVersion)})`).join(" or ");

let library: SearchClient<LiveEvidenceRecord> | undefined;
const libraryClient = () => library ??= new SearchClient<LiveEvidenceRecord>(cfg.searchEndpoint(), cfg.v2.libraryIndex, credential, { retryOptions: { maxRetries: 0 } });
export const evidenceSearch = makeEvidenceSearch(() => client ??= new SearchClient<LiveEvidenceRecord>(cfg.searchEndpoint(), LIVE_INDEX_NAME, credential, { retryOptions: { maxRetries: 0 } }), search,
  cfg.v2.libraryIndex ? { client: libraryClient, covered: libraryCoverage(async () => (await liveManifest.read()).manifest, async (filter, signal) =>
    (await libraryClient().search("*", { filter, top: 0, includeTotalCount: true, abortSignal: signal })).count ?? -1) } : undefined);
