// Explicit operator command. No writes occur without one of the flags below. Never called by the web app.
import { searchIndexes } from "../src/azure";
import { definition } from "./index-v2-schema";
import { azurePipelineStore } from "../src/live/pipeline-store";
import { seedRegistry } from "../src/live/pipeline-registry";
const [command, ...extra] = process.argv.slice(2);
if (extra.length || !["--seed-registry", "--create-index"].includes(command)) throw new Error("Usage: live-bootstrap.mjs --seed-registry | --create-index");
if (command === "--seed-registry") { await seedRegistry(azurePipelineStore(), AbortSignal.timeout(60_000)); console.log("Source registry seeded without overwriting existing decisions."); }
else {
  // Index Data Contributor cannot create indexes; bootstrap uses the operator's separate existing management grant.
  // https://learn.microsoft.com/azure/search/search-security-rbac
  const client = searchIndexes();
  try { await client.createIndex(definition); console.log("Created gbx-evidence-v2; no evidence was copied from v1."); }
  catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 409) throw e;
    const existing = await client.getIndex(definition.name);
    for (const field of definition.fields) {
      const actual = existing.fields.find((f) => f.name === field.name);
      if (!actual || actual.type !== field.type || ("vectorSearchDimensions" in field && (!('vectorSearchDimensions' in actual) || actual.vectorSearchDimensions !== field.vectorSearchDimensions))) throw new Error("Existing v2 schema differs; no automatic replacement is allowed.");
    }
    console.log("Existing v2 fields checked; no schema update or document deletion performed.");
  }
}
