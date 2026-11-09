import type { AnalysisCheckpoint } from "./pipeline-analysis";
import type { AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import type { SourceReviewRow, ExtractionRef, SilverDocumentRecord, SilverPageRecord, LineageRow, SourceRegistry } from "./contracts";
import type { ScannedBuffer } from "../scan-verdict";
export type PublicationStatus = "pending" | "queued" | "published" | "failed";
export type PipelineReviewRow = SourceReviewRow & { jobId: string; registryEtag: string; publicationStatus: PublicationStatus; publishedManifestVersion?: number; indexedManifestVersion?: number; detail?: string };
export interface ExtractionBundle extends ExtractionRef {
  registryEtag: string; jobId: string; createdAt: string;
  documents: { record: SilverDocumentRecord; blob: string; pages: string[]; chunks: string[] }[];
}
export interface PipelineServices {
  scan(blob: string, expectedSha256: string, signal: AbortSignal, maxBytes?: number): Promise<ScannedBuffer>;
  rendererVersion(signal: AbortSignal): Promise<string>;
  countPages(bytes: Buffer, signal: AbortSignal): Promise<number>;
  analyze(bytes: Buffer, pages: number, signal: AbortSignal, checkpoint: AnalysisCheckpoint): Promise<AnalyzeResultOutput>;
  render(bytes: Buffer, pages: SilverPageRecord[], consume: (page: SilverPageRecord, png: Buffer) => Promise<void>, signal: AbortSignal): Promise<void>;
  embeddings(texts: string[], signal: AbortSignal): Promise<number[][]>;
  catalogue(source: SourceRegistry, lineage: LineageRow, manifestVersion: number | undefined, signal: AbortSignal): Promise<void>;
}
