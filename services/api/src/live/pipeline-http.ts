import { PIPELINE_LIMITS, PipelineError } from "./pipeline-config";
export async function boundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new PipelineError(502, `Upstream request failed (${response.status}).`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { await response.body.cancel(); throw new PipelineError(413, "Upstream body exceeds its bound."); }
  const reader = response.body.getReader(), chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength;
      if (total > maxBytes) throw new PipelineError(413, "Upstream body exceeds its bound."); chunks.push(Buffer.from(value)); }
    if (!total) throw new PipelineError(422, "Empty upstream response.");
    return Buffer.concat(chunks, total);
  } catch (e) { await reader.cancel().catch(() => {}); throw e; } finally { reader.releaseLock(); }
}
export const downloadPublisher = async (url: string, signal: AbortSignal, accept = "application/zip", maxBytes: number = PIPELINE_LIMITS.sourceBytes) =>
  boundedResponse(await fetch(url, { redirect: "error", signal, headers: { Accept: accept, "Accept-Encoding": "identity" } }), maxBytes);
