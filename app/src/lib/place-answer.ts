// Answers about the point open in "What we know here", worked out from the same figures the card shows.
// The copilot only uses this when someone asks about that place with "Ask about this place". Nothing is generated: each
// sentence restates a figure from the place record, and the cloud validates every sentence against that record.
import type { Citation } from "@/lib/ask";
import type { Answer5, TraceStep } from "@/lib/answer5";
import { depthLabel, fmt } from "@/lib/basins";
import type { Geotag } from "@/lib/geotag";
import type { HereInfo } from "@/lib/pack";
import type { MapHit } from "@/lib/search";
import { entityTokens, tokenize } from "@/lib/search";

export type PlaceTopic = "basin" | "uncertainty" | "depth" | "boreholes" | "confidence" | "stress" | "seismic" | "features" | "position";
// Offered in the copilot while it is asked about a place; each is answered from the place's own figures.
export const PLACE_STARTERS = ["What do we know here?", "How deep is the basin floor here?", "Which boreholes are nearest?"];
const ORDER: PlaceTopic[] = ["basin", "uncertainty", "depth", "boreholes", "confidence", "stress", "seismic", "features", "position"];
const TOPICS: [PlaceTopic, RegExp][] = [
  ["basin", /\b(which|what) basin\b/i],
  ["uncertainty", /\b(uncertain\w*|reliab\w*|how (sure|well known|well constrained))\b/i],
  ["depth", /\b(depth|deep|deeper|basin floor|basement)\b/i],
  ["boreholes", /\b(bore ?holes?|wells?|drill\w*)\b/i],
  ["confidence", /\b(confiden\w*|data (coverage|density|quality))\b/i],
  ["stress", /\b(stress\w*|sh ?max)\b/i],
  ["seismic", /\bseismic\b/i],
  ["features", /\b(features?|synclines?|anticlines?|troughs?|embayments?|structures?|structural)\b/i],
  ["position", /\b(coordinates?|gda ?(2020|94)|mga|eastings?|northings?|utm|datum|latitude|longitude|position)\b/i],
];
// The question has to point at the place itself; "What do the sources near here say about X?" is left to the library.
const HERE = /\b(here|this (place|point|spot|location|site|pin|position)|near(by| this)|around (here|this)|close by|closest|nearest|at this|where i clicked)\b/i;
const SUMMARY = /\b(what (do|does) (we|you|it|the app) know|what('s| is) known|tell me about|summar\w*|overview|describe|what can you tell)\b/i;
// Words that name a topic of the card, so they never count as naming something else (a play can be called "Basement").
const TOPIC_WORDS = new Set(tokenize("depth deep floor basement borehole boreholes well wells seismic stress feature features syncline anticline trough embayment structure confidence uncertainty position coordinates datum zone point place spot location"));

/* The card's topics a question asks about, or null when it isn't about the place's own figures: it doesn't point at the
   place, it asks about none of them, or it names a basin, unit, play or well that the card doesn't list here. */
export function placeTopics(question: string, here: Pick<HereInfo, "basinName" | "features" | "wells">): PlaceTopic[] | null {
  if (!HERE.test(question)) return null;
  const allowed = new Set([...tokenize(here.basinName ?? ""), ...here.features.flatMap((f) => tokenize(f.name)), ...here.wells.flatMap((w) => tokenize(w.name)), ...TOPIC_WORDS]);
  const entities = entityTokens();
  if (tokenize(question).some((t) => entities.has(t) && !allowed.has(t))) return null;
  if (SUMMARY.test(question)) return ORDER;
  const asked = TOPICS.filter(([, re]) => re.test(question)).map(([t]) => t);
  return asked.length ? ORDER.filter((t) => asked.includes(t)) : null;
}

const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const where = (h: HereInfo) => `${Math.abs(h.lat).toFixed(4)}°S ${h.lon.toFixed(4)}°E`;
/* One entry per feature name, at its nearest distance, nearest first (the card can list a name twice). */
const nearestFeatures = (h: HereInfo) => {
  const byName = new Map<string, HereInfo["features"][number]>();
  for (const f of [...h.features].sort((a, b) => a.km - b.km)) if (!byName.has(f.name)) byName.set(f.name, f);
  return [...byName.values()];
};
const boreholeText = (b: HereInfo["boreholes"][number]) => {
  const parts = [b.td ? `TD ${fmt(b.td)} m` : "", b.year ? String(b.year) : ""].filter(Boolean);
  return `${b.name}${parts.length ? ` (${parts.join(", ")})` : ""} at ${b.km.toFixed(1)} km`;
};
const listWithSemicolons = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join("; ")}; and ${xs[xs.length - 1]}`);
const method = (h: HereInfo) => (h.geo ? "Distances are geodesic, measured by the GDAL/PROJ spatial service." : "Distances were worked out from the bundled layers, because the GDAL/PROJ spatial service didn't answer.");

function sentences(h: HereInfo, topic: PlaceTopic): string[] {
  const basin = h.basinName ? `the ${h.basinName}` : "";
  switch (topic) {
    case "basin": return [h.basinName ? `This point is in the ${h.basinName}.` : "This point is outside the four basins the app maps."];
    case "uncertainty": return [`Uncertainty here is ${h.uncertainty.toLowerCase()}, rated from ${listOf(h.reasons)}.`];
    case "depth": return [h.depth != null ? `The depth to the basin floor here is ${depthLabel(h.depth)}, read from Geoscience Australia's depth-to-basement grid.`
      : h.basin ? "Geoscience Australia's depth-to-basement grid has no value at this point." : "No depth-to-basement grid covers this point, because it is outside the four basins."];
    case "boreholes": {
      const out = [h.within10 === 1 ? "There is 1 borehole within 10 km." : `There are ${fmt(h.within10)} boreholes within 10 km.`];
      const near = h.boreholes.slice(0, 4);
      out.push(near.length ? `The nearest ${near.length === 1 ? "is" : "are"} ${listWithSemicolons(near.map(boreholeText))}.` : "No borehole lies within about 100 km.");
      for (const w of h.wells) out.push(`The scanned well report for ${w.name} is about ${w.km.toFixed(0)} km away.`);
      return out;
    }
    case "confidence": {
      const { boreholes: b, seismic: s } = h.ga;
      if (b == null && s == null) return ["Geoscience Australia's data-confidence grids have no value here."];
      return [[b != null ? `GA borehole confidence here is higher than ${b}% of ${basin || "the basin"}` : "", s != null ? `GA seismic confidence is higher than ${s}%${b != null ? "" : ` of ${basin || "the basin"}`}` : ""].filter(Boolean).join(", and ") + "."];
    }
    case "stress": return [h.stress ? `The nearest World Stress Map record is ${h.stress.km.toFixed(0)} km away, with SHmax at N${Math.round(h.stress.azi)}°E and quality ${h.stress.quality}.` : "There is no World Stress Map record within 150 km."];
    case "seismic": return [h.basin === "cooper" ? "Cooper Basin seismic lines aren't bundled with the app, so GA seismic confidence is the guide here."
      : h.seismicKm != null ? `The nearest bundled 2D seismic line is ${h.seismicKm.toFixed(1)} km away.` : "No bundled 2D seismic line is nearby."];
    case "features": { const f = nearestFeatures(h); return [f.length ? `Named features nearby are ${listOf(f.map((x) => `the ${x.name} (${x.km.toFixed(0)} km)`))}.` : "No named feature lies within 60 km."]; }
    case "position": return [h.geo
      ? `In GDA2020 this point is ${Math.abs(h.geo.gda2020.lat).toFixed(6)}°S ${h.geo.gda2020.lon.toFixed(6)}°E, ${fmt(h.geo.gda2020.shiftM, 2)} m from its GDA94 position. In MGA zone ${h.geo.mga.zone} it is E ${fmt(h.geo.mga.gda94.easting, 1)} N ${fmt(h.geo.mga.gda94.northing, 1)} in GDA94 (EPSG:${h.geo.mga.gda94.epsg}) and E ${fmt(h.geo.mga.gda2020.easting, 1)} N ${fmt(h.geo.mga.gda2020.northing, 1)} in GDA2020 (EPSG:${h.geo.mga.gda2020.epsg}).`
      : `This point is ${where(h)} in GDA94. Its GDA2020 and MGA positions need the GDAL/PROJ spatial service, which didn't answer.`];
  }
}

/* Every figure the answer can use, labelled with its source, so the independent check sees exactly what was read. */
export function placeRecord(h: HereInfo): string {
  const lines = [
    `Point ${where(h)} (GDA94), ${h.basinName ? `in the ${h.basinName}` : "outside the four basins"}.`,
    `Uncertainty: ${h.uncertainty}. Reasons: ${h.reasons.join("; ")}. Method: distance to the nearest borehole, plus Geoscience Australia's borehole and seismic confidence grids.`,
    `Depth to basin floor (GA depth-to-basement grid, rounded to 10 m): ${h.depth != null ? depthLabel(h.depth) : h.basin ? "no grid value at this point" : "no grid outside the four basins"}.`,
    `Boreholes within 10 km (GA borehole layers): ${fmt(h.within10)}.`,
    `Nearest boreholes: ${h.boreholes.length ? h.boreholes.slice(0, 4).map(boreholeText).join("; ") : "none within about 100 km"}.`,
    `Scanned well reports within 80 km: ${h.wells.length ? h.wells.map((w) => `${w.name}, about ${w.km.toFixed(0)} km`).join("; ") : "none"}.`,
    `GA borehole confidence percentile in this basin: ${h.ga.boreholes ?? "no grid here"}. GA seismic confidence percentile in this basin: ${h.ga.seismic ?? "no grid here"}.`,
    `Nearest World Stress Map record (within 150 km): ${h.stress ? `${h.stress.km.toFixed(0)} km, SHmax N${Math.round(h.stress.azi)}°E, quality ${h.stress.quality}` : "none"}.`,
    `Nearest bundled 2D seismic line: ${h.basin === "cooper" ? "Cooper Basin seismic lines are not bundled" : h.seismicKm != null ? `${h.seismicKm.toFixed(1)} km` : "none nearby"}.`,
    `Named features within 60 km: ${nearestFeatures(h).map((f) => `${f.name}, ${f.km.toFixed(0)} km`).join("; ") || "none"}.`,
    h.geo ? `Position from the GDAL/PROJ spatial service (GDAL ${h.geo.versions.gdal}, PROJ ${h.geo.versions.proj}): GDA2020 ${Math.abs(h.geo.gda2020.lat).toFixed(6)}°S ${h.geo.gda2020.lon.toFixed(6)}°E, ${fmt(h.geo.gda2020.shiftM, 2)} m from the GDA94 position; MGA zone ${h.geo.mga.zone}, GDA94 (EPSG:${h.geo.mga.gda94.epsg}) E ${fmt(h.geo.mga.gda94.easting, 1)} N ${fmt(h.geo.mga.gda94.northing, 1)}, GDA2020 (EPSG:${h.geo.mga.gda2020.epsg}) E ${fmt(h.geo.mga.gda2020.easting, 1)} N ${fmt(h.geo.mga.gda2020.northing, 1)}.`
      : "Position: GDA2020 and MGA not available, because the GDAL/PROJ spatial service didn't answer.",
    method(h),
  ];
  return lines.join("\n");
}

const DATASETS: Record<"depth" | "boreholes" | "conf" | "wsm" | "seismic" | "tegi" | "proj", Omit<Citation, "basin">> = {
  depth: { id: "ds:depth", doc: "GA depth-to-basement grids (dataset)", page: 0, heading: "Dataset", text: "Depth to basin floor grids from the Geoscience Australia TEGI basin packages, CC BY 4.0; values sampled from the grid." },
  boreholes: { id: "ds:boreholes", doc: "GA borehole layers, four basin packages (dataset)", page: 0, heading: "Dataset", text: "Borehole locations, names, total depths and years from the Geoscience Australia TEGI basin packages (eCat 147459–147462), CC BY 4.0." },
  conf: { id: "ds:confidence", doc: "GA borehole and seismic data-confidence grids (dataset)", page: 0, heading: "Dataset", text: "Geoscience Australia's borehole and seismic data-confidence grids from the TEGI basin packages, CC BY 4.0; a point's value is ranked against the whole basin." },
  wsm: { id: "ds:wsm", doc: "World Stress Map 2025 database (dataset)", page: 0, heading: "Dataset", text: "Maximum horizontal stress (SHmax) orientation records with quality A–E; World Stress Map 2025, CC BY 4.0." },
  seismic: { id: "ds:seismic", doc: "GA 2D seismic lines in the basin packages (dataset)", page: 0, heading: "Dataset", text: "2D seismic line locations bundled with the Geoscience Australia TEGI basin packages, CC BY 4.0." },
  tegi: { id: "ds:tegi", doc: "GA TEGI basin packages 147459–147462 (dataset)", page: 0, heading: "Dataset", text: "Outlines, units, plays, boreholes, faults and depth grids for the four basins; Geoscience Australia, CC BY 4.0." },
  proj: { id: "calc:gdal-proj", doc: "GDAL/PROJ spatial service (computation)", page: 0, heading: "Computation", text: "Geodesic distances on GRS80 and GDA94 to GDA2020 and MGA transformations with GDAL and PROJ." },
};
const SOURCES_OF: Record<PlaceTopic, (keyof typeof DATASETS)[]> = {
  basin: ["tegi"], uncertainty: ["boreholes", "conf"], depth: ["depth"], boreholes: ["boreholes"], confidence: ["conf"], stress: ["wsm"], seismic: ["seismic"], features: ["tegi"], position: ["proj"],
};

/* The answer to a question placeTopics accepted, from the place's figures. */
export function placeAnswer(question: string, h: HereInfo, topics: PlaceTopic[]): Answer5 {
  const t0 = performance.now();
  const id = `place:${h.lon.toFixed(4)},${h.lat.toFixed(4)}`;
  const paragraphs = [`This is what the app knows at ${where(h)} (GDA94)${h.basinName ? `, in the ${h.basinName}` : ", outside the four basins"}, from the same layers as What we know here.`,
    ...topics.filter((t) => t !== "basin" || topics.length === 1).flatMap((t) => sentences(h, t))];
  if (topics.some((t) => t === "uncertainty" || t === "boreholes" || t === "features" || t === "stress" || t === "seismic")) paragraphs.push(method(h));
  const record: Citation = { id, basin: h.basin ?? "", doc: `What we know here, ${where(h)} (computed)`, page: 0, heading: "Computed for this point", text: placeRecord(h) };
  const keys = [...new Set([...topics.flatMap((t) => SOURCES_OF[t]), ...(h.geo && topics.some((t) => t !== "basin") ? ["proj" as const] : [])])];
  const citations: Citation[] = [record, ...keys.map((k) => ({ ...DATASETS[k], basin: h.basin ?? "" }))];
  const point: Geotag = { label: "The point you asked about", kind: "point", lon: h.lon, lat: h.lat, basin: h.basin, method: "Named in the text" };
  const geo: Record<string, Geotag[]> = Object.fromEntries(citations.map((c) => [c.id, c.id === id ? [point] : []]));
  const hits: MapHit[] = topics.includes("boreholes") ? h.boreholes.slice(0, 4).map((b) => ({ lon: b.lon, lat: b.lat, label: b.name, kind: "borehole" })) : [];
  const trace: TraceStep[] = [
    { step: "Read the question", detail: `It asks about the point open in What we know here: ${topics.length === ORDER.length ? "everything the card shows" : topics.join(", ")}.`, ms: 0 },
    { step: "Used the place facts", detail: `The same figures as What we know here, from the bundled GA layers and World Stress Map${h.geo ? ", with distances and positions from the GDAL/PROJ spatial service" : ""}. No text is generated: every sentence restates a figure.`, ms: Math.round((performance.now() - t0) * 10) / 10 },
  ];
  return {
    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, question, status: "answered", basin: h.basin, paragraphs, provenance: ["computed"], citations,
    focus: { lon: h.lon, lat: h.lat, zoom: 8.4, label: "The point you asked about", ringKm: topics.includes("boreholes") ? 10 : undefined }, focusBasin: h.basin, highlight: [], followUps: [],
    why: { terms: [], rule: "Place facts: what we know at this point, from the GA layers, World Stress Map and the GDAL/PROJ spatial service", scores: [] },
    label: "Precomputed", hits, reason: "Worked out for this point from the same layers as What we know here", trace, geo, ms: Math.round((performance.now() - t0) * 10) / 10,
  };
}
