import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../", import.meta.url));
export const appSrc = path.join(repo, "app/src");
const require = createRequire(path.join(repo, "app/package.json"));
const { build } = require("esbuild");

export async function cloudBuildData() {
  const output = await build({ entryPoints: [path.join(repo, "app/scripts/cloud-data.ts")], bundle: true, platform: "node", format: "esm", write: false, logLevel: "error" });
  const { prepareCloudData } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString("base64")}`);
  return prepareCloudData(appSrc);
}
export const cloudDefines = { "import.meta.env.MODE": '"cloud"', "import.meta.env": '{"MODE":"cloud"}' };

export function appAliases(cloud) {
  const resolveFile = (p) => [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts")].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  return {
    name: cloud ? "cloud-licensed-app-aliases" : "offline-app-aliases",
    setup(b) {
      b.onResolve({ filter: /^@\// }, (a) => {
        const raw = a.path.endsWith("?raw"), url = a.path.endsWith("?url");
        const file = path.join(appSrc, a.path.slice(2).replace(/\?(raw|url)$/, ""));
        return { path: resolveFile(file), namespace: raw ? "raw" : url ? "url" : "file" };
      });
      b.onLoad({ filter: /.*/, namespace: "url" }, (a) => ({
        contents: `export default ${JSON.stringify(cloud?.gate.isWithheldAsset(a.path) ? "" : "data:application/octet-stream;base64," + fs.readFileSync(a.path).toString("base64"))};`, loader: "js",
      }));
      b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: `export default ${JSON.stringify(cloud?.packs.get(a.path) ?? fs.readFileSync(a.path, "utf8"))};`, loader: "js" }));
      b.onLoad({ filter: /\.json$/, namespace: "file" }, (a) => {
        const json = cloud?.packs.get(a.path);
        return json === undefined ? undefined : { contents: json, loader: "json" };
      });
      b.onLoad({ filter: /\.(?:webp|png|jpe?g|tiff?|pdf)$/, namespace: "file" }, (a) => cloud?.gate.isWithheldAsset(a.path) ? { contents: 'export default "";', loader: "js" } : undefined);
      b.onLoad({ filter: /app[\\/]src[\\/].*\.tsx?$/ }, (a) => {
        let source = fs.readFileSync(a.path, "utf8");
        if (source.includes("import.meta.glob(")) source = "const __glob = (..._a: unknown[]) => ({});\n" + source.replaceAll("import.meta.glob(", "__glob(");
        return { contents: source, loader: a.path.endsWith("x") ? "tsx" : "ts" };
      });
    },
  };
}
