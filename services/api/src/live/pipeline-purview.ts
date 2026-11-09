import { sha256Of } from "../scan-verdict";
import { credential } from "../azure";
import type { LineageRow, SourceRegistry } from "./contracts";
import { boundedResponse } from "./pipeline-http";
// Data Curator is a Purview collection data-plane role, not an ARM Contributor assignment.
// https://learn.microsoft.com/purview/data-gov-classic-permissions
// Types are created only when absent; qualifiedName makes asset/process upserts idempotent.
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/type/bulk-create
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/entity/bulk-create-or-update
// All operations below use the 2023-09-01 Data Map surface and its documented OAuth audience.
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/type/get-entity-def-by-name
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/type/get-classification-def-by-name
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/type/bulk-create
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/entity/get-by-unique-attributes
// Process inputs/outputs create lineage via the same entity bulk operation, not an unversioned relationship API.
// https://learn.microsoft.com/rest/api/purview/datamapdataplane/entity/bulk-create-or-update
export const PURVIEW_API_VERSION = "2023-09-01";
export const PURVIEW_TOKEN_SCOPE = "https://purview.azure.net/.default";
const versionedPath = (path: string) => {
  const url = new URL(path, "https://datamap.invalid");
  url.searchParams.set("api-version", PURVIEW_API_VERSION);
  return `${url.pathname}${url.search}`;
};
export const PURVIEW_TYPES = [
  { name: "gbx_asset_v1", superTypes: ["DataSet"], typeVersion: "1.0", attributeDefs: [
    { name: "stage", typeName: "string", isOptional: false, cardinality: "SINGLE" },
    { name: "provenance", typeName: "string", isOptional: false, cardinality: "SINGLE" },
  ] },
  { name: "gbx_process_v1", superTypes: ["Process"], typeVersion: "1.0", attributeDefs: [] },
];
export const PURVIEW_CLASSIFICATIONS = [{ name: "gbx_cc_by_4_0_v1", typeVersion: "1.0", superTypes: [], attributeDefs: [] }, { name: "gbx_source_evidence_v1", typeVersion: "1.0", superTypes: [], attributeDefs: [] }];
type Request = (path: string, method: "GET" | "POST", body?: unknown) => Promise<Record<string, unknown> | null>;
export function lineagePayload(source: SourceRegistry, row: LineageRow, manifestVersion?: number) {
  const base = `geobasin://${row.sourceId}/${row.sha256}/${row.extractionVersion}`;
  const stages = ["source", "raw", "scan", "extraction", "silver", ...(manifestVersion === undefined ? [] : ["index", "manifest"])];
  const artifact = `geobasin://sources/${row.sourceId}/${row.sha256}`;
  const nodes = stages.map((stage) => {
    const qualifiedName = stage === "source" ? `geobasin://sources/${source.sourceId}`
      : stage === "raw" ? `${artifact}/raw/${encodeURIComponent(row.rawBlobVersionId)}`
      : stage === "scan" ? `${artifact}/scan/${sha256Of(Buffer.from(row.scanTagsJson))}`
      : stage === "manifest" ? `geobasin://manifests/v${manifestVersion}` : `${base}/${stage}`;
    const provenance = stage === "source" ? { sourceId: source.sourceId, licence: source.licence }
      : stage === "manifest" ? { manifestVersion, indexName: "gbx-evidence-v2" }
      : { sourceId: row.sourceId, sha256: row.sha256, extractionVersion: row.extractionVersion, rawBlobVersionId: row.rawBlobVersionId,
        scanVerdict: row.scanVerdict, scanSha256: row.scanSha256, scanTags: JSON.parse(row.scanTagsJson), archiveMembers: JSON.parse(row.archiveMembersJson),
        extractionRunId: row.extractionRunId, chunkCount: row.chunkCount, ...(manifestVersion === undefined ? {} : { manifestVersion }), licence: source.licence };
    return { typeName: "gbx_asset_v1", attributes: { qualifiedName, name: stage === "manifest" ? `GeoBasin publication v${manifestVersion}` : `${source.title} (${stage})`, stage,
      provenance: JSON.stringify(provenance) }, classifications: PURVIEW_CLASSIFICATIONS.map((c) => ({ typeName: c.name })) };
  });
  return { base, nodes, stages };
}
export async function pushPurviewLineage(source: SourceRegistry, row: LineageRow, manifestVersion: number | undefined, signal: AbortSignal, transport?: Request) {
  const endpoint = process.env.PURVIEW_ENDPOINT, collection = process.env.PURVIEW_COLLECTION_ID;
  if (!transport && (!collection || !/^[A-Za-z0-9_-]{1,128}$/.test(collection))) throw new Error("Purview collection is not configured; publication stays closed.");
  const bulkPath = `/entity/bulk?api-version=2023-09-01${collection ? `&collectionId=${encodeURIComponent(collection)}` : ""}`;
  if (!transport && (!endpoint || !/^https:\/\/[a-z0-9-]+\.purview\.azure\.com\/?$/.test(endpoint))) throw new Error("Purview endpoint is not configured; publication stays closed.");
  const send: Request = transport ?? (async (path, method, body) => {
    const token = await credential.getToken(PURVIEW_TOKEN_SCOPE, { abortSignal: signal });
    if (!token) throw new Error("Purview identity token unavailable.");
    const response = await fetch(`${endpoint!.replace(/\/$/, "")}/datamap/api/atlas/v2${path}`, { method, signal, redirect: "error",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (method === "GET" && response.status === 404) return null;
    return JSON.parse((await boundedResponse(response, 4 * 1024 * 1024)).toString());
  });
  const request: Request = (path, method, body) => send(versionedPath(path), method, body);
  for (const [kind, defs] of [["entity", PURVIEW_TYPES], ["classification", PURVIEW_CLASSIFICATIONS]] as const) for (const def of defs) {
    const existing = await request(`/types/${kind}def/name/${def.name}`, "GET");
    if (existing) { if (existing.name !== def.name || existing.typeVersion !== def.typeVersion) throw new Error("Unexpected existing Purview type version."); }
    else await request("/types/typedefs", "POST", { [kind === "entity" ? "entityDefs" : "classificationDefs"]: [def] });
  }
  const { base, nodes } = lineagePayload(source, row, manifestVersion);
  await request(bulkPath, "POST", { entities: nodes });
  const ids = await Promise.all(nodes.map(async (node) => {
    const result = await request(`/entity/uniqueAttribute/type/gbx_asset_v1?attr:qualifiedName=${encodeURIComponent(node.attributes.qualifiedName)}&api-version=2023-09-01`, "GET");
    const guid = (result?.entity as { guid?: unknown } | undefined)?.guid;
    if (typeof guid !== "string" || !guid) throw new Error("Purview asset upsert could not be verified."); return { guid, typeName: "gbx_asset_v1" };
  }));
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], ...(manifestVersion === undefined ? [] : [[4, 5], [5, 6]])];
  await request(bulkPath, "POST", { entities: edges.map(([from, to]) => ({ typeName: "gbx_process_v1", attributes: {
    qualifiedName: `${base}/process/${from}-${to}${to === 6 ? `/v${manifestVersion}` : ""}`, name: `GeoBasin ${nodes[from].attributes.stage} to ${nodes[to].attributes.stage}`,
    inputs: [ids[from]], outputs: [ids[to]],
  } })) });
}
