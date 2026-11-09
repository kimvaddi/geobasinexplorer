import { isUnexpected } from "@azure-rest/ai-document-intelligence";
import { blobs, docIntel, embed } from "../azure";
import { cfg } from "../config";
import { keys, reserve, settle, takeBoth } from "../usage";
import { readScannedBlob, readUnscannedBlob } from "../scan-verdict";
import { analysisResultId, analyzeOnce, LAYOUT_API_VERSION, LAYOUT_MODEL } from "./pipeline-analysis";
import { PIPELINE_LIMITS, PipelineError } from "./pipeline-config";
import { pdfPageCount, renderPages, rendererVersion } from "./pipeline-native";
import { pushPurviewLineage } from "./pipeline-purview";
import type { PipelineServices } from "./pipeline-types";
// https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/layout
// https://learn.microsoft.com/javascript/api/overview/azure/ai-document-intelligence-rest-readme
export function azurePipelineServices(): PipelineServices {
  return {
    scan: (blob, expectedSha256, signal, maxBytes = PIPELINE_LIMITS.sourceBytes) => {
      const client = blobs().getContainerClient("quarantine").getBlobClient(blob), options = { expectedSha256, signal, maxBytes };
      return cfg.live.scan ? readScannedBlob(client, options) : readUnscannedBlob(client, options);
    },
    rendererVersion, countPages: pdfPageCount, render: renderPages, catalogue: pushPurviewLineage,
    async analyze(bytes, pages, signal, checkpoint) {
      if (!cfg.aiEnabled) throw new Error("AI is switched off.");
      const client = docIntel({ apiVersion: LAYOUT_API_VERSION, retryOptions: { maxRetries: 0 } });
      return analyzeOnce(bytes, pages, checkpoint, {
        bookPages: (count) => takeBoth(keys.ocrPages, count, cfg.caps.ocrPagesPerDay, cfg.caps.ocrPagesPerMonth, "OCR pages"),
        async submit(input, requestId, abortSignal) {
          const initial = await client.path("/documentModels/{modelId}:analyze", LAYOUT_MODEL).post({ contentType: "application/octet-stream", body: input,
            queryParameters: { stringIndexType: "utf16CodeUnit" }, headers: { "x-ms-client-request-id": requestId }, abortSignal });
          if (isUnexpected(initial)) throw new PipelineError(502, `Layout submission refused (${initial.status}); no automatic resubmission.`);
          return analysisResultId(initial.headers["operation-location"], cfg.docIntelEndpoint());
        },
        async result(resultId, abortSignal) {
          const response = await client.path("/documentModels/{modelId}/analyzeResults/{resultId}", LAYOUT_MODEL, resultId).get({ abortSignal });
          if (isUnexpected(response)) throw new PipelineError(response.status === "404" ? 409 : 503, "Saved analysis result could not be read; it will not be resubmitted.");
          const retryAfter = response.headers["retry-after"];
          return { status: response.body.status, result: response.body.analyzeResult, ...(retryAfter === undefined ? {} : { retryAfterMs: Number(retryAfter) * 1000 }) };
        },
      }, signal);
    },
    async embeddings(texts, signal) {
      if (!cfg.aiEnabled) throw new Error("AI is switched off.");
      const bound = texts.reduce((n, t) => n + Buffer.byteLength(t, "utf8") + 8, 0);
      const reservation = await reserve(keys.tokens, bound, cfg.caps.tokensPerDay, cfg.caps.tokensPerMonth, "embedding tokens");
      let used: number | null = null;
      try { return await embed(texts, { signal, maxRetries: 0, onUsage: (n) => { if (!Number.isSafeInteger(n) || n < 0 || n > bound) throw new Error("Embedding usage exceeded the reserved bound."); used = n; } }); }
      finally { await settle(reservation, used); }
    },
  };
}
