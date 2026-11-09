// Explicit operator retry of incomplete extraction, preserving operation/result/image checkpoints.
import { azurePipelineStore } from "../src/live/pipeline-store";
import { queueProcessingRetry } from "../src/live/pipeline-retry";
const [jobId, confirm, ...extra] = process.argv.slice(2);
if (confirm !== "--rescan-processing" || extra.length) throw new Error("Usage: live-retry.mjs <jobId> --rescan-processing");
console.log(JSON.stringify(await queueProcessingRetry(azurePipelineStore(), jobId, AbortSignal.timeout(30_000))));
