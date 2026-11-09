import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileText, MapPin, Maximize2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/basins";
import { CONFIDENCE, OCR_LABEL, docById, fieldValue, fieldSI, type Site, type SiteField, type SitePage } from "@/lib/wells";
import { BuildChip } from "@/components/panels/common";

const ORDER = ["identity", "depth", "reservoir", "seal", "pressure", "fluid", "temperature", "integrity"];
const GROUP_LABEL: Record<string, string> = { identity: "Well", depth: "Depth", reservoir: "Reservoir", seal: "Seal", pressure: "Pressure", fluid: "Fluids", temperature: "Temperature", integrity: "Casing" };
const METHOD: Record<SiteField["method"], string> = { "text-layer": "Read from the PDF text layer", "vision-read": "Read from the page image", computed: "Computed from values read on the page" };
const shortLabel = (t: string) => (t.length > 64 ? `${t.slice(0, 62)}…` : t);
const pageFor = (s: Site, f: { docId: string; page: number; pageId?: string }) => s.pages.find((p) => (f.pageId ? p.pageId === f.pageId : p.docId === f.docId && p.page === f.page)) ?? null;

export function WellEvidence(props: { site: Site; showBuild: boolean; focusField: string | null; reviewed: Record<string, string>; onReview: (s: Site, f: SiteField, decision: "accepted" | "edited", value?: string) => void; onShowOnMap: (s: Site) => void; extra?: React.ReactNode }) {
  const { site, focusField } = props;
  const [pageId, setPageId] = useState<string | null>(site.pages[0]?.pageId ?? null);
  const [zoom, setZoom] = useState<SitePage | null>(null);
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { setPageId(site.pages[0]?.pageId ?? null); setFilter("all"); setEditing(null); }, [site.siteId, site.pages]);
  useEffect(() => {
    if (!focusField) return;
    const f = site.fields.find((x) => x.fieldId === focusField); if (!f) return;
    const pg = pageFor(site, f); if (pg) setPageId(pg.pageId);
    setFilter("all");
    const t = window.setTimeout(() => listRef.current?.querySelector(`[data-field="${CSS.escape(focusField)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    return () => window.clearTimeout(t);
  }, [focusField, site]);
  const page = site.pages.find((p) => p.pageId === pageId) ?? site.pages[0] ?? null;
  const st = site.stats;
  const ordered = useMemo(() => [...site.fields].sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group)), [site]);
  const fields = filter === "review" ? ordered.filter((f) => f.needsReview) : ordered;
  const doc = page ? docById(site, page.docId) : null;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold">{site.name}</h2>
          <Button type="button" size="xs" variant="secondary" onClick={() => props.onShowOnMap(site)}><MapPin aria-hidden="true" /> Map</Button>
        </div>
        <p className="text-sm">{site.role}</p>
        <p className="text-xs text-muted-foreground">{[site.operator, site.spudYear && `spudded ${site.spudYear}`, site.totalDepthM && `TD ${fmt(site.totalDepthM)} m`].filter(Boolean).join(" · ")}</p>
      </header>
      {props.showBuild && <BuildChip cap="Document extraction" />}
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <Stat label="Files in the package" value={fmt(st.docsInPackage)} sub={`${st.docsSampled} opened`} />
        <Stat label="Pages read" value={fmt(st.pagesSampled)} sub={`${st.pagesReadable} readable`} />
        <Stat label="Values extracted" value={fmt(st.fieldsTotal)} sub={`${st.fieldsNeedReview} need review`} />
        {st.ocrCompared > 0 ? <Stat label="Old OCR text got right" value={`${st.ocrMatch} of ${st.ocrCompared}`} sub={st.ocrMissing ? `${st.ocrMissing} missing from it entirely` : "values checked"} /> : <Stat label="Statements cited" value={fmt(site.findings.length)} sub="with page and quote" />}
      </dl>
      {props.extra}
      {page && (
        <section aria-labelledby="pg-h" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2"><h3 id="pg-h" className="text-sm font-semibold">Source pages</h3><span className="text-xs text-muted-foreground">{site.pages.length} included</span></div>
          <button type="button" onClick={() => setZoom(page)} className="group relative block w-full overflow-hidden rounded-lg border bg-white focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Enlarge ${page.caption}`}>
            {page.img ? <img src={page.img} alt={`${site.name}: ${page.caption}`} className="max-h-72 w-full object-contain" /> : <span className="block p-3 text-sm">Image not included for this page.</span>}
            <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-md bg-black/60 text-white"><Maximize2 className="size-4" aria-hidden="true" /></span>
          </button>
          <p className="text-xs"><span className="font-medium">{shortLabel(doc?.title ?? page.docId)}</span> · p. {page.page} · {page.caption} · readability {page.readability}</p>
          {site.pages.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Source pages">
              {site.pages.map((pg) => (
                <button key={pg.pageId} type="button" aria-pressed={pg.pageId === page.pageId} aria-label={`${docById(site, pg.docId)?.title ?? pg.docId}, page ${pg.page}: ${pg.caption}`} onClick={() => setPageId(pg.pageId)}
                  className={cn("h-14 w-11 shrink-0 overflow-hidden rounded border bg-white focus-visible:outline-2 focus-visible:outline-ring", pg.pageId === page.pageId && "ring-2 ring-primary")}>
                  {pg.img && <img src={pg.img} alt="" className="size-full object-cover object-top" />}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      <section aria-labelledby="val-h" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="val-h" className="text-sm font-semibold">Values extracted · {site.fields.length}</h3>
          <div className="flex gap-1" role="group" aria-label="Filter values">
            <Button type="button" size="xs" variant={filter === "all" ? "secondary" : "ghost"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</Button>
            <Button type="button" size="xs" variant={filter === "review" ? "secondary" : "ghost"} aria-pressed={filter === "review"} onClick={() => setFilter("review")}>Needs review · {st.fieldsNeedReview}</Button>
          </div>
        </div>
        <ul ref={listRef} className="space-y-2">
          {fields.map((f) => {
            const si = fieldSI(f); const pg = pageFor(site, f); const done = props.reviewed[`field:${site.siteId}:${f.fieldId}`];
            return (
              <li key={f.fieldId} data-field={f.fieldId} className={cn("rounded-lg border p-2.5 text-sm", focusField === f.fieldId && "ring-2 ring-ring")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-medium"><span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{GROUP_LABEL[f.group] ?? f.group}</span>{f.label}</p>
                  <Badge className={cn("shrink-0", CONFIDENCE[f.confidence].cls)}>{CONFIDENCE[f.confidence].label}</Badge>
                </div>
                <p className="mt-0.5 tabular-nums"><span className="font-semibold">{fieldValue(f)}</span>{si && <span className="text-muted-foreground"> · {si}</span>}</p>
                <p className="text-xs text-muted-foreground">{[f.formation, f.depthM != null && `${fmt(f.depthM)} m${f.depthRef && !/not stated/i.test(f.depthRef) ? ` ${f.depthRef}` : ""}`, f.method === "computed" ? `computed: ${f.conversion ?? ""}` : f.conversion].filter(Boolean).join(" · ")}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Button type="button" size="xs" variant="secondary" className="h-auto max-w-full whitespace-normal py-1 text-left" disabled={!pg} onClick={() => pg && setPageId(pg.pageId)}><FileText aria-hidden="true" /> {shortLabel(docById(site, f.docId)?.title ?? f.docId)} · p. {f.page}</Button>
                  {f.ocrBaseline && <Badge variant="outline" className={OCR_LABEL[f.ocrBaseline.status].cls}>{OCR_LABEL[f.ocrBaseline.status].label}</Badge>}
                </div>
                <Collapsible defaultOpen={focusField === f.fieldId}>
                  <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 text-xs font-medium hover:underline">Where did this come from? <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" /></CollapsibleTrigger>
                  <CollapsibleContent className="mt-1 space-y-1.5 text-xs">
                    <blockquote className="border-l-2 border-primary pl-2">“{f.quote}”</blockquote>
                    <p>Confidence: {f.confidenceWhy}</p>
                    {f.ocrBaseline?.text && <p>Existing OCR text at this spot: “{f.ocrBaseline.text}”</p>}
                    <Lineage site={site} f={f} showBuild={props.showBuild} reviewed={done} />
                  </CollapsibleContent>
                </Collapsible>
                {f.needsReview && (
                  <div className="mt-2 border-t pt-2">
                    {done ? <p className="flex items-center gap-1 text-xs font-medium"><Check className="size-3.5" aria-hidden="true" /> {done}</p>
                      : editing === f.fieldId ? (
                        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { props.onReview(site, f, "edited", draft.trim()); setEditing(null); setDraft(""); } }}>
                          <label htmlFor={`fix-${f.fieldId}`} className="sr-only">Corrected value for {f.label}</label>
                          <Input id={`fix-${f.fieldId}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={fieldValue(f)} className="h-7 text-xs" maxLength={120} />
                          <Button type="submit" size="xs" disabled={!draft.trim()}>Save</Button>
                          <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                        </form>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          <Button type="button" size="xs" variant="outline" onClick={() => props.onReview(site, f, "accepted")}><Check aria-hidden="true" /> Accept</Button>
                          <Button type="button" size="xs" variant="outline" onClick={() => { setEditing(f.fieldId); setDraft(""); }}><PencilLine aria-hidden="true" /> Correct</Button>
                        </div>
                      )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {site.findings.length > 0 && (
        <section aria-labelledby="fd-h" className="space-y-2">
          <h3 id="fd-h" className="text-sm font-semibold">What the files say</h3>
          <ul className="space-y-2">
            {site.findings.map((f) => { const pg = pageFor(site, f); return (
              <li key={f.findingId} className="rounded-lg border p-2.5 text-sm">
                <p>{f.text}</p>
                <blockquote className="mt-1 border-l-2 border-primary pl-2 text-xs">“{f.quote}”</blockquote>
                <Button type="button" size="xs" variant="ghost" className="mt-1 h-auto px-1 py-0.5" disabled={!pg} onClick={() => pg && setPageId(pg.pageId)}>{shortLabel(docById(site, f.docId)?.title ?? f.docId)} · p. {f.page}</Button>
              </li>
            ); })}
          </ul>
        </section>
      )}
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-semibold hover:underline">Files and caveats <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" /></CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2 text-xs">
          <ul className="space-y-1">{site.documents.map((d) => <li key={d.docId}><span className="font-medium">{d.title}</span> · {d.kind}{d.year ? ` · ${d.year}` : ""} · {d.pages} p. · {d.format} · readability {d.readability}</li>)}</ul>
          {site.notes.length > 0 && <ul className="list-disc space-y-1 pl-4">{site.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <p>Position: {site.positionSource} · GDA94 (EPSG:4283)</p>
        </CollapsibleContent>
      </Collapsible>
      <p className="text-xs text-muted-foreground">Source: {site.source.credit} · {site.source.licence} · {site.source.publisher}</p>
      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="max-h-[92dvh] max-w-4xl overflow-y-auto">
          {zoom && (<><DialogTitle>{docById(site, zoom.docId)?.title ?? zoom.docId} · page {zoom.page}</DialogTitle><DialogDescription>{zoom.caption}</DialogDescription>{zoom.img && <img src={zoom.img} alt={`${site.name}: ${zoom.caption}`} className="w-full rounded border bg-white" />}</>)}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-lg border p-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-base font-semibold tabular-nums">{value}</dd>{sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}</div>;
}
function Lineage({ site, f, showBuild, reviewed }: { site: Site; f: SiteField; showBuild: boolean; reviewed?: string }) {
  const doc = docById(site, f.docId);
  const steps: [string, string, string][] = [
    ["Source", `${site.source.publisher} · ${doc?.title ?? f.docId} · p. ${f.page}`, "Catalogue record"],
    ["Read", `${METHOD[f.method]} · ${CONFIDENCE[f.confidence].label.toLowerCase()} confidence`, "Document extraction step: Azure AI Content Understanding, Document Intelligence or a partner (replaceable)"],
    ["Stored", `${site.name} file set · ${site.source.licence}`, "OneLake · Purview label and lineage"],
    ["Linked", [site.name, GROUP_LABEL[f.group] ?? f.group, f.formation].filter(Boolean).join(" › "), "Fabric IQ ontology"],
    ["Checked", reviewed ?? (f.needsReview ? "Waiting for an expert to review" : "No review needed"), "Expert review queue"],
  ];
  return (
    <div className="space-y-1 rounded-md bg-muted/60 p-2">
      <ol className="space-y-0.5" aria-label="Lineage">{steps.map(([k, v, svc]) => <li key={k} className="grid grid-cols-[4.25rem_1fr] gap-1.5"><span className="font-medium">{k}</span><span>{v}{showBuild && <span className="text-muted-foreground"> · {svc}</span>}</span></li>)}</ol>
      {showBuild && <p className="text-muted-foreground">The services named are how it would run in production. In this file, these steps ran before packaging.</p>}
    </div>
  );
}
