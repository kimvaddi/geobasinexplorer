import { cfg } from "../config";
export const PIPELINE_TABLES = { jobs: "pipelinejobs", versions: "sourceversions" } as const;
export const PIPELINE_LIMITS = {
  sourceBytes: 60_000_000, expandedBytes: 200 * 1024 * 1024, archiveEntries: 64,
  // The most a registered publisher file may be given as its own bound (SOURCE_ARTIFACTS maxBytes), for reports that
  // exceed 60 MB. Document Intelligence's layout model accepts 500 MB on the S0 tier; the owner upload route keeps 60 MB.
  maxSourceBytes: 128_000_000,
  // jsonBytes covers the full Document Intelligence layout result: the 420-page Marabooka 1 report exceeded the
  // first 32 MiB cap in Azure (2 Nov 2026). 128 MiB keeps headroom inside the processor's 4 GiB.
  pages: 500, chunks: 20_000, textChars: 20_000_000, jsonBytes: 128 * 1024 * 1024, imageBytes: 12 * 1024 * 1024,
  // Conservative envelope: 420 pages * 60 s + 60 min DI + 60 min persistence/embedding = 9 h.
  // Ten-hour application deadline, eleven-hour replica, then lease/queue slack. This is a bound, not a measured SLA.
  renderPageMs: 60_000, analysisMs: 60 * 60_000,
  jobMs: 10 * 60 * 60_000, replicaTimeoutSeconds: 11 * 60 * 60,
  leaseMs: (11 * 60 + 10) * 60_000, queueVisibilitySeconds: (11 * 60 + 15) * 60, publicationMs: 240_000,
} as const;
// Bump implementation whenever extraction code changes. The digest includes the exact native renderer version too.
export const recipe = (rendererVersion: string) => ({
  implementation: "phase1b-layout-3", documentIntelligence: { model: "prebuilt-layout", apiVersion: "2024-11-30", stringIndexType: "utf16CodeUnit" },
  chunker: { version: 1, maxChars: 3500, overlap: 0, pageBounded: true, headings: "sections-and-paragraphs" },
  renderer: { tool: "pdftoppm", version: rendererVersion, packageVersion: process.env.GBX_POPPLER_PACKAGE_VERSION ?? "local-unpinned", dpi: 110, maxDimension: 2200, format: "png" },
  embedding: { model: cfg.models.embed, deployment: cfg.deployments.embed, dimensions: 3072 },
});
export class PipelineError extends Error { constructor(public status: number, message: string) { super(message); this.name = "PipelineError"; } }
export const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;
export const escapeFilter = (s: string) => s.replace(/'/g, "''");
export const checkSignal = (signal?: AbortSignal) => signal?.throwIfAborted();
