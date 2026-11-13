// Folds dist/index.html and its one JS and one CSS file into a single offline HTML file,
// adds a strict Content Security Policy (no network) and the data credits.
import { readFileSync, writeFileSync, statSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const read = (p) => readFileSync(new URL(p, dist), "utf8");

let html = read("index.html");
const js = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/);
const css = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/);
if (!js || !css) {
  console.error("Could not find the built script and stylesheet in dist/index.html. Run `vite build` first.");
  process.exit(1);
}
const jsText = read(js[1]).replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
const cssText = read(css[1]).replaceAll("</style", "<\\/style");

// Use replacer functions so `$&` and similar sequences in the bundle are kept as-is.
html = html.replace(css[0], () => `<style>${cssText}</style>`).replace(js[0], () => "");
html = html.replace("</body>", () => `<script type="module">${jsText}</script>\n  </body>`);

const csp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'";
html = html.replace('<meta charset="UTF-8" />', () => `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);

const credit = `<!--
  GeoBasin Explorer AI. Single offline file: no login, no network calls, no telemetry.
  Built and maintained by Kim Vaddi (https://github.com/kimvaddi). Keep this attribution when you copy or redistribute this file.
  Original prototype built by Jorge Peña Alarcón, Microsoft. Architected and enhanced into an Azure platform by Kim Vaddi, Microsoft.
  Optional copilot voice input uses the browser's own speech service and stays off until the user turns it on.
  Data: Geoscience Australia (CC BY 4.0); Department for Energy and Mining, South Australia, PEPS SA (CC BY);
  Sources whose reuse terms are unconfirmed are withheld from this file, as in the cloud build;
  OzTemp (Geoscience Australia, CC BY 3.0 AU); World Stress Map Database Release 2025 (GFZ); Natural Earth (public domain).
  Values were read from the public documents before packaging and carry a confidence. Nothing calls a live service.
  Full list: DATA_SOURCES.md and NOTICE in the repository. Licensed under the Apache License 2.0.
-->
`;
html = html.replace("<!doctype html>", () => "<!doctype html>\n" + credit);

const out = new URL("geobasin-explorer-ai.html", dist);
writeFileSync(out, html);
console.log(`Wrote dist/geobasin-explorer-ai.html (${(statSync(out).size / 1e6).toFixed(2)} MB)`);
