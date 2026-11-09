import { Crosshair, FileSearch, MapPinPlus, MessageSquareText, Spline, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmt, depthLabel } from "@/lib/basins";
import type { HereInfo, NearSource } from "@/lib/pack";
import { BuildChip } from "@/components/panels/common";
import { WindowGrip } from "@/components/map-window";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

const U_CLS = { Low: "bg-emerald-700 text-white", Medium: "bg-amber-500 text-black", High: "bg-red-700 text-white" } as const;
/* "p. 9", "pp. 6, 9 and 18", or "40 pages"; the place is left out when the title already names it. */
const pagesOf = (s: NearSource) => (!s.pages.length ? "" : s.pages.length === 1 ? `, p. ${s.pages[0]}` : s.pages.length <= 3 ? `, pp. ${s.pages.slice(0, -1).join(", ")} and ${s.pages[s.pages.length - 1]}` : `, ${s.pages.length} pages`);
const placeOf = (s: NearSource) => (s.place && !s.doc.toLowerCase().includes(s.place.toLowerCase()) ? ` · ${s.place}` : "");
export function HereCard({ info, onClose, onFly, onOpenWell, showBuild, onTag, onSection, onAskNear }: { info: HereInfo; onClose: () => void; onFly: (lon: number, lat: number) => void; onOpenWell: (id: string) => void; showBuild: boolean; onTag?: () => void; onSection?: () => void; onAskNear?: () => void }) {
  const rawSources = info.sources;
  const src = !GATED || !rawSources ? rawSources : { ...rawSources,
    sources: rawSources.sources.filter((s) => !LICENCE.isWithheldPassage(s)),
    nearest: rawSources.nearest && !LICENCE.isWithheldPassage(rawSources.nearest) ? rawSources.nearest : null };
  return (
    <section aria-labelledby="here-h" className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card text-sm text-card-foreground shadow-xl">
      <div data-window-drag className="flex items-start justify-between gap-2 border-b px-3 pb-2 pt-3">
        <div className="min-w-0">
          <h2 id="here-h" className="font-semibold">What we know here</h2>
          <p className="text-xs text-muted-foreground">{Math.abs(info.lat).toFixed(4)}°S {info.lon.toFixed(4)}°E · GDA94 · {info.basinName ?? "outside the four basins"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5"><WindowGrip /><Button type="button" variant="ghost" size="icon-sm" aria-label="Close what we know here" onClick={onClose}><X aria-hidden="true" /></Button></div>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3 pt-2.5">
      {showBuild && <BuildChip cap="What we know here" />}
      <div className="rounded-lg border p-2">
        <div className="flex items-center justify-between gap-2"><span className="font-medium">Uncertainty</span><Badge className={U_CLS[info.uncertainty]}>{info.uncertainty}</Badge></div>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">{info.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className="mt-1 text-xs text-muted-foreground">How it's worked out: distance to the nearest borehole, plus Geoscience Australia's borehole and seismic confidence grids.{info.geo ? " Distances are geodesic, measured by the GDAL/PROJ spatial service." : ""}</p>
        {info.checking && <p role="status" className="mt-1 text-xs text-muted-foreground">Confirming these figures with the GDAL/PROJ spatial service…</p>}
        {info.geoError && <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-400">The spatial service didn't answer ({info.geoError}), so these figures were worked out in the browser.</p>}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Depth to basin floor</dt><dd className="font-semibold tabular-nums">{depthLabel(info.depth)}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Boreholes within 10 km</dt><dd className="font-semibold tabular-nums">{fmt(info.within10)}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">GA borehole confidence</dt><dd className="font-semibold">{info.ga.boreholes == null ? "No grid here" : `Higher than ${info.ga.boreholes}%`}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-muted-foreground">GA seismic confidence</dt><dd className="font-semibold">{info.ga.seismic == null ? "No grid here" : `Higher than ${info.ga.seismic}%`}</dd></div>
      </dl>
      {info.geo && (
        <section aria-label="Position in GDA2020 and MGA" className="space-y-0.5 rounded-lg border p-2 text-xs">
          <h3 className="font-semibold">Position in GDA2020 and MGA</h3>
          <p>In GDA2020 this point is {Math.abs(info.geo.gda2020.lat).toFixed(6)}°S {info.geo.gda2020.lon.toFixed(6)}°E, {fmt(info.geo.gda2020.shiftM, 2)} m from its GDA94 position.</p>
          <p>MGA zone {info.geo.mga.zone}: E {fmt(info.geo.mga.gda94.easting, 1)} N {fmt(info.geo.mga.gda94.northing, 1)} in GDA94 (EPSG:{info.geo.mga.gda94.epsg}), and E {fmt(info.geo.mga.gda2020.easting, 1)} N {fmt(info.geo.mga.gda2020.northing, 1)} in GDA2020 (EPSG:{info.geo.mga.gda2020.epsg}).</p>
          <p className="text-muted-foreground">Transformed with PROJ {info.geo.versions.proj} and GDAL {info.geo.versions.gdal} in {info.geo.ms} ms.</p>
        </section>
      )}
      <section aria-label="Nearest evidence" className="space-y-1">
        <h3 className="text-xs font-semibold">Nearest boreholes</h3>
        {info.boreholes.length ? (
          <ul className="space-y-0.5 text-xs">
            {info.boreholes.slice(0, 4).map((b) => (
              <li key={b.key} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{b.name}{b.td ? ` · TD ${fmt(b.td)} m` : ""}{b.year ? ` · ${b.year}` : ""}</span>
                <button type="button" className="shrink-0 tabular-nums underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onFly(b.lon, b.lat)}>{b.km.toFixed(1)} km</button>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs">None within about 100 km.</p>}
        <p className="text-xs">{info.stress ? `Nearest stress record ${info.stress.km.toFixed(0)} km: SHmax N${Math.round(info.stress.azi)}°E, quality ${info.stress.quality}.` : "No stress record within 150 km."}</p>
        <p className="text-xs">{info.seismicKm != null && info.basin !== "cooper" ? `Nearest bundled 2D seismic line: ${info.seismicKm.toFixed(1)} km.` : info.basin === "cooper" ? "Cooper Basin seismic lines are not bundled; use the GA seismic confidence above." : "No bundled seismic line nearby."}</p>
        {info.features.length > 0 && <p className="text-xs">Named features nearby: {info.features.map((f) => `${f.name} (${f.km.toFixed(0)} km)`).join(" · ")}</p>}
        {info.wells.filter((w) => !GATED || !LICENCE.isWithheldWell(w.id)).map((w) => (
          <Button key={w.id} type="button" size="xs" variant="secondary" onClick={() => onOpenWell(w.id)}><FileSearch aria-hidden="true" /> {w.name} scanned report · {w.km.toFixed(0)} km</Button>
        ))}
      </section>
      {(src || info.sourcesChecking || info.sourcesError) && (
        <section aria-label="Sources near here" className="space-y-1">
          <h3 className="text-xs font-semibold">Sources near here</h3>
          {info.sourcesChecking && <p role="status" className="text-xs text-muted-foreground">Searching the library for sources geotagged near here…</p>}
          {info.sourcesError && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">The library search didn't answer ({info.sourcesError}).</p>}
          {src && (src.sources.length ? (
            <ul className="space-y-0.5 text-xs">
              {src.sources.slice(0, 5).map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0">{s.doc}{pagesOf(s)}<span className="text-muted-foreground">{placeOf(s)}{s.yours ? " · your upload" : ""}</span></span>
                  <button type="button" aria-label={`Show ${s.place} on the map, ${s.km.toFixed(1)} km away`} className="shrink-0 tabular-nums underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onFly(s.lon, s.lat)}>{s.km.toFixed(1)} km</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs">No source in the library is geotagged within {src.km} km{src.nearest ? `. The nearest is ${src.nearest.doc}${pagesOf(src.nearest)}, which names ${src.nearest.place} about ${fmt(src.nearest.km, 0)} km away.` : ", or within 300 km."}</p>
          ))}
          {src && <p className="text-xs text-muted-foreground">{fmt(src.matched)} passage{src.matched === 1 ? "" : "s"} within {src.km} km{src.basin ? `, and ${fmt(src.basin.passages)} more about the ${src.basin.name} as a whole` : ""}. Found by Azure AI Search from each passage's geotags in {fmt(src.ms)} ms; distances are great-circle.</p>}
        </section>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer font-semibold">Coordinate reference systems</summary>
        <ul className="mt-1 space-y-0.5">{info.crs.map((c) => <li key={c.item} className="grid grid-cols-[9rem_1fr] gap-1"><span className="text-muted-foreground">{c.item}</span><span>{c.crs}</span></li>)}</ul>
      </details>
      <p className="flex items-center gap-1 text-xs text-muted-foreground"><Crosshair className="size-3.5" aria-hidden="true" /> Sources: GA basin packages (CC BY 4.0), World Stress Map 2025.</p>
      </div>
      {(onTag || onSection || onAskNear) && <div className="flex shrink-0 flex-wrap gap-1.5 border-t px-3 py-2">
        {onAskNear && <Button type="button" size="xs" variant="secondary" onClick={onAskNear}><MessageSquareText aria-hidden="true" /> Ask about this place</Button>}
        {onTag && <Button type="button" size="xs" variant="secondary" onClick={onTag}><MapPinPlus aria-hidden="true" /> Tag this spot</Button>}
        {onSection && <Button type="button" size="xs" variant="secondary" onClick={onSection}><Spline aria-hidden="true" /> Start a section here</Button>}
      </div>}
    </section>
  );
}
export const UNCERTAINTY_CLS = U_CLS;
export const cnU = (u: keyof typeof U_CLS) => cn("rounded px-1.5 py-0.5 text-xs font-semibold", U_CLS[u]);
