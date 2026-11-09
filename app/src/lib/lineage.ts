import { GATED } from "@/lib/cloud";
import { PACK } from "@/lib/pack";
import { libraryStats } from "@/lib/search";
import { CLASS_NAME, neighbors, PRED_LABEL, type KG, type KNode, type NType } from "@/lib/kg";

/* "Where did this come from?" for any item: the published record, the lake table it was loaded into,
   the knowledge-graph entity, and the screens that show it. Licence and attribution come from the
   source. Sensitivity label, OSDU kind and sync rule are a proposed design and say so. */

export interface Step { n: 1 | 2 | 3 | 4; title: string; lines: string[]; product: string }
export interface Gov { licence: string; attribution: string; label: string; osdu: string; osduNote: string; sync: string }
const TABLES: Record<string, { name: string; rows: string; steps: string; product: string }> = {
  basins: { name: "basins", rows: "4 outlines", steps: "Shapefiles read, outlines simplified for display, GDA94 kept", product: "Microsoft Fabric OneLake (lakehouse table)" },
  strat_units: { name: "strat_units", rows: "171 rows", steps: "Framework tables read from the four packages; one row per unit", product: "Microsoft Fabric OneLake (lakehouse table)" },
  play_intervals: { name: "play_intervals", rows: "35 rows", steps: "Play-interval tables read; ages, settings, rock types and flags kept as columns", product: "Microsoft Fabric OneLake (lakehouse table)" },
  charts: { name: "strat_charts", rows: "4 images", steps: "Chart images reduced for this file", product: "Microsoft Fabric OneLake (files)" },
  core_images: { name: "core_images", rows: "79 images", steps: "JPEG to WebP, reduced; wells, units and depths kept as columns", product: "Microsoft Fabric OneLake (files and table)" },
  boreholes: { name: "boreholes", rows: "21,961 rows", steps: "Borehole layers read; name, total depth and year kept; positions stored to about 10 m; GDA94 kept", product: "Azure Data Manager for Energy (OSDU) for wells, mirrored to OneLake" },
  structural_features: { name: "structural_features", rows: "88 rows", steps: "Named structural elements read with their positions", product: "Microsoft Fabric OneLake (lakehouse table)" },
  documents: { name: "documents and passages", rows: GATED ? `${PACK.docs.length} documents, ${libraryStats().passages} passages` : "11 documents, 558 passages", steps: "Text split into passages with document and page", product: "Microsoft Fabric OneLake, indexed by Azure AI Search" },
  hypotheses: { name: "hypothesis_tests", rows: "4 prepared tests", steps: "Rules written over the tables above; every item cites its source", product: "Foundry Agent Service tools over OneLake" },
};
const SCREENS: Record<NType, string> = {
  basin: "Map, Knowledge view, Ask answers", unit: "Knowledge view (framework and graph), Ask answers, Analogs", play: "Knowledge view, Analogs, Co-Scientist",
  flag: "Knowledge view (framework column)", hydro: "Knowledge view", role: "Knowledge view, Analogs", borehole: "Map, Knowledge view, Evidence",
  core: "Images, Knowledge view, Ask answers", chart: "Knowledge view, Evidence", feature: "Map labels, What we know here, Ask answers", document: "Ask answers, Evidence", hypothesis: "Co-Scientist, Analogs",
};
const OSDU: Partial<Record<NType, [string, string]>> = {
  basin: ["osdu:wks:master-data--Basin", "Standard kind"], borehole: ["osdu:wks:master-data--Wellbore", "Standard kind (with master-data--Well)"],
  core: ["osdu:wks:work-product-component--RockImage", "Standard kind"], chart: ["osdu:wks:work-product-component--Document", "Standard kind"],
  document: ["osdu:wks:work-product-component--Document", "Standard kind"], unit: ["custom:geobasin:StratigraphicUnit", "No standard kind; a demo extension"],
  feature: ["custom:geobasin:StructuralElement", "No standard kind; a demo extension"], play: ["custom:geobasin:PlayInterval", "No standard kind; a demo extension"],
  flag: ["custom:geobasin:ResourceFlag", "No standard kind; a demo extension"], hydro: ["custom:geobasin:HydroInterval", "No standard kind; a demo extension"],
  role: ["custom:geobasin:PetroleumRole", "No standard kind; a demo extension"], hypothesis: ["custom:geobasin:Hypothesis", "No standard kind; a demo extension"],
};
const ATTR: Record<string, string> = {
  "Geoscience Australia": "© Commonwealth of Australia (Geoscience Australia), CC BY 4.0",
  "Geological Survey of Queensland": "Geological Survey of Queensland open file",
  "PEPS SA, Department for Energy and Mining": "PEPS SA, Department for Energy and Mining, CC BY 4.0",
  "World Stress Map project": "World Stress Map Database Release 2025 (GFZ), CC BY 4.0",
};
export function lineage(g: KG, n: KNode): { steps: Step[]; gov: Gov } {
  const t = TABLES[n.table] ?? TABLES.strat_units;
  const rels = neighbors(g, n.id).filter((x) => x.dir === "out").slice(0, 4).map((x) => `${PRED_LABEL[x.pred]} ${x.node.label}`);
  const steps: Step[] = [
    { n: 1, title: "Published source", lines: [n.source.title, [n.source.publisher, n.source.id].filter(Boolean).join(" · "), `Licence: ${n.source.licence}`, ...(n.source.file ? [`File: ${n.source.file}`] : [])], product: "Catalogue record (GA eCat, GSQ or PEPS SA)" },
    { n: 2, title: "Lake table", lines: [`${t.name} · ${t.rows}`, t.steps], product: t.product },
    { n: 3, title: "Knowledge-graph entity", lines: [`${CLASS_NAME[n.type]}: ${n.label}`, ...(rels.length ? [rels.join(" · ")] : ["No links"])], product: "Fabric IQ ontology" },
    { n: 4, title: "This screen", lines: [SCREENS[n.type]], product: "Azure Maps or Esri ArcGIS, Foundry IQ answers, Azure AI Search" },
  ];
  const [osdu, osduNote] = OSDU[n.type] ?? ["custom:geobasin:Item", "No standard kind"];
  return { steps, gov: {
    licence: n.source.licence, attribution: ATTR[n.source.publisher] ?? n.source.publisher, label: /open file|cc by/i.test(n.source.licence) ? "Public" : "Review needed",
    osdu, osduNote, sync: "Re-read the catalogue record when it changes; keep the DOI and a file checksum; recompute derived values and keep the old version for audit.",
  } };
}
