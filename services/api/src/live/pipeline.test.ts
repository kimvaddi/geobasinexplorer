// No Azure requests: memory adapters enforce conditional writes and explicit download offset/count.
// node build.mjs --script src/live/pipeline.test.ts && node --test dist/scripts/pipeline.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync, deflateRawSync } from "node:zlib";
import Fastify from "fastify";
import fs from "node:fs/promises";
import type { BlobClient } from "@azure/storage-blob";
import type { AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import { cfg } from "../config";
import { liveScanVerdict, requireCleanScan, readScannedBlob, readUnscannedBlob, sha256Of, ScanVerdictError } from "../scan-verdict";
import { LIVE_SOURCE_IDS, LIVE_TABLES, LIVE_ROUTES, pageImageBlobName, type ClamAvTags, type ExtractionRef, type LineageRow, type LiveEvidenceRecord, type SilverChunkRecord, type SourceRegistryRow } from "./contracts";
import { PIPELINE_TABLES, PIPELINE_LIMITS } from "./pipeline-config";
import { SOURCE_ARTIFACTS, NATIONAL_SOURCES, NATIONAL_SOURCES_WAVE2, NATIONAL_SOURCES_WAVE3, OWNER_APPROVED_SOURCES, reuseAllowed, seedRegistry, allowedSource, landArtifact, sourceArtifact, sourceBlobName, sourceBytesFor, type PipelineJob, type SliceSourceId } from "./pipeline-registry";
import { CATALOGUE_RECORDS, LIVE_SOURCE_PLACES, PHASE1A_V1_DOC_IDS } from "./source-policy";
import { renderEcatRecord } from "./catalogue-ecat";
import { normalizeLayout, extractionPrefix } from "./pipeline-layout";
import { crc32, extractPdfs } from "./pipeline-zip";
import { requirePng, pdfPageCount, renderPages, rendererVersion } from "./pipeline-native";
import { immutableBlob, immutableJson, readJson, parallelBounded } from "./pipeline-artifacts";
import { boundedResponse } from "./pipeline-http";
import { queueProcessingRetry } from "./pipeline-retry";
import { runLiveWorker } from "./pipeline-worker";
import { decodeProcessMessage, documentTitle, processLiveJob, missingRenderedPages, publishableMembers } from "./pipeline-process";
import { decideSourceReview, registerLiveAdminRoutes, reviewDetail } from "./pipeline-admin";
import { currentManifest, publishExtraction, queueApprovedRepublish, reviewKey } from "./pipeline-publish";
import { lineagePayload, pushPurviewLineage } from "./pipeline-purview";
import type { PipelineReviewRow, PipelineServices, ExtractionBundle } from "./pipeline-types";
import type { PipelineStore, Row, BlobInfo, WriteCondition, IndexedRecord } from "./pipeline-store";

const fault = (statusCode: number) => Object.assign(new Error(`simulated ${statusCode}`), { statusCode });
class MemoryStore implements PipelineStore {
  rows = new Map<string, Row>(); blobs = new Map<string, { bytes: Buffer; info: BlobInfo }>(); index = new Map<string, LiveEvidenceRecord>();
  sent: { queue: string; value: string }[] = []; writes: string[] = []; serial = 0; failCurrent = false; partialIndex = false; failSend = false;
  key(t: string, p: string, r: string) { return `${t}|${p}|${r}`; }
  async get<T extends object>(t: string, p: string, r: string) { const row = this.rows.get(this.key(t,p,r)); return row ? structuredClone(row) as T & { etag: string } : null; }
  async put(t: string, row: Row, etag?: string) {
    const k = this.key(t,row.partitionKey,row.rowKey), old = this.rows.get(k);
    if (etag ? !old || etag === "*" || old.etag !== etag : !!old) throw fault(etag ? 412 : 409);
    this.rows.set(k, { ...old, ...structuredClone(row), etag: `row-${++this.serial}` });
  }
  async list<T extends object>(t: string, p: string, max: number) { const rows = [...this.rows.entries()].filter(([k])=>k.startsWith(`${t}|${p}|`)).map(([,r])=>structuredClone(r) as T & {etag:string}); if(rows.length>max) throw new Error("limit"); return rows; }
  async stat(c: string, n: string) { return this.blobs.get(`${c}/${n}`)?.info ?? null; }
  async read(c: string, n: string, max: number) { const b=this.blobs.get(`${c}/${n}`); if(!b)return null; if(b.bytes.length>max)throw new Error("size cap"); return {buffer:Buffer.from(b.bytes),info:{...b.info}}; }
  async write(c: string,n: string,b: Buffer,condition: WriteCondition,type: string,metadata: Record<string,string>={}) {
    const k=`${c}/${n}`, old=this.blobs.get(k);
    if(c==='manifests'&&n==='current.json'&&this.failCurrent) throw fault(412);
    if('ifNoneMatch' in condition ? condition.ifNoneMatch!=='*'||!!old : !old||condition.ifMatch==='*'||condition.ifMatch!==old.info.etag)throw fault('ifNoneMatch' in condition?409:412);
    this.blobs.set(k,{bytes:Buffer.from(b),info:{etag:`blob-${++this.serial}`,bytes:b.length,contentType:type,metadata,versionId:`version-${this.serial}`}});this.writes.push(k);
  }
  async send(queue: string,value: string){if(this.failSend)throw new Error('queue down');this.sent.push({queue,value});}
  async countIndex(){return this.index.size;}
  async indexed(ref:ExtractionRef){return [...this.index.values()].filter(x=>x.sourceId===ref.sourceId&&x.sha256===ref.sha256&&x.extractionVersion===ref.extractionVersion) as IndexedRecord[];}
  async upload(records:LiveEvidenceRecord[]){ for(const r of records){this.index.set(r.id,r);if(this.partialIndex)throw new Error('partial index failure');} }
}
const bytes=Buffer.from('%PDF-1.7\nSynthetic unit fixture\n%%EOF');
const now=new Date('2026-11-02T18:00:00Z').valueOf();
const tags=(b=bytes,time=now):ClamAvTags=>({'gbx-clamav-scan-result':'No threats found','gbx-clamav-sha256':sha256Of(b),'gbx-clamav-engine':'1.4.6 outdated','gbx-clamav-signature-version':'main:63/daily:28172/bytecode:339','gbx-clamav-signature-date':new Date(time-3600000).toISOString(),'gbx-clamav-scanned-at':new Date(time-1000).toISOString()});
function png(){ const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length);head.write(type,4);const tail=Buffer.alloc(4);tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([head,data,tail]);};const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,255,255]))),chunk('IEND',Buffer.alloc(0))]); }
function layout():AnalyzeResultOutput {
  const content='Report heading\nFirst page geological evidence.\nSecond page geological evidence.';
  const split=content.indexOf('Second');
  return {apiVersion:'2024-11-30',modelId:'prebuilt-layout',stringIndexType:'utf16CodeUnit',content,
    pages:[{pageNumber:1,width:8,height:11,unit:'inch',spans:[{offset:0,length:split}],words:[{content:'First',polygon:[0,0,1,0,1,1,0,1],span:{offset:15,length:5},confidence:.95}]},
      {pageNumber:2,width:8,height:11,unit:'inch',spans:[{offset:split,length:content.length-split}],words:[]}],
    paragraphs:[{content:'Report heading',role:'sectionHeading',spans:[{offset:0,length:14}],boundingRegions:[{pageNumber:1,polygon:[0,0,1,0,1,1,0,1]}]},
      {content:content.slice(split),spans:[{offset:split,length:content.length-split}],boundingRegions:[{pageNumber:2,polygon:[0,0,2,0,2,2,0,2]}]}],
    sections:[{spans:[{offset:0,length:content.length}],elements:['/paragraphs/0','/paragraphs/1']}],
  };
}
const owner={id:'owner-fixture',name:'Owner',owner:true,roles:[]};
async function setup(){
  const store=new MemoryStore(); await seedRegistry(store); const id='peps-sa-marabooka-1';const row=(await store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry,'source',id))!;
  await store.put(LIVE_TABLES.sourceRegistry,{partitionKey:'source',rowKey:id,expectedSha256:sha256Of(bytes)},row.etag);
  const landed=await landArtifact(store,id,bytes,owner.id); const counters={ocr:0,embed:0,catalogue:0,render:0};
  const services:PipelineServices={scan:async()=>({buffer:bytes,sha256:sha256Of(bytes),tags:tags(bytes,Date.now()),etag:'quarantine-etag'}),rendererVersion:async()=>'25.1.0',countPages:async()=>2,
    analyze:async()=>{counters.ocr++;return layout();},render:async(_b,pages,save)=>{for(const p of pages){counters.render++;await save(p,png());}},
    embeddings:async(texts)=>{counters.embed++;return texts.map(()=>Array(3072).fill(.1));},catalogue:async()=>{counters.catalogue++;}};
  const message=decodeProcessMessage(store.sent[0].value);return {store,services,counters,landed,message};
}
async function ready(){const s=await setup();await processLiveJob(s.store,s.services,s.message);const job=(await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs,'job',s.landed.jobId))!;const ref={sourceId:job.sourceId,sha256:job.sha256,extractionVersion:job.extractionVersion!};const row=(await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews,ref.sourceId,reviewKey(ref)))!;return {...s,job,ref,row};}
async function approve(s:Awaited<ReturnType<typeof ready>>){return decideSourceReview(s.store,s.ref,{...s.ref,decision:'approved',reason:'Reviewed source licence, scan and extraction.'},owner,s.row.etag);}

test('all six exact tags, exact verdict, hashes, signatures and temporal bounds are mandatory',()=>{
  assert.equal(requireCleanScan({...tags()},now)['gbx-clamav-scan-result'],'No threats found');
  for(const key of Object.keys(tags())){const t=tags() as unknown as Record<string,string>;delete t[key];assert.throws(()=>requireCleanScan(t,now),ScanVerdictError);}
  for(const patch of [{'gbx-clamav-scan-result':'no threats found'},{'gbx-clamav-scan-result':'Malicious'},{'gbx-clamav-sha256':'A'.repeat(64)}, {'gbx-clamav-engine':'unavailable'},{'gbx-clamav-signature-version':'daily:2'},
    {'gbx-clamav-signature-date':new Date(now-3*86400000-1).toISOString()},{'gbx-clamav-scanned-at':new Date(now+1).toISOString()},{'gbx-clamav-signature-date':new Date(now).toISOString()},{'gbx-clamav-scanned-at':'2026-02-30T00:00:00Z'}, {'gbx-clamav-extra':'clean'}])assert.throws(()=>requireCleanScan({...tags(),...patch} as Record<string,string>,now),ScanVerdictError);
  assert.equal(requireCleanScan({...tags(),other:'preserved'},now)['gbx-clamav-engine'],'1.4.6 outdated');
});
test('scan reader uses one bounded buffer, explicit offset/count and content ETag',async()=>{
  let calls=0,passed:Buffer|undefined;
  const fake={getTags:async()=>({tags:tags()}),getProperties:async()=>({contentLength:bytes.length,etag:'E'}),downloadToBuffer:async(b:Buffer,offset:number,count:number,opts:{conditions:{ifMatch:string};concurrency:number})=>{
    assert.equal(offset,0);assert.equal(count,bytes.length);assert.equal(opts.conditions.ifMatch,'E');assert.equal(opts.concurrency,1);calls++;passed=b;bytes.copy(b);return b;}};
  const out=await readScannedBlob(fake as unknown as BlobClient,{maxBytes:1000,expectedSha256:sha256Of(bytes),now:()=>now});assert.equal(calls,1);assert.equal(out.buffer,passed);assert.deepEqual(out.buffer,bytes);
  await assert.rejects(readScannedBlob({...fake,getProperties:async()=>({contentLength:1001,etag:'E'})} as unknown as BlobClient,{maxBytes:1000,expectedSha256:sha256Of(bytes),now:()=>now}),ScanVerdictError);
  await assert.rejects(readScannedBlob({...fake,downloadToBuffer:async(b:Buffer)=>{b.fill(0);return b;}} as unknown as BlobClient,{maxBytes:1000,expectedSha256:sha256Of(bytes),now:()=>now}),ScanVerdictError);
});
test('scan reader rechecks age after download and honors cancellation',async()=>{
  let clock=now;const fake={getTags:async()=>({tags:tags()}),getProperties:async()=>({contentLength:bytes.length,etag:'E'}),downloadToBuffer:async(b:Buffer)=>{bytes.copy(b);clock+=3*86400000;return b;}};
  await assert.rejects(readScannedBlob(fake as unknown as BlobClient,{maxBytes:1000,expectedSha256:sha256Of(bytes),now:()=>clock}),ScanVerdictError);
  const signal=AbortSignal.abort();await assert.rejects(readScannedBlob(fake as unknown as BlobClient,{maxBytes:1000,expectedSha256:sha256Of(bytes),signal}));
});
test('registry seeds with explicit clearance, withholds known sources and never overwrites an owner change',async()=>{
  const s=new MemoryStore();await seedRegistry(s);for(const id of ['gsq-cr000407','gsq-cr050039','sa-dem-core-2026']){const r=await s.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry,'source',id);assert.equal(r?.publishAllowed,false);await assert.rejects(allowedSource(s,id));}
  const r=(await s.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry,'source','ga-147461'))!;await s.put(LIVE_TABLES.sourceRegistry,{partitionKey:'source',rowKey:'ga-147461',publishAllowed:false},r.etag);await seedRegistry(s);await assert.rejects(allowedSource(s,'ga-147461'));
});
test('hash mismatch records an unapproved version and never lands or queues',async()=>{const s=new MemoryStore();await seedRegistry(s);await assert.rejects(landArtifact(s,'peps-sa-marabooka-1',bytes,'owner'));assert.equal(s.blobs.size,0);assert.equal(s.sent.length,0);const versions=await s.list<{publishAllowed:boolean}>(PIPELINE_TABLES.versions,'peps-sa-marabooka-1',10);assert.equal(versions[0].publishAllowed,false);});
test('verified landing is quarantine-only and sends exact scan route',async()=>{const s=await setup();assert.equal(s.store.sent[0].queue,'scan-jobs');assert.equal(s.message.route,'process-jobs');assert.equal(s.store.index.size,0);assert.ok([...s.store.blobs.keys()].every(k=>k.startsWith('quarantine/')));});
test('processing creates complete silver/pages/lineage and pending review without an index write',async()=>{
  const s=await ready();assert.equal(s.store.index.size,0);assert.equal(s.row.status,'pending');assert.equal(s.row.pageCount,2);assert.equal(s.counters.ocr,1);assert.equal(s.counters.render,2);
  const detail=await reviewDetail(s.store,s.ref);assert.equal(detail.samples.length,2);assert.equal(detail.documents[0].rawBlobVersionId.startsWith('version-'),true);assert.equal(detail.samples[0].vector,undefined);
  assert.equal((await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs,'job',s.job.rowKey))?.status,'review');
});
test('duplicate queue deliveries reuse completed review and never OCR twice',async()=>{const s=await ready();await processLiveJob(s.store,s.services,s.message);assert.equal(s.counters.ocr,1);assert.equal(s.counters.embed,1);assert.equal(s.store.index.size,0);});
test('a held job lease leaves duplicate delivery unacknowledged',async()=>{const s=await setup();const j=(await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs,'job',s.landed.jobId))!;await s.store.put(PIPELINE_TABLES.jobs,{partitionKey:'job',rowKey:j.rowKey,leaseUntil:Date.now()+60000},j.etag);assert.equal(await processLiveJob(s.store,s.services,s.message),'busy');assert.equal(s.counters.ocr,0);});
test('message spoofing, a bad scan, malformed vectors and missing OCR pages fail closed',async()=>{
  const spoof=await setup();await assert.rejects(processLiveJob(spoof.store,spoof.services,{...spoof.message,owner:'someone-else'}));
  const scan=await setup();scan.services.scan=async()=>{throw new ScanVerdictError('stale');};await assert.rejects(processLiveJob(scan.store,scan.services,scan.message));assert.equal(scan.counters.ocr,0);
  const vector=await setup();vector.services.embeddings=async()=>[[0]];await assert.rejects(processLiveJob(vector.store,vector.services,vector.message));assert.equal(vector.store.index.size,0);
  const ocr=await setup();ocr.services.analyze=async()=>({...layout(),pages:[]});await assert.rejects(processLiveJob(ocr.store,ocr.services,ocr.message));assert.equal(ocr.store.index.size,0);
});
test('owner approval requires matching identities, current ETag and registry clearance',async()=>{
  const s=await ready(),body={...s.ref,decision:'approved',reason:'Reviewed.'};
  await assert.rejects(decideSourceReview(s.store,s.ref,body,{...owner,owner:false},s.row.etag));await assert.rejects(decideSourceReview(s.store,s.ref,body,owner,undefined));
  await assert.rejects(decideSourceReview(s.store,s.ref,{...body,sha256:'f'.repeat(64)},owner,s.row.etag));await assert.rejects(decideSourceReview(s.store,s.ref,{...body,extra:true},owner,s.row.etag));
  const registry=(await s.store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry,'source',s.ref.sourceId))!;await s.store.put(LIVE_TABLES.sourceRegistry,{partitionKey:'source',rowKey:s.ref.sourceId,publishAllowed:false},registry.etag);await assert.rejects(decideSourceReview(s.store,s.ref,body,owner,s.row.etag));
});
test('approval queues a fresh scan but does not publish; the processing job publishes afterward',async()=>{
  const s=await ready();const out=await approve(s);assert.equal(out.publication.status,'queued');assert.equal(s.store.sent.length,2);assert.equal(s.store.index.size,0);
  await processLiveJob(s.store,s.services,decodeProcessMessage(s.store.sent[1].value));const current=await currentManifest(s.store);assert.equal(current?.manifest.manifestVersion,1);assert.equal(current?.manifest.sources[0].documents[0].sha256,sha256Of(bytes));assert.equal(s.counters.ocr,1);assert.equal(s.store.index.size,2);
});
test('rejection never queues publication and cannot be changed into approval',async()=>{const s=await ready();const out=await decideSourceReview(s.store,s.ref,{...s.ref,decision:'rejected',reason:'Needs another extraction.'},owner,s.row.etag);assert.equal(out.review.status,'rejected');assert.equal(s.store.sent.length,1);await assert.rejects(decideSourceReview(s.store,s.ref,{...s.ref,decision:'approved',reason:'Reviewed.'},owner,out.etag));});
test('a missing page, missing geotag, revoked registry or unapproved row blocks activation',async()=>{
  for(const damage of ['page','geo','registry','review']){const s=await ready();if(damage!=='review')await approve(s);
    if(damage==='page')s.store.blobs.delete([...s.store.blobs.keys()].find(k=>k.startsWith('pages/'))!);
    if(damage==='geo'){const key=[...s.store.blobs.keys()].find(k=>k.includes('/chunks/0.json'))!;const b=s.store.blobs.get(key)!;const v=JSON.parse(b.bytes.toString());v.points=[];b.bytes=Buffer.from(JSON.stringify(v));b.info.metadata.sha256=sha256Of(b.bytes);b.info.bytes=b.bytes.length;}
    if(damage==='registry'){const r=(await s.store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry,'source',s.ref.sourceId))!;await s.store.put(LIVE_TABLES.sourceRegistry,{partitionKey:'source',rowKey:s.ref.sourceId,publishAllowed:false},r.etag);}
    await assert.rejects(publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)));assert.equal(await currentManifest(s.store),null);
  }
});
test('partial index writes or Purview failures keep the manifest absent',async()=>{for(const fault of ['index','catalogue']){const s=await ready();await approve(s);if(fault==='index')s.store.partialIndex=true;else s.services.catalogue=async()=>{throw new Error('Purview unavailable');};await assert.rejects(publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)));assert.equal(await currentManifest(s.store),null);}});
test('ETag conflict preserves current and immutable history; replay skips the occupied generation',async()=>{
  const s=await ready();await approve(s);s.store.failCurrent=true;await assert.rejects(publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)));assert.equal(await currentManifest(s.store),null);assert.ok(s.store.blobs.has('manifests/v1.json'));const old=s.store.blobs.get('manifests/v1.json')!.bytes;
  s.store.failCurrent=false;const v=await publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000));assert.equal(v,2);assert.deepEqual(s.store.blobs.get('manifests/v1.json')!.bytes,old);assert.equal(s.store.index.size,2);
});
test('replaying an already active approved tuple is idempotent and never duplicates index records',async()=>{const s=await ready();await approve(s);assert.equal(await publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)),1);assert.equal(await publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)),1);assert.equal(s.store.index.size,2);});
test('malformed current manifest is not treated as an empty bootstrap',async()=>{const s=await ready();await approve(s);await s.store.write('manifests','current.json',Buffer.from('{}'),{ifNoneMatch:'*'},'application/json');await assert.rejects(publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)));assert.equal(s.store.blobs.get('manifests/current.json')!.bytes.toString(),'{}');});
test('index cap failure is closed and does not create a manifest',async()=>{const s=await ready();await approve(s);s.store.countIndex=async()=>cfg.caps.indexPassages;await assert.rejects(publishExtraction(s.store,s.services,s.ref,AbortSignal.timeout(10000)));assert.equal(await currentManifest(s.store),null);});
test('immutable artifacts reject changed bytes and validate persisted JSON hashes',async()=>{const s=new MemoryStore();await immutableBlob(s,'raw','x',bytes,'application/pdf',{});await immutableBlob(s,'raw','x',bytes,'application/pdf',{});await assert.rejects(immutableBlob(s,'raw','x',Buffer.from('different'),'application/pdf',{}));await immutableJson(s,'x.json',{a:1});s.blobs.get('processed/x.json')!.info.metadata.sha256='bad';await assert.rejects(readJson(s,'x.json'));});
test('bounded response rejects bad lengths and streaming overflow, and supports missing Content-Length',async()=>{assert.equal((await boundedResponse(new Response('abc'),3)).toString(),'abc');await assert.rejects(boundedResponse(new Response('abcd'),3));await assert.rejects(boundedResponse(new Response('a',{headers:{'content-length':'100'}}),3));await assert.rejects(boundedResponse(new Response(null,{status:503}),3));});
test('PNG parser rejects truncation, corrupt CRC and oversized dimensions',()=>{requirePng(png());assert.throws(()=>requirePng(png().subarray(0,30)));const corrupt=png();corrupt[45]^=1;assert.throws(()=>requirePng(corrupt));});
function zip(name:string, data=bytes, options:{crc?:number;declaredSize?:number;method?:number}={}){const n=Buffer.from(name),method=options.method??8,c=method===8?deflateRawSync(data):data,crc=options.crc??crc32(data);const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(c.length,18);local.writeUInt32LE(options.declaredSize??data.length,22);local.writeUInt16LE(n.length,26);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(c.length,20);central.writeUInt32LE(options.declaredSize??data.length,24);central.writeUInt16LE(n.length,28);const directory=Buffer.concat([central,n]);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(local.length+n.length+c.length,16);return Buffer.concat([local,n,c,directory,end]);}
test('bounded ZIP extraction verifies CRC, counts and paths and retains member hashes',()=>{const out=extractPdfs(zip('folder/report.pdf'),'bundle.zip');assert.equal(out.documents[0].sha256,sha256Of(bytes));assert.equal(out.members[0].name,'folder/report.pdf');for(const name of ['../report.pdf','/report.pdf','C:/report.pdf','folder/../report.pdf','code.js'])assert.throws(()=>extractPdfs(zip(name),'bundle.zip'));assert.throws(()=>extractPdfs(zip('r.pdf',bytes,{crc:0}),'bundle.zip'));assert.throws(()=>extractPdfs(zip('r.pdf',bytes,{declaredSize:1}),'bundle.zip'));assert.throws(()=>extractPdfs(zip('r.pdf',bytes,{method:99}),'bundle.zip'));});
test('layout keeps native page boundaries, heading paths, confidence and registered geotags',async()=>{const s=await ready(),source=(await allowedSource(s.store,s.ref.sourceId)).source;const normalized=normalizeLayout(layout(),2,{...s.ref,docId:'doc',documentSha256:sha256Of(bytes)},source,'Report');assert.equal(normalized.pages.length,2);assert.equal(normalized.chunks[0].headingPath[0],'Report heading');assert.equal(normalized.chunks[1].page,2);assert.equal(normalized.pages[1].confidence,null);assert.equal(normalized.chunks[0].points[0].longitude,140.6102);const invalid=layout();invalid.sections![0].elements=['/sections/0'];assert.throws(()=>normalizeLayout(invalid,2,{...s.ref,docId:'doc',documentSha256:sha256Of(bytes)},source,'Report'));});
test('Purview uses stable qualified names, verified upserts and no destructive operations',async()=>{const s=await ready(),source=(await allowedSource(s.store,s.ref.sourceId)).source,lineage=(await s.store.get<import('./contracts').LineageRow>(LIVE_TABLES.lineage,s.ref.sourceId,reviewKey(s.ref)))!;const calls:{path:string;method:string;body?:unknown}[]=[];
 const transport=async(path:string,method:'GET'|'POST',body?:unknown)=>{calls.push({path,method,body});if(path.startsWith('/types/'))return null;if(path.includes('uniqueAttribute'))return {entity:{guid:'guid-'+calls.length}};return {};};
 await pushPurviewLineage(source,lineage,1,AbortSignal.timeout(1000),transport);assert.deepEqual(lineagePayload(source,lineage,1),lineagePayload(source,lineage,1));assert.ok(calls.some(c=>c.path.startsWith('/types/typedefs?')&&c.method==='POST'));for(const call of calls)assert.equal(new URL(call.path,'https://test.invalid').searchParams.get('api-version'),'2023-09-01');assert.equal(calls.filter(c=>c.path.startsWith('/entity/bulk')).length,2);
});
test('owner routes enforce access before landing, return ETags and never expose Blob URLs',async()=>{
  const s=await ready();let user=owner;const app=Fastify({routerOptions:{maxParamLength:512}});await registerLiveAdminRoutes(app,()=>user,s.store);
  try{user={...owner,owner:false};const denied=await app.inject({method:'GET',url:LIVE_ROUTES.reviews.path});assert.equal(denied.statusCode,403);user=owner;
    const list=await app.inject({method:'GET',url:LIVE_ROUTES.reviews.path});assert.equal(list.statusCode,200);assert.equal(list.json().reviews.length,1);
    const path=`/api/admin/live/reviews/${s.ref.sourceId}/${s.ref.sha256}/${s.ref.extractionVersion}`;const detail=await app.inject({method:'GET',url:path});assert.equal(detail.statusCode,200);assert.equal(detail.headers.etag,s.row.etag);assert.ok(!detail.body.includes('.blob.core.'));
    const image=await app.inject({method:'GET',url:`${path}/pages/${sha256Of(bytes)}/1`});assert.equal(image.statusCode,200);assert.equal(image.headers['cache-control'],'private, no-store');assert.equal(image.headers['content-type'],'image/png');
    const absent=await app.inject({method:'GET',url:`${path}/pages/${'f'.repeat(64)}/1`});assert.equal(absent.statusCode,404);
    const decision=await app.inject({method:'POST',url:`${path}/decision`,headers:{'if-match':String(detail.headers.etag)},payload:{...s.ref,decision:'approved',reason:'Reviewed.'}});assert.equal(decision.statusCode,202);assert.equal(decision.json().publication.status,'queued');
  }finally{await app.close();}
});
test('processing wire decoder rejects extra fields, invalid base64 and wrong routes',()=>{for(const value of ['bad!',Buffer.from(JSON.stringify({jobId:'x',owner:'o',blob:'x',route:'other'})).toString('base64'),Buffer.from('{}').toString('base64')])assert.throws(()=>decodeProcessMessage(value));});
test('bounded parallel operations preserve order and worker concurrency',async()=>{let running=0,maximum=0;const out=await parallelBounded([1,2,3,4],2,async(n)=>{maximum=Math.max(maximum,++running);await new Promise(r=>setTimeout(r,1));running--;return n*2;});assert.deepEqual(out,[2,4,6,8]);assert.equal(maximum,2);});

test('native wrapper enforces page bounds, explicit argv, timeout budgets and workspace cleanup', async () => {
  const dirs: string[] = [];
  const run = async (command: string, args: string[], options: { cwd?: string; timeout: number; signal?: AbortSignal; killSignal: string }) => {
    assert.equal(options.killSignal, "SIGKILL"); assert.ok(options.timeout <= 60_000);
    if (args[0] === "-v") return { stdout: "", stderr: "pdftoppm version 25.1.0\n" };
    assert.ok(options.cwd?.startsWith(".gbx-runs/")); dirs.push(options.cwd!);
    assert.equal((await fs.readFile(`${options.cwd}/document.pdf`)).toString(), bytes.toString());
    if (command === "pdfinfo") return { stdout: "Pages: 2\nEncrypted: no\n", stderr: "" };
    assert.deepEqual(args.slice(0, 5), ["-f", "1", "-l", "1", "-singlefile"]);
    assert.ok(args.includes("-r") && args.includes("110")); assert.equal(args.at(-1), "page");
    await fs.writeFile(`${options.cwd}/page.png`, png()); return { stdout: "", stderr: "" };
  };
  assert.equal(await rendererVersion(undefined, run as never), "25.1.0");
  assert.equal(await pdfPageCount(bytes, undefined, run as never), 2);
  const s = await ready(), detail = await reviewDetail(s.store, s.ref);
  const page = { ...detail.samples[0], width: 8, height: 11, unit: "inch" as const, imageBlob: "unused", confidence: null };
  let count = 0;
  await renderPages(bytes, [page], async (_p, image) => { requirePng(image); count++; }, undefined, run as never);
  assert.equal(count, 1);
  for (const dir of dirs) await assert.rejects(fs.access(dir));
  await assert.rejects(pdfPageCount(bytes, undefined, (async () => ({ stdout: "Pages: 501\n", stderr: "" })) as never));
  await fs.rmdir(".gbx-runs").catch(() => {});
});
test('scan validation has a real fail-closed wall timeout even if an adapter stalls', async () => {
  const fake = { getTags: async () => { await new Promise(r => setTimeout(r, 40)); return { tags: tags() }; }, getProperties: async () => ({ contentLength: bytes.length, etag: "E" }), downloadToBuffer: async (b: Buffer) => { bytes.copy(b); return b; } };
  await assert.rejects(readScannedBlob(fake as unknown as BlobClient, { maxBytes: 1000, expectedSha256: sha256Of(bytes), now: () => now, timeoutMs: 5 }), /timed out/);
});
test('processing decoder refuses duplicate JSON keys rather than silently accepting the last one', () => {
  const wire = Buffer.from('{"jobId":"11111111-2222-4333-8444-555555555555","owner":"o","blob":"x.pdf","route":"process-jobs","route":"process-jobs"}').toString('base64');
  assert.throws(() => decodeProcessMessage(wire), /Duplicate/);
});
test('rollback selects an earlier approved extraction as a higher manifest without deleting or duplicating chunks', async () => {
  const s = await ready(); await approve(s); await publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000));
  const second = await landArtifact(s.store, s.ref.sourceId, bytes, owner.id), message = decodeProcessMessage(s.store.sent.at(-1)!.value);
  await processLiveJob(s.store, s.services, message);
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, "job", second.jobId))!, newer = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
  const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, newer.sourceId, reviewKey(newer)))!;
  await decideSourceReview(s.store, newer, { ...newer, decision: "approved", reason: "Reviewed the new extraction." }, owner, row.etag);
  assert.equal(await publishExtraction(s.store, s.services, newer, AbortSignal.timeout(10000)), 2);
  const count = s.store.index.size;
  await queueApprovedRepublish(s.store, s.ref, AbortSignal.timeout(10000));
  assert.equal(await publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000)), 3);
  assert.equal(s.store.index.size, count); assert.equal((await currentManifest(s.store))?.manifest.sources[0].extractionVersion, s.ref.extractionVersion);
  assert.equal(s.counters.ocr, 2);
});

test('queue worker honors visibility, original receipts, kill-switch holds and processing-attempt retries', async () => {
  const s = await setup(); let acknowledgements = 0;
  const queue = { receiveMessages: async (o: { numberOfMessages: number; visibilityTimeout: number }) => {
    assert.equal(o.numberOfMessages, 1); assert.ok([3600, PIPELINE_LIMITS.queueVisibilitySeconds].includes(o.visibilityTimeout));
    return { receivedMessageItems: [{ messageText: s.store.sent[0].value, messageId: "message", popReceipt: "receipt", dequeueCount: 99 }] };
  }, deleteMessage: async (id: string, receipt: string) => { assert.equal(id, "message"); assert.equal(receipt, "receipt"); acknowledgements++; } };
  await runLiveWorker({ queue: queue as never, store: s.store, services: s.services, enabled: false }); assert.equal(acknowledgements, 0); assert.equal(s.counters.ocr, 0);
  await runLiveWorker({ queue: queue as never, store: s.store, services: s.services }); assert.equal(acknowledgements, 1); assert.equal(s.counters.ocr, 1);
  await runLiveWorker({ queue: queue as never, store: s.store, services: s.services }); assert.equal(acknowledgements, 2); assert.equal(s.counters.ocr, 1);
  const failed = await setup(); let failureAcks = 0; failed.services.analyze = async () => { throw new Error("transient model service failure"); };
  const failingQueue = { receiveMessages: async () => ({ receivedMessageItems: [{ messageText: failed.store.sent[0].value, messageId: "failed", popReceipt: "receipt", dequeueCount: 1 }] }), deleteMessage: async () => { failureAcks++; } };
  for (let attempt = 1; attempt <= 3; attempt++) { await assert.rejects(runLiveWorker({ queue: failingQueue as never, store: failed.store, services: failed.services })); assert.equal(failureAcks, attempt); assert.equal(failed.store.sent.length, 1 + Math.min(attempt, 2)); }
});

test('the server router bound accommodates a fully bound live chunk ID as well as the extraction version', async () => {
  const s = await ready(), detail = await reviewDetail(s.store, s.ref), id = detail.samples[0].id;
  assert.ok(id.length > 192 && id.length < 512);
  const app = Fastify({ routerOptions: { maxParamLength: 512 } }); app.get('/api/source/:id', async (request) => request.params);
  try { const reply = await app.inject({ method: 'GET', url: `/api/source/${encodeURIComponent(id)}` }); assert.equal(reply.statusCode, 200); assert.equal(reply.json().id, id); }
  finally { await app.close(); }
});

test('an unavailable or malformed index count cannot bypass the publication cap', async () => {
  for (const count of [NaN, Infinity, -1, 1.5]) {
    const s = await ready(); await approve(s); s.store.countIndex = async () => count;
    await assert.rejects(publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000)), /capacity could not be verified/);
    assert.equal(await currentManifest(s.store), null);
  }
});

test('review replay of an already active approved tuple is a pure no-op', async () => {
  const s = await ready(); await approve(s); await publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000));
  const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, s.ref.sourceId, reviewKey(s.ref)))!;
  const serial = s.store.serial, sent = s.store.sent.length;
  const result = await decideSourceReview(s.store, s.ref, { ...s.ref, decision: 'approved', reason: 'Reviewed source licence, scan and extraction.' }, owner, row.etag);
  assert.equal(result.publication.status, 'published'); assert.equal(s.store.serial, serial); assert.equal(s.store.sent.length, sent);
  assert.equal((await currentManifest(s.store))?.manifest.manifestVersion, 1);
});
test('review replay cannot requeue an older published extraction after a newer one is current', async () => {
  const s = await ready(); await approve(s); await publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000));
  const next = await landArtifact(s.store, s.ref.sourceId, bytes, owner.id); await processLiveJob(s.store, s.services, decodeProcessMessage(s.store.sent.at(-1)!.value));
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', next.jobId))!, newer = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
  const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, newer.sourceId, reviewKey(newer)))!;
  await decideSourceReview(s.store, newer, { ...newer, decision: 'approved', reason: 'Reviewed newer extraction.' }, owner, row.etag);
  await publishExtraction(s.store, s.services, newer, AbortSignal.timeout(10000));
  const old = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, s.ref.sourceId, reviewKey(s.ref)))!, sent = s.store.sent.length;
  await assert.rejects(decideSourceReview(s.store, s.ref, { ...s.ref, decision: 'approved', reason: 'Reviewed source licence, scan and extraction.' }, owner, old.etag), /explicit.*republish|rollback/i);
  assert.equal(s.store.sent.length, sent); assert.equal((await currentManifest(s.store))?.manifest.sources[0].extractionVersion, newer.extractionVersion);
});

test('render retries skip verified immutable pages and never repeat OCR or embeddings', async () => {
  const s = await setup(), rendered: number[] = [];
  s.services.render = async (_bytes, pages, save) => { rendered.push(pages[0].page); await save(pages[0], png()); throw new Error('render interrupted after page 1'); };
  await assert.rejects(processLiveJob(s.store, s.services, s.message), /interrupted/); assert.equal(s.counters.ocr, 1); assert.equal(s.counters.embed, 1);
  s.services.analyze = async () => { throw new Error('a retry must not rebill OCR'); };
  s.services.embeddings = async () => { throw new Error('a retry must reuse embeddings'); };
  s.services.render = async (_bytes, pages, save) => { for (const page of pages) { rendered.push(page.page); await save(page, png()); } };
  await processLiveJob(s.store, s.services, s.message); assert.deepEqual(rendered, [1, 2]);
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', s.landed.jobId))!; assert.equal(job.status, 'review');
});
test('corrupt, oversized, mismatched or incorrectly named PNG checkpoints fail closed', async () => {
  const s = await ready(), bundle = (await readJson<ExtractionBundle>(s.store, `${extractionPrefix(s.ref)}/extraction.json`))!;
  const page = (await readJson<import('./contracts').SilverPageRecord>(s.store, bundle.documents[0].pages[0]))!, key = `pages/${page.imageBlob}`, original = s.store.blobs.get(key)!;
  assert.deepEqual(await missingRenderedPages(s.store, [page], AbortSignal.timeout(1000)), []);
  for (const corruption of ['signature', 'size', 'metadata']) {
    const damaged = { bytes: Buffer.from(original.bytes), info: { ...original.info, metadata: { ...original.info.metadata } } };
    if (corruption === 'signature') damaged.bytes[0] = 0;
    if (corruption === 'size') damaged.bytes = Buffer.alloc(PIPELINE_LIMITS.imageBytes + 1);
    if (corruption === 'metadata') damaged.info.metadata.documentsha256 = 'f'.repeat(64);
    s.store.blobs.set(key, damaged); await assert.rejects(missingRenderedPages(s.store, [page], AbortSignal.timeout(1000)));
  }
  s.store.blobs.set(key, original);
  await assert.rejects(missingRenderedPages(s.store, [{ ...page, imageBlob: 'sources/wrong/page.png' }], AbortSignal.timeout(1000)), /name is not bound/);
});
function multiZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], directories: Buffer[] = []; let length = 0;
  for (const entry of entries) {
    const single = zip(entry.name, entry.data), end = single.length - 22, directoryAt = single.readUInt32LE(end + 16);
    const local = single.subarray(0, directoryAt), directory = Buffer.from(single.subarray(directoryAt, end)); directory.writeUInt32LE(length, 42);
    locals.push(local); directories.push(directory); length += local.length;
  }
  const central = Buffer.concat(directories), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(length, 16);
  return Buffer.concat([...locals, central, end]);
}
test('GA processing accounts for guide, glossary and acknowledgement PDFs, not an assumed pair', async () => {
  const s = await setup(), archive = multiZip([{name:'TEGI_GEOLOGY-Cooper_Basin_Region.pdf',data:Buffer.from('%PDF-guide')},{name:'TEGI_Glossary.pdf',data:Buffer.from('%PDF-glossary')},{name:'TEGI_Acknowledgements.pdf',data:Buffer.from('%PDF-acknowledgements')}]);
  const registry = (await s.store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, 'source', 'ga-147461'))!;
  await s.store.put(LIVE_TABLES.sourceRegistry, { partitionKey: 'source', rowKey: 'ga-147461', expectedSha256: sha256Of(archive) }, registry.etag);
  const landed = await landArtifact(s.store, 'ga-147461', archive, owner.id);
  s.services.scan = async () => ({ buffer: archive, sha256: sha256Of(archive), tags: tags(archive, Date.now()), etag: 'etag' });
  await processLiveJob(s.store, s.services, decodeProcessMessage(s.store.sent.at(-1)!.value));
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', landed.jobId))!, ref = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
  const bundle = (await readJson<ExtractionBundle>(s.store, `${extractionPrefix(ref)}/extraction.json`))!;
  assert.equal(bundle.documents.length, 3); assert.equal(s.counters.ocr, 3);
  assert.ok(bundle.documents.some(d => d.record.title === 'TEGI acknowledgements'));
  const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, ref.sourceId, reviewKey(ref)))!; assert.equal(row.pageCount, 6);
});
async function processArchive(s: Awaited<ReturnType<typeof setup>>, id: SliceSourceId, archive: Buffer) {
  const registry = (await s.store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, 'source', id))!;
  await s.store.put(LIVE_TABLES.sourceRegistry, { partitionKey: 'source', rowKey: id, expectedSha256: sha256Of(archive) }, registry.etag);
  const landed = await landArtifact(s.store, id, archive, owner.id);
  s.services.scan = async () => ({ buffer: archive, sha256: sha256Of(archive), tags: tags(archive, Date.now()), etag: 'etag' });
  await processLiveJob(s.store, s.services, decodeProcessMessage(s.store.sent.at(-1)!.value));
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', landed.jobId))!, ref = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
  const bundle = (await readJson<ExtractionBundle>(s.store, `${extractionPrefix(ref)}/extraction.json`))!;
  return { bundle, chunk: (await readJson<SilverChunkRecord>(s.store, bundle.documents[0].chunks[0]))! };
}
test('later sources are cleared, pinned and described alike in the contract, registry and source policy', async () => {
  for (const table of [SOURCE_ARTIFACTS, PHASE1A_V1_DOC_IDS, LIVE_SOURCE_PLACES]) assert.deepEqual(Object.keys(table).sort(), [...LIVE_SOURCE_IDS].sort());
  const s = new MemoryStore(); await seedRegistry(s);
  for (const id of ['ga-147459', 'ga-147460', 'ga-147462', 'peps-sa-habanero-1'] as const) {
    const { source } = await allowedSource(s, id);
    assert.equal(source.licence, 'CC BY 4.0'); assert.equal(source.expectedSha256, SOURCE_ARTIFACTS[id].sha256);
  }
  assert.equal((await allowedSource(s, 'peps-sa-habanero-1')).source.wellLocation, null);
});
test('a member another source already publishes is skipped, and listed members get their own titles', () => {
  const docs = [{ name: 'TEGI_GEOLOGY-Adavale_Basin_Region.pdf', sha256: 'a'.repeat(64) }, { name: 'TEGI_Glossary.pdf', sha256: 'b'.repeat(64) }], shared = { ['b'.repeat(64)]: 'ga-147461' };
  assert.deepEqual(publishableMembers('ga-147462', docs, shared), { documents: [docs[0]], shared: [docs[1]] });
  assert.equal(publishableMembers('ga-147461', docs, shared).documents.length, 2);
  assert.equal(documentTitle('peps-sa-habanero-1', 'DownholeDiagram/HABANERO_001_03.pdf', 'Habanero 1 well files'), 'Habanero 1 well status diagram (suspended)');
  assert.equal(documentTitle('peps-sa-habanero-1', 'unlisted.pdf', 'Habanero 1 well files'), 'Habanero 1 well files');
  assert.equal(documentTitle('ga-147462', 'TEGI_Glossary.pdf', 'Adavale Basin regional geology (GA 147462)'), 'TEGI glossary');
});
test('a later guide carries its own basin, and an archive source refuses a bare PDF', async () => {
  const s = await setup(), registry = (await s.store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, 'source', 'ga-147462'))!;
  await s.store.put(LIVE_TABLES.sourceRegistry, { partitionKey: 'source', rowKey: 'ga-147462', expectedSha256: sha256Of(bytes) }, registry.etag);
  await assert.rejects(landArtifact(s.store, 'ga-147462', bytes, owner.id), /unexpected file type/);
  const { bundle, chunk } = await processArchive(s, 'ga-147462', multiZip([{ name: 'TEGI_GEOLOGY-Adavale_Basin_Region.pdf', data: Buffer.from('%PDF-adavale') }]));
  assert.equal(bundle.documents[0].record.title, 'Adavale Basin regional geology (GA 147462)');
  assert.deepEqual([chunk.basin, chunk.geotag, chunk.geoBasins, chunk.well, chunk.points], ['adavale', 'basin', ['adavale'], null, []]);
});
test('Habanero 1 documents keep their own titles and a Cooper basin geotag without a well point', async () => {
  const s = await setup();
  const { bundle, chunk } = await processArchive(s, 'peps-sa-habanero-1', multiZip([{ name: 'habanero_1_multi_finger_cali_report.pdf', data: Buffer.from('%PDF-caliper') }, { name: 'HABANERO_001_01.pdf', data: Buffer.from('%PDF-diagram') }]));
  assert.deepEqual(bundle.documents.map((d) => d.record.title).sort(), ['Habanero 1 downhole completion diagram, October 2003', 'Habanero 1 multi-finger caliper survey, December 2011']);
  assert.deepEqual([chunk.basin, chunk.geotag, chunk.well, chunk.points], ['cooper', 'basin', null, []]);
});
test('Wave 1 national sources are cleared, pinned and published by Geoscience Australia under CC BY 4.0, with no packaged copy', async () => {
  const s = new MemoryStore(); await seedRegistry(s);
  assert.equal(NATIONAL_SOURCES.length, 14);
  for (const [id, title, attribution] of NATIONAL_SOURCES) {
    const { source } = await allowedSource(s, id);
    assert.deepEqual([source.publisher, source.licence, source.title, source.attribution, source.url, source.expectedSha256, source.wellLocation, source.v1DocIds],
      ['Geoscience Australia', 'CC BY 4.0', title, attribution, SOURCE_ARTIFACTS[id].url, SOURCE_ARTIFACTS[id].sha256, null, []]);
    assert.ok(source.url.startsWith('https://') && !SOURCE_ARTIFACTS[id].name.endsWith('.zip'));
    assert.equal(Object.hasOwn(CATALOGUE_RECORDS, id), id.startsWith('ga-ecat-'));
  }
});
test('Wave 2 national sources are cleared and pinned under CC BY 4.0; archive members are PDFs inside the publisher\'s ZIP', async () => {
  const s = new MemoryStore(); await seedRegistry(s);
  assert.equal(NATIONAL_SOURCES_WAVE2.length, 47);
  for (const [id, title, attribution] of NATIONAL_SOURCES_WAVE2) {
    const { source } = await allowedSource(s, id), artifact = sourceArtifact(id);
    assert.deepEqual([source.publisher, source.licence, source.title, source.attribution, source.url, source.expectedSha256, source.wellLocation, source.v1DocIds],
      ['Geoscience Australia', 'CC BY 4.0', title, attribution, artifact.url, artifact.sha256, null, []]);
    assert.ok(source.url.startsWith('https://') && artifact.name.endsWith('.pdf') && /^[a-f0-9]{64}$/.test(artifact.sha256));
    assert.equal(Object.hasOwn(CATALOGUE_RECORDS, id), id.startsWith('ga-ecat-'));
    assert.deepEqual(LIVE_SOURCE_PLACES[id], { basin: null, well: null });
    assert.equal(Boolean(artifact.member), source.url.endsWith('.zip'), `${id}: an archive URL is read only through its pinned member`);
    if (artifact.member) assert.ok(artifact.member.endsWith(`/${artifact.name}`) || artifact.member === artifact.name, `${id}: the landed name is the member's own`);
    assert.equal(source.licenceBasis.includes('read out of the archive'), Boolean(artifact.member));
  }
});
test('Wave 3 datum references clear under CC BY 4.0 with their own publishers, and only the ANZLIC manual lands by owner upload', async () => {
  const s = new MemoryStore(); await seedRegistry(s);
  assert.equal(NATIONAL_SOURCES_WAVE3.length, 8);
  for (const [id, title, attribution, publisher, licenceBasis] of NATIONAL_SOURCES_WAVE3) {
    const { source } = await allowedSource(s, id), artifact = sourceArtifact(id);
    assert.deepEqual([source.publisher, source.licence, source.title, source.attribution, source.url, source.expectedSha256, source.licenceBasis, source.wellLocation],
      [publisher, 'CC BY 4.0', title, attribution, artifact.url, artifact.sha256, licenceBasis, null]);
    assert.ok(artifact.name.endsWith('.pdf') && !artifact.member && source.url.startsWith('https://'));
    assert.deepEqual(LIVE_SOURCE_PLACES[id], { basin: null, well: null });
    assert.equal(Boolean(artifact.ownerUpload), id === 'icsm-gda2020-manual', `${id}: owner upload only where the publisher refuses programmatic clients`);
  }
});
test('a live source needs CC BY 4.0 or reuse terms the owner approved; freely readable or all-rights-reserved material is refused', async () => {
  const s = new MemoryStore(); await seedRegistry(s);
  assert.equal(OWNER_APPROVED_SOURCES.length, 3);
  for (const [id, title, attribution, publisher, licence, licenceBasis] of OWNER_APPROVED_SOURCES) {
    const { source } = await allowedSource(s, id);
    assert.deepEqual([source.publisher, source.licence, source.title, source.attribution, source.licenceBasis, source.expectedSha256],
      [publisher, licence, title, attribution, licenceBasis, SOURCE_ARTIFACTS[id].sha256]);
    assert.ok(reuseAllowed(licence) && licenceBasis.startsWith('Licence review, '));
    if (licence !== 'CC BY 4.0') assert.ok(attribution.includes('reproduced with permission'), `${id}: the publisher's acknowledgement travels with every citation`);
  }
  for (const licence of ['All rights reserved', 'Freely available', 'CC BY-NC 4.0']) {
    const row = (await s.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, 'source', 'nzpam-basins-part-one'))!;
    await s.put(LIVE_TABLES.sourceRegistry, { partitionKey: 'source', rowKey: 'nzpam-basins-part-one', licence }, row.etag);
    await assert.rejects(allowedSource(s, 'nzpam-basins-part-one'), /permission is absent or invalid/, licence);
  }
});
test('a registered larger bound lets one publisher file exceed 60 MB, and no other', async () => {
  const s = new MemoryStore(); await seedRegistry(s);
  assert.deepEqual(Object.entries(SOURCE_ARTIFACTS).filter(([, a]) => 'maxBytes' in a).map(([id]) => id).sort(), ['ga-69190', 'ga-69470']);
  assert.deepEqual([sourceBytesFor('ga-69190'), sourceBytesFor('ga-70711'), sourceBytesFor('nonexistent')], [PIPELINE_LIMITS.maxSourceBytes, PIPELINE_LIMITS.sourceBytes, PIPELINE_LIMITS.sourceBytes]);
  const artifact = sourceArtifact('ga-70711'); artifact.maxBytes = PIPELINE_LIMITS.maxSourceBytes * 10;
  try { assert.equal(sourceBytesFor('ga-70711'), PIPELINE_LIMITS.maxSourceBytes, 'no registration can raise a bound past the ceiling'); } finally { delete artifact.maxBytes; }
  const big = Buffer.alloc(PIPELINE_LIMITS.sourceBytes + 1); big.write('%PDF-1.4');
  await assert.rejects(landArtifact(s, 'ga-70711', big, 'owner'), /registered size bound/);
  await assert.rejects(landArtifact(s, 'ga-69190', big, 'owner'), /Hash differs/, 'past the size check, only the pin decides');
  // Landing the same file again re-reads the quarantine copy, within the same bound, rather than overwriting it.
  const registry = (await s.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, 'source', 'ga-69190'))!;
  await s.put(LIVE_TABLES.sourceRegistry, { partitionKey: 'source', rowKey: 'ga-69190', expectedSha256: sha256Of(big) }, registry.etag);
  for (let i = 0; i < 2; i++) assert.equal((await landArtifact(s, 'ga-69190', big, 'owner')).status, 'queued');
  assert.equal([...s.blobs.keys()].filter((k) => k.startsWith('quarantine/')).length, 1);
});
test('the processing scan and the publication scan read quarantine within the source\'s own bound', async () => {
  for (const [id, bound] of [['ga-69190', PIPELINE_LIMITS.maxSourceBytes], ['ga-70711', PIPELINE_LIMITS.sourceBytes]] as const) {
    const s = await setup(), file = Buffer.from(`%PDF-1.4 ${id}`), bounds: (number | undefined)[] = [];
    const registry = (await s.store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, 'source', id))!;
    await s.store.put(LIVE_TABLES.sourceRegistry, { partitionKey: 'source', rowKey: id, expectedSha256: sha256Of(file) }, registry.etag);
    const landed = await landArtifact(s.store, id, file, owner.id);
    s.services.scan = async (_blob, _sha256, _signal, maxBytes) => { bounds.push(maxBytes); return { buffer: file, sha256: sha256Of(file), tags: tags(file, Date.now()), etag: 'etag' }; };
    await processLiveJob(s.store, s.services, decodeProcessMessage(s.store.sent.at(-1)!.value));
    const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', landed.jobId))!, ref = { sourceId: id, sha256: job.sha256, extractionVersion: job.extractionVersion! };
    const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, id, reviewKey(ref)))!;
    await decideSourceReview(s.store, ref, { ...ref, decision: 'approved', reason: 'Reviewed source licence, scan and extraction.' }, owner, row.etag);
    assert.equal(await publishExtraction(s.store, s.services, ref, AbortSignal.timeout(10000)), 1);
    assert.deepEqual(bounds, [bound, bound], `${id}: processing, then publication`);
  }
});
test('a national document and a rendered catalogue record land as PDFs and extract as general evidence under their own titles', async () => {
  const s = await setup();
  const notes = await processArchive(s, 'ga-144233', Buffer.from('%PDF-1.4 explanatory notes'));
  assert.equal(notes.bundle.documents[0].record.title, '2019 Australian National Gravity Grids explanatory notes (GA Record 2020/22)');
  assert.deepEqual([notes.chunk.basin, notes.chunk.geotag, notes.chunk.geoBasins, notes.chunk.well, notes.chunk.points], [null, 'general', [], null, []]);
  const pdf = renderEcatRecord({ ecatId: '100520', uuid: 'u', title: 'SUPERSEDED - Australian Onshore and Offshore Borehole Data', abstract: 'This record has been superseded by eCat 126310.',
    lineage: '', pid: null, doi: null, organisation: '', status: 'Superseded', resourceType: 'dataset', published: null, crs: '', licence: 'Creative Commons Attribution 4.0 International Licence', revision: '2018-05-01T04:59:04.000Z' });
  const record = await processArchive(s, 'ga-ecat-100520', pdf);
  assert.equal(record.bundle.documents[0].record.title, 'Geoscience Australia catalogue record: SUPERSEDED - Australian Onshore and Offshore Borehole Data (eCat 100520)');
  assert.deepEqual([record.chunk.basin, record.chunk.geotag], [null, 'general']);
});
test('landing paths cannot escape sources/ even through stored metadata or encoded traversal', () => {
  const path = sourceBlobName('ga-147461', 'a'.repeat(64)); assert.match(path, /^sources\/ga-147461\/[a-f0-9]{64}\//);
  for (const bad of ['../uploads/x', '%2e%2e', 'A'.repeat(64), '']) assert.throws(() => sourceBlobName('ga-147461', bad));
  assert.throws(() => sourceBlobName('uploads' as never, 'a'.repeat(64)));
});

test('explicit processing retry preserves checkpoints but cannot republish a reviewed tuple', async () => {
  const s = await setup(); s.services.render = async (_b, pages, save) => { await save(pages[0], png()); throw new Error('partial render'); };
  await assert.rejects(processLiveJob(s.store, s.services, s.message));
  const before = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', s.landed.jobId))!, sent = s.store.sent.length;
  await queueProcessingRetry(s.store, s.landed.jobId, AbortSignal.timeout(1000));
  const after = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', s.landed.jobId))!;
  assert.equal(after.extractionVersion, before.extractionVersion); assert.equal(s.store.sent.length, sent + 1); assert.equal(s.store.sent.at(-1)?.queue, 'scan-jobs');
  const complete = await ready(); await assert.rejects(queueProcessingRetry(complete.store, complete.job.rowKey, AbortSignal.timeout(1000)));
});
test('a retry after lineage persistence preserves the original scan provenance instead of overwriting it', async () => {
  const s = await setup(), put = s.store.put.bind(s.store); let fail = true;
  s.store.put = async (name, row, etag) => { if (name === LIVE_TABLES.reviews && fail) { fail = false; throw new Error('review write interrupted'); } return put(name, row, etag); };
  await assert.rejects(processLiveJob(s.store, s.services, s.message), /interrupted/);
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', s.landed.jobId))!, key = reviewKey({ ...job, extractionVersion: job.extractionVersion! });
  const original = (await s.store.get<import('./contracts').LineageRow>(LIVE_TABLES.lineage, job.sourceId, key))!;
  s.services.scan = async () => ({ buffer: bytes, sha256: sha256Of(bytes), tags: tags(bytes, Date.now() - 10_000), etag: 'fresh-scan' });
  await processLiveJob(s.store, s.services, s.message);
  assert.equal((await s.store.get<import('./contracts').LineageRow>(LIVE_TABLES.lineage, job.sourceId, key))?.scanTagsJson, original.scanTagsJson);
  assert.equal(s.counters.ocr, 1);
});
test('an explicit rollback is fenced to the observed manifest generation', async () => {
  const s = await ready(); await approve(s); await publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000));
  const next = await landArtifact(s.store, s.ref.sourceId, bytes, owner.id); await processLiveJob(s.store, s.services, decodeProcessMessage(s.store.sent.at(-1)!.value));
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', next.jobId))!, newer = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
  const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, newer.sourceId, reviewKey(newer)))!;
  await decideSourceReview(s.store, newer, { ...newer, decision: 'approved', reason: 'Reviewed newer extraction.' }, owner, row.etag);
  await publishExtraction(s.store, s.services, newer, AbortSignal.timeout(10000));
  await assert.rejects(publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000)), /explicit/);
  await queueApprovedRepublish(s.store, s.ref, AbortSignal.timeout(10000));
  const current = (await currentManifest(s.store))!, advanced = Buffer.from(JSON.stringify({ ...current.manifest, manifestVersion: current.manifest.manifestVersion + 1 }));
  await s.store.write('manifests', 'v3.json', advanced, { ifNoneMatch: '*' }, 'application/json');
  await s.store.write('manifests', 'current.json', advanced, { ifMatch: current.etag }, 'application/json');
  await assert.rejects(publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000)), /baseline changed/);
  assert.equal((await currentManifest(s.store))?.manifest.sources[0].extractionVersion, newer.extractionVersion);
});

test('a 420-page render retry validates the first 419 images and requests only page 420', async () => {
  const s = await ready(), bundle = (await readJson<ExtractionBundle>(s.store, `${extractionPrefix(s.ref)}/extraction.json`))!;
  const original = (await readJson<import('./contracts').SilverPageRecord>(s.store, bundle.documents[0].pages[0]))!;
  const pages = Array.from({ length: 420 }, (_, i) => ({ ...original, page: i + 1, imageBlob: pageImageBlobName({ sourceId: original.sourceId, sha256: original.documentSha256, extractionVersion: original.extractionVersion, page: i + 1 }) }));
  for (const page of pages.slice(0, 419)) {
    if (!await s.store.stat('pages', page.imageBlob)) await immutableBlob(s.store, 'pages', page.imageBlob, png(), 'image/png', { sourceid: page.sourceId, documentsha256: page.documentSha256, extractionversion: page.extractionVersion, page: String(page.page) });
  }
  const pending = await missingRenderedPages(s.store, pages, AbortSignal.timeout(10000)); assert.deepEqual(pending.map(p => p.page), [420]);
});
test('retry of a failed never-published newer approval remains allowed without implicitly rolling back', async () => {
  const s = await ready(); await approve(s); await publishExtraction(s.store, s.services, s.ref, AbortSignal.timeout(10000));
  await new Promise(resolve => setTimeout(resolve, 2));
  const next = await landArtifact(s.store, s.ref.sourceId, bytes, owner.id); await processLiveJob(s.store, s.services, decodeProcessMessage(s.store.sent.at(-1)!.value));
  const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', next.jobId))!, newer = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
  const body = { ...newer, decision: 'approved', reason: 'Reviewed the replacement.' }, row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, newer.sourceId, reviewKey(newer)))!;
  s.store.failSend = true; await assert.rejects(decideSourceReview(s.store, newer, body, owner, row.etag)); s.store.failSend = false;
  const failed = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, newer.sourceId, reviewKey(newer)))!;
  assert.equal(failed.publishedManifestVersion, undefined);
  assert.equal((await decideSourceReview(s.store, newer, body, owner, failed.etag)).publication.status, 'queued');
});

test('with the live scan and Purview off, landing skips the scanner, lineage says Not scanned and nothing is catalogued', async () => {
  const saved = { scan: cfg.live.scan, purview: cfg.live.purview };
  Object.assign(cfg.live, { scan: false, purview: false });
  try {
    const s = await setup(); s.services.scan = async () => ({ buffer: bytes, sha256: sha256Of(bytes), tags: null, etag: 'quarantine-etag' });
    assert.equal(s.store.sent[0].queue, 'process-jobs');
    await processLiveJob(s.store, s.services, s.message);
    const job = (await s.store.get<PipelineJob>(PIPELINE_TABLES.jobs, 'job', s.landed.jobId))!, ref = { sourceId: job.sourceId, sha256: job.sha256, extractionVersion: job.extractionVersion! };
    assert.equal((await s.store.get<LineageRow>(LIVE_TABLES.lineage, ref.sourceId, reviewKey(ref)))?.scanVerdict, 'Not scanned');
    const row = (await s.store.get<PipelineReviewRow>(LIVE_TABLES.reviews, ref.sourceId, reviewKey(ref)))!;
    await decideSourceReview(s.store, ref, { ...ref, decision: 'approved', reason: 'Reviewed the extraction.' }, owner, row.etag);
    assert.equal(s.store.sent.at(-1)!.queue, 'process-jobs');
    assert.equal(await publishExtraction(s.store, s.services, ref, AbortSignal.timeout(10000)), 1);
    assert.equal(s.counters.catalogue, 0);
  } finally { Object.assign(cfg.live, saved); }
});
test('while the live scan is on, a file without a clean verdict is still refused', () => {
  assert.throws(() => liveScanVerdict(null, true), ScanVerdictError);
  assert.equal(liveScanVerdict(tags(bytes, Date.now()), true), 'No threats found');
  assert.equal(liveScanVerdict(null, false), 'Not scanned');
});
test('the unscanned reader keeps one bounded ETag download and refuses bytes that differ from the registered hash', async () => {
  let calls = 0;
  const fake = { getProperties: async () => ({ contentLength: bytes.length, etag: 'E' }), downloadToBuffer: async (b: Buffer, offset: number, count: number, opts: { conditions: { ifMatch: string } }) => {
    assert.equal(offset, 0); assert.equal(count, bytes.length); assert.equal(opts.conditions.ifMatch, 'E'); calls++; bytes.copy(b); return b; } };
  const out = await readUnscannedBlob(fake as unknown as BlobClient, { maxBytes: 1000, expectedSha256: sha256Of(bytes) });
  assert.equal(out.tags, null); assert.deepEqual(out.buffer, bytes); assert.equal(calls, 1);
  await assert.rejects(readUnscannedBlob(fake as unknown as BlobClient, { maxBytes: 1000, expectedSha256: 'a'.repeat(64) }), ScanVerdictError);
  await assert.rejects(readUnscannedBlob(fake as unknown as BlobClient, { maxBytes: 4, expectedSha256: sha256Of(bytes) }), ScanVerdictError);
});
