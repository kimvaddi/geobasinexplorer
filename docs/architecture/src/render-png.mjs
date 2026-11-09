#!/usr/bin/env node
// Renders docs/architecture/technical-architecture.png from the .drawio file beside it, with the diagrams.net viewer in
// headless Chromium.
//   node docs/architecture/src/render-png.mjs [scale]      scale defaults to 2
// Needs Node 22+ and Playwright (PLAYWRIGHT_MODULE, or app/node_modules/playwright after `npm install` in app/);
// CHROME_PATH selects an installed Chrome or Edge instead of Playwright's browser. The viewer script loads from
// viewer.diagrams.net.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "..");
const require = createRequire(path.resolve(here, "../../../app/package.json"));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const name = "technical-architecture";
const scale = Number(process.argv[2] ?? 2);
const xml = fs.readFileSync(path.join(dir, `${name}.drawio`), "utf8");
const [, width, height] = xml.match(/pageWidth="(\d+)" pageHeight="(\d+)"/).map(Number);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: width + 40, height: height + 40 }, deviceScaleFactor: scale });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const config = JSON.stringify({ highlight: "#0078D4", nav: false, resize: false, toolbar: "", border: 0, xml }).replace(/&/g, "&amp;").replace(/'/g, "&#39;");
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><div class="mxgraph" style="width:${width}px;height:${height}px" data-mxgraph='${config}'></div>
<script src="https://viewer.diagrams.net/js/viewer-static.min.js"></script></body></html>`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForSelector(".mxgraph svg", { timeout: 60000 });
  await page.waitForTimeout(2000);
  if (errors.length) throw new Error(`The viewer reported errors: ${errors.join("; ")}`);
  const svg = await page.locator(".mxgraph svg").boundingBox();
  await page.screenshot({ path: path.join(dir, `${name}.png`), clip: { x: svg.x, y: svg.y, width, height } });
  console.log(`wrote ${name}.png (${width * scale} x ${height * scale})`);
} finally {
  await browser.close();
}
