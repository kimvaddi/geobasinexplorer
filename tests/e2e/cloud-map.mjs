// Operator check for the cloud map (Azure Maps) and the GDAL/PROJ spatial service.
//   GBX_TOKEN=$(az account get-access-token --scope api://<site app id>/.default --query accessToken -o tsv) \
//     node tests/e2e/cloud-map.mjs https://<your-site>
// The token (the Azure CLI is an allowed client of the sign-in app) is added only to requests for the app's own origin,
// never to Azure Maps. With `--local app/dist-cloud` it serves the cloud build on localhost and forwards /api to the
// live site; because the Maps account's CORS rule admits only the production origin, that local run starts Chromium
// without cross-origin checks, so CORS itself is only proven by the run against the live site.
// It checks that the base map and data layers load with no CSP violations or page errors, that "What we know here"
// and the preset Cooper section come back from GDAL/PROJ, that "Sources near here" and questions asked about the place
// use the Azure AI Search geo fields, the point's own figures and, for a question about another basin, the whole library
// (three questions are asked, which count against the daily caps), that the
// base map can be switched, and, when the deployment has an Esri key, that the Esri base maps load through the app's
// relay with their credits and that the Planetary Computer overlays draw over them, and only over them, with their
// licensors' notices; and that an area drawn on the map, on Azure Maps and on Esri, lists what lies inside it, from the
// browser, Azure AI Search and Planetary Computer Pro. Screenshots are saved.
//   env: PLAYWRIGHT_MODULE (default: playwright), CHROME_PATH (optional)
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const TOKEN = process.env.GBX_TOKEN;
if (!TOKEN) { console.error("Set GBX_TOKEN (see the header of this file)."); process.exit(2); }
const LIVE = process.env.GBX_SITE_URL ?? "https://localhost:8080";
const args = process.argv.slice(2);
const local = args[0] === "--local" ? path.resolve(args[1] ?? "app/dist-cloud") : null;
let base = local ? "" : (args[0] ?? LIVE).replace(/\/+$/, "");

// Same policy as services/api/src/server.ts, so the local run exercises it too.
const ATLAS = "https://atlas.microsoft.com https://*.atlas.microsoft.com";
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", `img-src 'self' data: blob: ${ATLAS}`, `font-src 'self' data: ${ATLAS}`, `connect-src 'self' ${ATLAS} data: blob:`, "worker-src 'self' blob:", "child-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
let server = null;
if (local) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".jpg": "image/jpeg" };
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      const headers = { ...req.headers, host: new URL(LIVE).host, authorization: `Bearer ${TOKEN}` };
      delete headers.cookie; delete headers.origin; delete headers.referer;
      const up = https.request({ hostname: new URL(LIVE).host, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
      req.pipe(up);
      return;
    }
    let f = path.join(local, decodeURIComponent(req.url.split("?")[0]));
    if (!f.startsWith(local) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(local, "index.html");
    res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream", "content-security-policy": CSP });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-cloud-map-"));
const browser = await chromium.launch({ headless: true, args: local ? ["--disable-web-security"] : [], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
if (!local) await ctx.route(`${base}/**`, (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${TOKEN}` } }));
await ctx.addInitScript(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
const page = await ctx.newPage();
const R = { pageErrors: [], consoleErrors: [], atlas: {}, checks: [] };
page.on("pageerror", (e) => R.pageErrors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") R.consoleErrors.push(m.text().slice(0, 300)); });
page.on("response", (r) => { const u = new URL(r.url()); if (u.hostname.endsWith("atlas.microsoft.com")) { const k = `${u.hostname}${u.pathname.split("/").slice(0, 3).join("/")} ${r.status()}`; R.atlas[k] = (R.atlas[k] ?? 0) + 1; } });
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); R.checks.push({ name, ok: true, ms: Date.now() - t, detail }); console.log(`ok   ${name} (${Date.now() - t} ms)${detail ? ` ${detail}` : ""}`); }
  catch (e) { R.checks.push({ name, ok: false, error: String(e).slice(0, 400) }); console.log(`FAIL ${name}: ${String(e).slice(0, 400)}`); await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {}); }
}
const mapBox = async () => page.locator('[data-gbx-map="azure"]').boundingBox();
// Pixel position of a point while the map shows the home view (centre 144.9 E, 24.4 S, Azure Maps zoom 4.45).
const W = 512 * 2 ** 4.45, mx = (lon) => ((lon + 180) / 360) * W, my = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * W;
const at = async (lon, lat) => { const b = await mapBox(); return { x: b.x + b.width / 2 + mx(lon) - mx(144.9), y: b.y + b.height / 2 + my(lat) - my(-24.4) }; };
const home = async () => { await page.getByRole("button", { name: "Reset view" }).click(); await page.waitForTimeout(2200); };

await check("app loads behind sign-in and the role picker opens", async () => {
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  const d = page.getByRole("dialog", { name: /Who's exploring today/ }); await d.waitFor({ timeout: 45000 });
  await d.getByRole("button", { name: /^Start as exploration geoscientist$/i }).click(); await page.waitForTimeout(500);
});
await check("Azure Maps draws the base map and the basin layers", async () => {
  await page.waitForFunction(() => { const c = document.querySelector('[data-gbx-map="azure"] canvas'); return !!c && c.getBoundingClientRect().height > 200; }, null, { timeout: 30000 });
  await page.waitForTimeout(6000); await home(); await page.waitForTimeout(1500); await shot("01-azure-map");
  const ok = Object.entries(R.atlas).filter(([k]) => k.endsWith(" 200")).reduce((n, [, v]) => n + v, 0);
  const bad = Object.entries(R.atlas).filter(([k]) => !/ 20\d$| 304$/.test(k));
  if (!ok) throw new Error(`no Azure Maps responses: ${JSON.stringify(R.atlas)}`);
  if (bad.length) throw new Error(`Azure Maps errors: ${JSON.stringify(bad)}`);
  // Basin names must all show at the home view, and well names must not compete with them there.
  const labels = await page.locator('[data-gbx-map="azure"]').evaluate((el) => ({ basins: el.dataset.gbxBasinLabels ?? "", wells: el.dataset.gbxWellLabels ?? "" }));
  const missing = ["ADAVALE", "COOPER", "GALILEE", "NORTH BOWEN"].filter((b) => !labels.basins.split("|").includes(b));
  if (missing.length) throw new Error(`basin names missing at the home view: ${missing.join(", ")} (rendered: ${labels.basins || "none"})`);
  if (labels.wells) throw new Error(`well names shown at the home view, where they compete with basin names: ${labels.wells}`);
  return `${ok} Azure Maps responses, all successful; basin names ${labels.basins.replaceAll("|", ", ")}`;
});
await check("What we know here comes back from the spatial service", async () => {
  const p = await at(140.75, -27.8); await page.mouse.click(p.x, p.y);
  const card = page.locator('section[aria-labelledby="here-h"]'); await card.waitFor({ timeout: 15000 });
  await card.getByText("Position in GDA2020 and MGA").waitFor({ timeout: 20000 }); await page.waitForTimeout(500); await shot("02-here");
  const t = await card.innerText(); const m = /In GDA2020 this point is .*? ([\d.]+) m from its GDA94 position/.exec(t);
  if (!/Distances are geodesic/.test(t) || !m) throw new Error(t.slice(0, 400));
  return `GDA2020 shift ${m[1]} m; ${/MGA zone \d+/.exec(t)?.[0]}`;
});
await check("Sources near here come from the Azure AI Search geo fields", async () => {
  const card = page.locator('section[aria-labelledby="here-h"]');
  const near = card.locator('section[aria-label="Sources near here"]');
  await near.locator("li").first().waitFor({ timeout: 20000 }); await near.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await shot("06-sources-near");
  const t = await near.innerText();
  const n = /([\d,]+) passages? within 50 km, and ([\d,]+) more about the Cooper Basin as a whole/.exec(t);
  if (!n || !/Found by Azure AI Search/.test(t)) throw new Error(t.slice(0, 400));
  return `${await near.locator("li").count()} sources listed; ${n[1]} passages within 50 km and ${n[2]} about the Cooper Basin as a whole`;
});
await check("the copilot answers about the place, near it first, and says when it looks further", async () => {
  const card = page.locator('section[aria-labelledby="here-h"]');
  const depth = (await card.locator("dt", { hasText: "Depth to basin floor" }).locator("xpath=following-sibling::dd").innerText()).trim();
  await card.getByRole("button", { name: "Ask about this place" }).click();
  const chip = page.locator("#gbx-copilot").getByText(/use what we know here and sources geotagged within 50 km/); await chip.waitFor({ timeout: 5000 });
  const box = page.getByRole("textbox", { name: "Message the exploration copilot" });
  // the copilot moves focus to its question box on the next frame
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Message the exploration copilot", null, { timeout: 3000 })
    .catch(() => { throw new Error("the question box didn't take focus"); });
  const ask = async (q) => {
    await box.fill(q);
    const reply = page.waitForResponse((r) => r.url().endsWith("/api/ask") && r.request().method() === "POST", { timeout: 120000 });
    await page.locator("#gbx-copilot").getByRole("button", { name: "Send" }).click();
    const r = await reply; const sent = JSON.parse(r.request().postData() ?? "{}"); const a = await r.json();
    if (!sent.near || sent.near.km !== 50) throw new Error(`no place sent with "${q}": ${JSON.stringify(sent)}`);
    if (!a.placeNote) throw new Error(`no place note on "${q}": ${JSON.stringify(a).slice(0, 400)}`);
    return a;
  };
  const near = await ask("What do the sources near here say about the Toolachee Formation?");
  const step = (near.trace ?? []).find((s) => /geotagged within 50 km/.test(s.detail ?? ""));
  if (!step) throw new Error(`no place filter in the trace: ${JSON.stringify(near.trace ?? []).slice(0, 500)}`);
  const untagged = (near.citations ?? []).filter((c) => !(near.geo?.[c.id]?.length));
  if (untagged.length) throw new Error(`citations without geotags: ${untagged.map((c) => c.id).join(", ")}`);
  await page.waitForTimeout(1500); await shot("07-ask-near");
  const facts = await ask("How deep is the basin floor here?");
  if (facts.label !== "Precomputed" || !/same figures as What we know here/.test(facts.placeNote) || !facts.paragraphs.join(" ").includes(depth))
    throw new Error(`the point's depth (${depth}) wasn't answered from the card's figures: ${JSON.stringify({ label: facts.label, note: facts.placeNote, text: facts.paragraphs })}`);
  const wide = await ask("Which figure in the Galilee Basin data guide shows where the boreholes and seismic surveys are?");
  if (wide.trace?.[0]?.step !== "Looked beyond the place" || !/about the Galilee Basin, and this place is in the Cooper Basin/.test(wide.placeNote))
    throw new Error(`a question about another basin wasn't answered from the whole library: ${JSON.stringify({ label: wide.label, note: wide.placeNote, trace: wide.trace?.[0] })}`);
  await page.waitForTimeout(1500); await shot("07b-ask-beyond");
  await page.getByRole("button", { name: "Stop limiting answers to this place" }).click();
  if (await chip.count()) throw new Error("the place limit didn't clear");
  await card.getByRole("button", { name: "Close what we know here" }).click();
  return `near: ${near.label}, ${(near.citations ?? []).length} citations, all geotagged; here: ${facts.label}, depth ${depth}; beyond: ${wide.label}, ${(wide.citations ?? []).length} citations`;
});
await check("the preset Cooper section is measured by GDAL/PROJ and keeps the reference fixture", async () => {
  await page.getByRole("button", { name: /^Role:/ }).click(); await page.getByRole("menuitem", { name: /Computational geoscientist/ }).click(); await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Section west to east across the Cooper Basin" }).click();
  const sheet = page.locator('section[aria-label="Cross-section"]'); await sheet.waitFor({ timeout: 30000 }); await page.waitForTimeout(2500); await shot("03-section");
  // the line itself, with the sheet and side panels briefly hidden
  const hide = await page.addStyleTag({ content: 'section[aria-label="Cross-section"], [class*="pointer-events-none absolute left-3"], [class*="z-30 flex flex-col gap-2"] { visibility: hidden !important; }' });
  await page.waitForTimeout(400); await shot("03b-section-line"); await hide.evaluate((el) => el.remove());
  const t = await sheet.innerText();
  if (!/GDAL\/PROJ/.test(t) || !/Measured with GDAL [\d.]+ and PROJ [\d.]+ along the geodesic/.test(t)) throw new Error(t.slice(0, 500));
  const ref = /reference method, which the reference fixture locks, gives ([\d.,]+) km and ([\d,]+) boreholes/.exec(t);
  if (!ref || ref[2] !== "464") throw new Error(`reference count missing or wrong: ${ref?.[0] ?? t.slice(0, 300)}`);
  const n = /(\d[\d,]*) boreholes within 10 km/.exec(t)?.[1];
  await sheet.getByRole("button", { name: "Close the section" }).click(); await page.waitForTimeout(400);
  return `geodesic ${n} boreholes; reference ${ref[1]} km and ${ref[2]} boreholes`;
});
await check("boreholes and faults draw when zoomed in", async () => {
  await home(); const p = await at(140.6, -28.0); await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(700); }
  await page.waitForTimeout(2500); await shot("04-zoomed");
  // Zoomed in, the evidence wells are named, in their marker's colour, and the basin name still shows.
  const labels = await page.locator('[data-gbx-map="azure"]').evaluate((el) => ({ basins: el.dataset.gbxBasinLabels ?? "", wells: el.dataset.gbxWellLabels ?? "" }));
  if (!labels.wells) throw new Error("no well names when zoomed in on the Cooper Basin wells");
  if (!labels.basins.split("|").includes("COOPER")) throw new Error(`COOPER missing when zoomed in (rendered: ${labels.basins || "none"})`);
  return `wells named: ${labels.wells.replaceAll("|", ", ")}; basin names: ${labels.basins.replaceAll("|", ", ")}`;
});
await check("the base map starts on satellite imagery and switches to Dark and back", async () => {
  await page.getByRole("button", { name: "Choose the base map" }).click();
  if ((await page.getByRole("menuitemcheckbox", { name: "Satellite" }).getAttribute("aria-checked")) !== "true") throw new Error("the base map did not start on Satellite");
  await page.getByRole("menuitemcheckbox", { name: "Dark" }).click(); await page.waitForTimeout(3000); await shot("05-dark");
  await page.getByRole("button", { name: "Choose the base map" }).click(); await page.getByRole("menuitemcheckbox", { name: "Satellite" }).click();
  await page.waitForTimeout(3000); await shot("05-satellite");
  const img = Object.keys(R.atlas).filter((k) => /imagery|satellite|microsoft\.imagery/i.test(k));
  return img.length ? img.join(", ") : "imagery requests not separately identifiable";
});
// The satellite style finds its photos through one lookup, the tileset details of microsoft.imagery. If that request
// fails, the SDK never asks for a photo and the map shows roads and labels on black (seen
// 8 Nov 2026), so the app then requests the photos directly and shows their credit (app/src/components/azure-basin-map.tsx).
await check("the satellite photos come back, with their credit, when their lookup fails", async () => {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    let photos = 0;
    await c.route(/\/map\/tileset\?.*tilesetId=microsoft\.imagery/, (r) => r.abort("connectionreset"));
    if (!local) await c.route(`${base}/**`, (r) => r.continue({ headers: { ...r.request().headers(), authorization: `Bearer ${TOKEN}` } }));
    const p = await c.newPage();
    p.on("request", (q) => { if (/\/map\/tile\?/.test(q.url()) && /tilesetId=microsoft\.imagery/.test(q.url())) photos++; });
    await p.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    const d = p.getByRole("dialog", { name: /Who's exploring today/ }); await d.waitFor({ timeout: 45000 });
    await d.getByRole("button", { name: /^Start as exploration geoscientist$/i }).click();
    const credit = p.locator("[data-gbx-photo-credit]"); await credit.waitFor({ timeout: 30000 });
    await p.waitForTimeout(3000); await p.screenshot({ path: path.join(out, "05-photos-recovered.png") });
    if (!photos) throw new Error("no photo tiles were requested after the lookup failed");
    return `${photos} photo tiles requested directly; credit "${(await credit.innerText()).replace(/^.*credits:\s*/s, "").trim()}"`;
  } finally { await c.close(); }
});
// Esri base maps come through the app's relay (services/api/src/esri.ts) only when the deployment has an Esri key and
// Esri's credits are known; otherwise the menu offers the Azure base maps alone and this check says so.
await check("Esri base maps switch in through the relay with their credits", async () => {
  const status = await page.evaluate(() => fetch("/api/basemap/esri", { credentials: "same-origin" }).then((r) => r.json()));
  if (!status.enabled) return `Esri not connected (${status.reason ?? "no reason given"}), so only the Azure base maps are offered`;
  const tiles = [];
  const seen = (r) => { if (r.url().includes("/api/basemap/esri/")) tiles.push(`${r.status()} ${r.headers()["content-type"] ?? ""}`); };
  page.on("response", seen);
  for (const s of status.styles) {
    await page.getByRole("button", { name: "Choose the base map" }).click(); await page.getByRole("menuitemcheckbox", { name: s.label, exact: true }).click();
    await page.waitForTimeout(5000); await shot(`06-esri-${s.id}`);
    const credit = (await page.locator("[data-gbx-esri-credit]").innerText()).replace(/\s+/g, " ");
    if (!credit.includes("Powered by Esri") || !credit.includes(s.credits.slice(0, 24))) throw new Error(`credits not shown for ${s.label}: ${credit}`);
  }
  page.off("response", seen);
  await page.getByRole("button", { name: "Choose the base map" }).click(); await page.getByRole("menuitemcheckbox", { name: "Satellite" }).click(); await page.waitForTimeout(1500);
  if (await page.locator("[data-gbx-esri-credit]").count()) throw new Error("Esri credits still shown on the Azure base map");
  const images = tiles.filter((t) => t.startsWith("200 image/")).length;
  if (!images || tiles.some((t) => !t.startsWith("200 image/") && !t.startsWith("404 "))) throw new Error(`Esri tile responses: ${JSON.stringify(tiles.slice(0, 8))}`);
  return `${status.styles.map((s) => s.label).join(" and ")}: ${images} tiles, credits shown`;
});
// Planetary Computer overlays (services/api/src/planetary.ts) are offered only with an Esri base map. Each must draw
// through the relay with its licensor's notice, and going back to Azure Maps must take the overlay and the notice away.
await check("Planetary Computer overlays draw over the Esri base map only, with their notices", async () => {
  const get = (u) => page.evaluate((x) => fetch(x, { credentials: "same-origin" }).then((r) => r.json()), u);
  const status = await get("/api/overlay/planetary");
  if (!status.enabled) return `Planetary Computer not connected (${status.reason ?? "no reason given"}), so no overlay is offered`;
  if (!(await get("/api/basemap/esri")).enabled) throw new Error("overlays are connected but Esri isn't, so nobody can choose them");
  const layersButton = page.getByRole("button", { name: "Layers", exact: true });
  await layersButton.click(); await page.waitForTimeout(400);
  if (await page.locator("[data-gbx-planetary]").count()) throw new Error("overlay choices offered with the Azure base map");
  await page.keyboard.press("Escape");
  const tiles = [];
  const seen = (r) => { if (r.url().includes("/api/overlay/planetary/")) tiles.push(`${r.status()} ${r.headers()["content-type"] ?? ""}`); };
  page.on("response", seen);
  const provider = page.locator("[data-gbx-map-provider]");
  await provider.getByRole("button", { name: "Esri ArcGIS" }).click(); await page.waitForTimeout(3000);
  for (const l of status.layers) {
    await layersButton.click();
    await page.locator("[data-gbx-planetary]").getByRole("radio", { name: l.label }).check();
    await page.keyboard.press("Escape");
    const hint = page.locator("[data-gbx-planetary-hint]");
    if (await hint.count()) { await hint.click(); await page.waitForTimeout(1500); }
    await page.waitForTimeout(6000); await shot(`08-planetary-${l.id}`);
    const notice = (await page.locator("[data-gbx-planetary-credit]").innerText()).replace(/\s+/g, " ");
    if (!notice.includes(l.credits.slice(0, 40))) throw new Error(`notice not shown for ${l.label}: ${notice}`);
  }
  page.off("response", seen);
  await provider.getByRole("button", { name: "Azure Maps" }).click(); await page.waitForTimeout(1500);
  if (await page.locator("[data-gbx-planetary-credit]").count()) throw new Error("overlay notice still shown on the Azure base map");
  const images = tiles.filter((t) => t.startsWith("200 image/")).length;
  if (!images || tiles.some((t) => !t.startsWith("200 image/"))) throw new Error(`overlay tile responses: ${JSON.stringify(tiles.slice(0, 8))}`);
  return `${status.layers.map((l) => l.label).join(", ")}: ${images} tiles, notices shown, gone with Azure Maps`;
});
// Drawn areas (app/src/lib/area.ts) work on every base map. On Azure Maps an outline closed with a double-click on its
// first corner must list what the map's own layers hold inside it and the library's sources geotagged there (Azure AI
// Search), and the rest of that double-click mustn't open "What we know here"; on Esri, closed with a double-click on a
// new corner, the card must add Planetary Computer's ground height and Sentinel-2 scenes with their notices.
await check("a drawn area lists what lies inside it, on Azure Maps and on Esri with Planetary Computer", async () => {
  const card = page.locator('section[aria-labelledby="area-h"]');
  const corners = [[139.8, -28.8], [141.6, -28.8], [141.6, -26.9], [139.8, -26.9]];
  const replies = [];
  const seen = (r) => { const p = new URL(r.url()).pathname; if (p === "/api/search/area" || p === "/api/overlay/planetary/area") replies.push(`${r.status()} ${p}`); };
  const draw = async (finish) => {
    await home();
    await page.getByRole("button", { name: "Draw an area" }).click();
    await page.locator("[data-gbx-area-banner]").waitFor({ timeout: 3000 });
    for (const [i, [lon, lat]] of corners.entries()) {
      const p = await at(lon, lat);
      if (i === corners.length - 1 && finish === "double-click") await page.mouse.dblclick(p.x, p.y); else await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(300);
    }
    if (finish === "first corner") { const p = await at(...corners[0]); await page.mouse.dblclick(p.x, p.y); }
    await card.waitFor({ timeout: 10000 });
    if (await page.locator("[data-gbx-area-banner]").count()) throw new Error(`still drawing after the ${finish}`);
    await page.waitForTimeout(900);
    if (await page.locator('section[aria-labelledby="here-h"]').count()) throw new Error(`the rest of the ${finish} gesture opened What we know here`);
  };
  page.on("response", seen);
  await draw("first corner");
  await card.locator('section[aria-label="Sources in this area"]').getByText(/Found by Azure AI Search/).waitFor({ timeout: 20000 });
  const azure = await card.innerText();
  const n = Number((/Boreholes inside\s*\n?\s*([\d,]+)/.exec(azure)?.[1] ?? "0").replace(/,/g, ""));
  if (!(n > 50) || !/in the Cooper Basin/.test(azure) || !/Marabooka 1 scanned report/.test(azure)) throw new Error(azure.slice(0, 500));
  const lib = /([\d,]+) passages? in ([\d,]+) documents? geotagged inside it/.exec(azure);
  if (!lib) throw new Error(`no library count: ${azure.slice(0, 500)}`);
  await page.waitForTimeout(500); await shot("09-area-azure");
  await card.getByRole("button", { name: "Close what we know in this area" }).click();
  let esri = "Esri not connected, so the double-click was checked on Azure Maps";
  const provider = page.locator("[data-gbx-map-provider]");
  const onEsri = (await provider.count()) > 0;
  if (onEsri) { await provider.getByRole("button", { name: "Esri ArcGIS" }).click(); await page.waitForTimeout(2500); }
  await draw("double-click");
  const pc = card.locator("[data-gbx-area-planetary]");
  if (await pc.count()) {
    await pc.getByText(/Ground height from the Copernicus DEM|holds no data|draw a smaller one/).waitFor({ timeout: 30000 });
    const t = await card.innerText();
    const dem = /Ground height from the Copernicus DEM: ([\d,.]+) to ([\d,.]+) m/.exec(t), s2 = /Sentinel-2 imagery: ([\d,]+) scenes? from 2025/.exec(t);
    const notices = await card.locator("[data-gbx-area-credit]").allInnerTexts();
    if (!dem || !s2) throw new Error(`Planetary Computer summary: ${(await pc.innerText()).slice(0, 400)}`);
    if (!notices.some((x) => x.startsWith("Produced using Copernicus WorldDEM-30")) || !notices.includes("Contains modified Copernicus Sentinel data 2025")) throw new Error(`notices: ${JSON.stringify(notices)}`);
    await card.getByRole("button", { name: "Zoom to the area" }).click(); await page.waitForTimeout(onEsri ? 7000 : 3000); await shot("10-area-esri-planetary");
    esri = `${onEsri ? "Esri" : "Azure Maps"}, closed with a double-click: ground height ${dem[1]} to ${dem[2]} m and ${s2[1]} Sentinel-2 scenes, with both notices`;
  }
  await card.getByRole("button", { name: "Close what we know in this area" }).click();
  if (onEsri) { await provider.getByRole("button", { name: "Azure Maps" }).click(); await page.waitForTimeout(1500); }
  page.off("response", seen);
  if (!replies.length || replies.some((r) => !r.startsWith("200 "))) throw new Error(`area replies: ${JSON.stringify(replies)}`);
  return `Azure Maps, closed with a double-click on its first corner: ${n.toLocaleString("en-US")} boreholes, ${lib[1]} passages in ${lib[2]} documents from Azure AI Search; ${esri}; ${replies.length} area replies, all 200`;
});
R.csp = await page.evaluate(() => window.__csp);
await browser.close(); server?.close();
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(R, null, 2));
console.log(`Azure Maps responses: ${JSON.stringify(R.atlas)}`);
console.log(`CSP violations: ${R.csp.length}${R.csp.length ? ` ${JSON.stringify([...new Set(R.csp)].slice(0, 8))}` : ""}`);
console.log(`page errors: ${R.pageErrors.length}${R.pageErrors.length ? ` ${JSON.stringify(R.pageErrors.slice(0, 5))}` : ""}`);
console.log(`console errors: ${R.consoleErrors.length}${R.consoleErrors.length ? ` ${JSON.stringify([...new Set(R.consoleErrors)].slice(0, 5))}` : ""}`);
console.log(`screenshots and results: ${out}`);
process.exit(R.checks.every((c) => c.ok) && !R.csp.length && !R.pageErrors.length ? 0 : 1);
