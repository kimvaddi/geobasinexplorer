// "Ask about this place" (answer.ts): the copilot starts from the point open in What we know here and the sources around
// it, and turns to the rest of the library only when a question reaches beyond that place or nothing near it answers.
// Every answer to such a question says which of these it used.
import type { Answer5 } from "@/lib/answer5";
import { basinById, depthAt } from "@/lib/basins";
import { WELLS, whatHere, withSpatial, type HereInfo, type SpatialHere } from "@/lib/pack";
import type { User } from "./auth";
import { greatCircleKm, type Near } from "./geo";
import { LICENCE } from "./licence";
import { spatialHere } from "./maps";
import { namesWell } from "./live/serving-policy";
import { LIVE_SOURCE_PLACES } from "./live/source-policy";

type PlaceBasin = { id: string; name: string } | null;
const BASIN_WORDS: [RegExp, string][] = [[/\bcooper\b/i, "cooper"], [/\badavale\b/i, "adavale"], [/\bgalilee\b/i, "galilee"], [/\b(north\s+)?bowen\b/i, "northbowen"]];
/* The basins a question names. */
export const basinsNamedIn = (q: string) => BASIN_WORDS.filter(([re]) => re.test(q)).map(([, id]) => id).filter((id) => !!basinById(id));
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const basinNames = (ids: string[]) => (ids.length === 1 ? basinById(ids[0])!.name : `${listOf(ids.map((id) => basinById(id)!.short))} basins`);

/* The card's figures as the browser works them out from the bundled layers, without the withheld well reports. */
export function localFacts(near: Near): HereInfo {
  const h = whatHere(near.lon, near.lat, (bid, x, y) => { const b = basinById(bid); return b ? depthAt(b, x, y) : null; });
  return { ...h, wells: h.wells.filter((w) => !LICENCE.isWithheldWell(w.id)) };
}
/* The same figures confirmed by the GDAL/PROJ spatial service, as the card does; the bundled layers stand in when it can't answer. */
export async function placeFacts(local: HereInfo, near: Near, user: User): Promise<HereInfo> {
  try { return withSpatial(local, await spatialHere({ lon: near.lon, lat: near.lat }, user.id) as SpatialHere); }
  catch (e) { return { ...local, geoError: e instanceof Error ? e.message : "The spatial service could not be reached." }; }
}

/* Why a question reaches beyond the place, or null when the sources near it may answer it: it names another basin or a
   well far from the point, it ranks or compares across basins, or what answers it (the prepared rules' sources) lies in
   another basin. The place filter would hide every one of those sources (geo.ts placeFilter). */
const ACROSS = /^(Analog question|Same-age question|Resource-flag question|Comparison across)/;
export function beyondPlace(question: string, near: Near, basin: PlaceBasin, prepared: Pick<Answer5, "status" | "label" | "basin" | "citations" | "why">): string | null {
  const here = basin?.id ?? null;
  const where = basin ? `this place is in the ${basin.name}` : "this place is outside the four basins";
  const others = basinsNamedIn(question).filter((b) => b !== here);
  if (others.length) return `Your question is about the ${basinNames(others)}, and ${where}`;
  for (const w of WELLS) {
    if (!namesWell(question, w.name)) continue;
    const km = greatCircleKm([near.lon, near.lat], [w.lon, w.lat]);
    if (km > near.km) return `Your question names ${w.name}, about ${Math.round(km)} km from this place`;
  }
  for (const p of Object.values(LIVE_SOURCE_PLACES)) {
    if (p.well && p.basin && p.basin !== here && !WELLS.some((w) => w.name === p.well) && namesWell(question, p.well)) return `Your question names ${p.well}, a ${basinById(p.basin)!.name} well, and ${where}`;
  }
  if (prepared.status === "answered" && prepared.label !== "Not found") {
    if (ACROSS.test(prepared.why?.rule ?? "")) return "Questions that rank or compare plays and basins look across every basin";
    const used = [...new Set([prepared.basin, ...prepared.citations.map((c) => c.basin)].filter((b): b is string => !!b && !!basinById(b) && b !== here))];
    if (used.length) return `What answers it is about the ${basinNames(used)}, and ${where}`;
  }
  return null;
}

// Not found because nothing near the place answered: no evidence, no supported statement, or a required live source that
// the place filter kept out of reach. A check or service that failed is not retried.
const NOTHING = new Set(["No supported live evidence", "No passage was retrieved", "No supported statement", "Validation blocked every statement"]);
export const nothingFound = (a: Pick<Answer5, "label" | "reason" | "validation">) => a.label === "Not found"
  && (NOTHING.has(a.reason) || (a.reason === "Validation incomplete" && /required live source was not cited/i.test(a.validation?.note ?? "")));
// Withheld because a statement from the sources near the place failed a check, rather than a timeout or a service.
const UNCONFIRMED = /did not fully confirm every generated fact|failed the deterministic citation and number checks|did not cite a retrieved source/i;
/* Why an answer limited to a place is asked again of the whole library, or null when it stands. */
export function widenReason(a: Pick<Answer5, "label" | "reason" | "validation">, near: Near, basin: PlaceBasin): string | null {
  if (nothingFound(a)) return nothingNear(near, basin);
  if (a.label === "Not found" && a.reason === "Validation incomplete" && UNCONFIRMED.test(a.validation?.note ?? "")) return "The independent check couldn't confirm the answer from the sources near this place";
  return null;
}

const around = (near: Near, basin: PlaceBasin) => `geotagged within ${near.km} km of this point${basin ? `, or about the ${basin.name} as a whole` : ""}`;
export const FACTS_NOTE = "Answered from what we know at this point, the same figures as What we know here.";
export const nearNote = (near: Near, basin: PlaceBasin) => `Answered from sources ${around(near, basin)}.`;
export const nothingNear = (near: Near, basin: PlaceBasin) => `No source ${around(near, basin)}${basin ? "," : ""} answers this question`;
export const widenedNote = (why: string, answered: boolean) => `${why}, so ${answered ? "this answer draws on" : "the copilot searched"} the whole library.`;
export const nearNotFound = (near: Near, basin: PlaceBasin) =>
  `Not found near this place. ${nothingNear(near, basin)}, and there wasn't time left to search the rest of the library. Clear the place limit above to search everywhere.`;
