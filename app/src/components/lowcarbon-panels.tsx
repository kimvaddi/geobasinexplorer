import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, FileText, Maximize2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { safeUrl } from "@/lib/safe-url";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/basins";
import {
  SITES, OZTEMP, CONFIDENCE, OCR_LABEL, STATUS, STAGES, ASKS, KO_STATUS, knockouts, screen, imgUrl, docById, fieldValue, fieldSI, findingById, fieldById,
  type Site, type SiteField, type SitePage, type Curve, type Fit,
} from "@/lib/lowcarbon";

/* Evidence, screening and "how it's built" panels for the low-carbon lens. */

const FIT_CLS: Record<Fit, string> = {
  "Out of the box": "border-emerald-700 text-emerald-800 dark:text-emerald-300",
  Configure: "border-sky-700 text-sky-800 dark:text-sky-300",
  Custom: "border-amber-600 text-amber-800 dark:text-amber-300",
};
export function BuildChips({ stage }: { stage: string }) {
  const st = STAGES.find((s) => s.id === stage);
  if (!st) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-2 text-xs" aria-label={`How it's built: ${st.step}`}>
      <span className="font-semibold">How it's built · {st.step}:</span>
      {st.microsoft.map((m) => <Badge key={m.name} variant="outline" className={FIT_CLS[m.fit]}>{m.name}</Badge>)}
      {st.partners.slice(0, 2).map((p) => <Badge key={p} variant="outline">{p}</Badge>)}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}{sub && <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span>}</dd>
    </div>
  );
}
const pageFor = (s: Site, f: { docId: string; page: number; pageId?: string }) =>
  s.pages.find((p) => p.pageId === f.pageId) ?? s.pages.find((p) => p.docId === f.docId && p.page === f.page) ?? null;

const CO2_ORDER = ["geomechanics", "pressure", "reservoir", "fluid", "seal", "integrity", "depth", "temperature", "identity"];
const GEO_ORDER = ["temperature", "pressure", "integrity", "depth", "reservoir", "fluid", "seal", "geomechanics", "identity"];
const GROUP_LABEL: Record<string, string> = { geomechanics: "Rock stress", pressure: "Pressure", reservoir: "Reservoir", fluid: "Water", seal: "Seal", integrity: "Well integrity", depth: "Depth", temperature: "Temperature", identity: "Well" };
const shortLabel = (t: string) => { const c = t.split(/\s[(;]|;|\s[-–]\s/)[0].trim(); return c.length > 70 ? `${c.slice(0, 68)}…` : c; };

/* ---------------- Evidence ---------------- */
export function EvidencePanel(props: {
  site: Site; showBuild: boolean; focusField: string | null;
  onReview: (s: Site, f: SiteField, decision: "approved" | "corrected", corrected?: string) => void;
  canReview: boolean; reviewed: Record<string, string>; reviewing: boolean;
}) {
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
    const p = pageFor(site, f); if (p) setPageId(p.pageId);
    setFilter("all");
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-field="${CSS.escape(focusField)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [focusField, site]);
  const page = site.pages.find((p) => p.pageId === pageId) ?? site.pages[0] ?? null;
  const st = site.stats;
  const ordered = useMemo(() => {
    const pri = site.kind === "geo" ? GEO_ORDER : CO2_ORDER;
    return [...site.fields].sort((a, b) => pri.indexOf(a.group) - pri.indexOf(b.group));
  }, [site]);
  const fields = filter === "review" ? ordered.filter((f) => f.needsReview) : ordered;
  const doc = page ? docById(site, page.docId) : null;
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{site.name}</h2>
        <p className="text-sm">{site.role}</p>
        <p className="text-xs text-muted-foreground">
          {[site.operator, site.spudYear && `drilled ${site.spudYear}`, site.totalDepthM && `TD ${fmt(site.totalDepthM)} m`].filter(Boolean).join(" · ")}
        </p>
      </header>
      {props.showBuild && <BuildChips stage="read" />}
      <dl data-tour="stats" className="grid grid-cols-2 gap-2 text-sm">
        <Stat label="Files in the package" value={fmt(st.docsInPackage)} sub={`${st.docsSampled} opened`} />
        <Stat label="Pages read" value={fmt(st.pagesSampled)} sub={`${st.pagesReadable} readable`} />
        <Stat label="Values extracted" value={fmt(st.fieldsTotal)} sub={`${st.fieldsNeedReview} to review`} />
        {st.ocrCompared > 0
          ? <Stat label="Government OCR had right" value={`${st.ocrMatch} of ${st.ocrCompared}`} sub={st.ocrMissing ? `${st.ocrMissing} not in its text at all` : "checked values"} />
          : <Stat label="Statements cited" value={fmt(site.findings.length)} sub="with page and quote" />}
      </dl>

      {page && (
        <section data-tour="pages" aria-labelledby="pg-h" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="pg-h" className="text-sm font-semibold">Source pages</h3>
            <span className="text-xs text-muted-foreground">{site.pages.length} shown</span>
          </div>
          <PageImage site={site} page={page} onZoom={() => setZoom(page)} />
          <p className="text-xs"><span className="font-medium">{shortLabel(doc?.title ?? page.docId)}</span> · p. {page.page} · {page.caption} · readability {page.readability}</p>
          {site.pages.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Source pages">
              {site.pages.map((p) => {
                const url = imgUrl(site.siteId, p.file);
                return (
                  <button key={p.pageId} type="button" aria-pressed={p.pageId === page.pageId} aria-label={`${docById(site, p.docId)?.title ?? p.docId}, page ${p.page}: ${p.caption}`} onClick={() => setPageId(p.pageId)}
                    className={cn("h-16 w-12 shrink-0 overflow-hidden rounded border bg-muted focus-visible:outline-2 focus-visible:outline-ring", p.pageId === page.pageId && "ring-2 ring-primary")}>
                    {url && <img src={url} alt="" className="size-full object-cover object-top" />}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="val-h" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="val-h" className="text-sm font-semibold">Values read · {site.fields.length}</h3>
          <div className="flex gap-1" role="group" aria-label="Filter values">
            <Button type="button" size="xs" variant={filter === "all" ? "secondary" : "ghost"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</Button>
            <Button type="button" size="xs" variant={filter === "review" ? "secondary" : "ghost"} aria-pressed={filter === "review"} onClick={() => setFilter("review")}>Needs review · {st.fieldsNeedReview}</Button>
          </div>
        </div>
        <ul ref={listRef} className="space-y-2">
          {fields.map((f) => {
            const si = fieldSI(f); const pg = pageFor(site, f); const done = props.reviewed[`${site.siteId}:${f.fieldId}`];
            return (
              <li key={f.fieldId} data-field={f.fieldId} className={cn("rounded-lg border p-2.5 text-sm", focusField === f.fieldId && "ring-2 ring-ring")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-medium"><span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{GROUP_LABEL[f.group] ?? f.group}</span>{f.label}</p>
                  <Badge className={cn("shrink-0", CONFIDENCE[f.confidence].cls)}>{CONFIDENCE[f.confidence].label}</Badge>
                </div>
                <p className="mt-0.5 tabular-nums"><span className="font-semibold">{fieldValue(f)}</span>{si && <span className="text-muted-foreground"> · {si}</span>}</p>
                <p className="text-xs text-muted-foreground">
                  {[f.formation, f.depthM != null && `${fmt(f.depthM)} m${f.depthRef && !/not stated/i.test(f.depthRef) ? ` ${f.depthRef}` : ""}`, f.method === "computed" ? `computed: ${f.conversion ?? ""}` : f.conversion].filter(Boolean).join(" · ")}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Button type="button" size="xs" variant="secondary" className="h-auto max-w-full whitespace-normal py-1 text-left" disabled={!pg} onClick={() => pg && setPageId(pg.pageId)} aria-label={`Show ${docById(site, f.docId)?.title ?? f.docId} page ${f.page}`}>
                    <FileText aria-hidden="true" /> {shortLabel(docById(site, f.docId)?.title ?? f.docId)} · p. {f.page}
                  </Button>
                  {f.ocrBaseline && <Badge variant="outline" className={OCR_LABEL[f.ocrBaseline.status].cls}>{OCR_LABEL[f.ocrBaseline.status].label}</Badge>}
                </div>
                <Collapsible>
                  <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 text-xs font-medium hover:underline">
                    Where did this come from? <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-1 space-y-1.5 text-xs">
                    <blockquote className="border-l-2 border-primary pl-2">“{f.quote}”</blockquote>
                    <p>Confidence: {f.confidenceWhy}</p>
                    {f.ocrBaseline?.text && <p>Government OCR at this spot: “{f.ocrBaseline.text}”</p>}
                    <Lineage site={site} f={f} showBuild={props.showBuild} reviewed={done} />
                  </CollapsibleContent>
                </Collapsible>
                {f.needsReview && (
                  <div className="mt-2 border-t pt-2">
                    {done ? (
                      <p className="flex items-center gap-1 text-xs font-medium"><Check className="size-3.5" aria-hidden="true" /> {done} · saved to the notebook</p>
                    ) : editing === f.fieldId ? (
                      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { props.onReview(site, f, "corrected", draft.trim()); setEditing(null); setDraft(""); } }}>
                        <label htmlFor={`fix-${f.fieldId}`} className="sr-only">Corrected value for {f.label}</label>
                        <Input id={`fix-${f.fieldId}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={fieldValue(f)} className="h-7 text-xs" maxLength={120} />
                        <Button type="submit" size="xs" disabled={!draft.trim() || props.reviewing}>Save</Button>
                        <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        <Button type="button" size="xs" variant="outline" disabled={!props.canReview || props.reviewing} onClick={() => props.onReview(site, f, "approved")}><Check aria-hidden="true" /> Approve</Button>
                        <Button type="button" size="xs" variant="outline" disabled={!props.canReview || props.reviewing} onClick={() => { setEditing(f.fieldId); setDraft(""); }}><PencilLine aria-hidden="true" /> Correct</Button>
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
            {site.findings.map((f) => {
              const pg = pageFor(site, f);
              return (
                <li key={f.findingId} className="rounded-lg border p-2.5 text-sm">
                  <p>{f.text}</p>
                  <blockquote className="mt-1 border-l-2 border-primary pl-2 text-xs">“{f.quote}”</blockquote>
                  <Button type="button" size="xs" variant="ghost" className="mt-1 h-auto px-1 py-0.5" disabled={!pg} onClick={() => pg && setPageId(pg.pageId)}>
                    {docById(site, f.docId)?.title ?? f.docId} · p. {f.page}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-semibold hover:underline">
          Files and caveats <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2 text-xs">
          <ul className="space-y-1">
            {site.documents.map((d) => <li key={d.docId}><span className="font-medium">{d.title}</span> · {d.kind}{d.year ? ` · ${d.year}` : ""} · {d.pages} p. · {d.format} · readability {d.readability}</li>)}
          </ul>
          {site.notes.length > 0 && <ul className="list-disc space-y-1 pl-4">{site.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <p>Position: {site.positionSource}</p>
        </CollapsibleContent>
      </Collapsible>
      <p className="text-xs text-muted-foreground">
        Source: {site.source.credit} · {site.source.licence} ·{" "}
        <a className="underline underline-offset-2" href={safeUrl(site.source.url)} target="_blank" rel="noreferrer">{site.source.publisher}<ExternalLink className="ml-0.5 inline size-3" aria-hidden="true" /></a>
      </p>

      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
          {zoom && (
            <>
              <DialogTitle>{docById(site, zoom.docId)?.title ?? zoom.docId} · page {zoom.page}</DialogTitle>
              <DialogDescription>{zoom.caption}</DialogDescription>
              {imgUrl(site.siteId, zoom.file) && <img src={imgUrl(site.siteId, zoom.file)!} alt={`${site.name}: ${zoom.caption}`} className="w-full rounded border bg-white" />}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const METHOD: Record<SiteField["method"], string> = { "text-layer": "Read from the PDF text layer", "vision-read": "Read from the page image", computed: "Computed from values read on the page" };
function Lineage({ site, f, showBuild, reviewed }: { site: Site; f: SiteField; showBuild: boolean; reviewed?: string }) {
  const doc = docById(site, f.docId);
  const steps: [string, string, string][] = [
    ["Source", `${site.source.publisher} · ${doc?.title ?? f.docId} · p. ${f.page}`, "Catalogue record"],
    ["Read", `${METHOD[f.method]} · ${CONFIDENCE[f.confidence].label.toLowerCase()} confidence`, "Azure AI Content Understanding"],
    ["Stored", `${site.name} file set · ${site.source.licence}`, "OneLake · Purview label and lineage"],
    ["Linked", [site.name, f.group.replace(/^\w/, (c) => c.toUpperCase()), f.formation].filter(Boolean).join(" → "), "Fabric IQ ontology"],
    ["Checked", reviewed ?? (f.needsReview ? "Waiting for a person to review" : "No review needed"), "Review queue · notebook workbook"],
  ];
  return (
    <div className="space-y-1 rounded-md bg-muted/60 p-2">
      <ol className="space-y-0.5" aria-label="Lineage">
        {steps.map(([k, v, svc]) => (
          <li key={k} className="grid grid-cols-[4.25rem_1fr] gap-1.5">
            <span className="font-medium">{k}</span>
            <span>{v}{showBuild && <span className="text-muted-foreground"> · {svc}</span>}</span>
          </li>
        ))}
      </ol>
      {showBuild && <p className="text-muted-foreground">Services named after each step are the production design; this demo ran those steps before publishing.</p>}
    </div>
  );
}

function PageImage({ site, page, onZoom }: { site: Site; page: SitePage; onZoom: () => void }) {
  const url = imgUrl(site.siteId, page.file);
  if (!url) return <p className="rounded-lg border p-3 text-sm">Image not included for this page.</p>;
  return (
    <button type="button" onClick={onZoom} className="group relative block w-full overflow-hidden rounded-lg border bg-white focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Enlarge ${page.caption}`}>
      <img src={url} alt={`${site.name}: ${page.caption}`} className="max-h-80 w-full object-contain" />
      <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-md bg-black/60 text-white"><Maximize2 className="size-4" aria-hidden="true" /></span>
    </button>
  );
}

/* ---------------- Screening ---------------- */
export function ScreeningPanel(props: {
  site: Site | null; lens: "co2" | "geo"; onLens: (l: "co2" | "geo") => void; onSelectSite: (id: string) => void;
  onOpenField: (siteId: string, fieldId: string) => void; showBuild: boolean;
}) {
  const { site, lens } = props;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{site ? site.name : "All evidence wells"}</h2>
        <div className="flex rounded-lg border p-0.5" role="group" aria-label="Screening lens">
          {(["co2", "geo"] as const).map((l) => (
            <Button key={l} type="button" size="xs" variant={lens === l ? "default" : "ghost"} aria-pressed={lens === l} onClick={() => props.onLens(l)}>{l === "co2" ? "CO₂ storage" : "Geothermal"}</Button>
          ))}
        </div>
      </div>
      {props.showBuild && <BuildChips stage="reason" />}
      {site ? <SiteScreen site={site} lens={lens} onOpenField={props.onOpenField} /> : <Matrix lens={lens} onSelectSite={props.onSelectSite} />}
      <p className="text-xs text-muted-foreground">Example rule set from public sources (IPCC, US EPA Class VI, US EIA). Your own screening rules replace it.</p>
    </div>
  );
}

function Matrix({ lens, onSelectSite }: { lens: "co2" | "geo"; onSelectSite: (id: string) => void }) {
  const sites = SITES.filter((s) => s.lenses.includes(lens));
  const ids = lens === "co2" ? ["depth", "pressure", "usdw", "quality"] : ["power", "gradient", "regional"];
  const heads = lens === "co2" ? ["Depth", "Pressure", "Water", "Quality"] : ["Power temp.", "Gradient", "5 km"];
  return (
    <div data-tour="screen" className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{lens === "co2" ? "CO₂ storage" : "Geothermal"} screening for each evidence well</caption>
        <thead><tr className="border-b"><th scope="col" className="py-2 pr-2 text-xs font-semibold">Well</th>{heads.map((h) => <th key={h} scope="col" className="py-2 pr-2 text-xs font-semibold">{h}</th>)}</tr></thead>
        <tbody>
          {sites.map((s) => {
            const rows = screen(s, lens);
            return (
              <tr key={s.siteId} className="border-b last:border-0">
                <th scope="row" className="py-2 pr-2 font-medium">
                  <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onSelectSite(s.siteId)}>{s.name}</button>
                  <span className="block text-xs font-normal text-muted-foreground">{s.tag}</span>
                </th>
                {ids.map((id) => { const r = rows.find((x) => x.id === id); return <td key={id} className="py-2 pr-2 align-top">{r && <Badge className={cn("whitespace-normal text-left", STATUS[r.status].cls)}>{r.status === "info" && r.short ? r.short : STATUS[r.status].label}</Badge>}</td>; })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SiteScreen({ site, lens, onOpenField }: { site: Site; lens: "co2" | "geo"; onOpenField: (siteId: string, fieldId: string) => void }) {
  const rows = useMemo(() => screen(site, lens), [site, lens]);
  const curve = lens === "geo" ? site.curves?.find((c) => /temp/i.test(c.label) || /°C/.test(c.unit)) : undefined;
  return (
    <div className="space-y-3">
      {curve && <TempProfile curve={curve} site={site} />}
      <ol data-tour="screen" className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg border p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold">{r.rule.title}</h3>
              <Badge className={cn("shrink-0", STATUS[r.status].cls)}>{STATUS[r.status].label}</Badge>
            </div>
            <p className="mt-1 tabular-nums">{r.value}</p>
            {r.detail && <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>}
            <p className="mt-1.5 text-xs">
              <span className="font-medium">Rule:</span> {r.rule.text}{" "}
              {r.rule.url ? <a href={safeUrl(r.rule.url)} target="_blank" rel="noreferrer" className="underline underline-offset-2">{r.rule.source}</a> : <span className="text-muted-foreground">({r.rule.source})</span>}
            </p>
            {(r.fieldIds.length > 0 || r.findingIds.length > 0) && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {[...new Set(r.fieldIds)].map((id) => { const f = fieldById(site, id); return f && <Button key={id} type="button" size="xs" variant="secondary" className="h-auto max-w-full whitespace-normal py-1 text-left" onClick={() => onOpenField(site.siteId, id)}>{shortLabel(f.label)} · p. {f.page}</Button>; })}
                {[...new Set(r.findingIds)].map((id) => { const f = findingById(site, id); return f && <Badge key={id} variant="outline" className="whitespace-normal text-left">{shortLabel(docById(site, f.docId)?.title ?? f.docId)} · p. {f.page}</Badge>; })}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function interp(points: [number, number][], d: number): number | null {
  for (let i = 1; i < points.length; i++) {
    const [d0, v0] = points[i - 1], [d1, v1] = points[i];
    if (d >= d0 && d <= d1 && d1 > d0) return v0 + ((v1 - v0) * (d - d0)) / (d1 - d0);
  }
  return null;
}
const niceStep = (span: number, steps: number[]) => steps.find((st) => span / st <= 6) ?? steps[steps.length - 1];
export function TempProfile({ curve, site }: { curve: Curve; site: Site }) {
  const pts = curve.points;
  const ds = pts.map((p) => p[0]), ts = pts.map((p) => p[1]);
  const minD = Math.min(...ds), maxD = Math.max(...ds), minT = Math.min(...ts), maxT = Math.max(...ts);
  const hot = 149;
  const dStep = niceStep(maxD - Math.min(minD, maxD - 1), [50, 100, 250, 500, 1000]);
  const d0 = maxD - minD < 1200 ? Math.floor(minD / dStep) * dStep : 0; const d1 = Math.ceil(maxD / dStep) * dStep;
  const t0 = Math.max(0, Math.floor((Math.min(minT, hot) - 10) / 25) * 25); const t1 = Math.ceil((Math.max(maxT, hot) + 5) / 25) * 25;
  const tStep = t1 - t0 > 150 ? 50 : 25;
  const W = 380, H = 230, L = 44, R = 12, Tp = 14, B = 30;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R); const y = (d: number) => Tp + ((d - d0) / (d1 - d0)) * (H - Tp - B);
  const path = pts.map(([d, t], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(d).toFixed(1)}`).join(" ");
  const dTicks = Array.from({ length: Math.round((d1 - d0) / dStep) + 1 }, (_, i) => d0 + i * dStep);
  const tTicks = Array.from({ length: Math.round((t1 - t0) / tStep) + 1 }, (_, i) => t0 + i * tStep);
  const rows = dTicks.filter((d) => d >= minD && d <= maxD).map((d) => [d, interp(pts, d)] as const).filter(([, t]) => t != null);
  const tableRows = rows.length >= 2 ? rows : ([[minD, pts[0][1]], [maxD, pts[pts.length - 1][1]]] as const);
  return (
    <figure data-tour="temp" className="space-y-2 rounded-lg border p-3">
      <figcaption className="text-sm font-semibold">{site.name} · {curve.label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-labelledby={`tp-t-${curve.curveId} tp-d-${curve.curveId}`}>
        <title id={`tp-t-${curve.curveId}`}>{`${site.name} temperature against depth`}</title>
        <desc id={`tp-d-${curve.curveId}`}>{`Temperature rises from ${fmt(pts[0][1])} °C at ${fmt(pts[0][0])} m to ${fmt(maxT)} °C; the record ends at ${fmt(maxD)} m.`}</desc>
        <rect x={x(hot)} y={Tp} width={Math.max(0, x(t1) - x(hot))} height={H - Tp - B} className="fill-orange-500/10" />
        <line x1={x(hot)} x2={x(hot)} y1={Tp} y2={H - B} className="stroke-orange-600" strokeDasharray="4 3" />
        <text x={x(hot) + 3} y={Tp + 10} className="fill-foreground text-[10px]">149 °C power threshold</text>
        {tTicks.map((t) => (
          <g key={t}><line x1={x(t)} x2={x(t)} y1={H - B} y2={H - B + 4} className="stroke-muted-foreground" /><text x={x(t)} y={H - B + 14} textAnchor="middle" className="fill-foreground text-[10px]">{t}</text></g>
        ))}
        {dTicks.map((d) => (
          <g key={d}><line x1={L - 4} x2={W - R} y1={y(d)} y2={y(d)} className="stroke-border" /><text x={L - 6} y={y(d) + 3} textAnchor="end" className="fill-foreground text-[10px]">{fmt(d)}</text></g>
        ))}
        <text x={(L + W - R) / 2} y={H - 3} textAnchor="middle" className="fill-foreground text-[10px]">Temperature (°C)</text>
        <text x={10} y={H / 2} textAnchor="middle" transform={`rotate(-90 10 ${H / 2})`} className="fill-foreground text-[10px]">Depth (m)</text>
        <path d={path} fill="none" className="stroke-orange-600" strokeWidth={2.2} />
      </svg>
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Temperature at depth from the record</caption>
        <thead><tr className="border-b"><th scope="col" className="py-1 pr-2 font-semibold">Depth</th><th scope="col" className="py-1 font-semibold">Temperature</th></tr></thead>
        <tbody>{tableRows.map(([d, t]) => <tr key={d} className="border-b last:border-0"><th scope="row" className="py-1 pr-2 font-medium tabular-nums">{fmt(d)} m</th><td className="py-1 tabular-nums">{fmt(t as number, 1)} °C</td></tr>)}</tbody>
      </table>
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium hover:underline">
          About this record <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 text-xs text-muted-foreground">{curve.note}</CollapsibleContent>
      </Collapsible>
    </figure>
  );
}

/* ---------------- How it's built ---------------- */
export function BuildPanel({ section, showBuild, onShowBuild }: { section: "stages" | "knockouts" | null; showBuild: boolean; onShowBuild: (v: boolean) => void }) {
  const kos = useMemo(() => knockouts(), []);
  const koRef = useRef<HTMLElement>(null);
  useEffect(() => { if (section === "knockouts") koRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [section]);
  return (
    <div className="space-y-6">
      <section data-tour="stages" aria-labelledby="st-h" className="space-y-2">
        <h2 id="st-h" className="text-lg font-semibold">From this demo to a working application</h2>
        <div className="flex items-center gap-2 rounded-lg border p-2">
          <Switch id="build-switch" checked={showBuild} onCheckedChange={onShowBuild} />
          <Label htmlFor="build-switch" className="text-sm">Show services and partners</Label>
        </div>
        {showBuild && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {(Object.keys(FIT_CLS) as Fit[]).map((f) => <Badge key={f} variant="outline" className={FIT_CLS[f]}>{f}</Badge>)}
          </div>
        )}
        <ol className="space-y-2">
          {STAGES.map((s, i) => (
            <li key={s.id} className="rounded-lg border p-3">
              <div className="flex items-start gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-white">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                  <p><span className="font-semibold">{s.step}</span> · {s.capability}</p>
                  {showBuild && (
                    <>
                      <div className="flex flex-wrap gap-1.5">{s.microsoft.map((m) => <Badge key={m.name} variant="outline" className={cn("whitespace-normal text-left", FIT_CLS[m.fit])}>{m.name} · {m.fit}</Badge>)}</div>
                      {s.partners.length > 0 && <p className="text-xs"><span className="font-medium">Partner options:</span> {s.partners.join(" · ")}</p>}
                    </>
                  )}
                  <p className="text-xs"><span className="font-medium">Custom work:</span> {s.custom}</p>
                  <p className="text-xs text-muted-foreground"><span className="font-medium">In this app:</span> {s.inApp}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section ref={koRef} data-tour="knockouts" aria-labelledby="ko-h" className="scroll-mt-4 space-y-2">
        <h2 id="ko-h" className="text-lg font-semibold">Knockout tests on the public sample</h2>
        <ul className="space-y-2">
          {kos.map((k) => (
            <li key={k.id} className="rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{k.test}</h3><Badge className={cn("shrink-0", KO_STATUS[k.status].cls)}>{KO_STATUS[k.status].label}</Badge></div>
              <p className="mt-1">{k.result}</p>
              <p className="mt-1 text-xs text-muted-foreground">Next: {k.next}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ask-h" className="space-y-2">
        <h2 id="ask-h" className="text-lg font-semibold">To run this on your documents</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">{ASKS.map((a) => <li key={a}>{a}</li>)}</ol>
      </section>
      <p className="text-xs text-muted-foreground">Temperature layer: {OZTEMP.credit}.</p>
    </div>
  );
}
