// Offline end-to-end test for the single-file build. Every network request is blocked.
// It opens the HTML from disk, picks a role, asks the benchmark questions, checks Show your work, the learning loop,
// Add a document (with the bundled sample), the knowledge click-through, images, the Co-Scientist, roles and sections,
// the Data workspace, the live test run, the guided tour, the Excel export, deep links, blocked storage, the docked copilot
// (typed and spoken questions with speech stubbed, one thread for answers asked anywhere), resizing the copilot and the
// side panel, and layout in dark mode, at 125% zoom and at three screen sizes. Questions go through the docked copilot;
// the full answer opens in the side panel.
//
// Usage:  node tests/e2e/smoke.mjs [path/to/geobasin-explorer-ai.html] [screenshot folder]
// Env:    CHROME_PATH        use an installed Chrome or Edge instead of Playwright's browser
//         PLAYWRIGHT_MODULE  where to load Playwright from (default: app/node_modules/playwright)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const require = createRequire(path.join(repo, "app", "package.json"));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [htmlArg, outArg] = process.argv.slice(2);
const HTML = path.resolve(htmlArg || path.join(repo, "app/dist/geobasin-explorer-ai.html"));
if (!fs.existsSync(HTML)) { console.error(`Not found: ${HTML}. Build the app first (cd app && npm run build).`); process.exit(2); }
const OUT = path.resolve(outArg || fs.mkdtempSync(path.join(os.tmpdir(), "gbx-shots-")));
fs.mkdirSync(OUT, { recursive: true });
const URL = pathToFileURL(HTML).href;
const L = { start: "Start the guided tour", step: (n) => new RegExp(`Guided tour: step ${n} of \\d+`), reset: "Reset the tour", cs: /Computational geoscientist/, prefix: /^geobasin-explorer-ai-scorecard_/, pack: path.join(repo, "app/src/data/app-pack.json") };
const pack = JSON.parse(fs.readFileSync(L.pack, "utf8"));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [], network = [], log = [], R = {};
let failed = 0;
async function newPage(opts = {}, init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", acceptDownloads: true, ...opts });
  await ctx.route("**/*", (r) => { const u = r.request().url(); if (/^(file|data|blob):/.test(u)) return r.continue(); network.push(u.slice(0, 160)); return r.abort(); });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message).slice(0, 240)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 240)); });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const step = async (name, fn) => { const t = Date.now(); try { await fn(); log.push(`ok    ${name} (${Date.now() - t} ms)`); } catch (e) { failed++; log.push(`FAIL  ${name}: ${String(e.message).split("\n")[0].slice(0, 260)}`); } };
const closeDialogs = async (page) => { for (let i = 0; i < 3; i++) if (await page.locator('[role="dialog"]').count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(250); } };
const answer = (page) => page.locator('article[aria-label^="Answer:"]').first();
const dockOf = (page) => page.getByRole("complementary", { name: "Exploration copilot" });
async function ask(page, q) {
  const dock = dockOf(page);
  if (!(await dock.count())) await page.getByRole("button", { name: "Open the exploration copilot" }).click();
  const box = dock.getByLabel("Message the exploration copilot"); await box.fill(q); await box.press("Enter");
  await page.waitForTimeout(80); await dock.locator('[data-copilot="busy"]').waitFor({ state: "detached", timeout: 15000 });
  const user = await dock.locator('[data-copilot="user"]').last().innerText(); if (!user.includes(q.slice(0, 40))) throw new Error("copilot did not ask: " + user.slice(0, 80));
  await dock.locator('[data-copilot="reply"]').last().getByRole("button", { name: "Open full answer" }).click();
  const art = answer(page); await art.waitFor({ timeout: 15000 }); await page.waitForTimeout(120);
  const text = await art.innerText();
  const cites = await art.locator('section[aria-label="Sources"] button').count();
  return { q, ok: cites > 0 || /Not found in the data|outside what this file holds/.test(text), cites, label: /Precomputed|Retrieved|Not found/.exec(text)?.[0] ?? "none", text };
}
async function pickRole(page, name = /^Start as exploration geoscientist$/i) {
  const d = page.getByRole("dialog", { name: /Who's exploring today/ }); await d.waitFor({ timeout: 30000 });
  await d.getByRole("button", { name }).click(); await page.waitForTimeout(500);
}

const t0 = Date.now();
const { ctx, page } = await newPage();
page.setDefaultTimeout(20000);
await page.goto(URL);
await step("role picker on first open", async () => { await page.getByRole("dialog", { name: /Who's exploring today/ }).waitFor({ timeout: 30000 }); R.loadMs = Date.now() - t0; await shot(page, "00-role-picker"); await pickRole(page); await shot(page, "01-map"); });
await step("benchmarks cite or say not found, with a label", async () => {
  const bad = [], labels = {};
  for (const b of pack.benchmarks) { const r = await ask(page, b.q); labels[r.label] = (labels[r.label] || 0) + 1; if (!r.ok || r.label === "none") bad.push(b.id); }
  R.benchLabels = labels; if (bad.length) throw new Error("bad: " + bad.join(","));
});
await step("show your work", async () => {
  const art = answer(page); await art.getByText("Show your work").click(); await page.waitForTimeout(200);
  const n = await art.locator('ol[aria-label="Steps"] li').count(); R.steps = n; if (n < 3) throw new Error(`only ${n} steps`);
  R.stepsText = (await art.locator('ol[aria-label="Steps"]').innerText()).slice(0, 600); await shot(page, "02-show-your-work");
});
await step("free-form and out-of-scope", async () => {
  const r = await ask(page, "Which plays are analogs to the Cooper Basin Patchawarra Play?"); if (!r.ok) throw new Error("analog not cited");
  const r2 = await ask(page, "What is the share price of a mining company today?"); if (!r2.ok) throw new Error("not declined");
  const r3 = await ask(page, "What do the reports say about Permian coal and gas in the Galilee Basin?"); R.multi = { label: r3.label, cites: r3.cites, head: r3.text.slice(0, 300) };
});
await step("learning loop: thumbs down then ask again", async () => {
  const q = "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are, and on which page?";
  const r = await ask(page, q); const art = answer(page);
  const before = await art.locator('section[aria-label="Sources"] button').allInnerTexts();
  await art.getByRole("button", { name: "No", exact: true }).click(); await art.getByRole("button", { name: "Wrong source", exact: true }).click(); await page.waitForTimeout(200);
  R.fbEffect = await art.locator('[role="status"]').first().innerText();
  await art.getByRole("button", { name: "Ask again", exact: true }).click(); await page.waitForTimeout(400);
  const art2 = answer(page); const after = await art2.locator('section[aria-label="Sources"] button').allInnerTexts();
  await art2.getByText("Show your work").click(); await page.waitForTimeout(150);
  const steps = await art2.locator('ol[aria-label="Steps"]').innerText();
  R.loop = { label1: r.label, before, after, applied: /Applied earlier feedback/.test(steps) };
  if (!R.loop.applied) throw new Error("feedback not applied: " + steps.slice(0, 200));
  await shot(page, "03-learning-loop");
});
await step("add a document: sample report", async () => {
  await page.getByRole("tab", { name: "Data", exact: true }).click(); await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Add a document", exact: true }).click();
  const d = page.getByRole("dialog");
  await d.waitFor({ timeout: 10000 });
  // A build offers the sample only when a redistributable PDF sits in app/src/assets/sample/; this edition ships none.
  if (!(await page.getByRole("button", { name: "Try the sample report" }).count())) {
    R.ingest = { skipped: "no bundled sample document" }; await shot(page, "04-ingest-dialog"); await closeDialogs(page); return;
  }
  await page.getByRole("button", { name: "Try the sample report" }).click();
  await d.getByText("Pages read").waitFor({ timeout: 90000 }); await page.waitForTimeout(300);
  R.ingest = { metrics: (await d.locator("dl").first().innerText()).replace(/\n/g, " | "), names: await d.getByRole("heading", { name: /Names found/ }).innerText(),
    places: await d.getByRole("heading", { name: /^Places/ }).innerText(), struggled: await d.getByRole("heading", { name: /Where it struggled/ }).innerText(),
    namesTable: (await d.locator('table').first().innerText().catch(() => "")).slice(0, 900), placesList: (await d.locator('section[aria-label="Places"]').innerText()).slice(0, 900),
    failures: (await d.locator('section[aria-label="What failed"]').innerText()).slice(0, 900), proposed: (await d.locator('section[aria-label="New names for review"]').innerText().catch(() => "none")).slice(0, 500) };
  await shot(page, "04-ingest");
  await d.getByRole("button", { name: "Ask about it" }).click(); await page.waitForTimeout(500);
  const art = answer(page); const text = await art.innerText(); R.ingestAsk = text.slice(0, 500);
  if (!/ZeroGen|DP-1|data evaluation/i.test(text)) throw new Error("answer did not cite the added document");
  await shot(page, "05-ingest-answer");
});
await step("knowledge click-through and lineage", async () => {
  await page.getByRole("tab", { name: "Knowledge" }).click(); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /^Basin:/ }).click(); await page.getByRole("menuitem", { name: "Cooper Basin" }).click(); await page.waitForTimeout(600);
  await page.locator('a[aria-label^="Patchawarra Formation:"]').first().click(); await page.waitForTimeout(600); await shot(page, "06-entity-card");
  await page.getByRole("button", { name: "Where did this come from?" }).click(); await page.waitForTimeout(500); await shot(page, "07-lineage"); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  for (const t of ["Graph", "Schema", "Curation"]) { await page.getByRole("tab", { name: t }).click(); await page.waitForTimeout(350); }
  await shot(page, "08-curation");
});
await step("look-alike image search", async () => {
  await page.getByRole("tab", { name: "Images" }).click(); await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Find similar" }).nth(3).click(); await page.getByText(/Ranked by colour and texture/).waitFor({ timeout: 30000 }); await shot(page, "09-images");
});
await step("Co-Scientist prepared and typed", async () => {
  await page.getByRole("tab", { name: "Co-Scientist" }).click(); await page.waitForTimeout(400);
  await page.getByRole("button", { name: /same-age counterparts/ }).first().click(); await page.waitForTimeout(2500);
  R.literature = (await page.locator('ol[aria-label="Agents"] li').first().innerText()).replace(/\n/g, " | ");
  await shot(page, "10-cosci-rift");
  await page.getByLabel("Or write your own statement").fill("The Patchawarra Formation in the Cooper Basin is a fluvial sandstone reservoir");
  await page.getByRole("button", { name: "Run the agents" }).click(); await page.waitForTimeout(2500); await shot(page, "11-cosci-typed");
});
await step("roles, section, low-carbon", async () => {
  await page.getByRole("button", { name: /^Role:/ }).click(); await page.getByRole("menuitem", { name: L.cs }).click(); await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Section west to east across the Cooper Basin" }).click(); await page.waitForTimeout(1500); await shot(page, "12-section");
  await page.locator('section[aria-label="Cross-section"]').getByRole("button", { name: "Close the section" }).click(); await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Role:/ }).click(); await page.getByRole("menuitem", { name: /Low-carbon/ }).click(); await page.waitForTimeout(1200); await shot(page, "13-lowcarbon");
  await page.getByRole("button", { name: /^Role:/ }).click(); await page.getByRole("menuitem", { name: /Exploration geoscientist/ }).click(); await page.waitForTimeout(500);
});
await step("draw an area: what we know inside it", async () => {
  // Corners around Innamincka and Marabooka at the home view (centre 144.9 E, 24.4 S, canvas zoom 5.45).
  await page.getByRole("button", { name: "Reset view" }).click(); await page.waitForTimeout(1300);
  const b = await page.locator("#basin-map-canvas").boundingBox(); const W = 256 * 2 ** 5.45;
  const X = (lon) => ((lon + 180) / 360) * W, Y = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * W;
  const at = ([lon, lat]) => [b.x + b.width / 2 + X(lon) - X(144.9), b.y + b.height / 2 + Y(lat) - Y(-24.4)];
  const corners = [[139.8, -28.8], [141.6, -28.8], [141.6, -26.9], [139.8, -26.9]];
  await page.getByRole("button", { name: "Draw an area" }).click();
  const banner = page.locator("[data-gbx-area-banner]"); await banner.waitFor({ timeout: 3000 });
  for (const c of corners) { const [x, y] = at(c); await page.mouse.click(x, y); await page.waitForTimeout(150); }
  await banner.getByRole("button", { name: "Undo" }).click(); await page.waitForTimeout(150);
  { const [x, y] = at(corners[3]); await page.mouse.click(x, y); await page.waitForTimeout(150); }
  if (!/click the first corner, to finish/.test(await banner.innerText())) throw new Error(`banner: ${await banner.innerText()}`);
  await shot(page, "13a-area-drawing");
  { const [x, y] = at(corners[0]); await page.mouse.click(x, y); }
  const card = page.locator('section[aria-labelledby="area-h"]'); await card.waitFor({ timeout: 5000 });
  const t = await card.innerText(); R.area = t.slice(0, 700);
  const n = Number((/Boreholes inside\s*\n?\s*([\d,]+)/.exec(t)?.[1] ?? "0").replace(/,/g, ""));
  if (!(n > 50) || !/in the Cooper Basin/.test(t) || !/Depth to basin floor\s*\n?\s*[\d,]+ to [\d,]+ m/.test(t)) throw new Error(t.slice(0, 400));
  if (!(await card.getByRole("button", { name: /Marabooka 1 scanned report/ }).count())) throw new Error("no Marabooka 1 report offered inside the area");
  const hl = card.getByRole("button", { name: /^Highlight the [\d,]+ boreholes$/ }); await hl.click();
  if ((await card.getByRole("button", { name: "Clear the highlight" }).getAttribute("aria-pressed")) !== "true") throw new Error("highlight didn't toggle");
  await shot(page, "13b-area");
  await card.getByRole("button", { name: "Clear the highlight" }).click();
  await card.getByRole("button", { name: "Close what we know in this area" }).click();
  if (await card.count()) throw new Error("the area card didn't close");
  // A double-click on the first corner closes the area once; its second click mustn't open "What we know here".
  await page.getByRole("button", { name: "Draw an area" }).click();
  for (const c of corners) { const [x, y] = at(c); await page.mouse.click(x, y); await page.waitForTimeout(150); }
  { const [x, y] = at(corners[0]); await page.mouse.dblclick(x, y); }
  await card.waitFor({ timeout: 5000 }); await page.waitForTimeout(900);
  if (await page.locator('section[aria-labelledby="here-h"]').count()) throw new Error("the double-click's second click opened What we know here");
  if (!(await card.count())) throw new Error("the area closed after a double-click on its first corner");
  await card.getByRole("button", { name: "Close what we know in this area" }).click();
  R.areaBoreholes = n;
});
await step("data sheet: loading and governance", async () => {
  await page.getByRole("tab", { name: "Data", exact: true }).click(); await page.waitForTimeout(400);
  await page.getByRole("tab", { name: "Loading" }).click(); await page.waitForTimeout(500);
  R.addedRow = (await page.getByRole("heading", { name: "Documents you added this session" }).locator("..").innerText({ timeout: 5000 }).catch(() => "none")).slice(0, 400); await shot(page, "14-loading");
  await page.getByRole("tab", { name: "Governance" }).click(); await page.waitForTimeout(400);
  R.fbList = (await page.getByRole("heading", { name: /Learning from your feedback/ }).innerText()); await shot(page, "15-governance"); await closeDialogs(page);
});
await step("How it's built switch", async () => {
  await page.getByRole("button", { name: /^More/ }).click(); await page.getByRole("menuitemcheckbox", { name: /How it's built/ }).click(); await page.waitForTimeout(400); await shot(page, "16-how-built");
  await page.getByRole("button", { name: /^More/ }).click(); await page.getByRole("menuitemcheckbox", { name: /How it's built/ }).click(); await page.waitForTimeout(200);
});
await step("live test run", async () => {
  await page.getByRole("tab", { name: "Evaluate" }).click(); await page.waitForTimeout(300);
  await page.getByRole("button", { name: /^Run all \d+ questions/ }).click();
  await page.getByText(/questions in \d+ ms\./).waitFor({ timeout: 60000 }); R.testRun = await page.locator('p[role="status"]', { hasText: /questions in \d+ ms\./ }).first().innerText(); await shot(page, "17-test-run");
  // The learning-loop step voted "Wrong source" earlier, so the run must say that feedback was re-ranking answers.
  const note = page.getByText(/re-ranking answers in this browser/); if (!(await note.count())) throw new Error("no feedback note after a Wrong source vote"); R.testRunNote = await note.first().innerText();
});
await step("guided tour, every step", async () => {
  await page.getByRole("button", { name: L.start }).click();
  const tour = page.locator('section[aria-labelledby="track-h"]');
  // The tour's length depends on the sources a build carries, so the test reads it from the tour itself.
  await page.getByText(L.step(1)).waitFor({ timeout: 5000 });
  const total = Number(/step 1 of (\d+)/.exec(await page.getByText(L.step(1)).first().innerText())?.[1] ?? 0);
  if (!(total >= 5)) throw new Error(`the tour has ${total} steps`);
  R.tourSteps = total;
  for (let n = 1; n <= total; n++) {
    await page.getByText(L.step(n)).waitFor({ timeout: 5000 });
    const tries = tour.getByRole("button").filter({ hasText: /Ask:|Open|What we know|Show|Rank|Test:|Run/ });
    const c = await tries.count();
    for (let i = 0; i < c; i++) { await tries.nth(i).click(); await page.waitForTimeout(700); await closeDialogs(page); }
    if (n === 3 || n === 5) await shot(page, `18-track-${n}`);
    if (n < total) await tour.getByRole("button", { name: "Next" }).click();
  }
  await page.waitForTimeout(1500);
});
await step("export to Excel", async () => {
  await page.getByRole("tab", { name: "Evaluate" }).click(); await page.getByLabel("Reviewer name").fill("Smoke Test");
  await page.locator("#q-Q03").getByRole("button", { name: "Correct" }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export to Excel" }).first().click()]);
  if (!L.prefix.test(dl.suggestedFilename())) throw new Error("name " + dl.suggestedFilename());
  await dl.saveAs(path.join(OUT, "export.xlsx")); R.exportName = dl.suggestedFilename();
});
await ctx.close();
await step("deep link and reset (no role picker)", async () => {
  const { ctx, page } = await newPage(); await page.goto(URL + "#ex=5"); await page.getByText(L.step(5)).waitFor({ timeout: 30000 });
  if (await page.getByRole("dialog", { name: /Who's exploring today/ }).count()) throw new Error("role picker blocked the deep link");
  await page.getByRole("button", { name: L.reset }).click(); await page.getByText(L.step(1)).waitFor({ timeout: 5000 }); await ctx.close();
});
await step("fresh browser test run matches the published numbers", async () => {
  const { ctx, page } = await newPage(); await page.goto(URL); await pickRole(page);
  await page.getByRole("tab", { name: "Evaluate" }).click(); await page.waitForTimeout(300);
  await page.getByRole("button", { name: /^Run all \d+ questions/ }).click();
  await page.getByText(/questions in \d+ ms\./).waitFor({ timeout: 60000 }); R.testRunClean = await page.locator('p[role="status"]', { hasText: /questions in \d+ ms\./ }).first().innerText();
  if (await page.getByText(/re-ranking answers in this browser/).count()) throw new Error("feedback note in a fresh browser");
  await shot(page, "17b-test-run-clean"); await ctx.close();
  if (!/Expected source cited: (\d+) of \1\b/.test(R.testRunClean)) throw new Error("clean run: " + R.testRunClean);
});
await step("storage blocked", async () => {
  const { ctx, page } = await newPage({}, () => { Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } }); });
  await page.goto(URL); await pickRole(page); const r = await ask(page, "How deep is the Taroom Trough?"); if (!r.ok) throw new Error("answer failed"); await ctx.close();
});
// The copilot talks back with an on-device voice and can take a spoken question. Speech is stubbed here, so the test
// proves the wiring (typed and spoken questions, cited replies, read aloud, keyboard close) without audio or network.
await step("copilot: typed and spoken questions, cited replies, read aloud", async () => {
  const { ctx, page } = await newPage({}, () => {
    window.__spoken = [];
    try {
      window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.lang = ""; this.voice = null; this.onend = null; this.onerror = null; } };
      const voices = [{ name: "On-device English (test)", lang: "en-AU", localService: true, default: true, voiceURI: "test-local" }];
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speaking: false, pending: false, paused: false, getVoices: () => voices,
        speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend({}), 20); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} } });
      class FakeRecognition {
        start() { setTimeout(() => { const alt = [{ transcript: "How deep is the Taroom Trough?" }]; alt.isFinal = true; this.onresult && this.onresult({ resultIndex: 0, results: [alt] }); this.onend && this.onend(); }, 60); }
        stop() { this.onend && this.onend(); } abort() {}
      }
      window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
    } catch (e) { window.__stubError = String(e); }
  });
  await page.goto(URL); await pickRole(page);
  const panel = dockOf(page); await panel.waitFor({ timeout: 5000 });
  if ((await page.locator("#gbx-copilot-toggle").getAttribute("aria-expanded")) !== "true") throw new Error("the copilot is not docked open at 1440 px");
  const box = panel.getByLabel("Message the exploration copilot");
  await box.fill("What is the SHmax orientation in the Cooper Basin?"); await box.press("Enter");
  const reply = panel.locator('[data-copilot="reply"]').first(); await reply.waitFor({ timeout: 15000 });
  if (!(await reply.locator('[data-copilot="source"]').count())) throw new Error("typed reply has no source");
  R.copilotTyped = (await reply.innerText()).replace(/\n/g, " | ").slice(0, 400);
  await reply.getByRole("button", { name: "Read aloud" }).click(); await page.waitForTimeout(200);
  if ((await page.evaluate(() => window.__spoken.length)) < 1) throw new Error("reply was not read aloud");
  const show = reply.getByRole("button", { name: "Show on map" }); R.copilotShowOnMap = await show.count(); if (R.copilotShowOnMap) { await show.click(); await page.waitForTimeout(300); }
  await panel.getByRole("button", { name: "Speak a question" }).click();
  await panel.getByRole("button", { name: "Turn on voice input" }).click();
  await panel.locator('[data-copilot="reply"]').nth(1).waitFor({ timeout: 15000 }); await page.waitForTimeout(250);
  const asked = await panel.locator('[data-copilot="user"]').last().innerText(); if (!/Taroom/i.test(asked)) throw new Error("voice transcript was not asked: " + asked);
  const spoken = await page.evaluate(() => window.__spoken); R.copilotVoice = { asked, stubError: await page.evaluate(() => window.__stubError ?? null), spoken: spoken.map((s) => s.slice(0, 180)) };
  if (spoken.length < 2) throw new Error("the spoken question was not answered aloud");
  await panel.locator('[data-copilot="reply"]').first().getByRole("button", { name: "Open full answer" }).click(); await page.waitForTimeout(300);
  if (!(await page.getByRole("complementary", { name: "Answers" }).locator('article[aria-label^="Answer:"]').count())) throw new Error("Open full answer did not show the answer in the side panel");
  // Follow-ups that start with "Open" are actions: they must open the right view, never be asked as questions.
  await box.fill("What was the DST 10 shut-in pressure in Innamincka 1?"); await box.press("Enter");
  await panel.locator('[data-copilot="reply"]').nth(2).waitFor({ timeout: 15000 }); await page.waitForTimeout(150);
  const openEv = panel.getByRole("button", { name: /^Open .* evidence$/ }); R.copilotFollowAction = await openEv.count();
  if (R.copilotFollowAction) {
    const before = await panel.locator('[data-copilot="reply"]').count(); await openEv.first().click(); await page.waitForTimeout(400);
    if ((await panel.locator('[data-copilot="reply"]').count()) !== before) throw new Error("an Open follow-up was sent to the engine as a question");
    if (!(await page.getByRole("complementary", { name: "Evidence" }).count())) throw new Error("Open evidence did not open the Evidence panel");
  }
  // One assistant: a question asked from the scorecard joins the same conversation.
  const before = await panel.locator('[data-copilot="reply"]').count();
  await page.getByRole("tab", { name: "Evaluate" }).click(); await page.waitForTimeout(300);
  await page.locator("#q-Q01").getByRole("button", { name: "Ask", exact: true }).click(); await page.waitForTimeout(400);
  if ((await panel.locator('[data-copilot="reply"]').count()) !== before + 1) throw new Error("a scorecard question did not join the copilot conversation");
  R.copilotContext = (await panel.getByRole("region", { name: "Context" }).innerText()).replace(/\n/g, " | ");
  if (!/evaluate/i.test(R.copilotContext)) throw new Error("copilot context did not follow the workspace: " + R.copilotContext);
  await shot(page, "22-copilot");
  await box.focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(250);
  if (await page.getByRole("complementary", { name: "Exploration copilot" }).count()) throw new Error("Escape did not close the copilot");
  if (!(await page.getByRole("button", { name: "Open the exploration copilot" }).evaluate((el) => el === document.activeElement))) throw new Error("focus did not return to the copilot button");
  await ctx.close();
});
// The copilot and the side panel are resized by dragging their inner edge, or with the arrow keys, Home and End once the
// edge has focus. The workspace keeps at least 440 px, the width is remembered, and a double-click puts the default back.
await step("panels: drag and keyboard resizing, remembered, reset", async () => {
  const { ctx, page } = await newPage(); await page.goto(URL); await pickRole(page);
  const width = (sel) => page.locator(sel).evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const drag = async (handle, dx) => { const b = await handle.boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2; await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150); };
  const edge = page.getByRole("separator", { name: "Resize the copilot" });
  const before = { copilot: await width("#gbx-copilot"), stage: await width("#gbx-stage") };
  if (before.copilot !== 380) throw new Error(`the docked copilot starts at ${before.copilot} px, not 380`);
  await drag(edge, -200); const dragged = { copilot: await width("#gbx-copilot"), stage: await width("#gbx-stage") };
  if (dragged.copilot !== 580 || dragged.stage !== before.stage - 200) throw new Error(`dragging the edge 200 px to the left gave ${JSON.stringify(dragged)}`);
  await edge.focus(); await page.keyboard.press("ArrowLeft"); if ((await width("#gbx-copilot")) !== 596) throw new Error("ArrowLeft did not widen the copilot by 16 px");
  await page.keyboard.press("End"); const widest = { copilot: await width("#gbx-copilot"), stage: await width("#gbx-stage") };
  if (widest.stage !== 440) throw new Error(`End left the workspace at ${widest.stage} px, not 440`);
  if (!(await page.locator("#gbx-copilot").count())) throw new Error("a resizing key closed the copilot");
  await page.reload(); await page.locator("#gbx-copilot").waitFor({ timeout: 30000 }); await page.waitForTimeout(300);
  if ((await width("#gbx-copilot")) !== widest.copilot) throw new Error("the copilot width was not remembered");
  await edge.dblclick(); await page.waitForTimeout(150); if ((await width("#gbx-copilot")) !== 380) throw new Error("a double-click did not put the copilot back to 380 px");
  await page.getByRole("button", { name: "Evidence" }).click(); await page.getByRole("complementary", { name: "Evidence" }).waitFor({ timeout: 5000 });
  await drag(page.getByRole("separator", { name: "Resize the side panel" }), 150);
  if ((await width("#gbx-side")) !== 550) throw new Error(`the side panel is ${await width("#gbx-side")} px after dragging its edge 150 px`);
  await edge.focus(); await page.keyboard.press("End");
  R.panelResize = { before, dragged, widest, both: { side: await width("#gbx-side"), copilot: await width("#gbx-copilot"), stage: await width("#gbx-stage") } };
  if (R.panelResize.both.stage !== 440) throw new Error(`with both panels open, End left the workspace at ${R.panelResize.both.stage} px, not 440`);
  await shot(page, "23-panels-resized"); await ctx.close();
});
// "What we know here" opens in a window on the map. Its header or grip moves it and its edges and corner resize it; the
// grip and the corner also take the arrow keys, and the corner Home and End. The page remembers it, a double-click puts
// it back where it docks, and it never leaves the map.
await step("map window: move, resize, keys, remembered, reset, kept inside", async () => {
  const { ctx, page } = await newPage(); await page.goto(URL); await pickRole(page);
  const win = page.locator("[data-gbx-map-window]"), card = page.locator('section[aria-labelledby="here-h"]'), roleCard = page.locator('section[aria-labelledby="lens-h"]');
  const open = async () => {
    await page.getByRole("tab", { name: "Map" }).click(); const b = await page.locator("#basin-map-canvas").boundingBox();
    for (let i = 0; i < 3 && !(await card.count()); i++) { await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(900); }
    await card.waitFor({ timeout: 5000 }); await page.waitForTimeout(300);
  };
  const rect = () => win.evaluate((el) => { const s = el.closest("#gbx-stage").getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), w: Math.round(r.width), h: Math.round(r.height), sw: Math.round(s.width), sh: Math.round(s.height) }; });
  const press = async (handle) => { const b = await handle.boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2; await page.mouse.move(x, y); await page.mouse.down(); return [x, y]; };
  const release = async (x, y) => { await page.mouse.move(x, y, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(200); };
  const drag = async (handle, dx, dy) => { const [x, y] = await press(handle); await release(x + dx, y + dy); };
  const same = (a, b, keys = ["x", "y", "w", "h"]) => keys.every((k) => a[k] === b[k]);
  // With the role card open at the top left the window docks on the right, beside the map's controls, as the card always
  // has; without it, at the top left.
  await open(); const right = await rect(), top = right.y;
  if (!(await roleCard.count()) || right.x !== right.sw - 56 - 380 || right.w !== 380) throw new Error(`with the role card open, the window opened at ${JSON.stringify(right)}, not docked on the right 380 px wide`);
  const docked = async () => ((await roleCard.count()) ? { x: right.sw - 56 - 380, y: top, w: 380 } : { x: 12, y: top, w: 380 });
  await roleCard.getByRole("button", { name: "Close the role card" }).click(); await page.waitForTimeout(300); const dock = await rect();
  if (!same(dock, { x: 12, y: top, w: 380 }, ["x", "y", "w"])) throw new Error(`with the role card closed, the window docked at ${JSON.stringify(dock)}, not at the top left`);
  const grip = page.getByRole("button", { name: "Move What we know here" }), corner = page.getByRole("button", { name: "Resize What we know here" });
  await drag(grip, 240, 60); const moved = await rect();
  if (moved.x !== dock.x + 240 || moved.y !== dock.y + 60 || moved.w !== dock.w) throw new Error(`dragging the grip by 240, 60 moved the window from ${JSON.stringify(dock)} to ${JSON.stringify(moved)}`);
  if (await page.evaluate(() => document.documentElement.dataset.gbxDrag)) throw new Error("the page stayed in drag mode after the drag ended");
  await drag(card.getByRole("heading", { name: "What we know here" }), -40, -20); const byHeader = await rect();
  if (byHeader.x !== moved.x - 40 || byHeader.y !== moved.y - 20) throw new Error(`dragging the header by -40, -20 gave ${JSON.stringify(byHeader)}`);
  await corner.focus(); await page.keyboard.press("End"); const largest = await rect();
  if (largest.x !== byHeader.x || largest.y !== byHeader.y || largest.x + largest.w !== largest.sw - 8 || largest.y + largest.h !== largest.sh - 8) throw new Error(`End on the corner gave ${JSON.stringify(largest)}`);
  await page.keyboard.press("Home"); const smallest = await rect();
  if (smallest.w !== 300 || smallest.h !== 220) throw new Error(`Home on the corner gave ${smallest.w} by ${smallest.h}, not 300 by 220`);
  await drag(corner, 100, 40); const resized = await rect();
  if (resized.w !== 400 || resized.h !== 260 || resized.x !== smallest.x || resized.y !== smallest.y) throw new Error(`dragging the corner by 100, 40 gave ${JSON.stringify(resized)}`);
  await drag(win.locator('[data-window-edge="w"]'), -50, 0); const wider = await rect();
  if (wider.x !== resized.x - 50 || wider.w !== resized.w + 50 || wider.h !== resized.h) throw new Error(`dragging the left edge by -50 gave ${JSON.stringify(wider)}`);
  await corner.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowDown"); const keyed = await rect();
  if (keyed.w !== wider.w + 16 || keyed.h !== wider.h + 16) throw new Error(`ArrowRight and ArrowDown on the corner gave ${keyed.w} by ${keyed.h}`);
  await grip.focus(); await page.keyboard.press("Shift+ArrowLeft"); const nudged = await rect();
  if (nudged.x !== keyed.x - 64 || nudged.y !== keyed.y) throw new Error(`Shift+ArrowLeft on the grip gave ${JSON.stringify(nudged)}`);
  // Mid-drag the window follows the pointer before the page renders it again.
  { const [x, y] = await press(grip); await page.mouse.move(x + 30, y + 30, { steps: 4 }); await page.waitForTimeout(100); const mid = await rect(); await release(x, y);
    if (mid.x !== nudged.x + 30 || mid.y !== nudged.y + 30) throw new Error(`mid-drag the window was at ${JSON.stringify(mid)}`);
    if (!same(await rect(), nudged)) throw new Error("dragging back to the start did not leave the window where it was"); }
  await shot(page, "24-map-window-moved");
  await page.reload(); await page.locator("#basin-map-canvas").waitFor({ timeout: 30000 }); await page.waitForTimeout(1500);
  await open(); const remembered = await rect();
  if (!same(remembered, nudged)) throw new Error(`after a reload the window opened at ${JSON.stringify(remembered)}, not ${JSON.stringify(nudged)}`);
  await grip.dblclick(); await page.waitForTimeout(200); const reset = await rect(), home = await docked();
  if (!same(reset, home, ["x", "y", "w"])) throw new Error(`a double-click on the grip put the window at ${JSON.stringify(reset)}, not where it docks ${JSON.stringify(home)}`);
  { const [x, y] = await press(grip); await release(1435, 895); }
  const far = await rect();
  if (far.x < 8 || far.y < top || far.x + far.w > far.sw - 8 || far.y + far.h > far.sh - 8) throw new Error(`dragged past the map's corner, the window left the map: ${JSON.stringify(far)}`);
  await card.getByRole("button", { name: "Close what we know here" }).click();
  if (await win.count()) throw new Error("closing the card left its window open");
  R.mapWindow = { right, dock, moved, largest, resized, keyed, remembered, reset, far };
  await ctx.close();
});
// Readability: dark mode, zoom and screen sizes
const contrast = () => {
  // Colours are resolved through a canvas so oklab/oklch and alpha (Tailwind v4) are read correctly, then composited.
  const cx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (el) => { const layers = []; while (el) { const c = rgba(getComputedStyle(el).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } el = el.parentElement; } let base = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const out = []; for (const el of document.querySelectorAll("main p, main li, main h2, main h3, main span, main button")) {
    if (!el.offsetParent || !el.textContent.trim() || el.children.length > 3) continue; const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
    const bg = bgOf(el); const fg = over(rgba(getComputedStyle(el).color), bg); const a = lum(fg), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 3) out.push({ text: el.textContent.trim().slice(0, 50), ratio: Math.round(ratio * 10) / 10, fg: fg.map(Math.round).join(","), bg: bg.map(Math.round).join(",") });
  }
  return { body: getComputedStyle(document.body).backgroundColor, low: out.slice(0, 12), nLow: out.length };
};
for (const [label, opts] of [["dark-1536@125", { colorScheme: "dark", viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 }], ["1366", { viewport: { width: 1366, height: 768 } }], ["1920", { viewport: { width: 1920, height: 1080 } }]]) {
  await step(`layout ${label}`, async () => {
    const { ctx, page } = await newPage(opts); await page.goto(URL); await pickRole(page);
    await page.getByRole("tab", { name: "Co-Scientist" }).click(); await page.waitForTimeout(300);
    await page.getByRole("button", { name: /same-age counterparts/ }).first().click(); await page.waitForTimeout(2600);
    const bar = await page.getByRole("group", { name: "Workspace tools" }).boundingBox(); const head = await page.getByRole("heading", { name: /Test a geological hypothesis/ }).boundingBox();
    const ws = await page.getByRole("tablist", { name: "Workspaces" }).boundingBox();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const c = await page.evaluate(contrast);
    R[`layout_${label}`] = { headBelowBar: head && bar ? Math.round(head.y - (bar.y + bar.height)) : null, workspaceBarRows: ws ? Math.round(ws.height) : null, docked: await page.locator("#gbx-copilot").count(), hOverflow: over, body: c.body, lowContrast: c.nLow, examples: c.low.slice(0, 5) };
    await shot(page, `20-${label}-cosci`);
    await page.getByRole("tab", { name: "Map" }).click(); await page.waitForTimeout(600); await shot(page, `21-${label}-map`);
    await ctx.close();
  });
}
await browser.close();
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ log, errors, network, R }, null, 1));
console.log(log.join("\n"));
console.log(`page errors: ${errors.length}${errors.length ? "\n  " + [...new Set(errors)].slice(0, 8).join("\n  ") : ""}`);
console.log(`network requests attempted: ${network.length}`);
console.log(`screenshots and results: ${OUT}`);
process.exit(failed || errors.length || network.length ? 1 : 0);
