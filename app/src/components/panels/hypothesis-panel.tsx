import { useMemo, useState } from "react";
import { BookmarkPlus, FlaskConical, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { rank, playById, type Weights } from "@/lib/analog";
import { PACK } from "@/lib/pack";
import { HYPOTHESES, VERDICT_RULE, testCustom, testHypothesis, type HDef, type HResult, type Stance } from "@/lib/hypothesis";
import type { ImageOpen } from "@/lib/images";
import { AnswerBadge, BuildChip } from "@/components/panels/common";
import { ImageStrip } from "@/components/panels/image-strip";

const GROUPS: { stance: Stance; title: string; cls: string }[] = [
  { stance: "for", title: "Evidence for", cls: "border-emerald-700" }, { stance: "against", title: "Evidence against", cls: "border-red-700" },
  { stance: "missing", title: "What's missing", cls: "border-amber-500" }, { stance: "context", title: "Context", cls: "border-slate-400" },
  { stance: "judge", title: "Passages to judge", cls: "border-sky-700" },
];
const V_CLS: Record<HResult["verdict"], string> = {
  Supported: "bg-emerald-700 text-white", "Supported, with gaps": "bg-emerald-100 text-emerald-900 border border-emerald-700", "Mixed evidence": "bg-amber-100 text-amber-950 border border-amber-500",
  "Open: not enough data": "bg-amber-100 text-amber-950 border border-amber-500", "More against than for": "bg-red-100 text-red-900 border border-red-700", "Not supported by this data": "bg-red-700 text-white", "Not judged": "bg-muted text-foreground border",
};
export type HypChoice = HDef["id"] | "custom";
export function HypothesisPanel(p: { refId: string; weights: Weights; choice: HypChoice; setChoice: (c: HypChoice) => void; result: HResult | null; setResult: (r: HResult | null) => void; onAsk: (q: string) => void; onOpen: (o: ImageOpen) => void; onSave: (r: HResult) => void; showBuild: boolean; saved: boolean }) {
  const [custom, setCustom] = useState("");
  const analogTitle = useMemo(() => { const ref = playById(p.refId) ?? playById(PACK.defaultRef)!; const top = rank(ref, p.weights)[0]?.play; return top ? `The ${top.play} is a good analog for the ${ref.play}` : HYPOTHESES[0].title; }, [p.refId, p.weights]);
  const run = () => p.setResult(p.choice === "custom" ? (custom.trim() ? testCustom(custom.trim()) : null) : testHypothesis(p.choice, { refId: p.refId, weights: p.weights }));
  const r = p.result;
  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Test a hypothesis</h2>
        <p className="text-sm">Pick a statement. You get what the data in this file says for it and against it, and what's missing, each with its source.</p>
      </header>
      {p.showBuild && <BuildChip cap="Hypothesis testing" />}
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Hypothesis</legend>
        {HYPOTHESES.map((h) => (
          <label key={h.id} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm", p.choice === h.id && "border-primary bg-primary/5")}>
            <input type="radio" name="hyp" className="mt-1" checked={p.choice === h.id} onChange={() => { p.setChoice(h.id); p.setResult(null); }} />
            <span>{h.id === "analog" ? analogTitle : h.title}{h.id === "analog" && <span className="block text-xs text-muted-foreground">Uses the reference play and weights from Rank analogs.</span>}</span>
          </label>
        ))}
        <label className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm", p.choice === "custom" && "border-primary bg-primary/5")}>
          <input type="radio" name="hyp" className="mt-1" checked={p.choice === "custom"} onChange={() => { p.setChoice("custom"); p.setResult(null); }} />
          <span className="flex-1">Write your own
            {p.choice === "custom" && <Textarea aria-label="Your hypothesis" value={custom} onChange={(e) => setCustom(e.target.value)} rows={2} maxLength={300} placeholder="e.g. The Toolachee Formation is a gas reservoir across the Cooper Basin" className="mt-1.5 text-sm" />}
            <span className="mt-0.5 block text-xs text-muted-foreground">The app finds passages for you to judge. It doesn't judge typed statements.</span>
          </span>
        </label>
      </fieldset>
      <Button type="button" onClick={run} disabled={p.choice === "custom" && !custom.trim()}><FlaskConical aria-hidden="true" /> Test it</Button>
      {r && (
        <article aria-label="Hypothesis result" className="space-y-3 rounded-xl border bg-card p-3 text-sm">
          <header className="space-y-1.5">
            <p className="font-semibold">{r.statement}</p>
            <div className="flex flex-wrap items-center gap-1.5"><span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", V_CLS[r.verdict])}>{r.verdict}</span><AnswerBadge label={r.label} />{r.ms != null && <span className="text-[11px] tabular-nums text-muted-foreground">{r.ms} ms</span>}</div>
            <p className="text-xs text-muted-foreground">{r.id === "custom" ? "No verdict for typed statements. Read each passage and decide." : VERDICT_RULE}</p>
          </header>
          {GROUPS.map((g) => { const items = r.items.filter((i) => i.stance === g.stance); return items.length ? (
            <section key={g.stance} className="space-y-1"><h3 className="text-xs font-semibold">{g.title} · {items.length}</h3>
              <ul className="space-y-1">{items.map((i, k) => <li key={k} className={cn("rounded-md border-l-2 bg-muted/40 px-2 py-1 text-xs", g.cls)}><p>{i.text}</p><p className="text-muted-foreground">{i.source}{i.conf ? ` · ${i.conf} confidence` : ""}</p></li>)}</ul>
            </section>) : null; })}
          {!r.items.length && <p className="text-sm">Not found in the data. Nothing in this file matches enough of the statement.</p>}
          {r.change.length > 0 && <section className="space-y-1"><h3 className="text-xs font-semibold">What would change this</h3><ul className="list-disc space-y-0.5 pl-4 text-xs">{r.change.map((c) => <li key={c}>{c}</li>)}</ul></section>}
          <ImageStrip images={r.images} onAsk={p.onAsk} onOpen={p.onOpen} label="Images to compare" />
          {r.next.length > 0 && <div className="flex flex-wrap gap-1.5">{r.next.map((n) => <Button key={n.label} type="button" size="xs" variant="outline" className="h-auto whitespace-normal py-1 text-left" disabled={!n.q && !n.open} onClick={() => (n.q ? p.onAsk(n.q) : n.open ? p.onOpen({ type: "evidence", item: n.open }) : undefined)}><Search aria-hidden="true" /> {n.label}</Button>)}</div>}
          <div className="flex flex-wrap gap-1.5 border-t pt-2">
            <Button type="button" size="xs" variant="outline" disabled={p.saved} onClick={() => p.onSave(r)}><BookmarkPlus aria-hidden="true" /> {p.saved ? "Saved to notes" : "Save to notes"}</Button>
            <Badge variant="outline" className="ml-auto">Level: Reason</Badge>
          </div>
        </article>
      )}
    </div>
  );
}
