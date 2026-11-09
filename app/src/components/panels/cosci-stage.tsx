import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, CircleHelp, FlaskConical, Layers3, Loader2, MapPinned, Mountain, Play, Save, ScanSearch, Scale, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STATUS_CLS } from "@/lib/pack";
import { AGENTS, PREPARED, runCoSci, type AgentId, type CoSciRun } from "@/lib/cosci";
import type { HDef, HItem } from "@/lib/hypothesis";
import type { Weights } from "@/lib/analog";
import { LABEL_CLS } from "@/components/panels/common";
import { SQUAD_ROLE, runSquad, squadToRun } from "@/lib/scientists";

const ICON: Record<AgentId, typeof BookOpen> = { literature: BookOpen, stratigraphy: Layers3, spatial: MapPinned, rock: Mountain, stress: Scale, critic: CircleHelp };
const ST: Record<HItem["stance"], { label: string; cls: string }> = {
  for: { label: "For", cls: "border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30" }, against: { label: "Against", cls: "border-red-700 bg-red-50 dark:bg-red-950/30" },
  missing: { label: "Missing", cls: "border-amber-500 bg-amber-50 dark:bg-amber-950/30" }, context: { label: "Context", cls: "border-slate-400 bg-muted/40" }, judge: { label: "To judge", cls: "border-sky-700 bg-sky-50 dark:bg-sky-950/30" },
};
const VERDICT_CLS: Record<string, string> = { Supported: "bg-emerald-700 text-white", "Supported, with gaps": "bg-emerald-100 text-emerald-900 border border-emerald-700", "Mixed evidence": "bg-amber-100 text-amber-950 border border-amber-600",
  "Open: not enough data": "bg-amber-100 text-amber-950 border border-amber-600", "More against than for": "bg-red-100 text-red-900 border border-red-700", "Not supported by this data": "bg-red-700 text-white", "Not judged": "bg-muted text-foreground border" };
const ENGINE_CLS: Record<string, string> = { answered: "bg-emerald-700 text-white", blocked: "bg-red-700 text-white", not_found: "bg-muted text-foreground border", validation_incomplete: "bg-amber-100 text-amber-950 border border-amber-600" };
const took = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
function Finding({ it }: { it: HItem }) {
  return <li className={cn("rounded-md border-l-[3px] px-2 py-1 text-sm", ST[it.stance].cls)}><span className="mr-1.5 text-[10px] font-bold uppercase tracking-wide">{ST[it.stance].label}</span>{it.text}<span className="block text-xs text-muted-foreground">{it.source}{it.conf ? ` · ${it.conf} confidence` : ""}</span></li>;
}
export interface CoSciReview { decision: "Accept" | "Reject" | "Needs more data"; note: string; reviewer: string }
export function CoSciStage(p: {
  topPad: number; hyp: HDef["id"] | null; setHyp: (h: HDef["id"] | null) => void; ctx: { refId: string; weights: Weights }; onAsk: (q: string) => void; onOpenImages: (q: string) => void;
  onSave: (r: CoSciRun, rv: CoSciReview) => void; reviewer: string; setReviewer: (s: string) => void; showBuild: boolean; onSelectEntity: (id: string) => void;
  /* In version 2, typed statements go to the Foundry scientists (lib/scientists.ts); the prepared ones stay rules. */
  scientists?: boolean;
}) {
  const [text, setText] = useState("");
  const [run, setRun] = useState<CoSciRun | null>(null);
  const [step, setStep] = useState(99);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<CoSciReview["decision"] | null>(null);
  const [working, setWorking] = useState<{ statement: string; elapsed: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const squad = useRef<AbortController | null>(null);
  const stopSquad = () => { squad.current?.abort(); squad.current = null; setWorking(null); };
  const reveal = () => setStep(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 99 : 0);
  const go = (input: { id?: HDef["id"]; text?: string }, keepNotice = false) => {
    stopSquad(); if (!keepNotice) setNotice(null);
    const r = runCoSci(input, p.ctx); setRun(r); setDecision(null); setNote(""); reveal();
  };
  // If the scientists can't run or take too long, the rules run instead and the workspace says so.
  const goSquad = async (statement: string, prepared: HDef["id"] | null) => {
    stopSquad(); const ac = new AbortController(); squad.current = ac;
    setNotice(null); setRun(null); setDecision(null); setNote(""); setWorking({ statement, elapsed: 0 });
    try {
      const r = await runSquad(statement, { signal: ac.signal, onTick: (elapsed) => { if (squad.current === ac) setWorking({ statement, elapsed }); } });
      if (squad.current !== ac) return;
      squad.current = null; setWorking(null); setRun(squadToRun(statement, prepared, r)); reveal();
    } catch (e) {
      if (squad.current !== ac) return;
      squad.current = null; setWorking(null);
      setNotice(`The Foundry scientists couldn't run this time (${e instanceof Error ? e.message : "no answer"}), so these are the rules over the bundled data instead.`);
      go(prepared ? { id: prepared } : { text: statement }, true);
    }
  };
  useEffect(() => () => squad.current?.abort(), []);
  useEffect(() => { if (p.hyp) go({ id: p.hyp }); }, [p.hyp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (step >= AGENTS.length) return; const t = window.setTimeout(() => setStep((s) => s + 1), 260); return () => window.clearTimeout(t); }, [step]);
  const done = step >= AGENTS.length;
  const prepared = useMemo(() => PREPARED.map((h) => ({ ...h, title: h.id === "analog" ? "The top-ranked analog is a good analog for the Patchawarra Play" : h.title })), []);
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col overflow-y-auto bg-[#F5F5FA] dark:bg-[#081B26]" style={{ top: p.topPad }}>
      <div className="space-y-2 border-b bg-background/90 px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Co-Scientist {p.scientists
          ? <><Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Extracted)}>Foundry scientists</Badge><span className="normal-case">Written by models and checked against the sources. You make the call.</span></>
          : <><Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Computed)}>Rules over the data</Badge><span className="normal-case">Nothing is generated. You make the call.</span></>}</p>
        <h2 className="text-base font-semibold leading-tight">Test a geological hypothesis with a team of agents</h2>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Prepared hypotheses">
          {prepared.map((h) => <button key={h.id} type="button" aria-pressed={run?.prepared === h.id} onClick={() => { p.setHyp(h.id); go({ id: h.id }); }}
            className={cn("max-w-xs rounded-lg border px-2.5 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring", run?.prepared === h.id ? "border-brand bg-brand text-white" : "bg-background hover:bg-muted")}>{h.title}</button>)}
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t) return; p.setHyp(null); if (p.scientists) void goSquad(t, null); else go({ text: t }); }}>
          <div className="min-w-[280px] flex-1 space-y-1"><label htmlFor="cs-text" className="text-xs font-medium">Or write your own statement</label>
            <Textarea id="cs-text" rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. The Toolachee Formation is a gas reservoir in Marabooka 1" className="min-h-9 text-sm" /></div>
          <Button type="submit" size="sm" disabled={!text.trim() || !!working} className="bg-brand text-white hover:bg-brand-hover"><Play aria-hidden="true" /> Run the agents</Button>
        </form>
        {p.showBuild && <p className="text-xs"><span className="rounded bg-[#DCFCE7] px-1.5 py-0.5 font-medium text-[#0d3b1c]">Foundry Agent Service, multi-agent with tools · Custom</span> <span className="rounded bg-[#FEF3C7] px-1.5 py-0.5 font-medium text-[#4a2a00]">Proposing new hypotheses: Microsoft Discovery · Research</span></p>}
      </div>
      {notice && <p role="status" className="mx-3 mt-3 rounded-md border border-amber-600 bg-amber-50 px-2 py-1.5 text-xs dark:bg-amber-950/30">{notice}</p>}
      {!run && !working && <p className="p-4 text-sm text-muted-foreground">{p.scientists
        ? "Pick a prepared hypothesis to see the rules over the bundled data, or write your own statement for the Foundry scientists. Each scientist searches the reports through GeoBasin's tools and cites what it used."
        : "Pick a prepared hypothesis or write your own. Each agent runs one tool over the bundled data and cites what it used."}</p>}
      {working && <div className="space-y-3 p-3" aria-live="polite" aria-busy="true">
        <p className="text-sm"><span className="font-semibold">Statement:</span> {working.statement}</p>
        <ol className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="Scientists at work">
          {AGENTS.map((a) => { const Icon = ICON[a.id];
            return <li key={a.id} className={cn("rounded-lg border bg-background p-2 text-xs", a.id === "critic" && "border-amber-600")}>
              <p className="flex items-center gap-1.5 font-semibold"><Icon className="size-4" aria-hidden="true" />{a.name}<Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /></p>
              <p className="text-muted-foreground">{SQUAD_ROLE[a.id]}</p></li>; })}
        </ol>
        <p className="text-sm tabular-nums">The Foundry scientists are working, {Math.round(working.elapsed / 1000)} s so far. A run takes about a minute and a half, and every statement is checked against its sources before you see it.</p>
        <Button type="button" size="sm" variant="outline" onClick={stopSquad}>Stop waiting</Button>
      </div>}
      {run && <div className="space-y-3 p-3">
        <p className="text-sm"><span className="font-semibold">Statement:</span> {run.statement}</p>
        <ol className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="Agents">
          {AGENTS.map((a, i) => { const o = run.agents.find((x) => x.id === a.id)!; const Icon = ICON[a.id]; const on = step > i; const n = o.items.length + o.images.length;
            return <li key={a.id} className={cn("rounded-lg border bg-background p-2 text-xs transition-all duration-300", on ? "opacity-100" : "translate-y-1 opacity-40", a.id === "critic" && "border-amber-600")}>
              <p className="flex items-center gap-1.5 font-semibold"><Icon className="size-4" aria-hidden="true" />{a.name}{on && <Check className="ml-auto size-3.5 text-emerald-700" aria-label="done" />}</p>
              <p className="text-muted-foreground">{run.engine ? SQUAD_ROLE[a.id] : a.tool}</p>
              <p className="mt-1 tabular-nums">{on ? (n ? `${n} finding${n === 1 ? "" : "s"}${o.ms ? ` · ${took(o.ms)}` : ""}` : o.note || "No findings") : "Waiting"}</p></li>; })}
        </ol>
        {done && <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            {!!run.engine?.lead.length && <section aria-label="Lead scientist findings" className="space-y-1.5 rounded-lg border bg-background p-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold"><FlaskConical className="size-4" aria-hidden="true" />Lead scientist <span className="text-xs font-normal text-muted-foreground">· Drew these together from the scientists' evidence</span></h3>
              <ul className="space-y-1">{run.engine.lead.map((it, j) => <Finding key={j} it={it} />)}</ul>
            </section>}
            {run.agents.filter((o) => o.id !== "critic").map((o) => { const a = AGENTS.find((x) => x.id === o.id)!; const Icon = ICON[o.id]; if (!o.items.length && !o.images.length) return null;
            return <section key={o.id} aria-label={`${a.name} findings`} className="space-y-1.5 rounded-lg border bg-background p-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Icon className="size-4" aria-hidden="true" />{a.name} <span className="text-xs font-normal text-muted-foreground">· {a.does}</span></h3>
              <ul className="space-y-1">{o.items.map((it, j) => <Finding key={j} it={it} />)}</ul>
              {o.images.length > 0 && <ul className="flex gap-2 overflow-x-auto pb-1">{o.images.map((im) => <li key={im.id} className="w-28 shrink-0"><img src={im.src} alt={im.title} className="h-24 w-full rounded border bg-white object-contain" /><p className="line-clamp-2 text-[11px] leading-tight">{im.title}</p>
                <button type="button" className="flex items-center gap-1 text-[11px] font-medium text-brand hover:underline dark:text-sky-200" onClick={() => p.onOpenImages(im.title)}><ScanSearch className="size-3" aria-hidden="true" /> Find similar</button></li>)}</ul>}
            </section>; })}
            {run.entities.length > 0 && <p className="text-xs text-muted-foreground">Named in the statement: {run.entities.map((e, i) => <span key={e.id}>{i ? ", " : ""}<button type="button" className="underline-offset-2 hover:underline" onClick={() => p.onSelectEntity(e.id)}>{e.label}</button></span>)}</p>}
          </div>
          <aside className="space-y-3">
            <section aria-label="Verdict" className="space-y-1.5 rounded-lg border bg-background p-2.5">
              <div className="flex flex-wrap items-center gap-1.5"><Badge className={cn("text-sm", VERDICT_CLS[run.verdict] ?? "bg-muted")}>{run.verdict}</Badge>{run.engine
                ? <Badge className={ENGINE_CLS[run.engine.status] ?? "bg-muted"}>{run.engine.label}</Badge> : <Badge className={LABEL_CLS[run.label]}>{run.label}</Badge>}<span className="text-xs tabular-nums text-muted-foreground">{took(run.ms)}</span></div>
              <p className="text-xs">{run.rule}</p>
              {run.engine ? <p className="text-xs tabular-nums">For {run.engine.tally.for} · Against {run.engine.tally.against} · Context {run.engine.tally.context} · Missing {run.engine.tally.missing}</p>
                : run.prepared && <p className="text-xs tabular-nums">For {run.counts.for} · Against {run.counts.against} · Missing {run.counts.missing}</p>}
              {p.scientists && !run.engine && <Button type="button" size="xs" variant="secondary" onClick={() => void goSquad(run.statement, run.prepared)}><FlaskConical aria-hidden="true" /> Ask the Foundry scientists</Button>}
            </section>
            <section aria-label="Critic" className="space-y-1 rounded-lg border border-amber-600 bg-background p-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold"><CircleHelp className="size-4" aria-hidden="true" />Critic</h3>
              <ul className="space-y-1">{run.agents.find((o) => o.id === "critic")!.items.map((it, j) => <li key={j} className={cn("rounded-md border-l-[3px] px-2 py-1 text-xs", ST[it.stance].cls)}><span className="mr-1 text-[10px] font-bold uppercase">{ST[it.stance].label}</span>{it.text}</li>)}</ul>
              {run.change.length > 0 && <><p className="pt-1 text-xs font-semibold">What would change the call</p><ul className="list-disc space-y-0.5 pl-4 text-xs">{run.change.map((c) => <li key={c}>{c}</li>)}</ul></>}
              {run.next.filter((n) => n.q).length > 0 && <div className="flex flex-wrap gap-1 pt-1">{run.next.filter((n) => n.q).map((n) => <Button key={n.label} type="button" size="xs" variant="secondary" onClick={() => p.onAsk(n.q!)}>{n.label}</Button>)}</div>}
            </section>
            <section aria-label="Your review" className="space-y-1.5 rounded-lg border-2 border-brand bg-background p-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold"><FlaskConical className="size-4" aria-hidden="true" />Your review</h3>
              <div className="flex flex-wrap gap-1">{(["Accept", "Reject", "Needs more data"] as const).map((d) => <Button key={d} type="button" size="xs" variant={decision === d ? "default" : "outline"} onClick={() => setDecision(d)}>{d === "Accept" ? <Check aria-hidden="true" /> : d === "Reject" ? <X aria-hidden="true" /> : null}{d}</Button>)}</div>
              <Input aria-label="Your name" placeholder="Your name" value={p.reviewer} onChange={(e) => p.setReviewer(e.target.value)} className="h-8 text-sm" />
              <Textarea aria-label="Your note" rows={2} placeholder="Why, in a sentence" value={note} onChange={(e) => setNote(e.target.value)} className="text-sm" />
              <Button type="button" size="sm" disabled={!decision} onClick={() => decision && p.onSave(run, { decision, note, reviewer: p.reviewer })}><Save aria-hidden="true" /> Save to Notes and the change log</Button>
            </section>
          </aside>
        </div>}
      </div>}
    </div>
  );
}
