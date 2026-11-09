import { useMemo, useState } from "react";
import { Check, ChevronDown, FileText, FlaskConical, GitBranch, Images, MapPin, MessageSquare, ScanSearch, Shapes, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PACK, STATUS_CLS, type Entity } from "@/lib/pack";
import { neighbors, passagesFor, whereOf, TYPE_COLOR, TYPE_LABEL, type KG, type KNode } from "@/lib/kg";
import type { ReviewState } from "@/lib/score";
import { Zoomable } from "@/components/panels/evidence-items";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

/* The card behind every click in the Knowledge, Images and Co-Scientist views: what the item is,
   what it links to, its core images, where it is (XY and polygon) and where it came from. */
export interface ShowPlace { kind: "point" | "polygon"; lon: number; lat: number; label: string; basin: string | null }
export function reviewEntityFor(n: KNode): Entity | null {
  const l = n.label.toLowerCase();
  if (n.type === "unit") return PACK.entities.find((e) => e.type === "formation" && e.label.toLowerCase() === l) ?? null;
  if (n.type === "borehole") return PACK.entities.find((e) => e.type === "well" && e.label.toLowerCase() === l.replace(/^gsq /, "")) ?? null;
  if (n.type === "play" || n.type === "basin") return PACK.entities.find((e) => e.id === n.id) ?? null;
  return null;
}
export function EntityCard(p: {
  g: KG; id: string; onSelect: (id: string) => void; onShow: (s: ShowPlace) => void; onAsk: (q: string) => void; onLineage: (id: string) => void;
  onTest: (hyp: string) => void; onSimilar?: (id: string) => void; onClose: () => void; review: ReviewState; onReview?: (e: Entity, d: "accepted" | "rejected") => void; className?: string;
}) {
  const n = p.g.nodes.get(p.id);
  const [allSrc, setAllSrc] = useState(false);
  const nb = useMemo(() => (n ? neighbors(p.g, n.id) : []), [n, p.g]);
  const where = useMemo(() => (n ? whereOf(p.g, n) : null), [n, p.g]);
  const passages = useMemo(() => (n ? passagesFor(n) : []), [n]);
  if (GATED && LICENCE.isWithheldGraphNode(n ?? p.id)) return null;
  if (!n || !where) return null;
  const groups = new Map<string, KNode[]>();
  for (const x of nb) { if (x.node.type === "core") continue; const l = groups.get(x.label) ?? []; if (!l.some((y) => y.id === x.node.id)) l.push(x.node); groups.set(x.label, l); }
  const cores = nb.filter((x) => x.node.type === "core" && x.node.img && x.node.id !== n.id).map((x) => x.node).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  // units and plays: core images of the units in the play too
  if (n.type === "play" && cores.length < 6) for (const x of nb) if (x.node.type === "unit") for (const y of neighbors(p.g, x.node.id)) if (y.node.type === "core" && y.node.img && !cores.some((c) => c.id === y.node.id)) cores.push(y.node);
  const tests = nb.filter((x) => x.node.type === "hypothesis").map((x) => x.node.id.replace(/^hyp:/, ""));
  const ent = reviewEntityFor(n); const rv = ent ? p.review[ent.id] : undefined;
  const shown = allSrc ? passages : passages.slice(0, 3);
  const q = n.type === "borehole" ? `Tell me about ${n.label}` : n.type === "play" ? `Which plays are analogs to the ${n.label.replace(/ Play$/, "")} Play?` : `Tell me about the ${n.label}`;
  return (
    <article aria-label={`${TYPE_LABEL[n.type]}: ${n.label}`} className={cn("flex max-h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl", p.className)}>
      <header className="flex items-start gap-2 border-b px-3 py-2.5">
        <span className="mt-1 size-3 shrink-0 rounded-full border border-black/20" style={{ background: TYPE_COLOR[n.type] }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{TYPE_LABEL[n.type]}<Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS[n.type === "hypothesis" ? "Computed" : "Real"])}>{n.type === "hypothesis" ? "Computed" : "Real"}</Badge>{n.lowc && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">Low-carbon lens</Badge>}</div>
          <h3 className="text-base font-semibold leading-tight">{n.label}</h3>
          {n.sub && <p className="text-xs text-muted-foreground">{n.sub}</p>}
        </div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={p.onClose}><X aria-hidden="true" /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5 text-sm">
        {n.img && <div className="space-y-1"><Zoomable src={n.img} alt={n.label} caption={n.source.title} />
          {p.onSimilar && <Button type="button" size="xs" variant="secondary" onClick={() => p.onSimilar!(n.id)}><ScanSearch aria-hidden="true" /> Find core that looks like this</Button>}</div>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {n.props.filter(([, v]) => v && v !== "not recorded").map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {groups.size > 0 && <section aria-label="Relationships" className="space-y-1.5">
          <h4 className="flex items-center gap-1 text-xs font-semibold"><GitBranch className="size-3.5" aria-hidden="true" /> Relationships <span className="font-normal text-muted-foreground">· links come from table columns</span></h4>
          {[...groups.entries()].map(([label, list]) => (
            <div key={label} className="grid grid-cols-[7.5rem_1fr] items-start gap-2 text-xs">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{label}</span>
              <div className="flex flex-wrap gap-1">{list.slice(0, 10).map((x) => (
                <button key={x.id} type="button" onClick={() => p.onSelect(x.id)} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="size-2 rounded-full border border-black/20" style={{ background: TYPE_COLOR[x.type] }} aria-hidden="true" /><span className="text-[10px] uppercase text-muted-foreground">{TYPE_LABEL[x.type]}</span> {x.short ?? x.label}
                </button>))}{list.length > 10 && <span className="px-1 text-muted-foreground">+{list.length - 10} more</span>}</div>
            </div>))}
        </section>}
        {cores.length > 0 && <section aria-label="Core images" className="space-y-1">
          <h4 className="flex items-center gap-1 text-xs font-semibold"><Images className="size-3.5" aria-hidden="true" /> Core images · {cores.length}</h4>
          <ul className="flex gap-1.5 overflow-x-auto pb-1">{cores.slice(0, 8).map((c) => (
            <li key={c.id} className="w-24 shrink-0"><button type="button" onClick={() => p.onSelect(c.id)} className="block w-full rounded-md border bg-white p-0.5 focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open ${c.label}`}>
              <img src={c.img} alt="" className="h-20 w-full object-contain" /></button><p className="mt-0.5 line-clamp-2 text-[11px] leading-tight">{c.label}</p></li>))}</ul>
        </section>}
        <section aria-label="Where it is" className="space-y-1">
          <h4 className="flex items-center gap-1 text-xs font-semibold"><MapPin className="size-3.5" aria-hidden="true" /> Where it is · GDA94</h4>
          {!where.points.length && !where.polygon && <p className="text-xs text-muted-foreground">No position in this file.</p>}
          <ul className="space-y-1 text-xs">
            {where.points.map((pt) => <li key={pt.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
              <span><span className="font-medium">XY</span> {pt.label}: {Math.abs(pt.lat).toFixed(4)}°S {pt.lon.toFixed(4)}°E<span className="block text-muted-foreground">{pt.how}</span></span>
              <Button type="button" size="xs" variant="ghost" onClick={() => p.onShow({ kind: "point", lon: pt.lon, lat: pt.lat, label: pt.label, basin: null })}>Show</Button></li>)}
            {where.polygon && <li className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
              <span><span className="font-medium">Polygon</span> {where.polygon.label}<span className="block text-muted-foreground">{where.polygon.how}</span></span>
              <Button type="button" size="xs" variant="ghost" onClick={() => { const b = where.polygon!; const nd = p.g.nodes.get(`basin:${b.basin}`); if (nd?.lonlat) p.onShow({ kind: "polygon", lon: nd.lonlat[0], lat: nd.lonlat[1], label: b.label, basin: b.basin }); }}>Show</Button></li>}
          </ul>
        </section>
        <section aria-label="Sources" className="space-y-1">
          <h4 className="flex items-center gap-1 text-xs font-semibold"><FileText className="size-3.5" aria-hidden="true" /> Passages that name it · {passages.length}{passages.length >= 30 ? "+" : ""}</h4>
          {!passages.length && <p className="text-xs text-muted-foreground">No passage in the bundled documents names it. The table record is the source.</p>}
          <ul className="space-y-1 text-xs">{shown.map((s) => <li key={s.id} className="rounded-md bg-muted/50 px-2 py-1"><span className="font-medium">{s.doc}{s.page ? ` · p. ${s.page}` : ""}</span> <span className="text-muted-foreground">{s.heading}</span><p className="line-clamp-3">{s.text}</p></li>)}</ul>
          {passages.length > 3 && <Button type="button" size="xs" variant="ghost" onClick={() => setAllSrc((v) => !v)}><ChevronDown className={cn("transition-transform", allSrc && "rotate-180")} aria-hidden="true" />{allSrc ? "Show fewer" : `Show all ${passages.length}`}</Button>}
        </section>
        {ent && p.onReview && <section aria-label="Expert review" className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-2 text-xs">
          <span className="font-semibold">Expert review:</span>{rv ? <Badge variant="outline">{rv.status} by {rv.by || "unnamed reviewer"}</Badge> : <span className="text-muted-foreground">not reviewed</span>}
          <Button type="button" size="xs" variant="outline" onClick={() => p.onReview!(ent, "accepted")}><Check aria-hidden="true" /> Accept</Button>
          <Button type="button" size="xs" variant="outline" onClick={() => p.onReview!(ent, "rejected")}><X aria-hidden="true" /> Reject</Button>
        </section>}
      </div>
      <footer className="flex flex-wrap gap-1.5 border-t px-3 py-2">
        <Button type="button" size="xs" onClick={() => p.onLineage(n.id)} className="bg-brand text-white hover:bg-brand-hover"><Shapes aria-hidden="true" /> Where did this come from?</Button>
        {n.type !== "hypothesis" && n.type !== "core" && (!GATED || !LICENCE.isWithheldWell(n.label)) && <Button type="button" size="xs" variant="secondary" onClick={() => p.onAsk(q)}><MessageSquare aria-hidden="true" /> Ask about this</Button>}
        {tests.map((t) => <Button key={t} type="button" size="xs" variant="secondary" onClick={() => p.onTest(t)}><FlaskConical aria-hidden="true" /> Test with the Co-Scientist</Button>)}
        {n.type === "hypothesis" && <Button type="button" size="xs" variant="secondary" onClick={() => p.onTest(n.id.replace(/^hyp:/, ""))}><FlaskConical aria-hidden="true" /> Run it</Button>}
      </footer>
    </article>
  );
}
