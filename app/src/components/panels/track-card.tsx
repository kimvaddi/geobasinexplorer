import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Link2, Play, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EXERCISES, type Action } from "@/lib/track";

export interface TrackState { active: boolean; n: number; done: number[]; startedAt: number | null }
export const TRACK_INIT: TrackState = { active: false, n: 1, done: [], startedAt: null };
const total = EXERCISES.reduce((s, e) => s + e.minutes, 0);

export function TrackCard({ st, setSt, run, onClose, maxHeight }: { st: TrackState; setSt: (s: TrackState) => void; run: (a: Action[]) => void; onClose: () => void; maxHeight?: number }) {
  const ex = EXERCISES.find((e) => e.n === st.n) ?? EXERCISES[0];
  const [min, setMin] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(t); }, []);
  const mins = st.startedAt ? Math.max(0, Math.round((now - st.startedAt) / 60000)) : 0;
  const isDone = st.done.includes(ex.n);
  const go = (n: number) => setSt({ ...st, n: Math.min(EXERCISES.length, Math.max(1, n)) });
  const link = () => { const u = `${location.href.split("#")[0]}#ex=${ex.n}`; void navigator.clipboard?.writeText(u).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }, () => setCopied(false)); };
  return (
    <section aria-labelledby="track-h" className="pointer-events-auto flex w-[min(400px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-2xl" style={maxHeight ? { maxHeight } : undefined}>
      <div className="flex shrink-0 items-center gap-2 bg-brand px-3 py-2 text-white">
        <Play className="size-4 text-brand-highlight" aria-hidden="true" />
        <h2 id="track-h" className="flex-1 text-sm font-semibold">Guided tour: step {ex.n} of {EXERCISES.length}</h2>
        <span className="text-xs tabular-nums text-white/80" title="Minutes since you started">{mins} of ~{total} min</span>
        <button type="button" className="grid size-7 place-items-center rounded hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white" aria-label={min ? "Expand exercise" : "Collapse exercise"} aria-expanded={!min} onClick={() => setMin(!min)}>{min ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}</button>
        <button type="button" className="grid size-7 place-items-center rounded hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white" aria-label="Close the tour" onClick={onClose}><X className="size-4" aria-hidden="true" /></button>
      </div>
      <ol className="flex shrink-0 gap-1 px-3 pt-2" aria-label="Exercises">
        {EXERCISES.map((e) => (
          <li key={e.n} className="flex-1"><button type="button" onClick={() => go(e.n)} aria-current={e.n === ex.n ? "step" : undefined} aria-label={`Exercise ${e.n}: ${e.title}${st.done.includes(e.n) ? " (done)" : ""}`}
            className={cn("h-1.5 w-full rounded-full focus-visible:outline-2 focus-visible:outline-ring", st.done.includes(e.n) ? "bg-emerald-600" : e.n === ex.n ? "bg-brand" : "bg-muted")} /></li>
        ))}
      </ol>
      {!min && (
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3 text-sm">
          <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{ex.title}</h3><Badge variant="outline" className="shrink-0">{ex.level} · {ex.minutes} min</Badge></div>
          <p>{ex.goal}</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">{ex.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Try this</p>
            {ex.tryThis.map((t) => <Button key={t.label} type="button" size="sm" variant="secondary" className="h-auto w-full justify-start whitespace-normal py-1.5 text-left" onClick={() => run(t.actions)}><ArrowRight aria-hidden="true" /> {t.label}</Button>)}
          </div>
          <p className="rounded-md bg-muted/60 p-2 text-xs"><span className="font-semibold">Done when:</span> {ex.done}</p>
          {ex.n === EXERCISES.length && st.done.length >= EXERCISES.length - 1 && <p role="status" className="rounded-md border border-emerald-600 p-2 text-xs">That's the full track. Your scorecard export is the record of this session.</p>}
        </div>
      )}
      {!min && (
        <div className="shrink-0 space-y-1.5 border-t p-3 pt-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" size="sm" variant={isDone ? "secondary" : "outline"} aria-pressed={isDone} onClick={() => setSt({ ...st, done: isDone ? st.done.filter((x) => x !== ex.n) : [...st.done, ex.n] })}><Check aria-hidden="true" /> {isDone ? "Done" : "Mark done"}</Button>
            <div className="flex gap-1.5">
              <Button type="button" size="sm" variant="outline" disabled={ex.n === 1} onClick={() => go(ex.n - 1)}><ArrowLeft aria-hidden="true" /> Back</Button>
              <Button type="button" size="sm" disabled={ex.n === EXERCISES.length} onClick={() => { if (!isDone) setSt({ ...st, n: ex.n + 1, done: [...st.done, ex.n] }); else go(ex.n + 1); }}>Next <ArrowRight aria-hidden="true" /></Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <Button type="button" size="xs" variant="ghost" onClick={link}><Link2 aria-hidden="true" /> {copied ? "Link copied" : "Copy link to this step"}</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setSt({ active: true, n: 1, done: [], startedAt: Date.now() })}><RotateCcw aria-hidden="true" /> Reset the tour</Button>
          </div>
        </div>
      )}
    </section>
  );
}
