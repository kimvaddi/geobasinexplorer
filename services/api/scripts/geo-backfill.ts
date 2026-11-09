// Adds the geo fields (src/geo.ts) to the live passage index and fills them for every passage already in it, bundled
// or uploaded. Only the geo fields are merged, so text and vectors stay as they are and nothing is embedded again.
// Safe to rerun. Run it before releasing an image that reads or writes the geo fields. From services/api:
//   node build.mjs --script scripts/geo-backfill.ts
//   SEARCH_ENDPOINT=https://<service>.search.windows.net node dist/scripts/geo-backfill.mjs
import { cfg } from "../src/config";
import { search, searchIndexes, type Passage } from "../src/azure";
import { geoFields } from "../src/geo";
import { definition } from "./index-schema";

const t0 = Date.now();
await searchIndexes().createOrUpdateIndex(definition as never);
console.log(`index ${cfg.index}: schema up to date, with the geo fields`);

const res = (await search().search("*", { top: 1000, includeTotalCount: true, select: ["key", "id", "doc", "heading", "text", "basin", "well"] } as never)) as unknown as { count?: number; results: AsyncIterable<{ document: Passage }> };
const all: Passage[] = [];
for await (const r of res.results) all.push(r.document);
if ((res.count ?? all.length) > all.length) throw new Error(`The index holds ${res.count} passages, more than one page of 1,000: page through them before rerunning.`);

const geotags: Record<string, number> = {};
const updates = all.map((p) => { const g = geoFields(p); geotags[g.geotag] = (geotags[g.geotag] ?? 0) + 1; return { key: p.key!, ...g }; });
for (let i = 0; i < updates.length; i += 100) {
  const r = await search().mergeDocuments(updates.slice(i, i + 100) as never);
  const bad = r.results.filter((x) => !x.succeeded);
  if (bad.length) throw new Error(`${bad.length} passages failed: ${bad[0].errorMessage}`);
}
await new Promise((r) => setTimeout(r, 3000));
const check = (await search().search("*", { top: 0, facets: ["geotag"], includeTotalCount: true } as never)) as unknown as { count?: number; facets?: Record<string, { value: string; count: number }[]> };
console.log(JSON.stringify({ passages: all.length, computed: geotags, indexed: Object.fromEntries((check.facets?.geotag ?? []).map((f) => [f.value, f.count])), seconds: Math.round((Date.now() - t0) / 1000) }));
