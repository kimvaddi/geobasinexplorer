// The copilot's suggested questions follow its context: the point it is asked about, else the basin selected on the map,
// else the role. A question is suggested for a basin only when that basin's own evidence answers it, so looking at the
// Galilee Basin no longer offers questions whose answers are in the Cooper Basin.
import { PLACE_STARTERS } from "@/lib/place-answer";

/* Four questions each basin's own guide and GA datasets answer; each was answered by the live site on 8 November 2026. */
export const BASIN_QUESTIONS: Readonly<Record<string, readonly string[]>> = {
  cooper: ["Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?", "Which plays are analogs to the Cooper Basin Patchawarra Play?", "What is the source rock in the Cooper Basin?", "Tell me about the Toolachee Formation"],
  galilee: ["Which figure in the Galilee Basin data guide shows where the boreholes and seismic surveys are?", "What are the reservoirs in the Galilee Basin?", "Which plays are analogs to the Aramac Play?", "How many Galilee boreholes are deeper than 2,000 m?"],
  northbowen: ["Which figure in the North Bowen Basin data guide shows where the boreholes and seismic surveys are?", "How old is the North Bowen Basin?", "How deep is the Taroom Trough?", "Where is the North Bowen Basin floor deepest, and how deep does it get?"],
  adavale: ["Which figure in the Adavale Basin data guide shows where the boreholes and seismic surveys are?", "Which Adavale units are reservoirs?", "How old is the Adavale Basin?", "Where is the Adavale Basin floor deepest, and how deep does it get?"],
};

/* The basins whose evidence answers each role and general question (lenses.ts, ask.ts STARTERS). An empty list means the
   question is about every basin or none, so it fits any basin. tests/answers/entry.ts requires every one to be listed. */
export const QUESTION_BASINS: Readonly<Record<string, readonly string[]>> = {
  "Which plays are analogs to the Cooper Basin Patchawarra Play?": ["cooper"],
  "Do the Galilee and Bowen basins have same-age counterparts of the Cooper rift plays?": ["cooper", "galilee", "northbowen"],
  "What is the top of the Toolachee Formation in Marabooka 1, below the kelly bushing and below sea level?": ["cooper"],
  "Which source defines the Cooper Basin play intervals, and how many play intervals does it use?": ["cooper"],
  "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?": ["cooper"],
  "Compare the four basins": [],
  "In the 1960 Innamincka 1 report, what shut-in pressure did DST 10 record, and over which perforations?": ["cooper"],
  "What is the porosity of the Hutton Sandstone?": ["cooper"],
  "How deep is the Taroom Trough?": ["northbowen"],
  "What is the mean maximum horizontal stress (SHmax) direction inside the Cooper Basin, from quality A–C records, and how many records support it?": ["cooper"],
  "Which Galilee boreholes are deepest?": ["galilee"],
  "Which plays are the same age as the Merrimelia Play?": ["cooper"],
  "Does the Marabooka 1 report suggest the Toolachee and Patchawarra could be in communication?": ["cooper"],
  "Which Adavale units are reservoirs?": ["adavale"],
  "What is the SHmax orientation in the Cooper Basin?": ["cooper"],
  "Tell me about the Toolachee Formation": ["cooper"],
  "What is a play interval?": [],
  "What was the DST 10 shut-in pressure in Innamincka 1?": ["cooper"],
  "How many Galilee boreholes are deeper than 2,000 m?": ["galilee"],
  "How old is the North Bowen Basin?": ["northbowen"],
};

/* `role` is the role's questions and the general ones, in order. `basin` is the basin around the point when the copilot is
   asked about a place, else the basin selected on the map. */
export function suggestedQuestions(role: readonly string[], ctx: { basin: string | null; place: boolean }): string[] {
  const own = (ctx.basin && BASIN_QUESTIONS[ctx.basin]) || [];
  if (ctx.place) return [...PLACE_STARTERS, ...own.slice(0, 1)];
  if (!ctx.basin) return [...role];
  const fits = role.filter((q) => QUESTION_BASINS[q]?.includes(ctx.basin!));
  const general = role.filter((q) => QUESTION_BASINS[q]?.length === 0);
  return [...new Set([...fits, ...own, ...general])];
}
