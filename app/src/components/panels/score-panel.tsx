import { useMemo, useState } from "react";
import { Download, Eye, EyeOff, Play, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { DATA_TYPES, LEVELS, type Bench, type DataType, type Level } from "@/lib/pack";
import { DT_LABEL, LEVEL_ORDER, summary, type Mark, type ScoreEntry, type ScoreState } from "@/lib/score";
import { AnswerBadge, BuildChip } from "@/components/panels/common";
import type { TestRun } from "@/lib/autocheck";

const MARKS: Mark[] = ["Correct", "Partial", "Wrong"];
const M_CLS: Record<Mark, string> = { Correct: "bg-emerald-700 text-white hover:bg-emerald-800", Partial: "bg-amber-500 text-black hover:bg-amber-600", Wrong: "bg-red-700 text-white hover:bg-red-800" };

export function ScorePanel(p: {
  questions: Bench[]; score: ScoreState; setEntry: (id: string, e: Partial<ScoreEntry>) => void; reviewer: string; setReviewer: (s: string) => void;
  onAsk: (q: Bench) => void; onAdd: (q: Omit<Bench, "id" | "custom">) => void; onRemove: (id: string) => void; onExport: () => void; onReset: () => void; showBuild: boolean; storageOk: boolean;
  onRunTest: () => void; testRun: TestRun | null; running: { n: number; of: number } | null;
}) {
  const sum = useMemo(() => summary(p.questions, p.score), [p.questions, p.score]);
  const [dt, setDt] = useState<DataType | "all">("all");
  const list = dt === "all" ? p.questions : p.questions.filter((q) => q.dataType === dt);
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Scorecard</h2>
        <p className="text-sm">Ask each question, check the answer against its sources, then mark it and record the highest level reached. Add your own questions below. Export to Excel for the readout.</p>
      </header>
      {p.showBuild && <BuildChip cap="Scorecard" />}
      {!p.storageOk && <p role="status" className="rounded-lg border border-amber-500 bg-amber-50 p-2 text-xs text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">This browser is not keeping data for local files. Your marks last until you close this tab, so export before you leave.</p>}
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1"><label htmlFor="sc-name" className="text-xs font-medium">Reviewer name</label><Input id="sc-name" value={p.reviewer} onChange={(e) => p.setReviewer(e.target.value)} maxLength={60} placeholder="Your name or team" className="h-8 text-sm" /></div>
        <Button type="button" size="sm" onClick={p.onExport}><Download aria-hidden="true" /> Export to Excel</Button>
      </div>
      <TestRunPanel run={p.testRun} running={p.running} n={p.questions.length} onRun={p.onRunTest} />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <caption className="sr-only">Results by data type</caption>
          <thead className="bg-muted/60"><tr>{["Data type", "Marked", "Correct", "Partial", "Wrong", "% correct"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left font-semibold">{h}</th>)}</tr></thead>
          <tbody>{sum.map((r) => <tr key={r.name} className={cn("border-t", r.name === "All questions" && "font-semibold")}><td className="px-1.5 py-1">{r.name}</td><td className="px-1.5 py-1 tabular-nums">{r.marked}/{r.questions}</td><td className="px-1.5 py-1 tabular-nums">{r.correct}</td><td className="px-1.5 py-1 tabular-nums">{r.partial}</td><td className="px-1.5 py-1 tabular-nums">{r.wrong}</td><td className="px-1.5 py-1 tabular-nums">{r.pct == null ? "—" : `${r.pct}%`}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Highest level reached (all marked): {LEVEL_ORDER.map((l) => `${l} ${sum[sum.length - 1].levels[l]}`).join(" · ")}</p>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Show data type">
        <Button type="button" size="xs" variant={dt === "all" ? "secondary" : "ghost"} aria-pressed={dt === "all"} onClick={() => setDt("all")}>All · {p.questions.length}</Button>
        {DATA_TYPES.map((d) => <Button key={d.id} type="button" size="xs" variant={dt === d.id ? "secondary" : "ghost"} aria-pressed={dt === d.id} onClick={() => setDt(d.id)}>{d.label} · {p.questions.filter((q) => q.dataType === d.id).length}</Button>)}
      </div>
      <ol className="space-y-2">{list.map((q) => <QuestionCard key={q.id} q={q} e={p.score[q.id] ?? {}} set={(e) => p.setEntry(q.id, e)} onAsk={() => p.onAsk(q)} onRemove={q.custom ? () => p.onRemove(q.id) : undefined} />)}</ol>
      <AddQuestion onAdd={p.onAdd} />
      <div className="flex justify-between gap-2 border-t pt-3">
        <Button type="button" size="sm" variant="ghost" onClick={p.onReset}><Trash2 aria-hidden="true" /> Clear all marks</Button>
        <Button type="button" size="sm" onClick={p.onExport}><Download aria-hidden="true" /> Export to Excel</Button>
      </div>
    </div>
  );
}
function QuestionCard({ q, e, set, onAsk, onRemove }: { q: Bench; e: ScoreEntry; set: (e: Partial<ScoreEntry>) => void; onAsk: () => void; onRemove?: () => void }) {
  const shown = e.revealed || !!e.mark;
  return (
    <li id={`q-${q.id}`} className="space-y-2 rounded-lg border p-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0"><span className="mr-1.5 font-semibold tabular-nums">{q.id}</span>{q.q}</p>
        {e.label && e.label !== "Not asked" ? <AnswerBadge label={e.label} /> : <Badge variant="outline">Not asked</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">{DT_LABEL[q.dataType]} · target level {q.level}{q.custom ? " · added by a reviewer" : ""}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant="secondary" onClick={onAsk}><Send aria-hidden="true" /> Ask</Button>
        <Button type="button" size="xs" variant="outline" aria-expanded={shown} onClick={() => set({ revealed: !e.revealed })} disabled={!!e.mark}>{shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />} {shown ? "Answer key shown" : "Show answer key"}</Button>
        {onRemove && <Button type="button" size="xs" variant="ghost" onClick={onRemove}><Trash2 aria-hidden="true" /> Remove</Button>}
      </div>
      {shown && (
        <div className="rounded-md bg-muted/60 p-2 text-xs">
          <p><span className="font-medium">Answer key:</span> {q.key || "None given. Judge against the sources."}</p>
          {q.evidence.length > 0 && <p className="mt-0.5"><span className="font-medium">Evidence:</span> {q.evidence.map((v) => `${v.doc}${v.page ? ` p. ${v.page}` : ""}`).join("; ")}</p>}
        </div>
      )}
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium">Mark</legend>
        <div className="flex gap-1.5">{MARKS.map((m) => <Button key={m} type="button" size="xs" aria-pressed={e.mark === m} variant="outline" className={cn(e.mark === m && M_CLS[m])} onClick={() => set({ mark: e.mark === m ? undefined : m, markedAt: new Date().toISOString().slice(0, 16).replace("T", " ") })}>{m}</Button>)}</div>
      </fieldset>
      <div className="grid grid-cols-2 gap-1.5">
        <div className="space-y-0.5"><label htmlFor={`lv-${q.id}`} className="text-xs font-medium">Highest level reached</label>
          <select id={`lv-${q.id}`} value={e.level ?? ""} onChange={(ev) => set({ level: (ev.target.value || undefined) as Level | undefined })} className="h-8 w-full rounded-md border bg-background px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring">
            <option value="">Not set</option>{LEVELS.map((l) => <option key={l.id} value={l.id}>{l.id}: {l.hint}</option>)}
          </select>
        </div>
        <div className="space-y-0.5"><label htmlFor={`ev-${q.id}`} className="text-xs font-medium">Evidence used</label><Input id={`ev-${q.id}`} value={e.evidence ?? ""} onChange={(ev) => set({ evidence: ev.target.value })} maxLength={200} placeholder="e.g. Cooper report p. 2" className="h-8 text-xs" /></div>
      </div>
      <div className="space-y-0.5"><label htmlFor={`nt-${q.id}`} className="text-xs font-medium">Notes</label><Input id={`nt-${q.id}`} value={e.notes ?? ""} onChange={(ev) => set({ notes: ev.target.value })} maxLength={300} className="h-8 text-xs" /></div>
    </li>
  );
}
function AddQuestion({ onAdd }: { onAdd: (q: Omit<Bench, "id" | "custom">) => void }) {
  const [q, setQ] = useState(""); const [dt, setDt] = useState<DataType>("born-digital"); const [lv, setLv] = useState<Level>("Find"); const [key, setKey] = useState(""); const [ev, setEv] = useState("");
  return (
    <Collapsible>
      <CollapsibleTrigger asChild><Button type="button" size="sm" variant="outline" className="w-full"><Plus aria-hidden="true" /> Add a question</Button></CollapsibleTrigger>
      <CollapsibleContent>
        <form className="mt-2 space-y-2 rounded-lg border p-2.5" onSubmit={(e) => { e.preventDefault(); if (!q.trim()) return; onAdd({ q: q.trim(), dataType: dt, level: lv, key: key.trim(), evidence: ev.trim() ? [{ doc: ev.trim(), page: 0 }] : [] }); setQ(""); setKey(""); setEv(""); }}>
          <div className="space-y-0.5"><label htmlFor="nq-q" className="text-xs font-medium">Question</label><Textarea id="nq-q" value={q} onChange={(e) => setQ(e.target.value)} rows={2} maxLength={300} className="text-sm" /></div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="space-y-0.5"><label htmlFor="nq-dt" className="text-xs font-medium">Data type</label><select id="nq-dt" value={dt} onChange={(e) => setDt(e.target.value as DataType)} className="h-8 w-full rounded-md border bg-background px-1.5 text-xs">{DATA_TYPES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></div>
            <div className="space-y-0.5"><label htmlFor="nq-lv" className="text-xs font-medium">Target level</label><select id="nq-lv" value={lv} onChange={(e) => setLv(e.target.value as Level)} className="h-8 w-full rounded-md border bg-background px-1.5 text-xs">{LEVELS.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}</select></div>
          </div>
          <div className="space-y-0.5"><label htmlFor="nq-k" className="text-xs font-medium">Answer key (optional)</label><Input id="nq-k" value={key} onChange={(e) => setKey(e.target.value)} maxLength={400} className="h-8 text-xs" /></div>
          <div className="space-y-0.5"><label htmlFor="nq-e" className="text-xs font-medium">Expected source (optional)</label><Input id="nq-e" value={ev} onChange={(e) => setEv(e.target.value)} maxLength={200} className="h-8 text-xs" /></div>
          <Button type="submit" size="sm" disabled={!q.trim()}><Plus aria-hidden="true" /> Add question</Button>
          <p className="text-xs text-muted-foreground">Added questions are kept in this browser and included in the export.</p>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TestRunPanel({ run, running, n, onRun }: { run: TestRun | null; running: { n: number; of: number } | null; n: number; onRun: () => void }) {
  const rows = run?.rows ?? [];
  const src = rows.filter((r) => r.source != null); const srcOk = src.filter((r) => r.source).length;
  const kf = rows.filter((r) => r.facts); const kfOk = kf.reduce((s, r) => s + r.facts![0], 0), kfAll = kf.reduce((s, r) => s + r.facts![1], 0);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b); const med = ms.length ? ms[Math.floor(ms.length / 2)] : null;
  /* The founding acceptance bar for the twelve seed questions: expected source on all 12 and at least 46 of 51 key facts. */
  const seed = rows.filter((r) => /^Q\d{2}$/.test(r.id)); const seedSrc = seed.filter((r) => r.source).length;
  const seedKf = seed.reduce((s, r) => s + (r.facts?.[0] ?? 0), 0), seedAll = seed.reduce((s, r) => s + (r.facts?.[1] ?? 0), 0);
  const seedMet = seedSrc === 12 && seedKf >= 46;
  return (
    <section aria-labelledby="tr-h" className="space-y-1.5 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="tr-h" className="text-sm font-semibold">Live test run</h3>
        <Button type="button" size="sm" onClick={onRun} disabled={!!running}><Play aria-hidden="true" /> {running ? `Running ${running.n} of ${running.of}` : `Run all ${n} questions`}</Button>
      </div>
      <p className="text-xs text-muted-foreground">Asks every question in your browser and checks two things: did the answer cite the expected source, and how many key facts from the answer key show up. It helps reviewers. The mark is still yours.</p>
      {run && !running && (<>
        <p className="text-xs" role="status"><span className="font-semibold">{rows.length} questions in {run.totalMs} ms.</span> Expected source cited: {srcOk} of {src.length}. Key facts found: {kfOk} of {kfAll}. Median answer time {med ?? "—"} ms. Run at {run.at}.</p>
        {seed.length === 12 && seedAll === 51 && <p className={cn("rounded-md px-2 py-1 text-xs", seedMet ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-950")}>Acceptance bar for the twelve seed questions: expected source on all 12 (this run: {seedSrc}) and at least 46 of 51 key facts (this run: {seedKf}). {seedMet ? "Both are met." : "Not met yet."}</p>}
        {(!!run.fb || !!run.added) && <p className="rounded-md bg-muted px-2 py-1 text-[11px]">{run.fb ? `${run.fb} feedback ${run.fb === 1 ? "vote was" : "votes were"} re-ranking answers in this browser during this run, so results can differ from a fresh run. Clear them in Data, Governance, then run again.` : ""}{run.fb && run.added ? " " : ""}{run.added ? `${run.added} added ${run.added === 1 ? "document was" : "documents were"} also searched.` : ""}</p>}
        <div className="max-h-56 overflow-auto rounded-md border"><table className="w-full text-xs"><caption className="sr-only">Test run results</caption>
          <thead className="sticky top-0 bg-muted"><tr>{["ID", "Tag", "Source", "Key facts", "ms"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left font-semibold">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="border-t"><td className="px-1.5 py-0.5 font-medium tabular-nums">{r.id}</td><td className="px-1.5 py-0.5">{r.label}</td>
            <td className="px-1.5 py-0.5">{r.source == null ? "—" : r.source ? "Yes" : "No"}</td><td className="px-1.5 py-0.5 tabular-nums">{r.facts ? `${r.facts[0]} of ${r.facts[1]}` : "—"}</td><td className="px-1.5 py-0.5 tabular-nums">{r.ms}</td></tr>)}</tbody></table></div>
        <p className="text-[11px] text-muted-foreground">Added questions with no answer key or expected source show a dash. The results go to the Excel export (Test run sheet).</p>
      </>)}
    </section>
  );
}
