import { QueueClient } from "@azure/storage-queue";
import { GeographyPoint, SearchClient } from "@azure/search-documents";
import { blobs, credential, table } from "../azure";
import { cfg } from "../config";
import { LIVE_INDEX_NAME, type ExtractionRef, type LiveEvidenceRecord } from "./contracts";
import { escapeFilter, PipelineError, statusOf } from "./pipeline-config";

export type Row = { partitionKey: string; rowKey: string; etag?: string } & Record<string, unknown>;
export interface BlobInfo { etag: string; bytes: number; contentType: string; metadata: Record<string, string>; versionId?: string }
export type WriteCondition = { ifNoneMatch: "*" } | { ifMatch: string };
export type IndexedRecord = Omit<LiveEvidenceRecord, "vector"> & { vector?: number[] };
export interface PipelineStore {
  get<T extends object>(table: string, pk: string, rk: string, signal?: AbortSignal): Promise<(T & { etag: string }) | null>;
  put(table: string, row: Row, etag?: string, signal?: AbortSignal): Promise<void>;
  list<T extends object>(table: string, pk: string, max: number, signal?: AbortSignal): Promise<(T & { etag: string })[]>;
  stat(container: string, name: string, signal?: AbortSignal): Promise<BlobInfo | null>;
  read(container: string, name: string, maxBytes: number, signal?: AbortSignal): Promise<{ buffer: Buffer; info: BlobInfo } | null>;
  write(container: string, name: string, bytes: Buffer, condition: WriteCondition, contentType: string, metadata?: Record<string, string>, signal?: AbortSignal): Promise<void>;
  send(queue: string, value: string, signal?: AbortSignal): Promise<void>;
  countIndex(signal?: AbortSignal): Promise<number>;
  indexed(ref: ExtractionRef, signal?: AbortSignal): Promise<IndexedRecord[]>;
  upload(records: LiveEvidenceRecord[], signal?: AbortSignal): Promise<void>;
}
export const pipelineQueue = (name: string) => new QueueClient(`https://${cfg.storageAccount()}.queue.core.windows.net/${name}`, credential, { retryOptions: { maxTries: 1 } });
const client = () => new SearchClient<LiveEvidenceRecord>(cfg.searchEndpoint(), LIVE_INDEX_NAME, credential, { retryOptions: { maxRetries: 0 } });
// Conditional writes are mandatory; missing resources are distinguished from unavailable services.
// https://learn.microsoft.com/javascript/api/@azure/data-tables/tableclient
// https://learn.microsoft.com/javascript/api/@azure/storage-blob/blobrequestconditions
// https://learn.microsoft.com/javascript/api/@azure/storage-blob/blobdownloadtobufferoptions
export function azurePipelineStore(): PipelineStore {
  const store: PipelineStore = {
    async get<T extends object>(name: string, pk: string, rk: string, signal?: AbortSignal) {
      try { return await table(name).getEntity<T>(pk, rk, { abortSignal: signal }); }
      catch (e) { if (statusOf(e) === 404) return null; throw e; }
    },
    async put(name, row, etag, signal) {
      const { etag: _etag, ...entity } = row;
      if (etag) { if (etag === "*") throw new Error("Unconditional table update refused."); await table(name).updateEntity(entity, "Merge", { etag, abortSignal: signal }); }
      else await table(name).createEntity(entity, { abortSignal: signal });
    },
    async list<T extends object>(name: string, pk: string, max: number, signal?: AbortSignal) {
      const result: (T & { etag: string })[] = [];
      for await (const row of table(name).listEntities<T>({ queryOptions: { filter: `PartitionKey eq '${escapeFilter(pk)}'` }, abortSignal: signal })) {
        if (result.length >= max) throw new PipelineError(507, "Table result cap reached; nothing was silently omitted.");
        result.push(row);
      }
      return result;
    },
    async stat(container, name, signal) {
      try { const p = await blobs().getContainerClient(container).getBlobClient(name).getProperties({ abortSignal: signal });
        if (!p.etag || !Number.isSafeInteger(p.contentLength)) throw new Error("Missing blob identity.");
        return { etag: p.etag, bytes: p.contentLength!, contentType: p.contentType ?? "", metadata: p.metadata ?? {}, versionId: p.versionId };
      } catch (e) { if (statusOf(e) === 404) return null; throw e; }
    },
    async read(container, name, maxBytes, signal) {
      const info = await store.stat(container, name, signal); if (!info) return null;
      if (info.bytes < 1 || info.bytes > maxBytes) throw new PipelineError(413, "Stored artifact exceeds its bound.");
      const buffer = Buffer.alloc(info.bytes);
      await blobs().getContainerClient(container).getBlobClient(name).downloadToBuffer(buffer, 0, info.bytes, { conditions: { ifMatch: info.etag }, concurrency: 1, maxRetryRequestsPerBlock: 0, abortSignal: signal });
      return { buffer, info };
    },
    async write(container, name, bytes, condition, contentType, metadata = {}, signal) {
      // Match the sources/ ABAC write boundary and reject URL-normalized traversal before reaching the SDK.
      if (container === "quarantine" && (!/^sources\/[a-z0-9][a-z0-9-]*\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes(".."))) throw new PipelineError(403, "Pipeline quarantine writes must stay under a canonical sources/ artifact path.");
      if (Object.keys(condition).length !== 1 || ("ifNoneMatch" in condition ? condition.ifNoneMatch !== "*" : !condition.ifMatch || condition.ifMatch === "*")) throw new Error("Unconditional blob write refused.");
      await blobs().getContainerClient(container).getBlockBlobClient(name).uploadData(bytes, { conditions: condition,
        blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "private, no-store" }, metadata, concurrency: 1, abortSignal: signal });
    },
    async send(name, value, signal) { await pipelineQueue(name).sendMessage(value, { abortSignal: signal }); },
    async countIndex(signal) { return client().getDocumentsCount({ abortSignal: signal }); },
    async indexed(ref, signal) {
      const filter = `sourceId eq '${escapeFilter(ref.sourceId)}' and sha256 eq '${ref.sha256}' and extractionVersion eq '${ref.extractionVersion}'`;
      // Page explicitly: without top the service returns only its default page of 50 and no continuation, which
      // made a 452-passage publication fail on 2 Nov 2026. Pages hold at most 1,000 results; ids are de-duplicated
      // and the unique total must equal the service's count, otherwise publication fails closed.
      // https://learn.microsoft.com/azure/search/search-pagination-page-layout#number-of-results-in-the-response
      const PAGE = 1000, byId = new Map<string, IndexedRecord>();
      let total: number | undefined;
      for (let skip = 0; ; skip += PAGE) {
        const response = await client().search("*", { filter, top: PAGE, skip, orderBy: ["page asc"], includeTotalCount: true, abortSignal: signal });
        total ??= response.count;
        let seen = 0;
        for await (const hit of response.results) {
          seen++;
          if (byId.size >= cfg.caps.indexPassages) throw new PipelineError(507, "Index result cap reached.");
          byId.set((hit.document as { id: string }).id, hit.document);
        }
        if (seen < PAGE || (total !== undefined && skip + PAGE >= total)) break;
      }
      if (total !== undefined && total !== byId.size) throw new Error("Index enumeration was incomplete.");
      return [...byId.values()];
    },
    async upload(records, signal) {
      const result = await client().uploadDocuments(records.map((r) => ({ ...r, points: r.points.map((p) => p instanceof GeographyPoint ? p : new GeographyPoint(p)) })), { abortSignal: signal });
      if (result.results.length !== records.length || result.results.some((r) => !r.succeeded)) throw new Error("Index publication was partial; manifest remains unchanged.");
    },
  };
  return store;
}
