import { useState } from "react";
import type { Citation } from "@/lib/ask";
import { CLOUD } from "@/lib/cloud";
import { livePagePath, type LiveClientSource } from "@/lib/live";

export function PrivatePageImage({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p role="status" className="text-xs">This page is not currently published or could not be opened. No packaged image is substituted.</p>
    : <img src={src} alt={label} loading="lazy" onError={() => setFailed(true)} className="mt-2 max-h-[70vh] w-full rounded-lg border object-contain" data-live-page="true" />;
}
export function LiveCitationPage({ citation }: { citation: Citation }) {
  if (!CLOUD || !citation.live) return null;
  const path = livePagePath(citation);
  return <div className="space-y-1 pt-1" data-live-citation="true">
    <p className="text-xs">Live source. Native PDF page {citation.page}; citation from publication {citation.live.manifestVersion}. The API opens the current published page.</p>
    {path ? <PrivatePageImage key={`${path}:${citation.live.extractionVersion}:${citation.live.manifestVersion}`} src={path} label={`${citation.doc}, native PDF page ${citation.page}`} /> : <p role="status">The live page identity is invalid.</p>}
  </div>;
}


export function LivePublishedSource({ source, manifestVersion }: { source: LiveClientSource; manifestVersion: number }) {
  const [documentId, setDocumentId] = useState(source.documents[0]?.docId ?? ""), [page, setPage] = useState(1);
  const document = source.documents.find((d) => d.docId === documentId) ?? source.documents[0];
  if (!document) return <p>No document is currently published.</p>;
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= document.pageCount;
  const citation: Citation = { id: document.docId, doc: document.title, page, heading: "", text: "", basin: "cooper", provenanceLabel: "live",
    live: { sourceId: source.sourceId, documentSha256: document.sha256, extractionVersion: source.extractionVersion, manifestVersion } };
  return <section className="space-y-3" aria-label="Current live source">
    <p className="text-xs">{source.licence}. {source.attribution} Publication {manifestVersion}. {source.wellLocation ? `Live GDA94 geotag: ${source.wellLocation.lon}, ${source.wellLocation.lat}.` : "No well point is published for this document."}</p>
    <label className="block text-sm">Published document<select className="ml-2 rounded-lg border bg-transparent p-1" value={document.docId} onChange={(e) => { setDocumentId(e.target.value); setPage(1); }}>{source.documents.map((d) => <option key={d.docId} value={d.docId}>{d.title}</option>)}</select></label>
    <label className="block text-sm">Native PDF page<input aria-label="Native PDF page" className="mx-2 w-24 rounded-lg border bg-transparent p-1" type="number" min={1} max={document.pageCount} value={page} onChange={(e) => setPage(Number(e.target.value))} />of {document.pageCount}</label>
    {valid ? <LiveCitationPage citation={citation} /> : <p role="status">Choose a page within the published document.</p>}
  </section>;
}
