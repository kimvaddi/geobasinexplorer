import type { Level } from "@/lib/pack";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

/* Guided tour: self-guided exercises, one per level, about 60 minutes in total. */
export type Tab = "ask" | "analogs" | "evidence" | "review" | "score" | "notes";
export type Action =
  | { type: "ask"; q: string }
  | { type: "tab"; tab: Tab }
  | { type: "well"; id: string; field?: string }
  | { type: "evidence"; item: "velocity" | "las" | "figure" | "core" | "pages" }
  | { type: "layer"; layer: "conf" | "seismic" | "boreholes" | "depth"; on: boolean }
  | { type: "here"; lon: number; lat: number; zoom?: number }
  | { type: "analog"; ref: string; weights?: Partial<Record<"age" | "env" | "lith" | "res" | "roles", number>> }
  | { type: "review"; filter: string; basin?: string }
  | { type: "score"; qid?: string }
  | { type: "hypothesis"; id: "analog" | "rift" | "communication" | "stress" }
  | { type: "filter"; filter: Partial<{ minTd: number; y0: number; y1: number; insideOnly: boolean }> }
  | { type: "sheet"; tab: "real" | "loading" | "checks" | "sources" | "governance" | "build" }
  | { type: "view"; view: View; sub?: KnowledgeSub; basin?: string }
  | { type: "entity"; id: string; sub?: KnowledgeSub }
  | { type: "section"; preset: string }
  | { type: "lens"; id: LensId }
  | { type: "cosci"; hyp?: "analog" | "rift" | "communication" | "stress" }
  | { type: "similar"; id: string }
  | { type: "depthLens"; range: [number, number] | null }
  | { type: "docs"; on: boolean }
  | { type: "lowc"; site?: string }
  | { type: "ingest"; sample?: boolean }
  | { type: "runtest" };
export type View = "map" | "knowledge" | "images" | "cosci";
export type KnowledgeSub = "framework" | "graph" | "schema" | "curation";
export type LensId = "geo" | "lead" | "ds" | "cs" | "rpm" | "lowc";
export interface Exercise { id?: string; n: number; level: Level | "Score"; title: string; minutes: number; goal: string; steps: string[]; tryThis: { label: string; actions: Action[] }[]; done: string }
const ALL_EXERCISES: Exercise[] = [
  { n: 1, level: "Find", title: "Find the right document", minutes: 7,
    goal: "Find the document that defines the Cooper Basin play intervals and the figure behind it, then see how the answer was found.",
    steps: ["Ask the first question below and check the tag on the answer.", "Open a source to read the passage and its page.", "Open Show your work on the answer to see each step and its time.", "Ask the figure question and open the page image it returns."],
    tryThis: [{ label: "Ask: How many play intervals does the Cooper Basin data guide use?", actions: [{ type: "ask", q: "How many play intervals does the Cooper Basin data guide use?" }] },
      { label: "Ask: Which figure shows where the Cooper Basin boreholes and seismic surveys are?", actions: [{ type: "ask", q: "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?" }] }],
    done: "You can name the document, the page and the figure, and say how the answer was found." },
  { n: 3, level: "Interpret", title: "Follow a formation through the knowledge graph", minutes: 8,
    goal: "Open the Patchawarra Formation, follow it to its core images and its place on the map, and see where each fact came from.",
    steps: ["Open the Patchawarra Formation in the Knowledge view.", "Open one of its core images, then press Show next to its point.", "Press “Where did this come from?” and read the four steps.", "In Review, accept or fix one extracted entity and check the change log."],
    tryThis: [{ label: "Open the Patchawarra Formation", actions: [{ type: "entity", id: "unit:cooper-basin:patchawarra-formation", sub: "framework" }] },
      { label: "Open Review: Cooper Basin formations", actions: [{ type: "review", filter: "formation", basin: "cooper" }] }],
    done: "You can say where the Patchawarra facts came from, and your review shows in the change log." },
  { n: 4, level: "Map", title: "Work the map", minutes: 9,
    goal: "See what we know at a point, cut a section across the basin, and filter the boreholes.",
    steps: ["Open the Nappamerri Trough point and read the uncertainty and its reasons.", "Run the west to east section across the Cooper Basin. Read the deepest floor and the faults it crosses.", "Filter to boreholes deeper than 3,000 m."],
    tryThis: [{ label: "What we know at the Nappamerri Trough", actions: [{ type: "layer", layer: "conf", on: true }, { type: "here", lon: 140.55, lat: -28.05, zoom: 7.2 }] },
      { label: "Show the west to east section across the Cooper Basin", actions: [{ type: "section", preset: "cooper-we" }] },
      { label: "Show boreholes deeper than 3,000 m", actions: [{ type: "filter", filter: { minTd: 3000 } }] }],
    done: "You can say how deep the floor gets on the section and how sure the map is at the trough." },
  { n: 5, level: "Integrate", title: "Several sources, then a new one", minutes: 10,
    goal: "Compare the Toolachee top in Marabooka 1 across three sources, then add a new public report and watch it join search and the map.",
    steps: ["Ask for the Toolachee top below the kelly bushing and below sea level, and read why the velocity chart differs.", GATED ? "If uploads are available, add a document whose reuse terms are confirmed. The bundled sample is withheld in the cloud build." : "Open Add a document and try the sample report. Check the names, the places and where it struggled.", "Press Ask about it."],
    tryThis: [{ label: "Ask: What is the top of the Toolachee in Marabooka 1, below KB and below sea level?", actions: [{ type: "ask", q: "What is the top of the Toolachee Formation in Marabooka 1, below the kelly bushing and below sea level?" }] },
      { label: "Open Add a document", actions: [{ type: "ingest" }] }],
    done: "You know whether the three sources agree, and the new report shows on the map." },
  { n: 6, level: "Reason", title: "Rank analogs, then test one with the Co-Scientist", minutes: 11,
    goal: "Rank analogs to the Cooper Basin Patchawarra Play, then let the Co-Scientist agents test whether the top one holds up.",
    steps: ["Rank analogs and change one weight.", "Open the Co-Scientist with the top analog. Read what each agent found and what's missing.", "Make the call: Accept, Reject or Needs more data, with a reason, and save it."],
    tryThis: [{ label: "Rank analogs to the Patchawarra Play", actions: [{ type: "analog", ref: "cooper-basin-patchawarra-play" }] },
      { label: "Open the Co-Scientist: is the top analog a good one?", actions: [{ type: "cosci", hyp: "analog" }] },
      { label: "Open the Co-Scientist: same-age rift plays", actions: [{ type: "cosci", hyp: "rift" }] }],
    done: "Your call and its reason are in Notes and the change log." },
  { n: 7, level: "Score", title: "Run the test, give feedback, export", minutes: 7,
    goal: "Run the live test, mark two questions, give feedback on one answer and export the scorecard.",
    steps: ["Open Evaluate, type your name and press Run all questions.", "Mark two questions and pick the highest level reached.", "On any answer, press Yes or No and pick a reason. Ask again to see what changed.", "Press Export to Excel."],
    tryThis: [{ label: "Open Evaluate", actions: [{ type: "score" }] }, { label: "Run the live test", actions: [{ type: "runtest" }] }],
    done: "An Excel file has downloaded, with a Test run sheet." },
];

export const EXERCISES = GATED ? ALL_EXERCISES.filter((e) => !LICENCE.referencesWithheld(e)).map((e, i) => ({ ...e, n: i + 1 })) : ALL_EXERCISES;
