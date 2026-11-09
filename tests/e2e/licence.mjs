// Cloud UI licence regressions against the built files. Azure Maps and API replies are stubbed; no cloud access.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/e2e/licence.mjs [app/dist-cloud]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(repo, "app/dist-cloud"));
const runtime = path.join(repo, `.licence-browser-${randomUUID()}`);
fs.mkdirSync(runtime);
process.env.TMPDIR = runtime;
const require = createRequire(path.join(repo, "app/package.json"));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.resolve(root, "." + (name === "/" ? "/index.html" : name));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" }); fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let checks = 0;
const errors = [], external = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem("gbx-notebook", JSON.stringify([{ id: "old", kind: "Answer", title: "FORBIDDEN_CLOUD_NOTE", note: "Old unlicensed evidence", sources: "GSQ CR000407" }]));
    localStorage.setItem("gbx-cloud-licence-20261102:gbx-notebook", JSON.stringify([{ id: "v1", kind: "Answer", title: "FORBIDDEN_V1_CLOUD_NOTE", note: "core photo taken from the 2026 DEM slides instead", sources: "Marabooka 1" }]));
  });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (u.origin !== origin) { external.push(u.href); return route.abort(); }
    if (/\/assets\/azure-basin-map-.*\.js$/.test(u.pathname)) return route.fulfill({ contentType: "text/javascript", body: "export default function LicenceMapStub() { return null; }" });
    if (u.pathname === "/api/live/manifest") return json({ enabled: false, manifestVersion: null, createdAt: null, sources: [], reason: "Live publication unavailable" });
    if (u.pathname === "/api/me") return json({ id: "test", name: "licence test", owner: false, ai: true, uploads: true, models: { writer: "test writer", checker: "test checker" } });
    if (u.pathname === "/api/basemap/esri") return json({ enabled: false, reason: "Esri isn't connected to this deployment yet.", styles: [] });
    if (u.pathname === "/api/reviews") return json({ review: {}, log: [{ entity: "field:innamincka-1:dst10-sip", before: "FORBIDDEN_CLOUD_REVIEW", after: "FORBIDDEN_CLOUD_REVIEW", at: "2026-11-02", by: "test", action: "Accepted", note: "" }] });
    if (u.pathname === "/api/ask") {
      const { q } = route.request().postDataJSON();
      return json({ id: `test-${Date.now()}`, question: q, status: "answered", basin: "cooper", label: "Precomputed", reason: "Test a stale API reply", paragraphs: ["FORBIDDEN_CLOUD_ANSWER"], citations: [{ id: "innamincka-1:dst10-sip", doc: "Innamincka 1 report", page: 10, basin: "cooper", heading: "Test", text: "FORBIDDEN_CLOUD_ANSWER" }], provenance: ["extracted"], focus: null, focusBasin: null, highlight: [], hits: [], followUps: [], why: { terms: [], rule: "Test", scores: [] }, fieldRef: { site: "innamincka-1", field: "dst10-sip" } });
    }
    if (u.pathname === "/api/spatial/here") {
      const { lon, lat } = route.request().postDataJSON(); const pos = { easting: 0, northing: 0, epsg: 7854 };
      return json({ lon, lat, basin: "cooper", basinName: "Cooper Basin", depth: 1000, boreholes: [{ name: "Innamincka 1", key: "ga-test", lon, lat, td: 1000, year: 2000, km: 0 }], within10: 1, stress: null, seismicKm: null, features: [], wells: [{ id: "innamincka-1", name: "Innamincka 1", km: 0 }], method: "Test fixture", versions: { proj: "test", gdal: "test" }, gda2020: { lon, lat, shiftM: 0 }, mga: { zone: 54, gda94: pos, gda2020: pos }, ms: 1 });
    }
    if (u.pathname === "/api/search/near") {
      const { lon, lat, km } = route.request().postDataJSON();
      return json({ lon, lat, km, matched: 1, sources: [{ id: "inn-ocr:test", doc: "Innamincka 1 · Government OCR text", page: 1, pages: [1], passages: 1, place: "Innamincka 1", how: "Test", lon, lat, km: 0 }], nearest: null, basin: null, ms: 1, method: "Test" });
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
  const role = async (name) => { await page.getByRole("button", { name: /^Role:/ }).click(); await page.getByRole("menuitem", { name }).click(); };
  const noText = async (text) => assert.ok(!(await page.locator("body").innerText()).includes(text), text);
  // Withheld sources stay withheld, but the pages no longer carry a notice about them.
  const NOTICE = "Withheld in the cloud build";
  await page.goto(origin);
  await page.getByRole("dialog", { name: /Who's exploring today/ }).getByRole("button", { name: /^Start as exploration geoscientist$/i }).click();

  await check("evidence cards withhold Innamincka and retain Marabooka", async () => {
    await page.getByRole("button", { name: "Evidence", exact: true }).click();
    await page.getByRole("heading", { name: "Evidence and stress tests" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Innamincka 1.*1960 report/ }).count(), 0);
    assert.ok(await page.getByRole("button", { name: /Marabooka 1.*1981 report/ }).count());
    await noText(NOTICE); await noText("GSQ open file CR000407");
  });
  await check("catalogue and governance omit the unconfirmed report", async () => {
    await page.getByRole("tab", { name: "Data", exact: true }).click(); await page.getByRole("tab", { name: "Sources", exact: true }).click();
    await noText("Innamincka 1 well completion report, 1960"); await noText(NOTICE);
    assert.ok((await page.locator("body").innerText()).includes("Marabooka 1 well completion report"));
    await page.getByRole("tab", { name: "What's real" }).click(); await noText(NOTICE); await noText("Not in this build");
    await page.getByRole("tab", { name: "Governance" }).click();
    assert.ok(!(await page.getByRole("table", { name: "Licences and credit by source" }).innerText()).includes("Innamincka"));
  });
  await check("sample report is unavailable even when uploads are enabled", async () => {
    await page.getByRole("button", { name: "Add a document", exact: true }).click();
    const d = page.getByRole("dialog", { name: "Add a document" });
    assert.equal(await d.getByRole("button", { name: "Try the sample report" }).count(), 0);
    assert.ok(await d.getByRole("button", { name: "Choose a PDF", exact: true }).count());
    const dialogText = await d.innerText(); assert.ok(!dialogText.includes(NOTICE)); assert.ok(!dialogText.includes("CR050039")); await page.keyboard.press("Escape");
  });
  await check("low-carbon sites and workshop evidence are filtered", async () => {
    await role(/Low-carbon/);
    const wells = page.getByRole("group", { name: "Low-carbon wells" }); await wells.waitFor(); await noText(NOTICE);
    assert.equal(await wells.getByRole("button", { name: /ZeroGen|Innamincka/ }).count(), 0);
    assert.equal(await wells.getByRole("button", { name: /Marabooka 1|Habanero 1/ }).count(), 2);
    await wells.getByRole("button", { name: "Marabooka 1", exact: true }).click();
    await page.getByRole("group", { name: "Low-carbon view" }).getByRole("button", { name: "Evidence", exact: true }).click();
    await noText("Cumulative Toolachee gas production"); await noText("now receiving CO₂");
    for (const text of ["2026 DEM slides", "core photo taken", "CO2-injection era", "Only 3 of 14", "beneath the store"]) await noText(text);
    assert.equal(await page.locator('img[src*="dem2026"]').count(), 0);
  });
  await check("image search contains no withheld workshop or well-report photos", async () => {
    await page.getByRole("tab", { name: "Images", exact: true }).click();
    await page.getByRole("heading", { name: "79 core images from Geoscience Australia" }).waitFor(); await noText(NOTICE);
    const urls = await page.locator("img").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src") ?? ""));
    assert.deepEqual(urls.filter((url) => !url.startsWith("data:") && /dem2026|\/zg2|\/innamincka/i.test(url)), []);
  });
  await check("GA Innamincka borehole and lineage remain without scanned-report evidence", async () => {
    await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
    await page.getByLabel("Find a formation, play, basin or well").fill("Innamincka");
    await page.getByRole("button", { name: /Innamincka.*Well/i }).click();
    const card = page.locator('article[aria-label^="Well:"]'); await card.waitFor();
    assert.ok(!(await card.innerText()).includes("Scanned report")); assert.ok(!(await card.innerText()).includes(NOTICE));
    assert.equal(await card.getByRole("button", { name: "Ask about this", exact: true }).count(), 0);
    await card.getByRole("button", { name: "Where did this come from?" }).click();
    const d = page.getByRole("dialog"); assert.ok((await d.innerText()).includes("Geoscience Australia")); assert.ok(!(await d.innerText()).includes("GSQ open file")); await page.keyboard.press("Escape");
    const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Download ontology (Turtle)" }).click();
    const download = await pending, file = await download.path();
    assert.ok(file.startsWith(runtime + path.sep));
    const turtle = fs.readFileSync(file, "utf8");
    assert.ok(turtle.includes("Innamincka 1")); assert.ok(!turtle.includes("CR000407")); assert.ok(!turtle.includes("GSQ open file reports"));
  });
  await check("starters omit restricted questions and stale API answers are withheld", async () => {
    await role(/Data scientist/);
    assert.equal(await page.getByRole("button", { name: /DST 10.*Innamincka|A 1960 scan/ }).count(), 0);
    const dock = page.getByRole("complementary", { name: "Exploration copilot" });
    if (!(await dock.count())) await page.getByRole("button", { name: "Open the exploration copilot" }).click();
    const box = dock.getByLabel("Message the exploration copilot"); await box.fill("What was the DST 10 shut-in pressure in Innamincka 1?"); await box.press("Enter");
    await dock.getByText(/requested evidence is withheld/).first().waitFor();
    await noText("FORBIDDEN_CLOUD_ANSWER"); await noText("FORBIDDEN_CLOUD_REVIEW");
  });
  await check("spatial replies cannot reintroduce a scanned-report button or restricted source", async () => {
    await role(/Computational geoscientist/); await page.getByRole("button", { name: "What we know at the Nappamerri Trough" }).click();
    await page.getByRole("heading", { name: "Position in GDA2020 and MGA" }).waitFor();
    const card = page.locator('section[aria-labelledby="here-h"]');
    assert.equal(await card.getByRole("button", { name: /Innamincka 1 scanned report/ }).count(), 0);
    assert.ok((await card.innerText()).includes("Innamincka 1"));
    assert.ok(!(await card.innerText()).includes("Government OCR text")); assert.ok(!(await card.innerText()).includes(NOTICE));
  });
  await check("cloud scorecard omits withheld answer keys", async () => {
    await page.getByRole("tab", { name: "Evaluate", exact: true }).click();
    await page.getByRole("button", { name: "Run all 10 questions" }).waitFor();
    await noText("what shut-in pressure did DST 10 record"); await noText("highest bottom-hole temperature recorded in Innamincka 1");
  });
  await check("old browser notes cannot reopen pre-gate content", async () => {
    await page.goto(origin + "/?check=notes#tab=notes"); await page.getByRole("heading", { name: "Notes", exact: true }).first().waitFor(); await noText("FORBIDDEN_CLOUD_NOTE"); await noText("FORBIDDEN_V1_CLOUD_NOTE");
  });
  await check("cloud guided tour omits restricted source steps", async () => {
    await page.goto(origin + "/?check=tour#ex=1");
    const tour = page.locator('section[aria-labelledby="track-h"]');
    for (let i = 1; i <= 6; i++) {
      await tour.getByRole("heading", { name: `Guided tour: step ${i} of 6` }).waitFor();
      const text = await tour.innerText(); assert.ok(!/Innamincka|ZeroGen/.test(text));
      if (i < 6) await tour.getByRole("button", { name: "Next", exact: true }).click();
    }
  });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(`\n${checks} cloud UI checks. Failures: 0. Page errors: 0. External requests: 0. APIs and map stubbed.`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(runtime, { recursive: true, force: true });
}
