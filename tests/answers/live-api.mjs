// Exact 0.12.0 comparison under identical resource/model fakes, plus partial-publication and rollback guards.
// All Azure calls are replaced at bundle time; git show reads the verified release without modifying it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appAliases, cloudBuildData, cloudDefines } from "../../tools/cloud-build.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(path.join(root, "app/package.json"));
const apiRequire = createRequire(path.join(root, "services/api/package.json"));
const { build } = require("esbuild"), outfile = path.join(root, `.live-api-${randomUUID()}.mjs`);
const baseline = execFileSync("git", ["show", "e58d7e8:services/api/src/answer.ts"], { cwd: root, encoding: "utf8" });
const questions = JSON.parse(fs.readFileSync(path.join(root, "app/src/data/app-pack.json"), "utf8")).benchmarks.filter((b) => ["Q01", "Q10", "Q11"].includes(b.id)).map(({ id, q }) => ({ id, q }));
const withheldQuestions = JSON.parse(fs.readFileSync(path.join(root, "app/src/data/app-pack.json"), "utf8")).benchmarks.filter((b) => ["Q08", "Q09"].includes(b.id)).map(({ id, q }) => ({ id, q }));
const mocks = {
  state: 'export const state = { manifest: null, manifestMode: "auto", downloads: [], calls: [], bookings: [], settlements: [], searches: [], models: [], documents: [], writer: "", ignoreFilter: false };',
  azure: String.raw`
    import { state } from "live-test-state";
    import { Readable } from "node:stream";
    import { createHash } from "node:crypto";
    export const credential = {};
    export const blobs = () => ({ getContainerClient: (container) => {
      if (container !== "manifests") throw new Error("Unexpected container in isolated test");
      return { getBlobClient: (name) => {
        if (name !== "current.json") throw new Error("Unexpected manifest path");
        return { download: async (offset, count, options) => {
          if (offset !== 0 || count !== 512 * 1024 + 1 || !options?.abortSignal || options.maxRetryRequests !== 0) throw new Error("Real Blob download requires the offset, bounded count, signal and stream retry policy");
          const call = { ifNoneMatch: options.conditions?.ifNoneMatch, mode: state.manifestMode }; state.downloads.push(call);
          if (state.manifestMode === "missing" || state.manifest === null) throw { statusCode: 404 };
          if (state.manifestMode === "unreadable") throw { statusCode: 403 };
          const bytes = Buffer.from(state.manifestMode === "invalid" ? '{"schemaVersion":999}' : state.manifestMode === "incomplete" ? '{"schemaVersion":1,' : JSON.stringify(state.manifest));
          const etag = '"' + createHash("sha256").update(bytes).digest("hex") + '"'; call.responseEtag = etag;
          if (options.conditions?.ifNoneMatch === etag) { call.status = 304; throw { statusCode: 304 }; }
          call.status = 200; return { etag, readableStreamBody: Readable.from(bytes) };
        } };
      } };
    } });
    export const table = () => { throw new Error("No real tables"); };
    export const embed = async () => [[0, 1]];
    function matches(d, f) {
      for (const m of f.matchAll(/not search\.in\(docId, '([^']*)', '\|'\)/g)) if (m[1].split("|").includes(d.docId)) return false;
      const id = /\bid eq '([^']*)'/.exec(f); if (id && d.id !== id[1]) return false;
      return d.visibility === "public" || d.owner === "caller-1";
    }
    export const search = () => ({ search: async (q, o = {}) => {
      state.searches.push({ q, ...o });
      const documents = state.documents.filter((d) => state.ignoreFilter || matches(d, o.filter ?? "")).slice(0, o.top ?? 1000);
      return { results: (async function* () { for (const document of documents) yield { score: 1, document: Object.fromEntries((o.select ?? Object.keys(document)).filter((k) => k in document).map((k) => [k, document[k]])) }; })() };
    } });
    export const ai = () => ({ chat: { completions: { create: async (body) => {
      state.models.push(body.model);
      const content = body.model === "validator" ? JSON.stringify({ verdicts: [...body.messages[1].content.matchAll(/^Claim (\d+)/gm)].map((m) => ({ claim: Number(m[1]), verdict: "supported", reason: "Fixture confirmed" })) })
        : JSON.stringify({ answerable: true, sentences: [{ text: state.writer, cites: ["P1"] }], missing: [] });
      return { choices: [{ message: { content } }], usage: { total_tokens: 17 } };
    } } } });
  `,
  agent: 'import { state } from "live-test-state"; export async function answerLive(a, context, before, options) { await before(300); state.calls.push({ context, options }); return { answer: { ...a, label: "Retrieved", status: "answered", paragraphs: ["Live test answer"], validation: { ...a.validation, status: "passed" } }, tokens: 123, known: true }; }',
  config: 'export const cfg = { aiEnabled: true, reserveTokensPerQuestion: 1000, live: { totalMs: 90000, sources: [] }, models: { answer:"writer", validator:"checker" }, deployments: { answer:"writer", validator:"validator" }, timeoutsMs:{validation:500,retrieval:500,generation:500,spatial:500}, maxOutputTokens:{answer:1200,validator:3000}, caps: { spatialPerUserPerMinute:1000, questionsPerUserPerDay:60, questionsPerDay:300, questionsPerMonth:3000, tokensPerDay:1200000, tokensPerMonth:12000000 } };',
  usage: 'import { state } from "live-test-state"; export class CapError extends Error {} export const keys={userQuestions:()=>"user",questions:"all",tokens:"tokens"}; export const take=async()=>{}; export const takeBoth=async()=>{}; export const reserve=async()=>{state.bookings.push("reserved"); return {id:"book",amount:1000};}; export const topUp=async()=>{state.bookings.push("topup");}; export const settle=async(_b,n)=>{state.settlements.push(n);};',
  geography: 'export class GeographyPoint { constructor(p) { Object.assign(this,p); } } export class SearchClient { search() { throw new Error("No live index in the isolated test"); } }',
  identity: 'export class AzureCliCredential {} export class ManagedIdentityCredential {}',
};
const entry = `
import assert from "node:assert/strict";
import Fastify from "fastify";
import { liveManifest, ManifestReader, downloadManifest } from "./services/api/src/live/serving-manifest";
import { registerLiveServingRoutes } from "./services/api/src/live/serving-pages";
import { askCloud } from "./services/api/src/answer";
import { askCloud as ask012 } from "baseline-answer";
import { sourcePassage } from "./services/api/src/sources";
import { sourcesNear } from "./services/api/src/geo";
import { manifestFixture } from "./services/api/src/live/serving.test-fixtures";
import { validateManifest } from "./services/api/src/live/contracts";
import { requiredLiveSources } from "./services/api/src/live/serving-policy";
import { answer5 } from "@/lib/answer5";
import { state } from "live-test-state";
import { cfg } from "./services/api/src/config";
const questions=${JSON.stringify(questions)}, user={id:"caller-1",name:"Caller",roles:[],owner:false}; let checks=0;
const reset = (qid="Q10") => {
  // Each scenario gets the real reader; commitments are evaluated on every call.
  const reader = new ManifestReader(downloadManifest); liveManifest.read = reader.read.bind(reader);
  state.manifestMode="auto"; state.downloads=[];
  state.calls=[]; state.models=[]; state.searches=[]; state.ignoreFilter=false;
  state.writer=qid==="Q01" ? "The Cooper Basin guide defines 16 play intervals." : "The report raises possible communication for the water-wet Patchawarra and leaves it untested.";
  state.documents=[{id:"legacy-"+qid,doc:qid==="Q01"?"Cooper report":"Marabooka 1 · completion report",docId:qid==="Q01"?"cooper-report":"marabooka-1-completion-report",page:qid==="Q01"?1:32,heading:"Evidence",text:state.writer,basin:"cooper",well:null,kind:"report",visibility:"public",owner:"",source:"Retained public source",points:[{longitude:140.6102,latitude:-28.176}],places:["Marabooka 1"],placeHow:["Source"],geoBasins:["cooper"],geotag:"point"}];
};
const stable = (a) => { const {id,ms,...rest}=a; return JSON.parse(JSON.stringify(rest, (key,value)=>key==="ms"?undefined:value)); };
const unlabel = (a) => ({...a,citations:a.citations.map(({provenanceLabel,...c})=>c)});
// 0.13.45 removed the basin limit from every search (CHANGELOG), so the 0.12.0 baseline is compared after rewriting exactly
// those two traces of it: its search trace's scope wording and the basin clause in its search filter. All else must match.
const expect012 = (a) => JSON.parse(JSON.stringify(stable(a)).replace(/Hybrid keyword and vector search(?: within the [^;"]+? and general documents)?;/g, "Hybrid keyword and vector search across every basin;"));
const unbasined = (searches) => searches.map((x) => typeof x.filter === "string" ? { ...x, filter: x.filter.replace(/ and \\(basin eq '[a-z]+' or basin eq null\\)/g, "") } : x);
for (const missing of [null, {invalid:true}]) for (const enabled of [false,true]) for (const q of questions) {
 cfg.aiEnabled=enabled; cfg.live.sources=[]; state.manifest=missing; reset(q.id);
 const expected=await ask012(q.q,null,user); const oldSearches=structuredClone(state.searches); reset(q.id);
 const actual=await askCloud(q.q,user);
 assert.deepEqual(stable(actual),expect012(expected), q.id+" empty/invalid manifest must be exactly 0.12.0, AI="+enabled);
 assert.deepEqual(state.searches,unbasined(oldSearches),"No empty-lane exclusion or probe may alter 0.12.0 queries");
 assert.ok(actual.citations.every(c=>!c.live && !c.provenanceLabel)); assert.equal(state.calls.length,0); assert.equal(state.downloads.length,0); checks++;
}
const mar=manifestFixture(); const ga=structuredClone(mar.sources[0]); ga.sourceId="ga-147461"; ga.sha256="e".repeat(64); ga.title="Cooper guide"; ga.wellLocation=null; ga.v1DocIds=["cooper-report"]; ga.documents=[{docId:"guide",sha256:"f".repeat(64),title:"Cooper guide",pageCount:20,chunkCount:40}]; ga.approval={...ga.approval,sourceId:ga.sourceId,sha256:ga.sha256};
const both=validateManifest({...mar,sources:[...mar.sources,ga]}); const onlyGa=validateManifest({...mar,sources:[ga]});
// A published manifest alone, with no revision commitment, must never change a slice answer or cause I/O.
for (const enabled of [false,true]) for (const q of questions) {
 cfg.aiEnabled=enabled; cfg.live.sources=[]; state.manifest=both; reset(q.id);
 const expected=await ask012(q.q,null,user); const oldSearches=structuredClone(state.searches); reset(q.id);
 const actual=await askCloud(q.q,user); assert.deepEqual(stable(actual),expect012(expected)); assert.deepEqual(state.searches,unbasined(oldSearches));
 assert.equal(state.downloads.length,0); assert.equal(state.calls.length,0); assert.ok(actual.citations.every(c=>!c.live && !c.provenanceLabel)); checks++;
}
for (const m of [mar, onlyGa, both]) for (const q of questions) {
 cfg.aiEnabled=true; cfg.live.sources=m.sources.map(s=>s.sourceId); state.manifest=m; reset(q.id);
 const sources=requiredLiveSources(answer5(q.q,{basin:null}),m);
 const expected=await ask012(q.q,null,user); reset(q.id); const a=await askCloud(q.q,user);
 if (sources.length) { assert.equal(state.calls.length,1); assert.equal(a.label,"Retrieved"); assert.equal(a.fieldRef,undefined); assert.equal(state.calls[0].context.user.id,user.id); assert.deepEqual(state.calls[0].context.requiredSourceIds,sources); }
 else { assert.equal(state.calls.length,0); assert.deepEqual(stable(unlabel(a)),expect012(expected)); assert.ok(a.citations.every(c=>c.provenanceLabel==="packaged snapshot")); }
 checks++;
}
// A full manifest with only one committed family must leave the other family's answers on 0.12.0.
for (const committed of [["ga-147461"],["peps-sa-marabooka-1"]]) for (const q of questions) {
 cfg.aiEnabled=true; cfg.live.sources=committed; state.manifest=both; reset(q.id);
 const expected=await ask012(q.q,null,user); reset(q.id); const actual=await askCloud(q.q,user);
 const needed=requiredLiveSources(answer5(q.q,{basin:null}),both);
 if (needed.length) { assert.equal(state.calls.length,1); assert.deepEqual(state.calls[0].context.manifest.sources.map(s=>s.sourceId),committed); }
 else { assert.equal(state.calls.length,0); assert.deepEqual(stable(unlabel(actual)),expect012(expected)); assert.ok(actual.citations.every(c=>!c.live)); }
 checks++;
}
// GBX_LIVE_ROUTE: "all" sends a question no prepared rule covers to the live agent with no mandatory source, while "matched"
// keeps it in the library when no best match is a migrated document. The withheld and unavailable checks still come first.
for (const route of ["matched","all"]) {
 cfg.aiEnabled=true; cfg.live.route=route; cfg.live.sources=["ga-147461"]; state.manifest=onlyGa; reset("Q11");
 const uncovered=await askCloud("zzzzgeobasinsliceprovenanceunknown",user), routed=uncovered.trace.find(t=>t.step==="Routed to the live sources");
 if (route==="all") { assert.equal(state.calls.length,1); assert.deepEqual(state.calls[0].context.requiredSourceIds,[]); assert.match(routed.detail,/^Live route "all"/); }
 else { assert.equal(state.calls.length,0); assert.equal(uncovered.label,"Retrieved"); assert.equal(routed,undefined); }
 for (const q of ${JSON.stringify(withheldQuestions)}) { reset("Q11"); const a=await askCloud(q.q,user); assert.equal(a.reason,"Reuse terms not confirmed"); assert.equal(state.calls.length,0); }
 cfg.live.sources=["peps-sa-marabooka-1"]; state.manifest=null; reset("Q10");
 assert.equal((await askCloud(questions.find(q=>q.id==="Q10").q,user)).reason,"Live publication unavailable"); assert.equal(state.calls.length,0);
 reset("Q11"); assert.equal((await askCloud("zzzzgeobasinsliceprovenanceunknown",user)).reason,"No passage was retrieved"); assert.equal(state.calls.length,0);
 checks++;
}
delete cfg.live.route;
for (const m of [null,{invalid:true},onlyGa]) for (const enabled of [false,true]) {
 cfg.aiEnabled=enabled; cfg.live.sources=["peps-sa-marabooka-1"]; state.manifest=m;
 for (const q of questions.filter(q=>q.id!=="Q01")) { reset(q.id); const a=await askCloud(q.q,user); assert.equal(a.reason,"Live publication unavailable"); assert.equal(a.label,"Not found"); assert.deepEqual(a.citations,[]); assert.deepEqual(a.hits,[]); assert.equal(a.focusBasin,null); assert.equal(state.calls.length,0); assert.deepEqual(state.models,[]); checks++; }
}
for (const enabled of [false,true]) {
 cfg.aiEnabled=enabled; cfg.live.sources=["peps-sa-marabooka-1"]; state.manifest=null; reset("Q01");
 const q=questions.find(q=>q.id==="Q01"); const expected=await ask012(q.q,null,user); reset("Q01"); const a=await askCloud(q.q,user);
 assert.deepEqual(stable(a),expect012(expected)); assert.equal(state.calls.length,0); checks++;
}
cfg.aiEnabled=true; cfg.live.sources=["ga-147461"]; state.manifest=mar; reset("Q01");
assert.equal((await askCloud(questions[0].q,user)).reason,"Live publication unavailable"); checks++;
cfg.aiEnabled=true; cfg.live.sources=["peps-sa-marabooka-1"]; state.manifest=null;
for (const q of ${JSON.stringify(withheldQuestions)}) { reset("Q11"); const a=await askCloud(q.q,user); assert.equal(a.reason,"Reuse terms not confirmed"); assert.deepEqual(a.citations,[]); assert.deepEqual(state.models,[]); assert.equal(state.searches.length,1); checks++; }
const noCite="zzzzgeobasinsliceprovenanceunknown"; assert.equal(answer5(noCite,{basin:null}).citations.length,0);
cfg.live.sources=["peps-sa-marabooka-1"]; state.manifest=null; reset("Q11");
const missingDoc={...state.documents[0]}; reset("Q01"); const allowedDoc={...state.documents[0]};
const unrelated=questions.find(q=>q.id==="Q01").q;
assert.equal(answer5(unrelated,{basin:null}).citations.some(c=>c.doc.includes("Marabooka")),false);
// The unavailable report ranks first without exclusions. It must not veto an unrelated answer from an allowed source.
const expectedAllowed=await ask012(unrelated,null,user); reset("Q01"); state.documents=[missingDoc,allowedDoc];
const allowed=await askCloud(unrelated,user); assert.deepEqual(stable(allowed),expect012(expectedAllowed)); assert.equal(allowed.label,"Retrieved");
assert.deepEqual(allowed.citations.map(c=>c.id),[allowedDoc.id]); assert.equal(state.searches.length,1); assert.ok(state.searches[0].select.includes("text"));
// Since 0.13.30 the query no longer filters out the live lane's report, so routing can see it; the answer above still never cites it.
assert.ok(!state.searches[0].filter.includes("marabooka-1-completion-report")); checks++;
// Even a backend ignoring exclusions is defended by the existing licence and packaged post-filters.
reset("Q01"); state.ignoreFilter=true; state.documents=[missingDoc,{...missingDoc,id:"unknown-withheld",docId:"unknown-withheld",source:"gsq-cr000407"},allowedDoc];
const defended=await askCloud(unrelated,user); assert.equal(defended.label,"Retrieved"); assert.deepEqual(defended.citations.map(c=>c.id),[allowedDoc.id]); assert.equal(state.searches.length,1); checks++;
reset("Q11"); const absent=await askCloud(noCite,user); assert.equal(absent.reason,"No passage was retrieved"); assert.notEqual(absent.reason,"Live publication unavailable"); assert.deepEqual(state.models,[]); assert.equal(state.searches.length,1); checks++;
reset("Q11"); state.documents[0].docId="renamed-v1"; state.documents[0].id="renamed-v1";
const renamed=await askCloud(noCite,user); assert.equal(renamed.reason,"No passage was retrieved"); assert.deepEqual(renamed.citations,[]); assert.deepEqual(state.models,[]); assert.equal(state.searches.length,1); checks++;
for (const committed of [[],["peps-sa-marabooka-1"]]) {
 cfg.live.sources=committed; state.manifest=null; reset("Q11"); const id=state.documents[0].id;
 const source=await sourcePassage(id,user); assert.equal(!!source,committed.length===0); if (source) assert.equal(source.provenanceLabel,undefined);
 const near=await sourcesNear({lon:140.6102,lat:-28.176,km:50},user); assert.equal(near.matched,committed.length?0:1); checks++;
}
cfg.live.sources=["peps-sa-marabooka-1"]; state.manifest=mar; cfg.aiEnabled=false; reset("Q10"); assert.equal((await askCloud(questions.find(q=>q.id==="Q10").q,user)).reason,"Validation incomplete"); checks++;
state.manifest=null; reset(); const declined=await askCloud("What is the share price of a mining company today in Marabooka 1?",user); assert.equal(declined.status,"declined"); assert.equal(state.calls.length,0); checks++;
const app=Fastify(); registerLiveServingRoutes(app,()=>user);
const expectedMissing=["peps-sa-marabooka-1"];
const endpoints=[
 {name:"answer",call:()=>askCloud(questions.find(q=>q.id==="Q10").q,user), good:(a)=>assert.equal(a.label,"Retrieved"), closed:(a)=>{assert.equal(a.reason,"Live publication unavailable");assert.deepEqual(a.citations,[]);}},
 {name:"source reopen",call:()=>sourcePassage("legacy-Q01",user),good:(p)=>assert.equal(p.provenanceLabel,"packaged snapshot"),closed:(p)=>{assert.equal(p.id,"legacy-Q01");assert.equal(p.provenanceLabel,undefined);}},
 {name:"near search",call:()=>sourcesNear({lon:140.6102,lat:-28.176,km:50},user),good:(r)=>assert.deepEqual(r.sources.map(s=>s.id),["legacy-Q01"]),closed:(r)=>assert.deepEqual(r.sources.map(s=>s.id),["legacy-Q01"])},
 {name:"GET /api/live/manifest",call:async()=>{const r=await app.inject("/api/live/manifest");assert.equal(r.statusCode,200);assert.equal(r.headers["cache-control"],"private, no-store");return r.json();},good:(m)=>assert.equal(m.enabled,true),closed:(m)=>{assert.equal(m.enabled,false);assert.deepEqual(m.sources,[]);assert.deepEqual(m.requiredSourceIds,expectedMissing);}}
];
try {
 for (const endpoint of endpoints) for (const failure of ["missing","invalid","unreadable","incomplete"]) {
  cfg.aiEnabled=true; cfg.live.sources=expectedMissing; state.manifest=manifestFixture(); reset("Q01"); state.documents.unshift(missingDoc);
  endpoint.good(await endpoint.call()); assert.equal(state.downloads.length,1,endpoint.name+" warm read");
  const etag=state.downloads[0].responseEtag; assert.ok(etag);
  state.manifestMode=failure; endpoint.closed(await endpoint.call());
  assert.equal(state.downloads.length,2,endpoint.name+" must revalidate before TTL expiry"); assert.equal(state.downloads[1].ifNoneMatch,etag);
  // The next actual caller must not reuse the last-good manifest or its ETag.
  endpoint.closed(await endpoint.call()); assert.equal(state.downloads.length,3); assert.equal(state.downloads[2].ifNoneMatch,undefined);
  if(endpoint.name==="answer") assert.equal(state.calls.length,1,"No agent call after publication failure");
  state.manifestMode="auto"; state.manifest=manifestFixture(2); endpoint.good(await endpoint.call());
  assert.equal(state.downloads.length,4); assert.equal(state.downloads[3].ifNoneMatch,undefined);
  checks++; console.log("PASS "+endpoint.name+" revalidates and immediately closes after "+failure);
 }
 for (const endpoint of endpoints) {
  cfg.aiEnabled=true; cfg.live.sources=expectedMissing; state.manifest=manifestFixture(); reset("Q01"); state.documents.unshift(missingDoc);
  endpoint.good(await endpoint.call()); endpoint.good(await endpoint.call());
  assert.equal(state.downloads.length,2); assert.equal(state.downloads[1].status,304); assert.equal(state.downloads[1].ifNoneMatch,state.downloads[0].responseEtag);
  checks++; console.log("PASS "+endpoint.name+" conditionally revalidates unchanged publication");
 }
 cfg.live.sources=[]; state.manifest=both; reset("Q01");
 assert.equal((await endpoints[3].call()).enabled,false); assert.equal(state.downloads.length,0);
 for (const endpoint of endpoints) await endpoint.call();
 assert.equal(state.downloads.length,0,"No serving entry point may download when the commitment list is empty");
 assert.deepEqual(await liveManifest.read({fresh:true}),{manifest:null,etag:null}); assert.equal(state.downloads.length,0);
 assert.equal((await app.inject("/api/pages/peps-sa-marabooka-1/"+mar.sources[0].documents[0].sha256+"/25")).statusCode,404); assert.equal(state.downloads.length,0); checks++;
 cfg.live.sources=expectedMissing;
 const committedView=await endpoints[3].call(); assert.equal(committedView.enabled,true); assert.deepEqual(committedView.sources.map(s=>s.sourceId),expectedMissing); assert.equal(state.downloads.length,1); checks++;
 cfg.live.sources=["ga-147461"]; const gaView=await endpoints[3].call(); assert.deepEqual(gaView.sources.map(s=>s.sourceId),["ga-147461"]);
 assert.equal((await app.inject("/api/pages/peps-sa-marabooka-1/"+mar.sources[0].documents[0].sha256+"/25")).statusCode,404); checks++;
 cfg.live.sources=[]; const disabled=await endpoints[3].call(); assert.equal(disabled.enabled,false); assert.deepEqual(disabled.sources,[]); assert.equal(state.downloads.length,2,"Clearing commitments must not reuse or download a cached publication"); checks++;

} finally { await app.close(); }
console.log(checks+" live answer-routing/0.12.0 compatibility checks passed. Azure requests: 0.");
`;
try {
  await build({ stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile, define: cloudDefines, logLevel: "error", plugins: [{ name: "no-cloud", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.path === "fastify") return { path: apiRequire.resolve("fastify"), external: true };
      if (a.path === "baseline-answer") return { path: "baseline", namespace: "baseline" };
      if (a.path === "live-test-state") return { path: "state", namespace: "fake" };
      if (a.path === "@azure/identity") return { path: "identity", namespace: "fake" };
      if (a.path === "@azure/search-documents") return { path: "geography", namespace: "fake" };
      if (!a.path.startsWith(".")) return;
      const p = path.resolve(a.resolveDir, a.path).replace(/\.ts$/, ""), base = path.join(root, "services/api/src");
      const files = { azure: "azure", config: "config", usage: "usage", "live/agent-answer": "agent" };
      for (const [file, name] of Object.entries(files)) if (p === path.join(base, file)) return { path: name, namespace: "fake" };
    });
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: mocks[a.path], loader: "js", resolveDir: root }));
    b.onLoad({ filter: /.*/, namespace: "baseline" }, () => ({ contents: baseline, loader: "ts", resolveDir: path.join(root,"services/api/src") }));
  } }, appAliases(await cloudBuildData())] });
  await import(pathToFileURL(outfile).href);
} finally { fs.rmSync(outfile, { force: true }); }
