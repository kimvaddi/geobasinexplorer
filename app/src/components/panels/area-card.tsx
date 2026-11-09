import { FileSearch, Focus, Highlighter, Pentagon, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { azimuthLabel, fmt, regimeLabel } from "@/lib/basins";
import type { AreaFacts } from "@/lib/area";
import { GATED, type AreaSource, type AreaSources, type PlanetaryArea } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";
import { WindowGrip } from "@/components/map-window";

/* "What we know in this area": the card for an outline drawn on the map. The browser's counts of the map's own layers
   show at once; in the cloud build the library's sources geotagged inside the outline (Azure AI Search) and what
   Planetary Computer Pro holds there follow, each saying where it came from, or why it couldn't be had. */
export interface AreaInfo extends AreaFacts {
  sources?: AreaSources; sourcesChecking?: boolean; sourcesError?: string;
  pc?: PlanetaryArea; pcChecking?: boolean; pcError?: string;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const pagesOf = (s: AreaSource) => (!s.pages.length ? "" : s.pages.length === 1 ? `, p. ${s.pages[0]}` : s.pages.length <= 3 ? `, pp. ${s.pages.slice(0, -1).join(", ")} and ${s.pages[s.pages.length - 1]}` : `, ${s.pages.length} pages`);
const placeOf = (s: AreaSource) => (s.place && !s.doc.toLowerCase().includes(s.place.toLowerCase()) ? ` · ${s.place}` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const pct = (share: number) => (share >= 0.995 ? "All" : share < 0.005 ? "Under 1%" : `${Math.round(share * 100)}%`);

export function AreaCard({ info, onClose, onFly, onOpenWell, onZoom, onHighlight, highlighted, onSave, onRedraw }: {
  info: AreaInfo; onClose: () => void; onFly: (lon: number, lat: number) => void; onOpenWell: (id: string) => void; onZoom: () => void;
  onHighlight: () => void; highlighted: boolean; onSave?: () => void; onRedraw: () => void;
}) {
  const wells = info.wells.filter((w) => !GATED || !LICENCE.isWithheldWell(w.id));
  const src = !GATED || !info.sources ? info.sources : { ...info.sources, sources: info.sources.sources.filter((s) => !LICENCE.isWithheldPassage(s)) };
  const where = info.basins.length
    ? `${info.basins.map((b) => `${pct(b.share)} in the ${b.name}`).join(", ")}${info.outside >= 0.005 ? `, ${pct(info.outside).toLowerCase()} outside the four basins` : ""}`
    : "Outside the four basins";
  const bh = info.boreholes;
  const cooper = info.basins.some((b) => b.id === "cooper");
  const pc = info.pc;
  const scenes = pc?.scenes ?? [];
  const clouds = scenes.map((s) => s.cloud).filter((c): c is number => c != null);
  return (
    <section aria-labelledby="area-h" data-gbx-area className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card text-sm text-card-foreground shadow-xl">
      <div data-window-drag className="flex items-start justify-between gap-2 border-b px-3 pb-2 pt-3">
        <div className="min-w-0">
          <h2 id="area-h" className="font-semibold">What we know in this area</h2>
          <p className="text-xs text-muted-foreground">{fmt(info.areaKm2, info.areaKm2 < 10 ? 1 : 0)} km² · {fmt(info.perimeterKm, info.perimeterKm < 10 ? 1 : 0)} km around · {info.ring.length} corners · GDA94</p>
          <p className="text-xs">{where}.</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5"><WindowGrip /><Button type="button" variant="ghost" size="icon-sm" aria-label="Close what we know in this area" onClick={onClose}><X aria-hidden="true" /></Button></div>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3 pt-2.5">
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Depth to basin floor</dt><dd className="font-semibold tabular-nums">{info.depth ? `${fmt(Math.round(info.depth.min / 10) * 10)} to ${fmt(Math.round(info.depth.max / 10) * 10)} m` : "Not mapped here"}</dd>{info.depth && <dd className="text-muted-foreground tabular-nums">mean {fmt(Math.round(info.depth.mean / 10) * 10)} m</dd>}</div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Boreholes inside</dt><dd className="font-semibold tabular-nums">{fmt(bh.n)}</dd>{bh.filtered != null && <dd className="text-muted-foreground tabular-nums">{fmt(bh.filtered)} match your filter</dd>}</div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Fault traces</dt><dd className="font-semibold tabular-nums">{info.faults.n ? `${fmt(info.faults.n)} · ${fmt(info.faults.km)} km` : "None"}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">2D seismic lines</dt><dd className="font-semibold tabular-nums">{info.seismic.lines ? `${fmt(info.seismic.lines)} · ${fmt(info.seismic.km)} km` : cooper ? "Not bundled for the Cooper" : "None bundled"}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Stress records</dt><dd className="font-semibold tabular-nums">{info.stress.n ? `${fmt(info.stress.n)} · SHmax ${azimuthLabel(info.stress.azimuth)}` : "None"}</dd>{info.stress.n > 0 && <dd className="text-muted-foreground">{fmt(info.stress.good)} of quality A to C{info.stress.regime ? `, mostly ${regimeLabel(info.stress.regime)}` : ""}</dd>}</div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Well reports</dt><dd className="font-semibold tabular-nums">{wells.length ? fmt(wells.length) : "None"}</dd></div>
      </dl>
      {wells.length > 0 && <div className="flex flex-wrap gap-1.5">{wells.map((w) => (
        <Button key={w.id} type="button" size="xs" variant="secondary" onClick={() => onOpenWell(w.id)}><FileSearch aria-hidden="true" /> {w.name} scanned report{w.year ? ` (${w.year})` : ""}</Button>
      ))}</div>}
      <section aria-label="Boreholes in this area" className="space-y-1">
        <h3 className="text-xs font-semibold">{bh.named ? "Deepest named boreholes" : "Deepest boreholes"}</h3>
        {bh.list.length ? (
          <ul className="space-y-0.5 text-xs">{bh.list.map((b) => (
            <li key={b.key} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{b.name}{b.year ? ` · ${b.year}` : ""}</span>
              <button type="button" aria-label={`Show ${b.name} on the map`} className="shrink-0 tabular-nums underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onFly(b.lon, b.lat)}>{b.td ? `TD ${fmt(b.td)} m` : "show"}</button>
            </li>
          ))}</ul>
        ) : <p className="text-xs">No borehole lies inside this area.</p>}
        {bh.n > 0 && <p className="text-xs text-muted-foreground">{plural(bh.n, "borehole")}, {fmt(bh.named)} named{bh.years ? `, drilled ${bh.years[0] === bh.years[1] ? `in ${bh.years[0]}` : `from ${bh.years[0]} to ${bh.years[1]}`}` : ""}{bh.deepest ? `; the deepest reached ${fmt(bh.deepest)} m` : ""}.</p>}
        {info.features.length > 0 && <p className="text-xs">Named features inside: {info.features.slice(0, 8).map((f) => f.name).join(" · ")}{info.features.length > 8 ? ` and ${info.features.length - 8} more` : ""}</p>}
      </section>
      {(src || info.sourcesChecking || info.sourcesError) && (
        <section aria-label="Sources in this area" className="space-y-1">
          <h3 className="text-xs font-semibold">Library sources in this area</h3>
          {info.sourcesChecking && <p role="status" className="text-xs text-muted-foreground">Searching the library for sources geotagged inside this area…</p>}
          {info.sourcesError && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">The library search didn't answer ({info.sourcesError}).</p>}
          {src && (src.sources.length ? (
            <ul className="space-y-0.5 text-xs">{src.sources.slice(0, 6).map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">{s.doc}{pagesOf(s)}<span className="text-muted-foreground">{placeOf(s)}{s.yours ? " · your upload" : ""}</span></span>
                <button type="button" aria-label={`Show ${s.place || s.doc} on the map`} className="shrink-0 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onFly(s.lon, s.lat)}>show</button>
              </li>
            ))}</ul>
          ) : <p className="text-xs">No source in the library is geotagged inside this area.</p>)}
          {src && <p className="text-xs text-muted-foreground">{plural(src.matched, "passage")} in {plural(src.documents, "document")} geotagged inside it{src.basins.length ? `, and ${src.basins.map((b) => `${fmt(b.passages)} more about the ${b.name} as a whole`).join(", ")}` : ""}. Found by Azure AI Search with the outline as a polygon filter in {fmt(src.ms)} ms.</p>}
        </section>
      )}
      {(pc || info.pcChecking || info.pcError) && (
        <section aria-label="Planetary Computer in this area" data-gbx-area-planetary className="space-y-1">
          <h3 className="text-xs font-semibold">Microsoft Planetary Computer Pro</h3>
          {info.pcChecking && <p role="status" className="text-xs text-muted-foreground">Asking Planetary Computer Pro about this area…</p>}
          {info.pcError && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">Planetary Computer didn't answer ({info.pcError}).</p>}
          {pc && !pc.covered && <p className="text-xs">The catalog holds Copernicus data for the Cooper Basin only, and this area lies outside it.</p>}
          {pc?.covered && <>
            <p className="text-xs">{pc.elevation
              ? <>Ground height from the Copernicus DEM: <span className="font-semibold tabular-nums">{fmt(pc.elevation.min)} to {fmt(pc.elevation.max)} m</span>, mean {fmt(pc.elevation.mean)} m above sea level, from {fmt(pc.elevation.samples)} samples across {plural(pc.elevation.tiles, "DEM tile")}.</>
              : pc.elevationNote ?? "The Copernicus DEM holds no data inside this area."}</p>
            <p className="text-xs">{scenes.length
              ? `Sentinel-2 imagery: ${plural(scenes.length, "scene")} from 2025 ${scenes.length === 1 ? "covers" : "cover"} this area, ${scenes.length === 1 ? `taken on ${day(scenes[0].date)}` : `taken from ${day(scenes[0].date)} to ${day(scenes[scenes.length - 1].date)}`}${clouds.length ? `, with ${Math.max(...clouds) < 1 ? "under 1%" : `at most ${fmt(Math.max(...clouds), 1)}%`} cloud` : ""}.`
              : "No Sentinel-2 scene in the catalog covers this area."}</p>
            {scenes.length > 0 && <ul className="space-y-0.5 text-xs text-muted-foreground">{scenes.slice(0, 4).map((s) => <li key={s.id}>{day(s.date)}{s.tile ? ` · grid square ${s.tile}` : ""}{s.cloud != null ? ` · ${s.cloud < 0.05 ? "no" : `${fmt(s.cloud, 1)}%`} cloud` : ""}</li>)}{scenes.length > 4 && <li>and {plural(scenes.length - 4, "more scene")}</li>}</ul>}
            {pc.elevation && <p className="text-[11px] leading-snug text-muted-foreground" data-gbx-area-credit>{pc.credits.elevation}</p>}
            {scenes.length > 0 && <p className="text-[11px] leading-snug text-muted-foreground" data-gbx-area-credit>{pc.credits.imagery}</p>}
            <p className="text-xs text-muted-foreground">From the GeoBasin GeoCatalog in {fmt(pc.ms)} ms: a STAC search of each collection, and the DEM's statistics inside the outline.</p>
          </>}
        </section>
      )}
      <p className="text-xs text-muted-foreground">How it's worked out: the map's own layers are counted in your browser, inside the outline as drawn; areas and lengths are on a sphere of mean radius 6,371 km, and the depth is sampled from the GA depth-to-basement grids. Sources: GA basin packages (CC BY 4.0), World Stress Map 2025.</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5 border-t px-3 py-2">
        <Button type="button" size="xs" variant="secondary" onClick={onZoom}><Focus aria-hidden="true" /> Zoom to the area</Button>
        {bh.n > 0 && <Button type="button" size="xs" variant="secondary" aria-pressed={highlighted} onClick={onHighlight}><Highlighter aria-hidden="true" /> {highlighted ? "Clear the highlight" : `Highlight ${bh.n === 1 ? "the borehole" : `the ${fmt(bh.n)} boreholes`}`}</Button>}
        {onSave && <Button type="button" size="xs" variant="secondary" onClick={onSave}><Save aria-hidden="true" /> Save to notes</Button>}
        <Button type="button" size="xs" variant="secondary" onClick={onRedraw}><Pentagon aria-hidden="true" /> Draw another area</Button>
      </div>
    </section>
  );
}
