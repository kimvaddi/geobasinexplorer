import { useRef, useState } from "react";
import { AlertTriangle, CircleCheck, CircleX, FileUp, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/basins";
import { PACK, type FigureItem, type VelocityItem } from "@/lib/pack";
import { parseLas, type LasRead } from "@/lib/las";
import { BuildChip } from "@/components/panels/common";

export const CONF_CLS: Record<string, string> = { high: "bg-emerald-700 text-white", medium: "bg-amber-500 text-black", low: "bg-red-700 text-white", unreadable: "bg-zinc-700 text-white" };
const confCls = (c: string) => CONF_CLS[c.toLowerCase()] ?? "bg-muted text-foreground";
export function Zoomable({ src, alt, caption, className, action }: { src: string; alt: string; caption?: string; className?: string; action?: { label: string; onClick: () => void } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Enlarge: ${alt}`} className={cn("group relative block w-full overflow-hidden rounded-lg border bg-white focus-visible:outline-2 focus-visible:outline-ring", className)}>
        <img src={src} alt={alt} className="max-h-72 w-full object-contain" />
        <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-md bg-black/60 text-white"><Maximize2 className="size-4" aria-hidden="true" /></span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[94dvh] max-w-5xl overflow-y-auto"><DialogTitle>{alt}</DialogTitle>{caption && <DialogDescription>{caption}</DialogDescription>}<img src={src} alt={alt} className="w-full rounded border bg-white" />{action && <div><Button type="button" size="sm" variant="secondary" onClick={() => { setOpen(false); action.onClick(); }}>{action.label}</Button></div>}</DialogContent>
      </Dialog>
    </>
  );
}
function Failures({ items }: { items: { where: string; what: string; why: string }[] }) {
  if (!items.length) return null;
  return (
    <section aria-label="Where extraction failed" className="space-y-1">
      <h4 className="flex items-center gap-1 text-xs font-semibold"><AlertTriangle className="size-3.5 text-red-700" aria-hidden="true" /> Where it failed or needs a person · {items.length}</h4>
      <ul className="space-y-1 text-xs">{items.map((f, i) => <li key={i} className="rounded-md border-l-2 border-red-700 bg-muted/50 px-2 py-1"><span className="font-medium">{f.where}:</span> {f.what}<span className="text-muted-foreground"> · {f.why}</span></li>)}</ul>
    </section>
  );
}

/* ---------- Checkshot table and velocity chart (legacy scan) ---------- */
const FRIENDLY: Record<string, string> = { "checkshot-table": "Checkshot table (Enclosure 1)", "tz-diagram": "Time–depth chart (Enclosure 2)" };
export function VelocityView({ showBuild }: { showBuild: boolean }) {
  const v = PACK.velocity;
  if (!v) return <NotIncluded what="Marabooka 1 checkshot table and velocity chart" why="The pages were not read in time for this build." />;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Marabooka 1 · checkshot and velocity</h2>
        <p className="text-sm">Two scanned enclosures from the 1981 completion report: the checkshot table and the time–depth chart. We read the values from the page images before packaging, each with a confidence.</p>
        <p className="text-xs text-muted-foreground">{v.source.publisher} · {v.source.report} · {v.source.licence}</p>
      </header>
      {showBuild && <BuildChip cap="Document extraction" />}
      {v.items.map((it) => <VelocityBlock key={it.itemId} it={it} />)}
    </div>
  );
}
function VelocityBlock({ it }: { it: VelocityItem }) {
  const s = it.stats;
  return (
    <section aria-label={it.title} className="space-y-2 rounded-xl border p-3">
      <div className="flex items-start justify-between gap-2"><h3 className="text-sm font-semibold">{FRIENDLY[it.itemId] ?? it.title}</h3><Badge variant="outline" className="shrink-0">Readability {it.scan.readability}</Badge></div>
      <p className="text-xs text-muted-foreground">Printed title “{it.title}” · {it.file} · {it.scan.w}×{it.scan.h} px, {it.scan.bits}</p>
      {it.scan.note && <details className="text-xs"><summary className="cursor-pointer font-medium">How it was read</summary><p className="mt-1">{it.scan.note}</p></details>}
      {it.images.slice(0, 2).map((im) => <Zoomable key={im.file + (im.crop ?? "")} src={im.img} alt={`${it.title}: ${im.caption}`} caption={im.caption} />)}
      <dl className="grid grid-cols-4 gap-1.5 text-center text-xs">
        {([["Read", s.cellsOrValuesAttempted], ["High", s.readHigh], ["Medium", s.readMedium], ["Low or unreadable", s.readLow + s.unreadable]] as [string, number][]).map(([k, n]) => <div key={k} className="rounded-md border p-1.5"><dt className="text-muted-foreground">{k}</dt><dd className="text-sm font-semibold tabular-nums">{n}</dd></div>)}
      </dl>
      {it.headers && it.rows && (
        <div className="max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-xs">
            <caption className="sr-only">{it.title} as read{it.datum ? `; datum ${it.datum}` : ""}</caption>
            <thead className="sticky top-0 bg-muted"><tr>{it.headers.map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left font-semibold">{h}</th>)}<th scope="col" className="px-1.5 py-1 text-left font-semibold">Confidence</th></tr></thead>
            <tbody>{it.rows.map((r, i) => (
              <tr key={i} className={cn("border-t", r.needsReview && "bg-amber-50 dark:bg-amber-950/30")}>
                {r.cells.map((c, j) => <td key={j} className="px-1.5 py-0.5 tabular-nums">{c ?? <span className="text-muted-foreground">—</span>}</td>)}
                <td className="px-1.5 py-0.5"><span className={cn("rounded px-1 text-[10px] font-semibold", confCls(r.confidence))}>{r.confidence}</span>{r.note && <span className="ml-1 text-muted-foreground">{r.note}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {it.values && it.values.length > 0 && (
        <ul className="space-y-1 text-xs">{it.values.map((x) => (
          <li key={x.valueId} className="flex items-start justify-between gap-2 rounded-md border px-2 py-1">
            <span><span className="font-medium">{x.label}:</span> {x.value}{x.unit ? ` ${x.unit}` : ""}{x.note && <span className="text-muted-foreground"> · {x.note}</span>}</span>
            <span className={cn("shrink-0 rounded px-1 text-[10px] font-semibold", confCls(x.confidence))}>{x.confidence}</span>
          </li>
        ))}</ul>
      )}
      {it.curvePoints && it.curvePoints.length > 1 && <TzPlot pts={it.curvePoints} />}
      {it.crossChecks.length > 0 && (
        <section aria-label="Cross-checks" className="space-y-1">
          <h4 className="text-xs font-semibold">Cross-checks against other sources</h4>
          <ul className="space-y-1 text-xs">{it.crossChecks.map((c, i) => (
            <li key={i} className="flex items-start gap-1.5">
              {c.agrees === true ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-700" aria-label="Agrees" /> : c.agrees === false ? <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-700" aria-label="Disagrees" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-label="Not decided" />}
              <span><span className="font-medium">{c.check}:</span> {c.result}{c.formula && <span className="text-muted-foreground"> · {c.formula}</span>}</span>
            </li>
          ))}</ul>
        </section>
      )}
      <Failures items={it.failures} />
      <p className="text-xs text-muted-foreground">Reading time: {it.timing.elapsedSec ? `${fmt(it.timing.elapsedSec)} s` : "not measured"} · {it.timing.note}</p>
    </section>
  );
}
function TzPlot({ pts }: { pts: { depthFtMSL: number; twtSec: number; confidence: string }[] }) {
  const W = 300, H = 220, m = { l: 46, r: 10, t: 10, b: 30 };
  const xs = pts.map((p) => p.twtSec), ys = pts.map((p) => p.depthFtMSL);
  const x0 = 0, x1 = Math.max(...xs) * 1.05, y0 = 0, y1 = Math.max(...ys) * 1.05;
  const X = (t: number) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r), Y = (d: number) => m.t + ((d - y0) / (y1 - y0)) * (H - m.t - m.b);
  const sorted = [...pts].sort((a, b) => a.depthFtMSL - b.depthFtMSL);
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-sm" role="img" aria-label={`Time–depth points read from the chart: ${pts.length} points from ${fmt(Math.min(...ys))} to ${fmt(Math.max(...ys))} ft below sea level`}>
        <rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} fill="none" stroke="currentColor" strokeOpacity={0.25} />
        <polyline fill="none" className="stroke-brand" strokeWidth={1.5} points={sorted.map((p) => `${X(p.twtSec)},${Y(p.depthFtMSL)}`).join(" ")} />
        {pts.map((p, i) => <circle key={i} cx={X(p.twtSec)} cy={Y(p.depthFtMSL)} r={3} fill={p.confidence === "high" ? "#047857" : p.confidence === "medium" ? "#d97706" : "#b91c1c"} />)}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <text key={f} x={X(x0 + f * (x1 - x0))} y={H - 12} fontSize={9} textAnchor="middle" fill="currentColor">{(x0 + f * (x1 - x0)).toFixed(2)}</text>)}
        {[0, 0.5, 1].map((f) => <text key={f} x={m.l - 4} y={Y(y0 + f * (y1 - y0)) + 3} fontSize={9} textAnchor="end" fill="currentColor">{fmt(Math.round(y0 + f * (y1 - y0)))}</text>)}
        <text x={(W + m.l) / 2} y={H - 1} fontSize={9} textAnchor="middle" fill="currentColor">Two-way time (s)</text>
      </svg>
      <figcaption className="text-xs text-muted-foreground">Points as read from the scanned chart (depth in ft below sea level). Colour shows read confidence.</figcaption>
    </figure>
  );
}

/* ---------- Report pages with a seismic image and legend ---------- */
export function FigureView({ showBuild }: { showBuild: boolean }) {
  const figs = PACK.figures;
  if (!figs.length) return <NotIncluded what="Report page with a seismic image and legend" why="No page was prepared for this build." />;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Seismic line 80-KBK in a scanned report</h2>
        <p className="text-sm">Three pages from the 1981 Marabooka 1 report: a seismic time section, the survey diagram with its legend, and the location map. What we could read, how sure we are, and where an automatic reader goes wrong.</p>
      </header>
      {showBuild && <BuildChip cap="Document extraction" />}
      {figs.map((f) => <FigureBlock key={`${f.doc}-${f.page}`} f={f} />)}
    </div>
  );
}
function FigureBlock({ f }: { f: FigureItem }) {
  return (
    <section aria-label={f.title} className="space-y-2 rounded-xl border p-3">
      <h3 className="text-sm font-semibold">{f.title}</h3>
      <Zoomable src={f.img} alt={`${f.title} (${f.doc}, page ${f.page})`} caption={f.caption} />
      <p className="text-xs text-muted-foreground">{f.doc} · p. {f.page} · {f.caption}</p>
      {f.extraImages?.map((x) => <figure key={x.caption} className="space-y-1"><Zoomable src={x.img} alt={`Computed marker on ${f.title}`} caption={x.caption} /><figcaption className="text-xs"><span className="rounded bg-violet-700 px-1 text-[10px] font-semibold text-white">Computed</span> {x.caption}</figcaption></figure>)}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <caption className="sr-only">Values read from {f.title}</caption>
          <thead className="bg-muted/60"><tr><th scope="col" className="px-1.5 py-1 text-left">Read</th><th scope="col" className="px-1.5 py-1 text-left">Value</th><th scope="col" className="px-1.5 py-1 text-left">Confidence</th></tr></thead>
          <tbody>{f.extracted.map((x, i) => <tr key={i} className="border-t align-top"><td className="px-1.5 py-1 font-medium">{x.label}</td><td className="px-1.5 py-1">{x.value}{x.note && <span className="block text-muted-foreground">{x.note}</span>}</td><td className="px-1.5 py-1"><span className={cn("rounded px-1 text-[10px] font-semibold", confCls(x.confidence))}>{x.confidence}</span></td></tr>)}</tbody>
        </table>
      </div>
      {f.legend.length > 0 && (
        <section aria-label="Legend as read" className="space-y-1">
          <h4 className="text-xs font-semibold">Legend and key, as read</h4>
          <ul className="flex flex-wrap gap-1.5 text-xs">{f.legend.map((l) => <li key={l.label} className="rounded-md border px-1.5 py-0.5">{l.label} <span className={cn("ml-1 rounded px-1 text-[10px] font-semibold", confCls(l.confidence))}>{l.confidence}</span></li>)}</ul>
        </section>
      )}
      <Failures items={f.failures} />
      {f.timing && <p className="text-xs text-muted-foreground">{f.timing.elapsedSec ? `Measured: ${fmt(f.timing.elapsedSec, 1)} s` : "Time: not measured"} · {f.timing.note}</p>}
    </section>
  );
}

/* ---------- LAS reader: bring your own file ---------- */
export function LasReader({ showBuild }: { showBuild: boolean }) {
  const [res, setRes] = useState<LasRead | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  const read = (file: File) => {
    setErr(null);
    if (file.size > 60 * 1024 * 1024) { setErr("That file is over 60 MB. Try a smaller LAS file."); return; }
    const r = new FileReader();
    r.onerror = () => setErr("The browser could not read that file.");
    r.onload = () => { try { setRes(parseLas(String(r.result ?? ""), file.name, file.size)); } catch { setErr("That file could not be read as LAS text."); } };
    r.readAsText(file);
  };
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">LAS log reader</h2>
        <p className="text-sm">No LAS file is bundled in this build. Open any LAS 1.2 or 2.0 file to see what is extracted, how complete the header is, and where the file has problems.</p>
        <p className="text-xs text-muted-foreground">The file is read inside this browser. Nothing is uploaded or saved.</p>
      </header>
      {showBuild && <BuildChip cap="Structured data quality" />}
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) read(f); }}
        className={cn("grid place-items-center gap-2 rounded-xl border-2 border-dashed p-5 text-center text-sm", drag && "border-primary bg-primary/5")}>
        <FileUp className="size-6 text-muted-foreground" aria-hidden="true" />
        <p>Drop a .las file here, or</p>
        <Button type="button" size="sm" variant="secondary" onClick={() => inp.current?.click()}>Choose a LAS file</Button>
        <Input ref={inp} type="file" accept=".las,.LAS,.txt" className="sr-only" aria-label="Choose a LAS file" onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = ""; }} />
      </div>
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      {res && <LasResult r={res} />}
    </div>
  );
}
function LasResult({ r }: { r: LasRead }) {
  const show = r.curves.slice(1).filter((c) => c.pts.length > 1).slice(0, 4);
  const wellRows = ["WELL", "COMP", "FLD", "LOC", "UWI", "SRVC", "DATE", "CTRY", "STAT", "PROV"].filter((k) => r.well[k]).map((k) => [k, r.well[k]]);
  return (
    <section aria-label={`Results for ${r.file}`} className="space-y-3">
      <div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-all text-sm font-semibold">{r.file}</h3><Badge className={confCls(r.confidence)}>{r.confidence} confidence</Badge></div>
      <p className="text-xs">{r.confidenceWhy}. LAS {r.version}{r.wrap === "YES" ? " (wrapped)" : ""} · {fmt(r.rows)} rows · {r.curves.length} curves · depth {r.start ?? "?"} to {r.stop ?? "?"} {r.depthUnit}, step {r.step ?? "?"} · NULL {r.nullValue ?? "not declared"} · read in {fmt(r.parseMs)} ms</p>
      {wellRows.length > 0 && <dl className="grid grid-cols-[4rem_1fr] gap-x-2 gap-y-0.5 text-xs">{wellRows.map(([k, v]) => <div key={k} className="contents"><dt className="font-medium">{k}</dt><dd className="break-words">{v}</dd></div>)}</dl>}
      {show.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{show.map((c) => <Track key={c.mnem} c={c} unit={r.depthUnit} />)}</div>
      )}
      <div className="max-h-56 overflow-auto rounded-lg border">
        <table className="w-full text-xs"><caption className="sr-only">Curves</caption>
          <thead className="sticky top-0 bg-muted"><tr>{["Curve", "Unit", "Description", "Min", "Max", "NULL %"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
          <tbody>{r.curves.map((c) => <tr key={c.mnem} className="border-t"><td className="px-1.5 py-0.5 font-medium">{c.mnem}</td><td className="px-1.5 py-0.5">{c.unit || <span className="text-red-700">none</span>}</td><td className="px-1.5 py-0.5">{c.descr}</td><td className="px-1.5 py-0.5 tabular-nums">{c.min == null ? "—" : fmt(c.min, 2)}</td><td className="px-1.5 py-0.5 tabular-nums">{c.max == null ? "—" : fmt(c.max, 2)}</td><td className="px-1.5 py-0.5 tabular-nums">{c.samples ? Math.round((100 * c.nulls) / c.samples) : 0}</td></tr>)}</tbody>
        </table>
      </div>
      <section aria-label="Problems found" className="space-y-1">
        <h4 className="text-xs font-semibold">Problems found · {r.issues.length}</h4>
        <ul className="space-y-1 text-xs">{r.issues.map((x, i) => <li key={i} className={cn("rounded-md border-l-2 bg-muted/50 px-2 py-1", x.severity === "failure" ? "border-red-700" : x.severity === "warning" ? "border-amber-500" : "border-sky-700")}><span className="font-medium">{x.where}:</span> {x.what} <span className="text-muted-foreground">({x.severity})</span></li>)}</ul>
      </section>
    </section>
  );
}
function Track({ c, unit }: { c: LasRead["curves"][number]; unit: string }) {
  const W = 120, H = 260; const ds = c.pts.map((p) => p[0]), vs = c.pts.map((p) => p[1]);
  const d0 = Math.min(...ds), d1 = Math.max(...ds), v0 = c.min ?? Math.min(...vs), v1 = c.max ?? Math.max(...vs);
  const X = (v: number) => 4 + ((v - v0) / (v1 - v0 || 1)) * (W - 8), Y = (d: number) => 4 + ((d - d0) / (d1 - d0 || 1)) * (H - 8);
  return (
    <figure className="rounded-lg border p-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full" role="img" aria-label={`${c.mnem} from ${fmt(d0)} to ${fmt(d1)} ${unit}: range ${fmt(v0, 2)} to ${fmt(v1, 2)} ${c.unit}`}>
        <polyline fill="none" className="stroke-brand" strokeWidth={1} points={c.pts.map((p) => `${X(p[1])},${Y(p[0])}`).join(" ")} />
      </svg>
      <figcaption className="text-center text-[11px]"><span className="font-semibold">{c.mnem}</span> {c.unit && `(${c.unit})`}</figcaption>
    </figure>
  );
}

export function NotIncluded({ what, why }: { what: string; why: string }) {
  return <div className="space-y-1 rounded-xl border border-dashed p-4 text-sm"><Badge className="bg-muted text-foreground">Not included</Badge><p className="font-medium">{what}</p><p className="text-muted-foreground">{why}</p></div>;
}
