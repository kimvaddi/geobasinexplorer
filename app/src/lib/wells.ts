import { fmt } from "@/lib/basins";

/* Legacy-scan wells: values read from scanned report pages with page citations, confidence and review flags. */
export type Confidence = "high" | "medium" | "low";
export type Readability = "good" | "fair" | "poor";
export interface SiteDoc { docId: string; file: string; title: string; kind: string; year?: number; pages: number; format: string; readability: Readability; note?: string }
export interface SitePage { pageId: string; docId: string; page: number; file: string; w: number; h: number; caption: string; readability: Readability; crop?: string; img: string }
export interface OcrBaseline { status: "match" | "partial" | "garbled" | "missing"; text?: string }
export interface SiteField {
  fieldId: string; group: string; label: string; value: number | string; unit?: string; valueSI?: number; unitSI?: string; conversion?: string; depthM?: number; depthRef?: string; formation?: string;
  docId: string; page: number; pageId?: string; quote: string; method: "text-layer" | "vision-read" | "computed"; confidence: Confidence; confidenceWhy: string; needsReview: boolean; ocrBaseline?: OcrBaseline; note?: string;
}
export interface Finding { findingId: string; topic: string; text: string; quote: string; docId: string; page: number; confidence: Confidence }
export interface Curve { curveId: string; label: string; unit: string; depthUnit: "m"; points: [number, number][]; docId: string; note: string }
export interface SiteStats { docsInPackage: number; docsSampled: number; pagesSampled: number; pagesReadable: number; fieldsTotal: number; fieldsNeedReview: number; ocrCompared: number; ocrMatch: number; ocrPartial: number; ocrGarbled: number; ocrMissing: number }
export interface Site {
  siteId: string; name: string; role: string; basinId: string; lat: number; lon: number; positionSource: string; spudYear?: number; operator?: string; totalDepthM?: number;
  source: { publisher: string; report: string; url: string; licence: string; credit: string };
  documents: SiteDoc[]; pages: SitePage[]; fields: SiteField[]; findings: Finding[]; curves?: Curve[]; stats: SiteStats; notes: string[];
}
export const docById = (s: Site, id: string) => s.documents.find((d) => d.docId === id) ?? null;
export const CONFIDENCE: Record<Confidence, { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-emerald-700 text-white" }, medium: { label: "Medium", cls: "bg-amber-600 text-black" }, low: { label: "Low", cls: "bg-red-700 text-white" },
};
export const OCR_LABEL: Record<OcrBaseline["status"], { label: string; cls: string }> = {
  match: { label: "OCR matches", cls: "border-emerald-700 text-emerald-800" }, partial: { label: "OCR partly right", cls: "border-amber-600 text-amber-800" },
  garbled: { label: "OCR garbled", cls: "border-red-700 text-red-800" }, missing: { label: "Not in the OCR text", cls: "border-red-700 text-red-800" },
};
export function fieldValue(f: SiteField): string {
  const v = typeof f.value === "number" ? fmt(f.value, Math.min((String(f.value).split(".")[1] ?? "").length, 3)) : f.value;
  return f.unit ? `${v} ${f.unit}` : String(v);
}
export function fieldSI(f: SiteField): string | null {
  if (f.valueSI == null || !f.unitSI || (f.unit && f.unitSI === f.unit)) return null;
  const d = Math.abs(f.valueSI) >= 100 ? 0 : Math.abs(f.valueSI) >= 10 ? 1 : 2;
  return `${fmt(f.valueSI, d)} ${f.unitSI}`;
}
