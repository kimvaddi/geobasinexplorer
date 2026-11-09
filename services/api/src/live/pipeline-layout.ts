import type { AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import { LICENCE } from "../licence";
import type { BoundingRegion, BoundingRegionSummary, ConfidenceStatistics, DocumentRef, SilverChunkRecord, SilverPageRecord, SourceRegistry, StoredGeoFields } from "./contracts";
import { pageImageBlobName } from "./contracts";
import { PIPELINE_LIMITS, PipelineError, recipe } from "./pipeline-config";
import { livePlace } from "./source-policy";
function fail(why: string): never { throw new PipelineError(422, why); }
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const spansOverlap = (a: { offset: number; length: number }, b: { offset: number; length: number }) => a.offset < b.offset + b.length && b.offset < a.offset + a.length;
export const extractionKey = (ref: DocumentRef | { sourceId: string; sha256: string; extractionVersion: string }) => `${ref.sourceId}_${ref.sha256}_${ref.extractionVersion}`;
export const extractionPrefix = (ref: { sourceId: string; sha256: string; extractionVersion: string }) => `sources/${ref.sourceId}/${ref.sha256}/${ref.extractionVersion}`;
export const documentPrefix = (ref: DocumentRef) => `${extractionPrefix(ref)}/${ref.documentSha256}`;

// Layout sections contain /paragraphs/N and /sections/N references; text spans are explicitly requested as UTF-16.
// https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/layout#sections
export function normalizeLayout(result: AnalyzeResultOutput, expectedPages: number, ref: DocumentRef, source: SourceRegistry, title: string) {
  if (result.apiVersion !== "2024-11-30" || result.modelId !== "prebuilt-layout" || result.stringIndexType !== "utf16CodeUnit"
    || typeof result.content !== "string" || result.content.length > PIPELINE_LIMITS.textChars || result.pages.length !== expectedPages) fail("Unexpected or incomplete layout result.");
  const place = livePlace(source.sourceId);
  if (!place || (source.wellLocation && !place.well)) fail("The source has no registered basin, or a located well without a name.");
  const paragraphs = result.paragraphs ?? [], sections = result.sections ?? [], headingPaths = new Map<number, string[]>();
  const children = new Set<number>();
  for (const section of sections) for (const e of section.elements ?? []) if (/^\/sections\/\d+$/.test(e)) children.add(Number(e.split("/")[2]));
  const visit = (n: number, parent: string[], ancestors = new Set<number>()) => {
    if (!sections[n] || ancestors.has(n) || ancestors.size >= 32) fail("Invalid or cyclic section hierarchy.");
    const next = new Set(ancestors).add(n), elements = sections[n].elements ?? [];
    const heading = elements.map((e) => /^\/paragraphs\/(\d+)$/.exec(e)).filter((m) => m !== null)
      .map((m) => paragraphs[Number(m![1])]).find((p) => p?.role === "title" || p?.role === "sectionHeading");
    const path = heading ? [...parent, heading.content.trim()] : parent;
    for (const e of elements) {
      const p = /^\/paragraphs\/(\d+)$/.exec(e), s = /^\/sections\/(\d+)$/.exec(e);
      if (p) { const i = Number(p[1]); if (!paragraphs[i]) fail("Missing paragraph in section."); const old = headingPaths.get(i); if (!old || old.length < path.length) headingPaths.set(i, path); }
      else if (s) visit(Number(s[1]), path, next);
      else if (!/^\/(?:tables|figures)\/\d+$/.test(e)) fail("Unexpected layout section pointer.");
    }
  };
  sections.forEach((_, i) => { if (!children.has(i)) visit(i, []); });
  if (sections.length && children.size >= sections.length) fail("Cyclic section roots.");
  const pages: SilverPageRecord[] = [], chunks: SilverChunkRecord[] = [];
  const seen = new Set<number>(); let currentHeading: string[] = [];
  for (const page of [...result.pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const n = page.pageNumber;
    if (!Number.isInteger(n) || n < 1 || n > expectedPages || seen.has(n) || !numeric(page.width) || page.width <= 0 || !numeric(page.height) || page.height <= 0 || !["inch", "pixel"].includes(page.unit ?? "")) fail("Invalid layout page geometry or identity.");
    seen.add(n); const unit = page.unit as BoundingRegion["unit"];
    const spans = page.spans ?? [];
    for (const s of spans) if (!Number.isSafeInteger(s.offset) || !Number.isSafeInteger(s.length) || s.offset < 0 || s.length < 0 || s.offset + s.length > result.content.length) fail("Invalid page text span.");
    if (spans.length > 1 && spans.some((s, i) => i > 0 && s.offset < spans[i-1].offset + spans[i-1].length)) fail("Overlapping page text spans.");
    const text = spans.map((s) => result.content.slice(s.offset, s.offset + s.length)).join("\n");
    if (LICENCE.isWithheldPassage({ id: ref.docId, doc: title, sourceId: source.sourceId, source: { publisher: source.publisher }, text, visibility: "public" })) fail("Withheld evidence in extraction.");
    const relevant = paragraphs.map((p, index) => ({ p, index })).filter(({ p }) => p.boundingRegions?.some((r) => r.pageNumber === n));
    const regions: BoundingRegion[] = [];
    for (const { p } of relevant) for (const r of p.boundingRegions ?? []) if (r.pageNumber === n) {
      if (!r.polygon || r.polygon.length < 6 || r.polygon.length % 2 || !r.polygon.every(numeric)) fail("Invalid layout bounding polygon.");
      regions.push({ page: n, polygon: r.polygon, unit });
    }
    if (!regions.length) regions.push({ page: n, unit, polygon: [0, 0, page.width, 0, page.width, page.height, 0, page.height] });
    const confidence = (page.words ?? []).map((w) => w.confidence);
    if (confidence.some((v) => !numeric(v) || v < 0 || v > 1)) fail("Invalid word confidence.");
    const mean = confidence.length ? confidence.reduce((a, b) => a + b, 0) / confidence.length : null;
    const first = relevant.find(({ p }) => p.role === "title" || p.role === "sectionHeading");
    if (first) currentHeading = headingPaths.get(first.index) ?? [first.p.content.trim()];
    const pageRecord: SilverPageRecord = { ...ref, page: n, text, width: page.width, height: page.height, unit,
      headingPath: [...currentHeading], boundingRegions: regions, confidence: mean,
      imageBlob: pageImageBlobName({ sourceId: ref.sourceId, sha256: ref.documentSha256, extractionVersion: ref.extractionVersion, page: n }) };
    pages.push(pageRecord);
    const geo: StoredGeoFields = source.wellLocation ? {
      points: [{ longitude: source.wellLocation.lon, latitude: source.wellLocation.lat }], places: [place.well!], placeHow: ["Registered well location (GDA94), published with this extraction"], geoBasins: place.basin ? [place.basin] : [], geotag: "point",
    } : !place.basin || /glossary|acknowledg/i.test(title) ? { points: [], places: [], placeHow: [], geoBasins: [], geotag: "general" }
      : { points: [], places: [], placeHow: [], geoBasins: [place.basin], geotag: "basin" };
    let pageOffset = 0;
    while (pageOffset < text.length) {
      let end = Math.min(text.length, pageOffset + recipe("").chunker.maxChars);
      if (end < text.length) { const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end)); if (boundary > pageOffset + 1000) end = boundary + 1; }
      while (Buffer.byteLength(text.slice(pageOffset, end), "utf8") > 7500) end--;
      const part = text.slice(pageOffset, end), absolute = { offset: (spans[0]?.offset ?? 0) + pageOffset, length: part.length };
      const paragraph = relevant.find(({ p }) => p.spans?.some((s) => spansOverlap(s, absolute)));
      const headingPath = paragraph ? headingPaths.get(paragraph.index) ?? pageRecord.headingPath : pageRecord.headingPath;
      if (part.trim()) {
        const summary: BoundingRegionSummary[] = regions.map((r) => { const x = r.polygon.filter((_, i) => i % 2 === 0), y = r.polygon.filter((_, i) => i % 2 === 1);
          return { page: n, unit, x: Math.min(...x), y: Math.min(...y), width: Math.max(...x) - Math.min(...x), height: Math.max(...y) - Math.min(...y) }; });
        chunks.push({ ...ref, ...geo, id: `${extractionKey(ref)}_${ref.documentSha256}_c${chunks.length}`, page: n, text: part, headingPath: [...headingPath],
          boundingRegions: regions, boundingRegionsSummary: summary, basin: geo.geotag === "general" ? null : place.basin, well: source.wellLocation ? place.well : null,
          visibility: "public", owner: "", licence: source.licence, attribution: source.attribution });
        if (chunks.length > PIPELINE_LIMITS.chunks) fail("Chunk cap reached.");
      }
      pageOffset = end;
    }
  }
  if (seen.size !== expectedPages) fail("A page is missing from extraction.");
  if (!chunks.length) fail("No readable evidence; retain the explicit processing failure for review.");
  const values = pages.map((p) => p.confidence).filter((n): n is number => n !== null);
  const confidence: ConfidenceStatistics = { minimum: values.length ? Math.min(...values) : null, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    measuredPages: values.length, lowConfidencePages: pages.filter((p) => p.confidence === null || p.confidence < 0.8).length };
  return { pages, chunks, confidence };
}
