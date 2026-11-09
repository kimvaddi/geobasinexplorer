// From services/api: node build.mjs --script src/live/contracts.test.ts && node --test dist/scripts/contracts.test.mjs
// Uses the real existing licence gate; imports no service clients and performs no network calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchField, SimpleField } from "@azure/search-documents";
import { definition } from "../../scripts/index-v2-schema";
import {
  CURRENT_MANIFEST_BLOB, DEFAULT_SCAN_ROUTE, EXTRACTION_VERSION_PATTERN, LIVE_CONTAINERS, LIVE_INDEX_FIELDS,
  LIVE_INDEX_NAME, LIVE_QUEUES, LIVE_ROUTES, LIVE_TABLES, LIVE_VECTOR_DIMENSIONS, MANIFEST_SCHEMA, REVIEW_REASON_MAX_LENGTH,
  ManifestValidationError, SCAN_ROUTES, SOURCE_REGISTRY_DEFAULTS, manifestBlobName, pageImageBlobName, validateManifest, validateStewardDecision,
  type ProcessJobMessage, type PublicationManifest, type ScanJobMessage,
} from "./contracts";

const recipe = "c".repeat(64);
const version = `layout-v1-${recipe}-11111111-2222-4333-8444-555555555555`;
const gaHash = "a".repeat(64), guideHash = "b".repeat(64), reportHash = "d".repeat(64);
function fixture(): PublicationManifest {
  return {
    schemaVersion: 1, manifestVersion: 2, createdAt: "2026-11-02T16:10:00.000Z", indexName: LIVE_INDEX_NAME,
    sources: [
      {
        sourceId: "ga-147461", sha256: gaHash, extractionVersion: version, publisher: "Geoscience Australia", title: "Cooper Basin package",
        url: "https://d28rz98at9flks.cloudfront.net/147461/147461_00_0.zip", licence: "CC BY 4.0", attribution: "Source: Geoscience Australia.",
        licenceBasis: "Owner-confirmed CC BY 4.0 for the package.", publishAllowed: true, visibility: "public",
        v1DocIds: ["packaged-cooper-guide"], wellLocation: null,
        documents: [{ docId: "cooper-guide", sha256: guideHash, title: "Cooper Basin guide", pageCount: 40, chunkCount: 80 }],
        approval: { sourceId: "ga-147461", sha256: gaHash, extractionVersion: version, decision: "approved", by: "owner-fixture",
          at: "2026-11-02T16:00:00.000Z", reason: "Reviewed the licence and the extraction." },
      },
      {
        sourceId: "peps-sa-marabooka-1", sha256: reportHash, extractionVersion: version, publisher: "PEPS South Australia", title: "Marabooka 1 report",
        url: "bundle-copy", licence: "CC BY 4.0", attribution: "PEPS South Australia", licenceBasis: "Owner-confirmed CC BY 4.0 for the report.",
        publishAllowed: true, visibility: "public", v1DocIds: ["packaged-marabooka-report"],
        wellLocation: { lon: 140.75, lat: -27.8, datum: "GDA94" },
        documents: [{ docId: "marabooka-report", sha256: reportHash, title: "Marabooka 1 report", pageCount: 50, chunkCount: 100 }],
        approval: { sourceId: "peps-sa-marabooka-1", sha256: reportHash, extractionVersion: version, decision: "approved", by: "owner-fixture",
          at: "2026-11-02T16:00:00.000Z", reason: "Reviewed the licence, extraction and well location." },
      },
    ],
  };
}
type Path = (string | number)[];
const at = (value: unknown, path: Path): Record<string, unknown> => {
  for (const key of path) value = (value as Record<string | number, unknown>)[key];
  return value as Record<string, unknown>;
};
function objectPaths(value: unknown, path: Path = []): Path[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => objectPaths(item, [...path, i]));
  return [path, ...Object.entries(value).flatMap(([key, item]) => objectPaths(item, [...path, key]))];
}
function stringPaths(value: unknown, path: Path = []): Path[] {
  if (typeof value === "string") return [path];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => stringPaths(item, [...path, key]));
}
const reject = (candidate: unknown) => assert.throws(() => validateManifest(candidate), ManifestValidationError);

test("accepts a complete manifest, including an archive member and a bundle-copy source", () => {
  const original = fixture();
  const validated = validateManifest(JSON.parse(JSON.stringify(original)), 1);
  assert.deepEqual(validated, original);
  assert.notEqual(validated, original);
  assert.notEqual(validated.sources[0].sha256, validated.sources[0].documents[0].sha256);
  assert.equal(validateManifest({ ...original, manifestVersion: 1 }).manifestVersion, 1);
});
test("returns a detached value so mutating the input cannot alter a cached manifest", () => {
  const original = fixture(), validated = validateManifest(original);
  original.sources[0].publishAllowed = false as never;
  assert.equal(validated.sources[0].publishAllowed, true);
});
test("rejects every missing required field at every object depth", () => {
  for (const path of objectPaths(fixture())) for (const key of Object.keys(at(fixture(), path))) {
    const candidate = fixture(); delete at(candidate, path)[key]; reject(candidate);
  }
});
test("rejects unknown fields at every object depth", () => {
  for (const path of objectPaths(fixture())) {
    const candidate = fixture(); at(candidate, path).unexpected = true; reject(candidate);
  }
});
test("rejects wrong types for every field without coercion", () => {
  for (const path of objectPaths(fixture())) for (const [key, value] of Object.entries(at(fixture(), path))) {
    const candidate = fixture();
    at(candidate, path)[key] = typeof value === "number" ? "2" : typeof value === "string" ? 2
      : typeof value === "boolean" ? "true" : Array.isArray(value) ? {} : value === null ? false : [];
    reject(candidate);
  }
});
for (const candidate of [undefined, null, [], "{}", false, 1]) test(`rejects a missing or non-object manifest: ${String(candidate)}`, () => reject(candidate));

for (const sourceId of ["gsq-cr000407", "gsq-cr050039", "sa-dem-core-2026", "unregistered-source"]) {
  test(`rejects a withheld or unregistered source: ${sourceId}`, () => {
    const candidate = fixture();
    at(candidate, ["sources", 0]).sourceId = sourceId;
    at(candidate, ["sources", 0, "approval"]).sourceId = sourceId;
    reject(candidate);
  });
}
test("accepts later sources, including one with no packaged documents to replace", () => {
  const candidate = fixture();
  for (const [i, sourceId] of [[0, "ga-147462"], [1, "peps-sa-habanero-1"]] as const) {
    at(candidate, ["sources", i]).sourceId = sourceId; at(candidate, ["sources", i, "approval"]).sourceId = sourceId;
  }
  Object.assign(at(candidate, ["sources", 1]), { v1DocIds: [], wellLocation: null });
  assert.deepEqual(validateManifest(candidate).sources.map((s) => s.v1DocIds.length), [1, 0]);
});
test("reuses the licence gate for aliases and derivatives, not just the source-id allowlist", () => {
  for (const marker of ["GSQ open file CR000407", "GSQ open file CR050039", "sa-dem-core-2026"]) {
    const candidate = fixture(); candidate.sources[0].attribution = marker; reject(candidate);
  }
  const candidate = fixture(); candidate.sources[0].v1DocIds = ["inn-ocr-001"]; reject(candidate);
});

const unsafeUrls = [
  "http://example.org/report.pdf", "ftp://example.org/report.pdf", "gopher://example.org/report.pdf", "file:///private/report.pdf",
  "blob:https://example.org/123", "BLOB:https://example.org/123", "data:text/plain,private", "javascript:alert(1)", "mailto:owner@example.org",
  "//example.org/report.pdf", "See,//example.org/report.pdf", "https://account.blob.core.windows.net/raw/report.pdf",
  "https://ACCOUNT.BLOB.CORE.WINDOWS.NET./raw/report.pdf", "https://account.privatelink.blob.core.windows.net/raw/report.pdf",
  "https://account.blob.core.usgovcloudapi.net/raw/report.pdf", "https://account.blob.core.chinacloudapi.cn/raw/report.pdf",
  "https://account.z01.blob.storage.azure.net/raw/report.pdf", "https://account.dfs.core.windows.net/raw/report.pdf",
  "https://example.org/report.pdf?sv=2026-02-06&sig=secret", "https://user:secret@example.org/report.pdf",
  "https://example.org/redirect?next=http://example.net/private", "https://example.org/redirect?next=https://account.blob.core.windows.net/raw/x",
  "https://example.org/redirect?next=https%3A%2F%2Faccount.blob.core.windows.net%2Fraw%2Fx",
  "https://example.org/redirect?next=http%253A%252F%252Fexample.net%252Fx",
];
for (const url of unsafeUrls) test(`rejects unsafe URLs anywhere: ${url}`, () => {
  for (const path of stringPaths(fixture())) {
    const candidate = fixture();
    at(candidate, path.slice(0, -1))[String(path.at(-1))] = url; reject(candidate);
  }
  const candidate = fixture(); candidate.sources[0].approval.reason = `Evidence is at ${url} and was reviewed.`; reject(candidate);
});
test("permits an ordinary HTTPS publisher link embedded in text and ordinary prose colons", () => {
  const candidate = fixture(); candidate.sources[0].attribution = "Publisher: see https://www.ga.gov.au/ for attribution.";
  assert.deepEqual(validateManifest(candidate), candidate);
});

test("rejects a manifest version that does not increase", () => {
  for (const previous of [2, 3]) assert.throws(() => validateManifest(fixture(), previous), /version must increase/);
  assert.equal(validateManifest({ ...fixture(), manifestVersion: 3 }, 2).manifestVersion, 3);
});
test("rejects malformed, fractional, non-finite and out-of-range versions and baselines", () => {
  for (const manifestVersion of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, "3"]) reject({ ...fixture(), manifestVersion });
  for (const previous of [-1, 1.5, NaN, Infinity, 2_147_483_648]) assert.throws(() => validateManifest(fixture(), previous), ManifestValidationError);
});
test("requires the supported schema and index, public visibility, explicit permission and approval", () => {
  for (const change of [{ schemaVersion: 2 }, { indexName: "gbx-passages" }]) reject({ ...fixture(), ...change });
  for (const change of [{ publishAllowed: false }, { visibility: "private" }, { licenceBasis: " " }, { documents: [] }]) {
    const candidate = fixture(); Object.assign(candidate.sources[0], change); reject(candidate);
  }
  const candidate = fixture(); Object.assign(candidate.sources[0].approval, { decision: "rejected" }); reject(candidate);
  reject({ ...fixture(), sources: [] });
});
test("binds approval to source id, landed SHA-256 and extraction version", () => {
  for (const change of [{ sourceId: "peps-sa-marabooka-1" }, { sha256: guideHash }, { extractionVersion: version.replace("11111111", "22222222") }]) {
    const candidate = fixture(); Object.assign(candidate.sources[0].approval, change); reject(candidate);
  }
});
test("requires lowercase hashes and the recipe/run extraction version format", () => {
  for (const sha256 of ["A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
    const candidate = fixture(); candidate.sources[0].sha256 = sha256; reject(candidate);
  }
  for (const extractionVersion of ["v1", "layout-v1-123", version.replace("4333", "5333"), version.replace(recipe, "c".repeat(63))]) {
    const candidate = fixture(); candidate.sources[0].extractionVersion = extractionVersion; reject(candidate);
  }
});
test("requires real UTC timestamps and approval no later than publication", () => {
  for (const createdAt of ["2026-02-30T16:10:00.000Z", "2026-11-02", "2026-11-02T16:10:00+00:00", "2026-11-02T24:00:00.000Z"]) reject({ ...fixture(), createdAt });
  const late = fixture(); late.sources[0].approval.at = "2026-11-02T16:11:00.000Z"; reject(late);
  const seconds = fixture(); seconds.createdAt = "2026-11-02T16:10:00Z"; assert.deepEqual(validateManifest(seconds), seconds);
});
test("requires the Marabooka geotag with finite GDA94 coordinates", () => {
  for (const wellLocation of [null, { lon: NaN, lat: -27.8, datum: "GDA94" }, { lon: 190, lat: -27.8, datum: "GDA94" },
    { lon: 140.75, lat: 20, datum: "GDA94" }, { lon: 140.75, lat: -27.8, datum: "WGS84" }]) {
    const candidate = fixture(); Object.assign(candidate.sources[1], { wellLocation }); reject(candidate);
  }
});
test("rejects duplicate source, document, page identity and packaged-document mappings", () => {
  const sources = fixture(); sources.sources[1] = structuredClone(sources.sources[0]); reject(sources);
  const documents = fixture(); documents.sources[0].documents.push({ ...documents.sources[0].documents[0], docId: "another-id" }); reject(documents);
  const ids = fixture(); ids.sources[1].documents[0].docId = ids.sources[0].documents[0].docId; reject(ids);
  const packaged = fixture(); packaged.sources[1].v1DocIds = [...packaged.sources[0].v1DocIds]; reject(packaged);
  const local = fixture(); local.sources[0].v1DocIds.push(local.sources[0].v1DocIds[0]); reject(local);
});
test("accepts separately hashed PDFs in an archive and preserves their native pages", () => {
  const candidate = fixture(); candidate.sources[0].documents.push({ docId: "glossary", sha256: "e".repeat(64), title: "Glossary", pageCount: 3, chunkCount: 6 });
  assert.equal(validateManifest(candidate).sources[0].documents.length, 2);
});
test("rejects zero, fractional and non-finite document counts", () => {
  for (const value of [0, -1, 0.5, Infinity, NaN]) for (const field of ["pageCount", "chunkCount"] as const) {
    const candidate = fixture(); candidate.sources[0].documents[0][field] = value; reject(candidate);
  }
});
test("rejects non-JSON objects, accessors, symbols, sparse arrays and non-enumerable properties", () => {
  const inherited = Object.create(fixture()) as unknown; reject(inherited);
  const symbol = fixture(); Object.assign(symbol, { [Symbol("extra")]: true }); reject(symbol);
  const hidden = fixture(); Object.defineProperty(hidden, "extra", { value: true }); reject(hidden);
  const hiddenRequired = fixture(); Object.defineProperty(hiddenRequired, "schemaVersion", { value: 1, enumerable: false }); reject(hiddenRequired);
  const getter = fixture(); Object.defineProperty(getter, "sources", { get() { throw new Error("must not execute an accessor"); } }); reject(getter);
  const sparse = fixture(); delete sparse.sources[0]; reject(sparse);
  const extra = fixture(); Object.assign(extra.sources, { extra: true }); reject(extra);
  const arrayGetter = fixture(); Object.defineProperty(arrayGetter.sources, "0", { get() { throw new Error("must not execute an array accessor"); } }); reject(arrayGetter);
  const cyclic = fixture(); Object.assign(cyclic.sources[0].approval, { extra: cyclic }); reject(cyclic);
  const controls = fixture(); controls.sources[0].title = "Report\u0000"; reject(controls);
});

test("exports a closed JSON Schema with every object property required", () => {
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const schema = value as Record<string, unknown>;
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties as object));
    }
    for (const item of Object.values(schema)) inspect(item);
  };
  assert.equal(MANIFEST_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  inspect(MANIFEST_SCHEMA);
});
test("page paths are private, extraction-specific, use PDF hashes and one-based page numbers", () => {
  assert.match(version, new RegExp(EXTRACTION_VERSION_PATTERN));
  const ref = { sourceId: "ga-147461", sha256: guideHash, extractionVersion: version, page: 1 };
  assert.equal(pageImageBlobName(ref), `sources/ga-147461/${guideHash}/${version}/1.png`);
  for (const change of [{ sourceId: "../source" }, { sourceId: "source\n" }, { sha256: "bad" }, { extractionVersion: "../escape" }, { page: 0 }, { page: 1.5 }, { sourceId: "gsq-cr000407" }]) {
    assert.throws(() => pageImageBlobName({ ...ref, ...change }), ManifestValidationError);
  }
  assert.equal(CURRENT_MANIFEST_BLOB, "current.json"); assert.equal(manifestBlobName(2), "v2.json");
  assert.throws(() => manifestBlobName(0), ManifestValidationError);
});
test("shares the table, queue, container and route names without changing the legacy queue body", () => {
  for (const name of Object.values(LIVE_TABLES)) assert.match(name, /^[A-Za-z][A-Za-z0-9]{2,62}$/);
  assert.equal(LIVE_TABLES.sourceRegistry, "sourceregistry"); assert.notEqual(LIVE_TABLES.reviews, "reviews");
  assert.equal(SOURCE_REGISTRY_DEFAULTS.publishAllowed, false);
  assert.deepEqual(Object.values(LIVE_CONTAINERS), ["quarantine", "raw", "processed", "pages", "manifests"]);
  const legacy: ScanJobMessage = { jobId: "job-1", owner: "owner-1", blob: "uploads/test.pdf" };
  const live: ProcessJobMessage = { ...legacy, route: "process-jobs" };
  assert.deepEqual(SCAN_ROUTES, ["ingest-jobs", "process-jobs"]); assert.equal(DEFAULT_SCAN_ROUTE, LIVE_QUEUES.ingest);
  assert.deepEqual(Object.keys(live), [...Object.keys(legacy), "route"]);
  assert.deepEqual(LIVE_ROUTES.sourceContent, { method: "PUT", path: "/api/admin/sources/:id/content" });
  assert.deepEqual(LIVE_ROUTES.page, { method: "GET", path: "/api/pages/:sourceId/:sha256/:page" });
  assert.equal(LIVE_ROUTES.reviewDecision.method, "POST"); assert.equal(LIVE_ROUTES.manifest.path, "/api/live/manifest");
});
test("v2 definition has exactly the shared fields and one retrievable string key", () => {
  assert.equal(definition.name, "gbx-evidence-v2");
  assert.deepEqual(definition.fields.map((field) => field.name).sort(), [...LIVE_INDEX_FIELDS].sort());
  assert.equal(new Set(definition.fields.map((field) => field.name)).size, definition.fields.length);
  const keys = definition.fields.filter((field) => "key" in field && field.key);
  assert.deepEqual(keys.map((field) => field.name), ["id"]);
  assert.equal(keys[0].type, "Edm.String"); assert.equal((keys[0] as SimpleField).hidden, false);
});
test("v2 vector is 3072-dimensional and has legal flags, an existing profile and cosine HNSW", () => {
  const vector = definition.fields.find((field) => field.name === "vector") as SimpleField;
  assert.equal(LIVE_VECTOR_DIMENSIONS, 3072); assert.equal(vector.vectorSearchDimensions, 3072);
  assert.equal(vector.type, "Collection(Edm.Single)"); assert.equal(vector.searchable, true); assert.equal(vector.hidden, true);
  assert.equal(vector.filterable, false); assert.equal(vector.sortable, false); assert.equal(vector.facetable, false);
  const profile = definition.vectorSearch.profiles.find((item) => item.name === vector.vectorSearchProfileName)!;
  assert.ok(profile);
  const algorithm = definition.vectorSearch.algorithms.find((item) => item.name === profile.algorithmConfigurationName)!;
  assert.equal(algorithm.kind, "hnsw"); assert.equal(algorithm.parameters.metric, "cosine");
});
test("v2 geo and access fields retain the 0.11.0 filter contract and legal collection attributes", () => {
  const field = (name: string) => definition.fields.find((item) => item.name === name) as SimpleField;
  assert.equal(field("points").type, "Collection(Edm.GeographyPoint)"); assert.equal(field("points").filterable, true);
  assert.equal(field("geoBasins").type, "Collection(Edm.String)"); assert.equal(field("geoBasins").facetable, true);
  for (const name of ["id", "docId", "owner", "visibility", "publishAllowed", "manifestVersion", "sourceId", "sha256", "extractionVersion", "geotag"]) assert.equal(field(name).filterable, true);
  const inspect = (fields: SearchField[]) => {
    for (const f of fields) {
      if (f.type.startsWith("Collection(")) assert.notEqual((f as SimpleField).sortable, true);
      if (f.type.includes("GeographyPoint")) assert.notEqual((f as SimpleField).facetable, true);
      if ("fields" in f && f.fields) inspect(f.fields);
    }
  };
  inspect(definition.fields);
});

test("review reasons accept exactly 500 characters and reject 501 for either decision", () => {
  assert.equal(REVIEW_REASON_MAX_LENGTH, 500);
  for (const decision of ["approved", "rejected"] as const) {
    const body = { sourceId: "ga-147461", sha256: gaHash, extractionVersion: version, decision, reason: "x".repeat(500) };
    assert.deepEqual(validateStewardDecision(body), body);
    assert.throws(() => validateStewardDecision({ ...body, reason: "x".repeat(501) }), ManifestValidationError);
  }
});
