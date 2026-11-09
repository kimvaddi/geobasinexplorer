import type { BlobClient } from "@azure/storage-blob";
import { blobs } from "../azure";
import { CURRENT_MANIFEST_BLOB, LIVE_CONTAINERS, validateManifest, type PublicationManifest } from "./contracts";

import { configuredLiveSources, projectLiveManifest } from "./serving-policy";

export const MAX_MANIFEST_BYTES = 512 * 1024;
export interface ManifestSnapshot { manifest: PublicationManifest | null; etag: string | null }
export type ManifestDownload = (etag: string | null, signal: AbortSignal) => Promise<{ status: 200; etag: string; bytes: Buffer } | { status: 304 }>;

export async function boundedBytes(stream: NodeJS.ReadableStream | undefined, max: number, signal: AbortSignal): Promise<Buffer> {
  if (!stream) throw new Error("Missing blob body");
  const body = stream as NodeJS.ReadableStream & AsyncIterable<Buffer> & { destroy(error?: Error): void };
  const abort = () => body.destroy(new Error("Blob read cancelled"));
  signal.throwIfAborted(); signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of body) {
      signal.throwIfAborted(); const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > max) throw new Error("Blob exceeds the serving limit");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener("abort", abort); body.destroy(); }
}

// Conditional GET uses a real offset with the bounded count, and never retries a broken stream.
// https://learn.microsoft.com/javascript/api/@azure/storage-blob/blobclient#@azure-storage-blob-blobclient-download
// https://learn.microsoft.com/javascript/api/@azure/storage-blob/blobdownloadoptions
export const manifestDownloadFrom = (blob: Pick<BlobClient, "download">): ManifestDownload => async (etag, signal) => {
  try {
    const r = await blob.download(0, MAX_MANIFEST_BYTES + 1, { conditions: etag ? { ifNoneMatch: etag } : {}, abortSignal: signal, maxRetryRequests: 0 });
    if (!r.etag) throw new Error("Manifest response has no ETag");
    const bytes = await boundedBytes(r.readableStreamBody, MAX_MANIFEST_BYTES, signal);
    return { status: 200, etag: r.etag, bytes };
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 304 && etag) return { status: 304 };
    throw e;
  }
};

export const downloadManifest: ManifestDownload = (etag, signal) => manifestDownloadFrom(blobs().getContainerClient(LIVE_CONTAINERS.manifests).getBlobClient(CURRENT_MANIFEST_BLOB))(etag, signal);

export class ManifestReader {
  private cached: ManifestSnapshot = { manifest: null, etag: null };
  private highWater = 0;
  private previous = "";
  private loading: Promise<ManifestSnapshot> | null = null;
  constructor(private readonly download: ManifestDownload = downloadManifest, private readonly commitments = configuredLiveSources) {}

  async read(options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<ManifestSnapshot> {
    options.signal?.throwIfAborted();
    // Publication is not activation: an empty revision commitment makes no storage call, even for fresh reads.
    if (!this.commitments().length) return { manifest: null, etag: null };
    // One refresh per process; an individual caller's disconnect must not poison other callers' refreshes.
    this.loading ??= this.refresh().finally(() => { this.loading = null; });
    const value = await this.loading;
    options.signal?.throwIfAborted();
    const manifest = projectLiveManifest(value.manifest, this.commitments());
    return manifest ? { manifest: structuredClone(manifest), etag: value.etag } : { manifest: null, etag: null };
  }
  private async refresh(): Promise<ManifestSnapshot> {
    try {
      const response = await this.download(this.cached.etag, AbortSignal.timeout(3_000));
      if (response.status === 304) {
        if (!this.cached.manifest || !this.cached.etag) throw new Error("Unexpected conditional response");
      } else {
        if (!response.etag || response.bytes.length > MAX_MANIFEST_BYTES) throw new Error("Invalid manifest response");
        const manifest = validateManifest(JSON.parse(response.bytes.toString("utf8")));
        const serialized = JSON.stringify(manifest);
        if (manifest.manifestVersion < this.highWater || (manifest.manifestVersion === this.highWater && serialized !== this.previous)) {
          throw new Error("Manifest generation was replayed or rewritten");
        }
        this.highWater = manifest.manifestVersion; this.previous = serialized;
        this.cached = { manifest, etag: response.etag };
      }
    } catch {
      // Do not retain a last-good manifest after a missing, invalid, inaccessible or timed-out current pointer.
      this.cached = { manifest: null, etag: null };
    }
    return this.cached;
  }
}
export const liveManifest = new ManifestReader();

export function clientManifest(publication: PublicationManifest | null, requiredSourceIds = [...configuredLiveSources()]) {
  const manifest = projectLiveManifest(publication, requiredSourceIds);
  return manifest ? {
    requiredSourceIds, enabled: true as const, manifestVersion: manifest.manifestVersion, createdAt: manifest.createdAt,
    sources: manifest.sources.map(({ sourceId, title, publisher, licence, attribution, sha256, extractionVersion, documents, wellLocation, v1DocIds }) =>
      ({ sourceId, title, publisher, licence, attribution, sha256, extractionVersion, documents, wellLocation, v1DocIds })),
  } : { requiredSourceIds, enabled: false as const, manifestVersion: null, createdAt: null, sources: [], reason: "Live publication unavailable" };
}
export type ClientManifest = ReturnType<typeof clientManifest>;
