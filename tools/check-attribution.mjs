// Checks that the author attribution to Kim Vaddi is intact: node tools/check-attribution.mjs
// GeoBasin Explorer AI is built and maintained by Kim Vaddi. The credit is carried in several places so that anyone who
// clones, forks or copies the project can see who built it. This check fails if any of them is removed or renamed.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const AUTHOR = "Kim Vaddi";

const files = [
  "README.md",
  "AUTHORS.md",
  "CITATION.cff",
  "NOTICE.md",
  "LICENSE",
  ".github/copilot-instructions.md",
  "app/index.html",
  "app/package.json",
  "services/api/package.json",
  "ingestion-framework/pyproject.toml",
  "services/scientists/pyproject.toml",
  "app/src/components/app-shell.tsx",
  "app/src/pages/home.tsx",
  "app/scripts/inline-single-file.mjs",
];
for (const rel of files) assert.ok(read(rel).includes(AUTHOR), `${rel} no longer credits ${AUTHOR}`);

assert.match(read("README.md"), /\[!\[Built by Kim Vaddi\]\(https:\/\/img\.shields\.io\/badge\/Built_by-Kim_Vaddi-/, "README.md lost the Built by Kim Vaddi badge");
assert.match(read("AUTHORS.md"), /\*\*Author and maintainer:\*\* Kim Vaddi/, "AUTHORS.md no longer names Kim Vaddi as author and maintainer");
assert.match(read("CITATION.cff"), /family-names: Vaddi\s+given-names: Kim/, "CITATION.cff no longer lists Kim Vaddi as an author");
for (const rel of ["app/package.json", "services/api/package.json"]) {
  assert.ok(String(JSON.parse(read(rel)).author ?? "").startsWith(AUTHOR), `${rel} author is not ${AUTHOR}`);
}
for (const rel of files.filter((f) => f.endsWith("pyproject.toml"))) {
  assert.match(read(rel), /^authors = \[\{ name = "Kim Vaddi" \}\]$/m, `${rel} authors does not list ${AUTHOR}`);
}
assert.match(read("app/index.html"), /<meta name="author" content="Kim Vaddi/, "app/index.html meta author does not lead with Kim Vaddi");
assert.match(read("app/src/components/app-shell.tsx"), /data-author="Kim Vaddi"[^>]*>Built by Kim Vaddi</, "the app header lost the Built by Kim Vaddi mark");
assert.equal((read("app/src/pages/home.tsx").match(/Author and maintainer/g) ?? []).length, 2, "home.tsx must credit Kim Vaddi in the About dialog and the export");
assert.match(read("app/scripts/inline-single-file.mjs"), /Built and maintained by Kim Vaddi/, "the offline file credit comment no longer names Kim Vaddi");
assert.match(read("LICENSE"), /^Copyright \(c\) \d{4} Kim Vaddi$/m, "LICENSE copyright line no longer names Kim Vaddi");

// When the offline file has been built, it must carry the credit too.
const offline = path.join(repo, "app/dist/geobasin-explorer-ai.html");
if (fs.existsSync(offline)) assert.ok(fs.readFileSync(offline, "utf8").includes(`Built and maintained by ${AUTHOR}`), "app/dist/geobasin-explorer-ai.html has no author credit; rebuild it with npm run build");

console.log(`Author attribution to ${AUTHOR} is intact in ${files.length} files.`);
