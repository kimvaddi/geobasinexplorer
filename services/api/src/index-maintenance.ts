import { index } from "@/lib/search";
import { searchDocumentId } from "@/lib/licence";
import { LICENCE } from "./licence";
import { embed, search, searchIndexes, type Passage } from "./azure";
import { geoFields } from "./geo";
import { definition } from "../scripts/index-schema";

const keyOf = (id: string) => Buffer.from(id, "utf8").toString("base64url");
const PAGE = 1000;

async function withheldKeys(): Promise<string[]> {
  const keys = new Set<string>();
  for (let skip = 0; ; skip += PAGE) {
    let res;
    try {
      res = await search().search("*", { top: PAGE, skip, select: ["key", "id", "doc", "docId", "source", "well", "visibility", "text"] } as never);
    } catch (e) {
      if (skip === 0 && (e as { statusCode?: number }).statusCode === 404) return [];
      throw e;
    }
    let count = 0;
    for await (const { document } of (res as { results: AsyncIterable<{ document: Passage }> }).results) {
      count++;
      if (!LICENCE.isWithheldPassage(document)) continue;
      if (!document.key) throw new Error("A withheld index record has no key; no maintenance writes were made.");
      keys.add(document.key);
    }
    if (count < PAGE) return [...keys].sort();
  }
}

/* The dry run performs only queries: no schema update, deletion, embedding or upload. */
export async function maintainIndex(opts: { dryRun: boolean }) {
  const all = index().docs.map((d) => d.p);
  const passages = LICENCE.filterPassages(all);
  const skipped = Math.max(LICENCE.metadata().passages.length, all.length - passages.length);
  const keys = await withheldKeys();
  if (opts.dryRun) return { dryRun: true, uploaded: 0, skipped, deleted: 0, wouldDelete: keys.length, keys };

  await searchIndexes().createOrUpdateIndex(definition as never);
  let deleted = 0, uploaded = 0;
  // Keys come from the complete inventory, so deletion cannot shift the pagination being inspected.
  // https://learn.microsoft.com/javascript/api/@azure/search-documents/searchclient#@azure-search-documents-searchclient-deletedocuments
  for (let i = 0; i < keys.length; i += PAGE) {
    const result = await search().deleteDocuments("key", keys.slice(i, i + PAGE));
    deleted += result.results.filter((r) => r.succeeded).length;
    if (result.results.some((r) => !r.succeeded)) throw new Error(`Index cleanup failed after ${deleted} successful deletions; no passages were uploaded.`);
  }
  for (let i = 0; i < passages.length; i += 64) {
    const batch = passages.slice(i, i + 64);
    const vectors = await embed(batch.map((p) => `${p.h}\n${p.t}`));
    const docs: Passage[] = batch.map((p, j) => ({
      key: keyOf(p.id), id: p.id, doc: p.doc, page: p.page ?? 0, heading: p.h ?? "", text: p.t, basin: p.basin ?? null,
      well: p.well ?? null, kind: p.kind ?? "report", visibility: "public", owner: "", docId: searchDocumentId(p.doc),
      source: "GeoBasin reference pack (retained public Australian sources)", vector: vectors[j],
      ...geoFields({ id: p.id, doc: p.doc, heading: p.h ?? "", text: p.t, basin: p.basin ?? null, well: p.well ?? null }),
    }));
    const result = await search().mergeOrUploadDocuments(docs);
    uploaded += result.results.filter((r) => r.succeeded).length;
    if (result.results.some((r) => !r.succeeded)) throw new Error(`Index upload failed after ${uploaded} successful uploads, ${skipped} skipped passages and ${deleted} deletions.`);
  }
  return { dryRun: false, uploaded, skipped, deleted };
}
