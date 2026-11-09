// Bundles the cloud service with esbuild. The app's library code in app/src (answer engine, knowledge graph,
// spatial checks, extraction) is bundled in, so the cloud and the offline file share one implementation.
//   node build.mjs                      -> dist/server.mjs, dist/worker.mjs and dist/scripts/eval.mjs (run as a job in Azure)
//   node build.mjs --script <file.ts>   -> dist/scripts/<file>.mjs (operator scripts)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appAliases, cloudBuildData, cloudDefines } from "../../tools/cloud-build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]);

const cloud = await cloudBuildData();

const common = {
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: true, sourcesContent: false, define: cloudDefines, logLevel: "warning", external,
  loader: { ".webp": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl", ".pdf": "dataurl" },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [appAliases(cloud)],
};

const args = process.argv.slice(2);
if (args[0] === "--script") {
  const entry = path.resolve(args[1]);
  const out = path.join(here, "dist/scripts", path.basename(entry).replace(/\.ts$/, ".mjs"));
  await build({ ...common, entryPoints: [entry], outfile: out });
  console.log(path.relative(here, out));
} else {
  const scripts = fs.readdirSync(path.join(here, "scripts")).filter((f) => f.endsWith(".ts"));
  const outputs = new Set(["server.mjs", "worker.mjs", ...scripts.map((f) => `scripts/${f.replace(/\.ts$/, ".mjs")}`)]);
  // Rebuild every operator bundle under the same policy. Remove only orphaned generated JS/maps, never saved reports.
  for (const folder of ["", "scripts"]) {
    const dir = path.join(here, "dist", folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.mjs(?:\.map)?$/.test(f) && !outputs.has([folder, f.replace(/\.map$/, "")].filter(Boolean).join("/"))) fs.unlinkSync(path.join(dir, f));
  }
  for (const name of ["server", "worker"]) await build({ ...common, entryPoints: [path.join(here, `src/${name === "worker" ? "worker-main" : name}.ts`)], outfile: path.join(here, `dist/${name}.mjs`) });
  for (const file of scripts) await build({ ...common, entryPoints: [path.join(here, "scripts", file)], outfile: path.join(here, "dist/scripts", file.replace(/\.ts$/, ".mjs")) });
  console.log(`built cloud-stripped server, worker and ${scripts.length} operator bundles`);
}
