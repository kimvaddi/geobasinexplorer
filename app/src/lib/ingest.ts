import { getDocumentProxy } from "unpdf";
import { BASINS, basinAt, haversineKm, type LonLat } from "@/lib/basins";
import { addPassages, type IndexedPassage } from "@/lib/search";
import { addDocumentNode, type KG } from "@/lib/kg";
import type { DocPoint } from "@/lib/doctags";

/* "Add a document": a public PDF is read page by page in this browser, then tagged against the knowledge
   graph, located, checked against the basin outlines and added to search, the map and the graph.
   Pages without a text layer are flagged for OCR, a service step in production. Nothing leaves the browser. */
export const MAX_PAGES = 80;
export interface IngestPage { n: number; chars: number; ms: number; ocr: boolean }
export type EntType = "Basin" | "Formation or unit" | "Play" | "Structural feature" | "Well";
export interface IngestEntity { label: string; found: string; type: EntType; nodeId: string | null; pages: number[]; count: number; confidence: "high" | "medium" | "low"; how: string }
export interface IngestPlace { label: string; lon: number; lat: number; page: number; how: string; check: string; ok: boolean | null }
export interface IngestResult {
  docId: string; title: string; fileName: string; bytes: number; totalPages: number; pages: IngestPage[];
  entities: IngestEntity[]; proposed: { name: string; pages: number[] }[]; places: IngestPlace[]; ages: { text: string; pages: number[] }[];
  failures: string[]; passages: number; passageList: IndexedPassage[]; docPoints: DocPoint[]; ms: { read: number; extract: number; index: number; total: number };
}

/* ---------- reading ---------- */
async function readPdf(data: Uint8Array, onPage: (n: number, total: number) => void) {
  const pdf = await getDocumentProxy(data, { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 } as never);
  const total = pdf.numPages; const pages: (IngestPage & { text: string })[] = [];
  for (let n = 1; n <= Math.min(total, MAX_PAGES); n++) {
    const t0 = performance.now();
    const page = await pdf.getPage(n); const tc = await page.getTextContent();
    let text = "";
    for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) { if (typeof it.str !== "string") continue; text += it.str + (it.hasEOL ? "\n" : " "); }
    text = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    pages.push({ n, chars: text.length, ms: Math.round((performance.now() - t0) * 10) / 10, ocr: text.replace(/\s/g, "").length < 40, text });
    onPage(n, Math.min(total, MAX_PAGES));
    if (n % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { total, pages };
}

/* ---------- coordinates ---------- */
/* MGA (GDA94) easting and northing to latitude and longitude, GRS80 ellipsoid, southern hemisphere. */
export function mgaToLonLat(E: number, N: number, zone: number): LonLat {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = N - 10000000; const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const fp = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(fp) ** 2, T1 = Math.tan(fp) ** 2;
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(fp) ** 2, 1.5), N1 = a / Math.sqrt(1 - e2 * Math.sin(fp) ** 2), D = x / (N1 * k0);
  const lat = fp - ((N1 * Math.tan(fp)) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = ((zone * 6 - 183) * Math.PI) / 180 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(fp);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
/* Degrees, minutes, seconds as printed. Scans and typed reports often use a capital O for the degree sign. */
const DMS = /(latitude|longitude|lat|long)?[:\s]{0,3}(\d{1,3})\s*[°ºO]\s*(\d{1,2}(?:\.\d+)?)\s*['’′]\s*(?:(\d{1,3}(?:\.\d+)?)\s*["”″]?)?\s*([NSEW])?/gi;
function parseDms(text: string) {
  const out: { kind: "lat" | "lon" | null; value: number | null; raw: string; note: string }[] = [];
  for (const m of text.matchAll(DMS)) {
    const label = (m[1] ?? "").toLowerCase(); const deg = Number(m[2]), min = Number(m[3]), sec = m[4] != null ? Number(m[4]) : 0; const hemi = (m[5] ?? "").toUpperCase();
    const kind = label.startsWith("lat") || hemi === "N" || hemi === "S" ? "lat" : label.startsWith("lon") || hemi === "E" || hemi === "W" ? "lon" : deg <= 45 ? "lat" : deg >= 110 && deg <= 160 ? "lon" : null;
    if (!kind) continue;
    const raw = m[0].replace(/^(latitude|longitude|lat|long)[:\s]*/i, "").trim();
    if (min >= 60 || sec >= 60 || /\d\.\d+\s*['’′]\s*\d/.test(raw)) { out.push({ kind, value: null, raw, note: `printed as ${raw}: minutes or seconds out of range, so it can't be read safely` }); continue; }
    let v = deg + min / 60 + sec / 3600; let note = "";
    if (kind === "lat") { if (hemi !== "N") v = -v; if (!hemi) note = "no hemisphere printed; south assumed"; }
    out.push({ kind, value: v, raw, note });
  }
  return out;
}

/* ---------- names ---------- */
const RANK = "Formation|Sandstone|Shale|Group|Subgroup|Supergroup|Member|Beds|Coal Measures|Limestone|Mudstone|Siltstone|Volcanics|Conglomerate";
const RANK_RE = new RegExp(`\\s+(${RANK})$`, "i");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
interface Name { re: RegExp; label: string; type: EntType; nodeId: string | null; variant?: RegExp; base?: string }
let NAMES: Name[] | null = null;
function names(g: KG): Name[] {
  if (NAMES) return NAMES;
  const out: Name[] = [];
  for (const n of g.nodes.values()) {
    if (n.type === "basin") out.push({ re: new RegExp(`\\b${esc(n.label)}\\b`, "gi"), label: n.label, type: "Basin", nodeId: n.id });
    else if (n.type === "play" && n.label.length > 8) out.push({ re: new RegExp(`\\b${esc(n.label)}\\b`, "gi"), label: n.label, type: "Play", nodeId: n.id });
    else if (n.type === "feature" && n.label.length > 7 && !/unnamed/i.test(n.label)) out.push({ re: new RegExp(`\\b${esc(n.label)}\\b`, "gi"), label: n.label, type: "Structural feature", nodeId: n.id });
    else if (n.type === "unit") {
      const base = n.label.replace(RANK_RE, "").replace(/^(upper|lower|middle)\s+/i, "").trim();
      if (base.length < 4 || base.split(" ").length > 3) continue;
      out.push({ re: new RegExp(`\\b${esc(n.label)}\\b`, "gi"), label: n.label, type: "Formation or unit", nodeId: n.id, variant: new RegExp(`\\b(?:upper |lower |middle )?${esc(base)}\\s+(?:${RANK})\\b`, "gi"), base });
    }
  }
  const seenWell = new Set<string>();
  for (const b of BASINS) for (const w of [...b.boreholes].sort((x, y) => Number(y.major) - Number(x.major))) {
    if (!w.name || seenWell.has(w.name)) continue;
    const m = /^(.*?[A-Z]{3,}[A-Z ]*?)[\s-]*(\d{1,3})$/.exec(w.name.trim()); if (!m || m[1].replace(/\s/g, "").length < (w.major ? 4 : 5)) continue;
    seenWell.add(w.name);
    out.push({ re: new RegExp(`\\b${esc(m[1].trim()).replace(/\\? /g, "[\\s-]*")}[\\s#-]*(?:No\\.?\\s*)?0*${m[2]}\\b`, "gi"), label: w.name, type: "Well", nodeId: null });
  }
  NAMES = out; return out;
}
const AGE_RE = /\b(Cambrian|Ordovician|Silurian|Devonian|Carboniferous|Permian|Triassic|Jurassic|Cretaceous|Paleogene|Neogene|Quaternary|\d{1,3}(?:\.\d)?\s?Ma)\b/g;
const PROPOSE_RE = new RegExp(`\\b((?:[A-Z][a-z]{2,}\\s){0,2}[A-Z][a-z]{3,})\\s(${RANK})\\b`, "g");

/* ---------- extraction ---------- */
/* Pure: tags names, ages and places on page texts and splits them into passages, without touching search or the graph.
   The browser runs it on the PDF text layer; the cloud ingestion job runs it on Document Intelligence OCR text. */
export interface PageText { n: number; text: string; ocr: boolean }
export interface Extracted {
  entities: IngestEntity[]; proposed: { name: string; pages: number[] }[]; places: IngestPlace[]; ages: { text: string; pages: number[] }[];
  failures: string[]; passages: IndexedPassage[]; links: { id: string; pred: "describes" | "mentions" }[]; docPoints: DocPoint[];
}
export function extractFromPages(pages: PageText[], g: KG, title: string, docId: string): Extracted {
  const ents = new Map<string, IngestEntity>(); const failures: string[] = [];
  const proposed = new Map<string, number[]>(); const ages = new Map<string, number[]>(); const places: IngestPlace[] = [];
  const add = (key: string, e: Omit<IngestEntity, "pages" | "count" | "confidence">, page: number, conf: IngestEntity["confidence"]) => {
    const cur = ents.get(key);
    if (cur) { cur.count++; if (!cur.pages.includes(page)) cur.pages.push(page); if (!/^Ambiguous/.test(cur.how) && (conf === "high" || (conf === "medium" && cur.confidence === "low"))) cur.confidence = conf; }
    else ents.set(key, { ...e, pages: [page], count: 1, confidence: conf });
  };
  const list = names(g);
  for (const p of pages) {
    if (p.ocr) continue;
    const text = p.text; const low = text.toLowerCase();
    const variantBase = new Map<string, string>();
    for (const n of list) {
      const probe = (n.base ?? n.label).toLowerCase().split(/[\s-]+/)[0];
      if (probe.length >= 3 && !low.includes(probe)) continue;
      n.re.lastIndex = 0; let hit = false;
      for (const m of text.matchAll(n.re)) { hit = true; add(n.label, { label: n.label, found: m[0], type: n.type, nodeId: n.nodeId, how: n.type === "Well" ? "Name matches the GA borehole layer" : "Exact name in the knowledge graph" }, p.n, "high"); }
      if (!hit && n.variant) for (const m of text.matchAll(n.variant)) {
        const key = n.base!.toLowerCase(); const prev = variantBase.get(key);
        if (prev && prev !== n.label) { const e = ents.get(prev); if (e && !/Ambiguous/.test(e.how)) { e.confidence = "low"; e.how = `Ambiguous: "${m[0]}" could be ${prev} or ${n.label}. Check the page.`; } continue; }
        variantBase.set(key, n.label);
        add(n.label, { label: n.label, found: m[0], type: n.type, nodeId: n.nodeId, how: `Name variant: "${m[0]}" read as ${n.label}` }, p.n, "medium");
      }
    }
    for (const m of text.matchAll(AGE_RE)) { const k = m[1].replace(/\s+/g, " "); ages.set(k, [...new Set([...(ages.get(k) ?? []), p.n])]); }
    for (const m of text.matchAll(PROPOSE_RE)) {
      const name = `${m[1]} ${m[2]}`; if (/^(The|This|That|Upper|Lower|Middle|Top|Base|Well|Core|Table|Figure)\b/.test(m[1])) continue;
      const base = m[1].toLowerCase();
      if ([...ents.values()].some((e) => e.label.toLowerCase().includes(base) || e.found.toLowerCase().includes(base))) continue;
      if (list.some((n) => n.type === "Formation or unit" && n.base?.toLowerCase() === base)) continue;
      proposed.set(name, [...new Set([...(proposed.get(name) ?? []), p.n])]);
    }
    // places: MGA easting and northing first, then degrees as printed
    const e = /easting[:\s]*([\d,]{6,9}(?:\.\d+)?)/i.exec(text), nn = /northing[:\s]*([\d,]{7,9}(?:\.\d+)?)/i.exec(text), z = /(?:MGA|zone)\s*Z?\s*(4[89]|5[0-6])\b/i.exec(text);
    const well = [...ents.values()].find((x) => x.type === "Well" && x.pages.includes(p.n));
    const label = well ? well.label : `Page ${p.n}`;
    if (e && nn && z) {
      const [lon, lat] = mgaToLonLat(Number(e[1].replace(/,/g, "")), Number(nn[1].replace(/,/g, "")), Number(z[1]));
      places.push({ label, lon, lat, page: p.n, how: `MGA zone ${z[1]} easting and northing converted to GDA94 latitude and longitude`, check: "", ok: null });
    } else if (e || nn) failures.push(`Page ${p.n}: easting or northing found without a zone, so it was not converted.`);
    const dms = parseDms(text);
    const la = dms.find((d) => d.kind === "lat"), lo = dms.find((d) => d.kind === "lon");
    for (const d of dms) if (d.value == null) failures.push(`Page ${p.n}: ${d.kind === "lat" ? "latitude" : "longitude"} ${d.note}.`);
    if (la?.value != null && lo?.value != null) places.push({ label, lon: lo.value, lat: la.value, page: p.n, how: `Latitude and longitude as printed${la.note ? ` (${la.note})` : ""}`, check: "", ok: null });
    else if (la?.value != null && places.some((x) => x.page === p.n)) { const mp = places.find((x) => x.page === p.n)!; const dKm = Math.abs(mp.lat - la.value) * 111.32; mp.how += `. The printed latitude agrees within ${dKm < 0.1 ? "0.1" : dKm.toFixed(1)} km${la.note ? ` (${la.note})` : ""}`; }
  }
  // wells named in the text but not located in it: use the GA borehole layer
  for (const w of [...ents.values()].filter((x) => x.type === "Well")) {
    if (places.some((p) => p.label === w.label)) continue;
    for (const b of BASINS) { const bh = b.boreholes.find((x) => x.name === w.label); if (bh) { places.push({ label: w.label, lon: bh.lon, lat: bh.lat, page: w.pages[0], how: "Well named in the text, placed from the GA borehole layer", check: "", ok: null }); break; } }
  }
  // checks: inside a basin outline, and agreement with the GA borehole layer
  const namedBasins = new Set([...ents.values()].filter((x) => x.type === "Basin").map((x) => x.label));
  for (const pl of places) {
    if (pl.lat > -9 || pl.lat < -45 || pl.lon < 110 || pl.lon > 160) { pl.ok = false; pl.check = "Outside Australia: check the hemisphere or datum"; continue; }
    const b = basinAt(pl.lon, pl.lat);
    const bh = BASINS.flatMap((x) => x.boreholes).filter((x) => x.name && pl.label.toUpperCase().replace(/[^A-Z0-9]/g, "") === x.name.toUpperCase().replace(/[^A-Z0-9]/g, ""))[0];
    const near = bh ? haversineKm(pl.lon, pl.lat, bh.lon, bh.lat) : null;
    const parts = [b ? `Inside the ${b.name} outline${namedBasins.size && !namedBasins.has(b.name) ? ", a basin the document doesn't name" : ""}` : "Outside the four mapped basin outlines"];
    if (near != null && !/borehole layer/.test(pl.how)) parts.push(`${near < 1 ? `${Math.round(near * 1000)} m` : `${near.toFixed(1)} km`} from ${bh!.name} in the GA borehole layer`);
    pl.check = parts.join("; "); pl.ok = !!b && (near == null || near < 2);
  }
  // search: pages split into passages of about 900 characters
  const textPages = pages.filter((p) => !p.ocr);
  const basinCount = new Map<string, number>();
  for (const e of ents.values()) if (e.type === "Basin" && e.nodeId) { const id = e.nodeId.replace(/^basin:/, ""); if (BASINS.some((b) => b.id === id)) basinCount.set(id, (basinCount.get(id) ?? 0) + e.count); }
  for (const pl of places) { const b = basinAt(pl.lon, pl.lat); if (b) basinCount.set(b.id, (basinCount.get(b.id) ?? 0) + 3); }
  const basin = [...basinCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const passages: IndexedPassage[] = [];
  for (const p of textPages) {
    const paras = p.text.split(/\n(?=[A-Z0-9])/); let buf = ""; let k = 0;
    const flush = () => { const t = buf.replace(/\s+/g, " ").trim(); if (t.length > 40) passages.push({ id: `user:${docId}:p${p.n}:${k++}`, doc: title, page: p.n, h: `${title}, page ${p.n}`, t, basin, kind: "user" } as IndexedPassage); buf = ""; };
    for (const para of paras) { if (buf.length + para.length > 900) flush(); buf += `${para}\n`; }
    flush();
  }
  const links = [...ents.values()].filter((e) => e.nodeId && g.nodes.has(e.nodeId)).map((e) => ({ id: e.nodeId!, pred: (e.type === "Basin" ? "describes" : "mentions") as "describes" | "mentions" }));
  const docPoints: DocPoint[] = places.map((pl, i) => ({ id: `user:${docId}:pt${i}`, lon: pl.lon, lat: pl.lat, label: `${title}: ${pl.label}`, n: 1, passages: passages.filter((x) => x.page === pl.page).map((x) => x.id).slice(0, 3), how: pl.how }));
  return {
    entities: [...ents.values()].sort((a, b) => (a.nodeId ? 0 : 1) - (b.nodeId ? 0 : 1) || b.count - a.count),
    proposed: [...proposed.entries()].map(([name, pg]) => ({ name, pages: pg })).sort((a, b) => b.pages.length - a.pages.length).slice(0, 12),
    places, ages: [...ages.entries()].map(([text, pg]) => ({ text, pages: pg })).sort((a, b) => b.pages.length - a.pages.length).slice(0, 10),
    failures, passages, links, docPoints,
  };
}

/* ---------- main ---------- */
export async function ingestPdf(data: Uint8Array, fileName: string, g: KG, onProgress: (msg: string) => void): Promise<IngestResult> {
  const t0 = performance.now();
  const title = fileName.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim() || "Your document";
  const docId = `user-${Date.now().toString(36)}`;
  const { total, pages } = await readPdf(data, (n, of) => onProgress(`Reading page ${n} of ${of}`));
  const tRead = performance.now();
  onProgress("Tagging names, ages and places");
  const x = extractFromPages(pages, g, title, docId);
  const tExtract = performance.now();
  onProgress("Adding to search, the map and the knowledge graph");
  addPassages(x.passages);
  addDocumentNode(g, { id: docId, title, pages: total, links: x.links, lonlat: x.places[0] ? [x.places[0].lon, x.places[0].lat] : null });
  const tIndex = performance.now();
  const failures = [...x.failures];
  const ocrPages = pages.filter((p) => p.ocr).map((p) => p.n);
  if (ocrPages.length) failures.unshift(`${ocrPages.length} page${ocrPages.length === 1 ? "" : "s"} with no text layer (${ocrPages.slice(0, 8).join(", ")}${ocrPages.length > 8 ? " …" : ""}): these need OCR, a service step in production.`);
  if (total > MAX_PAGES) failures.unshift(`Only the first ${MAX_PAGES} of ${total} pages were read. This prototype stops there to stay quick.`);
  return {
    docId, title, fileName, bytes: data.byteLength, totalPages: total, pages: pages.map(({ text: _t, ...rest }) => rest),
    entities: x.entities, proposed: x.proposed, places: x.places, ages: x.ages,
    failures: [...new Set(failures)], passages: x.passages.length, passageList: x.passages, docPoints: x.docPoints,
    ms: { read: Math.round(tRead - t0), extract: Math.round(tExtract - tRead), index: Math.round(tIndex - tExtract), total: Math.round(tIndex - t0) },
  };
}
/* The bundled sample: a public well data evaluation report (Geological Survey of Queensland, open file CR050039). */
export function dataUrlBytes(u: string): Uint8Array { const b64 = u.slice(u.indexOf(",") + 1); const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
/* The single-file build inlines the sample as a data URL; a dev server serves it as a file. */
export async function loadBytes(u: string): Promise<Uint8Array> { return u.startsWith("data:") ? dataUrlBytes(u) : new Uint8Array(await (await fetch(u)).arrayBuffer()); }
