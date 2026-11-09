import { useMemo, useState } from "react";
import { Check, MapPin, PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PACK, type Entity } from "@/lib/pack";
import { BASINS } from "@/lib/basins";
import type { LogEntry, ReviewState } from "@/lib/score";
import { BuildChip } from "@/components/panels/common";

const TYPES: Entity["type"][] = ["basin", "play", "formation", "age", "well", "interval"];
const T_LABEL: Record<Entity["type"], string> = { basin: "Basin", play: "Play", formation: "Formation", age: "Age", well: "Well", interval: "Interval" };
const S_CLS = { accepted: "bg-emerald-700 text-white", rejected: "bg-red-700 text-white", edited: "bg-sky-700 text-white" } as const;
const C_CLS: Record<string, string> = { high: "border-emerald-700 text-emerald-800 dark:text-emerald-300", medium: "border-amber-600 text-amber-800 dark:text-amber-300", low: "border-red-700 text-red-800 dark:text-red-300" };
export interface ReviewFilter { type: Entity["type"] | "all"; basin: string; status: "all" | "open" | "accepted" | "rejected" | "edited"; q: string }
export const DEFAULT_FILTER: ReviewFilter = { type: "all", basin: "all", status: "all", q: "" };

export function ReviewPanel(p: { reviewer: string; setReviewer: (s: string) => void; review: ReviewState; log: LogEntry[]; filter: ReviewFilter; setFilter: (f: ReviewFilter) => void; onDecide: (e: Entity, status: "accepted" | "rejected" | "edited", label?: string) => void; onShow: (e: Entity) => void; showBuild: boolean }) {
  const [limit, setLimit] = useState(40);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const f = p.filter;
  const list = useMemo(() => PACK.entities.filter((e) => (f.type === "all" || e.type === f.type) && (f.basin === "all" || e.basin === f.basin)
    && (f.status === "all" || (f.status === "open" ? !p.review[e.id] : p.review[e.id]?.status === f.status))
    && (!f.q || `${e.label} ${Object.values(e.attrs).join(" ")}`.toLowerCase().includes(f.q.toLowerCase()))), [f, p.review]);
  const counts = useMemo(() => { const c = { accepted: 0, rejected: 0, edited: 0 }; Object.values(p.review).forEach((r) => { c[r.status]++; }); return c; }, [p.review]);
  const done = counts.accepted + counts.rejected + counts.edited;
  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Review the knowledge graph</h2>
        <p className="text-sm">Basins, plays, formations, ages, wells and intervals pulled from the public data. Accept, reject or edit each one. Every decision goes in the change log.</p>
      </header>
      {p.showBuild && <BuildChip cap="Expert review" />}
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1"><label htmlFor="rev-name" className="text-xs font-medium">Your name (shown in the change log)</label><Input id="rev-name" value={p.reviewer} onChange={(e) => p.setReviewer(e.target.value)} maxLength={60} placeholder="e.g. A. Geologist" className="h-8 text-sm" /></div>
        <p className="pb-1 text-xs tabular-nums">{done} of {PACK.entities.length} reviewed</p>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Entity type">
        {(["all", ...TYPES] as const).map((t) => <Button key={t} type="button" size="xs" variant={f.type === t ? "secondary" : "ghost"} aria-pressed={f.type === t} onClick={() => { p.setFilter({ ...f, type: t }); setLimit(40); }}>{t === "all" ? "All" : T_LABEL[t]} · {t === "all" ? PACK.entities.length : PACK.entities.filter((e) => e.type === t).length}</Button>)}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <select aria-label="Basin" value={f.basin} onChange={(e) => p.setFilter({ ...f, basin: e.target.value })} className="h-8 rounded-md border bg-background px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring"><option value="all">All basins</option>{BASINS.map((b) => <option key={b.id} value={b.id}>{b.short}</option>)}</select>
        <select aria-label="Review status" value={f.status} onChange={(e) => p.setFilter({ ...f, status: e.target.value as ReviewFilter["status"] })} className="h-8 rounded-md border bg-background px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring"><option value="all">Any status</option><option value="open">Not reviewed</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="edited">Edited</option></select>
        <Input aria-label="Filter by text" value={f.q} onChange={(e) => p.setFilter({ ...f, q: e.target.value })} placeholder="Filter…" className="h-8 text-xs" />
      </div>
      <ul className="space-y-2">
        {list.slice(0, limit).map((e) => {
          const r = p.review[e.id];
          return (
            <li key={e.id} className="rounded-lg border p-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0"><span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{T_LABEL[e.type]}</span><span className={cn("font-medium", r?.status === "rejected" && "line-through")}>{r?.status === "edited" && r.label ? r.label : e.label}</span>{r?.status === "edited" && <span className="block text-xs text-muted-foreground">was “{e.label}”</span>}</p>
                {r ? <Badge className={S_CLS[r.status]}>{r.status}</Badge> : <Badge variant="outline" className={C_CLS[e.confidence] ?? ""}>{e.confidence} confidence</Badge>}
              </div>
              <p className="mt-0.5 text-xs">{Object.entries(e.attrs).filter(([, v]) => v != null && v !== "").slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
              <p className="text-xs text-muted-foreground">{e.method} · {e.source}{e.crs ? ` · ${e.crs}` : ""}</p>
              {editing === e.id ? (
                <form className="mt-1.5 flex gap-1.5" onSubmit={(ev) => { ev.preventDefault(); if (draft.trim()) { p.onDecide(e, "edited", draft.trim()); setEditing(null); } }}>
                  <label htmlFor={`ed-${e.id}`} className="sr-only">New label for {e.label}</label>
                  <Input id={`ed-${e.id}`} value={draft} onChange={(ev) => setDraft(ev.target.value)} className="h-7 text-xs" maxLength={120} autoFocus />
                  <Button type="submit" size="xs" disabled={!draft.trim()}>Save</Button><Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              ) : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button type="button" size="xs" variant={r?.status === "accepted" ? "secondary" : "outline"} aria-pressed={r?.status === "accepted"} onClick={() => p.onDecide(e, "accepted")}><Check aria-hidden="true" /> Accept</Button>
                  <Button type="button" size="xs" variant={r?.status === "rejected" ? "secondary" : "outline"} aria-pressed={r?.status === "rejected"} onClick={() => p.onDecide(e, "rejected")}><X aria-hidden="true" /> Reject</Button>
                  <Button type="button" size="xs" variant="outline" onClick={() => { setEditing(e.id); setDraft(r?.label ?? e.label); }}><PencilLine aria-hidden="true" /> Edit</Button>
                  {e.lonlat && <Button type="button" size="xs" variant="ghost" onClick={() => p.onShow(e)}><MapPin aria-hidden="true" /> Map</Button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {list.length > limit && <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setLimit((l) => l + 40)}>Show more ({list.length - limit} left)</Button>}
      {!list.length && <p className="rounded-lg border border-dashed p-3 text-sm">No entities match these filters.</p>}
      <section aria-labelledby="log-h" className="space-y-1.5 border-t pt-3">
        <h3 id="log-h" className="text-sm font-semibold">Change log · {p.log.length}</h3>
        {p.log.length ? (
          <ol className="max-h-64 space-y-1 overflow-y-auto text-xs">{p.log.slice(0, 100).map((l, i) => <li key={i} className="rounded-md bg-muted/50 px-2 py-1"><span className="tabular-nums text-muted-foreground">{l.at}</span> · <span className="font-medium">{l.by || "Unnamed reviewer"}</span> · {l.action} <span className="font-medium">{l.before}</span>{l.after && l.after !== l.before ? <> → <span className="font-medium">{l.after}</span></> : null}</li>)}</ol>
        ) : <p className="text-xs text-muted-foreground">No decisions yet. They also export with the scorecard.</p>}
      </section>
    </div>
  );
}
