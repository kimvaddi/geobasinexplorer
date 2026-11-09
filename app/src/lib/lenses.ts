import type { Action, LensId, View } from "@/lib/track";
import { PACK } from "@/lib/pack";
import { BASINS } from "@/lib/basins";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

/* Role lenses. Same data, different starting points. The exploration geoscientist is the default.
   Low-carbon is a secondary lens and is off until chosen. */
export interface Kpi { value: string; label: string }
export interface LensDef {
  id: LensId; title: string; who: string; view: View; layers: Record<string, boolean>; secondary?: boolean;
  actions: { label: string; acts: Action[] }[]; questions: string[];
}
const nBh = BASINS.reduce((s, b) => s + b.boreholes.length, 0);
const ALL_LENSES: LensDef[] = [
  { id: "geo", title: "Exploration geoscientist", who: "Screen for analogs, test the idea, check the rocks.", view: "map",
    layers: { depth: true, faults: true, boreholes: true, sites: true, stress: false, conf: false, docs: false, temp: false },
    actions: [
      { label: "Rank analogs to the Patchawarra Play", acts: [{ type: "analog", ref: PACK.defaultRef }] },
      { label: "Test the top analog with the Co-Scientist", acts: [{ type: "cosci", hyp: "analog" }] },
      { label: "Open the Cooper Basin framework", acts: [{ type: "view", view: "knowledge", sub: "framework", basin: "cooper" }] },
      { label: "Find core that looks like the Patchawarra", acts: [{ type: "similar", id: "core:CP03" }] },
    ],
    questions: ["Which plays are analogs to the Cooper Basin Patchawarra Play?", "Do the Galilee and Bowen basins have same-age counterparts of the Cooper rift plays?", "What is the top of the Toolachee Formation in Marabooka 1, below the kelly bushing and below sea level?"] },
  { id: "lead", title: "Program lead", who: "See each capability, where it shows up, and how it scores.", view: "map",
    layers: { depth: true, faults: false, boreholes: false, sites: true, stress: false, conf: false, docs: true, temp: false },
    actions: [
      { label: "Open the scorecard summary", acts: [{ type: "score" }] },
      { label: "What's real and what isn't", acts: [{ type: "sheet", tab: "real" }] },
      { label: "Speed and loading, measured", acts: [{ type: "sheet", tab: "loading" }] },
      { label: "Governance and lineage", acts: [{ type: "sheet", tab: "governance" }] },
    ],
    questions: ["Which source defines the Cooper Basin play intervals, and how many play intervals does it use?", "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?", "Compare the four basins"] },
  { id: "ds", title: "Data scientist", who: "Check answer quality, extraction confidence and where things fail.", view: "map",
    layers: { depth: false, faults: false, boreholes: true, sites: true, stress: false, conf: true, docs: false, temp: false },
    actions: [
      { label: `Score the ${PACK.benchmarks.length} benchmark questions`, acts: [{ type: "score" }] },
      { label: "Extraction stress test: checkshot and velocity chart", acts: [{ type: "evidence", item: "velocity" }] },
      { label: "Curation queue: where the GA files disagree", acts: [{ type: "view", view: "knowledge", sub: "curation" }] },
    ],
    questions: ["In the 1960 Innamincka 1 report, what shut-in pressure did DST 10 record, and over which perforations?", "What is the porosity of the Hutton Sandstone?", "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?"] },
  { id: "cs", title: "Computational geoscientist", who: "Work the space: sections, depth, stress and where sources disagree.", view: "map",
    layers: { depth: true, faults: true, boreholes: true, sites: true, stress: true, conf: false, docs: true, temp: false },
    actions: [
      { label: "Section west to east across the Cooper Basin", acts: [{ type: "section", preset: "cooper-we" }] },
      { label: "Depth lens: basin floor deeper than 3 km", acts: [{ type: "depthLens", range: [3000, 11000] }] },
      { label: "Spatial checks", acts: [{ type: "sheet", tab: "checks" }] },
      { label: "What we know at the Nappamerri Trough", acts: [{ type: "here", lon: 140.55, lat: -28.05, zoom: 7.2 }] },
    ],
    questions: ["How deep is the Taroom Trough?", "What is the mean maximum horizontal stress (SHmax) direction inside the Cooper Basin, from quality A–C records, and how many records support it?", "Which Galilee boreholes are deepest?"] },
  { id: "rpm", title: "Research lead", who: "Look at the research items: geotags, the knowledge graph, the Co-Scientist and learning.", view: "knowledge",
    layers: { depth: true, faults: false, boreholes: false, sites: true, stress: false, conf: false, docs: true, temp: false },
    actions: [
      { label: "Co-Scientist: same-age rift plays", acts: [{ type: "cosci", hyp: "rift" }] },
      { label: "Knowledge graph with expert review", acts: [{ type: "view", view: "knowledge", sub: "graph" }] },
      { label: "Geotag coverage, measured", acts: [{ type: "sheet", tab: "loading" }] },
      { label: "Learning log: what changed after testing", acts: [{ type: "sheet", tab: "governance" }] },
    ],
    questions: ["Do the Galilee and Bowen basins have same-age counterparts of the Cooper rift plays?", "Which plays are the same age as the Merrimelia Play?", "Does the Marabooka 1 report suggest the Toolachee and Patchawarra could be in communication?"] },
  { id: "lowc", title: "Low-carbon (secondary)", who: GATED ? "CO₂ storage and geothermal screening on retained public well evidence." : "CO₂ storage and geothermal screening on four public wells.", view: "map", secondary: true,
    layers: { depth: false, faults: true, boreholes: false, sites: true, stress: true, conf: false, docs: false, temp: true },
    actions: [
      { label: "Habanero 1: a hot-rock geothermal well", acts: [{ type: "lowc", site: "habanero-1" }] },
      { label: "CCS flags in the Cooper framework", acts: [{ type: "view", view: "knowledge", sub: "framework", basin: "cooper" }] },
    ],
    questions: [] },
];
export const LENSES = GATED ? ALL_LENSES.map((l) => ({ ...l, actions: l.actions.filter((a) => !LICENCE.referencesWithheld(a)), questions: l.questions.filter((q) => !LICENCE.referencesWithheld(q)) })) : ALL_LENSES;
export const lensById = (id: LensId) => LENSES.find((l) => l.id === id) ?? LENSES[0];
export const BH_TOTAL = nBh;
export interface AskRow { id: string; ask: string; where: string; acts: Action[] }
/* The program lead's list: each capability and where to see it in this file. */
export const ASK_ROWS: AskRow[] = [
  { id: "1", ask: "Chat-style search across documents", where: "The Copilot, every answer cited", acts: [{ type: "tab", tab: "ask" }] },
  { id: "2", ask: "Images as well as text", where: "Images workspace and image results in answers", acts: [{ type: "view", view: "images" }] },
  { id: "3", ask: "Answer quality and why answers fail", where: "Evaluate, the live test run and Show your work", acts: [{ type: "score" }] },
  { id: "4", ask: "Ingestion and answer speed", where: "Data: Add a document (timed) and Loading", acts: [{ type: "sheet", tab: "loading" }] },
  { id: "5", ask: "Map, layer filters, spatial validation", where: "Map layers, sections and the spatial checks in Data", acts: [{ type: "sheet", tab: "checks" }] },
  { id: "6", ask: "Every result on the map", where: "Tagged documents layer and On the map in answers", acts: [{ type: "docs", on: true }] },
  { id: "7", ask: "Knowledge graph with expert review", where: "Knowledge and Review", acts: [{ type: "view", view: "knowledge", sub: "graph" }] },
  { id: "8", ask: "Learning from feedback", where: "Thumbs up or down on any answer, and the learning log", acts: [{ type: "sheet", tab: "governance" }] },
  { id: "9", ask: "Co-Scientist for hypothesis testing", where: "Co-Scientist", acts: [{ type: "cosci", hyp: "rift" }] },
];
