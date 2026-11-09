import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PACK, WELLS, wellById } from "@/lib/pack";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";
import type { Site, SiteField } from "@/lib/wells";
import { WellEvidence } from "@/components/panels/evidence-wells";
import { FigureView, LasReader, VelocityView, Zoomable } from "@/components/panels/evidence-items";

export type EvItem = "innamincka-1" | "marabooka-1" | "velocity" | "figure" | "las" | "core" | "charts" | "pages";
const DT_BADGE = { "legacy-scan": ["Legacy scan", "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"], structured: ["Structured data", "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100"], "born-digital": ["Born-digital", "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100"] } as const;
interface Card { id: EvItem; title: string; dt: keyof typeof DT_BADGE; tests: string; available: boolean }
const CARDS: Card[] = [
  { id: "marabooka-1", title: "Marabooka 1 · 1981 report", dt: "legacy-scan", tests: "420 scanned pages. Formation tops, tests and casing, each with its page. One well, three printed positions.", available: !!wellById("marabooka-1") },
  { id: "velocity", title: "Marabooka 1 · checkshot and velocity chart", dt: "legacy-scan", tests: "A scanned table and a hand-drawn chart, read cell by cell and cross-checked.", available: !!PACK.velocity },
  { id: "figure", title: "Seismic line 80-KBK · report pages", dt: "legacy-scan", tests: "A seismic section, its key and a location map. What can be read, and where a machine goes wrong.", available: PACK.figures.length > 0 },
  { id: "las", title: "LAS log reader", dt: "structured", tests: "Open any LAS file to see its header, curves and problems. No LAS file is bundled.", available: true },
  { id: "core", title: "Core photographs", dt: "structured", tests: `${PACK.core.photos.length} Geoscience Australia core photos by formation and well`, available: PACK.core.photos.length > 0 },
  { id: "charts", title: "Stratigraphic charts", dt: "born-digital", tests: "The four published basin frameworks behind the plays", available: PACK.charts.length > 0 },
  { id: "pages", title: "Cooper Basin data guide pages", dt: "born-digital", tests: "The five pages answers cite, so you can check them by eye.", available: PACK.reportPages.length > 0 },
];

export function EvidencePanel(p: { item: EvItem | null; setItem: (i: EvItem | null) => void; focusField: string | null; showBuild: boolean; reviewed: Record<string, string>; onReview: (s: Site, f: SiteField, d: "accepted" | "edited", v?: string) => void; onShowWell: (s: Site) => void; onAsk: (q: string) => void }) {
  if (!p.item) return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Evidence and stress tests</h2>
        <p className="text-sm">Real public files, including messy ones. Each shows what we read, how sure we are, and where the reading failed.</p>
      </header>
      <ul className="space-y-2">
        {CARDS.filter((c) => !GATED || !LICENCE.isWithheldWell(c.id)).map((c) => (
          <li key={c.id}>
            <button type="button" disabled={!c.available} onClick={() => p.setItem(c.id)} className="flex w-full items-start gap-2 rounded-lg border p-2.5 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{c.title}</span><span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", DT_BADGE[c.dt][1])}>{DT_BADGE[c.dt][0]}</span>{!c.available && <Badge className="bg-muted text-foreground">Not included</Badge>}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{c.tests}</span>
              </span>
              <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
  const back = <Button type="button" size="xs" variant="ghost" onClick={() => p.setItem(null)}><ArrowLeft aria-hidden="true" /> All evidence</Button>;
  const site = p.item === "innamincka-1" || p.item === "marabooka-1" ? wellById(p.item) : null;
  return (
    <div className="space-y-3">
      {back}
      {site && <WellEvidence site={site} showBuild={p.showBuild} focusField={p.focusField} reviewed={p.reviewed} onReview={p.onReview} onShowOnMap={p.onShowWell} extra={site.siteId === "marabooka-1" ? <PositionCheck /> : null} />}
      {p.item === "velocity" && <VelocityView showBuild={p.showBuild} />}
      {p.item === "figure" && <FigureView showBuild={p.showBuild} />}
      {p.item === "las" && <LasReader showBuild={p.showBuild} />}
      {p.item === "core" && <CoreGallery onAsk={p.onAsk} />}
      {p.item === "charts" && <Gallery title="Stratigraphic charts" items={PACK.charts.map((c) => ({ id: c.id, src: c.img, alt: c.title, cap: `Geoscience Australia ${c.id} · CC BY 4.0` }))} />}
      {p.item === "pages" && <Gallery title="Cooper Basin data guide · pages 1–5" items={PACK.reportPages.map((r) => ({ id: `${r.doc}-${r.page}`, src: r.img, alt: `${r.doc} · page ${r.page}`, cap: "Geoscience Australia, eCat 147461 · CC BY 4.0" }))} />}
    </div>
  );
}
function PositionCheck() {
  const pc = PACK.positions;
  if (!pc) return null;
  return (
    <section aria-labelledby="pos-h" className="space-y-1.5 rounded-xl border p-3 text-xs">
      <h3 id="pos-h" className="text-sm font-semibold">One well, three positions</h3>
      <table className="w-full">
        <caption className="sr-only">Printed positions compared with the Geoscience Australia borehole layer</caption>
        <thead><tr className="text-left text-muted-foreground"><th scope="col" className="py-0.5 pr-1 font-medium">Source</th><th scope="col" className="py-0.5 pr-1 font-medium">Datum</th><th scope="col" className="py-0.5 text-right font-medium">From GA position</th></tr></thead>
        <tbody>{pc.rows.map((r) => <tr key={r.source} className="border-t align-top"><td className="py-1 pr-1"><span className="font-medium">{r.source}</span><span className="block text-muted-foreground">{r.printed}</span></td><td className="py-1 pr-1">{r.datum}</td><td className="py-1 text-right tabular-nums">{r.kmFromGA < 0.05 ? "< 0.05 km" : `${r.kmFromGA.toFixed(2)} km`}</td></tr>)}</tbody>
      </table>
      <p>{pc.note}</p>
      <p className="text-muted-foreground">GA position: {Math.abs(pc.ga.lat).toFixed(5)}°S {pc.ga.lon.toFixed(5)}°E · {pc.ga.source}</p>
    </section>
  );
}
const depthRange = (d: unknown) => (Array.isArray(d) && d.length ? `${Math.min(...(d as number[])).toLocaleString("en-US")}–${Math.max(...(d as number[])).toLocaleString("en-US")} m` : "");
const wellList = (w: unknown) => (Array.isArray(w) ? (w as string[]).join(", ") : typeof w === "string" ? w : "");
function CoreGallery({ onAsk }: { onAsk: (q: string) => void }) {
  const photos = PACK.core.photos;
  const forms = useMemo(() => [...new Set(photos.map((x) => x.formation))].sort(), [photos]);
  const [f, setF] = useState<string>("all");
  const list = f === "all" ? photos : photos.filter((x) => x.formation === f);
  return (
    <div className="space-y-3">
      <header className="space-y-1"><h2 className="text-base font-semibold">Core photographs</h2><p className="text-xs text-muted-foreground">Geoscience Australia core photography · CC BY 4.0. Depths as printed with each photo.</p></header>
      <div className="space-y-1"><label htmlFor="core-f" className="text-xs font-medium">Formation</label>
        <select id="core-f" value={f} onChange={(e) => setF(e.target.value)} className="h-8 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"><option value="all">All formations ({photos.length})</option>{forms.map((x) => <option key={x} value={x}>{x}</option>)}</select>
      </div>
      <ul className="grid grid-cols-2 gap-2">{list.map((ph) => (
        <li key={ph.id} className="space-y-1"><Zoomable src={ph.img} alt={`${ph.formation}${wellList(ph.wells) ? `, ${wellList(ph.wells)}` : ""}`} caption={[ph.play, depthRange(ph.depths_m), ph.file].filter(Boolean).join(" · ")} className="[&_img]:max-h-32" action={{ label: "Find text about this", onClick: () => onAsk(`Tell me about the ${ph.formation}`) }} />
          <p className="text-[11px] leading-tight"><span className="font-medium">{ph.formation}</span>{wellList(ph.wells) ? ` · ${wellList(ph.wells)}` : ""}{depthRange(ph.depths_m) ? ` · ${depthRange(ph.depths_m)}` : ""}</p></li>
      ))}</ul>
    </div>
  );
}
function Gallery({ title, items }: { title: string; items: { id: string; src: string; alt: string; cap: string }[] }) {
  return (
    <div className="space-y-3"><h2 className="text-base font-semibold">{title}</h2>
      <ul className="space-y-3">{items.map((x) => <li key={x.id} className="space-y-1"><Zoomable src={x.src} alt={x.alt} caption={x.cap} /><p className="text-xs"><span className="font-medium">{x.alt}</span> · {x.cap}</p></li>)}</ul>
    </div>
  );
}
export const EVIDENCE_WELLS = WELLS;
