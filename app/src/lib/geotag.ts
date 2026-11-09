import { BASINS, basinAt, basinById } from "@/lib/basins";
import { WELLS } from "@/lib/pack";
import { index, mapHits, type IndexedPassage } from "@/lib/search";

/* Geotags: every search passage gets a place on the map where the data allows it.
   A point comes from a name in the text (gazetteer match) or from the document's well.
   A polygon is the Geoscience Australia basin outline: the basin around the point, or the document's basin.
   General documents (glossary, reference lists) are not tied to a place, and say so. */
export type GeoMethod = "Named in the text" | "From the document's well" | "From the document's basin" | "Basin around the point";
export interface Geotag { label: string; kind: "point" | "polygon"; lon: number; lat: number; basin: string | null; method: GeoMethod }
export interface GeoResult { tags: Geotag[]; general: boolean }
const GENERAL = /glossary|references/i;
const WELL_BY_DOC: [RegExp, string][] = [[/innamincka/i, "innamincka-1"], [/marabooka/i, "marabooka-1"]];
/* The legacy well a passage belongs to, from its id, for passages that don't carry it. */
export const wellOf = (id: string) => /^(innamincka-1|marabooka-1)[:-]/.exec(id)?.[1] ?? (/^inn-/.test(id) ? "innamincka-1" : /^mar:/.test(id) ? "marabooka-1" : undefined);

export function geotagPassage(p: Pick<IndexedPassage, "doc" | "h" | "t" | "basin" | "well">): GeoResult {
  const tags: Geotag[] = []; const seen = new Set<string>();
  const add = (g: Geotag) => { const k = `${g.kind}:${g.label.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); tags.push(g); } };
  // points named in the text
  for (const h of mapHits([`${p.h} ${p.t}`], 6)) {
    if (h.kind === "basin") { const b = BASINS.find((x) => x.name === h.label); if (b) add({ label: b.name, kind: "polygon", lon: b.labelAt[0], lat: b.labelAt[1], basin: b.id, method: "Named in the text" }); }
    else add({ label: h.label, kind: "point", lon: h.lon, lat: h.lat, basin: basinAt(h.lon, h.lat)?.id ?? null, method: "Named in the text" });
  }
  // the document's well
  const wid = p.well ?? WELL_BY_DOC.find(([re]) => re.test(p.doc))?.[1];
  const w = wid ? WELLS.find((x) => x.siteId === wid) : null;
  if (w) add({ label: w.name, kind: "point", lon: w.lon, lat: w.lat, basin: basinAt(w.lon, w.lat)?.id ?? null, method: "From the document's well" });
  // polygons: basin around each point, else the document's basin
  for (const t of [...tags]) if (t.kind === "point" && t.basin) { const b = basinById(t.basin); if (b) add({ label: b.name, kind: "polygon", lon: b.labelAt[0], lat: b.labelAt[1], basin: b.id, method: "Basin around the point" }); }
  const general = GENERAL.test(p.doc);
  if (!tags.some((t) => t.kind === "polygon") && p.basin && !general) { const b = basinById(p.basin); if (b) add({ label: b.name, kind: "polygon", lon: b.labelAt[0], lat: b.labelAt[1], basin: b.id, method: "From the document's basin" }); }
  return { tags, general: general && !tags.length };
}

export interface GeoCoverage { passages: number; withPoint: number; withPolygon: number; general: number; none: number; byMethod: Record<GeoMethod, number>; ms: number }
let COV: GeoCoverage | null = null;
/* Measured in this browser over every searchable passage. */
export function geoCoverage(): GeoCoverage {
  if (COV) return COV;
  const t0 = performance.now(); const I = index();
  const byMethod: Record<GeoMethod, number> = { "Named in the text": 0, "From the document's well": 0, "From the document's basin": 0, "Basin around the point": 0 };
  let withPoint = 0, withPolygon = 0, general = 0, none = 0;
  for (const d of I.docs) {
    const r = geotagPassage(d.p);
    if (r.tags.some((t) => t.kind === "point")) withPoint++;
    if (r.tags.some((t) => t.kind === "polygon")) withPolygon++;
    if (r.general) general++; else if (!r.tags.length) none++;
    for (const m of new Set(r.tags.map((t) => t.method))) byMethod[m]++;
  }
  COV = { passages: I.docs.length, withPoint, withPolygon, general, none, byMethod, ms: Math.round(performance.now() - t0) };
  return COV;
}

/* Same measurement, in small batches so the screen never freezes. Time is processing time only. */
export function geoCoverageAsync(done: (c: GeoCoverage) => void, progress?: (n: number, total: number) => void): () => void {
  if (COV) { done(COV); return () => undefined; }
  const I = index(); const docs = I.docs; let i = 0, ms = 0, cancelled = false;
  const byMethod: Record<GeoMethod, number> = { "Named in the text": 0, "From the document's well": 0, "From the document's basin": 0, "Basin around the point": 0 };
  let withPoint = 0, withPolygon = 0, general = 0, none = 0;
  const step = () => {
    if (cancelled) return;
    const t0 = performance.now(); const end = Math.min(docs.length, i + 30);
    for (; i < end; i++) {
      const r = geotagPassage(docs[i].p);
      if (r.tags.some((t) => t.kind === "point")) withPoint++;
      if (r.tags.some((t) => t.kind === "polygon")) withPolygon++;
      if (r.general) general++; else if (!r.tags.length) none++;
      for (const m of new Set(r.tags.map((t) => t.method))) byMethod[m]++;
    }
    ms += performance.now() - t0; progress?.(i, docs.length);
    if (i < docs.length) window.setTimeout(step, 0);
    else { COV = { passages: docs.length, withPoint, withPolygon, general, none, byMethod, ms: Math.round(ms) }; done(COV); }
  };
  window.setTimeout(step, 0);
  return () => { cancelled = true; };
}
