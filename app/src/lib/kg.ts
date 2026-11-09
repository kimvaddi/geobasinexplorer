import { BASINS, basinById, fmt, type Borehole, type Unit } from "@/lib/basins";
import { PACK, WELLS, type Play5 } from "@/lib/pack";
import { index } from "@/lib/search";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";
import { HYPOTHESES } from "@/lib/hypothesis";
import { rank, DEFAULT_WEIGHTS, playById } from "@/lib/analog";

/* Knowledge graph built in the browser from the bundled public tables. Nodes are the things in the
   tables (basins, stratigraphic units, play intervals, resource flags, wells, core photos, charts,
   structural features, documents). Each link comes from a table column: the parent group, the play
   interval, the resource flag, the well on a core photo. Nothing is inferred by a model. */

export type NType = "basin" | "unit" | "play" | "flag" | "hydro" | "role" | "borehole" | "core" | "chart" | "feature" | "document" | "hypothesis";
export type Pred = "isPartOf" | "belongsToBasin" | "mappedIn" | "assignedToPlay" | "hasResourceFlag" | "hasCcsFlag" | "inHydroInterval" | "hasRole"
  | "depictsUnit" | "depictsPlay" | "fromBorehole" | "partOfPanel" | "locatedIn" | "shownOn" | "describes" | "reportFor" | "tests" | "mentions";
export interface SourceRef { title: string; publisher: string; id: string; licence: string; file?: string }
export interface KNode {
  id: string; type: NType; label: string; sub?: string; props: [string, string][];
  basin: string | null; lonlat: [number, number] | null; pointHow?: string;
  img?: string; source: SourceRef; table: string; names: string[]; ccs?: boolean; lowc?: boolean; short?: string;
}
export interface KEdge { s: string; p: Pred; o: string }
export interface KG { nodes: Map<string, KNode>; edges: KEdge[]; out: Map<string, KEdge[]>; inn: Map<string, KEdge[]> }

export const TYPE_LABEL: Record<NType, string> = {
  basin: "Basin", unit: "Stratigraphic unit", play: "Play interval", flag: "Resource flag", hydro: "Hydrostratigraphic interval", role: "Petroleum role",
  borehole: "Well", core: "Core image", chart: "Stratigraphic chart", feature: "Structural feature", document: "Document", hypothesis: "Hypothesis",
};
export const CLASS_NAME: Record<NType, string> = {
  basin: "Basin", unit: "StratigraphicUnit", play: "PlayInterval", flag: "ResourceFlag", hydro: "HydroInterval", role: "PetroleumRole",
  borehole: "Wellbore", core: "CoreImage", chart: "StratigraphicChart", feature: "StructuralElement", document: "Document", hypothesis: "Hypothesis",
};
export const TYPE_COLOR: Record<NType, string> = {
  basin: "#FFFFFF", unit: "#BAE6FD", play: "#DCFCE7", flag: "#FEF3C7", hydro: "#E0F2FE", role: "#F4C7D3", borehole: "#F6B26B",
  core: "#D9C6A3", chart: "#F7D06B", feature: "#C9C3F0", document: "#E2E2EA", hypothesis: "#B79CF2",
};
export const PRED_LABEL: Record<Pred, string> = {
  isPartOf: "is part of", belongsToBasin: "belongs to basin", mappedIn: "mapped in the package", assignedToPlay: "assigned to play interval",
  hasResourceFlag: "resource flag", hasCcsFlag: "CCS flag", inHydroInterval: "hydrostratigraphic interval", hasRole: "petroleum role",
  depictsUnit: "shows unit", depictsPlay: "shows play interval", fromBorehole: "from well", partOfPanel: "part of core panel",
  locatedIn: "located in", shownOn: "shown on chart", describes: "describes", reportFor: "report for", tests: "tests", mentions: "mentions",
};
export const PRED_INVERSE: Record<Pred, string> = {
  isPartOf: "has part", belongsToBasin: "contains", mappedIn: "maps", assignedToPlay: "includes unit", hasResourceFlag: "flag on",
  hasCcsFlag: "CCS flag on", inHydroInterval: "includes", hasRole: "role of", depictsUnit: "core images", depictsPlay: "core images",
  fromBorehole: "core images", partOfPanel: "core strips", locatedIn: "contains", shownOn: "shows", describes: "described by", reportFor: "reports", tests: "tested by", mentions: "mentioned in",
};

export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const MAPPED: Record<string, string> = { "cooper-basin": "cooper", "adavale-basin": "adavale", "galilee-basin": "galilee", "north-bowen-basin": "northbowen" };
const ABBR = new Set(["GSQ", "DST", "SA", "QLD", "NSW", "NT", "CSG", "DIO", "AAO", "BMR", "PPC", "AOE", "GA"]);
const titleCase = (s: string) => s.split(/\s+/).map((w) => (/\d/.test(w) || ABBR.has(w.replace(/[^A-Za-z]/g, "").toUpperCase()) && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");
const provLabel = (p: string) => (/\s/.test(p) ? p : titleCase(p.replace(/-/g, " ")));
const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) { try { return JSON.parse(v.replace(/'/g, '"')) as string[]; } catch { return []; } }
  return typeof v === "string" && v ? [v] : [];
};
const asNums = (v: unknown): number[] => {
  if (Array.isArray(v)) return v.map(Number).filter((x) => Number.isFinite(x));
  if (typeof v === "string" && v.trim().startsWith("[")) { try { return (JSON.parse(v) as number[]).filter((x) => Number.isFinite(x)); } catch { return []; } }
  return [];
};
const ma = (u: { top: number | null; base: number | null }) => (u.top != null && u.base != null ? `${fmt(u.top, 1)}–${fmt(u.base, 1)} Ma` : "not recorded");
const pkgSource = (bid: string): SourceRef => {
  const b = basinById(bid);
  return b ? { title: b.catalogue.title, publisher: "Geoscience Australia", id: `eCat ${b.catalogue.ecat} · DOI ${b.catalogue.doi}`, licence: b.catalogue.licence || "CC BY 4.0" }
    : { title: "Geoscience Australia basin package", publisher: "Geoscience Australia", id: "", licence: "CC BY 4.0" };
};
const datasetFile = (bid: string, re: RegExp) => PACK.datasets.find((d) => d.basin === bid && re.test(d.name))?.file;

export function flagKey(unc: string): { key: string; label: string; short: string } {
  if (/shale.*high/i.test(unc)) return { key: "shale-high", label: "Shale resources (high prospectivity)", short: "Shale (high)" };
  if (/shale.*medium/i.test(unc)) return { key: "shale-medium", label: "Shale resources (medium prospectivity)", short: "Shale (medium)" };
  if (/^csg$|coal seam/i.test(unc)) return { key: "coal-seam-gas", label: "Coal seam gas (CSG)", short: "CSG" };
  if (/tight/i.test(unc)) return { key: "tight-gas", label: "Tight gas", short: "Tight gas" };
  return { key: slug(unc), label: unc, short: unc };
}

/* ---------- boreholes by name ---------- */
const BH_INDEX = (() => {
  const m = new Map<string, Borehole[]>();
  for (const b of BASINS) for (const w of b.boreholes) if (w.name) { const k = normWell(w.name); const l = m.get(k); if (l) l.push(w); else m.set(k, [w]); }
  return m;
})();
export function normWell(s: string) { return s.toUpperCase().replace(/^GSQ\s+/, "").replace(/\s+/g, " ").trim(); }
export function findBorehole(name: string, basinHint?: string | null): { w: Borehole; how: string } | null {
  const k = normWell(name);
  let l = BH_INDEX.get(k); let how = "Matched by name in the GA borehole layer";
  if (!l && !/\d/.test(k)) { l = BH_INDEX.get(`${k} 1`); how = `Matched to ${titleCase(`${k} 1`)} in the GA borehole layer (the well number is not printed)`; }
  if (!l?.length) return null;
  const w = (basinHint && l.find((x) => x.basin === basinHint)) || l[0];
  return { w, how };
}

/* ---------- build ---------- */
export interface KGOptions { ccs: boolean; lowc: boolean }
const CACHE = new Map<string, KG>();
export function getKG(opts: KGOptions): KG {
  const key = `${opts.ccs}|${opts.lowc}`; const hit = CACHE.get(key); if (hit) return hit;
  const g = build(opts); CACHE.set(key, g); return g;
}

function build(opts: KGOptions): KG {
  const nodes = new Map<string, KNode>(); const edges: KEdge[] = []; const seen = new Set<string>();
  const add = (n: KNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id)!; };
  const link = (s: string, p: Pred, o: string) => { const k = `${s}|${p}|${o}`; if (s === o || seen.has(k) || !nodes.has(s) || !nodes.has(o)) return; seen.add(k); edges.push({ s, p, o }); };

  // basins (the four mapped packages)
  for (const b of BASINS) {
    add({ id: `basin:${b.id}`, type: "basin", label: b.name, props: [["State", b.state], ["Age", b.age], ["Area", b.stats.area_km2 != null ? `${fmt(b.stats.area_km2 as number)} km²` : "not recorded"], ["Boreholes in the layer", fmt(b.boreholes.length)], ["Basin floor", `${fmt(b.depth.min)} to ${fmt(b.depth.max)} m`]],
      basin: b.id, lonlat: b.labelAt, pointHow: "Label point of the GA outline", source: { ...pkgSource(b.id), file: datasetFile(b.id, /extent/i) }, table: "basins", names: [b.name] });
  }
  const provNode = (prov: string, pkg: string) => {
    const ps = slug(prov); const mapped = MAPPED[ps];
    if (mapped) return `basin:${mapped}`;
    const id = `basin:${ps}`;
    add({ id, type: "basin", label: provLabel(prov), props: [["Mapped in", `${basinById(pkg)?.name ?? pkg} package`], ["Outline", "Not bundled. The map shows the package outline"]],
      basin: pkg, lonlat: null, source: pkgSource(pkg), table: "strat_units", names: [provLabel(prov)] });
    return id;
  };

  // stratigraphic units, merged by province and name
  const unitId = new Map<string, string>(); // `${pkg}|${slug(n)}` -> node id
  const unitPkgs = new Map<string, Set<string>>();
  for (const b of BASINS) for (const u of b.units) {
    const ps = slug(u.prov); const id = `unit:${ps}:${slug(u.n)}`;
    unitId.set(`${b.id}|${slug(u.n)}`, id);
    const pk = unitPkgs.get(id) ?? new Set<string>(); pk.add(b.id); unitPkgs.set(id, pk);
    if (nodes.has(id)) continue;
    const flag = u.unc ? flagKey(u.unc) : null;
    add({ id, type: "unit", label: u.n, sub: u.rank, props: [["Rank", u.rank], ["Age", `${u.age || "not recorded"} (${ma(u)})`], ["Lithology", u.lith || "not recorded"], ["Depositional environment", u.env || "not recorded"],
      ["Petroleum role", u.pet || "not recorded"], ["Resource flag", flag ? flag.label : "none"], ["Hydrostratigraphy", u.hydro?.replace(/"/g, "") || "not recorded"], ["Province", provLabel(u.prov)]],
      basin: MAPPED[ps] ?? b.id, lonlat: null, source: { ...pkgSource(b.id), file: datasetFile(b.id, /strat|framework|unit/i) }, table: "strat_units", names: [u.n], ccs: !!(u as Unit).ccs });
  }
  for (const [id, pk] of unitPkgs) { const n = nodes.get(id)!; n.props.push(["Mapped in", [...pk].map((x) => basinById(x)?.name ?? x).join(", ")]); }
  for (const b of BASINS) for (const u of b.units) {
    const id = unitId.get(`${b.id}|${slug(u.n)}`)!;
    link(id, "belongsToBasin", provNode(u.prov, b.id));
    if (!MAPPED[slug(u.prov)] && !nodes.get(`basin:${slug(u.prov)}`)?.lonlat) link(id, "mappedIn", `basin:${b.id}`);
    if (u.parent) { const [pk, ps] = u.parent.split(":"); const pid = unitId.get(`${pk}|${ps}`); if (pid) link(id, "isPartOf", pid); }
    if (u.unc) { const f = flagKey(u.unc); add({ id: `flag:${f.key}`, type: "flag", label: f.label, short: f.short, props: [["Flag", f.label], ["Meaning", "GA framework column for unconventional resource prospectivity"]], basin: null, lonlat: null, source: { ...pkgSource(b.id), file: datasetFile(b.id, /strat|framework|unit/i) }, table: "strat_units", names: [f.short.toLowerCase(), f.label.toLowerCase()] }); link(id, "hasResourceFlag", `flag:${f.key}`); }
    if (opts.ccs && (u as Unit).ccs) { add({ id: "flag:ccs", type: "flag", label: "CCS potential", short: "CCS", props: [["Flag", "CCS potential"], ["Meaning", "GA framework column for carbon capture and storage"], ["Lens", "Low-carbon"]], basin: null, lonlat: null, source: pkgSource(b.id), table: "strat_units", names: ["carbon capture", "CCS"], lowc: true }); link(id, "hasCcsFlag", "flag:ccs"); }
    if (u.hydro) { const h = u.hydro.replace(/"/g, ""); add({ id: `hydro:${slug(h)}`, type: "hydro", label: h, props: [["Interval", h]], basin: b.id, lonlat: null, source: pkgSource(b.id), table: "strat_units", names: [h] }); link(id, "inHydroInterval", `hydro:${slug(h)}`); }
    if (u.pet) for (const r of u.pet.split(/,|;|\/|\band\b/i).map((x) => x.trim()).filter(Boolean)) {
      const rl = r.charAt(0).toUpperCase() + r.slice(1).toLowerCase();
      add({ id: `role:${slug(rl)}`, type: "role", label: rl, props: [["Role", rl], ["Meaning", "Petroleum-system role recorded in the GA framework table"]], basin: null, lonlat: null, source: pkgSource(b.id), table: "strat_units", names: [rl] });
      link(id, "hasRole", `role:${slug(rl)}`);
    }
  }
  // charts: one per package; every unit of the package is shown on it
  for (const c of PACK.charts) {
    add({ id: `chart:${c.id}`, type: "chart", label: c.title, props: [["Product", c.id], ["Image", `${c.w} × ${c.h} px, reduced for this file`]], basin: c.basin, lonlat: null, img: c.img,
      source: { title: `Stratigraphic charts (${c.id})`, publisher: "Geoscience Australia", id: c.id, licence: "CC BY 4.0" }, table: "charts", names: [c.title] });
    link(`chart:${c.id}`, "describes", `basin:${c.basin}`);
  }
  for (const b of BASINS) { const c = PACK.charts.find((x) => x.basin === b.id); if (c) for (const u of b.units) link(unitId.get(`${b.id}|${slug(u.n)}`)!, "shownOn", `chart:${c.id}`); }

  // play intervals
  const playNodeByName = (name: string, basinHint?: string | null): string | null => {
    const n = name.replace(/ Play Interval$/i, " Play").replace(/-/g, "–").toLowerCase(); const alt = name.replace(/ Play Interval$/i, " Play").toLowerCase();
    const cands = PACK.plays.filter((p) => { const pn = p.play.toLowerCase(); return pn === n || pn === alt || pn.replace(/–/g, "-") === alt; });
    const p = (basinHint && cands.find((x) => x.basins.includes(basinHint))) || cands[0];
    return p ? `play:${p.id}` : null;
  };
  for (const p of PACK.plays) {
    add({ id: `play:${p.id}`, type: "play", label: p.play, sub: p.province, props: [["Province", p.province], ["Age", `${p.stage || p.interval || "not recorded"} (${ma(p)})`], ["Period", p.period ?? "not recorded"],
      ["Depositional environment", p.env.join(", ") || "not recorded"], ["Lithology", p.lith.join(", ") || "not recorded"], ["Resource flags", p.res.join(", ") || "none"], ["Petroleum roles", p.roles.join(", ") || "not recorded"]],
      basin: p.basins[0] ?? null, lonlat: null, source: { title: `GA play-interval table (eCat ${p.ecat})`, publisher: "Geoscience Australia", id: `eCat ${p.ecat}`, licence: "CC BY 4.0" }, table: "play_intervals", names: [p.play, `${p.play} Interval`] });
    link(`play:${p.id}`, "belongsToBasin", provNode(p.province, p.basins[0] ?? "cooper"));
    for (const pu of p.units) { const uid = unitId.get(`${pu.basin}|${slug(pu.n)}`); if (uid) link(uid, "assignedToPlay", `play:${p.id}`); }
  }

  // wells: core wells, the two scanned reports, the low-carbon wells (lens only)
  const bhNode = (name: string, basinHint?: string | null): string | null => {
    const f = findBorehole(name, basinHint); if (!f) return null;
    const { w } = f; const id = `bh:${slug(normWell(w.name ?? name))}`;
    if (!nodes.has(id)) {
      const disp = /^GSQ\s/i.test(name) ? `GSQ ${titleCase(normWell(name))}` : titleCase(w.name ?? name);
      add({ id, type: "borehole", label: disp, props: [["Total depth", w.td != null ? `${fmt(w.td)} m` : "not recorded"], ["Year", w.year != null ? String(w.year) : "not recorded"], ["Type", w.type.toLowerCase()],
        ...(w.operator ? [["Operator", w.operator] as [string, string]] : []), ...(w.result ? [["Result", w.result] as [string, string]] : []), ["Position", `${Math.abs(w.lat).toFixed(4)}°S ${w.lon.toFixed(4)}°E (GDA94)`], ["Package", basinById(w.basin)?.name ?? w.basin]],
        basin: w.basin, lonlat: [w.lon, w.lat], pointHow: f.how, source: { ...pkgSource(w.basin), file: datasetFile(w.basin, /borehole/i) }, table: "boreholes", names: [name, titleCase(w.name ?? name)] });
      link(id, "locatedIn", `basin:${w.basin}`);
    }
    return id;
  };
  for (const s of WELLS) {
    const id = bhNode(s.name, "cooper");
    if (id) { const n = nodes.get(id)!; n.props.push(["Scanned report", `${s.name} completion report, read page by page`]); n.names.push(s.name); }
  }
  // Retain the independent GA borehole records, without any completion-report values or links.
  if (GATED) for (const [name] of LICENCE.metadata().sites) if (name.includes(" ")) bhNode(name);
  // documents
  for (const d of PACK.docs) {
    add({ id: `doc:${d.id}`, type: "document", label: d.title, props: [["Type", d.dataType.replace("-", " ")], ["Pages", String(d.pages)], ["Source", d.source], ["Licence", d.licence]], basin: null, lonlat: null,
      source: { title: d.title, publisher: d.source, id: d.id, licence: d.licence }, table: "documents", names: [d.title] });
    const m = /^ga-(cooper|adavale|galilee|northbowen)$/.exec(d.id); if (m) link(`doc:${d.id}`, "describes", `basin:${m[1]}`);
    if (/^inn-/.test(d.id)) { const b = bhNode("Innamincka 1", "cooper"); if (b) link(`doc:${d.id}`, "reportFor", b); }
    if (/^mar-/.test(d.id)) { const b = bhNode("Marabooka 1", "cooper"); if (b) link(`doc:${d.id}`, "reportFor", b); }
  }
  // core images
  const unitByName = (name: string, basins: string[]): string | null => {
    for (const b of [...basins, ...BASINS.map((x) => x.id)]) { const id = unitId.get(`${b}|${slug(name)}`); if (id) return id; }
    return null;
  };
  for (const p of PACK.core.photos) {
    const wells = asList(p.wells); const regions = asList(p.regions); const depths = asNums(p.depths_m);
    const id = `core:${p.id}`;
    add({ id, type: "core", label: `${p.formation} core`, sub: wells.join(", "), props: [["Formation", p.formation], ["Play interval", p.play ?? "not recorded"], ["Wells", wells.join(", ") || "not recorded"],
      ["Depths", depths.length ? `${fmt(Math.min(...depths), 1)}–${fmt(Math.max(...depths), 1)} m` : "not recorded"], ["Product", p.code ?? p.id]],
      basin: regions[0] ?? null, lonlat: null, img: p.img, source: { title: `Core photography (${p.code ?? p.id})`, publisher: "Geoscience Australia", id: p.code ?? p.id, licence: "CC BY 4.0", file: p.file }, table: "core_images", names: [p.formation] });
    const u = unitByName(p.formation, regions); if (u) link(id, "depictsUnit", u);
    if (p.play) { const pl = playNodeByName(p.play, regions[0]); if (pl) link(id, "depictsPlay", pl); }
    for (const w of wells) { const b = bhNode(w, regions[0]); if (b) link(id, "fromBorehole", b); }
  }
  for (const pn of PACK.core.panels) {
    const id = `core:${pn.id}`;
    add({ id, type: "core", label: `${pn.title} core panel`, sub: "Cooper Basin", props: [["Play interval", pn.title], ["Product", pn.code], ["Image", `${pn.w} × ${pn.h} px, reduced for this file`]],
      basin: pn.basin, lonlat: null, img: pn.img, source: { title: `Core photography panels (${pn.code})`, publisher: "Geoscience Australia", id: pn.code, licence: "CC BY 4.0", file: pn.file }, table: "core_images", names: [pn.title] });
    const pl = PACK.plays.find((x) => x.basins.includes(pn.basin) && slug(x.play.replace(/ Play$/, "")) === pn.play);
    if (pl) link(id, "depictsPlay", `play:${pl.id}`);
  }
  for (const s of PACK.core.strips) {
    const id = `core:${s.id}`;
    add({ id, type: "core", label: `${s.unit}, ${s.well}`, sub: `${s.top}–${s.base} m`, props: [["Unit", s.unit], ["Well", s.well], ["Depth", `${s.top}–${s.base} m`], ["Panel", s.panel]],
      basin: "cooper", lonlat: null, img: s.thumb, source: { title: `Core photography panels (strip ${s.id})`, publisher: "Geoscience Australia", id: s.id, licence: "CC BY 4.0" }, table: "core_images", names: [s.unit] });
    const u = unitByName(s.unit, ["cooper"]); if (u) link(id, "depictsUnit", u);
    const b = bhNode(s.well, "cooper"); if (b) link(id, "fromBorehole", b);
    link(id, "partOfPanel", `core:${s.panel}`);
  }
  // structural features
  for (const b of BASINS) for (const f of b.features) {
    const id = `feature:${b.id}:${slug(f.n)}`;
    add({ id, type: "feature", label: f.n, sub: f.t, props: [["Type", f.t], ...(f.fst ? [["Basin floor nearby", `max ${fmt(f.fst[0])} m, mean ${fmt(f.fst[1])} m, P90 ${fmt(f.fst[2])} m within ${fmt(f.fst[4])} km`] as [string, string]] : []), ["Position", `${Math.abs(f.lat).toFixed(3)}°S ${f.lon.toFixed(3)}°E (GDA94)${f.approx ? ", approximate" : ""}`]],
      basin: b.id, lonlat: [f.lon, f.lat], pointHow: f.approx ? "Named in the report text; position approximate" : "GA structural elements layer", source: { ...pkgSource(b.id), file: datasetFile(b.id, /struct|element|feature|zone/i) }, table: "structural_features", names: [f.n] });
    link(id, "locatedIn", `basin:${b.id}`);
  }
  // low-carbon wells (lens only)
  if (opts.lowc) for (const name of ["ZeroGen 2", "Habanero 1"].filter((n) => !GATED || !LICENCE.isWithheldWell(n))) { const id = bhNode(name); if (id) { const n = nodes.get(id)!; n.lowc = true; n.props.push(["Lens", "Low-carbon"]); } }
  // hypotheses
  for (const h of HYPOTHESES) {
    const id = `hyp:${h.id}`;
    add({ id, type: "hypothesis", label: h.title, props: [["Kind", "Prepared hypothesis test"], ["Verdict rule", "Counts the cited items for, against and missing"]], basin: null, lonlat: null,
      source: { title: "Prepared hypothesis test in this file", publisher: "GeoBasin Explorer AI", id: h.id, licence: "Built from the cited public data" }, table: "hypotheses", names: [] });
    const ref = playById(PACK.defaultRef);
    if (h.id === "analog" && ref) { link(id, "tests", `play:${ref.id}`); const top = rank(ref, DEFAULT_WEIGHTS)[0]; if (top) link(id, "tests", `play:${top.play.id}`); }
    if (h.id === "rift") { PACK.plays.filter((p: Play5) => p.province === "Cooper Basin" && p.period === "Permian").forEach((p) => link(id, "tests", `play:${p.id}`)); link(id, "tests", "basin:galilee"); link(id, "tests", "basin:northbowen"); }
    if (h.id === "communication") { const b = bhNode("Marabooka 1", "cooper"); if (b) link(id, "tests", b); for (const n of ["Toolachee Formation", "Patchawarra Formation"]) { const u = unitId.get(`cooper|${slug(n)}`); if (u) link(id, "tests", u); } }
    if (h.id === "stress") link(id, "tests", "basin:cooper");
  }
  if (GATED) {
    for (const [id, node] of nodes) if (LICENCE.isWithheldGraphNode(node)) nodes.delete(id);
    for (let i = edges.length - 1; i >= 0; i--) if (!nodes.has(edges[i].s) || !nodes.has(edges[i].o)) edges.splice(i, 1);
  }
  const out = new Map<string, KEdge[]>(), inn = new Map<string, KEdge[]>();
  for (const e of edges) { (out.get(e.s) ?? out.set(e.s, []).get(e.s)!).push(e); (inn.get(e.o) ?? inn.set(e.o, []).get(e.o)!).push(e); }
  return { nodes, edges, out, inn };
}

/* ---------- queries ---------- */
export interface Neighbor { node: KNode; label: string; dir: "out" | "in"; pred: Pred }
export function neighbors(g: KG, id: string): Neighbor[] {
  const r: Neighbor[] = [];
  for (const e of g.out.get(id) ?? []) { const n = g.nodes.get(e.o); if (n) r.push({ node: n, label: PRED_LABEL[e.p], dir: "out", pred: e.p }); }
  for (const e of g.inn.get(id) ?? []) { const n = g.nodes.get(e.s); if (n) r.push({ node: n, label: PRED_INVERSE[e.p], dir: "in", pred: e.p }); }
  return r;
}
export function searchNodes(g: KG, q: string, max = 12): KNode[] {
  const s = q.trim().toLowerCase(); if (s.length < 2) return [];
  const hits: [number, KNode][] = [];
  for (const n of g.nodes.values()) {
    if (n.type === "core" && !/core|photo/.test(s)) continue;
    const l = n.label.toLowerCase(); const i = l.indexOf(s); if (i < 0) continue;
    hits.push([(i === 0 ? 0 : 1) + (n.type === "unit" || n.type === "play" || n.type === "basin" ? 0 : 0.5) + l.length / 200, n]);
  }
  return hits.sort((a, b) => a[0] - b[0]).slice(0, max).map((x) => x[1]);
}

/* Passages in the bundled documents that name the node. */
export interface PassageHit { id: string; doc: string; page: number; heading: string; text: string; basin?: string }
const GENERIC = /^(the|sandstone|formation|group|member|beds|shale|basin|play|interval|coal|measures|unit|undifferentiated)$/i;
export function passagesFor(n: KNode, max = 30): PassageHit[] {
  const keys = new Set<string>();
  for (const k of n.names) if (k && k.length >= 4) keys.add(k.toLowerCase());
  if (n.type === "unit" || n.type === "play") { const first = n.label.split(/[\s–-]+/)[0]; if (first.length >= 6 && !GENERIC.test(first)) keys.add(first.toLowerCase()); }
  if (n.type === "flag") { if (/shale/i.test(n.label)) keys.add("shale resources"); if (/coal seam/i.test(n.label)) keys.add("coal seam gas"); if (/tight/i.test(n.label)) keys.add("tight gas"); }
  if (!keys.size) return [];
  const out: PassageHit[] = [];
  for (const d of index().docs) {
    if ([...keys].some((k) => d.low.includes(k))) out.push({ id: d.p.id, doc: d.p.doc, page: d.p.page, heading: d.p.h, text: d.p.t, basin: d.p.basin });
    if (out.length >= max) break;
  }
  return out;
}

/* Where a node is: points (XY) and a polygon (the basin outline it belongs to). */
export interface Where { points: { label: string; lon: number; lat: number; how: string; id: string }[]; polygon: { basin: string; label: string; how: string } | null }
export function whereOf(g: KG, n: KNode): Where {
  const pts: Where["points"] = [];
  const push = (m: KNode | undefined) => { if (m?.lonlat && !pts.some((p) => p.id === m.id)) pts.push({ label: m.label, lon: m.lonlat[0], lat: m.lonlat[1], how: m.pointHow ?? "From the layer", id: m.id }); };
  if (n.lonlat && n.type !== "basin") push(n);
  const via = (id: string, depth: number) => {
    for (const e of g.inn.get(id) ?? []) {
      if (e.p === "depictsUnit" || e.p === "depictsPlay") for (const f of g.out.get(e.s) ?? []) if (f.p === "fromBorehole") push(g.nodes.get(f.o));
      if (depth > 0 && e.p === "assignedToPlay") via(e.s, depth - 1);
    }
    for (const e of g.out.get(id) ?? []) if (e.p === "fromBorehole" || e.p === "tests") push(g.nodes.get(e.o));
  };
  via(n.id, n.type === "play" ? 1 : 0);
  const b = n.basin ? basinById(n.basin) : null;
  const prov = n.props.find(([k]) => k === "Province")?.[1] ?? "";
  const how = !b ? "" : n.type === "basin" ? "GA basin outline" : n.type === "unit" && prov && !prov.includes(b.short) ? `Package outline: the unit is mapped in the ${b.name} package` : `Outline of the ${b.name}`;
  const polygon = b ? { basin: b.id, label: b.name, how } : null;
  return { points: pts.slice(0, 8), polygon };
}

/* ---------- schema ---------- */
export function schema(g: KG) {
  const classes = new Map<NType, number>();
  for (const n of g.nodes.values()) classes.set(n.type, (classes.get(n.type) ?? 0) + 1);
  const rels = new Map<string, { p: Pred; from: NType; to: NType; n: number }>();
  for (const e of g.edges) { const a = g.nodes.get(e.s)!.type, b = g.nodes.get(e.o)!.type; const k = `${a}|${e.p}|${b}`; const r = rels.get(k); if (r) r.n++; else rels.set(k, { p: e.p, from: a, to: b, n: 1 }); }
  return { classes: [...classes.entries()].sort((a, b) => b[1] - a[1]), rels: [...rels.values()].sort((a, b) => b.n - a.n) };
}

/* ---------- Turtle export ---------- */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
const iri = (id: string) => `gb:${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
export function toTurtle(g: KG): string {
  const L: string[] = [
    "@prefix gb: <https://example.org/geobasin#> .", "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .", "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix owl: <http://www.w3.org/2002/07/owl#> .", "@prefix geo: <http://www.opengis.net/ont/geosparql#> .", "@prefix dct: <http://purl.org/dc/terms/> .", "",
    `<https://example.org/geobasin> a owl:Ontology ; rdfs:label "GeoBasin Explorer AI geoscience ontology" ; rdfs:comment "${GATED ? "Built from retained Geoscience Australia data, PEPS SA reports and World Stress Map 2025. Sources with unconfirmed reuse terms are withheld. Exported from GeoBasin Explorer AI." : "Built from public Geoscience Australia data (CC BY 4.0), PEPS SA and GSQ open file reports and the World Stress Map 2025. Exported from GeoBasin Explorer AI."}" .`, "",
  ];
  for (const t of Object.keys(CLASS_NAME) as NType[]) L.push(`gb:${CLASS_NAME[t]} a owl:Class ; rdfs:label "${TYPE_LABEL[t]}" .`);
  for (const p of Object.keys(PRED_LABEL) as Pred[]) L.push(`gb:${p} a owl:ObjectProperty ; rdfs:label "${PRED_LABEL[p]}" .`);
  L.push("gb:sourceRecord a owl:DatatypeProperty .", "gb:licence a owl:DatatypeProperty .", "gb:property a owl:DatatypeProperty .", "");
  for (const n of g.nodes.values()) {
    const parts = [`${iri(n.id)} a gb:${CLASS_NAME[n.type]}`, `rdfs:label "${esc(n.label)}"`, `gb:sourceRecord "${esc([n.source.title, n.source.id].filter(Boolean).join(" · "))}"`, `gb:licence "${esc(n.source.licence)}"`];
    for (const [k, v] of n.props) parts.push(`gb:property "${esc(`${k}: ${v}`)}"`);
    if (n.lonlat) parts.push(`geo:hasGeometry [ geo:asWKT "POINT(${n.lonlat[0].toFixed(5)} ${n.lonlat[1].toFixed(5)})"^^geo:wktLiteral ]`);
    for (const e of g.out.get(n.id) ?? []) parts.push(`gb:${e.p} ${iri(e.o)}`);
    L.push(parts.join(" ;\n    ") + " .");
  }
  return L.join("\n") + "\n";
}
export const kgStats = (g: KG) => ({ nodes: g.nodes.size, edges: g.edges.length });

/* "Add a document": the new document joins the graph with links to what it names. */
export function addDocumentNode(g: KG, doc: { id: string; title: string; pages: number; links: { id: string; pred: "describes" | "mentions" }[]; lonlat: [number, number] | null }) {
  const id = `doc:${doc.id}`;
  if (GATED && LICENCE.isWithheldDocument(doc)) return id;
  if (!g.nodes.has(id)) g.nodes.set(id, { id, type: "document", label: doc.title, props: [["Type", "added by you"], ["Pages", String(doc.pages)], ["Source", "Your file, read in this browser"], ["Licence", "Public document you added"]],
    basin: null, lonlat: doc.lonlat, source: { title: doc.title, publisher: "Added in this session", id: doc.id, licence: "Public document you added" }, table: "documents", names: [doc.title] });
  for (const l of doc.links) {
    if ((GATED && LICENCE.isWithheldGraphNode(l.id)) || !g.nodes.has(l.id) || g.edges.some((e) => e.s === id && e.o === l.id)) continue;
    const e: KEdge = { s: id, p: l.pred, o: l.id }; g.edges.push(e);
    (g.out.get(id) ?? g.out.set(id, []).get(id)!).push(e); (g.inn.get(l.id) ?? g.inn.set(l.id, []).get(l.id)!).push(e);
  }
  return id;
}
