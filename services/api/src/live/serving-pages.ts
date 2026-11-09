import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { User } from "../auth";
import { blobs } from "../azure";
import { LIVE_CONTAINERS, LIVE_ROUTES, SHA256_PATTERN, SOURCE_ID_PATTERN, pageImageBlobName, type PublicationManifest } from "./contracts";
import { boundedBytes, clientManifest, liveManifest, type ManifestReader } from "./serving-manifest";

import { configuredLiveSources, projectLiveManifest } from "./serving-policy";

const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function activePage(manifest: PublicationManifest | null, sourceId: string, documentSha256: string, page: number) {
  if (!new RegExp(SOURCE_ID_PATTERN).test(sourceId) || !new RegExp(SHA256_PATTERN).test(documentSha256) || !Number.isSafeInteger(page) || page < 1) return null;
  const source = manifest?.sources.find((s) => s.sourceId === sourceId);
  const document = source?.documents.find((d) => d.sha256 === documentSha256 && page <= d.pageCount);
  return source && document ? { source, document, page } : null;
}
export type PageDownload = (blobName: string, signal: AbortSignal) => Promise<Buffer>;
export const downloadPage: PageDownload = async (name, signal) => {
  // The SDK exposes a Node readable stream; no account URL, SAS, redirects or user-selected blob paths are returned.
  // https://learn.microsoft.com/azure/storage/blobs/storage-blob-download-javascript
  const r = await blobs().getContainerClient(LIVE_CONTAINERS.pages).getBlobClient(name)
    .download(0, MAX_PAGE_BYTES + 1, { abortSignal: signal, maxRetryRequests: 0 });
  return boundedBytes(r.readableStreamBody, MAX_PAGE_BYTES, signal);
};
export function registerLiveServingRoutes(app: FastifyInstance, who: (request: FastifyRequest) => User,
  reader: Pick<ManifestReader, "read"> = liveManifest, download: PageDownload = downloadPage, commitments = configuredLiveSources) {
  app.get(LIVE_ROUTES.manifest.path, async (req, reply) => {
    who(req); reply.header("Cache-Control", "private, no-store");
    const configured = commitments();
    return clientManifest(configured.length ? (await reader.read()).manifest : null, [...configured]);
  });
  app.get<{ Params: { sourceId: string; sha256: string; page: string } }>(LIVE_ROUTES.page.path, async (req, reply) => {
    who(req); reply.header("Cache-Control", "private, no-store");
    const missing = () => reply.code(404).send({ error: "Page not published." });
    const { sourceId, sha256, page } = req.params;
    if (!commitments().includes(sourceId) || !/^[1-9]\d{0,9}$/.test(page)) return missing();
    const cancel = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) cancel.abort(); };
    req.raw.once("aborted", abort); reply.raw.once("close", abort);
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]);
    try {
      const current = await reader.read({ fresh: true, signal });
      const ref = activePage(projectLiveManifest(current.manifest, commitments()), sourceId, sha256, Number(page));
      if (!ref) return missing();
      const bytes = await download(pageImageBlobName({ sourceId, sha256, extractionVersion: ref.source.extractionVersion, page: ref.page }), signal);
      if (bytes.length > MAX_PAGE_BYTES || !bytes.subarray(0, PNG.length).equals(PNG)) return missing();
      // A withdrawal or rollback during the image read must not serve a page from the superseded extraction.
      const latest = activePage(projectLiveManifest((await reader.read({ fresh: true, signal })).manifest, commitments()), sourceId, sha256, ref.page);
      if (!latest || latest.source.sha256 !== ref.source.sha256 || latest.source.extractionVersion !== ref.source.extractionVersion) return missing();
      return reply.type("image/png").header("X-Content-Type-Options", "nosniff").send(Readable.from(bytes));
    } catch { return missing(); }
    finally { req.raw.off("aborted", abort); reply.raw.off("close", abort); }
  });
}
