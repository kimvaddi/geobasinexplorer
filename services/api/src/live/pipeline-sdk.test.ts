// SDK-boundary tests bundle adapters with strict in-memory clients, never contacting Azure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const { build } = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");
test("storage, queues and model services obey the real SDK call shapes and book caps before work", async () => {
  const output = `.pipeline-sdk-${randomUUID()}.mjs`;
  const mocks: Record<string, string> = {
    state: `export const state={events:[],length:3,etag:'E',tableError:0,cap:false,partial:false,usage:2,rows:[],ocr:0,embeddings:0,polls:0,tokenScopes:[],docs:[]};`,
    azure: `import {state} from 'proof-state';
      export const credential={getToken:async(scope)=>{state.tokenScopes.push(scope);return {token:'unit-token',expiresOnTimestamp:9999999999999};}};
      export const blobs=()=>({getContainerClient:()=>({getBlobClient:()=>({getProperties:async()=>({etag:state.etag,contentLength:state.length,contentType:'application/json',metadata:{},versionId:'v1'}),
        downloadToBuffer:async(b,offset,count,o)=>{if(offset!==0||count!==state.length||o.conditions.ifMatch!==state.etag||o.concurrency!==1)throw Error('wrong download overload');b.write('abc');return b;}}),
        getBlockBlobClient:()=>({uploadData:async(b,o)=>{if(!o.conditions||!(o.conditions.ifMatch||o.conditions.ifNoneMatch==='*'))throw Error('missing write precondition');state.events.push(['blobWrite',o]);}})})});
      export const table=()=>({getEntity:async(p,r,o)=>{if(state.tableError)throw Object.assign(Error('table'),{statusCode:state.tableError});return {partitionKey:p,rowKey:r,etag:'T'};},
        createEntity:async(e,o)=>{if(Object.values(e).some(v=>typeof v==='object'))throw Error('non-scalar table property');state.events.push(['create',e]);},
        updateEntity:async(e,mode,o)=>{if(mode!=='Merge'||!o.etag||o.etag==='*')throw Error('unconditional update');state.events.push(['update',e]);},
        listEntities:()=>({async *[Symbol.asyncIterator](){yield* state.rows;}})});
      export const docIntel=(options)=>{state.events.push(['diClient',options]);return {path:(route,model,resultId)=>({
        post:async(o)=>{if(model!=='prebuilt-layout'||o.queryParameters.stringIndexType!=='utf16CodeUnit'||o.contentType!=='application/octet-stream'||!o.headers['x-ms-client-request-id'])throw Error('wrong layout API');state.ocr++;state.events.push(['ocr']);return {status:'202',headers:{'operation-location':'https://di.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/11111111-2222-4333-8444-555555555555?api-version=2024-11-30'}};},
        get:async(o)=>{if(route!=='/documentModels/{modelId}/analyzeResults/{resultId}'||model!=='prebuilt-layout'||resultId!=='11111111-2222-4333-8444-555555555555')throw Error('wrong analysis lookup');state.polls++;return {status:'200',headers:{},body:{status:'succeeded',analyzeResult:{fixture:true}}};}
      })}};
      export const embed=async(texts,o)=>{if(o.maxRetries!==0)throw Error('unbudgeted retry');state.embeddings++;state.events.push(['embed']);o.onUsage(state.usage);return texts.map(()=>Array(3072).fill(0));};`,
    config: `export const cfg={aiEnabled:true,models:{embed:'text-embedding-3-large'},deployments:{embed:'gbx-embed'},docIntelEndpoint:()=> 'https://di.cognitiveservices.azure.com',storageAccount:()=> 'storage',searchEndpoint:()=> 'https://search.invalid',caps:{indexPassages:20000,tokensPerDay:1200000,tokensPerMonth:12000000,ocrPagesPerDay:500,ocrPagesPerMonth:5000}};`,
    usage: `import {state} from 'proof-state';export const keys={ocrPages:'ocr',tokens:'tokens'};export const takeBoth=async(k,n)=>{state.events.push(['bookOcr',n]);if(state.cap)throw Error('cap');};export const reserve=async(k,n)=>{state.events.push(['reserve',n]);if(state.cap)throw Error('cap');return {amount:n};};export const settle=async(r,n)=>{state.events.push(['settle',n]);};`,
    contracts: `export const LIVE_INDEX_NAME='gbx-evidence-v2';`,
    search: `import {state} from 'proof-state';export class GeographyPoint{constructor(p){Object.assign(this,p);}}export class SearchClient{constructor(url,index){if(index!=='gbx-evidence-v2')throw Error('wrong index');}async getDocumentsCount(){return 0;}async search(q,o){const all=state.docs,top=o.top,skip=o.skip||0;if(top!==undefined&&(top<1||top>1000))throw Error('top must be 1..1000');const page=top===undefined?all.slice(0,50):all.slice(skip,skip+top);return {count:o.includeTotalCount?all.length:undefined,results:(async function*(){for(const d of page)yield {document:d};})()};}async uploadDocuments(r,o){return {results:r.map((x,i)=>({succeeded:!state.partial||i>0,key:x.id}))};}}`,
    queue: `import {state} from 'proof-state';export class QueueClient{constructor(url,credential,opts){if(opts.retryOptions.maxTries!==1)throw Error('queue retries');this.url=url;}async sendMessage(v,o){state.events.push(['send',this.url,v]);}}`,
    intelligence: `export const isUnexpected=r=>!['200','202'].includes(r.status);`,
  };
  const entry = `import assert from 'node:assert/strict';import {state} from 'proof-state';import {azurePipelineStore} from './src/live/pipeline-store';import {azurePipelineServices} from './src/live/pipeline-services';
    globalThis.fetch=()=>{throw Error('A test attempted a network request');};
    const s=azurePipelineStore(), services=azurePipelineServices(), signal=AbortSignal.timeout(1000);
    assert.equal((await s.read('processed','x',3,signal)).buffer.toString(),'abc');state.length=4;await assert.rejects(s.read('processed','x',3,signal));state.length=3;
    await s.write('raw','x',Buffer.from('abc'),{ifNoneMatch:'*'},'application/pdf',{},signal);await assert.rejects(s.write('raw','x',Buffer.from('abc'),{ifMatch:'*'},'application/pdf'));
    await s.put('jobs',{partitionKey:'p',rowKey:'r'},'T',signal);await assert.rejects(s.put('jobs',{partitionKey:'p',rowKey:'r'},'*'));
    await assert.rejects(s.put('registry',{partitionKey:'p',rowKey:'r',nested:{x:1}}));state.tableError=404;assert.equal(await s.get('jobs','p','r'),null);state.tableError=403;await assert.rejects(s.get('jobs','p','r'));state.tableError=0;
    state.rows=[{id:1},{id:2}];await assert.rejects(s.list('jobs','p',1));
    const wire=Buffer.from(JSON.stringify({jobId:'id',owner:'o',blob:'x',route:'process-jobs'})).toString('base64');await s.send('scan-jobs',wire);assert.deepEqual(state.events.at(-1),['send','https://storage.queue.core.windows.net/scan-jobs',wire]);
    state.partial=true;await assert.rejects(s.upload([{id:'x',points:[]}],signal));state.partial=false;
    state.docs=Array.from({length:452},(_,i)=>({id:'c'+i,page:i+1}));const ref={sourceId:'peps-sa-marabooka-1',sha256:'a'.repeat(64),extractionVersion:'x'};assert.equal((await s.indexed(ref,signal)).length,452);state.docs=Array.from({length:2400},(_,i)=>({id:'d'+i,page:i+1}));assert.equal((await s.indexed(ref,signal)).length,2400);state.docs=[];
    const checkpoint=()=>{let submitted=null,operation=null;return {submission:async()=>submitted,operation:async()=>operation,saveSubmission:async(v)=>{submitted=v;state.events.push(['submitted']);},saveOperation:async(v)=>{operation=v;state.events.push(['savedOperation']);}};};const saved=checkpoint();
    state.events=[];await services.analyze(Buffer.from('pdf'),2,signal,saved);assert.ok(state.events.findIndex(e=>e[0]==='bookOcr')<state.events.findIndex(e=>e[0]==='ocr'));assert.ok(state.events.findIndex(e=>e[0]==='submitted')<state.events.findIndex(e=>e[0]==='ocr'));assert.equal(state.events.find(e=>e[0]==='diClient')[1].apiVersion,'2024-11-30');assert.equal(state.events.find(e=>e[0]==='diClient')[1].retryOptions.maxRetries,0);
    const ocrBefore=state.ocr;await services.analyze(Buffer.from('pdf'),2,signal,saved);assert.equal(state.ocr,ocrBefore);assert.equal(state.polls,2);
    state.cap=true;const before=state.ocr;await assert.rejects(services.analyze(Buffer.from('pdf'),2,signal,checkpoint()));assert.equal(state.ocr,before);await assert.rejects(services.embeddings(['abc'],signal));assert.equal(state.embeddings,0);
    state.cap=false;state.events=[];await services.embeddings(['abc'],signal);assert.deepEqual(state.events[0],['reserve',11]);assert.deepEqual(state.events.at(-1),['settle',2]);
    state.usage=999;state.events=[];await assert.rejects(services.embeddings(['abc'],signal));assert.deepEqual(state.events.at(-1),['settle',null]);
    await assert.rejects(s.write('quarantine','uploads/user/file.pdf',Buffer.from('abc'),{ifNoneMatch:'*'},'application/pdf'));
    await assert.rejects(s.write('quarantine','sources/../uploads/file.pdf',Buffer.from('abc'),{ifNoneMatch:'*'},'application/pdf'));
    await s.write('quarantine','sources/ga-147461/'+ 'a'.repeat(64) +'/147461_00_0.zip',Buffer.from('abc'),{ifNoneMatch:'*'},'application/zip');
    process.env.PURVIEW_ENDPOINT='https://test.purview.azure.com';process.env.PURVIEW_COLLECTION_ID='collection';const requests=[];
    globalThis.fetch=async(url,o)=>{const u=new URL(url);requests.push(u);assert.equal(u.searchParams.get('api-version'),'2023-09-01');assert.equal(o.headers.Authorization,'Bearer unit-token');
      if(u.pathname.includes('/types/')&&o.method==='GET')return new Response('{}',{status:404});
      return new Response(JSON.stringify(u.pathname.includes('uniqueAttribute')?{entity:{guid:'guid-'+requests.length}}:{}));};
    await services.catalogue({sourceId:'ga-147461',title:'Guide',licence:'CC BY 4.0'}, {sourceId:'ga-147461',sha256:'a'.repeat(64),extractionVersion:'v',rawBlobVersionId:'raw-v1',scanTagsJson:'{}',archiveMembersJson:'[]',chunkCount:1},1,signal);
    assert.ok(requests.some(u=>u.pathname.endsWith('/types/typedefs')));assert.ok(requests.some(u=>u.pathname.includes('/types/entitydef/')));assert.ok(requests.some(u=>u.pathname.includes('/types/classificationdef/')));
    assert.ok(requests.some(u=>u.pathname.includes('/entity/uniqueAttribute/')));assert.ok(requests.some(u=>u.pathname.endsWith('/entity/bulk')));
    assert.equal(state.tokenScopes.length,requests.length);assert.ok(state.tokenScopes.every(s=>s==='https://purview.azure.net/.default'));

    export const passed=true;`;
  try {
    await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "sdk-proof.ts" }, outfile: output, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent",
      plugins: [{ name: "strict-sdk-fakes", setup(build) {
        build.onResolve({ filter: /./ }, (args) => {
          const exact: Record<string, string> = { "proof-state": "state", "@azure/search-documents": "search", "@azure/storage-queue": "queue", "@azure-rest/ai-document-intelligence": "intelligence" };
          const name = exact[args.path] ?? (/\/azure$/.test(args.path) ? "azure" : /\/usage$/.test(args.path) ? "usage" : /\/config$/.test(args.path) ? "config" : /\/contracts$/.test(args.path) ? "contracts" : undefined);
          return name ? { path: name, namespace: "fake" } : undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "fake" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
      } }],
    });
    assert.equal((await import(pathToFileURL(path.resolve(output)).href)).passed, true);
  } finally { await fs.unlink(output).catch(() => {}); }
});
