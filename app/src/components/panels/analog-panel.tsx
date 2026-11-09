import { useMemo, useState } from "react";
import { BookmarkPlus, ChevronDown, FileText, MapPin, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { PACK, type Play5 } from "@/lib/pack";
import { CRITERIA, DEFAULT_WEIGHTS, rank, rationale, playById, type Weights, type Ranked } from "@/lib/analog";
import { BuildChip, passageById } from "@/components/panels/common";

const PROVINCES = [...new Set(PACK.plays.map((p) => p.province))];
const ageLabel = (p: Play5) => p.interval || (p.top != null && p.base != null ? `${p.top}–${p.base} Ma` : "age not recorded");

export function AnalogPanel(p: { refId: string; setRefId: (id: string) => void; weights: Weights; setWeights: (w: Weights) => void; onShowPlay: (p: Play5) => void; onSave: (ref: Play5, r: Ranked, lines: string[]) => void; showBuild: boolean; savedKeys: Set<string> }) {
  const ref = playById(p.refId) ?? PACK.plays[0];
  const [same, setSame] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const ranked = useMemo(() => rank(ref, p.weights, same).slice(0, 8), [ref, p.weights, same]);
  const total = Object.values(p.weights).reduce((s, x) => s + x, 0);
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Find analogs</h2>
        <p className="text-sm">Pick a play, set what matters, and see why each analog ranks where it does. All attributes come from Geoscience Australia's play-interval tables.</p>
      </header>
      {p.showBuild && <BuildChip cap="Analog ranking" />}
      <div className="space-y-1">
        <label htmlFor="ref-play" className="text-sm font-semibold">Reference play</label>
        <select id="ref-play" value={ref.id} onChange={(e) => { p.setRefId(e.target.value); setOpen(null); }} className="h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">
          {PROVINCES.map((pr) => <optgroup key={pr} label={pr}>{PACK.plays.filter((x) => x.province === pr).map((x) => <option key={x.id} value={x.id}>{x.play}</option>)}</optgroup>)}
        </select>
        <PlayFacts play={ref} />
      </div>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-semibold hover:underline">What matters (weights) <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" /></CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3">
          {CRITERIA.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs"><Label htmlFor={`w-${c.id}`} className="text-xs font-medium">{c.label}</Label><span className="tabular-nums">{total ? Math.round((100 * p.weights[c.id]) / total) : 0}%</span></div>
              <Slider id={`w-${c.id}`} aria-label={`${c.label} weight`} min={0} max={60} step={5} value={[p.weights[c.id]]} onValueChange={(v) => p.setWeights({ ...p.weights, [c.id]: v[0] })} />
              <p className="text-xs text-muted-foreground">{c.hint}</p>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><Switch id="same-prov" checked={same} onCheckedChange={setSame} /><Label htmlFor="same-prov" className="text-xs">Include plays from the same basin</Label></div>
            <Button type="button" size="xs" variant="ghost" onClick={() => p.setWeights(DEFAULT_WEIGHTS)}><RotateCcw aria-hidden="true" /> Reset weights</Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <section aria-labelledby="rank-h" className="space-y-2">
        <div className="flex items-baseline justify-between gap-2"><h3 id="rank-h" className="text-sm font-semibold">Ranked analogs</h3><Badge className="bg-violet-700 text-white">Precomputed</Badge></div>
        <ol className="space-y-2">
          {ranked.map((r, i) => {
            const key = `${ref.id}>${r.play.id}`; const isOpen = open === r.play.id; const lines = rationale(ref, r);
            return (
              <li key={r.play.id} className={cn("rounded-lg border p-2.5 text-sm", isOpen && "ring-2 ring-ring")}>
                <button type="button" className="flex w-full items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.play.id)}>
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{r.play.play} <span className="font-normal text-muted-foreground">· {r.play.province}</span></span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full bg-brand" style={{ width: `${r.score}%` }} /></span>
                      <span className="w-24 shrink-0 text-right text-xs tabular-nums">score {r.score} · {r.coverage}%</span>
                    </span>
                  </span>
                </button>
                {isOpen && (
                  <div className="mt-2 space-y-2 border-t pt-2 text-xs">
                    <ul className="list-disc space-y-0.5 pl-4">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
                    <p className="text-muted-foreground">Coverage {r.coverage}%: how much of the weighting had data for both plays. An attribute recorded for only one play counts as no match.</p>
                    <PlayFacts play={r.play} compact />
                    <Evidence play={r.play} />
                    <div className="flex flex-wrap gap-1.5">
                      <Button type="button" size="xs" variant="secondary" onClick={() => p.onShowPlay(r.play)}><MapPin aria-hidden="true" /> Show basin</Button>
                      <Button type="button" size="xs" variant="outline" disabled={p.savedKeys.has(key)} onClick={() => p.onSave(ref, r, lines)}><BookmarkPlus aria-hidden="true" /> {p.savedKeys.has(key) ? "Saved to notes" : "Save rationale"}</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-muted-foreground">Use this to shortlist analogs. It compares recorded attributes only. Few plays have petroleum roles recorded, so that weight often drops out. To check one, use Test a hypothesis.</p>
      </section>
    </div>
  );
}
function PlayFacts({ play, compact }: { play: Play5; compact?: boolean }) {
  const rows: [string, string][] = [["Age", ageLabel(play)], ["Environment", play.env.join(", ") || "not recorded"], ["Lithology", play.lith.join(", ") || "not recorded"], ["Resource flags", play.res.join(", ") || "none recorded"], ["Roles", play.roles.join(", ") || "not recorded"]];
  return (
    <dl className={cn("grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs", !compact && "mt-2 rounded-lg bg-muted/50 p-2")}>
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>)}
      <dt className="text-muted-foreground">Units</dt><dd>{play.units.slice(0, 6).map((u) => u.n).join(", ") || "not listed"}{play.units.length > 6 ? ` +${play.units.length - 6}` : ""}</dd>
    </dl>
  );
}
function Evidence({ play }: { play: Play5 }) {
  const ps = play.passages.map(passageById).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 2);
  return (
    <div className="space-y-1">
      <p className="font-medium">Evidence</p>
      <p className="flex items-center gap-1"><FileText className="size-3.5" aria-hidden="true" /> {play.province} play-interval table, Geoscience Australia eCat {play.ecat}</p>
      {ps.map((x) => <blockquote key={x.id} className="border-l-2 border-primary pl-2"><span className="font-medium">{x.doc}{x.page ? ` · p. ${x.page}` : ""}:</span> {x.t.length > 260 ? `${x.t.slice(0, 260)}…` : x.t}</blockquote>)}
      {!ps.length && <p className="text-muted-foreground">No report passage names this play. The table row is the evidence.</p>}
    </div>
  );
}
