// Cloud UI regressions with fake same-origin APIs, not a live acceptance run. No Azure access.
import assert from "node:assert/strict";
import { readPageImage, assertPagePng } from "./slice-1a.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const root = fileURLToPath(new URL("../../", import.meta.url)), build = path.resolve(process.argv[2] ?? path.join(root, "app/dist-cloud"));
const require = createRequire(path.join(root, "app/package.json"));
const work = path.join(root, `.live-ui-${randomUUID()}`); fs.mkdirSync(work); process.env.TMPDIR = work;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname), file = path.resolve(build, `.${name === "/" ? "/index.html" : name}`);
  if (!file.startsWith(build + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".woff2": "font/woff2" };
  res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" }); fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const origin = `http://127.0.0.1:${server.address().port}`;
const landed = "a".repeat(64), pdf = "b".repeat(64), extraction = `layout-v1-${"c".repeat(64)}-11111111-2222-4333-8444-555555555555`;
const ref = { sourceId: "peps-sa-marabooka-1", sha256: landed, extractionVersion: extraction };
const source = { ...ref, publisher: "PEPS South Australia", title: "Marabooka 1 report", url: "bundle-copy", licence: "CC BY 4.0", attribution: "PEPS South Australia", expectedSha256: landed, publishAllowed: true, licenceBasis: "Owner confirmed", freshness: "NOT VERIFIED", v1DocIds: ["marabooka-1-completion-report"], wellLocation: { lon: 140.6102, lat: -28.176, datum: "GDA94" }, documents: [{ docId: "report", sha256: pdf, title: "Marabooka 1 report", pageCount: 420, chunkCount: 800 }] };
const review = { ...ref, status: "pending", createdAt: "2026-11-02T16:00:00.000Z", pageCount: 420, chunkCount: 800, confidence: { mean: 0.96, minimum: 0.7, measuredPages: 420, lowConfidencePages: 2 }, sampleChunkIds: ["sample1"], decision: null };
const document = { ...ref, docId: "report", documentSha256: pdf, title: "Marabooka 1 report", pageCount: 420 };
const sample = { ...document, id: "sample1", page: 25, text: "Top Toolachee 6326 ft below KB", headingPath: ["Formation tops"] };
const publication = { requiredSourceIds: ["peps-sa-marabooka-1"], enabled: true, manifestVersion: 3, createdAt: "2026-11-02T16:10:00.000Z", sources: [source] };
const answer = { id: "live-answer", question: "What is the Toolachee top?", status: "answered", basin: "cooper", engine: "azure", label: "Retrieved", reason: "Live test", paragraphs: ["Top is 6326 ft below KB and 6144.1 ft below sea level."], provenance: ["published", "computed"], focus: null, focusBasin: "cooper", highlight: [], followUps: [], hits: [], why: { terms: [], rule: "Live test", scores: [] }, citations: [{ id: "live-1", basin: "cooper", doc: "Marabooka 1 report", page: 25, heading: "Formation tops", text: sample.text, provenanceLabel: "live", live: { sourceId: ref.sourceId, documentSha256: pdf, extractionVersion: extraction, manifestVersion: 3 } }], validation: { status: "passed", validator: "Test checker", checked: 1, supported: 1, removed: [], note: "Test" }, trace: [] };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
let browser, checks = 0;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  for (const owner of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const admin = [], images = [], external = [], errors = [], decisions = [];
    let manifestAvailable = true, alreadyPublished = false, decisionFailure = null;
    let reviewState = review, publicationState = { status: "pending" }, reviewEtag = 'W/"review-1"';
    await context.route("**/*", (route) => {
      const request = route.request(), u = new URL(request.url()), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (u.origin !== origin) { external.push(u.href); return route.abort(); }
      if (/\/assets\/azure-basin-map-.*\.js$/.test(u.pathname)) return route.fulfill({ contentType: "text/javascript", body: "export default function MapStub(props) { window.__liveSites = props.sites; return null; }" });
      if (u.pathname === "/api/me") return json({ name: "Tester", id: "test", owner, liveSources: ["peps-sa-marabooka-1"], ai: true, uploads: false });
      if (u.pathname === "/api/reviews") return json({ review: {}, log: [] });
      if (u.pathname === "/api/live/manifest") return manifestAvailable ? json(publication) : json({ error: "Unavailable" }, 503);
      if (u.pathname === "/api/ask") return json({ ...answer, question: request.postDataJSON().q });
      if (u.pathname.startsWith("/api/pages/")) { images.push(u.pathname); return route.fulfill({ contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: png }); }
      if (u.pathname.startsWith("/api/admin/")) {
        admin.push(u.pathname); if (!owner) return json({ error: "Owner required" }, 403);
        if (u.pathname === "/api/admin/live/reviews") return json({ reviews: [reviewState], registry: [source] });
        if (/\/pages\//.test(u.pathname)) { images.push(u.pathname); return route.fulfill({ contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: png }); }
        if (/\/decision$/.test(u.pathname)) { const body = request.postDataJSON(); decisions.push({ body, etag: request.headers()["if-match"] }); if (decisionFailure) return json({ error: decisionFailure }, 400); if (body.reason.length > 500) return json({ error: "Reason exceeds 500 characters." }, 400); if (alreadyPublished) return json({ review: reviewState, etag: reviewEtag, publication: { status: "published", manifestVersion: 3 } }); reviewState = { ...review, status: body.decision, decision: { ...body, by: "Owner", at: "2026-11-02T17:00:00.000Z" } }; publicationState = { status: "queued" }; reviewEtag = 'W/"next"'; return json({ review: reviewState, etag: reviewEtag, publication: publicationState }, 202); }
        return json({ review: reviewState, source, documents: [document], samples: [sample], etag: reviewEtag, publication: publicationState });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin); await page.getByRole("dialog", { name: /Who's exploring today/ }).getByRole("button", { name: /^Start as exploration geoscientist$/i }).click();
    await page.waitForFunction(() => window.__liveSites?.some((s) => s.id === "marabooka-1" && s.lon === 140.6102 && /live geotag/.test(s.tag)));
    checks++; console.log(`PASS manifest-driven marker (${owner ? "owner" : "tester"})`);
    const dock = page.getByRole("complementary", { name: "Exploration copilot" }); await dock.getByLabel("Message the exploration copilot").fill("What is the Toolachee top?"); await dock.getByLabel("Message the exploration copilot").press("Enter");
    await dock.locator('[data-copilot="reply"]').last().getByRole("button", { name: /live.*p\./ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('img[data-live-page="true"]')].some((i) => i.complete && i.naturalWidth > 0));
    assert.ok(images.includes(`/api/pages/${ref.sourceId}/${pdf}/25`)); assert.ok(!images.some((u) => u.startsWith(`/api/pages/${ref.sourceId}/${landed}/`)));
    checks++; console.log(`PASS live page uses PDF hash and authenticated API (${owner ? "owner" : "tester"})`);
    const reference = { docId: "report", page: 25, path: `/api/pages/${ref.sourceId}/${pdf}/25` };
    assertPagePng(await readPageImage(page, reference.path), reference);
    checks++; console.log(`PASS acceptance PNG decoder works through the authenticated API (${owner ? "owner" : "tester"})`);
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    if (!owner) { assert.equal(await page.getByRole("region", { name: "Live source steward review" }).count(), 0); assert.deepEqual(admin, []); checks++; console.log("PASS tester cannot see or fetch steward review"); }
    else {
      const panel = page.getByRole("region", { name: "Live source steward review" }); await panel.getByRole("button", { name: "Inspect extraction" }).click();
      await panel.getByText("Sample chunk · native PDF page 25").click();
      await page.waitForFunction(() => document.querySelectorAll('img[data-live-page="true"]').length >= 1);
      await panel.getByRole("button", { name: "Approve extraction" }).waitFor(); assert.equal(await panel.getByRole("button", { name: "Approve extraction" }).isDisabled(), true);
      const reasonInput = panel.getByLabel("Decision reason"), validReason = "x".repeat(500);
      assert.equal(await reasonInput.getAttribute("maxlength"), "500");
      await panel.getByText("500 characters remaining", { exact: true }).waitFor();
      await reasonInput.fill(validReason); await panel.getByText("0 characters remaining", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "Approve extraction" }).isDisabled(), false);
      decisionFailure = "Review or registry changed; reload before deciding.";
      await panel.getByRole("button", { name: "Approve extraction" }).click();
      await panel.getByRole("alert").filter({ hasText: decisionFailure }).waitFor();
      assert.equal(await reasonInput.inputValue(), validReason); assert.ok(await panel.getByRole("button", { name: "Approve extraction" }).count());
      assert.equal(decisions[0].body.reason.length, 500);
      await panel.getByRole("button", { name: "Reload review, keep reason" }).click();
      await reasonInput.waitFor(); assert.equal(await reasonInput.inputValue(), validReason);
      checks++; console.log("PASS 500-character reason is retained with the API error, including after reload");
      await reasonInput.evaluate((element) => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(element, "x".repeat(501)); element.dispatchEvent(new Event("input", { bubbles: true })); });
      await panel.getByText("1 character over the limit", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "Approve extraction" }).isDisabled(), true);
      assert.equal(await panel.getByRole("button", { name: "Reject extraction" }).isDisabled(), true); assert.equal(decisions.length, 1);
      checks++; console.log("PASS 501-character reason is blocked without an API decision request");
      decisionFailure = null; await reasonInput.fill(validReason); await panel.getByRole("button", { name: "Approve extraction" }).click();
      await panel.getByText(/Approval recorded\. Publication is queued/).waitFor();
      assert.deepEqual(decisions[1], { etag: 'W/"review-1"', body: { ...ref, decision: "approved", reason: validReason } });
      assert.ok(images.some((u) => u.includes(`/api/admin/live/reviews/${ref.sourceId}/${landed}/${extraction}/pages/${pdf}/25`)));
      checks++; console.log("PASS owner review binds landed hash/extraction/ETag, previews PDF page, reports queued not live");
      publicationState = { status: "failed" };
      await panel.getByRole("button", { name: "Inspect extraction" }).click();
      await panel.getByRole("button", { name: "Retry approved publication" }).click();
      await page.waitForFunction(() => document.body.innerText.includes("Approval recorded. Publication is queued"));
      assert.deepEqual(decisions[2], { etag: 'W/"next"', body: decisions[1].body });
      checks++; console.log("PASS retry reuses the recorded approval tuple/reason and fresh ETag");
      publicationState = { status: "failed" };
      await panel.getByRole("button", { name: "Inspect extraction" }).click(); alreadyPublished = true;
      await panel.getByRole("button", { name: "Retry approved publication" }).click();
      await panel.getByText("This approval is already published; no new publication was queued.").waitFor();
      checks++; console.log("PASS already-published approval is reported as a no-op, not a queued publish");
      manifestAvailable = false;
      await panel.getByRole("button", { name: "Refresh publications and reviews" }).click();
      await page.waitForFunction(() => window.__liveSites?.every((s) => s.id !== "marabooka-1"));
      checks++; console.log("PASS failed manifest refresh removes live marker instead of substituting packaged coordinates");
    }
    assert.deepEqual(external, []); assert.deepEqual(errors, []); await context.close();
  }
  for (const { name, configured, invalid, published } of [
    { name: "empty", configured: [], invalid: false }, { name: "invalid", configured: [], invalid: true },
    { name: "published but uncommitted", configured: [], invalid: false, published: true },
    { name: "missing committed", configured: ["peps-sa-marabooka-1"], invalid: false }, { name: "invalid committed", configured: ["peps-sa-marabooka-1"], invalid: true },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const external = [], pages = [];
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url()), json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (u.origin !== origin) { external.push(u.href); return route.abort(); }
      if (/\/assets\/azure-basin-map-.*\.js$/.test(u.pathname)) return route.fulfill({ contentType: "text/javascript", body: "export default function MapStub(props) { window.__liveSites = props.sites; window.__selectSite = props.onSelectSite; return null; }" });
      if (u.pathname === "/api/me") return json({ id: "test", name: "Tester", owner: false, liveSources: configured, ai: true, uploads: false });
      if (u.pathname === "/api/reviews") return json({ review: {}, log: [] });
      if (u.pathname === "/api/live/manifest") return json(published ? { ...publication, requiredSourceIds: configured } : invalid ? { enabled: true, requiredSourceIds: configured, sources: [{}] } : { enabled: false, manifestVersion: null, createdAt: null, sources: [], requiredSourceIds: configured });
      if (u.pathname === "/api/ask") {
        const citations = answer.citations.map(({ live, provenanceLabel, ...c }) => c);
        return json(configured.length ? { ...answer, label: "Not found", status: "unsupported", reason: "Live publication unavailable", citations: [], paragraphs: ["Not found. Live publication unavailable."] }
          : { ...answer, label: "Precomputed", reason: "Prepared from packaged sources", citations });
      }
      if (u.pathname.startsWith("/api/pages/")) { pages.push(u.pathname); return json({ error: "Not published" }); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    await page.goto(origin); await page.getByRole("dialog", { name: /Who's exploring today/ }).getByRole("button", { name: /^Start as exploration geoscientist$/i }).click();
    await page.waitForFunction((blocked) => Array.isArray(window.__liveSites) && window.__liveSites.some((s) => s.id === "marabooka-1") === !blocked, configured.length > 0);
    const markers = await page.evaluate(() => window.__liveSites); assert.ok(markers.every((s) => !s.tag.includes("packaged snapshot")));
    // The publication status sits in the Layers panel (from 0.13.43 the map carries no standing key card).
    await page.getByRole("button", { name: "Layers" }).click(); const status = page.locator('[data-live-map-status="true"]');
    if (configured.length) assert.match(await status.first().innerText(), /Live publication unavailable/); else assert.equal(await status.count(), 0);
    await page.keyboard.press("Escape");
    const dock = page.getByRole("complementary", { name: "Exploration copilot" }); await dock.getByLabel("Message the exploration copilot").fill("What is the Toolachee top?"); await dock.getByLabel("Message the exploration copilot").press("Enter");
    await dock.locator('[data-copilot="reply"]').last().waitFor();
    assert.ok(!(await page.locator("body").innerText()).toLowerCase().includes("packaged snapshot"));
    if (!configured.length) {
      await dock.locator('[data-copilot="source"]').last().click(); assert.equal(await page.locator('[data-live-page="true"]').count(), 0);
      await page.evaluate(() => window.__selectSite("marabooka-1"));
      assert.equal(await page.getByRole("dialog", { name: "Marabooka 1 live publication" }).count(), 0);
    }
    assert.deepEqual(pages, []); assert.deepEqual(external, []); await context.close();
    checks++; console.log(`PASS ${name} manifest honors revision commitments without new packaged labels`);
  }
  console.log(`${checks} live UI checks passed. Azure requests: 0.`);
} finally { if (browser) await browser.close(); await new Promise((r) => server.close(r)); fs.rmSync(work, { recursive: true, force: true }); }
