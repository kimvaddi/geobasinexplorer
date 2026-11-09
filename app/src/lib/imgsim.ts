import type { KG } from "@/lib/kg";

/* Look-alike image search over the bundled core images. Each picture is reduced in the browser to
   colour and texture histograms (hue, saturation, brightness, edge strength at two scales, edge
   direction). Two pictures match when their histograms overlap. This stands in for AI image
   embeddings: it sees colour, banding and grain, and knows nothing about geology. */

export interface ImgItem {
  id: string; nodeId: string | null; src: string; title: string; sub: string; kind: "Photo" | "Panel" | "Strip" | "Report photo";
  basin: string | null; unit: string | null; play: string | null; wells: string[]; top: number | null; base: number | null; source: string;
}
const num = (s: string | undefined) => { if (!s) return null; const v = parseFloat(s.replace(/,/g, "")); return Number.isFinite(v) ? v : null; };
export function imageItems(g: KG, extras: ImgItem[] = []): ImgItem[] {
  const out: ImgItem[] = [];
  for (const n of g.nodes.values()) {
    if (n.type !== "core" || !n.img) continue;
    const kind: ImgItem["kind"] = /^core:CP\d\d$/.test(n.id) ? "Panel" : /^core:CP\d\d-\d+$/.test(n.id) ? "Strip" : "Photo";
    const rel = (p: string) => (g.out.get(n.id) ?? []).filter((e) => e.p === p).map((e) => g.nodes.get(e.o)!.label);
    const prop = (k: string) => n.props.find(([a]) => a === k)?.[1];
    let top: number | null = null, base: number | null = null;
    const dep = prop("Depth") ?? prop("Depths");
    if (dep) { const m = /([\d,.]+)\s*–\s*([\d,.]+)/.exec(dep); if (m) { top = num(m[1]); base = num(m[2]); } }
    out.push({ id: n.id, nodeId: n.id, src: n.img, title: n.label, sub: n.sub ?? "", kind, basin: n.basin, unit: rel("depictsUnit")[0] ?? (kind === "Strip" ? prop("Unit") ?? null : prop("Formation") ?? null),
      play: rel("depictsPlay")[0] ?? null, wells: rel("fromBorehole"), top, base, source: n.source.title });
  }
  return [...out, ...extras];
}

/* ---------- features ---------- */
const BLOCKS = [["hue", 12, 0.25], ["sat", 4, 0.1], ["val", 6, 0.2], ["mag", 8, 0.2], ["ori", 8, 0.15], ["coarse", 8, 0.1]] as const;
const LEN = BLOCKS.reduce((s, b) => s + b[1], 0);
/* The caller owns a 96 x 96 off-screen buffer (a hidden, non-drawing canvas) and passes its context. */
export type Ctx2D = CanvasRenderingContext2D;
export function featureFrom(img: CanvasImageSource, w: number, h: number, ctx: Ctx2D | null): Float32Array {
  const s = 96 / Math.max(w, h, 1); const cw = Math.max(8, Math.min(96, Math.round(w * s))), ch = Math.max(8, Math.min(96, Math.round(h * s)));
  const f = new Float32Array(LEN); if (!ctx) return f;
  ctx.clearRect(0, 0, 96, 96); ctx.drawImage(img, 0, 0, cw, ch);
  const d = ctx.getImageData(0, 0, cw, ch).data;
  const gray = new Float32Array(cw * ch); const keep = new Uint8Array(cw * ch);
  let o = 0; const off = { hue: 0, sat: 12, val: 16, mag: 22, ori: 30, coarse: 38 };
  for (let i = 0; i < cw * ch; i++) {
    const r = d[i * 4] / 255, gg = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), v = mx, sa = mx ? (mx - mn) / mx : 0;
    gray[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    if ((v > 0.93 && sa < 0.08) || v < 0.04) continue; // paper, labels and black borders
    keep[i] = 1; o++;
    let hh = 0; const c = mx - mn;
    if (c > 0) { hh = mx === r ? ((gg - b) / c) % 6 : mx === gg ? (b - r) / c + 2 : (r - gg) / c + 4; hh = (hh * 60 + 360) % 360; }
    if (sa > 0.12) f[off.hue + Math.min(11, Math.floor(hh / 30))] += sa;
    f[off.sat + Math.min(3, Math.floor(sa * 4))] += 1;
    f[off.val + Math.min(5, Math.floor(v * 6))] += 1;
  }
  const grad = (src: Float32Array, W: number, H: number, mag: number, ori: number | null) => {
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (W === cw && !keep[i]) continue;
      const gx = src[i + 1] - src[i - 1], gy = src[i + W] - src[i - W]; const m = Math.hypot(gx, gy);
      f[mag + Math.min(7, Math.floor(Math.sqrt(m / 0.6) * 8))] += 1;
      if (ori != null && m > 0.04) f[ori + Math.min(7, Math.floor((((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180) / 22.5))] += m;
    }
  };
  grad(gray, cw, ch, off.mag, off.ori);
  const W2 = Math.floor(cw / 2), H2 = Math.floor(ch / 2); const g2 = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) g2[y * W2 + x] = (gray[2 * y * cw + 2 * x] + gray[2 * y * cw + 2 * x + 1] + gray[(2 * y + 1) * cw + 2 * x] + gray[(2 * y + 1) * cw + 2 * x + 1]) / 4;
  grad(g2, W2, H2, off.coarse, null);
  let k = 0;
  for (const [, n] of BLOCKS) { let s2 = 0; for (let j = 0; j < n; j++) s2 += f[k + j]; if (s2 > 0) for (let j = 0; j < n; j++) f[k + j] /= s2; k += n; }
  void o; return f;
}
export function similarity(a: Float32Array, b: Float32Array): number {
  let k = 0, s = 0;
  for (const [, n, wgt] of BLOCKS) { let inter = 0; for (let j = 0; j < n; j++) inter += Math.min(a[k + j], b[k + j]); s += wgt * inter; k += n; }
  return s;
}
const CACHE = new Map<string, Float32Array>();
const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("image")); im.src = src; });
export async function featureOf(it: { id: string; src: string }, ctx: Ctx2D | null): Promise<Float32Array> {
  const c = CACHE.get(it.id); if (c) return c;
  const im = await load(it.src); const f = featureFrom(im, im.naturalWidth, im.naturalHeight, ctx); CACHE.set(it.id, f); return f;
}
/* Features for every item, a few at a time so the page stays responsive. */
export async function allFeatures(items: ImgItem[], ctx: Ctx2D | null, progress?: (n: number, total: number) => void): Promise<{ map: Map<string, Float32Array>; ms: number }> {
  const t0 = performance.now(); const map = new Map<string, Float32Array>(); let n = 0;
  for (const it of items) {
    try { map.set(it.id, await featureOf(it, ctx)); } catch { /* skip unreadable image */ }
    n++; if (n % 8 === 0) { progress?.(n, items.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  progress?.(items.length, items.length);
  return { map, ms: Math.round(performance.now() - t0) };
}
export async function featureOfFile(file: Blob, ctx: Ctx2D | null): Promise<{ f: Float32Array; url: string }> {
  const url = URL.createObjectURL(file); const im = await load(url);
  return { f: featureFrom(im, im.naturalWidth, im.naturalHeight, ctx), url };
}
export function rankSimilar(q: Float32Array, map: Map<string, Float32Array>, skip?: string, k = 12): { id: string; score: number }[] {
  const r: { id: string; score: number }[] = [];
  for (const [id, f] of map) if (id !== skip) r.push({ id, score: similarity(q, f) });
  return r.sort((a, b) => b.score - a.score).slice(0, k);
}
