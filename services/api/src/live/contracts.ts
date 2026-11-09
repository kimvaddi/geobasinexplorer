// Live-lane contracts only . Resource access, approval and publication are not implemented here.
import type { TableEntity } from "@azure/data-tables";
import type { Passage } from "../azure";
import type { GeoFields, Near } from "../geo";
import { LICENCE } from "../licence";

export const LIVE_TABLES = {
  sourceRegistry: "sourceregistry", reviews: "sourcereviews", lineage: "lineage",
  documents: "silverdocuments", pages: "silverpages", chunks: "silverchunks",
} as const;
export const LIVE_CONTAINERS = {
  quarantine: "quarantine", raw: "raw", processed: "processed", pages: "pages", manifests: "manifests",
} as const;
export const LIVE_QUEUES = { scan: "scan-jobs", ingest: "ingest-jobs", process: "process-jobs" } as const;
export const SCAN_ROUTES = [LIVE_QUEUES.ingest, LIVE_QUEUES.process] as const;
export const DEFAULT_SCAN_ROUTE = LIVE_QUEUES.ingest;
export const LIVE_INDEX_NAME = "gbx-evidence-v2";
export const REVIEW_REASON_MAX_LENGTH = 500;
// the first sources, then the documents cleared on 4 Nov 2026. Keep in step with source-policy.ts.
export const LIVE_SOURCE_IDS = ["ga-147461", "peps-sa-marabooka-1", "ga-147459", "ga-147460", "ga-147462", "peps-sa-habanero-1",
  "ga-144233", "ga-133023-points", "ga-145744", "ga-147688", "ga-146380", "ga-81486", "ga-ecat-133023", "ga-ecat-145744", "ga-ecat-147688",
  "ga-ecat-148588", "ga-ecat-67240", "ga-ecat-65388", "ga-ecat-126310", "ga-ecat-100520",
  "ga-74123-userguide", "ga-74123-inversion", "ga-74123-fugro", "ga-74123-metadata", "ga-ecat-74123", "ga-ecat-65384", "ga-ecat-84308",
  "ga-132709", "ga-ecat-132709", "ga-149375", "ga-ecat-149375", "ga-145984-report", "ga-ecat-145984", "ga-ecat-144778", "ga-ecat-144775",
  "ga-ecat-144783", "ga-144414", "ga-ecat-144414", "ga-67212-fugro", "ga-ecat-67212", "ga-68792-methodology", "ga-68792-userguide",
  "ga-ecat-68792", "ga-67211-report", "ga-ecat-67211", "ga-74137-userguide", "ga-74137-inversion", "ga-ecat-74137", "ga-69470",
  "ga-ecat-69470", "ga-69190", "ga-ecat-69190", "ga-70711", "ga-ecat-70711", "ga-65704", "ga-ecat-65704", "ga-ecat-65395", "ga-ecat-65231",
  "ga-ecat-140140", "ga-ecat-140141", "ga-ecat-75582", "ga-112283-metadata", "ga-ecat-112283", "ga-ecat-123889", "ga-116461",
  "ga-ecat-116461", "ga-ecat-114642", "linz-s25000", "linz-s25002", "linz-s25009", "linz-g25700", "linz-g25702", "linz-g25703", "linz-itrf-nzgd2000", "icsm-gda2020-manual", "nzpam-basins-part-one", "nzpam-basins-part-two", "linz-hannah-2001"] as const;
export const SOURCE_REGISTRY_DEFAULTS = { publishAllowed: false, freshness: "NOT VERIFIED" } as const;
// current.json holds the full same manifest as v<N>.json, replaced only with the current ETag.
export const CURRENT_MANIFEST_BLOB = "current.json";

// Matches the unshortened embeddings returned by azure.ts embed().
// https://learn.microsoft.com/azure/search/cognitive-search-skill-azure-openai-embedding#supported-dimensions-by-modelname
export const LIVE_VECTOR_DIMENSIONS = 3072;

export const LIVE_ROUTES = {
  sourceContent: { method: "PUT", path: "/api/admin/sources/:id/content" },
  reviews: { method: "GET", path: "/api/admin/live/reviews" },
  review: { method: "GET", path: "/api/admin/live/reviews/:sourceId/:sha256/:extractionVersion" },
  reviewDecision: { method: "POST", path: "/api/admin/live/reviews/:sourceId/:sha256/:extractionVersion/decision" },
  // Pending images are owner-only, bound to the review rather than the public manifest.
  reviewPage: { method: "GET", path: "/api/admin/live/reviews/:sourceId/:sha256/:extractionVersion/pages/:documentSha256/:page" },
  // Streams image/png with Cache-Control private, no-store. sha256 is the PDF hash, not its archive hash.
  page: { method: "GET", path: "/api/pages/:sourceId/:sha256/:page" },
  manifest: { method: "GET", path: "/api/live/manifest" },
} as const;

// Base64 UTF-8 JSON, forwarded unchanged after any final verdict. A message never proves a clean scan.
// blob is a quarantine-relative name: sources/<sourceId>/<landed sha256>/<original basename>.
export interface ScanJobMessage { jobId: string; blob: string; owner: string; route?: typeof SCAN_ROUTES[number] }
export type ProcessJobMessage = ScanJobMessage & { route: typeof LIVE_QUEUES.process };

export const SHA256_PATTERN = "^[a-f0-9]{64}$";
export const SOURCE_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
// The recipe digest pins extractor/model/API, chunking, rendering and embedding settings; UUID v4 identifies a run.
export const EXTRACTION_VERSION_PATTERN = "^layout-v1-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$";
export interface ExtractionRef { sourceId: string; sha256: string; extractionVersion: string }
// sha256 always identifies the landed bytes; documentSha256 identifies the extracted PDF (equal for a plain PDF).
export interface DocumentRef extends ExtractionRef { docId: string; documentSha256: string }
export type WellLocation = Pick<Near, "lon" | "lat"> & { datum: "GDA94" };
export interface SourceRegistry {
  sourceId: string; publisher: string; title: string; url: `https://${string}` | "bundle-copy";
  licence: string; attribution: string; expectedSha256: string; publishAllowed: boolean; licenceBasis: string;
  freshness: "NOT VERIFIED" | "publisher-verified"; wellLocation: WellLocation | null; v1DocIds: string[];
}

// Table properties are scalars; nested metadata is JSON text. Large silver bodies live in processed, not table cells.
// https://learn.microsoft.com/rest/api/storageservices/understanding-the-table-service-data-model#property-types
// https://learn.microsoft.com/javascript/api/@azure/data-tables/tableentity
// Registry: partitionKey="source", rowKey=sourceId. Missing publishAllowed must be read as false, never as approval.
export type SourceRegistryRow = TableEntity<Omit<SourceRegistry, "wellLocation" | "v1DocIds"> & {
  wellLocationJson: string; v1DocIdsJson: string;
}> & { partitionKey: "source" };

export interface StewardDecision extends ExtractionRef { decision: "approved" | "rejected"; reason: string }
// by and at are server-set from the authenticated owner; requests require the review's If-Match ETag.
export type StewardDecisionRecord = StewardDecision & { by: string; at: string };
export interface ConfidenceStatistics { minimum: number | null; mean: number | null; measuredPages: number; lowConfidencePages: number }
export interface SourceReview extends ExtractionRef {
  status: "pending" | "approved" | "rejected"; createdAt: string; pageCount: number; chunkCount: number;
  confidence: ConfidenceStatistics; sampleChunkIds: string[]; decision: StewardDecisionRecord | null;
}
// Reviews and lineage: partitionKey=sourceId, rowKey=<sha256>_<extractionVersion>.
export type SourceReviewRow = TableEntity<Omit<SourceReview, "confidence" | "sampleChunkIds" | "decision"> & {
  confidenceJson: string; sampleChunkIdsJson: string; decisionJson: string;
}>;
export interface ClamAvTags {
  "gbx-clamav-scan-result": "No threats found" | "Malicious" | "Error";
  "gbx-clamav-sha256": string; "gbx-clamav-engine": string; "gbx-clamav-signature-version": string;
  "gbx-clamav-signature-date": string; "gbx-clamav-scanned-at": string;
}
export interface ArchiveMember { name: string; sha256: string; bytes: number }
export type LineageRow = TableEntity<ExtractionRef & {
  rawBlob: string; rawBlobVersionId: string; scanVerdict: ClamAvTags["gbx-clamav-scan-result"] | "Not scanned"; scanSha256: string;
  scanTagsJson: string; archiveMembersJson: string; extractionRunId: string; chunkCount: number;
  indexName?: typeof LIVE_INDEX_NAME; manifestVersion?: number; purviewQualifiedName: string;
}>;

export interface BoundingRegion { page: number; polygon: number[]; unit: "inch" | "pixel" }
export interface BoundingRegionSummary { page: number; x: number; y: number; width: number; height: number; unit: BoundingRegion["unit"] }
export interface SilverDocumentRecord extends DocumentRef {
  title: string; originalName: string; memberName: string | null; rawBlob: string; rawBlobVersionId: string;
  layoutBlob: string; pageCount: number; chunkCount: number; confidence: ConfidenceStatistics;
  licence: string; attribution: string;
}
export interface SilverPageRecord extends DocumentRef {
  page: number; text: string; width: number; height: number; unit: BoundingRegion["unit"];
  headingPath: string[]; boundingRegions: BoundingRegion[]; imageBlob: string; confidence: number | null;
}
// Stored points retain the geo.ts coordinates without serializing an SDK class; rebuild GeographyPoint for Search.
export type StoredGeoFields = Omit<GeoFields, "points"> & { points: Pick<GeoFields["points"][number], "longitude" | "latitude">[] };
// id=<sourceId>_<sha256>_<extractionVersion>_<documentSha256>_c<ordinal>, unique across extractions.
export interface SilverChunkRecord extends DocumentRef, StoredGeoFields,
  Pick<Passage, "id" | "page" | "text" | "vector" | "basin" | "well" | "visibility" | "owner"> {
  headingPath: string[]; boundingRegions: BoundingRegion[]; boundingRegionsSummary: BoundingRegionSummary[];
  licence: string; attribution: string;
}
// Silver partitionKey=<sourceId>_<sha256>_<extractionVersion>; rowKey=docId, <docId>_p<page>, or chunk id respectively.
// recordBlob is a processed-relative JSON path; keep page text, geometry and vectors out of 64-KiB table properties.
export type SilverDocumentRow = TableEntity<DocumentRef & { recordBlob: string; pageCount: number; chunkCount: number }>;
export type SilverPageRow = TableEntity<DocumentRef & { page: number; recordBlob: string; imageBlob: string }>;
export type SilverChunkRow = TableEntity<DocumentRef & { id: string; page: number; recordBlob: string }>;

// Index id is the stable silver chunk id. Approved extractions are retained; serving filters manifest tuples, not manifestVersion.
// The live lane publishes only cleared public sources. owner/docId remain present for geo.ts accessFilter compatibility.
export interface LiveEvidenceRecord extends Omit<SilverChunkRecord, "points" | "boundingRegions" | "visibility" | "vector">, GeoFields {
  vector: number[]; publishAllowed: true; manifestVersion: number; visibility: "public";
}
export const LIVE_INDEX_FIELDS = [
  "id", "sourceId", "sha256", "extractionVersion", "documentSha256", "docId", "page", "headingPath", "text", "vector",
  "boundingRegionsSummary", "points", "places", "placeHow", "geoBasins", "geotag", "basin", "well", "licence", "attribution",
  "publishAllowed", "manifestVersion", "visibility", "owner",
] as const satisfies readonly (keyof LiveEvidenceRecord)[];

// This small, closed JSON Schema vocabulary is also the runtime validator's only vocabulary.
type Schema =
  | { const: string | number | boolean }
  | { enum: readonly string[] }
  | { type: "string"; minLength: number; maxLength: number; pattern?: string; format?: "date-time" | "uri" }
  | { type: "integer" | "number"; minimum: number; maximum: number }
  | { type: "null" }
  | { type: "array"; items: Schema; minItems: number; maxItems: number; uniqueItems?: true }
  | { type: "object"; properties: Record<string, Schema>; required: readonly string[]; additionalProperties: false }
  | { anyOf: readonly Schema[] };
type SchemaValue<S> = S extends { const: infer V } ? V : S extends { enum: readonly (infer V)[] } ? V
  : S extends { anyOf: readonly (infer V)[] } ? SchemaValue<V>
  : S extends { type: "object"; properties: infer P } ? { -readonly [K in keyof P]: SchemaValue<P[K]> }
  : S extends { type: "array"; items: infer V } ? SchemaValue<V>[]
  : S extends { type: "string" } ? string : S extends { type: "null" } ? null : number;
const object = <const P extends Record<string, Schema>>(properties: P) =>
  ({ type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false as const });
const array = <const S extends Schema>(items: S, minItems: number, maxItems: number) => ({ type: "array" as const, items, minItems, maxItems });
const text = { type: "string", minLength: 1, maxLength: 2048, pattern: "\\S" } as const;
const hash = { ...text, pattern: SHA256_PATTERN, maxLength: 64 } as const;
const extractionVersion = { ...text, pattern: EXTRACTION_VERSION_PATTERN, maxLength: 111 } as const;
const identifier = { ...text, pattern: "^[a-z0-9][a-z0-9_-]{0,127}$", maxLength: 128 } as const;
const timestamp = { ...text, format: "date-time", maxLength: 24 } as const;
const positiveInteger = { type: "integer", minimum: 1, maximum: 2_147_483_647 } as const;
const extraction = { sourceId: { enum: LIVE_SOURCE_IDS }, sha256: hash, extractionVersion } as const;
const wellLocation = object({
  lon: { type: "number", minimum: 100, maximum: 170 }, lat: { type: "number", minimum: -50, maximum: 0 }, datum: { const: "GDA94" },
});

// The manifest contains no storage URLs or arbitrary paths. Paths are derived from immutable identities below.
// Always call validateManifest: the schema alone cannot check licence policy, cross-field bindings or version advancement.
// An archive has one reviewed source entry and one document entry per published PDF, with native 1-based page numbers.
export const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...object({
    schemaVersion: { const: 1 }, manifestVersion: positiveInteger, createdAt: timestamp, indexName: { const: LIVE_INDEX_NAME },
    sources: array(object({
      ...extraction, publisher: text, title: text,
      url: { anyOf: [{ const: "bundle-copy" }, { ...text, format: "uri", pattern: "^https://" }] },
      licence: text, attribution: text, licenceBasis: text, publishAllowed: { const: true }, visibility: { const: "public" },
      // Packaged documents this source replaces; none when it has no packaged counterpart (Habanero 1).
      v1DocIds: { ...array(identifier, 0, 128), uniqueItems: true },
      wellLocation: { anyOf: [wellLocation, { type: "null" }] },
      documents: array(object({ docId: identifier, sha256: hash, title: text, pageCount: positiveInteger, chunkCount: positiveInteger }), 1, 128),
      approval: object({ ...extraction, decision: { const: "approved" }, reason: text, by: text, at: timestamp }),
    }), 1, LIVE_SOURCE_IDS.length),
  }),
} as const;
export type PublicationManifest = SchemaValue<typeof MANIFEST_SCHEMA>;
export type ManifestSource = PublicationManifest["sources"][number];
export type ManifestDocument = ManifestSource["documents"][number];

export class ManifestValidationError extends Error {
  constructor(path: string, reason: string) { super(`Invalid publication manifest at ${path}: ${reason}`); this.name = "ManifestValidationError"; }
}
function invalid(path: string, reason: string): never { throw new ManifestValidationError(path, reason); }

function check(schema: Schema, value: unknown, path: string): void {
  if ("const" in schema) { if (value !== schema.const) invalid(path, "unexpected value"); return; }
  if ("enum" in schema) { if (typeof value !== "string" || !schema.enum.includes(value)) invalid(path, "unexpected value"); return; }
  if ("anyOf" in schema) {
    for (const choice of schema.anyOf) {
      try { check(choice, value, path); return; } catch (e) { if (!(e instanceof ManifestValidationError)) throw e; }
    }
    invalid(path, "no permitted shape matches");
  }
  switch (schema.type) {
    case "null": if (value !== null) invalid(path, "expected null"); return;
    case "string": {
      if (typeof value !== "string" || value.length < schema.minLength || value.length > schema.maxLength
        || (schema.pattern && !new RegExp(schema.pattern).test(value))) invalid(path, "invalid string");
      if (schema.format === "date-time") {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))
          || new Date(value).toISOString() !== value.replace(/(?<!\.\d{3})Z$/, ".000Z")) invalid(path, "expected a real UTC timestamp");
      }
      if (schema.format === "uri") safeHttpsUrl(value, path);
      return;
    }
    case "integer": case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum
        || (schema.type === "integer" && !Number.isSafeInteger(value))) invalid(path, "invalid number");
      return;
    case "array":
      if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) invalid(path, "invalid array");
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) invalid(path, "expected a plain dense array");
      for (let i = 0; i < value.length; i++) {
        if (!Object.getOwnPropertyDescriptor(value, String(i))?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i))!, "value")) invalid(path, "unexpected array property");
        check(schema.items, value[i], `${path}[${i}]`);
      }
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) invalid(path, "duplicate items");
      return;
    case "object": {
      if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid(path, "expected a plain JSON object");
      const record = value as Record<string, unknown>;
      if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key))) invalid(path, "unknown field");
      for (const key of schema.required) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid(`${path}.${key}`, "missing field or non-JSON property");
        check(schema.properties[key], descriptor.value, `${path}.${key}`);
      }
      return;
    }
  }
}

function safeHttpsUrl(value: string, path: string): void {
  let url: URL;
  try { url = new URL(value); } catch { invalid(path, "invalid URL"); }
  if (!/^https:\/\//i.test(value) || url.protocol !== "https:" || url.username || url.password || /[\s\\]/u.test(value)
    || /(?:^|\.)(?:blob|dfs)(?:\.|$)/i.test(url.hostname) || [...url.searchParams.keys()].some((key) => key.toLowerCase() === "sig")) {
    invalid(path, "only HTTPS publisher URLs without storage endpoints, credentials or SAS are permitted");
  }
}

// Apply URL policy to every string, including embedded links in attribution, titles and approval notes.
function safeStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    let decoded = value;
    for (let layer = 0; layer < 4; layer++) {
      if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(decoded) || /(?<!:)\/\//u.test(decoded)) invalid(path, "unsafe string or protocol-relative URL");
      if (/\b(?:http|ftp|ftps|file|blob|data|javascript|vbscript|mailto|tel|urn):/i.test(decoded)) invalid(path, "non-HTTPS URL");
      for (const match of decoded.matchAll(/\b[a-z][a-z0-9+.-]*:(?=\S)/gi)) {
        const url = decoded.slice(match.index).match(/^[^\s"'<>]+/)![0];
        safeHttpsUrl(url, path);
      }
      if (!/%[0-9a-f]{2}/i.test(decoded)) return;
      let next: string;
      try { next = decodeURIComponent(decoded); } catch { invalid(path, "invalid URL encoding"); }
      if (next === decoded) return;
      decoded = next;
    }
    invalid(path, "too many URL encoding layers");
  }
  if (Array.isArray(value)) value.forEach((v, i) => safeStrings(v, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) safeStrings(v, `${path}.${k}`);
}

// Reads use the default baseline. Activation MUST pass the current pointer's version and use its ETag.
// Rollback is a new, higher manifest generation; do not lower the version or rewrite the old index generation.
// Validation does not prove registry state, approval authenticity, page existence or index readiness.
export function validateManifest(value: unknown, previousVersion = 0): PublicationManifest {
  if (!Number.isSafeInteger(previousVersion) || previousVersion < 0 || previousVersion > positiveInteger.maximum) invalid("previousVersion", "invalid baseline");
  check(MANIFEST_SCHEMA, value, "manifest");
  safeStrings(value, "manifest");
  if (LICENCE.referencesWithheld(value)) invalid("manifest", "withheld source or derivative");
  const manifest = value as PublicationManifest;
  if (manifest.manifestVersion <= previousVersion) invalid("manifest.manifestVersion", "version must increase");
  const sourceIds = new Set<string>(), docIds = new Set<string>(), v1DocIds = new Set<string>();
  for (const source of manifest.sources) {
    if (sourceIds.has(source.sourceId)) invalid("manifest.sources", "duplicate source");
    sourceIds.add(source.sourceId);
    if (source.sourceId === "peps-sa-marabooka-1" && !source.wellLocation) invalid("manifest.sources.wellLocation", "Marabooka 1 requires its live geotag");
    for (const key of ["sourceId", "sha256", "extractionVersion"] as const) {
      if (source.approval[key] !== source[key]) invalid("manifest.sources.approval", "decision is not bound to this extraction");
    }
    if (Date.parse(source.approval.at) > Date.parse(manifest.createdAt)) invalid("manifest.sources.approval.at", "approval follows publication");
    const hashes = new Set<string>();
    for (const document of source.documents) {
      if (docIds.has(document.docId) || hashes.has(document.sha256)) invalid("manifest.sources.documents", "ambiguous document or page identity");
      docIds.add(document.docId); hashes.add(document.sha256);
    }
    for (const id of source.v1DocIds) {
      if (v1DocIds.has(id)) invalid("manifest.sources.v1DocIds", "packaged document mapped twice");
      v1DocIds.add(id);
    }
  }
  return structuredClone(manifest);
}

export interface PageImageRef { sourceId: string; sha256: string; extractionVersion: string; page: number }
// Private pages container: sources/<sourceId>/<PDF sha256>/<extractionVersion>/<native page>.png.
// The serving route resolves extractionVersion from the active manifest, never from an arbitrary client path.
export function pageImageBlobName(ref: PageImageRef): string {
  check(object({ sourceId: { ...text, pattern: SOURCE_ID_PATTERN, maxLength: 64 }, sha256: hash, extractionVersion, page: positiveInteger }), ref, "page");
  safeStrings(ref, "page");
  if (LICENCE.isWithheldSource(ref.sourceId)) invalid("page.sourceId", "withheld source");
  return `sources/${ref.sourceId}/${ref.sha256}/${ref.extractionVersion}/${ref.page}.png`;
}
export function manifestBlobName(version: number): string {
  check(positiveInteger, version, "manifestVersion");
  return `v${version}.json`;
}

// Shared owner decision validation. Actor/time/visibility never come from the request body.
export function validateStewardDecision(value: unknown): StewardDecision {
  check(object({ ...extraction, decision: { enum: ["approved", "rejected"] }, reason: { ...text, maxLength: REVIEW_REASON_MAX_LENGTH } }), value, "decision");
  safeStrings(value, "decision");
  if (LICENCE.referencesWithheld(value)) invalid("decision", "withheld source or derivative");
  return structuredClone(value) as StewardDecision;
}

// Validate the public registry projection before it is used for landing, review or publication.
export function validateRegistrySource(value: unknown): SourceRegistry {
  check(object({ sourceId: extraction.sourceId, publisher: text, title: text, url: MANIFEST_SCHEMA.properties.sources.items.properties.url,
    licence: text, attribution: text, expectedSha256: hash, publishAllowed: { anyOf: [{ const: true }, { const: false }] }, licenceBasis: text,
    freshness: { enum: ["NOT VERIFIED", "publisher-verified"] }, wellLocation: { anyOf: [wellLocation, { type: "null" }] },
    v1DocIds: MANIFEST_SCHEMA.properties.sources.items.properties.v1DocIds }), value, "registry");
  safeStrings(value, "registry");
  if (LICENCE.referencesWithheld(value)) invalid("registry", "withheld source or derivative");
  return structuredClone(value) as SourceRegistry;
}
