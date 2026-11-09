import { useRef, useState } from "react";
import { CircleAlert, CircleCheck, FileUp, FlaskConical, MapPin, Network, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ingestPdf, loadBytes, type IngestResult } from "@/lib/ingest";
import { CLOUD, cloud, type JobStatus } from "@/lib/cloud";
import type { KG } from "@/lib/kg";
import { BuildChip } from "@/components/panels/common";
import { LICENCE } from "@/lib/licensed-data";
/* An optional sample: put one public PDF that you may redistribute in src/assets/sample/ and the dialog offers it. */
const SAMPLES = import.meta.glob("../../assets/sample/*.pdf", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const [samplePath, sampleUrl] = Object.entries(SAMPLES)[0] ?? [];
export const SAMPLE = samplePath ? { name: samplePath.split("/").pop() ?? "sample.pdf", credit: "the public sample document bundled with this build" } : null;
const CONF_CLS = { high: "bg-emerald-100 text-emerald-900", medium: "bg-amber-100 text-amber-950", low: "bg-muted text-foreground" } as const;

export function IngestDialog(p: {
  open: boolean; onOpenChange: (o: boolean) => void; g: KG; showBuild: boolean; done: IngestResult[];
  onDone: (r: IngestResult) => void; onAsk: (q: string) => void; onShowPlace: (lon: number, lat: number, label: string) => void; onOpenEntity: (id: string) => void;
  onPropose: (name: string, doc: string, decision: "Accepted" | "Rejected") => void;
  /* Cloud build only: false while uploads are refused (AI kill switch, or malware scanning paused). */
  uploadsOpen?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<IngestResult | null>(null);
  const [decided, setDecided] = useState<Record<string, "Accepted" | "Rejected">>({});
  const [job, setJob] = useState<JobStatus | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /* Cloud: upload to quarantine, then follow the job through the malware scan, OCR, extraction and indexing. */
  const runCloud = async (file: File) => {
    if (LICENCE.isWithheldDocument(file.name) || LICENCE.isWithheldAsset(file.name)) { setErr("This source is withheld until its reuse terms are confirmed."); return; }
    setErr(null); setRes(null); setDecided({}); setJob(null); setBusy("Uploading to quarantine");
    try {
      const { jobId } = await cloud.upload(file);
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 3000));
        const j = await cloud.job(jobId); setJob(j);
        if (j.status === "done" && j.result && LICENCE.isWithheldIngestResult(j.result)) { setErr("This evidence is withheld until its reuse terms are confirmed."); setJob(null); break; }
        if (j.status === "done" && j.result) { setRes(j.result); p.onDone(j.result); break; }
        if (j.status === "rejected" || j.status === "failed") { setErr(j.detail); break; }
        setBusy(j.detail || j.status);
        if (Date.now() - t0 > 25 * 60_000) { setErr("Still processing after 25 minutes. Check back later; the job keeps running."); break; }
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "The upload could not be completed."); }
    finally { setBusy(null); }
  };
  const run = async (bytes: Uint8Array, name: string) => {
    if (CLOUD) { await runCloud(new File([bytes as BlobPart], name, { type: "application/pdf" })); return; }
    setErr(null); setRes(null); setDecided({}); setBusy("Opening the file");
    try { const r = await ingestPdf(bytes, name, p.g, setBusy); setRes(r); p.onDone(r); }
    catch (e) { setErr(`This file could not be read as a PDF${e instanceof Error && e.message ? ` (${e.message.slice(0, 120)})` : ""}. Try another public PDF.`); }
    finally { setBusy(null); }
  };
  const onFile = async (f: File | undefined) => { if (!f) return;
    if (CLOUD) { if (!/\.(pdf|png|jpe?g|tiff?)$/i.test(f.name)) { setErr("Choose a PDF, PNG, JPEG or TIFF file."); return; } if (f.size > 50 * 1024 * 1024) { setErr("That file is over 50 MB. Try a smaller public document."); return; } await runCloud(f); return; }
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { setErr("Choose a PDF file."); return; } if (f.size > 60e6) { setErr("That file is over 60 MB. Try a smaller public PDF."); return; } await run(new Uint8Array(await f.arrayBuffer()), f.name); };
  const already = p.done.length;
  const textPages = res ? res.pages.filter((x) => !x.ocr).length : 0;
  const linked = res ? res.entities.filter((e) => e.nodeId) : [];
  const topEnt = res?.entities.find((e) => e.type === "Formation or unit" && e.confidence === "high") ?? res?.entities.find((e) => e.type !== "Well") ?? res?.entities[0];
  return (
    <Dialog open={p.open} onOpenChange={(o) => { if (!busy) p.onOpenChange(o); }}>
      <DialogContent className="max-h-[94dvh] max-w-3xl overflow-y-auto">
        <DialogTitle>Add a document</DialogTitle>
        <DialogDescription>{CLOUD ? "Upload a public PDF or image. Microsoft Defender scans it before anything reads it; Azure Document Intelligence then reads every page, scanned ones included. The passages join your own library, which only you can see." : "Drop in a public PDF and watch it get read, tagged and placed on the map. It joins search and the knowledge graph for this session. The file never leaves this browser."}</DialogDescription>
        {p.showBuild && <BuildChip cap="Document extraction" />}
        {CLOUD && p.uploadsOpen === false && !res && !busy && (
          <p role="status" className="rounded-lg border border-amber-600 bg-amber-50 p-2 text-sm text-amber-950">Adding documents is paused while malware scanning is switched off during the build-out. Nothing uploaded now could be checked, so nothing is accepted. Documents already in your library are unaffected.</p>
        )}
        {!res && !busy && !(CLOUD && p.uploadsOpen === false) && (
          <div className="space-y-3">
            <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files?.[0]); }}
              className="grid place-items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center text-sm">
              <FileUp className="size-8 text-muted-foreground" aria-hidden="true" />
              <p>Drag a PDF here, or</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" size="sm" onClick={() => input.current?.click()}><Upload aria-hidden="true" /> Choose a PDF</Button>
                {SAMPLE && sampleUrl && <Button type="button" size="sm" variant="secondary" onClick={async () => run(await loadBytes(sampleUrl), SAMPLE.name)}><FlaskConical aria-hidden="true" /> Try the sample report</Button>}
              </div>
              <input ref={input} type="file" accept={CLOUD ? "application/pdf,.pdf,image/png,image/jpeg,image/tiff" : "application/pdf,.pdf"} className="sr-only" aria-label={CLOUD ? "Choose a PDF or image" : "Choose a PDF"} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              {SAMPLE && <p className="max-w-md text-xs text-muted-foreground">Sample: {SAMPLE.credit}.</p>}
            </div>
            <p className="text-xs text-muted-foreground">{CLOUD ? "Public documents only, up to 50 MB and 300 pages. Uploads are limited each day to keep the prototype within its budget. " : "Public documents only. Reading works on PDFs with a text layer. Scanned pages with no text are flagged: in production an OCR service reads them. "}{already ? `Added this session: ${already}.` : ""}</p>
          </div>
        )}
        {busy && <p role="status" className="rounded-lg border p-3 text-sm">{busy}…</p>}
        {err && <p role="alert" className="rounded-lg border border-red-700 bg-red-50 p-2 text-sm text-red-900">{err}</p>}
        {res && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {([["Pages read", `${res.pages.length} of ${res.totalPages}`], ["With text", String(textPages)], ["Need OCR", String(res.pages.length - textPages)], ["Time", `${(res.ms.total / 1000).toFixed(1)} s`], ["Passages added", String(res.passages)]] as const).map(([k, v]) => (
                <div key={k} className="rounded-md border bg-muted/40 p-1.5"><dt className="text-[11px] text-muted-foreground">{k}</dt><dd className="text-sm font-semibold tabular-nums">{v}</dd></div>))}
            </dl>
            {CLOUD && job?.metrics && <p className="text-xs">Malware scan: <span className="font-medium">{job.result?.scan ?? "No threats found"}</span> (waited {(job.metrics.msScanWait / 1000).toFixed(0)} s). Azure Document Intelligence read {job.metrics.readPages} of {job.metrics.pages} pages{job.metrics.meanConfidence != null ? `, mean word confidence ${job.metrics.meanConfidence}, worst page ${job.metrics.worstPageConfidence}` : ""}{job.metrics.blankOrFailed ? `; ${job.metrics.blankOrFailed} blank or failed, listed below` : ""}. OCR {(job.metrics.msOcr / 1000).toFixed(1)} s, tagging {job.metrics.msExtract} ms, indexing {(job.metrics.msIndex / 1000).toFixed(1)} s.</p>}
            {!CLOUD && <p className="text-xs text-muted-foreground">Measured in this browser: reading {res.ms.read} ms ({res.pages.length ? Math.round(res.ms.read / res.pages.length) : 0} ms a page), tagging {res.ms.extract} ms, adding to search, map and graph {res.ms.index} ms.</p>}
            <section className="space-y-1" aria-label="Names found">
              <h3 className="text-sm font-semibold">Names found · {res.entities.length} <span className="font-normal text-muted-foreground">({linked.length} linked to the knowledge graph)</span></h3>
              {res.entities.length ? <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><caption className="sr-only">Names found in the document</caption>
                <thead className="bg-muted/60"><tr>{["Type", "Found as", "Linked to", "Pages", "Confidence"].map((h) => <th key={h} scope="col" className="px-1.5 py-1 text-left font-semibold">{h}</th>)}</tr></thead>
                <tbody>{res.entities.slice(0, 14).map((e) => <tr key={e.label} className="border-t align-top">
                  <td className="px-1.5 py-1">{e.type}</td><td className="px-1.5 py-1">{e.found}</td>
                  <td className="px-1.5 py-1">{e.nodeId ? <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => p.onOpenEntity(e.nodeId!)}>{e.label}</button> : <span>{e.label} <span className="text-muted-foreground">(GA borehole layer)</span></span>}</td>
                  <td className="px-1.5 py-1 tabular-nums">{e.pages.slice(0, 6).join(", ")}{e.pages.length > 6 ? " …" : ""}</td>
                  <td className="px-1.5 py-1"><span className={cn("rounded px-1 py-0.5 font-medium", CONF_CLS[e.confidence])} title={e.how}>{e.confidence}</span><span className="block text-[10px] text-muted-foreground">{e.how}</span></td></tr>)}</tbody></table></div>
                : <p className="text-xs">No basin, formation, play, feature or well names from the four basins were found.</p>}
            </section>
            {res.proposed.length > 0 && <section className="space-y-1" aria-label="New names for review">
              <h3 className="text-sm font-semibold">New names, not in the knowledge graph yet · {res.proposed.length}</h3>
              <p className="text-xs text-muted-foreground">Proposed for expert review. Your decision goes to the change log; nothing joins the graph without it.</p>
              <ul className="space-y-1">{res.proposed.map((x) => <li key={x.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
                <span><span className="font-medium">{x.name}</span> <span className="text-muted-foreground">· pages {x.pages.slice(0, 6).join(", ")}</span></span>
                {decided[x.name] ? <span className="font-medium">{decided[x.name]}</span> : <span className="flex gap-1">
                  <Button type="button" size="xs" variant="outline" onClick={() => { setDecided((d) => ({ ...d, [x.name]: "Accepted" })); p.onPropose(x.name, res.title, "Accepted"); }}>Accept</Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => { setDecided((d) => ({ ...d, [x.name]: "Rejected" })); p.onPropose(x.name, res.title, "Rejected"); }}>Reject</Button></span>}
              </li>)}</ul>
            </section>}
            <section className="space-y-1" aria-label="Places">
              <h3 className="text-sm font-semibold">Places · {res.places.length}</h3>
              {res.places.length ? <ul className="space-y-1">{res.places.map((pl, i) => <li key={i} className="flex items-start justify-between gap-2 rounded-md border px-2 py-1 text-xs">
                <span className="flex items-start gap-1.5">{pl.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-700" aria-label="Checks out" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-label="Check this" />}
                  <span><span className="font-medium">{pl.label}</span> · {Math.abs(pl.lat).toFixed(4)}°S {pl.lon.toFixed(4)}°E (GDA94), page {pl.page}<span className="block text-muted-foreground">{pl.how}</span><span className="block">{pl.check}</span></span></span>
                <Button type="button" size="xs" variant="outline" onClick={() => p.onShowPlace(pl.lon, pl.lat, pl.label)}><MapPin aria-hidden="true" /> Show</Button></li>)}</ul>
                : <p className="text-xs">No coordinates or known well names found, so the document has no point on the map.</p>}
            </section>
            {res.ages.length > 0 && <p className="text-xs"><span className="font-semibold">Ages named:</span> {res.ages.map((a) => `${a.text} (p. ${a.pages.slice(0, 3).join(", ")})`).join(" · ")}</p>}
            <section className="space-y-1" aria-label="What failed">
              <h3 className="text-sm font-semibold">Where it struggled · {res.failures.length}</h3>
              {res.failures.length ? <ul className="list-disc space-y-0.5 pl-5 text-xs">{res.failures.slice(0, 8).map((f) => <li key={f}>{f}</li>)}</ul> : <p className="text-xs">Nothing flagged.</p>}
            </section>
            <div className="flex flex-wrap gap-1.5 border-t pt-2">
              {topEnt && <Button type="button" size="sm" variant="secondary" onClick={() => p.onAsk(`In the ${res.title}, what is said about the ${topEnt.found}?`)}><Search aria-hidden="true" /> Ask about it</Button>}
              {linked[0]?.nodeId && <Button type="button" size="sm" variant="outline" onClick={() => p.onOpenEntity(linked[0].nodeId!)}><Network aria-hidden="true" /> Open in Knowledge</Button>}
              <Button type="button" size="sm" variant="ghost" onClick={() => { setRes(null); setErr(null); }}>Add another</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
