// Where a live citation sits on the map, shared by the live agent's answers and prepared answers matched to live pages.
import type { Citation } from "@/lib/ask";
import { basinById } from "@/lib/basins";
import type { Geotag } from "@/lib/geotag";
import type { PublicationManifest } from "./contracts";
import { livePlace } from "./source-policy";

export const wellLabel = (s: { sourceId: string; title: string }) => `${livePlace(s.sourceId)?.well ?? s.title} (live geotag)`;
/* The source's registered well, and the outline of the citation's basin. */
export function liveGeotags(c: Pick<Citation, "basin" | "live">, manifest: PublicationManifest): Geotag[] {
  const s = manifest.sources.find((source) => source.sourceId === c.live?.sourceId);
  const tags: Geotag[] = [];
  if (s?.wellLocation) tags.push({ label: wellLabel(s), kind: "point", lon: s.wellLocation.lon, lat: s.wellLocation.lat, basin: c.basin || null, method: "From the document's well" });
  const basin = basinById(c.basin);
  if (basin) tags.push({ label: `${basin.name} (packaged outline)`, kind: "polygon", lon: basin.labelAt[0], lat: basin.labelAt[1], basin: basin.id, method: "From the document's basin" });
  return tags;
}
