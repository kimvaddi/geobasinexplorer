// Isolated cloud-stripped API regressions. All service clients are replaced at bundle time; no Azure request is made.
// node tests/answers/licence-api.mjs
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appAliases, cloudBuildData, cloudDefines } from "../../tools/cloud-build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "app/package.json"));
const { build } = require("esbuild");
const outfile = path.join(root, `.licence-api-${randomUUID()}.mjs`);
const questions = JSON.parse(fs.readFileSync(path.join(root, "app/src/data/app-pack.json"))).benchmarks.filter((q) => ["Q08", "Q09"].includes(q.id)).map(({ id, q }) => ({ id, q }));
const mocks = {
  azure: String.raw`
    export const credential = { getToken: async () => { throw new Error("No Azure credentials in isolated tests"); } };
    export const state = { documents: [], searches: [], returned: [], embeddings: 0, embedded: [], modelCalls: 0, reviews: [], job: {}, result: null,
      schemaWrites: 0, uploaded: [], deleted: [], failIndexDeletes: new Set(), storage: new Map(), blobDeletes: [], failBlobDeletes: new Set(), checkpointWrites: [], jobWrites: [], ocrCalls: 0,
      ocrResult: { pages: [] }, extracted: { passages: [], entities: [] } };
    function matches(document, filter = "") {
      for (const match of filter.matchAll(/not\s+search\.in\(\s*(\w+)\s*,\s*'((?:''|[^'])*)'\s*,\s*'([^']+)'\s*\)/g)) {
        const values = match[2].replace(/''/g, "'").split(new RegExp("[" + match[3].replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&") + "]"));
        if (document[match[1]] != null && values.includes(document[match[1]])) return false;
      }
      const id = /\bid eq '((?:''|[^'])*)'/.exec(filter);
      if (id && document.id !== id[1].replace(/''/g, "'")) return false;
      const owner = /owner eq '((?:''|[^'])*)'/.exec(filter);
      if (filter.includes("visibility eq 'public'") && document.visibility !== "public" && document.owner !== owner?.[1].replace(/''/g, "'")) return false;
      return true;
    }
    export const search = () => ({ search: async (q, options = {}) => {
      state.searches.push({ q, ...options });
      const matched = state.documents.filter(d => matches(d, options.filter));
      const documents = matched.slice(options.skip ?? 0, (options.skip ?? 0) + (options.top ?? matched.length));
      state.returned.push(documents.map(d => d.id));
      return { count: matched.length, results: (async function* () { for (const document of documents) yield { score: 1, document }; })() };
    }, getDocumentsCount: async () => state.documents.length,
      deleteDocuments: async (field, keys) => {
        if (field !== "key") throw new Error("Wrong index key field");
        state.deleted.push(...keys);
        state.documents = state.documents.filter(d => !keys.includes(d.key) || state.failIndexDeletes.has(d.key));
        return { results: keys.map(key => ({ key, succeeded: !state.failIndexDeletes.has(key) })) };
      },
      mergeOrUploadDocuments: async (documents) => {
        state.uploaded.push(...documents);
        for (const d of documents) { const i = state.documents.findIndex(x => x.key === d.key); if (i < 0) state.documents.push(d); else state.documents[i] = d; }
        return { results: documents.map(d => ({ key: d.key, succeeded: true })) };
      },
    });
    export const searchIndexes = () => ({ createOrUpdateIndex: async () => { state.schemaWrites++; } });
    export const embed = async (texts) => { state.embeddings++; state.embedded.push(...texts); return texts.map(() => [0]); };
    export const ai = () => { state.modelCalls++; throw new Error("A writer or validator must not receive withheld evidence"); };
    export const table = () => ({ listEntities: () => (async function* () { yield* state.reviews; })(), getEntity: async () => state.job });
    const client = (container, name) => {
      const key = container + "/" + name;
      return { exists: async () => state.storage.has(key),
        downloadToBuffer: async () => {
          if (state.storage.has(key)) return state.storage.get(key);
          if (name.endsWith("/result.json")) return Buffer.from(JSON.stringify(state.result));
          throw new Error("Missing test blob " + key);
        },
        uploadData: async (bytes) => { state.storage.set(key, Buffer.from(bytes)); state.checkpointWrites.push(key); },
        getTags: async () => ({ tags: { "scan result": "No threats found" } }),
        deleteIfExists: async (options) => { state.blobDeletes.push({ key, options }); if (state.failBlobDeletes.has(key)) throw new Error("Simulated cleanup failure"); return { succeeded: state.storage.delete(key) }; },
        delete: async () => { state.storage.delete(key); },
      };
    };
    export const blobs = () => ({ getContainerClient: container => ({ getBlobClient: name => client(container, name), getBlockBlobClient: name => client(container, name) }) });
    export const docIntel = () => ({ path: () => ({ post: async () => { state.ocrCalls++; return { status: "202" }; } }) });
    export const queue = () => { throw new Error("No ingestion queue should be contacted"); };
  `,
  config: `export const cfg = {
    aiEnabled: false, malwareScan: false, reserveTokensPerQuestion: 100, spatialUrl: "http://test.invalid", index: "test", dimensions: 3072,
    timeoutsMs: { retrieval: 1000, spatial: 1000, generation: 1000, validation: 1000 },
    models: { answer: "test writer", validator: "test checker" }, deployments: {},
    caps: { maxPages: 300, spatialPerUserPerMinute: 100, questionsPerUserPerDay: 100, questionsPerDay: 100, questionsPerMonth: 100, tokensPerDay: 100000, tokensPerMonth: 100000 },
  };`,
  usage: `export class CapError extends Error {}
    export const keys = { userQuestions: () => "user", userUploads: () => "upload", questions: "questions", tokens: "tokens", ocrPages: "ocr" };
    export const take = async () => {}; export const takeBoth = async () => {}; export const settle = async () => {};
    export const reserve = async () => ({ amount: 100 }); export const topUp = async () => {}; export const record = async () => {};`,
  jobs: `import { state } from "azure-mock";
    export const claimJob = async () => "claimed"; export const jobStatusOf = async () => "queued"; export const TERMINAL = ["done", "failed", "rejected"];
    export const setJob = async (id, fields) => { state.jobWrites.push({ id, ...fields }); };`,
  extraction: `import { state } from "azure-mock"; export const extractFromPages = () => state.extracted;`,
  intelligence: `import { state } from "azure-mock"; export const isUnexpected = () => false; export const getLongRunningPoller = () => ({ pollUntilDone: async () => ({ body: { analyzeResult: state.ocrResult } }) });`,
  identity: `export class AzureCliCredential {} export class ManagedIdentityCredential {}`,
  projects: `export class AIProjectClient { constructor() { throw new Error("A live agent must not be constructed by licence regressions"); } }`,
  geography: `export class SearchClient { constructor() { throw new Error("No live Search in licence regressions"); } } export class GeographyPoint { constructor(p) { Object.assign(this, p); } }`,
  pdf: `export const getDocumentProxy = async () => ({ numPages: 1 });`,
  otel: "",
};
const entry = `
  import assert from "node:assert/strict";
  import { askCloud } from "./services/api/src/answer";
  import { sourcePassage } from "./services/api/src/sources";
  import { sourcesNear } from "./services/api/src/geo";
  import { spatialHere } from "./services/api/src/maps";
  import { listReviews, decideReview } from "./services/api/src/reviews";
  import { jobStatus, startIngest } from "./services/api/src/ingest-api";
  import { processJob } from "./services/api/src/worker";
  import { maintainIndex } from "./services/api/src/index-maintenance";
  import { cfg } from "./services/api/src/config";
  import { state, search } from "./services/api/src/azure";
  import { PACK } from "@/lib/pack";
  import { CLOUD } from "@/lib/cloud";
  import { LICENCE, LOWCARBON_DATA } from "@/lib/licensed-data";
  const questions = ${JSON.stringify(questions)};
  const user = { id: "licence-test", name: "licence test", roles: [], owner: false };
  let checks = 0;
  const check = async (name, fn) => { await fn(); checks++; console.log("PASS " + name); };
  const denied = { key: "old-unknown", id: "unfamiliar-id", doc: "Renamed", docId: "renamed", source: "gsq-cr000407", visibility: "public", page: 10, heading: "Test", text: "Withheld evidence", basin: "cooper", well: null, owner: "", points: [{ longitude: 140.2, latitude: -28 }], places: ["Innamincka 1"], placeHow: ["Report"] };
  const allowed = { ...denied, well: "innamincka-1", key: "ga", id: "allowed", doc: "GA reference catalogue", docId: "ga-reference-catalogue", source: "Geoscience Australia", text: "GA reference passage", places: ["Cooper Basin"] };
  const preId = { ...denied, key: "old-id", id: LICENCE.metadata().passages[0][0], source: "legacy" };
  const preDoc = { ...denied, key: "old-doc", id: "doc-only", docId: LICENCE.metadata().docIds[0][0], source: "legacy" };
  const zero = { ...denied, key: "old-zero", id: "upload-zero", source: "gsq-cr050039", visibility: "private", owner: "another-user" };
  const deck = { ...denied, key: "old-deck", id: "upload-deck", source: "sa-dem-core-2026", visibility: "private", owner: "another-user" };
  await check("the API test uses stripped packs and static deny metadata", async () => {
    assert.equal(CLOUD, true); assert.equal(PACK.wells.length, 1); assert.equal(PACK.extraPassages.length, 52); assert.equal(LOWCARBON_DATA.sites.length, 2);
    assert.equal(LICENCE.metadata().passages.length, 98);
  });
  for (const enabled of [false, true]) for (const { id, q } of questions) await check(id + (enabled ? " OData and post-filter" : " kill-switch fallback"), async () => {
    cfg.aiEnabled = enabled; state.documents = [preId, preDoc, denied, allowed]; state.searches = []; state.returned = []; state.embeddings = 0;
    const a = await askCloud(q, user);
    assert.equal(a.label, "Not found"); assert.equal(a.status, "unsupported");
    assert.deepEqual(a.citations, []); assert.deepEqual(a.hits, []); assert.equal(a.table, undefined); assert.equal(a.images, undefined); assert.equal(a.fieldRef, undefined);
    assert.equal(state.modelCalls, 0); assert.equal(state.embeddings, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(state.searches.length, 1); assert.equal(state.searches[0].top, 64); assert.ok(state.searches[0].filter.includes("not search.in(docId,"));
      assert.deepEqual(state.returned[0], [denied.id, allowed.id], "The mock must apply the OData exclusions before the post-filter");
      assert.ok(a.trace.some(t => /1 passage returned/.test(t.detail)), "The remaining unknown-source record must be post-filtered");
    }
  });
  await check("mock search.in honours escaped literals and does not exclude nulls", async () => {
    state.documents = [{ ...allowed, id: "O'Brien" }, { ...allowed, id: "null", docId: null }];
    const r = await search().search("*", { filter: "not search.in(id, 'O''Brien', '|') and (docId eq null or not search.in(docId, 'ga-reference-catalogue', '|'))" });
    const out = []; for await (const x of r.results) out.push(x.document.id); assert.deepEqual(out, ["null"]);
  });
  await check("approved prepared answer still works with AI disabled", async () => {
    cfg.aiEnabled = false; const a = await askCloud("Compare the four basins", user);
    assert.equal(a.label, "Precomputed"); assert.ok(a.citations.length); assert.equal(LICENCE.isWithheldAnswer(a), false);
  });
  await check("known source id returns not-found without querying", async () => {
    state.searches = []; assert.equal(await sourcePassage("innamincka-1:dst10-sip", user), null); assert.equal(state.searches.length, 0);
  });
  await check("source metadata post-filter still protects unknown ids", async () => {
    state.documents = [denied]; assert.equal(await sourcePassage(denied.id, user), null);
    state.documents = [allowed]; assert.equal((await sourcePassage(allowed.id, user)).id, allowed.id);
  });
  await check("nearby sources, basin counts and nearest fallback exclude withheld records", async () => {
    state.documents = [preId, preDoc, denied, allowed]; const r = await sourcesNear({ lon: 140.2, lat: -28, km: 50 }, user);
    assert.equal(r.matched, 1); assert.deepEqual(r.sources.map(s => s.id), ["allowed"]); assert.equal(r.basin?.passages, 1);
    state.documents = [preId, preDoc, denied]; const empty = await sourcesNear({ lon: 140.2, lat: -28, km: 50 }, user);
    assert.equal(empty.matched, 0); assert.deepEqual(empty.sources, []); assert.equal(empty.nearest, null); assert.equal(empty.basin?.passages, 0);
  });
  await check("spatial proxy keeps the GA borehole but removes the report link", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ wells: [{ id: "innamincka-1" }, { id: "marabooka-1" }], boreholes: [{ name: "Innamincka 1", key: "ga:inn" }] }) });
      const r = await spatialHere({ lon: 140.2, lat: -28 }, user.id); assert.deepEqual(r.wells, [{ id: "marabooka-1" }]); assert.deepEqual(r.boreholes, [{ name: "Innamincka 1", key: "ga:inn" }]);
    } finally { globalThis.fetch = original; }
  });
  await check("review states, history and write targets withhold restricted fields", async () => {
    const permitted = PACK.entities[0].id;
    state.reviews = [{ rowKey: "current", entity: "field:innamincka-1:dst10-sip", status: "accepted", label: "withheld", version: 1 },
      { rowKey: "000001", entity: "lowc:marabooka-1:f15-cumprod", status: "accepted", before: "withheld", version: 1 },
      { rowKey: "000002", entity: "lowc:marabooka-1:f11-toolachee", before: "Top Toolachee Formation (CO₂ storage reservoir): 6326 ft", after: "accepted", version: 2 },
      { rowKey: "current", entity: permitted, status: "accepted", label: "retained", version: 1 }];
    const r = await listReviews(); assert.deepEqual(Object.keys(r.review), [permitted]); assert.deepEqual(r.log, []);
    for (const entityId of ["field:innamincka-1:dst10-sip", "lowc:marabooka-1:f15-cumprod"]) assert.equal((await decideReview({ entityId, status: "accepted" }, user)).status, 400);
  });
  await check("old ingestion results cannot reopen the sample", async () => {
    state.job = { owner: user.id, status: "done", fileName: "renamed.pdf" }; state.result = { title: "ZeroGen DP-1 data evaluation summary", passageList: [] };
    assert.equal(await jobStatus("existing-job", user), null);
  });
  await check("known uploads are refused before reading bytes", async () => {
    let resumed = false; const r = await startIngest({ filename: "zerogen-dp1-summary.pdf", file: { resume: () => { resumed = true; } }, toBuffer: () => { throw new Error("Must not read"); } }, user);
    assert.equal(r.status, 400); assert.ok(resumed);
  });
  const resetWorker = (name = "renamed.png") => {
    state.storage = new Map(); state.blobDeletes = []; state.failBlobDeletes = new Set(); state.checkpointWrites = []; state.jobWrites = []; state.ocrCalls = 0;
    state.job = { fileName: name, kind: "png", status: "queued" }; state.extracted = { passages: [], entities: [] };
    state.ocrResult = { pages: [{ pageNumber: 1, lines: [{ content: "Permitted reference text" }], words: [{ confidence: 1 }] }] };
    const msg = { jobId: "licence-job", blob: "uploads/licence-job/" + name, owner: user.id };
    state.storage.set("quarantine/" + msg.blob, Buffer.from([137,80,78,71,13,10,26,10])); return msg;
  };
  const expectCleanup = (msg) => {
    assert.deepEqual(state.blobDeletes.map(x => x.key).sort(), ["quarantine/" + msg.blob, "processed/licence-job/analyze.json"].sort());
    assert.ok(state.blobDeletes.every(x => x.options.deleteSnapshots === "include"));
    assert.equal(state.storage.has("quarantine/" + msg.blob), false); assert.equal(state.storage.has("processed/licence-job/analyze.json"), false);
    assert.equal(state.jobWrites.at(-1).status, "rejected");
  };
  for (const phase of ["filename", "OCR", "extraction"]) await check("licence rejection cleans quarantine and checkpoint at " + phase, async () => {
    const msg = resetWorker(phase === "filename" ? "CR000407_report.png" : "renamed.png");
    if (phase === "filename") state.storage.set("processed/licence-job/analyze.json", Buffer.from("{}"));
    if (phase === "OCR") state.ocrResult.pages[0].lines[0].content = "Well Completion Report, D.F.S. Innamincka No. 1";
    if (phase === "extraction") state.extracted.entities = [{ nodeId: "doc:inn-wcr" }];
    await processJob(msg); expectCleanup(msg);
    assert.equal(state.ocrCalls, phase === "filename" ? 0 : 1);
    if (phase !== "filename") assert.deepEqual(state.checkpointWrites, ["processed/licence-job/analyze.json"]);
  });
  await check("cleanup failures are logged and do not prevent the second deletion", async () => {
    const msg = resetWorker("CR000407_report.png"); state.storage.set("processed/licence-job/analyze.json", Buffer.from("{}")); state.failBlobDeletes.add("quarantine/" + msg.blob);
    const logs = [], original = console.log; console.log = value => logs.push(JSON.parse(value));
    try { await processJob(msg); } finally { console.log = original; }
    assert.equal(state.blobDeletes.length, 2); assert.equal(state.storage.has("processed/licence-job/analyze.json"), false);
    assert.ok(logs.some(l => l.m === "licence cleanup failed" && l.container === "quarantine")); assert.ok(logs.some(l => l.m === "licence cleanup completed" && l.container === "processed"));
    assert.equal(state.jobWrites.at(-1).status, "rejected");
  });
  const resetIndex = () => { state.searches = []; state.returned = []; state.embeddings = 0; state.embedded = []; state.schemaWrites = 0; state.uploaded = []; state.deleted = []; state.failIndexDeletes = new Set(); };
  await check("index dry-run paginates and only reports withheld deletion keys", async () => {
    resetIndex(); state.documents = [...Array.from({ length: 1001 }, (_, i) => ({ ...allowed, key: "ga-" + i, id: "ga-" + i })), preId, preDoc, denied, zero, deck];
    const r = await maintainIndex({ dryRun: true }); assert.deepEqual(r.keys, [preId.key, preDoc.key, denied.key, zero.key, deck.key].sort());
    assert.equal(r.wouldDelete, 5); assert.equal(r.uploaded, 0); assert.equal(r.skipped, 98); assert.equal(r.deleted, 0);
    assert.deepEqual(state.searches.map(s => s.skip), [0,1000]); assert.equal(state.schemaWrites, 0); assert.equal(state.embeddings, 0); assert.deepEqual(state.uploaded, []); assert.deepEqual(state.deleted, []);
  });
  await check("index maintenance removes withheld keys and is idempotent", async () => {
    resetIndex(); state.documents = [allowed, preId, preDoc, denied, zero, deck];
    const first = await maintainIndex({ dryRun: false }); assert.equal(first.deleted, 5); assert.equal(first.skipped, 98); assert.equal(first.uploaded, 460);
    assert.ok(state.uploaded.every(p => !LICENCE.isWithheldPassage(p))); assert.ok(state.embedded.every(s => !s.includes("2026 DEM slides")));
    const second = await maintainIndex({ dryRun: false }); assert.equal(second.deleted, 0); assert.equal(second.uploaded, 460); assert.equal(second.skipped, 98);
  });
  await check("failed index deletion stops embeddings and uploads", async () => {
    resetIndex(); state.documents = [denied]; state.failIndexDeletes.add(denied.key);
    await assert.rejects(maintainIndex({ dryRun: false }), /cleanup failed/); assert.equal(state.embeddings, 0); assert.deepEqual(state.uploaded, []);
  });
  console.log("\\n" + checks + " isolated API checks. Failures: 0. Azure requests: 0.");
`;

try {
  const cloud = await cloudBuildData();
  await build({
    stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile, logLevel: "error", define: cloudDefines,
    plugins: [{ name: "isolated-api", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        const names = { "azure-mock": "azure", "@azure/identity": "identity", "@azure/search-documents": "geography", "@azure/ai-projects": "projects", "@azure-rest/ai-document-intelligence": "intelligence", "unpdf": "pdf", "@/lib/ingest": "extraction" };
        if (names[a.path]) return { path: names[a.path], namespace: "mock" };
        if (!a.path.startsWith(".")) return;
        const resolved = path.resolve(a.resolveDir, a.path).replace(/\.ts$/, "");
        for (const name of ["azure", "config", "usage", "jobs", "otel"]) if (resolved === path.join(root, "services/api/src", name)) return { path: name, namespace: "mock" };
      });
      b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: mocks[a.path], loader: "js" }));
    } }, appAliases(cloud)],
  });
  await import(pathToFileURL(outfile).href);
  const probe = path.join(root, "services/api", `.licence-projection-${randomUUID()}.ts`);
  try {
    fs.writeFileSync(probe, 'import assert from "node:assert/strict"; import { CLOUD } from "@/lib/cloud"; import { PACK } from "@/lib/pack"; import { LICENCE } from "@/lib/licensed-data"; assert.equal(CLOUD, true); assert.equal(PACK.wells.length, 1); assert.equal(PACK.extraPassages.length, 52); assert.equal(LICENCE.metadata().passages.length, 98); console.log("API entry projection passed");');
    const result = execFileSync(process.execPath, [path.join(root, "tools/run-ts.mjs"), probe], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (!result.includes("API entry projection passed")) throw new Error("run-ts API entry was not tested");
    console.log("PASS run-ts automatically strips API entry points");
    console.log("22 total API/tooling checks. Failures: 0. Azure requests: 0.");
  } finally { fs.rmSync(probe, { force: true }); }
} finally { fs.rmSync(outfile, { force: true }); }
