// Rebuild the permitted reference passages and remove withheld records already in the index.
// node build.mjs --script scripts/build-index.ts
// node dist/scripts/build-index.mjs --dry-run   (queries only; reports deletion keys)
// node dist/scripts/build-index.mjs             (deletes withheld keys, then uploads permitted passages)
import { maintainIndex } from "../src/index-maintenance";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: build-index.mjs [--dry-run]");
console.log(JSON.stringify(await maintainIndex({ dryRun: args.includes("--dry-run") }), null, 2));
