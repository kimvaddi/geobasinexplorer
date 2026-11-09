// Explicit operator-only republish/rollback of an earlier APPROVED extraction, through a fresh scan.
import { azurePipelineStore } from "../src/live/pipeline-store";
import { queueApprovedRepublish } from "../src/live/pipeline-publish";
const [sourceId, sha256, extractionVersion, confirm, ...extra] = process.argv.slice(2);
if (confirm !== "--queue-approved" || extra.length) throw new Error("Usage: live-rollback.mjs <sourceId> <landed sha256> <extractionVersion> --queue-approved");
const result = await queueApprovedRepublish(azurePipelineStore(), { sourceId, sha256, extractionVersion }, AbortSignal.timeout(30_000));
console.log(JSON.stringify({ ...result, sourceId, sha256, extractionVersion,
  note: result.queued ? "Explicit republish queued against the observed manifest generation. No chunks deleted. Coordinate the compatible serving revision separately." : "Already active; nothing was queued or changed." }));
