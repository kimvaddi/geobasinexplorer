// Read-only, staged live acceptance. Requires GBX_TOKEN. Never deploys, publishes, approves, rolls back, or starts jobs.
// Before serving activation (no Marabooka commitment): --stage before --out <project-relative report.json>
// After operator approval/publication: --stage after --previous <before.json> --out <after.json>
// The after stage verifies all 439 page images. Rollback repeats live questions and reopens every PDF; allow several minutes.
// After operator rollback: --stage rollback --previous <after.json> --target <approved-target.json>
//                         --expected-revision <revision> --out <rollback.json>
// Browser requests may use Azure Maps (atlas.microsoft.com), as in 0.12.0. Any Blob/DFS host or SAS still fails.
// --self-test makes no network requests and needs no token or browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(repo, "app/package.json"));
export function forbiddenStorageRequest(url) {
  const u = new URL(url);
  return /(?:^|\.)(?:blob|dfs)(?:\.|$)/i.test(u.hostname) || [...u.searchParams.keys()].some((key) => key.toLowerCase() === "sig");
}
export const textOf = (a) => (a.paragraphs ?? []).join(" ").replace(/,/g, "");
export function assertBlocked(a) {
  assert.equal(a.label, "Not found"); assert.equal(a.reason, "Reuse terms not confirmed");
  assert.deepEqual(a.citations, []); assert.deepEqual(a.hits, []); assert.ok(!a.table && !a.images && !a.fieldRef && !a.computations?.length);
}
export function assertPackagedQ10(a) {
  assert.equal(a.label, "Precomputed", "Before migration Q10 must keep its 0.12.0 label");
  assert.equal(a.status, "answered");
  assert.ok(a.citations.length && a.citations.every((c) => !c.live), "Before migration use packaged citations only");
  const text = textOf(a); for (const number of [/\b6326\b/, /\b6144\.1\b/, /\b181\.9\b/]) assert.match(text, number);
}
export function assertQ10(a) {
  assert.equal(a.label, "Retrieved"); assert.equal(a.validation?.status, "passed");
  const text = textOf(a); assert.match(text, /\b6326\b/); assert.match(text, /\b6144\.1\b/); assert.match(text, /\b181\.9\b/);
  assert.match(text, /below (?:the )?(?:kelly bushing|KB)/i); assert.match(text, /below sea level/i);
  const c = a.computations?.find((c) => c.tool === "convert_depth_kb_to_subsea" && c.output?.value === 6144.1);
  assert.ok(c, "Q10 must contain tool-derived computation evidence"); assert.equal(c.formula, "depthBelowKbFt - kbElevationFt");
  assert.ok(c.inputs.some((i) => i.name === "depthBelowKbFt" && i.value === 6326 && i.unit === "ft"));
  assert.ok(c.inputs.some((i) => i.name === "kbElevationFt" && i.value === 181.9 && i.unit === "ft"));
  const citationIds = new Set(a.citations.map((citation) => citation.id));
  assert.ok(c.sourceIds.length && c.sourceIds.every((id) => citationIds.has(id)), "Computation sources must resolve to returned citations");
  assert.ok(c.inputs.every((input) => citationIds.has(input.evidenceId)), "Each numerical input must resolve to its source citation");
  assert.ok(a.trace?.some((t) => /Computed from source evidence/.test(t.step) && /6144\.1/.test(t.detail)));
  if (/\b6147\b/.test(text)) {
    const figure = text.split(/(?<=[.!?])\s+/).find((s) => /\b6147\b/.test(s));
    assert.match(figure, /velocity|enclosure 2/i, "The alternate datum must be separately labelled as a velocity-chart figure"); assert.match(figure, /\b179\b/);
  }
  assert.ok(a.citations.some((c) => c.live?.sourceId === "peps-sa-marabooka-1" && c.page > 0));
}
export function assertQ01(a) {
  assert.equal(a.label, "Retrieved"); assert.equal(a.validation?.status, "passed");
  assert.match(textOf(a), /\b16\b.*play intervals?|play intervals?[^.]*\b16\b/i);
  assert.ok(a.citations.some((c) => c.live?.sourceId === "ga-147461"));
}
export function assertStageHealth(health, stage) {
  assert.ok(["before", "after", "rollback"].includes(stage));
  assert.equal(health?.ai, true, `${stage} requires /api/health ai: true; an AI-disabled run cannot pass acceptance`);
}
export function assertQ11(a, elapsedMs) {
  assert.ok(elapsedMs <= 90_000, `Q11 exceeded 90 s (${elapsedMs} ms)`);
  if (a.reason === "Validation incomplete") { assert.equal(a.validation?.status, "incomplete"); assert.deepEqual(a.citations, []); return; }
  assert.equal(a.label, "Retrieved"); assert.equal(a.validation?.status, "passed");
  const text = textOf(a); assert.match(text, /communicat/i); assert.match(text, /possible|possibility|may|could|hypothes/i);
  // Page 32 says the Patchawarra sandstones "were essentially water filled" and offers "Three possible explanations"; the
  // benchmark key paraphrases this as "water-wet" and "untested". A live answer must quote the report, so both are accepted.
  assert.match(text, /water[- ]?(?:wet|filled|bearing|saturated).*Patchawarra|Patchawarra.*water[- ]?(?:wet|filled|bearing|saturated)/i);
  // A negation must modify the proof word directly ("not proven", "not a proven connection"), so "not only proven" fails.
  assert.match(text, /\b(?:untested|unproven|unconfirmed|tentative|speculative)\b|\bnot\s+(?:(?:yet|been|a|an)\s+){0,2}(?:proven|established|confirmed|demonstrated|tested)\b/i);
  assert.ok(a.citations.some((c) => c.live?.sourceId === "peps-sa-marabooka-1" && c.page === 32), "Q11 must reopen page 32");
}
export const tuples = (manifest) => (manifest.sources ?? []).map((s) => [s.sourceId, s.sha256, s.extractionVersion, s.documents.map((d) => [d.docId, d.sha256, d.pageCount]).sort()]).sort((a, b) => a[0].localeCompare(b[0]));
export function assertRollback(current, previous, target, expectedRevision) {
  assert.ok(current.manifest.enabled && target.manifest.enabled, "Rollback target must be an earlier approved publication");
  assert.ok(expectedRevision, "Supply the operator-selected expected revision");
  assert.equal(current.health.revision, expectedRevision); assert.notEqual(current.health.revision, previous.health.revision, "Rollback must change the serving revision too");
  assert.ok(current.manifest.manifestVersion > previous.manifest.manifestVersion, "Rollback must publish a NEW, higher manifest generation");
  assert.deepEqual(tuples(current.manifest), tuples(target.manifest), "Rollback manifest must point to the earlier approved extraction tuples");
  assert.deepEqual([...(current.manifest.requiredSourceIds ?? [])].sort(), [...(target.manifest.requiredSourceIds ?? [])].sort(), "Rollback must restore the target revision's GBX_LIVE_SOURCES commitments");
}
const DOCUMENTS = [
  { kind: "acknowledgement", sourceId: "ga-147461", pages: 3, matches: (name) => /acknowledg/i.test(name) },
  { kind: "cooper-guide", sourceId: "ga-147461", pages: 5, matches: (name) => /cooper/i.test(name) && !/acknowledg|glossary/i.test(name) },
  { kind: "glossary", sourceId: "ga-147461", pages: 11, matches: (name) => /glossary/i.test(name) },
  { kind: "marabooka-report", sourceId: "peps-sa-marabooka-1", pages: 420, matches: (name) => /marabooka/i.test(name) },
];
export function assertDocumentInventory(manifest) {
  assert.equal(manifest?.enabled, true, "The live publication must be enabled");
  assert.ok(Array.isArray(manifest.sources));
  // later sources may be live alongside; this acceptance check covers exactly the two first live sources.
  const slice = manifest.sources.filter((s) => ["ga-147461", "peps-sa-marabooka-1"].includes(s.sourceId));
  assert.deepEqual(slice.map((s) => s.sourceId).sort(), ["ga-147461", "peps-sa-marabooka-1"]);
  const documents = slice.flatMap((source) => {
    assert.ok(Array.isArray(source.documents));
    return source.documents.map((document) => ({ ...document, sourceId: source.sourceId, extractionVersion: source.extractionVersion }));
  });
  assert.equal(documents.length, 4, "The complete slice contains exactly four PDFs");
  assert.equal(new Set(documents.map((d) => `${d.sourceId}:${d.sha256}`)).size, 4, "PDF identities must be unique");
  return DOCUMENTS.map((expected) => {
    const matching = documents.filter((d) => d.sourceId === expected.sourceId && expected.matches(`${d.title ?? ""} ${d.docId ?? ""}`));
    assert.equal(matching.length, 1, `Expected one ${expected.kind} PDF, matched by title or docId`);
    const d = matching[0]; assert.equal(d.pageCount, expected.pages, `${expected.kind} native page count`);
    assert.match(d.sha256, /^[a-f0-9]{64}$/, `${expected.kind} must identify the PDF hash`);
    assert.ok(typeof d.docId === "string" && d.docId.length && typeof d.extractionVersion === "string" && d.extractionVersion.length);
    return { kind: expected.kind, sourceId: d.sourceId, documentSha256: d.sha256, extractionVersion: d.extractionVersion, docId: d.docId, title: d.title, pageCount: d.pageCount };
  });
}
export function pageReferences(inventory, answers, allPages) {
  const cited = new Map();
  for (const answer of answers) for (const citation of answer.citations ?? []) if (citation.live) {
    const doc = inventory.find((d) => d.sourceId === citation.live.sourceId && d.documentSha256 === citation.live.documentSha256);
    assert.ok(doc, "A live answer cited a PDF outside the current inventory");
    assert.equal(citation.live.extractionVersion, doc.extractionVersion, "A citation points to a different extraction");
    assert.ok(Number.isInteger(citation.page) && citation.page >= 1 && citation.page <= doc.pageCount, "A cited page is outside its document");
    cited.set(`${doc.sourceId}:${doc.documentSha256}:${citation.page}`, { ...doc, page: citation.page, basis: "answer citation" });
  }
  const references = [];
  for (const doc of inventory) {
    const fromAnswer = [...cited.values()].filter((r) => r.sourceId === doc.sourceId && r.documentSha256 === doc.documentSha256);
    // Q10/Q01 do not normally cite the acknowledgement or glossary. Give those documents an explicit native-page
    // citation from the validated inventory, rather than pretending that a model cited them.
    const selected = allPages ? Array.from({ length: doc.pageCount }, (_, i) => cited.get(`${doc.sourceId}:${doc.documentSha256}:${i + 1}`) ?? { ...doc, page: i + 1, basis: "manifest page citation" })
      : fromAnswer.length ? fromAnswer : [{ ...doc, page: 1, basis: "manifest page citation" }];
    references.push(...selected.map((r) => ({ ...r, path: `/api/pages/${encodeURIComponent(r.sourceId)}/${r.documentSha256}/${r.page}` })));
  }
  return references;
}
export function readPageImage(page, path) {
  assert.match(path, /^\/api\/pages\//, "Page image checks must use the authenticated API");
  return page.evaluate(async (path) => {
          const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(20_000) });
          const bytes = await response.arrayBuffer(); let width = 0, height = 0;
          if (response.ok && response.headers.get("content-type")?.startsWith("image/png")) {
            try { const image = await createImageBitmap(new Blob([bytes], { type: "image/png" })); width = image.width; height = image.height; image.close(); } catch { /* the PNG assertion reports a decode failure */ }
          }
          return { status: response.status, path: new URL(response.url).pathname, contentType: response.headers.get("content-type"), cacheControl: response.headers.get("cache-control"), bytes: bytes.byteLength, width, height,
            signature: Array.from(new Uint8Array(bytes).subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("") };
  }, path);
}
// Cache-Control directive names, order-free, so "x-private" never counts as "private".
export const directives = (value) => new Set(String(value ?? "").split(",").map((d) => d.split("=")[0].trim().toLowerCase()).filter(Boolean));
export function assertPagePng(result, reference) {
  const label = `${reference.docId} page ${reference.page}`;
  assert.equal(result.status, 200, `${label} must reopen successfully`);
  assert.match(result.contentType ?? "", /^image\/png(?:;|$)/i, `${label} must return image/png`);
  const cache = directives(result.cacheControl); assert.ok(cache.has("private") && cache.has("no-store"), `${label} must be private, no-store`);
  assert.equal(result.signature, "89504e470d0a1a0a", `${label} is not a PNG`);
  assert.ok(result.bytes > 8 && result.width > 0 && result.height > 0, `${label} must decode as a nonempty PNG`);
  assert.equal(result.path, reference.path, `${label} must be served directly through its authenticated API path`);
}
export async function verifyPageImages(inventory, answers, reopen, allPages) {
  const proof = inventory.map((d) => ({ ...d, verifiedPages: [] }));
  for (const reference of pageReferences(inventory, answers, allPages)) {
    assertPagePng(await reopen(reference), reference);
    proof.find((d) => d.kind === reference.kind).verifiedPages.push({ page: reference.page, basis: reference.basis });
  }
  for (const d of proof) assert.equal(d.verifiedPages.length >= (allPages ? d.pageCount : 1), true, `Incomplete image coverage for ${d.docId}`);
  return proof;
}
export async function verifyPublishedStage(stage, manifest, { ask, reopen, check = async (_name, run) => run() }) {
  assert.ok(stage === "after" || stage === "rollback");
  let inventory, pageImages; const answers = [];
  await check("complete four-PDF inventory and exact native page counts", async () => { inventory = assertDocumentInventory(manifest); });
  for (const sourceId of ["ga-147461", "peps-sa-marabooka-1"]) assert.ok(manifest.requiredSourceIds?.includes(sourceId), "Both sources must be committed on the serving revision");
  await check(`Q10 exact report datum and tool-derived calculation (${stage})`, async () => { const r = await ask("Q10"); assert.ok(r.elapsed <= 90_000); assertQ10(r.data); answers.push(r.data); });
  await check(`Q11 uncertainty or timely withholding (${stage})`, async () => { const r = await ask("Q11"); assertQ11(r.data, r.elapsed); answers.push(r.data); });
  await check(`Q01 sixteen live play intervals (${stage})`, async () => {
    const r = await ask("Q01"); assert.ok(r.elapsed <= 90_000); assertQ01(r.data);
    const guide = inventory.find((d) => d.kind === "cooper-guide");
    assert.ok(r.data.citations.some((c) => c.live?.sourceId === guide.sourceId && c.live?.documentSha256 === guide.documentSha256), "Q01 must cite the Cooper data guide, not another GA PDF");
    answers.push(r.data);
  });
  await check(stage === "after" ? "PNG images for all 439 native pages across all four documents" : "rollback reopens answer citations and a native-page citation for every PDF", async () => {
    pageImages = await verifyPageImages(inventory, answers, reopen, stage === "after");
  });
  return { inventory, pageImages };
}
export function parseOptions(args) {
  const options = { site: process.env.GBX_SITE_URL ?? "https://localhost:8080", stage: "after", offline: "app/dist/geobasin-explorer-ai.html" };
  const allowed = new Set(["site", "stage", "previous", "target", "expected-revision", "out", "offline"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--self-test") { options.selfTest = true; continue; }
    assert.ok(args[i].startsWith("--") && allowed.has(args[i].slice(2)), `Unsupported option ${args[i]} (deployment and approval are deliberately unsupported)`);
    const key = args[i].slice(2), value = args[++i]; assert.ok(value && !value.startsWith("--"), `Missing --${key}`); options[key] = value;
  }
  assert.ok(["before", "after", "rollback"].includes(options.stage));
  const u = new URL(options.site); assert.equal(u.protocol, "https:"); assert.ok(!u.username && !u.password && !u.search && !u.hash && u.pathname === "/"); options.site = u.origin;
  return options;
}
function projectFile(value) {
  const file = path.resolve(repo, value), relative = path.relative(repo, file); assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Files must stay in the project directory"); return file;
}
export function selfTest() {
  const q10 = { label: "Retrieved", validation: { status: "passed" }, paragraphs: ["Top is 6326 ft below KB; minus KB elevation 181.9 ft gives 6144.1 ft below sea level."], computations: [{ tool: "convert_depth_kb_to_subsea", formula: "depthBelowKbFt - kbElevationFt", output: { value: 6144.1 }, inputs: [{ name: "depthBelowKbFt", value: 6326, unit: "ft", evidenceId: "citation-1" }, { name: "kbElevationFt", value: 181.9, unit: "ft", evidenceId: "citation-1" }], sourceIds: ["citation-1"] }], trace: [{ step: "Computed from source evidence", detail: "6144.1" }], citations: [{ id: "citation-1", page: 25, live: { sourceId: "peps-sa-marabooka-1" } }] };
  assertQ10(q10); assert.throws(() => assertQ10({ ...q10, paragraphs: ["Top is 6147 ft below sea level (KB 179 ft)."] }));
  assert.throws(() => assertQ10({ ...q10, paragraphs: [...q10.paragraphs, "It is 6147 ft at KB 179 ft."] }));
  assertQ11({ reason: "Validation incomplete", validation: { status: "incomplete" }, citations: [] }, 89_000);
  assert.throws(() => assertQ11({ reason: "Validation incomplete", validation: { status: "incomplete" }, citations: [] }, 91_000));
  assert.throws(() => parseOptions(["--approve"])); assert.throws(() => parseOptions(["--deploy"]));
  const q11 = { label: "Retrieved", validation: { status: "passed" }, citations: [{ page: 32, live: { sourceId: "peps-sa-marabooka-1" } }],
    paragraphs: ["Communication is one possible explanation for the essentially water-filled Patchawarra, not a proven connection."] };
  assertQ11(q11, 20_000); assert.throws(() => assertQ11({ ...q11, paragraphs: ["Communication may explain the water-filled Patchawarra; it is not only proven, but confirmed."] }, 20_000));
  assert.ok(directives("no-store, private").has("private")); assert.ok(!directives("x-private, x-no-store").has("private"));
  console.log("10 slice acceptance self-checks passed; Azure requests: 0.");
}
async function main(options) {
  assert.ok(process.env.GBX_TOKEN, "Set GBX_TOKEN to an operator token; this script never obtains credentials");
  assert.ok(options.out, "Specify --out for the stage's persistent evidence report");
  const reportFile = projectFile(options.out), outputDir = path.dirname(reportFile);
  fs.mkdirSync(outputDir, { recursive: true });
  const previous = options.previous ? JSON.parse(fs.readFileSync(projectFile(options.previous), "utf8")) : null;
  const target = options.target ? JSON.parse(fs.readFileSync(projectFile(options.target), "utf8")) : null;
  if (options.stage === "after") assert.ok(previous?.stage === "before" && previous.passed, "Run the before-approval stage first and pass its report with --previous");
  if (options.stage === "rollback") assert.ok(previous?.stage === "after" && previous.passed && target?.passed && options["expected-revision"], "Rollback needs the successful after report, approved --target report and --expected-revision");
  const questions = JSON.parse(fs.readFileSync(path.join(repo, "app/src/data/app-pack.json"), "utf8")).benchmarks;
  const q = (id) => { const b = questions.find((b) => b.id === id); assert.ok(b); return b.q; };
  const runtime = path.join(repo, `.slice-1a-browser-${randomUUID()}`); fs.mkdirSync(runtime); process.env.TMPDIR = runtime;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  let browser; const network = [], storage = [], checks = [], answers = {};
  const report = { stage: options.stage, site: options.site, startedAt: new Date().toISOString(), passed: false, checks, answers, network, storage };
  const check = async (name, fn) => { const start = Date.now(); try { await fn(); checks.push({ name, status: "PASS", ms: Date.now() - start }); console.log(`PASS ${name}`); } catch (e) { checks.push({ name, status: "FAIL", error: e.message, ms: Date.now() - start }); throw e; } };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const request = route.request(), u = new URL(request.url());
      if (forbiddenStorageRequest(u.href)) { storage.push(`${u.origin}${u.pathname}`); return route.abort(); }
      if (u.origin === options.site) {
        if (u.pathname.startsWith("/api/")) network.push({ method: request.method(), path: u.pathname });
        if (u.pathname.startsWith("/api/admin/") || (request.method() !== "GET" && request.method() !== "HEAD" && u.pathname !== "/api/ask")) return route.abort();
        return route.continue({ headers: { ...request.headers(), authorization: `Bearer ${process.env.GBX_TOKEN}` } });
      }
      // Azure Maps base-map tiles are expected; operator credentials are never forwarded to that host.
      if (/^(?:[a-z0-9-]+\.)*atlas\.microsoft\.com$/i.test(u.hostname)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); await page.goto(options.site, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const api = (path, body) => page.evaluate(async ({ path, body }) => { const started = Date.now(); const response = await fetch(path, { method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90_000) }); if (!response.ok) throw new Error(`API ${path}: ${response.status}`); return { data: await response.json(), elapsed: Date.now() - started }; }, { path, body });
    report.health = (await api("/api/health")).data; report.manifest = (await api("/api/live/manifest")).data;
    await check("operator identity and stable revision/publication snapshot", async () => {
      assertStageHealth(report.health, options.stage);
      assert.equal((await api("/api/me")).data.owner, true); assert.ok(report.health.revision, "This release must expose revision metadata");
      const again = (await api("/api/health")).data; assertStageHealth(again, options.stage); assert.equal(again.revision, report.health.revision);
    });
    const ask = async (id) => { const result = await api("/api/ask", { q: q(id), basin: null }); assert.ok(result.elapsed <= 90_000, `${id} exceeded the request budget`); answers[id] = result; return result; };
    for (const id of ["Q08", "Q09"]) await check(`${id} is Not found with the licence reason (${options.stage})`, async () => assertBlocked((await ask(id)).data));
    if (options.stage === "before") await check("Q10 retains the packaged 0.12.0 answer before Marabooka activation", async () => {
      assert.ok(!report.manifest.sources?.some((s) => s.sourceId === "peps-sa-marabooka-1"));
      assert.ok(!report.manifest.requiredSourceIds?.includes("peps-sa-marabooka-1"), "The pre-activation revision must not yet require Marabooka live");
      assertPackagedQ10((await ask("Q10")).data);
    });
    if (options.stage === "rollback") await check("rollback changes revision, commitments and manifest together", async () => assertRollback(report, previous, target, options["expected-revision"]));
    if (options.stage === "after" || options.stage === "rollback") {
      const dialog = page.getByRole("dialog", { name: /Who's exploring today/ }); if (await dialog.count()) await dialog.getByRole("button", { name: /^Start as exploration geoscientist$/i }).click();
      const askWithPage = async (id) => {
        if (id !== "Q10") return ask(id);
        const dock = page.getByRole("complementary", { name: "Exploration copilot" });
        if (!(await dock.count())) await page.getByRole("button", { name: "Open the exploration copilot" }).click();
        const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/ask", { timeout: 90_000 }); const start = Date.now();
        await dock.getByLabel("Message the exploration copilot").fill(q("Q10")); await dock.getByLabel("Message the exploration copilot").press("Enter");
        const reply = await response; const a = await reply.json(); const elapsed = Date.now() - start; assert.ok(elapsed <= 90_000); answers.Q10 = { data: a, elapsed }; assertQ10(a);
        const source = dock.locator('[data-copilot="reply"]').last().getByRole("button", { name: /marabooka.*live.*p\./i }).first();
        const imageResponse = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith("/api/pages/peps-sa-marabooka-1/")); await source.click();
        const image = await imageResponse; assert.equal(image.status(), 200); const cache = directives(image.headers()["cache-control"]); assert.ok(cache.has("private") && cache.has("no-store"), "Q10 page image must be private, no-store"); assert.match(image.headers()["content-type"], /image\/png/);
        await dock.locator('img[data-live-page="true"]').last().waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('img[data-live-page="true"]')].some((i) => i.complete && i.naturalWidth > 0));
        await page.screenshot({ path: path.join(outputDir, `q10-${options.stage}-live-page.png`) });
        return answers.Q10;
      };
      let lastPageStart = 0;
      const reopen = async (reference) => {
        // Bound read traffic below the existing site limit; page checks do not invoke models or publish anything.
        const delay = Math.max(0, 150 - (Date.now() - lastPageStart)); if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); lastPageStart = Date.now();
        return readPageImage(page, reference.path);
      };
      Object.assign(report, await verifyPublishedStage(options.stage, report.manifest, { ask: askWithPage, reopen, check }));
      await check("Marabooka marker has live provenance; other layers are labelled packaged snapshot", async () => { assert.ok(report.manifest.sources.find((s) => s.sourceId === "peps-sa-marabooka-1").wellLocation); assert.match(await page.locator('[data-live-map-status="true"]').first().innerText(), /live geotag.*packaged snapshot/i); });
    }
    await check("page images use the API; Atlas map traffic is allowed, but Blob/DFS and SAS are forbidden", async () => { assert.deepEqual(storage, []); assert.ok(network.every((r) => r.path.startsWith("/api/"))); if (options.stage !== "before") assert.ok(network.some((r) => r.path.startsWith("/api/pages/"))); });
    await check("offline single-file answer still works with zero network requests", async () => {
      const offline = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const attempts = [];
      try {
        await offline.route("**/*", (route) => { if (/^(file|data|blob):/.test(route.request().url())) return route.continue(); attempts.push(route.request().url()); return route.abort(); });
        const p = await offline.newPage(); await p.goto(pathToFileURL(projectFile(options.offline)).href);
        await p.getByRole("dialog", { name: /Who's exploring today/ }).getByRole("button", { name: /^Start as exploration geoscientist$/i }).click();
        const dock = p.getByRole("complementary", { name: "Exploration copilot" }); await dock.getByLabel("Message the exploration copilot").fill(q("Q10")); await dock.getByLabel("Message the exploration copilot").press("Enter");
        // The offline engine's Q10 answer gives the kelly-bushing depth and quotes the tops table's rounded subsea
        // figure (6144'); it never computes 6144.1, and its exact answers are guarded by the offline fingerprint suite.
        await dock.locator('[data-copilot="reply"]').last().waitFor(); assert.match((await dock.locator('[data-copilot="reply"]').last().innerText()).replace(/,/g, ""), /\b6326\b/); assert.deepEqual(attempts, []);
      } finally { await offline.close(); }
    });
    await check("AI remains enabled through the completed stage", async () => assertStageHealth((await api("/api/health")).data, options.stage));
    report.passed = checks.every((c) => c.status === "PASS");
  } catch (e) { report.error = e.message; process.exitCode = 1; console.error(`FAIL ${e.message}`); }
  finally { if (browser) await browser.close(); fs.rmSync(runtime, { recursive: true, force: true }); report.completedAt = new Date().toISOString(); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n"); console.log(`Report: ${path.relative(repo, reportFile)} (${checks.filter((c) => c.status === "PASS").length}/${checks.length} passed)`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseOptions(process.argv.slice(2)); if (options.selfTest) selfTest(); else await main(options);
}
