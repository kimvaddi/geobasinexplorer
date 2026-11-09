import { BASINS } from "@/lib/basins";
import { PACK, WELLS } from "@/lib/pack";

/* Image search over the pictures bundled in this file: core photos and core panels, stratigraphic charts,
   report pages, scanned well pages, seismic pages and velocity enclosures. Images are matched by what is
   written about them (formation, play, well, basin, cited page), and each result says why it matched.
   Matching by what the picture looks like is a later step (see How it's built). */
export type ImageOpen = { type: "well"; id: string; field?: string } | { type: "evidence"; item: "velocity" | "figure" | "core" | "charts" | "pages" };
export interface ImageHit { id: string; src: string; title: string; caption: string; why: string; askAbout?: string; open?: ImageOpen }
interface Entry extends ImageHit { keys: string[]; wellKeys: string[] }

const GENERIC = /\b(play interval|play|formation|sandstone|beds|group|coal measures|member|salt|limestone|shale|unit)\b/gi;
export function nameKeys(name: string): string[] {
  const base = name.toLowerCase().replace(GENERIC, " ").replace(/\s+/g, " ").trim();
  if (!base || /^basement$/.test(base)) return [];
  return base.split(/\s*[-–]\s*/).map((s) => s.trim()).filter((s) => s.length > 3);
}
const fmtDepths = (d?: number[] | null) => (Array.isArray(d) && d.length ? `${Math.min(...d).toLocaleString("en-US")}–${Math.max(...d).toLocaleString("en-US")} m` : "depth not given");
let ENTRIES: Entry[] | null = null;
function entries(): Entry[] {
  if (ENTRIES) return ENTRIES;
  const out: Entry[] = [];
  for (const p of PACK.core.photos) {
    const wells = (Array.isArray(p.wells) ? p.wells : [p.wells]).filter(Boolean) as string[];
    out.push({ id: `photo:${p.id}`, src: p.img, title: `${p.formation} core`, caption: `${wells.join(", ") || "well not given"} · ${fmtDepths(p.depths_m as unknown as number[])}${p.play ? ` · ${p.play}` : ""}`,
      why: "", askAbout: `Tell me about the ${p.formation}`, open: { type: "evidence", item: "core" },
      keys: [...nameKeys(p.formation), ...nameKeys(p.play ?? "")], wellKeys: wells.map((w) => w.toLowerCase()) });
  }
  for (const pn of PACK.core.panels) {
    const strips = PACK.core.strips.filter((s) => s.panel === pn.id);
    const units = [...new Set(strips.map((s) => s.unit))]; const wells = [...new Set(strips.map((s) => s.well))];
    out.push({ id: `panel:${pn.id}`, src: pn.img, title: `${pn.title} core panel`, caption: `Cooper Basin · ${units.join(", ")} · ${wells.join(", ")}`,
      why: "", askAbout: units[0] ? `Tell me about the ${units[0]}` : undefined, open: { type: "evidence", item: "core" },
      keys: [...nameKeys(pn.title), ...units.flatMap(nameKeys)], wellKeys: wells.map((w) => w.toLowerCase()) });
  }
  ENTRIES = out; return out;
}
const has = (text: string, key: string) => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

/* Pages and enclosures cited by an answer. */
function citedImages(cites: { id: string; doc: string; page: number }[]): ImageHit[] {
  const out: ImageHit[] = [];
  for (const c of cites) {
    if (/^Cooper report$/.test(c.doc) && c.page) {
      const pg = PACK.reportPages.find((r) => r.page === c.page);
      if (pg) out.push({ id: `report:${pg.page}`, src: pg.img, title: `Cooper Basin data guide, page ${pg.page}`, caption: "Geoscience Australia, eCat 147461", why: "Page cited in the answer", open: { type: "evidence", item: "pages" } });
    }
    const m = /^(innamincka-1|marabooka-1):(.+)$/.exec(c.id);
    if (m) {
      const site = WELLS.find((w) => w.siteId === m[1]); const f = site?.fields.find((x) => x.fieldId === m[2]);
      const pg = site && f ? site.pages.find((p) => (f.pageId ? p.pageId === f.pageId : p.docId === f.docId && p.page === f.page)) : null;
      if (site && pg?.img) out.push({ id: `wellpage:${pg.pageId}`, src: pg.img, title: `${site.name}, page ${pg.page}`, caption: pg.caption, why: "Page the value was read from", open: { type: "well", id: site.siteId, field: f?.fieldId } });
    }
    const fg = /^mar:p(313|314|316)$/.exec(c.id);
    if (fg) { const f = PACK.figures.find((x) => x.page === Number(fg[1])); if (f) out.push({ id: `figure:${f.page}`, src: f.img, title: f.title, caption: `Marabooka 1 report, page ${f.page}`, why: "Page cited in the answer", open: { type: "evidence", item: "figure" } }); }
    if (/^mar:(cs|tz|tool)/.test(c.id) && PACK.velocity) {
      const item = PACK.velocity.items.find((i) => (/^mar:cs/.test(c.id) ? i.itemId === "checkshot-table" : i.itemId === "tz-diagram"));
      const im = item?.images[item.itemId === "tz-diagram" ? Math.min(1, item.images.length - 1) : 0];
      if (item && im) out.push({ id: `vel:${item.itemId}`, src: im.img, title: item.itemId === "tz-diagram" ? "Time–depth chart (Enclosure 2)" : "Checkshot table (Enclosure 1)", caption: im.caption, why: "Enclosure cited in the answer", open: { type: "evidence", item: "velocity" } });
    }
  }
  return out;
}

export function imagesFor(question: string, answerText: string, cites: { id: string; doc: string; page: number }[], basin: string | null, max = 6): ImageHit[] {
  const seen = new Set<string>(); const out: ImageHit[] = [];
  const push = (h: ImageHit) => { if (!seen.has(h.id) && out.length < max) { seen.add(h.id); out.push(h); } };
  citedImages(cites).forEach(push);
  // formation and play names in the question first, then in the answer; well names only when the question asks for cores or photos
  const wantsCore = /\b(cores?|photos?|photographs?|images?|pictures?)\b/i.test(question);
  for (const [text, where] of [[question, "question"], [answerText, "answer"]] as const) {
    for (const e of entries()) {
      const k = e.keys.find((key) => has(text, key));
      if (k) { push({ ...e, why: `Name “${k.replace(/\b\w/g, (c) => c.toUpperCase())}” in the ${where}` }); continue; }
      const w = wantsCore && where === "question" ? e.wellKeys.find((key) => has(text, key)) : undefined;
      if (w) push({ ...e, why: `Well “${w.replace(/\b\w/g, (c) => c.toUpperCase())}” in the question` });
    }
  }
  // stratigraphic charts when the question is about the succession of a basin
  const named = BASINS.filter((b) => has(question, b.short) || has(question, b.name.replace(/ Basin$/, "")));
  const chartBasins = /\b(stratigraph\w*|chart|framework|succession|how old|age of|units|formations)\b/i.test(question) ? (named.length ? named.map((b) => b.id) : basin ? [basin] : []) : [];
  for (const id of chartBasins) { const ch = PACK.charts.find((c) => c.basin === id); if (ch) push({ id: `chart:${ch.id}`, src: ch.img, title: ch.title, caption: `Geoscience Australia ${ch.id}`, why: "Chart for the basin in the question", open: { type: "evidence", item: "charts" } }); }
  return out;
}
/* Charts and core photos for a list of plays (used by the hypothesis test). */
export function imagesForPlays(names: string[], basins: string[], max = 6): ImageHit[] {
  const out: ImageHit[] = []; const seen = new Set<string>();
  for (const n of names) { const keys = nameKeys(n); for (const e of entries()) { if (out.length >= max) break; const k = e.keys.find((x) => keys.includes(x)); if (k && !seen.has(e.id)) { seen.add(e.id); out.push({ ...e, why: `Core from the ${n.replace(/ Play$/, "")} interval` }); } } }
  for (const id of basins) { const ch = PACK.charts.find((c) => c.basin === id); if (ch && out.length < max && !seen.has(ch.id)) { seen.add(ch.id); out.push({ id: `chart:${ch.id}`, src: ch.img, title: ch.title, caption: `Geoscience Australia ${ch.id}`, why: "Stratigraphic chart for the comparison", open: { type: "evidence", item: "charts" } }); } }
  return out;
}
export function velocityImage(): ImageHit | null {
  const item = PACK.velocity?.items.find((i) => i.itemId === "tz-diagram"); const im = item?.images[Math.min(1, (item?.images.length ?? 1) - 1)];
  return item && im ? { id: "vel:tz-diagram", src: im.img, title: "Time–depth chart (Enclosure 2)", caption: im.caption, why: "Formation tops used in the test", open: { type: "evidence", item: "velocity" } } : null;
}
