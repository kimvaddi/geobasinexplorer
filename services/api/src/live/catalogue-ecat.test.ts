import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Of } from "../scan-verdict";
import { CC_BY_4, ECAT_FIELDS, ECAT_SEARCH_URL, ecatRecordArtifact, fetchEcatRecord, plainText, recordFrom, renderEcatRecord } from "./catalogue-ecat";
import { textPdf, winAnsi } from "./pdf-text";
import { NATIONAL_SOURCES, NATIONAL_SOURCES_WAVE2, SOURCE_ARTIFACTS } from "./pipeline-registry";
import { CATALOGUE_RECORDS, LIVE_SOURCE_PLACES } from "./source-policy";

// Shaped like eCat's search response for the superseded national borehole record (fields trimmed).
const source = (over: Record<string, unknown> = {}) => ({
  eCatId: "100520", uuid: "489d1fa5-24fc-4b19-ac6b-01e3082db942",
  resourceTitleObject: { default: "SUPERSEDED - Australian Onshore and Offshore Borehole Data" },
  resourceAbstractObject: { default: "<b>This record has been superseded by eCat 126310</b> <p>Geoscience Australia defines a borehole &amp; its <i>collar</i>.</p>" },
  lineageObject: { default: "A decision was made to exclude any boreholes that had no defined location." },
  resourceIdentifier: [{ code: "https://pid.geoscience.gov.au/dataset/ga/100520", codeSpace: "Geoscience Australia Persistent Identifier" },
    { code: "http://dx.doi.org/10.26186/5cbe68e353099", codeSpace: "Digital Object Identifier" }],
  OrgForResourceObject: [{ default: "Commonwealth of Australia (Geoscience Australia)" }], cl_status: [{ default: "Superseded" }], resourceType: ["dataset"],
  resourceDate: [{ type: "creation", date: "2016-06-07T00:00:00.000Z" }, { type: "publication", date: "2019-04-02T03:13:45.000Z" }],
  crsDetails: [{ name: "GDA94 (EPSG:4283)" }], legalconstraints: "Creative Commons Attribution 4.0 International Licence", dateStamp: "2018-05-01T04:59:04.000Z",
  ...over,
});
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
const hits = (...sources: unknown[]) => ({ hits: { total: { value: sources.length }, hits: sources.map((s) => ({ _source: s })) } });

test("the text PDF is byte-for-byte deterministic, well formed and keeps WinAnsi text", () => {
  const blocks = [{ text: "Title (draft)", size: 14, bold: true }, { text: "Units: 1 µm/s² is 0.1 mGal – also written 1 μm s−2 \\ end" }];
  const a = textPdf("Test", blocks), b = textPdf("Test", blocks), s = a.toString("latin1");
  assert.deepEqual(a, b);
  assert.ok(s.startsWith("%PDF-1.4\n")); assert.ok(s.endsWith("%%EOF\n")); assert.ok(!/CreationDate|ModDate|\/ID/.test(s));
  assert.ok(textPdf("Gravity – Australia’s grid", blocks).toString("latin1").includes("/Title <FEFF0047007200610076006900740079002020130020004100750073007400720061006C006900612019007300200067007200690064>"));
  assert.match(s, /\(Title \\\(draft\\\)\) Tj/);
  assert.match(s, /1 \\265m\/s\\262 is 0\.1 mGal \\226 also written 1 \\265m s-2 \\\\ end/);
  const xref = Number(/startxref\n(\d+)\n/.exec(s)![1]);
  assert.ok(s.slice(xref).startsWith("xref\n"));
  const offsets = s.slice(xref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
  offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} offset`));
  assert.deepEqual(winAnsi("€ ≥ \u200b?"), [0x80, 0x20, 0x3e, 0x3d, 0x20, 0x3f]);
});
test("long text wraps and paginates, and a runaway text is refused", () => {
  const s = textPdf("Long", [{ text: Array.from({ length: 400 }, (_, i) => `Sentence ${i} about gravity datums and survey line spacing.`).join(" ") }]).toString("latin1");
  assert.ok(Number(/\/Count (\d+)/.exec(s)![1]) > 1);
  for (const line of s.matchAll(/\((.*?)\) Tj/g)) assert.ok(line[1].length <= 140, "a wrapped line stays inside the page");
  assert.throws(() => textPdf("Huge", [{ text: "x ".repeat(150_000) }]), /bound/);
});
test("catalogue HTML becomes plain text with block breaks and decoded entities", () => {
  assert.equal(plainText("<div>Line <b>one</b>&nbsp;&amp; more</div><p>Two&#8211;three &#x3BC;m</p><ul><li>a</li></ul>"), "Line one & more\nTwo–three μm\n\n- a");
  assert.equal(plainText("&bogus; &#xFFFFFFFF; &constructor; &toString;"), "&bogus; &#xFFFFFFFF; &constructor; &toString;");
  assert.equal(plainText("Values are in decimal units (&micro;ms&minus;&sup2; (micro metres per second squared))"), "Values are in decimal units (µms−² (micro metres per second squared))");
  assert.equal(plainText("&Eacute;tude &eacute;t&eacute; &Delta;g &le; 0.1 &deg;C &copy; GA <!-- note -->"), "Étude été Δg ≤ 0.1 °C © GA");
  assert.equal(plainText("Stations with errors < 0.1 mGal were retained; those > 0.5 mGal were rejected."), "Stations with errors < 0.1 mGal were retained; those > 0.5 mGal were rejected.");
  assert.equal(plainText("<p class=MsoNormal>Survey<o:p></o:p> <st1:place w:st=\"on\">Eromanga</st1:place></p>"), "Survey Eromanga");
  assert.equal(plainText("&AMP; &LT;"), "& <");
});
test("a record is accepted only with its own eCat id, CC BY 4.0, a title, an abstract and a revision date", () => {
  const r = recordFrom(source(), "100520");
  assert.equal(r.title, "SUPERSEDED - Australian Onshore and Offshore Borehole Data"); assert.equal(r.status, "Superseded");
  assert.equal(r.abstract, "This record has been superseded by eCat 126310 Geoscience Australia defines a borehole & its collar.");
  assert.equal(r.pid, "https://pid.geoscience.gov.au/dataset/ga/100520"); assert.equal(r.doi, "10.26186/5cbe68e353099"); assert.equal(r.published, "2019-04-02");
  assert.equal(r.crs, "GDA94 (EPSG:4283)"); assert.equal(r.licence, `${CC_BY_4} Licence`);
  assert.throws(() => recordFrom(source(), "126310"), /different record/);
  assert.throws(() => recordFrom(source({ legalconstraints: "© Commonwealth of Australia, all rights reserved" }), "100520"), /not licensed CC BY 4\.0/);
  assert.throws(() => recordFrom(source({ legalconstraints: "Creative Commons Attribution 4.0 International Licence does not apply to the imagery" }), "100520"), /not licensed CC BY 4\.0/);
  assert.throws(() => recordFrom(source({ legalconstraints: ["Creative Commons Attribution 4.0 International Licence", "© Commonwealth of Australia, all rights reserved"] }), "100520"), /not licensed CC BY 4\.0/);
  assert.throws(() => recordFrom(source({ legalconstraints: "Creative Commons Attribution-NonCommercial 4.0 International Licence" }), "100520"), /not licensed CC BY 4\.0/);
  assert.equal(recordFrom(source({ legalconstraints: ["© Commonwealth of Australia (Geoscience Australia) 2019", "Creative Commons Attribution 4.0 International Licence"] }), "100520").licence,
    "© Commonwealth of Australia (Geoscience Australia) 2019; Creative Commons Attribution 4.0 International Licence");
  assert.throws(() => recordFrom(source({ resourceAbstractObject: { default: "<p> </p>" } }), "100520"), /no title or abstract/);
  assert.throws(() => recordFrom(source({ dateStamp: "yesterday" }), "100520"), /revision date/);
  assert.equal(recordFrom(source({ resourceIdentifier: [{ code: "https://example.org/dataset/ga/100520", codeSpace: "Geoscience Australia Persistent Identifier" }] }), "100520").pid, null);
  assert.throws(() => recordFrom(source({ lineageObject: { default: "x".repeat(70_000) } }), "100520"), /exceeds its bound/);
});
test("the eCat fetch posts one exact query without redirects and refuses missing, duplicate, invalid or oversized replies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (body: unknown, init?: ResponseInit) => (async (url: string | URL | Request, request?: RequestInit) => { calls.push({ url: String(url), init: request! }); return reply(body, init); }) as typeof fetch;
  const r = await fetchEcatRecord("100520", AbortSignal.timeout(5_000), fake(hits(source())));
  assert.equal(r.ecatId, "100520"); assert.equal(calls[0].url, ECAT_SEARCH_URL); assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { query: { query_string: { query: "eCatId:100520" } }, size: 2, _source: [...ECAT_FIELDS] });
  await assert.rejects(fetchEcatRecord("1005 20", AbortSignal.timeout(5_000), fake(hits(source()))), /Invalid eCat identifier/);
  assert.equal(calls.length, 1, "an invalid identifier is refused before any request");
  await assert.rejects(fetchEcatRecord("100520", AbortSignal.timeout(5_000), fake(hits())), /no single record/);
  await assert.rejects(fetchEcatRecord("100520", AbortSignal.timeout(5_000), fake(hits(source(), source()))), /no single record/);
  await assert.rejects(fetchEcatRecord("100520", AbortSignal.timeout(5_000), fake("<html>")), /invalid JSON/);
  await assert.rejects(fetchEcatRecord("100520", AbortSignal.timeout(5_000), fake("{}", { status: 503 })), /Upstream request failed/);
  await assert.rejects(fetchEcatRecord("100520", AbortSignal.timeout(5_000), fake("x".repeat(3 * 1024 * 1024))), /exceeds its bound/);
});
test("a rendered record carries the record's own fields and hashes the same every time", async () => {
  const fake = (async () => reply(hits(source()))) as unknown as typeof fetch;
  const a = await ecatRecordArtifact("100520", AbortSignal.timeout(5_000), fake), b = await ecatRecordArtifact("100520", AbortSignal.timeout(5_000), fake);
  assert.equal(a.sha256, b.sha256); assert.equal(a.sha256, sha256Of(a.bytes)); assert.deepEqual(a.bytes, renderEcatRecord(a.record));
  const text = a.bytes.toString("latin1");
  for (const part of ["(SUPERSEDED - Australian Onshore and Offshore Borehole Data) Tj", "(Geoscience Australia catalogue record, eCat 100520) Tj", "superseded by eCat 126310",
    "exclude any boreholes that had no defined location", "(Status: Superseded) Tj", "(Catalogue record revision: 2018-05-01T04:59:04.000Z) Tj", "(DOI: 10.26186/5cbe68e353099) Tj"]) assert.ok(text.includes(part), part);
});
test("every catalogue source is a pinned, national, persistent-identifier record, and every national source is described", () => {
  const records = Object.entries(CATALOGUE_RECORDS);
  assert.ok(records.length >= 8);
  for (const [id, ecat] of records) {
    const artifact = SOURCE_ARTIFACTS[id as keyof typeof SOURCE_ARTIFACTS];
    assert.equal(artifact.url, `https://pid.geoscience.gov.au/dataset/ga/${ecat}`); assert.equal(artifact.name, `ecat-${ecat}-record.pdf`); assert.equal(id, `ga-ecat-${ecat}`);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  const national = [...NATIONAL_SOURCES, ...NATIONAL_SOURCES_WAVE2];
  for (const [id] of national) assert.deepEqual(LIVE_SOURCE_PLACES[id as keyof typeof LIVE_SOURCE_PLACES], { basin: null, well: null });
  assert.deepEqual(national.map(([id]) => id).filter((id) => id.startsWith("ga-ecat-")).sort(), records.map(([id]) => id).sort());
});
