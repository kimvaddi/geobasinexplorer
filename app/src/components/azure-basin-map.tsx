// Azure Maps workspace map for the cloud build (Azure Maps presents the map layers, and the
// GDAL/PROJ spatial service measures sections and "What we know here").
// It draws the same layers as the offline canvas map (basin-map.tsx), at the same zoom thresholds and with the same
// click priority, over an Azure Maps base map (places, roads, terrain or imagery) or an Esri one. Esri tiles come
// through this app's relay (services/api/src/esri.ts) and replace the Azure base map, which switches to the blank
// accessible style (Learn: supported-map-styles), so screen readers still hear the location. With an Esri base map, one
// Planetary Computer overlay can be laid over the Cooper Basin (services/api/src/planetary.ts), over the app's tints and
// under its lines and markers; it goes away with the Esri base map, so the Azure Maps option never shows it. Props and
// callbacks keep the canvas map's zoom scale so the rest of the app is unchanged: Azure Maps zoom = canvas zoom - 1 (its
// tiles are 512 pixels).
// No Azure Maps key reaches the browser: the map asks this app's API for a Microsoft Entra token that can only read
// map tiles (Learn: how-to-secure-webapp-users). If Azure Maps can't start, the canvas map takes over.
import { useEffect, useRef, useState } from "react";
import * as atlas from "azure-maps-control";
import "azure-maps-control/dist/atlas.min.css";
import { toast } from "sonner";
import { BASINS, basinAt, depthAt, type Basin, type LonLat } from "@/lib/basins";
import { AREA_CORNER, AREA_FILL, AREA_SETTLE_MS, AREA_STROKE, BasinMap, DEFAULT_BASE_MAP, HOME, SITE_COLORS, YEAR_MAX, YEAR_MIN, areaHit, depthPixels, filterOn, passFilter, type BaseTiles, type BasinMapProps, type BhFilter, type FlyRequest, type OverlayTiles, type SiteKind } from "@/components/basin-map";
import { cloud, type MapsToken } from "@/lib/cloud";

const AZ = (canvasZoom: number) => canvasZoom - 1;
const RAD = Math.PI / 180;
const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI) / 2;
const uny = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;
const HALO = "rgba(7,7,28,0.85)";
/* Basin names sit on top of everything here, so the Cooper name moves north, still well inside the basin, where it
   can't cover the Innamincka 1 or Marabooka 1 markers at the regional view (checked against the GA outline). */
const LABEL_AT: Record<string, LonLat> = { cooper: [141.15, -26.85] };
const SEMI = ["SegoeUi-SemiBold"], BOLD = ["SegoeUi-Bold"], REG = ["SegoeUi-Regular"];
const BH = BASINS.flatMap((b) => b.boreholes);
// Style expressions are plain arrays; the SDK types them strictly, so they pass through this one helper.
const expr = (v: unknown) => v as never;

let cachedToken: MapsToken | null = null;
async function mapsToken(): Promise<MapsToken> {
  if (!cachedToken || cachedToken.expiresOn - Date.now() < 5 * 60_000) cachedToken = await cloud.mapsToken();
  return cachedToken;
}

/* Azure Maps stretches an image layer linearly between its four corners in Web Mercator. These rasters are regular in
   latitude, so their rows are first resampled to rows that are regular in Mercator y (linear interpolation of
   premultiplied colour); otherwise a basin-sized image would sit kilometres out of place across its middle. */
function mercatorRows(src: ImageData, north: number, south: number, outW: number, outH: number): HTMLCanvasElement {
  const sw = src.width, sh = src.height, s = src.data;
  const mid = new ImageData(sw, outH), d = mid.data;
  const yN = my(north), yS = my(south);
  for (let r = 0; r < outH; r++) {
    const lat = uny(yN + ((r + 0.5) / outH) * (yS - yN));
    const f = Math.max(0, Math.min(sh - 1, ((north - lat) / (north - south)) * sh - 0.5));
    const r0 = Math.floor(f), r1 = Math.min(sh - 1, r0 + 1), t = f - r0;
    for (let c = 0; c < sw; c++) {
      const i0 = (r0 * sw + c) * 4, i1 = (r1 * sw + c) * 4, o = (r * sw + c) * 4;
      const a0 = s[i0 + 3] * (1 - t), a1 = s[i1 + 3] * t, a = a0 + a1;
      if (a <= 0) continue;
      d[o] = (s[i0] * a0 + s[i1] * a1) / a; d[o + 1] = (s[i0 + 1] * a0 + s[i1 + 1] * a1) / a; d[o + 2] = (s[i0 + 2] * a0 + s[i1 + 2] * a1) / a; d[o + 3] = a;
    }
  }
  const tmp = document.createElement("canvas"); tmp.width = sw; tmp.height = outH; tmp.getContext("2d")!.putImageData(mid, 0, 0);
  if (outW === sw) return tmp;
  const out = document.createElement("canvas"); out.width = outW; out.height = outH;
  const ctx = out.getContext("2d")!; ctx.imageSmoothingEnabled = true; ctx.drawImage(tmp, 0, 0, outW, outH);
  return out;
}
const corners = (w: number, s: number, e: number, n: number): atlas.data.Position[] => [[w, n], [e, n], [e, s], [w, s]];

/* The depth-to-basement tint, coloured exactly as the canvas map colours it and clipped to the GA outline (even-odd). */
function depthImage(b: Basin, lens: [number, number] | null): { url: string; coords: atlas.data.Position[] } {
  const d = b.depth; const k = 3;
  const west = d.x0, east = d.x0 + d.dx * d.w, north = d.y0, south = d.y0 + d.dy * d.h;
  const out = mercatorRows(depthPixels(b, lens), north, south, d.w * k, d.h * k);
  const ctx = out.getContext("2d")!; const yN = my(north), yS = my(south);
  ctx.globalCompositeOperation = "destination-in"; ctx.beginPath();
  for (const ring of b.outline) {
    ring.forEach((q, i) => { const x = ((q[0] - west) / (east - west)) * out.width, y = ((my(q[1]) - yN) / (yS - yN)) * out.height; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
  }
  ctx.fill("evenodd");
  return { url: out.toDataURL("image/png"), coords: corners(west, south, east, north) };
}
async function overlayImage(src: string, bounds: [number, number, number, number]) {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
  const [w, s, e, n] = bounds;
  const out = mercatorRows(g.getImageData(0, 0, c.width, c.height), n, s, c.width, Math.round(c.height * 1.5));
  return { url: out.toDataURL("image/png"), coords: corners(w, s, e, n) };
}

/* Map symbols, drawn at twice their size for sharp edges on high-density screens. */
function icon(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): ImageData {
  const R = 2, cv = document.createElement("canvas"); cv.width = w * R; cv.height = h * R;
  const c = cv.getContext("2d")!; c.scale(R, R); draw(c);
  return c.getImageData(0, 0, cv.width, cv.height);
}
const diamond = (color: string, act: boolean) => icon(act ? 44 : 20, act ? 44 : 20, (c) => {
  const m = act ? 22 : 10, r = act ? 9 : 7;
  if (act) { c.shadowColor = color; c.shadowBlur = 14; }
  c.fillStyle = color; c.strokeStyle = act ? "#ffffff" : "rgba(7,7,28,0.95)"; c.lineWidth = act ? 2.5 : 1.8;
  c.beginPath(); c.moveTo(m, m - r); c.lineTo(m + r, m); c.lineTo(m, m + r); c.lineTo(m - r, m); c.closePath(); c.fill(); c.stroke();
});
const tick = (good: boolean) => icon(6, 22, (c) => {
  const len = good ? 9 : 6;
  c.strokeStyle = good ? "rgba(255,155,113,0.95)" : "rgba(255,155,113,0.45)"; c.lineWidth = good ? 2 : 1.2;
  c.beginPath(); c.moveTo(3, 11 - len); c.lineTo(3, 11 + len); c.stroke();
});
const page = (act: boolean) => icon(20, 24, (c) => {
  const r = 9, x = 10, y = 12;
  c.fillStyle = act ? "#ffffff" : "rgba(205,244,214,0.95)"; c.strokeStyle = "rgba(7,7,28,0.95)"; c.lineWidth = 1.5;
  c.beginPath(); c.roundRect(x - r * 0.8, y - r, r * 1.6, r * 2, 2); c.fill(); c.stroke();
  c.strokeStyle = "rgba(15,43,61,0.8)"; c.lineWidth = 1; c.beginPath();
  c.moveTo(x - r * 0.45, y - r * 0.35); c.lineTo(x + r * 0.45, y - r * 0.35); c.moveTo(x - r * 0.45, y + r * 0.15); c.lineTo(x + r * 0.45, y + r * 0.15); c.stroke();
});
const pin = (act: boolean) => icon(20, 25, (c) => {
  const x = 10, y = 24;
  c.fillStyle = "#C2410C"; c.strokeStyle = "#ffffff"; c.lineWidth = 2;
  c.beginPath(); c.arc(x, y - 10, act ? 7.5 : 6, 0, Math.PI * 2); c.moveTo(x - 4, y - 6); c.lineTo(x, y); c.lineTo(x + 4, y - 6); c.fill(); c.stroke();
});
const crosshair = () => icon(36, 36, (c) => {
  const x = 18, y = 18;
  c.strokeStyle = "#ffffff"; c.lineWidth = 2; c.shadowColor = "rgba(0,0,0,0.8)"; c.shadowBlur = 4;
  c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2);
  c.moveTo(x - 15, y); c.lineTo(x - 5, y); c.moveTo(x + 5, y); c.lineTo(x + 15, y); c.moveTo(x, y - 15); c.lineTo(x, y - 5); c.moveTo(x, y + 5); c.lineTo(x, y + 15); c.stroke();
  c.shadowBlur = 0; c.fillStyle = "#C2410C"; c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill();
});

/* GA outlines are sets of rings filled with the even-odd rule; GeoJSON needs explicit outer rings and holes. */
function inRing(p: LonLat, ring: LonLat[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const closed = (r: LonLat[]): LonLat[] => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
function evenOdd(rings: LonLat[][]): LonLat[][][] {
  const depth = rings.map((r, i) => rings.reduce((n, o, j) => (j !== i && inRing(r[0], o) ? n + 1 : n), 0));
  const polys: { outer: number; rings: LonLat[][] }[] = [];
  rings.forEach((r, i) => { if (depth[i] % 2 === 0) polys.push({ outer: i, rings: [closed(r)] }); });
  rings.forEach((r, i) => { if (depth[i] % 2 === 1) polys.find((p) => depth[p.outer] === depth[i] - 1 && inRing(r[0], rings[p.outer]))?.rings.push(closed(r)); });
  return polys.map((p) => p.rings);
}

/* Borehole filter: the same rules as passFilter in basin-map.tsx, as a style expression. */
function bhFilter(f: BhFilter | null | undefined, major: boolean) {
  const all: unknown[] = ["all", major ? ["==", ["get", "m"], true] : ["!=", ["get", "m"], true]];
  if (f && filterOn(f)) {
    if (f.minTd > 0) all.push([">=", ["coalesce", ["get", "td"], -1], f.minTd]);
    if (f.y0 > YEAR_MIN || f.y1 < YEAR_MAX) all.push([">=", ["coalesce", ["get", "y"], -1], f.y0], ["<=", ["coalesce", ["get", "y"], 1e9], f.y1]);
    if (f.insideOnly) all.push(["==", ["get", "i"], true]);
  }
  return expr(all);
}
const point = (p: LonLat, props: Record<string, unknown> = {}) => new atlas.data.Feature(new atlas.data.Point(p), props);
const textOnly = { image: "none" };
const halo = { haloColor: HALO, haloWidth: 1.75 };

export function AzureBasinMap(p: BasinMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<atlas.Map | null>(null);
  const props = useRef(p);
  props.current = p;
  const layers = useRef<Record<string, atlas.layer.Layer>>({});
  const sources = useRef<Record<string, atlas.source.DataSource>>({});
  const ring = useRef<FlyRequest | null>(null);
  const lensDone = useRef<string>("");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const L = (id: string) => layers.current[id] as (atlas.layer.Layer & { setOptions: (o: object) => void }) | undefined;
  const S = (id: string) => sources.current[id];
  const esriActive = useRef(false);
  const overlay = useRef<{ tiles: OverlayTiles; layer: string } | null>(null);
  const [pcHint, setPcHint] = useState<OverlayTiles | null>(null);
  /* A click on the first corner or a double-click closes an area; the rest of that gesture (the second click of a
     double-click, or a third) must not open "What we know here" or zoom, so it is ignored until this time. */
  const areaSettle = useRef(0);
  const lowestApp = () => ["gbx-conf", "gbx-temp", `gbx-depth-${BASINS[0].id}`].find((k) => L(k)) ?? "gbx-hl";

  /* The satellite style finds its photo tiles through one lookup request, the tileset details of microsoft.imagery. If
     that request fails, the SDK never asks for a photo and doesn't retry, so the map stays black under the roads and
     labels until the page is reloaded (seen 8 Nov 2026). The SDK reports only "Failed to fetch", so
     the map counts the photo tiles it asks for (transformRequest), and when the satellite style has asked for none a few
     seconds after it was applied, or soon after a failed request, the photos are requested directly, through the map's
     own domain and sign-in ({azMapsDomain}; Learn, Add a tile layer to a map). They go above the style's empty photo
     layer and under its roads and labels. The layer's name starts with gbx-base-, so the next base-map change removes it
     with the Esri tiles. */
  const PHOTOS = "gbx-base-azure-photos";
  const SATELLITE = "satellite_road_labels";
  const photoTiles = useRef(0);
  const photoCheck = useRef(0);
  const mapsAuth = useRef<{ domain: string; clientId: string } | null>(null);
  const [photoCredit, setPhotoCredit] = useState<string | null>(null);
  function photosDirect(map: atlas.Map): boolean {
    if (L(PHOTOS) || esriActive.current || map.getStyle().style !== SATELLITE) return false;
    const layer = new atlas.layer.TileLayer({ tileUrl: "https://{azMapsDomain}/map/tile?api-version=2.1&tilesetId=microsoft.imagery&zoom={z}&x={x}&y={y}&tileSize=256&view=Auto", tileSize: 256, maxSourceZoom: 19 }, PHOTOS);
    map.layers.add(layer, "roads");
    layers.current[PHOTOS] = layer;
    void photoCreditFor(map);
    return true;
  }
  /* The photos' copyright, which the style would otherwise show, follows the view: Azure Maps' Get Map Attribution for
     microsoft.imagery, refreshed after every move and shown in the lower right corner (Learn, Show the correct copyright
     attribution). The Render API counts zoom on 256-pixel tiles, one level above the map's 512-pixel zoom. */
  async function photoCreditFor(map: atlas.Map) {
    const auth = mapsAuth.current;
    if (!L(PHOTOS) || !auth) { setPhotoCredit(null); return; }
    const cam = map.getCamera(); const b = cam.bounds; const zoom = Math.min(19, Math.max(1, Math.round((cam.zoom ?? 3) + 1)));
    if (!b) return;
    try {
      const t = await mapsToken();
      const r = await fetch(`https://${auth.domain}/map/attribution?api-version=2024-04-01&tilesetId=microsoft.imagery&zoom=${zoom}&bounds=${b.map((x) => x.toFixed(5)).join(",")}`,
        { headers: { Authorization: `Bearer ${t.token}`, "x-ms-client-id": auth.clientId } });
      const body = (await r.json().catch(() => ({}))) as { copyrights?: string[] };
      // Each credit comes as a small HTML anchor; only its text is shown.
      const text = (body.copyrights ?? []).map((h) => new DOMParser().parseFromString(h, "text/html").body.textContent?.trim() ?? "").filter(Boolean).join(" ");
      if (L(PHOTOS)) setPhotoCredit(r.ok && text ? text : "Imagery from Azure Maps");
    } catch { if (L(PHOTOS)) setPhotoCredit("Imagery from Azure Maps"); }
  }
  function watchPhotos(map: atlas.Map, afterMs = 8000) {
    window.clearTimeout(photoCheck.current);
    photoCheck.current = window.setTimeout(() => {
      if (photoTiles.current === 0 && photosDirect(map)) console.warn("Azure Maps: the satellite style asked for no photo tiles, so they are requested directly.");
    }, afterMs);
  }

  /* Azure styles are set directly, and the Planetary Computer overlay goes with the Esri base map. An Esri style adds
     its tile layers, the background under the lowest of this app's layers and the place names just under the markers,
     then blanks the Azure base map. The SDK keeps every layer of this app across a style change, and puts any whose
     anchor layer the new style lacks back on top in its original order, so the app's layers stay in the same order on
     the blank style. */
  function applyBaseMap(map: atlas.Map, id: string, tiles?: BaseTiles[]) {
    const old = Object.keys(layers.current).filter((k) => k.startsWith("gbx-base-"));
    if (old.length) { map.layers.remove(old); for (const k of old) delete layers.current[k]; }
    setPhotoCredit(null);
    esriActive.current = !!tiles?.length;
    if (!tiles?.length) {
      applyOverlay(map, null, 0); photoTiles.current = 0; map.setStyle({ style: id });
      if (id === SATELLITE) watchPhotos(map); else window.clearTimeout(photoCheck.current);
      return;
    }
    window.clearTimeout(photoCheck.current);
    const lowest = lowestApp();
    for (const t of tiles) {
      const layer = new atlas.layer.TileLayer({ tileUrl: `${location.origin}/api/basemap/esri/${t.id}/{z}/{y}/{x}`, tileSize: t.size, maxSourceZoom: t.maxZoom }, `gbx-base-${t.id}`);
      map.layers.add(layer, t.overlay ? "gbx-hl" : lowest);
      layers.current[layer.getId()] = layer;
    }
    map.setStyle({ style: "blank_accessible" });
  }

  /* One Planetary Computer overlay at a time, over the app's depth, confidence and temperature tints, which would
     otherwise hide it inside the basin, and under its outlines, lines and markers; the opacity slider lets the tints
     show through. Tiles are asked for only inside its bounds and zoom range, so a view elsewhere costs nothing; the hint
     says where to look instead. */
  function applyOverlay(map: atlas.Map, o: OverlayTiles | null, opacity: number) {
    const cur = overlay.current;
    if (cur && o && esriActive.current && cur.tiles.id === o.id) { L(cur.layer)?.setOptions({ opacity }); return; }
    if (cur) { map.layers.remove(cur.layer); delete layers.current[cur.layer]; overlay.current = null; }
    if (o && esriActive.current) {
      const id = `gbx-pc-${o.id}`;
      const layer = new atlas.layer.TileLayer({ tileUrl: `${location.origin}/api/overlay/planetary/${o.id}/{z}/{x}/{y}`, tileSize: o.size, minSourceZoom: o.minZoom, maxSourceZoom: o.maxZoom, bounds: new atlas.data.BoundingBox(o.bounds), opacity }, id);
      map.layers.add(layer, "gbx-basin-fill");
      layers.current[id] = layer;
      overlay.current = { tiles: o, layer: id };
    }
    showHint(map);
  }
  function showHint(map: atlas.Map) {
    const o = overlay.current?.tiles ?? null; const cam = map.getCamera(); const b = cam.bounds;
    const seen = !!o && !!b && b[0] < o.bounds[2] && b[2] > o.bounds[0] && b[1] < o.bounds[3] && b[3] > o.bounds[1];
    setPcHint(o && (Math.round(cam.zoom ?? 0) < o.minZoom || !seen) ? o : null);
  }

  function drawRing() {
    const rg = ring.current; const P = props.current;
    S("ring")?.clear(); S("ring-pt")?.clear();
    if (!rg) return;
    if (rg.ringKm) S("ring").add(new atlas.data.Polygon([atlas.math.getRegularPolygonPath([rg.lon, rg.lat], rg.ringKm, 72, "kilometers")]));
    const sites = P.layers.sites ? P.sites ?? [] : [];
    const label = rg.label && !sites.some((st) => st.label.toLowerCase() === rg.label!.toLowerCase()) ? rg.label : "";
    S("ring-pt").add(point([rg.lon, rg.lat], { dot: !!rg.ringKm, label }));
  }

  function click(map: atlas.Map, x: number, y: number, lon: number, lat: number) {
    const P = props.current; const z = (map.getCamera().zoom ?? 0) + 1;
    const px = (pts: LonLat[]) => map.positionsToPixels(pts);
    if (performance.now() < areaSettle.current) return;
    if (P.areaPick && P.onAreaPick) {
      const at = areaHit(P.area?.pts ?? [], (q) => px([q])[0] as [number, number], x, y);
      if (at === "first") areaSettle.current = performance.now() + AREA_SETTLE_MS;
      P.onAreaPick(lon, lat, at); return;
    }
    if (P.sectionPick && P.onSectionPick) { P.onSectionPick(lon, lat); return; }
    if (P.layers.docs && P.docPoints?.length && P.onSelectDoc && z >= 4.6) {
      let best = -1, bd = 10;
      px(P.docPoints.map((d) => [d.lon, d.lat])).forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { P.onSelectDoc(P.docPoints[best].id); return; }
    }
    if (P.layers.sites && P.sites?.length && P.onSelectSite) {
      const i = px(P.sites.map((s) => [s.lon, s.lat])).findIndex((q) => Math.hypot(q[0] - x, q[1] - y) < 12);
      if (i >= 0) { P.onSelectSite(P.sites[i].id); return; }
    }
    if (P.pins.length) {
      const i = px(P.pins.map((q) => [q.lon, q.lat])).findIndex((q) => Math.hypot(q[0] - x, q[1] - 10 - y) < 11);
      if (i >= 0) { P.onSelectPin(P.pins[i].id); return; }
    }
    if (P.tagMode) { P.onPick(lon, lat); return; }
    if (P.layers.boreholes && z >= 6.2) {
      const [a, b] = map.pixelsToPositions([[x - 8, y - 8], [x + 8, y + 8]]);
      const w0 = Math.min(a[0], b[0]), w1 = Math.max(a[0], b[0]), s0 = Math.min(a[1], b[1]), s1 = Math.max(a[1], b[1]);
      const F = P.bhFilter; const fOn = filterOn(F);
      const cand = BH.filter((w) => w.lon >= w0 && w.lon <= w1 && w.lat >= s0 && w.lat <= s1 && (!fOn || passFilter(w, F!)));
      let best = -1, bd = 7;
      if (cand.length) px(cand.map((w) => [w.lon, w.lat])).forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { P.onSelectBorehole(cand[best]); return; }
    }
    const bs = basinAt(lon, lat); if (bs) P.onSelectBasin(bs.id);
    P.onPickHere?.(lon, lat);
  }

  async function build(map: atlas.Map) {
    const P = props.current;
    const sprites: [string, ImageData][] = [
      ...(Object.keys(SITE_COLORS) as SiteKind[]).flatMap((k): [string, ImageData][] => [[`gbx-site-${k}`, diamond(SITE_COLORS[k], false)], [`gbx-site-${k}-act`, diamond(SITE_COLORS[k], true)]]),
      ["gbx-stress-good", tick(true)], ["gbx-stress-poor", tick(false)], ["gbx-doc", page(false)], ["gbx-doc-act", page(true)],
      ["gbx-pin", pin(false)], ["gbx-pin-act", pin(true)], ["gbx-here", crosshair()],
    ];
    await Promise.all(sprites.map(([id, im]) => map.imageSprite.add(id, im, { pixelRatio: 2 })));

    const src = (id: string) => { const s = new atlas.source.DataSource(`gbx-${id}`); map.sources.add(s); sources.current[id] = s; return s; };
    src("basins").add(BASINS.map((b) => new atlas.data.Feature(new atlas.data.MultiPolygon(evenOdd(b.outline)), { id: b.id })));
    src("outlines").add(BASINS.map((b) => new atlas.data.Feature(new atlas.data.MultiLineString(b.outline.map(closed)), { id: b.id })));
    src("faults").add(BASINS.flatMap((b) => b.faults.map((f) => new atlas.data.LineString(f))));
    src("folds").add(BASINS.flatMap((b) => b.folds.map((f) => new atlas.data.LineString(f.p))));
    src("seismic").add((P.seismic ?? []).map((l) => new atlas.data.LineString(l)));
    src("bh").add(BH.map((w) => point([w.lon, w.lat], { m: w.major, i: w.inside, ...(w.td != null ? { td: w.td } : {}), ...(w.year != null ? { y: w.year } : {}) })));
    src("hl"); src("docs"); src("sec-line"); src("sec-pts"); src("area-fill"); src("area"); src("area-rubber"); src("area-pts"); src("ring"); src("ring-pt"); src("sites"); src("here"); src("pins");
    src("stress").add(BASINS.flatMap((b) => b.stress.map((s) => point([s[0], s[1]], { azi: s[2], g: "ABC".includes(s[3]) }))));
    src("features").add(BASINS.flatMap((b) => b.features.map((f) => point([f.lon, f.lat], { n: f.n }))));
    src("labels").add(BASINS.map((b) => point(LABEL_AT[b.id] ?? b.labelAt, { t: b.short.toUpperCase() })));

    const add = (layer: atlas.layer.Layer, before?: string) => { map.layers.add(layer, before); layers.current[layer.getId()] = layer; };
    // Raster tints, outlines, lines and boreholes go under the base map's place names; markers and labels go on top.
    const lens = P.depthLens ?? null; lensDone.current = JSON.stringify(lens);
    for (const b of BASINS) { const im = depthImage(b, lens); add(new atlas.layer.ImageLayer({ url: im.url, coordinates: im.coords, opacity: 1 }, `gbx-depth-${b.id}`), "labels"); }
    add(new atlas.layer.PolygonLayer(S("basins"), "gbx-basin-fill", { fillColor: "rgba(161,221,252,0.07)", fillOpacity: 1 }), "labels");
    add(new atlas.layer.LineLayer(S("outlines"), "gbx-outline-glow", { strokeColor: "rgba(161,221,252,0.9)", strokeWidth: 5, blur: 4, strokeOpacity: 0.45 }), "labels");
    add(new atlas.layer.LineLayer(S("outlines"), "gbx-outline", { strokeColor: "rgba(207,237,253,0.85)", strokeWidth: 1.4 }), "labels");
    const thin = expr(["step", ["zoom"], 0.8, 6, 1.2]);
    add(new atlas.layer.LineLayer(S("faults"), "gbx-faults", { strokeColor: "rgba(251,232,204,0.6)", strokeWidth: thin, minZoom: AZ(5) }), "labels");
    add(new atlas.layer.LineLayer(S("folds"), "gbx-folds", { strokeColor: "rgba(205,244,214,0.7)", strokeWidth: thin, strokeDashArray: [6, 5], minZoom: AZ(5) }), "labels");
    add(new atlas.layer.LineLayer(S("seismic"), "gbx-seismic", { strokeColor: "rgba(161,221,252,0.55)", strokeWidth: expr(["step", ["zoom"], 0.7, 6.5, 1]), minZoom: AZ(4.8) }), "labels");
    add(new atlas.layer.BubbleLayer(S("bh"), "gbx-bh-minor", { color: expr(["case", ["==", ["get", "i"], true], "rgba(255,255,255,0.5)", "rgba(255,255,255,0.22)"]), radius: expr(["step", ["zoom"], 1.3, 6.5, 1.8, 7.5, 2.4]), strokeWidth: 0, filter: bhFilter(null, false), minZoom: AZ(7) }), "labels");
    add(new atlas.layer.BubbleLayer(S("bh"), "gbx-bh-major", { color: "rgba(205,244,214,0.9)", radius: expr(["step", ["zoom"], 1.3, 6, 1.8, 6.5, 2.3, 7.5, 2.9]), strokeWidth: 0, filter: bhFilter(null, true), minZoom: AZ(5.9) }), "labels");

    add(new atlas.layer.BubbleLayer(S("hl"), "gbx-hl", { color: "rgba(0,0,0,0)", radius: 3.6, strokeColor: "#ffd166", strokeWidth: 1.6 }));
    add(new atlas.layer.SymbolLayer(S("stress"), "gbx-stress", { iconOptions: { image: expr(["case", ["get", "g"], "gbx-stress-good", "gbx-stress-poor"]), rotation: expr(["get", "azi"]), rotationAlignment: "map", allowOverlap: true, ignorePlacement: true }, textOptions: { textField: "" } }));
    add(new atlas.layer.SymbolLayer(S("docs"), "gbx-docs", { minZoom: AZ(4.6), iconOptions: { image: expr(["case", ["get", "act"], "gbx-doc-act", "gbx-doc"]), size: expr(["get", "s"]), allowOverlap: true, ignorePlacement: true },
      textOptions: { textField: expr(["step", ["zoom"], "", AZ(6), ["case", [">", ["get", "n"], 1], ["to-string", ["get", "n"]], ""]]), font: BOLD, size: 9.5, color: "#ffffff", ...halo, anchor: "left", offset: [0.8, -0.7], allowOverlap: true, ignorePlacement: true } }));
    add(new atlas.layer.LineLayer(S("sec-line"), "gbx-sec-casing", { strokeColor: "#ffffff", strokeWidth: 4, strokeDashArray: [2, 1.25] }));
    add(new atlas.layer.LineLayer(S("sec-line"), "gbx-sec-line", { strokeColor: "#C2410C", strokeWidth: 2.2, strokeDashArray: [3.6, 2.3] }));
    add(new atlas.layer.BubbleLayer(S("sec-pts"), "gbx-sec-pts", { color: "#C2410C", radius: 9, strokeColor: "#ffffff", strokeWidth: 2 }));
    add(new atlas.layer.SymbolLayer(S("sec-pts"), "gbx-sec-text", { iconOptions: textOnly, textOptions: { textField: expr(["get", "t"]), font: BOLD, size: 11, color: "#ffffff", allowOverlap: true, ignorePlacement: true } }));
    // A drawn area: its fill and outline, and while drawing, the line on to the pointer and its corners (the first
    // corner larger once it can close the area).
    add(new atlas.layer.PolygonLayer(S("area-fill"), "gbx-area-fill", { fillColor: AREA_FILL, fillOpacity: 1 }));
    add(new atlas.layer.LineLayer(S("area"), "gbx-area-casing", { strokeColor: "rgba(7,7,28,0.85)", strokeWidth: 4.5 }));
    add(new atlas.layer.LineLayer(S("area"), "gbx-area-line", { strokeColor: AREA_STROKE, strokeWidth: 2.2 }));
    add(new atlas.layer.LineLayer(S("area-rubber"), "gbx-area-rubber", { strokeColor: AREA_STROKE, strokeWidth: 1.6, strokeDashArray: [3, 2.5] }));
    add(new atlas.layer.BubbleLayer(S("area-pts"), "gbx-area-pts", { color: "#ffffff", radius: expr(["case", ["get", "first"], 6.5, 4.5]), strokeColor: AREA_CORNER, strokeWidth: 2 }));
    add(new atlas.layer.PolygonLayer(S("ring"), "gbx-ring-fill", { fillColor: "rgba(255,209,102,0.10)", fillOpacity: 1 }));
    add(new atlas.layer.LineLayer(S("ring"), "gbx-ring-line", { strokeColor: "rgba(255,209,102,0.95)", strokeWidth: 2, strokeDashArray: [3, 2.5] }));
    add(new atlas.layer.BubbleLayer(S("ring-pt"), "gbx-ring-dot", { color: "#ffd166", radius: 4, strokeWidth: 0, filter: expr(["==", ["get", "dot"], true]) }));
    add(new atlas.layer.SymbolLayer(S("ring-pt"), "gbx-ring-label", { iconOptions: textOnly, textOptions: { textField: expr(["get", "label"]), font: SEMI, size: 12, color: "#ffd166", ...halo, offset: [0, -1.4], allowOverlap: true } }));
    add(new atlas.layer.SymbolLayer(S("features"), "gbx-feature-labels", { minZoom: AZ(6.6), iconOptions: textOnly, textOptions: { textField: expr(["get", "n"]), font: REG, size: 11, color: "rgba(251,232,204,0.95)", ...halo } }));
    const kindColor = expr(["match", ["get", "kind"], "legacy", SITE_COLORS.legacy, "co2", SITE_COLORS.co2, "geo", SITE_COLORS.geo, SITE_COLORS.context]);
    // Evidence wells are points, so they must never read like the basins around them: the marker always shows, but the
    // name appears only from regional zoom, in the marker's colour and a smaller size than the basin names.
    add(new atlas.layer.SymbolLayer(S("sites"), "gbx-sites", { filter: expr(["!=", ["get", "act"], true]), iconOptions: { image: expr(["concat", "gbx-site-", ["get", "kind"]]), allowOverlap: true, ignorePlacement: true }, textOptions: { textField: "" } }));
    add(new atlas.layer.SymbolLayer(S("sites"), "gbx-site-labels", { filter: expr(["!=", ["get", "act"], true]), minZoom: AZ(6.2), iconOptions: textOnly,
      textOptions: { textField: expr(["get", "label"]), font: SEMI, size: 11, color: kindColor, ...halo, variableAnchor: ["left", "right"], radialOffset: 0.9, justify: "auto", optional: true } }));
    add(new atlas.layer.SymbolLayer(S("sites"), "gbx-site-active", { filter: expr(["==", ["get", "act"], true]), iconOptions: { image: expr(["concat", "gbx-site-", ["get", "kind"], "-act"]), allowOverlap: true, ignorePlacement: true },
      textOptions: { textField: expr(["format", ["get", "label"], { "text-color": kindColor }, "\n", {}, ["get", "tag"], { "font-scale": 0.875, "text-color": "#ffffff" }]), font: SEMI, size: 12, color: "#ffffff", ...halo, variableAnchor: ["left", "right"], radialOffset: 1.1, justify: "auto", allowOverlap: true } }));
    add(new atlas.layer.SymbolLayer(S("here"), "gbx-here", { iconOptions: { image: "gbx-here", allowOverlap: true, ignorePlacement: true }, textOptions: { textField: "" } }));
    add(new atlas.layer.SymbolLayer(S("pins"), "gbx-pins", { iconOptions: { image: expr(["case", ["get", "act"], "gbx-pin-act", "gbx-pin"]), anchor: "bottom", allowOverlap: true, ignorePlacement: true },
      textOptions: { textField: expr(["case", ["get", "act"], ["get", "label"], ""]), font: SEMI, size: 11, color: "#ffffff", ...halo, anchor: "bottom", offset: [0, -2.1], allowOverlap: true } }));
    // Basin names go on the top layer, which the map places first, so no well, feature or base-map label can displace
    // them; they still claim their space, so lower labels move aside rather than sit on top of them.
    add(new atlas.layer.SymbolLayer(S("labels"), "gbx-basin-labels", { iconOptions: { ...textOnly, allowOverlap: true, ignorePlacement: true },
      textOptions: { textField: expr(["get", "t"]), font: BOLD, size: expr(["step", ["zoom"], 13, 6, 15]), color: "#ffffff", ...halo, allowOverlap: true, ignorePlacement: false } }));

    // GA data-confidence overlay under the depth tint, as on the canvas map (it loads asynchronously).
    if (P.overlay) void overlayImage(P.overlay.src, P.overlay.bounds).then((im) => {
      if (mapRef.current !== map) return;
      add(new atlas.layer.ImageLayer({ url: im.url, coordinates: im.coords, opacity: 0.62, visible: props.current.layers.conf }, "gbx-conf"), L("gbx-temp") ? "gbx-temp" : `gbx-depth-${BASINS[0].id}`);
    }).catch(() => undefined);

    map.events.add("click", (e: atlas.MapMouseEvent) => { if (e.position && e.pixel) click(map, e.pixel[0], e.pixel[1], e.position[0], e.position[1]); });
    map.events.add("dblclick", () => {
      if (performance.now() < areaSettle.current || !props.current.areaPick) return;
      areaSettle.current = performance.now() + AREA_SETTLE_MS;
      props.current.onAreaFinish?.();
    });
    let hoverRaf = 0; let last: atlas.MapMouseEvent | null = null;
    map.events.add("mousemove", (e: atlas.MapMouseEvent) => {
      last = e;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0; const ev = last; if (!ev?.position || !ev.pixel) return;
        if ((ev.originalEvent as MouseEvent | undefined)?.buttons) return;
        const [lon, lat] = ev.position; const Q = props.current; const b = basinAt(lon, lat);
        const A = Q.area;
        if (Q.areaPick && A && !A.closed && A.pts.length) {
          const end = A.pts[A.pts.length - 1];
          S("area-rubber")?.setShapes([new atlas.data.LineString(A.pts.length >= 2 ? [end, [lon, lat], A.pts[0]] : [end, [lon, lat]])]);
        }
        let site: string | null = null;
        if (Q.layers.sites && Q.sites?.length) { const i = map.positionsToPixels(Q.sites.map((s) => [s.lon, s.lat])).findIndex((q) => Math.hypot(q[0] - ev.pixel![0], q[1] - ev.pixel![1]) < 12); if (i >= 0) site = Q.sites[i].id; }
        Q.onHover({ lon, lat, basin: b?.name ?? null, depth: b ? depthAt(b, lon, lat) : null, site });
      });
    });
    map.events.add("moveend", () => { props.current.onViewChange?.((map.getCamera().zoom ?? 0) + 1); if (overlay.current) showHint(map); });
    map.events.add("zoomend", () => L("gbx-conf")?.setOptions({ opacity: (map.getCamera().zoom ?? 0) > AZ(7) ? 0.5 : 0.62 }));
    // Which basin and well names are on screen after each render, for the operator's browser check (tests/e2e/cloud-map.mjs):
    // a basin name hidden by another label is a defect that screenshots alone let slip through.
    map.events.add("idle", () => {
      const el = outerRef.current; if (!el || mapRef.current !== map) return;
      const names = (layer: string, key: string) => [...new Set(map.layers.getRenderedShapes(undefined, layer)
        .map((s) => String((s instanceof atlas.Shape ? s.getProperties() : (s as atlas.data.Feature<atlas.data.Geometry, Record<string, unknown>>).properties)?.[key] ?? ""))
        .filter(Boolean))].sort();
      el.dataset.gbxBasinLabels = names("gbx-basin-labels", "t").join("|");
      el.dataset.gbxWellLabels = names("gbx-site-labels", "label").join("|");
    });
  }

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    let live = true; let map: atlas.Map | null = null;
    const giveUp = (why: string) => {
      if (!live) return;
      live = false; console.warn("Azure Maps unavailable:", why);
      map?.dispose(); mapRef.current = null;
      toast.warning("Azure Maps couldn't load, so the offline map is shown.");
      setFailed(true);
    };
    const timer = window.setTimeout(() => giveUp("it did not start within 20 seconds"), 20_000);
    void (async () => {
      let t: MapsToken;
      try { t = await mapsToken(); } catch (e) { giveUp(e instanceof Error ? e.message : "no map token"); return; }
      if (!live) return;
      atlas.setDomain(t.domain);
      mapsAuth.current = { domain: t.domain, clientId: t.clientId };
      map = new atlas.Map(el, {
        center: [HOME.lon, HOME.lat], zoom: AZ(HOME.zoom), minZoom: AZ(3.5), maxZoom: 14,
        style: DEFAULT_BASE_MAP, language: "en-US", view: "Auto", showFeedbackLink: false, renderWorldCopies: false,
        dragRotateInteraction: false, touchRotate: false,
        // Screen readers still hear the location, taken from the map's own data; the geocoder fallback is off because
        // the map token may only read tiles (Learn: atlas.serviceoptions, enableAccessibilityLocationFallback).
        enableAccessibilityLocationFallback: false,
        authOptions: { authType: atlas.AuthenticationType.anonymous, clientId: t.clientId, getToken: (resolve, reject) => { mapsToken().then((x) => resolve(x.token), reject); } },
        // Counts the satellite photo tiles the map asks for (watchPhotos); the SDK still signs every request itself.
        transformRequest: (url: string, type: string) => {
          if (type === "Tile" && url.includes("tilesetId=microsoft.imagery")) photoTiles.current++;
          return { url };
        },
      });
      mapRef.current = map;
      const m = map;
      m.events.add("ready", () => {
        if (!live) return;
        window.clearTimeout(timer);
        if (m.getStyle().style === SATELLITE) watchPhotos(m);
        m.events.add("moveend", () => { if (L(PHOTOS)) void photoCreditFor(m); });
        void build(m).then(() => { if (live) { setReady(true); props.current.onEngine?.("azure"); } }, (e: unknown) => giveUp(e instanceof Error ? e.message : "layers failed"));
      });
      m.events.add("error", (e: atlas.MapErrorEvent) => {
        // An Esri tile refused on the way (Front Door's tile allowance, the day's Esri allowance, or Esri itself being
        // unavailable or slow) switches the map back to the Azure base map once, rather than leaving gaps.
        const err = e.error as (Error & { status?: number; url?: string }) | undefined;
        if (err?.url?.includes("/api/basemap/esri/") && [403, 429, 502, 503, 504].includes(err.status ?? 0) && esriActive.current) {
          esriActive.current = false;
          applyBaseMap(m, DEFAULT_BASE_MAP);
          props.current.onBaseMap?.(DEFAULT_BASE_MAP);
          toast.warning(err.status === 429 ? "Today's Esri map allowance is used up, so the Azure Maps base map is back." : "Esri's base map isn't available right now, so the Azure Maps base map is back.");
          return;
        }
        // A Planetary Computer tile refused (the day's allowance, Front Door's count, or the catalog itself) turns the
        // overlay off once, and the Esri base map stays.
        if (err?.url?.includes("/api/overlay/planetary/") && [403, 404, 429, 502, 503, 504].includes(err.status ?? 0) && overlay.current) {
          applyOverlay(m, null, 0);
          props.current.onOverlayOff?.();
          toast.warning(err.status === 429 ? "Today's Planetary Computer allowance is used up, so the overlay is off." : "The Planetary Computer overlay isn't available right now, so it's off.");
          return;
        }
        // A failed request while the satellite style has asked for no photo tiles may be its photo lookup (photosDirect).
        if (photoTiles.current === 0 && !esriActive.current && !L(PHOTOS)) watchPhotos(m, 3000);
        console.warn("Azure Maps:", e.error?.message);
      });
    })();
    const ro = new ResizeObserver(() => mapRef.current?.resize()); ro.observe(el);
    const ctxMenu = (e: MouseEvent) => {
      const P = props.current; const m = mapRef.current; if (!P.onContextPick || !m) return;
      e.preventDefault(); const r = el.getBoundingClientRect();
      const [pos] = m.pixelsToPositions([[e.clientX - r.left, e.clientY - r.top]]); P.onContextPick(pos[0], pos[1]);
    };
    const leave = () => props.current.onHover(null);
    el.addEventListener("contextmenu", ctxMenu); el.addEventListener("mouseleave", leave);
    return () => {
      live = false; window.clearTimeout(timer); window.clearTimeout(photoCheck.current); ro.disconnect();
      el.removeEventListener("contextmenu", ctxMenu); el.removeEventListener("mouseleave", leave);
      map?.dispose(); mapRef.current = null; layers.current = {}; sources.current = {}; setReady(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // controls used by the zoom, reset and base-map buttons
  useEffect(() => {
    const map = mapRef.current; if (!ready || !map || !p.controlRef) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    p.controlRef.current = {
      zoomBy: (d) => map.setCamera({ zoom: (map.getCamera().zoom ?? 0) + d, type: "ease", duration: reduce ? 0 : 250 }),
      reset: () => { ring.current = null; drawRing(); map.setCamera({ center: [HOME.lon, HOME.lat], zoom: AZ(HOME.zoom), type: reduce ? "jump" : "fly", duration: 900 }); },
      setBaseMap: (id, tiles) => applyBaseMap(map, id, tiles),
      setOverlay: (o, opacity) => applyOverlay(map, o, opacity),
    };
  }, [ready, p.controlRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current; const f = p.fly; if (!ready || !map || !f) return;
    ring.current = f.ringKm ? f : f.label ? { ...f, ringKm: 0 } : null; drawRing();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    map.setCamera({ center: [f.lon, f.lat], zoom: AZ(f.zoom), type: reduce ? "jump" : "fly", duration: 900 });
  }, [ready, p.fly]); // eslint-disable-line react-hooks/exhaustive-deps

  // layer switches and the selected basin
  const ly = p.layers;
  useEffect(() => {
    if (!ready) return;
    const vis = (id: string, v: boolean) => L(id)?.setOptions({ visible: v });
    for (const b of BASINS) vis(`gbx-depth-${b.id}`, ly.depth);
    vis("gbx-basin-fill", !ly.depth); vis("gbx-conf", ly.conf && !!p.overlay); vis("gbx-temp", ly.temp && !!p.tempOverlay);
    vis("gbx-faults", ly.faults); vis("gbx-folds", ly.faults); vis("gbx-seismic", ly.seismic && !!p.seismic);
    vis("gbx-bh-minor", ly.boreholes); vis("gbx-bh-major", ly.boreholes); vis("gbx-stress", ly.stress); vis("gbx-docs", ly.docs);
    const sel = p.selected ?? "";
    const isSel = ["==", ["get", "id"], sel];
    L("gbx-outline")?.setOptions({ strokeColor: expr(["case", isSel, "#ffffff", "rgba(207,237,253,0.85)"]), strokeWidth: expr(["case", isSel, 2.4, 1.4]) });
    L("gbx-outline-glow")?.setOptions({ strokeWidth: expr(["case", isSel, 9, 5]), strokeOpacity: expr(["case", isSel, 0.6, 0.45]) });
    L("gbx-basin-fill")?.setOptions({ fillColor: expr(["case", isSel, "rgba(161,221,252,0.16)", "rgba(161,221,252,0.07)"]) });
  }, [ready, ly.depth, ly.conf, ly.temp, ly.faults, ly.seismic, ly.boreholes, ly.stress, ly.docs, p.selected, p.overlay, p.tempOverlay, p.seismic]); // eslint-disable-line react-hooks/exhaustive-deps

  // borehole filter: a filter shows every match from zoom 4.6; otherwise named wells first, all boreholes from zoom 7
  const F = p.bhFilter; const fKey = JSON.stringify(filterOn(F) ? F : null);
  useEffect(() => {
    if (!ready) return;
    const on = filterOn(F);
    L("gbx-bh-minor")?.setOptions({ filter: bhFilter(F, false), minZoom: AZ(on ? 4.6 : 7) });
    L("gbx-bh-major")?.setOptions({ filter: bhFilter(F, true), minZoom: AZ(on ? 4.6 : 5.9) });
  }, [ready, fKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return;
    S("hl")?.setShapes(p.highlight.size ? BH.filter((w) => p.highlight.has(w.key)).map((w) => new atlas.data.Point([w.lon, w.lat])) : []);
  }, [ready, p.highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  // depth tint (and the depth lens): rebuilt shortly after the lens stops moving
  const lensKey = JSON.stringify(p.depthLens ?? null);
  useEffect(() => {
    if (!ready || lensKey === lensDone.current) return;
    const t = window.setTimeout(() => {
      lensDone.current = lensKey; const lens = JSON.parse(lensKey) as [number, number] | null;
      for (const b of BASINS) L(`gbx-depth-${b.id}`)?.setOptions({ url: depthImage(b, lens).url });
    }, 120);
    return () => window.clearTimeout(t);
  }, [ready, lensKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // OzTemp temperature overlay (low-carbon lens), created the first time it is needed
  const tempSrc = p.tempOverlay?.src ?? "";
  useEffect(() => {
    const map = mapRef.current; const tv = p.tempOverlay; if (!ready || !map || !tv || L("gbx-temp")) return;
    let live = true;
    void overlayImage(tv.src, tv.bounds).then((im) => {
      if (!live || mapRef.current !== map || L("gbx-temp")) return;
      const layer = new atlas.layer.ImageLayer({ url: im.url, coordinates: im.coords, opacity: 0.6, visible: props.current.layers.temp }, "gbx-temp");
      map.layers.add(layer, `gbx-depth-${BASINS[0].id}`); layers.current["gbx-temp"] = layer;
    }).catch(() => undefined);
    return () => { live = false; };
  }, [ready, tempSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  const docKey = JSON.stringify([ly.docs, p.activeDoc, p.docPoints?.map((d) => [d.id, d.n, d.lon, d.lat])]);
  useEffect(() => {
    if (!ready) return;
    S("docs")?.setShapes((p.docPoints ?? []).map((d) => { const act = d.id === p.activeDoc; const r = Math.min(9, 3.5 + Math.log2(1 + d.n) * 1.6) + (act ? 2 : 0); return point([d.lon, d.lat], { n: d.n, act, s: r / 9 }); }));
  }, [ready, docKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const siteKey = JSON.stringify([ly.sites, p.activeSite, p.sites?.map((s) => [s.id, s.lon, s.lat, s.label, s.tag, s.kind])]);
  useEffect(() => {
    if (!ready) return;
    const sites = ly.sites ? p.sites ?? [] : [];
    S("sites")?.setShapes(sites.map((s) => point([s.lon, s.lat], { label: s.label, tag: s.tag, kind: s.kind, act: s.id === p.activeSite })));
    drawRing();
  }, [ready, siteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinKey = JSON.stringify([p.activePin, p.pins.map((q) => [q.id, q.lon, q.lat, q.label])]);
  useEffect(() => {
    if (!ready) return;
    S("pins")?.setShapes(p.pins.map((q) => point([q.lon, q.lat], { label: q.label.slice(0, 40), act: q.id === p.activePin })));
  }, [ready, pinKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hereKey = p.here ? `${p.here.lon},${p.here.lat}` : "";
  useEffect(() => {
    if (!ready) return;
    S("here")?.setShapes(p.here ? [new atlas.data.Point([p.here.lon, p.here.lat])] : []);
  }, [ready, hereKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const secKey = JSON.stringify([p.section, p.sectionPath?.length ?? 0, p.sectionPath?.[1]]);
  useEffect(() => {
    if (!ready) return;
    const sec = p.section;
    S("sec-line")?.setShapes(sec?.b ? [new atlas.data.LineString(p.sectionPath?.length ? p.sectionPath : [sec.a, sec.b])] : []);
    S("sec-pts")?.setShapes(sec ? [point(sec.a, { t: "A" }), ...(sec.b ? [point(sec.b, { t: "B" })] : [])] : []);
  }, [ready, secKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const areaKey = JSON.stringify([p.area?.closed ?? null, p.area?.pts ?? null, !!p.areaPick]);
  useEffect(() => {
    if (!ready) return;
    const ar = p.area; const pts = ar?.pts ?? [];
    S("area-fill")?.setShapes(pts.length >= 3 ? [new atlas.data.Polygon([[...pts, pts[0]]])] : []);
    S("area")?.setShapes(ar && pts.length >= 2 ? [new atlas.data.LineString(ar.closed ? [...pts, pts[0]] : pts)] : []);
    S("area-pts")?.setShapes(ar && !ar.closed ? pts.map((q, i) => point(q, { first: i === 0 && pts.length >= 3 })) : []);
    if (!ar || ar.closed || !p.areaPick || !pts.length) S("area-rubber")?.clear();
  }, [ready, areaKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current; if (!ready || !map) return;
    map.getCanvasContainer().style.cursor = p.tagMode || p.sectionPick || p.areaPick ? "crosshair" : "";
    // A double-click finishes an area, so it mustn't also zoom while one is being drawn, nor at the end of the gesture
    // that closed it: zoom comes back only once that gesture is over. Starting to draw is a new gesture, so whatever
    // closed the last area no longer holds clicks back.
    if (p.areaPick) { areaSettle.current = 0; map.setUserInteraction({ dblClickZoomInteraction: false }); return; }
    const t = window.setTimeout(() => mapRef.current?.setUserInteraction({ dblClickZoomInteraction: true }), Math.max(0, areaSettle.current - performance.now()));
    return () => window.clearTimeout(t);
  }, [ready, p.tagMode, p.sectionPick, p.areaPick]);

  if (failed) return <BasinMap {...p} />;
  // The SDK restyles its container (position, role and label), so it gets an inner element sized inline, and this
  // app's description of the map stays on the outer region.
  return (
    <div ref={outerRef} className="absolute inset-0 bg-brand-stage" role="region" data-gbx-map="azure"
      aria-label="Azure Maps map of the Cooper, Adavale, Galilee and North Bowen basins with depth to basin floor, faults, boreholes, seismic lines, stress, data confidence, evidence wells and saved notes. Click anywhere to see what is known there.">
      <div ref={wrapRef} style={{ position: "absolute", inset: 0 }} />
      {photoCredit && <div className="pointer-events-none absolute bottom-[22px] right-14 z-20 max-w-[min(70%,42rem)] truncate rounded bg-black/60 px-1.5 text-[10px] leading-[13px] text-white/90" data-gbx-photo-credit>
        <span className="sr-only">Satellite photo credits: </span>{photoCredit}
      </div>}
      {pcHint && !p.sectionPick && !p.areaPick && <button type="button" data-gbx-planetary-hint
        onClick={() => { const [w, s, e, n] = pcHint.bounds; mapRef.current?.setCamera({ center: [(w + e) / 2, (s + n) / 2], zoom: Math.max(pcHint.minZoom + 1, 7), type: "ease", duration: 700 }); }}
        className="absolute left-1/2 top-[88px] z-10 -translate-x-1/2 rounded-full bg-brand-bar/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-white/25 hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-white">
        The overlay covers only the Cooper Basin. Zoom there
      </button>}
    </div>
  );
}
export default AzureBasinMap;
