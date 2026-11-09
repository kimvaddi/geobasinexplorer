// Manual job only. Publisher allowlist and expected SHA-256 are both enforced before enqueue. A catalogue-record source is
// fetched from Geoscience Australia's eCat and rendered (src/live/catalogue-ecat.ts); its registered URL is the record's
// persistent identifier. An archive-member source is one PDF read out of the publisher's ZIP by byte-range requests
// (src/live/archive-member.ts); every other source is downloaded within its own registered bound.
//   live-connect.mjs [registered source id with a publisher URL; default ga-147461]
import "../src/otel";
import { sha256Of } from "../src/scan-verdict";
import { LIVE_TABLES } from "../src/live/contracts";
import { cfg } from "../src/config";
import { azurePipelineStore } from "../src/live/pipeline-store";
import { SOURCE_ARTIFACTS, allowedSource, isArchiveArtifact, landArtifact, sourceArtifact, sourceBytesFor, type SliceSourceId } from "../src/live/pipeline-registry";
import { downloadPublisher } from "../src/live/pipeline-http";
import { fetchArchiveMember } from "../src/live/archive-member";
import { ecatRecordArtifact } from "../src/live/catalogue-ecat";
import { CATALOGUE_RECORDS } from "../src/live/source-policy";
const args = process.argv.slice(2);
if (args.length > 1 || !cfg.aiEnabled) throw new Error("Run live-connect with at most one source id, only while AI is enabled.");
const id = (args[0] ?? "ga-147461") as SliceSourceId;
if (!Object.hasOwn(SOURCE_ARTIFACTS, id) || !SOURCE_ARTIFACTS[id].url.startsWith("https://")) throw new Error("The connector fetches only registered publisher URLs.");
if (sourceArtifact(id).ownerUpload) throw new Error("This source is landed through the owner upload route (PUT /api/admin/sources/:id/content), because its publisher refuses programmatic clients.");
const store = azurePipelineStore(), signal = AbortSignal.timeout(240_000);
const { source, etag } = await allowedSource(store, id, signal);
if (source.url !== SOURCE_ARTIFACTS[id].url) throw new Error("Connector publisher URL is not allowlisted.");
const ecatId = (CATALOGUE_RECORDS as Readonly<Record<string, string>>)[id], member = sourceArtifact(id).member;
const bytes = ecatId ? (await ecatRecordArtifact(ecatId, signal)).bytes
  : member ? await fetchArchiveMember(source.url, member, sourceBytesFor(id), signal)
  : await downloadPublisher(source.url, signal, isArchiveArtifact(id) ? "application/zip" : "application/pdf", sourceBytesFor(id));
if (sha256Of(bytes) === source.expectedSha256 && source.freshness !== "publisher-verified") {
  await store.put(LIVE_TABLES.sourceRegistry, { partitionKey: "source", rowKey: id, freshness: "publisher-verified", freshnessCheckedAt: new Date().toISOString() }, etag, signal);
}
console.log(JSON.stringify(await landArtifact(store, id, bytes, "id-gbx-pipeline", signal)));
