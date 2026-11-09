// Runs a TypeScript entry file against the app's own code, outside the browser.
// It bundles the entry with esbuild (resolving "@/..." to app/src) and runs it with Node.
//
// Usage: node tools/run-ts.mjs [--cloud] <entry.ts> [args...]
// API entry points are always cloud-stripped. Tests and app entries default to the unchanged offline data.
// Needs `npm install` in app/ first (esbuild comes from app/node_modules).
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appAliases, cloudBuildData, cloudDefines } from "./cloud-build.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "app/package.json"));
const { build } = require("esbuild");

const argv = process.argv.slice(2);
const requestedCloud = argv[0] === "--cloud";
if (requestedCloud) argv.shift();
const [entry, ...args] = argv;
if (!entry) { console.error("Usage: node tools/run-ts.mjs <entry.ts> [args...]"); process.exit(2); }
const runDir = path.join(repo, `.run-ts-${randomUUID()}`);
fs.mkdirSync(runDir);
process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
const outfile = path.join(runDir, "run.mjs");

const cloud = requestedCloud || path.resolve(entry).startsWith(path.join(repo, "services/api") + path.sep) ? await cloudBuildData() : null;
await build({
  entryPoints: [path.resolve(entry)], bundle: true, platform: "node", format: "esm", outfile, logLevel: "error",
  loader: { ".webp": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl", ".pdf": "dataurl" },
  define: cloud ? cloudDefines : {},
  plugins: [appAliases(cloud)],
});
process.argv = [process.argv[0], outfile, ...args];
await import(pathToFileURL(outfile).href);
