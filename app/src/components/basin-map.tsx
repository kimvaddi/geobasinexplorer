import { useCallback, useEffect, useMemo, useRef } from "react";
import { BASINS, BASEMAP, basinAt, depthAt, depthToT, isNoData, ramp, type Basin, type Borehole, type LonLat } from "@/lib/basins";

/* Custom canvas map (Web Mercator) for the four basins, drawn offline: shaded relief, coastline, GA basin
   outlines with a depth tint from the depth-to-base grids, faults, folds, boreholes, bundled 2D seismic lines,
   World Stress Map SHmax ticks, the GA data-confidence overlay, evidence wells, notes pins, answer
   highlights and the "what we know here" marker. All coordinates are GDA94 geographic. */
export type SiteKind = "legacy" | "co2" | "geo" | "context";
export const SITE_COLORS: Record<SiteKind, string> = { legacy: "#f6b26b", co2: "#7fd1ae", geo: "#ff8a65", context: "#E0F2FE" };

export interface MapPin { id: string; lon: number; lat: number; label: string }
export interface FlyRequest { seq: number; lon: number; lat: number; zoom: number; ringKm?: number; label?: string }
export interface MapLayers { depth: boolean; faults: boolean; boreholes: boolean; stress: boolean; conf: boolean; seismic: boolean; sites: boolean; docs: boolean; temp: boolean }
export interface DocMarker { id: string; lon: number; lat: number; n: number; label: string }
export interface SiteMarker { id: string; lon: number; lat: number; label: string; tag: string; kind: SiteKind }
export interface ConfOverlay { src: string; bounds: [number, number, number, number] }
export interface HoverInfo { lon: number; lat: number; basin: string | null; depth: number | null; site: string | null }
export interface BhFilter { minTd: number; y0: number; y1: number; insideOnly: boolean }
export const YEAR_MIN = 1880, YEAR_MAX = 2025;
export const NO_FILTER: BhFilter = { minTd: 0, y0: YEAR_MIN, y1: YEAR_MAX, insideOnly: false };
export const filterOn = (f: BhFilter | null | undefined) => !!f && (f.minTd > 0 || f.y0 > YEAR_MIN || f.y1 < YEAR_MAX || f.insideOnly);
export function passFilter(w: Borehole, f: BhFilter) {
  if (f.minTd > 0 && (w.td ?? -1) < f.minTd) return false;
  if ((f.y0 > YEAR_MIN || f.y1 < YEAR_MAX) && (w.year == null || w.year < f.y0 || w.year > f.y1)) return false;
  if (f.insideOnly && !w.inside) return false;
  return true;
}

export interface BasinMapProps {
  selected: string | null;
  fly: FlyRequest | null;
  highlight: Set<string>;
  pins: MapPin[];
  activePin: string | null;
  layers: MapLayers;
  tagMode: boolean;
  sites?: SiteMarker[];
  activeSite?: string | null;
  overlay?: ConfOverlay | null;
  seismic?: LonLat[][];
  here?: { lon: number; lat: number } | null;
  bhFilter?: BhFilter | null;
  depthLens?: [number, number] | null;
  docPoints?: DocMarker[];
  activeDoc?: string | null;
  onSelectDoc?: (id: string) => void;
  section?: { a: LonLat; b: LonLat | null } | null;
  /** The path the spatial service measured (a geodesic); without it the line runs straight from A to B. */
  sectionPath?: LonLat[] | null;
  sectionPick?: boolean;
  onSectionPick?: (lon: number, lat: number) => void;
  /** A drawn area: its corners so far, and whether it is finished (closed). */
  area?: { pts: LonLat[]; closed: boolean } | null;
  /** Drawing an area: clicks place corners instead of opening "What we know here". */
  areaPick?: boolean;
  /** A click while drawing an area. `at` is "first" on the first corner, which closes the area, and "last" on the corner
      just placed, as the second click of a double-click is. */
  onAreaPick?: (lon: number, lat: number, at: "first" | "last" | null) => void;
  /** A double-click while drawing finishes the area. */
  onAreaFinish?: () => void;
  tempOverlay?: ConfOverlay | null;
  onContextPick?: (lon: number, lat: number) => void;
  onPickHere?: (lon: number, lat: number) => void;
  onSelectSite?: (id: string) => void;
  onSelectBasin: (id: string) => void;
  onSelectBorehole: (b: Borehole) => void;
  onSelectPin: (id: string) => void;
  onPick: (lon: number, lat: number) => void;
  onHover: (info: HoverInfo | null) => void;
  onViewChange?: (zoom: number) => void;
  controlRef?: React.MutableRefObject<MapControl | null>;
  /** Which map is drawing: Azure Maps, or this canvas map (offline, or when Azure Maps can't load). */
  onEngine?: (engine: "azure" | "canvas") => void;
  /** The map changed its own base map (Esri tiles stopped being available), so the base-map menu follows it. */
  onBaseMap?: (id: string) => void;
  /** The map turned the Planetary Computer overlay off because its tiles stopped coming, so the layer panel follows it. */
  onOverlayOff?: () => void;
}
/* Tile layers for a base map that this app relays (Esri, cloud build only): `overlay` layers such as place names go above
   the app's lines and tints, the rest below everything. */
export interface BaseTiles { id: string; size: 256 | 512; maxZoom: number; overlay: boolean }
/* A Planetary Computer overlay that this app relays (cloud build, with an Esri base map only): one at a time, drawn over
   the base map and under the app's own layers, and only inside its bounds and zoom range. */
export interface OverlayTiles { id: string; label: string; size: 512; minZoom: number; maxZoom: number; bounds: [number, number, number, number] }
export interface MapControl { zoomBy: (d: number) => void; reset: () => void; setBaseMap?: (id: string, tiles?: BaseTiles[]) => void; setOverlay?: (o: OverlayTiles | null, opacity: number) => void }
/* Azure Maps base map styles offered in the cloud build (the offline canvas map draws its own relief). */
export const BASE_MAPS = [
  { id: "grayscale_dark", label: "Dark" },
  { id: "night", label: "Night" },
  { id: "road_shaded_relief", label: "Terrain" },
  { id: "satellite_road_labels", label: "Satellite" },
] as const;
/* The style a visit starts on, and the one the map returns to when Esri falls away: satellite imagery with roads and
   labels from 0.13.44, Dark before. */
export const DEFAULT_BASE_MAP: (typeof BASE_MAPS)[number]["id"] = "satellite_road_labels";
/* A drawn area reads on dark maps, Esri imagery and the Planetary Computer overlays alike: cyan with a dark casing. */
export const AREA_STROKE = "#22d3ee", AREA_FILL = "rgba(34,211,238,0.14)", AREA_CORNER = "#0e7490";
/* How long the rest of the gesture that closed an area is ignored: longer than a double-click's interval. */
export const AREA_SETTLE_MS = 600;
/* Whether a click while drawing lands on the first corner (with three or more placed, it closes the area) or on the
   corner just placed (the second click of a double-click, which only finishes). */
export function areaHit(pts: LonLat[], toPx: (q: LonLat) => [number, number], x: number, y: number): "first" | "last" | null {
  if (!pts.length) return null;
  const d = (q: LonLat) => { const [px, py] = toPx(q); return Math.hypot(px - x, py - y); };
  if (pts.length >= 3 && d(pts[0]) < 11) return "first";
  return d(pts[pts.length - 1]) < 6 ? "last" : null;
}

const RAD = Math.PI / 180;
const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI) / 2;
const unx = (x: number) => x * 360 - 180;
const uny = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;
export const HOME = { lon: 144.9, lat: -24.4, zoom: 5.45 };
export function depthPixels(b: Basin, lens?: [number, number] | null): ImageData {
  const { w, h, grid } = b.depth;
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = grid[i];
    if (isNoData(v)) continue;
    if (lens && (v < lens[0] || v > lens[1])) { img.data[i * 4] = 40; img.data[i * 4 + 1] = 40; img.data[i * 4 + 2] = 70; img.data[i * 4 + 3] = 70; continue; }
    const [r, g, bb] = ramp(depthToT(v));
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = bb; img.data[i * 4 + 3] = 205;
  }
  return img;
}

export function BasinMap(p: BasinMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef({ cx: mx(HOME.lon), cy: my(HOME.lat), z: HOME.zoom, w: 800, h: 600, dpr: 1 });
  const props = useRef(p);
  props.current = p;
  const ring = useRef<FlyRequest | null>(null);
  const raf = useRef(0);
  const anim = useRef<{ t0: number; from: { cx: number; cy: number; z: number }; to: { cx: number; cy: number; z: number } } | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const areaCursor = useRef<[number, number] | null>(null);
  /* A click on the first corner or a double-click closes an area; the rest of that gesture (the second click of a
     double-click, or a third) must not open "What we know here" or zoom, so it is ignored until this time. */
  const areaSettle = useRef(0);

  const relief = useMemo(() => { const im = new Image(); im.src = BASEMAP.relief.src; return im; }, []);
  const overlaySrc = p.overlay?.src ?? "";
  const overlayImg = useMemo(() => { if (!overlaySrc) return null; const im = new Image(); im.src = overlaySrc; return im; }, [overlaySrc]);
  const tempSrc = p.tempOverlay?.src ?? "";
  const tempImg = useMemo(() => { if (!tempSrc) return null; const im = new Image(); im.src = tempSrc; return im; }, [tempSrc]);
  const depthImgs = useRef(new Map<string, ImageBitmap>());

  const toScreen = useCallback((lon: number, lat: number): [number, number] => {
    const v = view.current; const S = 256 * 2 ** v.z;
    return [(mx(lon) - v.cx) * S + v.w / 2, (my(lat) - v.cy) * S + v.h / 2];
  }, []);
  const toLonLat = useCallback((x: number, y: number): LonLat => {
    const v = view.current; const S = 256 * 2 ** v.z;
    return [unx((x - v.w / 2) / S + v.cx), uny((y - v.h / 2) / S + v.cy)];
  }, []);

  const draw = useCallback(() => {
    raf.current = 0;
    const cv = document.getElementById("basin-map-canvas") as HTMLCanvasElement | null; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const v = view.current; const P = props.current;
    if (anim.current) {
      const k = Math.min(1, (performance.now() - anim.current.t0) / 900);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      const { from, to } = anim.current;
      v.cx = from.cx + (to.cx - from.cx) * e; v.cy = from.cy + (to.cy - from.cy) * e; v.z = from.z + (to.z - from.z) * e;
      if (k >= 1) { anim.current = null; P.onViewChange?.(v.z); } else raf.current = requestAnimationFrame(draw);
    }
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.fillStyle = "#061520"; ctx.fillRect(0, 0, v.w, v.h);
    const S = 256 * 2 ** v.z;
    const line = (pts: LonLat[], close = false) => {
      pts.forEach((q, i) => { const [x, y] = toScreen(q[0], q[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (close) ctx.closePath();
    };
    const strips = (img: CanvasImageSource, iw: number, ih: number, lon0: number, lat0: number, lon1: number, lat1: number) => {
      // equirectangular image → Mercator: contiguous strips on whole-pixel edges (no overlaps, no gaps)
      const n = 32; const x0 = Math.round(toScreen(lon0, lat0)[0]); const x1 = Math.round(toScreen(lon1, lat0)[0]);
      let ya = Math.round(toScreen(lon0, lat0)[1]);
      for (let i = 0; i < n; i++) {
        const lb = lat0 + ((lat1 - lat0) * (i + 1)) / n;
        const yb = Math.round(toScreen(lon0, lb)[1]);
        if (yb > ya && yb > 0 && ya < v.h) ctx.drawImage(img, 0, (ih * i) / n, iw, ih / n, x0, ya, x1 - x0, yb - ya);
        ya = yb;
      }
    };
    // relief basemap (equirectangular image drawn in Mercator strips)
    if (relief.complete && relief.naturalWidth) {
      const [l0, b0, l1, t1] = BASEMAP.relief.bbox;
      strips(relief, relief.naturalWidth, relief.naturalHeight, l0, t1, l1, b0);
      ctx.fillStyle = "rgba(12,11,40,0.62)"; ctx.fillRect(0, 0, v.w, v.h);
    }
    // GA data-confidence overlay (equirectangular image, drawn in Mercator strips)
    const ov = P.overlay;
    if (P.layers.conf && ov && overlayImg && overlayImg.complete && overlayImg.naturalWidth) {
      const [w0, s0, e0, n0] = ov.bounds;
      ctx.save(); ctx.globalAlpha = v.z > 7 ? 0.5 : 0.62; ctx.imageSmoothingEnabled = true;
      strips(overlayImg, overlayImg.naturalWidth, overlayImg.naturalHeight, w0, n0, e0, s0);
      ctx.restore();
    }
    const tv = P.tempOverlay;
    if (P.layers.temp && tv && tempImg && tempImg.complete && tempImg.naturalWidth) {
      const [w0, s0, e0, n0] = tv.bounds;
      ctx.save(); ctx.globalAlpha = 0.6; ctx.imageSmoothingEnabled = true;
      strips(tempImg, tempImg.naturalWidth, tempImg.naturalHeight, w0, n0, e0, s0);
      ctx.restore();
    }
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(161,221,252,0.32)"; ctx.lineWidth = 1;
    ctx.beginPath(); BASEMAP.coast.forEach((l) => line(l)); ctx.stroke();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.beginPath(); BASEMAP.states.forEach((l) => line(l)); ctx.stroke(); ctx.setLineDash([]);
    if (v.z < 6.5) {
      ctx.font = "600 11px Geist Variable, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(255,255,255,0.32)";
      BASEMAP.stateLabels.filter((s) => !/capital|jervis/i.test(s.name)).forEach((s) => { const [x, y] = toScreen(s.lon, s.lat); ctx.fillText(s.name.toUpperCase(), x, y); });
    }
    // basins
    for (const b of BASINS) {
      const sel = P.selected === b.id;
      if (P.layers.depth) {
        const d = b.depth; const im = depthImgs.current.get(b.id);
        if (im) {
          ctx.save(); ctx.beginPath(); b.outline.forEach((r) => line(r, true)); ctx.clip("evenodd");
          ctx.imageSmoothingEnabled = true;
          strips(im, d.w, d.h, d.x0, d.y0, d.x0 + d.dx * d.w, d.y0 + d.dy * d.h);
          ctx.restore();
        }
      } else {
        ctx.fillStyle = sel ? "rgba(161,221,252,0.16)" : "rgba(161,221,252,0.07)";
        ctx.beginPath(); b.outline.forEach((r) => line(r, true)); ctx.fill("evenodd");
      }
      ctx.save(); ctx.shadowColor = "rgba(161,221,252,0.9)"; ctx.shadowBlur = sel ? 14 : 7;
      ctx.strokeStyle = sel ? "#ffffff" : "rgba(207,237,253,0.85)"; ctx.lineWidth = sel ? 2.4 : 1.4;
      ctx.beginPath(); b.outline.forEach((r) => line(r, true)); ctx.stroke(); ctx.restore();
    }
    if (P.layers.faults && v.z >= 5) {
      ctx.strokeStyle = "rgba(251,232,204,0.6)"; ctx.lineWidth = v.z > 7 ? 1.2 : 0.8;
      ctx.beginPath(); BASINS.forEach((b) => b.faults.forEach((f) => line(f))); ctx.stroke();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(205,244,214,0.7)";
      ctx.beginPath(); BASINS.forEach((b) => b.folds.forEach((f) => line(f.p))); ctx.stroke(); ctx.setLineDash([]);
    }
    if (P.layers.seismic && P.seismic && v.z >= 4.8) {
      ctx.strokeStyle = "rgba(161,221,252,0.55)"; ctx.lineWidth = v.z > 7.5 ? 1 : 0.7;
      ctx.beginPath(); P.seismic.forEach((l) => line(l)); ctx.stroke();
    }
    const F = P.bhFilter; const fOn = filterOn(F);
    if (P.layers.boreholes && (v.z >= 5.9 || (fOn && v.z >= 4.6))) {
      // semantic zoom: named/major wells first, every public borehole once zoomed in; a filter shows every match
      const all = v.z >= 7 || fOn;
      const r = v.z > 8.5 ? 2.2 : v.z > 7.5 ? 1.6 : 1.1;
      for (const b of BASINS) for (const w of b.boreholes) {
        if (fOn && !passFilter(w, F!)) continue;
        if (!all && !w.major) continue;
        const [x, y] = toScreen(w.lon, w.lat);
        if (x < -4 || y < -4 || x > v.w + 4 || y > v.h + 4) continue;
        ctx.fillStyle = w.major ? "rgba(205,244,214,0.9)" : w.inside ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.22)";
        const rr = w.major && all ? r + 0.5 : r; ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
    }
    if (P.highlight.size) {
      ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1.6;
      for (const b of BASINS) for (const w of b.boreholes) {
        if (!P.highlight.has(w.key)) continue;
        const [x, y] = toScreen(w.lon, w.lat);
        ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (P.layers.stress) {
      for (const b of BASINS) for (const s of b.stress) {
        const [x, y] = toScreen(s[0], s[1]); const good = "ABC".includes(s[3]);
        const len = good ? 9 : 6; const a = s[2] * RAD; const dx = Math.sin(a) * len, dy = -Math.cos(a) * len;
        ctx.strokeStyle = good ? "rgba(255,155,113,0.95)" : "rgba(255,155,113,0.45)"; ctx.lineWidth = good ? 2 : 1.2;
        ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
      }
    }
    // tagged documents: one marker per place, sized by the number of passages
    if (P.layers.docs && P.docPoints && v.z >= 4.6) {
      for (const d of P.docPoints) {
        const [x, y] = toScreen(d.lon, d.lat); if (x < -10 || y < -10 || x > v.w + 10 || y > v.h + 10) continue;
        const act = d.id === P.activeDoc; const r = Math.min(9, 3.5 + Math.log2(1 + d.n) * 1.6) + (act ? 2 : 0);
        ctx.save(); ctx.fillStyle = act ? "#ffffff" : "rgba(205,244,214,0.95)"; ctx.strokeStyle = "rgba(7,7,28,0.95)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect(x - r * 0.8, y - r, r * 1.6, r * 2, 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = "rgba(15,43,61,0.8)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - r * 0.45, y - r * 0.35); ctx.lineTo(x + r * 0.45, y - r * 0.35); ctx.moveTo(x - r * 0.45, y + r * 0.15); ctx.lineTo(x + r * 0.45, y + r * 0.15); ctx.stroke();
        if (d.n > 1 && v.z >= 6) { ctx.font = "700 9.5px Geist Variable, system-ui, sans-serif"; ctx.fillStyle = "#ffffff"; ctx.textAlign = "left"; ctx.fillText(String(d.n), x + r * 0.9, y - r * 0.6); }
        ctx.restore();
      }
    }
    // cross-section line
    if (P.section) {
      const [ax, ay] = toScreen(P.section.a[0], P.section.a[1]);
      ctx.save(); ctx.fillStyle = "#C2410C"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
      if (P.section.b) {
        const [bx, by] = toScreen(P.section.b[0], P.section.b[1]);
        const path = P.sectionPath?.length ? P.sectionPath : [P.section.a, P.section.b];
        ctx.setLineDash([8, 5]); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 4; ctx.beginPath(); line(path); ctx.stroke();
        ctx.strokeStyle = "#C2410C"; ctx.lineWidth = 2.2; ctx.beginPath(); line(path); ctx.stroke(); ctx.setLineDash([]);
        for (const [x, y, t] of [[ax, ay, "A"], [bx, by, "B"]] as [number, number, string][]) { ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = "#C2410C"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.stroke(); ctx.fillStyle = "#fff"; ctx.font = "700 11px Geist Variable, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(t, x, y + 0.5); }
      } else { ctx.beginPath(); ctx.arc(ax, ay, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#fff"; ctx.font = "700 11px Geist Variable, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("A", ax, ay + 0.5); }
      ctx.restore(); ctx.textBaseline = "alphabetic";
    }
    // drawn area: its fill and outline, and while drawing, its corners and the line on to the pointer
    const ar = P.area;
    if (ar?.pts.length) {
      const pts = ar.pts; ctx.save();
      if (pts.length >= 3) { ctx.fillStyle = AREA_FILL; ctx.beginPath(); line(pts, true); ctx.fill(); }
      const path = ar.closed ? [...pts, pts[0]] : pts;
      if (path.length >= 2) {
        ctx.strokeStyle = "rgba(7,7,28,0.85)"; ctx.lineWidth = 4.5; ctx.beginPath(); line(path); ctx.stroke();
        ctx.strokeStyle = AREA_STROKE; ctx.lineWidth = 2.2; ctx.beginPath(); line(path); ctx.stroke();
      }
      const cur = areaCursor.current;
      if (!ar.closed && P.areaPick && cur) {
        const [lx, ly] = toScreen(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.setLineDash([5, 4]); ctx.strokeStyle = AREA_STROKE; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(cur[0], cur[1]);
        if (pts.length >= 2) { const [fx, fy] = toScreen(pts[0][0], pts[0][1]); ctx.lineTo(fx, fy); }
        ctx.stroke(); ctx.setLineDash([]);
      }
      if (!ar.closed) pts.forEach((q, i) => {
        const [x, y] = toScreen(q[0], q[1]);
        ctx.beginPath(); ctx.arc(x, y, i === 0 && pts.length >= 3 ? 6.5 : 4.5, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.strokeStyle = AREA_CORNER; ctx.lineWidth = 2; ctx.stroke();
      });
      ctx.restore();
    }
    // answer ring
    const rg = ring.current;
    if (rg && rg.ringKm) {
      const [x, y] = toScreen(rg.lon, rg.lat);
      const pxPerKm = S / (40075.017 * Math.cos(rg.lat * RAD));
      ctx.save(); ctx.setLineDash([6, 5]); ctx.strokeStyle = "rgba(255,209,102,0.95)"; ctx.lineWidth = 2;
      ctx.fillStyle = "rgba(255,209,102,0.10)"; ctx.beginPath(); ctx.arc(x, y, rg.ringKm * pxPerKm, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
      ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    // labels
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    const halo = (t: string, x: number, y: number, font: string, fill: string) => {
      ctx.font = font; ctx.strokeStyle = "rgba(7,7,28,0.85)"; ctx.lineWidth = 3.5; ctx.strokeText(t, x, y); ctx.fillStyle = fill; ctx.fillText(t, x, y);
    };
    type Box = [number, number, number, number];
    const hit = (a: Box, list: Box[]) => list.some((d) => a[0] < d[2] && a[2] > d[0] && a[1] < d[3] && a[3] > d[1]);
    const basinFont = `700 ${v.z > 7 ? 15 : 13}px Geist Variable, system-ui, sans-serif`;
    ctx.font = basinFont;
    const basinBoxes: Box[] = BASINS.map((b) => {
      const [x, y] = toScreen(b.labelAt[0], b.labelAt[1]); const w = ctx.measureText(b.short.toUpperCase()).width;
      return [x - w / 2 - 2, y - 9, x + w / 2 + 2, y + 9];
    });
    // evidence-site label placement: right of the marker, else left, else hidden (the active site always shows)
    const showSites = P.layers.sites && !!P.sites;
    const sites = showSites ? P.sites ?? [] : [];
    const markerBoxes: Box[] = sites.map((st) => { const [x, y] = toScreen(st.lon, st.lat); return [x - 8, y - 8, x + 8, y + 8]; });
    const siteBoxes: Box[] = [];
    const placed: { st: SiteMarker; x: number; y: number; r: number; side: 1 | -1; act: boolean }[] = [];
    for (const st of [...sites].sort((a, b) => Number(b.id === P.activeSite) - Number(a.id === P.activeSite))) {
      const [x, y] = toScreen(st.lon, st.lat); const act = st.id === P.activeSite; const r = act ? 9 : 7;
      ctx.font = "500 10.5px Geist Variable, system-ui, sans-serif"; const tw = act ? ctx.measureText(st.tag).width : 0;
      ctx.font = `${act ? 700 : 600} 12px Geist Variable, system-ui, sans-serif`;
      const w = Math.max(ctx.measureText(st.label).width, tw); const y1 = y - 12, y2 = y + (act ? 16 : 4);
      const right: Box = [x + r + 3, y1, x + r + 7 + w, y2]; const left: Box = [x - r - 7 - w, y1, x - r - 3, y2];
      const others = [...siteBoxes, ...basinBoxes, ...markerBoxes.filter((m) => !(m[0] === x - 8 && m[1] === y - 8))];
      const side: 1 | -1 | 0 = !hit(right, others) ? 1 : !hit(left, others) ? -1 : act ? 1 : 0;
      if (!side) continue;
      siteBoxes.push(side === 1 ? right : left);
      placed.push({ st, x, y, r, side, act });
    }
    if (v.z >= 6.6) {
      const ff = "italic 500 11px Geist Variable, system-ui, sans-serif"; ctx.font = ff;
      for (const b of BASINS) for (const f of b.features) {
        const [x, y] = toScreen(f.lon, f.lat); if (x < 0 || y < 0 || x > v.w || y > v.h) continue;
        const w = ctx.measureText(f.n).width;
        if (siteBoxes.length && hit([x - w / 2, y - 7, x + w / 2, y + 7], [...siteBoxes, ...markerBoxes])) continue;
        halo(f.n, x, y, ff, "rgba(251,232,204,0.95)"); ctx.font = ff;
      }
    }
    for (const b of BASINS) {
      const [x, y] = toScreen(b.labelAt[0], b.labelAt[1]);
      halo(b.short.toUpperCase(), x, y, basinFont, "#ffffff");
    }
    if (rg?.label && !sites.some((st) => st.label.toLowerCase() === rg.label!.toLowerCase())) { const [x, y] = toScreen(rg.lon, rg.lat); halo(rg.label, x, y - 16, "600 12px Geist Variable, system-ui, sans-serif", "#ffd166"); }
    // evidence sites: markers, then the placed labels
    for (const st of sites) {
      const [x, y] = toScreen(st.lon, st.lat); const act = st.id === P.activeSite;
      const r = act ? 9 : 7;
      ctx.save();
      if (act) { ctx.shadowColor = SITE_COLORS[st.kind]; ctx.shadowBlur = 14; }
      ctx.fillStyle = SITE_COLORS[st.kind]; ctx.strokeStyle = act ? "#ffffff" : "rgba(7,7,28,0.95)"; ctx.lineWidth = act ? 2.5 : 1.8;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    for (const q of placed) {
      ctx.textAlign = q.side === 1 ? "left" : "right";
      const tx = q.x + q.side * (q.r + 5);
      halo(q.st.label, tx, q.y - 5, `${q.act ? 700 : 600} 12px Geist Variable, system-ui, sans-serif`, "#ffffff");
      if (q.act) halo(q.st.tag, tx, q.y + 9, "500 10.5px Geist Variable, system-ui, sans-serif", SITE_COLORS[q.st.kind]);
    }
    ctx.textAlign = "center";
    // "what we know here" marker
    if (P.here) {
      const [x, y] = toScreen(P.here.lon, P.here.lat);
      ctx.save(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.moveTo(x - 15, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 15, y); ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 15); ctx.stroke();
      ctx.fillStyle = "#C2410C"; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    // notebook pins
    for (const pin of P.pins) {
      const [x, y] = toScreen(pin.lon, pin.lat); const act = pin.id === P.activePin;
      ctx.fillStyle = "#C2410C"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y - 10, act ? 7.5 : 6, 0, Math.PI * 2); ctx.moveTo(x - 4, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + 4, y - 6); ctx.fill(); ctx.stroke();
      if (act) halo(pin.label.slice(0, 40), x, y - 24, "600 11px Geist Variable, system-ui, sans-serif", "#ffffff");
    }
  }, [relief, overlayImg, tempImg, toScreen]);

  const requestDraw = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(draw); }, [draw]);
  const flyTo = useCallback((lon: number, lat: number, z: number) => {
    const v = view.current;
    anim.current = { t0: performance.now(), from: { cx: v.cx, cy: v.cy, z: v.z }, to: { cx: mx(lon), cy: my(lat), z } };
    requestDraw();
  }, [requestDraw]);
  const zoomAt = useCallback((x: number, y: number, nz: number) => {
    const v = view.current; const [lon, lat] = toLonLat(x, y);
    v.z = Math.max(3.5, Math.min(11.5, nz));
    const S = 256 * 2 ** v.z; v.cx = mx(lon) - (x - v.w / 2) / S; v.cy = my(lat) - (y - v.h / 2) / S;
    anim.current = null; requestDraw(); props.current.onViewChange?.(v.z);
  }, [requestDraw, toLonLat]);

  useEffect(() => {
    if (p.controlRef) p.controlRef.current = {
      zoomBy: (d) => { const v = view.current; zoomAt(v.w / 2, v.h / 2, v.z + d); },
      reset: () => { ring.current = null; flyTo(HOME.lon, HOME.lat, HOME.zoom); },
    };
  }, [flyTo, zoomAt, p.controlRef]);

  useEffect(() => { relief.onload = () => requestDraw(); }, [relief, requestDraw]);
  // Starting to draw is a new gesture, so whatever closed the last area no longer holds clicks back.
  useEffect(() => { if (p.areaPick) areaSettle.current = 0; }, [p.areaPick]);
  useEffect(() => { if (!overlayImg) return; overlayImg.onload = () => requestDraw(); if (overlayImg.complete) requestDraw(); }, [overlayImg, requestDraw]);
  useEffect(() => { if (!tempImg) return; tempImg.onload = () => requestDraw(); if (tempImg.complete) requestDraw(); }, [tempImg, requestDraw]);
  const lens0 = p.depthLens?.[0] ?? null, lens1 = p.depthLens?.[1] ?? null;
  useEffect(() => {
    let live = true; const lens: [number, number] | null = lens0 != null && lens1 != null ? [lens0, lens1] : null;
    BASINS.forEach((b) => {
      void createImageBitmap(depthPixels(b, lens)).then((bmp) => { if (live) { depthImgs.current.set(b.id, bmp); requestDraw(); } });
    });
    return () => { live = false; };
  }, [requestDraw, lens0, lens1]);
  useEffect(() => { requestDraw(); });
  useEffect(() => { p.onEngine?.("canvas"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = p.fly; if (!f) return;
    ring.current = f.ringKm ? f : f.label ? { ...f, ringKm: 0 } : null;
    flyTo(f.lon, f.lat, f.zoom);
  }, [p.fly, flyTo]);

  useEffect(() => {
    const wrap = wrapRef.current; const cv = document.getElementById("basin-map-canvas") as HTMLCanvasElement | null; if (!wrap || !cv) return;
    const resize = () => {
      const r = wrap.getBoundingClientRect(); const v = view.current;
      v.dpr = Math.min(window.devicePixelRatio || 1, 2); v.w = Math.max(1, r.width); v.h = Math.max(1, r.height);
      cv.width = Math.round(v.w * v.dpr); cv.height = Math.round(v.h * v.dpr); cv.style.width = `${v.w}px`; cv.style.height = `${v.h}px`;
      requestDraw();
    };
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize();
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); const r = wrap.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, view.current.z - e.deltaY * 0.0022);
    };
    wrap.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); wrap.removeEventListener("wheel", wheel); if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; };
  }, [requestDraw, zoomAt]);

  const local = (e: React.PointerEvent | React.MouseEvent) => { const r = wrapRef.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const click = (x: number, y: number) => {
    const P = props.current; const [lon, lat] = toLonLat(x, y);
    if (performance.now() < areaSettle.current) return;
    if (P.areaPick && P.onAreaPick) {
      const at = areaHit(P.area?.pts ?? [], (q) => toScreen(q[0], q[1]), x, y);
      if (at === "first") areaSettle.current = performance.now() + AREA_SETTLE_MS;
      P.onAreaPick(lon, lat, at); return;
    }
    if (P.sectionPick && P.onSectionPick) { P.onSectionPick(lon, lat); return; }
    if (P.layers.docs && P.docPoints && P.onSelectDoc && view.current.z >= 4.6) {
      let best: DocMarker | null = null, bd = 10;
      for (const d of P.docPoints) { const [px, py] = toScreen(d.lon, d.lat); const dd = Math.hypot(px - x, py - y); if (dd < bd) { bd = dd; best = d; } }
      if (best) { P.onSelectDoc(best.id); return; }
    }
    if (P.layers.sites && P.sites && P.onSelectSite) {
      for (const st of P.sites) { const [px, py] = toScreen(st.lon, st.lat); if (Math.hypot(px - x, py - y) < 12) { P.onSelectSite(st.id); return; } }
    }
    for (const pin of P.pins) { const [px, py] = toScreen(pin.lon, pin.lat); if (Math.hypot(px - x, py - 10 - y) < 11) { P.onSelectPin(pin.id); return; } }
    if (P.tagMode) { P.onPick(lon, lat); return; }
    if (P.layers.boreholes && view.current.z >= 6.2) {
      let best: Borehole | null = null, bd = 7;
      const F = P.bhFilter; const fOn = filterOn(F);
      for (const b of BASINS) for (const w of b.boreholes) { if (fOn && !passFilter(w, F!)) continue; const [px, py] = toScreen(w.lon, w.lat); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = w; } }
      if (best) { P.onSelectBorehole(best); return; }
    }
    const b = basinAt(lon, lat); if (b) P.onSelectBasin(b.id);
    P.onPickHere?.(lon, lat);
  };

  return (
    <div
      ref={wrapRef}
      className={`absolute inset-0 touch-none select-none ${p.tagMode || p.sectionPick || p.areaPick ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      onContextMenu={(e) => { if (!props.current.onContextPick) return; e.preventDefault(); const [x, y] = local(e); const [lon, lat] = toLonLat(x, y); props.current.onContextPick(lon, lat); }}
      onPointerDown={(e) => { const [x, y] = local(e); const v = view.current; drag.current = { x, y, cx: v.cx, cy: v.cy, moved: false }; anim.current = null; (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        const [x, y] = local(e); const d = drag.current;
        if (d) {
          if (Math.hypot(x - d.x, y - d.y) > 3) d.moved = true;
          if (d.moved) { const S = 256 * 2 ** view.current.z; view.current.cx = d.cx - (x - d.x) / S; view.current.cy = d.cy - (y - d.y) / S; requestDraw(); }
          return;
        }
        const [lon, lat] = toLonLat(x, y); const b = basinAt(lon, lat); const P = props.current;
        if (P.areaPick && P.area?.pts.length && !P.area.closed) { areaCursor.current = [x, y]; requestDraw(); }
        let site: string | null = null;
        if (P.layers.sites && P.sites) for (const st of P.sites) { const [px, py] = toScreen(st.lon, st.lat); if (Math.hypot(px - x, py - y) < 12) { site = st.id; break; } }
        P.onHover({ lon, lat, basin: b?.name ?? null, depth: b ? depthAt(b, lon, lat) : null, site });
      }}
      onPointerUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved) { const [x, y] = local(e); click(x, y); } }}
      onPointerLeave={() => { if (!drag.current) props.current.onHover(null); if (areaCursor.current) { areaCursor.current = null; requestDraw(); } }}
      onDoubleClick={(e) => {
        if (performance.now() < areaSettle.current) return;
        if (props.current.areaPick) { areaSettle.current = performance.now() + AREA_SETTLE_MS; props.current.onAreaFinish?.(); return; }
        const [x, y] = local(e); zoomAt(x, y, view.current.z + 1);
      }}
    >
      <canvas
        id="basin-map-canvas"
        role="img"
        aria-label="Map of the Cooper, Adavale, Galilee and North Bowen basins with depth to basin floor, faults, boreholes, seismic lines, stress, data confidence, evidence wells and saved notes. Click anywhere to see what is known there."
        className="block h-full w-full"
      />
    </div>
  );
}
