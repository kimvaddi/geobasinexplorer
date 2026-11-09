import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { PACK, STATUS_CLS, TAG_CLS } from "@/lib/pack";
import { searchStats } from "@/lib/search";
import { geoCoverageAsync, type GeoCoverage } from "@/lib/geotag";
import { spatialChecks } from "@/lib/validation";
import type { IngestResult } from "@/lib/ingest";
import type { Feedback } from "@/lib/feedback";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

export type SheetTab = "real" | "loading" | "checks" | "sources" | "governance" | "build";
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/* The Planetary Computer overlays' sources (cloud build, where the deployment has them): the licensors' notices, word for
   word, and the Copernicus DEM licence's non-liability sentence, which must accompany any public display (DATA_SOURCES.md). */
const OVERLAY_SOURCES = [
  ["Copernicus DEM GLO-30, Cooper Basin (Planetary Computer overlay)", "Copernicus WorldDEM-30 licence, free and open", "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"],
  ["Sentinel-2 Level-2A imagery, 2025, Cooper Basin (Planetary Computer overlay)", "Copernicus Sentinel data legal notice, free, full and open", "Contains modified Copernicus Sentinel data 2025"],
];
const COPERNICUS_LIABILITY = "The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.";
/* Shown inline in the Data workspace: what's real, how it was loaded and checked, and where it came from. */
export function DataSheet({ tab, setTab, showBuild, appMs, answerMs, added, feedback, overlays = false, onClearFeedback }: { tab: SheetTab; setTab: (t: SheetTab) => void; showBuild: boolean; appMs: number | null; answerMs: number[]; added: IngestResult[]; feedback: Feedback[]; overlays?: boolean; onClearFeedback: () => void }) {
  const [geo, setGeo] = useState<GeoCoverage | null>(null);
  const [geoN, setGeoN] = useState(0);
  useEffect(() => { if (tab !== "loading" || geo) return; return geoCoverageAsync(setGeo, (n) => setGeoN(n)); }, [tab, geo]);
  const checks = useMemo(() => (tab === "checks" ? spatialChecks() : null), [tab]);
  const ss = searchStats(); const med = median(answerMs);
  const live: { group: string; label: string; value: string; how: string }[] = [
    { group: "Measured in this browser", label: "App ready", value: appMs == null ? "not measured" : `${Math.round(appMs)} ms`, how: "From page start to first screen, this session" },
    { group: "Measured in this browser", label: "Search index built", value: `${ss.ms} ms`, how: `${ss.passages} passages, ${ss.terms} distinct words` },
    { group: "Measured in this browser", label: "Answers this session", value: answerMs.length ? `${answerMs.length} · median ${Math.round(med!)} ms · slowest ${Math.round(Math.max(...answerMs))} ms` : "none yet", how: "Time from pressing Ask to a full answer, including images and map places" },
  ];
  const metrics = [...PACK.metrics, ...live];
  const groups = [...new Set(metrics.map((m) => m.group))];
  return (
    <section aria-labelledby="data-sheet-h" className="space-y-2 rounded-xl border bg-card p-4">
        <header className="space-y-1"><h2 id="data-sheet-h" className="text-base font-semibold">Data sheet</h2><p className="text-sm text-muted-foreground">What's real, how it was loaded and checked, and where it came from{showBuild ? ", plus how it maps to Microsoft services" : ""}.</p></header>
        <Tabs value={tab} onValueChange={(v) => setTab(v as SheetTab)}>
          <TabsList className="w-full"><TabsTrigger value="real">What's real</TabsTrigger><TabsTrigger value="loading">Loading</TabsTrigger><TabsTrigger value="checks">Checks</TabsTrigger><TabsTrigger value="sources">Sources</TabsTrigger><TabsTrigger value="governance">Governance</TabsTrigger>{showBuild && <TabsTrigger value="build">How it's built</TabsTrigger>}</TabsList>
          <TabsContent value="real" className="space-y-3 pt-3">
            <p className="text-sm">Everything here is public data, read from it, or worked out from it. Illustrative values in this build: <b>{PACK.realness.filter((r) => r.status === "Illustrative").length}</b>. What we couldn't include is listed too.</p>
            <ul className="flex flex-wrap gap-1.5 text-xs">{(["Real", "Computed", "Extracted", "Illustrative", "Proposed", "Not included"] as const).map((s) => <li key={s} className="flex items-center gap-1"><span className={cn("rounded px-1.5 py-0.5 font-semibold", STATUS_CLS[s])}>{s}</span>{PACK.realness.filter((r) => r.status === s).length}</li>)}</ul>
            <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Status of each item</caption>
              <thead className="bg-muted/60"><tr>{["Item", "Status", "Source", "Note"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
              <tbody>{PACK.realness.map((r) => <tr key={r.item} className="border-t align-top"><td className="px-1.5 py-1 font-medium">{r.item}</td><td className="px-1.5 py-1"><span className={cn("whitespace-nowrap rounded px-1 py-0.5 text-[11px] font-semibold", STATUS_CLS[r.status])}>{r.status}</span></td><td className="px-1.5 py-1">{r.source}</td><td className="px-1.5 py-1">{r.note}</td></tr>)}</tbody></table></div>
            {PACK.removed.length > 0 && <section className="space-y-1"><h3 className="text-sm font-semibold">Not in this build</h3><ul className="list-disc space-y-0.5 pl-5 text-xs">{PACK.removed.map((r) => <li key={r}>{r}</li>)}</ul></section>}
          </TabsContent>
          <TabsContent value="loading" className="space-y-3 pt-3">
            <p className="text-sm">Counts and times measured when this file was built, and a few measured now in your browser. Anything we didn't measure says so.</p>
            {groups.map((g) => (
              <section key={g} className="space-y-1"><h3 className="text-sm font-semibold">{g}</h3>
                <dl className="divide-y rounded-lg border text-xs">{metrics.filter((m) => m.group === g).map((m) => <div key={m.label} className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1"><dt>{m.label}<span className="block text-muted-foreground">{m.how}</span></dt><dd className={cn("text-right font-semibold tabular-nums", m.value === "not measured" && "font-normal text-muted-foreground")}>{m.value}</dd></div>)}</dl>
              </section>
            ))}
            <section className="space-y-1"><h3 className="text-sm font-semibold">Documents you added this session</h3>
              {added.length ? <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Documents added this session</caption>
                <thead className="bg-muted/60"><tr>{["Document", "Pages read", "Need OCR", "Names (linked)", "Places", "Per page", "Total"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
                <tbody>{added.map((d) => { const ocr = d.pages.filter((x) => x.ocr).length; return <tr key={d.docId} className="border-t tabular-nums"><td className="px-1.5 py-1 font-medium">{d.title}</td><td className="px-1.5 py-1">{d.pages.length} of {d.totalPages}</td><td className="px-1.5 py-1">{ocr}</td><td className="px-1.5 py-1">{d.entities.length} ({d.entities.filter((e) => e.nodeId).length})</td><td className="px-1.5 py-1">{d.places.length}</td><td className="px-1.5 py-1">{d.pages.length ? Math.round(d.ms.read / d.pages.length) : 0} ms</td><td className="px-1.5 py-1">{(d.ms.total / 1000).toFixed(1)} s</td></tr>; })}</tbody></table></div>
                : <p className="text-xs text-muted-foreground">None yet. Use Add a document above to read a public PDF and time it.</p>}
            </section>
            <section className="space-y-1" aria-live="polite"><h3 className="text-sm font-semibold">Geotags (measured in this browser)</h3>
              {geo ? (
                <dl className="divide-y rounded-lg border text-xs">
                  {([["Passages with a basin outline", `${geo.withPolygon} of ${geo.passages} (${pct(geo.withPolygon, geo.passages)})`, "Outline from the place named, the document's well or the document's basin"],
                    ["Passages with a point", `${geo.withPoint} of ${geo.passages} (${pct(geo.withPoint, geo.passages)})`, "A named feature, borehole or well, or the document's well"],
                    ["General passages with no place", `${geo.general}`, "Glossary entries and reference lists"],
                    ["Place-specific passages with no place", `${geo.none}`, "Should be zero; anything here needs a fix"],
                    ["Placed by", Object.entries(geo.byMethod).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(" · "), "A passage can have more than one place"],
                    ["Time to tag every passage", `${geo.ms} ms`, "Processing time, in small batches"]] as const).map(([k, v, h]) => <div key={k} className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1"><dt>{k}<span className="block text-muted-foreground">{h}</span></dt><dd className="max-w-[14rem] text-right font-semibold tabular-nums">{v}</dd></div>)}
                </dl>
              ) : <p className="text-xs text-muted-foreground">Measuring… {geoN} of {ss.passages} passages</p>}
            </section>
          </TabsContent>
          <TabsContent value="checks" className="space-y-4 pt-3">
            <p className="text-sm">Spatial checks run in your browser on the data in this file{checks ? ` (${checks.ms} ms)` : ""}. They flag where sources disagree. The report is the primary source unless a note says otherwise.</p>
            {checks && (<>
              <section className="space-y-1"><h3 className="text-sm font-semibold">Wells: report against the map layer</h3>
                <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Well checks</caption>
                  <thead className="bg-muted/60"><tr>{["Well", "Check", "Report", "Map layer", "Result"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody>{checks.wells.map((w, i) => <tr key={i} className="border-t align-top"><td className="px-1.5 py-1 font-medium">{w.well}</td><td className="px-1.5 py-1">{w.check}</td><td className="px-1.5 py-1">{w.document}</td><td className="px-1.5 py-1">{w.layer}</td><td className="px-1.5 py-1"><span className="flex items-start gap-1">{w.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-700" aria-label="Agrees" /> : <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-700" aria-label="Disagrees" />}{w.note}</span></td></tr>)}</tbody></table></div>
              </section>
              <section className="space-y-1"><h3 className="text-sm font-semibold">Borehole layers</h3>
                <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Borehole layer quality</caption>
                  <thead className="bg-muted/60"><tr>{["Basin", "Boreholes", "Inside outline", "No depth", "No year", "Years", "Deepest"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody>{checks.layers.map((l) => <tr key={l.basin} className="border-t tabular-nums"><td className="px-1.5 py-1 font-medium">{l.basin}</td><td className="px-1.5 py-1">{l.total.toLocaleString("en-US")}</td><td className="px-1.5 py-1">{l.inside.toLocaleString("en-US")}</td><td className={cn("px-1.5 py-1", l.noDepth / l.total > 0.2 && "font-semibold text-red-700")}>{l.noDepth.toLocaleString("en-US")} ({pct(l.noDepth, l.total)})</td><td className={cn("px-1.5 py-1", l.noYear / l.total > 0.2 && "font-semibold text-red-700")}>{l.noYear.toLocaleString("en-US")} ({pct(l.noYear, l.total)})</td><td className="px-1.5 py-1">{l.firstYear}–{l.lastYear}</td><td className="px-1.5 py-1">{l.deepest?.toLocaleString("en-US")} m</td></tr>)}</tbody></table></div>
                <p className="text-xs text-muted-foreground">Boreholes with no depth or year drop out when you filter by depth or year on the map. Inside-outline counts use the rounded coordinates stored in this file. With full-precision coordinates the Cooper count is 4,879, the figure in the GA report.</p>
              </section>
              <section className="space-y-1"><h3 className="text-sm font-semibold">Cooper Basin report figures, recomputed from the data</h3>
                <ul className="space-y-1 text-xs">{checks.claims.map((c, i) => <li key={i} className="flex items-start gap-1.5 rounded-md border px-2 py-1">{c.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-700" aria-label="Agrees" /> : <CircleX className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-label="Differs" />}<span><span className="font-medium">{c.claim}</span><span className="block text-muted-foreground">{c.computed}</span></span></li>)}</ul>
              </section>
              <section className="space-y-1"><h3 className="text-sm font-semibold">Coordinate systems</h3>
                <ul className="space-y-0.5 text-xs">{checks.crs.map((c) => <li key={c.crs}>{c.crs}: {c.datasets} dataset{c.datasets === 1 ? "" : "s"}</li>)}</ul>
                <p className="text-xs text-muted-foreground">Legacy reports use older datums (AGD66, AMG grid). Their positions are converted before comparing.</p>
              </section>
              <section className="space-y-1"><h3 className="text-sm font-semibold">Names and labels that disagree · {checks.names.length}</h3>
                <ul className="space-y-1 text-xs">{checks.names.map((n) => <li key={n.title} className="rounded-md border px-2 py-1"><p className="font-medium">{n.title}</p><p>{n.detail}</p><p className="text-muted-foreground">Fix: {n.fix}</p></li>)}</ul>
              </section>
            </>)}
          </TabsContent>
          <TabsContent value="sources" className="space-y-3 pt-3">
            <section className="space-y-1"><h3 className="text-sm font-semibold">Documents</h3><ul className="space-y-1 text-xs">{PACK.docs.map((d) => <li key={d.id} className="rounded-md border px-2 py-1"><span className="font-medium">{d.title}</span> · {d.pages} p. · {d.source} · {d.licence}</li>)}</ul></section>
            <section className="space-y-1"><h3 className="text-sm font-semibold">Datasets and coordinate systems · {PACK.datasets.length}</h3>
              <div className="max-h-80 overflow-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Datasets with coordinate reference systems</caption><thead className="sticky top-0 bg-muted"><tr>{["Basin", "Dataset", "Records", "CRS"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
                <tbody>{PACK.datasets.map((d, i) => <tr key={i} className="border-t align-top"><td className="px-1.5 py-0.5">{d.basin}</td><td className="px-1.5 py-0.5">{d.name}</td><td className="px-1.5 py-0.5 tabular-nums">{d.records ?? "—"}</td><td className="px-1.5 py-0.5">{d.crs}</td></tr>)}</tbody></table></div>
            </section>
            <p className="text-xs">Geology © Commonwealth of Australia (Geoscience Australia), CC BY 4.0. {GATED ? "Retained well reports: Department for Energy and Mining, South Australia (PEPS SA, CC BY 4.0)." : "Well reports: Department for Energy and Mining, South Australia (PEPS SA, CC BY 4.0) and Geological Survey of Queensland open-file reports."} Stress: World Stress Map 2025. Basemap: Natural Earth (public domain).{overlays ? ` Planetary Computer overlays: ${OVERLAY_SOURCES.map((r) => r[2]).join("; ")}. ${COPERNICUS_LIABILITY}` : ""}</p>
          </TabsContent>
          <TabsContent value="governance" className="space-y-4 pt-3">
            <p className="text-sm">Who owns each source, the licence and credit that travel with it, and how the data moves from the published record to this screen. Labels and sync rules are a proposed design.</p>
            <section className="space-y-1"><h3 className="text-sm font-semibold">Lineage, for every item</h3>
              <ol className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4">{[["1 · Published source", "GA catalogue record, GSQ or PEPS SA report, World Stress Map", "Catalogue record"], ["2 · Lake table", "Tables and files built from the sources, with their steps", "Microsoft Fabric OneLake; Azure Data Manager for Energy for wells"], ["3 · Knowledge graph", "Units, plays, flags, wells, core images and their links", "Fabric IQ ontology"], ["4 · This screen", "Map, Knowledge, Images, Ask and Co-Scientist", "Azure Maps or Esri; Foundry IQ; Azure AI Search"]].map(([t, d, prod]) => <li key={t} className="space-y-0.5 rounded-md border bg-muted/30 p-1.5"><p className="font-semibold">{t}</p><p>{d}</p>{showBuild && <p className="text-sky-900 dark:text-sky-200">On Microsoft: {prod}</p>}</li>)}</ol>
              <p className="text-xs text-muted-foreground">Open any item in the Knowledge view and press <span className="font-medium">Where did this come from?</span> to see its own four steps.{showBuild ? " On Microsoft, Microsoft Purview records this lineage and carries the labels." : ""}</p></section>
            <section className="space-y-1"><h3 className="text-sm font-semibold">Licences and credit</h3>
              <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Licences and credit by source</caption>
                <thead className="bg-muted/60"><tr>{["Source", "Licence", "Credit shown", "Proposed label"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
                <tbody>{[...[["Geoscience Australia basin packages, core photography, charts", "CC BY 4.0", "© Commonwealth of Australia (Geoscience Australia)"], ["Innamincka 1 report (GSQ CR000407)", "Open file", "Geological Survey of Queensland"], ["Marabooka 1 report (PEPS SA Env. 4324)", "CC BY 4.0", "Department for Energy and Mining, South Australia"], ["World Stress Map 2025", "CC BY 4.0", "World Stress Map project (GFZ)"], ["Natural Earth basemap", "Public domain", "Natural Earth"]].filter(([name]) => !GATED || !LICENCE.isWithheldSource(name)), ...(overlays ? OVERLAY_SOURCES : [])].map(([a, b, c]) => <tr key={a} className="border-t align-top"><td className="px-1.5 py-1 font-medium">{a}</td><td className="px-1.5 py-1">{b}</td><td className="px-1.5 py-1">{c}</td><td className="px-1.5 py-1"><span className={cn("rounded px-1 py-0.5 text-[11px] font-semibold", STATUS_CLS.Proposed)}>Public</span></td></tr>)}</tbody></table></div>
              <p className="text-xs text-muted-foreground">Credits travel with every answer source and with the Excel export (About sheet). {overlays ? `${COPERNICUS_LIABILITY} ` : ""}{GATED ? "Sources with unconfirmed reuse terms are withheld. Public access alone does not establish a reuse licence." : "No restricted data is in this file, so every proposed label is Public."}</p></section>
            <section className="space-y-1"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Learning from your feedback · {feedback.length}</h3>{feedback.length > 0 && <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={onClearFeedback}>Clear feedback</button>}</div>
              {feedback.length ? <ul className="space-y-1 text-xs">{feedback.slice(0, 20).map((f) => <li key={f.id} className="rounded-md border px-2 py-1"><span className="font-medium">{f.at}{f.by ? ` · ${f.by}` : ""}.</span> {f.vote === "up" ? "Useful" : `Not useful: ${f.reason.toLowerCase()}`} on “{f.q}”. <span className="text-muted-foreground">{f.effect}</span></li>)}</ul>
                : <p className="text-xs text-muted-foreground">No feedback yet. Use the thumbs on any answer. Up raises its sources for similar questions; down with “Wrong source” lowers them. Ask again to see the change.</p>}
            </section>
            <section className="space-y-1"><h3 className="text-sm font-semibold">Learning log: what we changed after testing</h3>
              <ul className="space-y-1 text-xs">{PACK.learning.map((l) => <li key={l.date + l.change} className="rounded-md border px-2 py-1"><span className="font-medium">{l.date}.</span> {l.trigger}. <span className="font-medium">Change:</span> {l.change}. <span className="text-muted-foreground">{l.effect}.</span></li>)}</ul>
              <p className="text-xs text-muted-foreground">{PACK.learningNote}{showBuild ? " On Microsoft: Foundry evaluations feeding prompt and tool updates (Custom)." : ""}</p></section>
          </TabsContent>
          {showBuild && (
            <TabsContent value="build" className="space-y-3 pt-3">
              <p className="text-sm">How each part would run on Microsoft, and how much is product versus build work. Reading scanned documents is a step you can swap: a Microsoft service or a partner can do it.</p>
              <ul className="flex flex-wrap gap-1.5 text-xs">{(["Out of the box", "Configured", "Custom", "Research"] as const).map((t) => <li key={t}><span className={cn("rounded px-1.5 py-0.5 font-semibold", TAG_CLS[t])}>{t}</span></li>)}</ul>
              <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Capability mapping</caption>
                <thead className="bg-muted/60"><tr>{["Capability", "In this file", "Service", "Tag"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left">{h}</th>)}</tr></thead>
                <tbody>{PACK.mapping.map((m, i) => <tr key={i} className="border-t align-top"><td className="px-1.5 py-1 font-medium">{m.capability}</td><td className="px-1.5 py-1">{m.inFile}</td><td className="px-1.5 py-1">{m.service}{m.partner ? <span className="block text-muted-foreground">Partner option: {m.partner}</span> : null}</td><td className="px-1.5 py-1"><span className={cn("whitespace-nowrap rounded px-1 py-0.5 text-[11px] font-semibold", TAG_CLS[m.tag])}>{m.tag}</span></td></tr>)}</tbody></table></div>
            </TabsContent>
          )}
        </Tabs>
    </section>
  );
}
