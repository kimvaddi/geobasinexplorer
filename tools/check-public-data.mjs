// Checks that this edition carries no withheld source content: node tools/check-public-data.mjs
// The licence registry (app/src/lib/licence.ts) withholds sources whose reuse terms are unconfirmed, together with every
// value derived from them, and app/src/data/licence-provenance.json records a one-way fingerprint of each withheld text.
// This check fails if any text in the bundled packs matches one of those fingerprints, if the licence gate is not always
// on, or if a withheld source appears among the assets or in the source manifest. It needs no plaintext of the withheld
// content, so the check itself never redistributes it.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
// The same fingerprint as licenceTextKey in app/src/lib/licence.ts: 64-bit FNV-1a over the lower-cased, trimmed text.
const textKey = (s) => {
  let h = 0xcbf29ce484222325n;
  for (const c of s.toLowerCase().replace(/\\/g, "/").trim()) h = BigInt.asUintN(64, (h ^ BigInt(c.codePointAt(0))) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
};
const binary = (s) => s.startsWith("data:") || /^[A-Za-z0-9+/=]{200,}$/.test(s);
const strings = (value, at, out) => {
  if (typeof value === "string") { if (!binary(value)) out.push({ at, key: textKey(value) }); }
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (k !== "withheldProvenance") strings(v, `${at}.${k}`, out);
  return out;
};

const provenance = JSON.parse(read("app/src/data/licence-provenance.json"));
const withheld = new Map(provenance.text.filter((p) => !p.id.endsWith(":question") && !p.id.startsWith("starter:")).map((p) => [p.fingerprint, p]));
const packs = ["app-pack", "lowcarbon-pack", "basins-pack"];
const found = packs.flatMap((name) => strings(JSON.parse(read(`app/src/data/${name}.json`)), name, [])).filter((s) => withheld.has(s.key));
assert.equal(found.length, 0, `Withheld text found in the packs: ${found.slice(0, 10).map((f) => `${f.at} (${withheld.get(f.key).id})`).join(", ")}`);

assert.match(read("app/src/lib/cloud.ts"), /export const GATED = true;/, "The licence gate must always be on in this edition (app/src/lib/cloud.ts)");

const registry = read("app/src/lib/licence.ts");
const ids = [...registry.matchAll(/\{ id: "([a-z0-9-]+)", reference: /g)].map((m) => m[1]);
assert.ok(ids.length >= 1, "No withheld sources found in app/src/lib/licence.ts");
const manifest = read("data/sources/manifest.csv").split(/\r?\n/).map((l) => l.split(",")[0]);
for (const id of ids) assert.ok(!manifest.includes(id), `Withheld source ${id} is listed in data/sources/manifest.csv`);
const markers = /cr[_-]?0*407\b|cr[_-]?0*50039|zerogen|innamincka|dem[ _-]*core|core[ _-]*workshop/i;
const files = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
const assets = files(path.join(repo, "app/src/assets")).map((f) => path.relative(repo, f)).filter((f) => markers.test(f));
assert.equal(assets.length, 0, `Assets from withheld sources: ${assets.join(", ")}`);

console.log(`Public data check passed: ${withheld.size} withheld-text fingerprints absent from ${packs.length} packs, gate always on, ` +
  `${ids.length} withheld sources absent from the manifest and the assets.`);
