import { LiveCitationPage } from "./live-page";
import { useState } from "react";
import { validationText } from "@/lib/cloud";
import { BookmarkPlus, ChevronDown, FilePlus2, FileText, FlaskConical, Image as ImageIcon, ListPlus, MapPin, RotateCcw, Search, Send, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Answer5 } from "@/lib/answer5";
import { DOWN_REASONS, type Reason, type Vote } from "@/lib/feedback";
import type { MapHit } from "@/lib/search";
import type { Geotag } from "@/lib/geotag";
import type { ImageHit, ImageOpen } from "@/lib/images";
import type { HDef } from "@/lib/hypothesis";
import { AnswerBadge, BuildChip, Rich } from "@/components/panels/common";

export interface FeedbackState { vote: Vote; reason: Reason; effect: string }

export function AskPanel(p: {
  answers: Answer5[]; onAsk: (q: string) => void; onShow: (a: Answer5) => void; onHit: (h: MapHit) => void; onSave: (a: Answer5) => void;
  onAnalogs: (ref: string) => void; onOpenField: (site: string, field: string) => void; showBuild: boolean; inputId: string; savedIds: Set<string>;
  onGeo: (g: Geotag) => void; onOpenImage: (o: ImageOpen) => void; onHypothesis: (id: HDef["id"]) => void;
  starters: string[]; feedback: Record<string, FeedbackState>; onFeedback: (a: Answer5, vote: Vote, reason: Reason) => void; onAddDoc: () => void; onAddToScore: (q: string) => void;
  /* compose: false when the Copilot holds the conversation and this panel only shows the full answers. */
  compose?: boolean;
}) {
  const [q, setQ] = useState("");
  const submit = (text: string) => { const t = text.trim(); if (!t) return; p.onAsk(t); setQ(""); };
  const compose = p.compose ?? true;
  return (
    <div className="space-y-3">
      {compose ? <form onSubmit={(e) => { e.preventDefault(); submit(q); }} className="space-y-2">
        <div className="flex items-center justify-between gap-2"><label htmlFor={p.inputId} className="text-sm font-semibold">Ask a question</label>
          <Button type="button" size="xs" variant="outline" onClick={p.onAddDoc}><FilePlus2 aria-hidden="true" /> Add a document</Button></div>
        <div className="flex items-center gap-2">
          <Input id={p.inputId} value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="e.g. Which plays are analogs to the Patchawarra Play?" className="h-10 text-sm" autoComplete="off" />
          <Button type="submit" size="icon" aria-label="Ask" disabled={!q.trim()}><Send aria-hidden="true" /></Button>
        </div>
        <p className="text-xs text-muted-foreground">Answers come only from the public data in this file and are computed in your browser. Each is tagged <b>Precomputed</b> (worked out from the data in advance), <b>Retrieved</b> (found by search when you ask) or <b>Not found</b>. Open <b>Show your work</b> on any answer to see the steps.</p>
      </form>
        : <p className="text-xs text-muted-foreground">The full answers from the Copilot, newest first. Each is tagged <b>Precomputed</b> (worked out from the data in advance), <b>Retrieved</b> (found by search when you ask) or <b>Not found</b>. Open <b>Show your work</b> to see the steps, and mark whether it was useful.</p>}
      {p.showBuild && <BuildChip cap="Ask with citations" />}
      {compose && !p.answers.length && (
        <section aria-label="Questions to try" className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Try one</h3>
          <div className="flex flex-wrap gap-1.5">{p.starters.slice(0, 8).map((s) => <Button key={s} type="button" size="xs" variant="outline" className="h-auto max-w-full whitespace-normal py-1 text-left" onClick={() => submit(s)}>{s}</Button>)}</div>
        </section>
      )}
      {!compose && !p.answers.length && <p className="rounded-lg border border-dashed p-3 text-sm">No answers yet. Ask the Copilot on the right, or use Ask on an entity, a document or a scorecard question.</p>}
      <ol className="space-y-3" aria-label="Answers">
        {p.answers.map((a, i) => <li key={a.id}><AnswerCard a={a} latest={i === 0} {...p} saved={p.savedIds.has(a.id)} onAsk={submit} fb={p.feedback[a.id]} /></li>)}
      </ol>
    </div>
  );
}

function AnswerCard({ a, latest, onShow, onHit, onSave, onAsk, onAnalogs, onOpenField, onGeo, onOpenImage, onHypothesis, saved, fb, onFeedback, onAddToScore }: { a: Answer5; latest: boolean; onShow: (a: Answer5) => void; onHit: (h: MapHit) => void; onSave: (a: Answer5) => void; onAsk: (q: string) => void; onAnalogs: (ref: string) => void; onOpenField: (site: string, field: string) => void; onGeo: (g: Geotag) => void; onOpenImage: (o: ImageOpen) => void; onHypothesis: (id: HDef["id"]) => void; saved: boolean; fb?: FeedbackState; onFeedback: (a: Answer5, vote: Vote, reason: Reason) => void; onAddToScore: (q: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [img, setImg] = useState<ImageHit | null>(null);
  void onHit;
  const geoAll = Object.values(a.geo ?? {}).flat().filter((g, i, arr) => arr.findIndex((x) => x.kind === g.kind && x.label.toLowerCase() === g.label.toLowerCase()) === i);
  const [down, setDown] = useState(false);
  return (
    <article id={`answer-${a.id}`} className={cn("scroll-mt-3 space-y-2 rounded-xl border bg-card p-3 text-sm", latest && "border-primary/50 shadow-sm")} aria-label={`Answer: ${a.question}`}>
      <header className="flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-snug">{a.question}</h3>
        <span className="flex shrink-0 flex-col items-end gap-0.5"><AnswerBadge label={a.label} />{a.ms != null && <span className="text-[11px] tabular-nums text-muted-foreground" title="Time to answer in this browser">{a.ms < 1 ? "<1" : Math.round(a.ms)} ms</span>}</span>
      </header>
      {a.placeNote && <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><MapPin className="mt-px size-3.5 shrink-0" aria-hidden="true" /><span>{a.placeNote}</span></p>}
      <div className="space-y-1.5">{a.paragraphs.map((t, i) => <p key={i} className={cn(/^\d+\. /.test(t) && "pl-3")}><Rich text={t} /></p>)}</div>
      {a.table && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/60"><tr>{a.table.columns.map((c) => <th key={c} scope="col" className="px-2 py-1 text-left font-semibold">{c}</th>)}</tr></thead>
            <tbody>{a.table.rows.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="px-2 py-1 tabular-nums">{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {a.citations.length > 0 && (
        <section aria-label="Sources" className="space-y-1">
          <h4 className="text-xs font-semibold">Sources</h4>
          <div className="flex flex-wrap gap-1.5">
            {a.citations.map((c) => (
              <Button key={c.id} type="button" size="xs" variant={open === c.id ? "secondary" : "outline"} aria-expanded={open === c.id} className="h-auto max-w-full whitespace-normal py-1 text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
                <FileText aria-hidden="true" /> {c.doc}{a.engine === "azure" && c.provenanceLabel ? ` · ${c.provenanceLabel}` : ""}{c.page ? ` · p. ${c.page}` : /OCR/.test(c.doc) ? " · page not marked in source" : ""}{a.citations.filter((x) => x.doc === c.doc && x.page === c.page).length > 1 ? ` · ${c.heading.replace(/^.*?, page \d+$/, "").slice(0, 32) || c.id.split(":").pop()}` : ""}
              </Button>
            ))}
          </div>
          {open && (() => { const c = a.citations.find((x) => x.id === open); const tags = a.geo?.[open] ?? []; return c ? (
            <blockquote className="space-y-1 rounded-md border-l-2 border-primary bg-muted/50 p-2 text-xs"><p className="font-medium">{c.heading}</p><p>{c.text.length > 700 ? `${c.text.slice(0, 700)}…` : c.text}</p><LiveCitationPage citation={c} />
              <p className="flex flex-wrap items-center gap-1 pt-0.5"><span className="font-medium">On the map:</span>{tags.length ? tags.map((g) => <GeoChip key={`${g.kind}${g.label}`} g={g} onGeo={onGeo} />) : <span className="text-muted-foreground">not tied to a place</span>}</p>
            </blockquote>) : null; })()}
        </section>
      )}
      {(a.images?.length ?? 0) > 0 && (
        <section aria-label="Images" className="space-y-1">
          <h4 className="flex items-center gap-1 text-xs font-semibold"><ImageIcon className="size-3.5" aria-hidden="true" /> Images · {a.images!.length}</h4>
          <ul className="flex gap-2 overflow-x-auto pb-1">{a.images!.map((im) => (
            <li key={im.id} className="w-28 shrink-0">
              <button type="button" onClick={() => setImg(im)} className="block w-full overflow-hidden rounded-md border bg-white focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open image: ${im.title}`}><img src={im.src} alt="" className="h-20 w-full object-cover" /></button>
              <p className="mt-0.5 line-clamp-2 text-[11px] font-medium leading-tight">{im.title}</p>
              <p className="line-clamp-2 text-[10px] leading-tight text-muted-foreground">{im.why}</p>
            </li>))}</ul>
        </section>
      )}
      {geoAll.length > 0 && (
        <section aria-label="On the map" className="space-y-1">
          <h4 className="text-xs font-semibold">On the map</h4>
          <div className="flex flex-wrap gap-1">{geoAll.map((g) => <GeoChip key={`${g.kind}:${g.label}`} g={g} onGeo={onGeo} />)}</div>
        </section>
      )}
      <div className="flex flex-wrap gap-1.5 border-t pt-2">
        {(a.focus || a.focusBasin) && <Button type="button" size="xs" variant="secondary" onClick={() => onShow(a)}><MapPin aria-hidden="true" /> Show on map</Button>}
        {a.analogRef && <Button type="button" size="xs" variant="secondary" onClick={() => onAnalogs(a.analogRef!)}><Search aria-hidden="true" /> Open in Analogs</Button>}
        {a.fieldRef && <Button type="button" size="xs" variant="secondary" onClick={() => onOpenField(a.fieldRef!.site, a.fieldRef!.field)}><FileText aria-hidden="true" /> Open the page</Button>}
        {a.hypothesisRef && <Button type="button" size="xs" variant="secondary" onClick={() => onHypothesis(a.hypothesisRef!)}><FlaskConical aria-hidden="true" /> Test as a hypothesis</Button>}
        <Button type="button" size="xs" variant="outline" disabled={saved} onClick={() => onSave(a)}><BookmarkPlus aria-hidden="true" /> {saved ? "Saved to notes" : "Save to notes"}</Button>
      </div>
      <Dialog open={!!img} onOpenChange={(o) => !o && setImg(null)}>
        <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto">
          {img && (<>
            <DialogTitle>{img.title}</DialogTitle>
            <DialogDescription>{img.caption} · {img.why}</DialogDescription>
            <img src={img.src} alt={img.title} className="w-full rounded border bg-white" />
            <div className="flex flex-wrap gap-1.5">
              {img.askAbout && <Button type="button" size="sm" variant="secondary" onClick={() => { const q = img.askAbout!; setImg(null); onAsk(q); }}><Search aria-hidden="true" /> Find text about this</Button>}
              {img.open && <Button type="button" size="sm" variant="outline" onClick={() => { const o = img.open!; setImg(null); onOpenImage(o); }}><FileText aria-hidden="true" /> Open in Evidence</Button>}
            </div>
          </>)}
        </DialogContent>
      </Dialog>
      {a.followUps.length > 0 && (
        <div className="flex flex-wrap gap-1.5">{a.followUps.filter((f) => /\?$|^Open /.test(f)).slice(0, 3).map((f) => <Button key={f} type="button" size="xs" variant="ghost" className="h-auto whitespace-normal py-0.5 text-left text-xs underline-offset-2 hover:underline" onClick={() => (/^Open Analogs/.test(f) && a.analogRef ? onAnalogs(a.analogRef) : /^Open .* evidence$/.test(f) && a.fieldRef ? onOpenField(a.fieldRef.site, a.fieldRef.field) : /^Open Evidence/.test(f) ? onOpenField("core", "") : onAsk(f))}>{f}</Button>)}</div>
      )}
      <Collapsible>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium hover:underline">Show your work <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" /></CollapsibleTrigger>
          <span className="text-[11px] text-muted-foreground">{a.engine ? "Answered by the GeoBasin service" : "Computed in your browser"}{a.ms != null ? ` in ${a.ms < 1 ? "<1" : Math.round(a.ms)} ms` : ""}{a.searchInfo ? ` · ${a.searchInfo.scanned.toLocaleString("en-US")} passages searched` : ""}</span>
        </div>
        <CollapsibleContent className="mt-1.5">
          <ol className="space-y-1 border-l-2 border-brand/30 pl-3 text-xs" aria-label="Steps">
            {(a.trace ?? []).map((t, i) => <li key={i}><span className="font-medium">{i + 1}. {t.step}</span> <span className="tabular-nums text-muted-foreground">· {t.ms < 1 ? "<1" : t.ms} ms</span><span className="block text-muted-foreground">{t.detail}</span></li>)}
          </ol>
          {a.why.scores.length > 0 && a.label !== "Precomputed" && <p className="mt-1 text-[11px] text-muted-foreground"><span className="font-medium">Top passage scores:</span> {a.why.scores.slice(0, 5).map((x) => `${x.id} ${x.score}`).join(" · ")}</p>}
          <p className="mt-1 text-[11px] text-muted-foreground">Tag: {a.label}. {a.reason}. {a.engine ? (a.label === "Retrieved" ? "Written from the cited passages only, then checked independently." : "") : "No text is generated: answers quote the data or compute from it."}</p>
          {validationText(a) && <p className="mt-0.5 text-[11px] font-medium">{validationText(a)}</p>}
          {!!a.validation?.removed.length && <details className="mt-0.5 text-[11px] text-muted-foreground"><summary className="cursor-pointer">What the checks removed ({a.validation.removed.length})</summary><ul className="list-disc pl-4">{a.validation.removed.map((r, i) => <li key={i}>{r.text} <span className="italic">({r.why})</span></li>)}</ul></details>}
        </CollapsibleContent>
      </Collapsible>
      {a.status !== "declined" && <div className="space-y-1.5 rounded-lg bg-muted/50 p-2" aria-label="Feedback">
        {!fb ? (<>
          <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="font-medium">Was this useful?</span>
            <Button type="button" size="xs" variant="outline" onClick={() => onFeedback(a, "up", "Right source")}><ThumbsUp aria-hidden="true" /> Yes</Button>
            <Button type="button" size="xs" variant="outline" aria-expanded={down} onClick={() => setDown(!down)}><ThumbsDown aria-hidden="true" /> No</Button>
          </div>
          {down && <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="What was wrong"><span>What was wrong?</span>{DOWN_REASONS.map((r) => <Button key={r} type="button" size="xs" variant="secondary" onClick={() => { setDown(false); onFeedback(a, "down", r); }}>{r}</Button>)}</div>}
        </>) : (
          <div className="space-y-1 text-xs" role="status">
            <p><span className="font-medium">{fb.vote === "up" ? "Marked useful." : `Marked: ${fb.reason.toLowerCase()}.`}</span> {fb.effect}</p>
            <div className="flex flex-wrap gap-1.5">
              {fb.vote === "down" && fb.reason === "Wrong source" && a.label === "Retrieved" && <Button type="button" size="xs" variant="secondary" onClick={() => onAsk(a.question)}><RotateCcw aria-hidden="true" /> Ask again</Button>}
              {fb.vote === "down" && fb.reason === "Missing facts" && <Button type="button" size="xs" variant="secondary" onClick={() => onAddToScore(a.question)}><ListPlus aria-hidden="true" /> Add to Score</Button>}
            </div>
          </div>
        )}
      </div>}
    </article>
  );
}

function GeoChip({ g, onGeo }: { g: Geotag; onGeo: (g: Geotag) => void }) {
  return (
    <button type="button" onClick={() => onGeo(g)} title={`${g.kind === "point" ? "Point" : "Basin outline"} · ${g.method}`}
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
      {g.kind === "point" ? <MapPin className="size-3" aria-hidden="true" /> : <Square className="size-3" aria-hidden="true" />}
      <span className="font-medium">{g.label}</span><span className="text-muted-foreground">· {g.kind === "point" ? "point" : "outline"}, {g.method.toLowerCase()}</span>
    </button>
  );
}
