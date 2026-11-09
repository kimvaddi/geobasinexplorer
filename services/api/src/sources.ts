// "Where did this come from?": reopen a cited passage by its original id, only if the caller may see it.
import { search, type Passage } from "./azure";
import { accessFilter } from "./geo";
import { LICENCE } from "./licence";
import type { User } from "./auth";
import { liveManifest } from "./live/serving-manifest";
import { packagedAllowed, packagedFilter, hasLiveSources, PACKAGED_LABEL } from "./live/serving-policy";

export async function sourcePassage(id: string, user: User) {
  if (LICENCE.isWithheldId(id)) return null;
  const { manifest } = await liveManifest.read();
  const safe = id.replace(/'/g, "''").slice(0, 200);
  const res = await search().search("*", { top: 1, filter: packagedFilter(`id eq '${safe}' and ${accessFilter(user)}`, manifest), select: ["id", "doc", "page", "heading", "text", "basin", "kind", "source", "docId", "well", "visibility"] } as never);
  for await (const r of (res as { results: AsyncIterable<{ document: Passage }> }).results) if (!LICENCE.isWithheldPassage(r.document) && packagedAllowed(r.document, manifest)) return hasLiveSources(manifest) ? { ...r.document, provenanceLabel: PACKAGED_LABEL } : r.document;
  return null;
}
