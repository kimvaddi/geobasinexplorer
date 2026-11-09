import provenance from "../data/licence-provenance.json";
import type { Answer5 } from "./answer5";
import type { Pack as AppPack, Passage5 } from "./pack";
import type { Pack as LowcarbonPack, Site as LowcarbonSite } from "./lowcarbon";
import type { Site } from "./wells";

export const WITHHELD_SOURCES = [
  { id: "gsq-cr000407", reference: "GSQ open file CR000407", title: "Innamincka 1 well completion report", status: "reuse terms not confirmed", reason: "The owner has withheld this source and its derivatives until its reuse terms are confirmed." },
  { id: "gsq-cr050039", reference: "GSQ open file CR050039", title: "ZeroGen well reports and project studies", status: "reuse terms not confirmed", reason: "The owner has withheld this source and its derivatives until its reuse terms are confirmed." },
  { id: "sa-dem-core-2026", reference: "SA DEM core workshop, 2026", title: "Department for Energy and Mining core workshop", status: "reuse terms not confirmed", reason: "The owner has withheld this source and its derivatives until its reuse terms are confirmed." },
] as const;
export type WithheldSource = typeof WITHHELD_SOURCES[number];
export type WithheldSourceId = WithheldSource["id"];
const bySourceId = new Map<string, WithheldSource>(WITHHELD_SOURCES.map((s) => [s.id, s]));

// Older packs have report codes, filenames and well aliases rather than manifest source ids. All other
// document, field, page and image identities are derived from those records below, not a title denylist.
const SOURCE_MARKERS: [RegExp, WithheldSourceId][] = [
  [/(?:^|[^a-z0-9])cr[_-]?0*407(?=$|[^a-z0-9])/i, "gsq-cr000407"],
  [/(?:^|[^a-z0-9])cr[_-]?0*50039(?=$|[^a-z0-9])|(?:^|[^a-z0-9])zerogen[ _-]*dp[ _-]*1(?=$|[^a-z0-9])/i, "gsq-cr050039"],
  [/sa-dem-core-2026|dem2026|dem[ _-]+core[ _-]+workshop|core[ _-]+workshop[^\n]*2026|2026[ _-]+DEM[ _-]+(?:slides|deck)|DEM[ _-]+(?:slides|deck)[^\n.]*2026/i, "sa-dem-core-2026"],
];
const EVIDENCE_ALIASES: [RegExp, WithheldSourceId][] = [
  [/(?:^|[^a-z0-9])innamincka[ _-]*(?:no\.?[ _-]*)?1(?=$|[^a-z0-9])|(?:^|:)inn-[a-z0-9]/i, "gsq-cr000407"],
  [/(?:^|[^a-z0-9])zerogen[ _-]*2(?=$|[^a-z0-9])/i, "gsq-cr050039"],
];
const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/").trim();
// Some source titles contain extracted depths. Keep only a deterministic fingerprint in the browser's
// withholding registry; the title itself must not re-enter the cloud bundle as policy metadata.
export const licenceTextKey = (s: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const c of norm(s)) hash = BigInt.asUintN(64, (hash ^ BigInt(c.codePointAt(0)!)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
};
interface TextProvenance { id: string; fingerprint: string; length: number; prefixFingerprint: string; sourceId: WithheldSourceId; replacement: string | null }
interface ItemProvenance { id: string; sources: WithheldSourceId[]; action: "remove" | "recompute" | "reword" }
export const DERIVED_TEXT_PROVENANCE = provenance.text as TextProvenance[];
export const DERIVED_ITEM_PROVENANCE = provenance.items as ItemProvenance[];
const derivedText = new Map(DERIVED_TEXT_PROVENANCE.map((p) => [p.fingerprint, p]));
const textPrefixes = new Map<string, TextProvenance[]>();
for (const p of DERIVED_TEXT_PROVENANCE) textPrefixes.set(p.prefixFingerprint, [...(textPrefixes.get(p.prefixFingerprint) ?? []), p]);
const derivedItems = new Map(DERIVED_ITEM_PROVENANCE.map((p) => [p.id, p]));
export const PASSAGE_PREFIXES: { prefix: string; sourceId: WithheldSourceId }[] = [
  { prefix: "inn-", sourceId: "gsq-cr000407" }, { prefix: "innamincka-1:", sourceId: "gsq-cr000407" },
  { prefix: "zerogen-2:", sourceId: "gsq-cr050039" },
];
export const searchDocumentId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === "string" ? v : "";
const marker = (s: string, aliases = false): WithheldSourceId | undefined =>
  SOURCE_MARKERS.find(([re]) => re.test(s))?.[1] ?? (aliases ? EVIDENCE_ALIASES.find(([re]) => re.test(s))?.[1] : undefined);
const PROVENANCE_KEYS = new Set(["id", "sourceId", "source", "sources", "doc", "docId", "document", "file", "fileName", "url", "report", "passage", "passageId", "entity", "entityId", "panel"]);
const BINARY_KEYS = new Set(["img", "thumb", "b64", "src", "image", "vector"]);
export type Metadata = { passages: [string, WithheldSourceId][]; docIds: [string, WithheldSourceId][]; ids: [string, WithheldSourceId][]; documents: [string, WithheldSourceId][]; sites: [string, WithheldSourceId][]; assets: [string, WithheldSourceId][] };
type PackWithMetadata = AppPack & { withheldProvenance?: Metadata };
type Passage = { id?: string; doc?: string; docId?: string; source?: unknown; sourceId?: string; well?: string | null; text?: string; t?: string; visibility?: string };

export class LicenceGate {
  private passages = new Map<string, WithheldSourceId>();
  private docIds = new Map<string, WithheldSourceId>();
  private ids = new Map<string, WithheldSourceId>();
  private documents = new Map<string, WithheldSourceId>();
  private sites = new Map<string, WithheldSourceId>();
  private assets = new Map<string, WithheldSourceId>();

  constructor(app: AppPack, lowcarbon: LowcarbonPack) {
    // Cloud bundles retain only this provenance metadata, never the withheld values or image bytes.
    const saved = (app as PackWithMetadata).withheldProvenance;
    if (saved) for (const k of ["ids", "documents", "sites", "assets", "passages", "docIds"] as const) for (const [id, source] of saved[k] ?? []) this[k].set(id, source);
    for (const site of [...app.wells, ...lowcarbon.sites]) this.registerSite(site);
    for (const d of app.docs) {
      const source = this.sourceOf(d.source) ?? this.sourceOf(d.title);
      if (source) { this.ids.set(norm(d.id), source); this.documents.set(licenceTextKey(d.title), source); }
    }
    for (const p of app.extraPassages) {
      const source = this.passageSource(p);
      if (source) { this.ids.set(norm(p.id), source); this.passages.set(p.id, source); this.docIds.set(searchDocumentId(p.doc), source); this.documents.set(licenceTextKey(p.doc), source); }
    }
    for (const q of app.benchmarks) for (const evidence of q.evidence) {
      const source = this.sourceOf(evidence.doc);
      if (source) {
        this.documents.set(licenceTextKey(evidence.doc), source);
        if (evidence.passage) this.ids.set(norm(evidence.passage), source);
      }
    }
    for (const e of app.entities) {
      const source = this.sourceOf(e.source);
      if (source) this.ids.set(norm(e.id), source);
    }
    for (const image of [...app.core.panels, ...app.core.photos]) {
      const source = this.provenanceSource(image);
      if (source) { this.ids.set(norm(image.id), source); this.assets.set(norm(image.file), source); }
    }
    for (const strip of app.core.strips) {
      const source = this.idSource(strip.panel);
      if (source) this.ids.set(norm(strip.id), source);
    }
  }

  private registerSite(site: Site | LowcarbonSite) {
    const whole = this.sourceOf(site.source);
    if (whole) { this.sites.set(norm(site.siteId), whole); this.sites.set(norm(site.name), whole); }
    for (const doc of site.documents) {
      const source = whole ?? this.provenanceSource(doc) ?? this.sourceOf(doc.title);
      if (!source) continue;
      this.ids.set(norm(`${site.siteId}:${doc.docId}`), source);
      this.documents.set(licenceTextKey(`${site.name} · ${doc.title}`), source);
      this.assets.set(norm(doc.file), source);
      if (marker(doc.title, true)) this.documents.set(licenceTextKey(doc.title), source);
      for (const f of [...site.fields, ...site.findings]) if (f.docId === doc.docId) {
        const id = "fieldId" in f ? f.fieldId : f.findingId;
        this.ids.set(norm(`${site.siteId}:${id}`), source);
      }
      for (const page of site.pages) if (page.docId === doc.docId) {
        this.ids.set(norm(`${site.siteId}:${page.pageId}`), source);
        this.ids.set(norm(`wellpage:${page.pageId}`), source);
        this.assets.set(norm(page.file.replace(/^img\//, "")), source);
      }
    }
  }

  textProvenance = (text: string) => derivedText.get(licenceTextKey(text));
  // Propagate the explicit provenance when a label/note is embedded in a review or generated sentence.
  // Only hashes and lengths are shipped, never the restricted wording used to identify the fragment.
  textProvenanceIn = (text: string): TextProvenance | undefined => {
    const exact = this.textProvenance(text); if (exact) return exact;
    const value = norm(text);
    const starts = [0, ...Array.from(value.matchAll(/[^a-z0-9_]/g), (match) => match.index! + 1)];
    for (const start of starts) {
      for (const p of textPrefixes.get(licenceTextKey(value.slice(start, start + 8))) ?? [])
        if (value.length >= start + p.length && licenceTextKey(value.slice(start, start + p.length)) === p.fingerprint) return p;
    }
    return undefined;
  };
  itemProvenance = (id: string) => derivedItems.get(id);
  private retainedText(text: string): string | null { return this.textProvenance(text)?.replacement ?? (this.textProvenance(text) ? null : text); }
  sourceOf(value: unknown): WithheldSourceId | undefined {
    if (typeof value === "string") return /^bh:/i.test(value) ? undefined : bySourceId.has(value) ? value as WithheldSourceId : this.textProvenanceIn(value)?.sourceId ?? this.idSource(value) ?? this.documents.get(licenceTextKey(value)) ?? this.assets.get(norm(value).replace(/^img\//, "")) ?? marker(value, true);
    const v = obj(value);
    for (const k of ["sourceId", "source", "id", "title", "report", "file", "fileName", "url", "credit"]) {
      if (v[k] != null) { const source = this.sourceOf(v[k]); if (source) return source; }
    }
    return undefined;
  }

  private idSource(id: string): WithheldSourceId | undefined {
    if (/^bh:/i.test(id)) return undefined; // GA boreholes are not the scanned well evidence.
    const key = norm(id);
    const unwrapped = key.replace(/^(?:doc|field|lowc|interval|well|core|photo|panel|strip):/, "");
    return this.ids.get(key) ?? this.ids.get(unwrapped) ?? this.docIds.get(key) ?? this.sites.get(unwrapped) ?? derivedItems.get(id)?.sources[0] ?? PASSAGE_PREFIXES.find((p) => key.startsWith(p.prefix))?.sourceId ?? marker(key, true);
  }
  isWithheldSource = (value: unknown) => !!this.sourceOf(value);
  isWithheldId = (id: string) => !!this.idSource(id);
  isWithheldDocument = (value: unknown) => !!(typeof value === "string" ? this.idSource(value) ?? this.sourceOf(value) : this.provenanceSource(value) ?? this.sourceOf(value));
  isWithheldWell = (value: string | { siteId: string; source?: unknown }) => typeof value === "string"
    ? !!(this.sites.get(norm(value)) ?? marker(value, true)) : !!(this.sourceOf(value.source) ?? this.sites.get(norm(value.siteId)));

  private provenanceSource(value: unknown): WithheldSourceId | undefined {
    const v = obj(value);
    for (const [k, x] of Object.entries(v)) if (PROVENANCE_KEYS.has(k)) {
      const source = typeof x === "string" ? this.idSource(x) ?? this.sourceOf(x) : this.sourceOf(x);
      if (source) return source;
    }
    return undefined;
  }
  private passageSource(p: Passage): WithheldSourceId | undefined {
    const known = this.ids.get(norm(p.id ?? "")) ?? this.docIds.get(p.docId ?? "") ?? this.documents.get(licenceTextKey(p.doc ?? ""));
    if (known) return known;
    const explicit = marker(`${p.sourceId ?? ""} ${JSON.stringify(p.source ?? "")} ${p.doc ?? ""} ${p.docId ?? ""}`);
    if (explicit) return explicit;
    if (/Geoscience Australia/i.test(JSON.stringify(p.source ?? ""))) return undefined;
    const derived = this.textProvenanceIn(p.text ?? p.t ?? "")?.sourceId;
    if (derived) return derived;
    const source = this.provenanceSource(p);
    if (source) return source;
    if (p.well && this.isWithheldWell(p.well)) return this.sites.get(norm(p.well)) ?? marker(p.well, true);
    // A renamed upload may still identify the restricted report in its text. Public GA passages about a
    // borehole are not that borehole's completion report, so names in public passage text are not a veto.
    if (p.visibility !== "private") return undefined;
    const text = p.text ?? p.t ?? "";
    return marker(text) ?? (/well completion|formation testing|government OCR|\bDST\b|bottom[- ]hole temperature|data evaluation summary/i.test(text) ? marker(text, true) : undefined);
  }
  isWithheldPassage = (p: Passage | string) => typeof p === "string" ? this.isWithheldId(p) : !!this.passageSource(p);
  filterPassages = <T extends Passage>(passages: T[]): T[] => passages.filter((p) => !this.isWithheldPassage(p));
  isWithheldAsset = (file: string) => {
    if (/^(?:data|blob):/i.test(file)) return false;
    const path = norm(file.split("?")[0]);
    return !!marker(path, true) || [...this.assets.keys()].some((f) => path === f || path.endsWith(`/${f}`));
  };
  isWithheldImage = (value: unknown): boolean => {
    if (typeof value === "string") return this.isWithheldId(value) || this.isWithheldAsset(value);
    const v = obj(value), open = obj(v.open);
    return !!this.provenanceSource(v) || this.isWithheldAsset(str(v.src)) || (open.type === "well" && this.isWithheldWell(str(open.id)));
  };
  isWithheldGraphNode = (value: unknown): boolean => {
    if (typeof value === "string") return this.isWithheldId(value);
    const v = obj(value);
    if (v.type === "borehole" && /Geoscience Australia/i.test(str(obj(v.source).publisher))) return false;
    return !!this.provenanceSource(v);
  };

  referencesWithheld = (value: unknown): boolean => {
    if (typeof value === "string") return !/^bh:/i.test(value) && !!(this.idSource(value) ?? this.sourceOf(value));
    if (Array.isArray(value)) return value.some(this.referencesWithheld);
    return Object.entries(obj(value)).some(([key, v]) => !BINARY_KEYS.has(key) && (this.isWithheldId(key) || this.referencesWithheld(v)));
  };
  private hasProvenance(value: unknown): boolean {
    if (typeof value === "string") return !!(marker(value) ?? this.textProvenanceIn(value)?.sourceId ?? this.ids.get(norm(value)) ?? this.documents.get(licenceTextKey(value)));
    if (Array.isArray(value)) return value.some((v) => this.hasProvenance(v));
    return !!this.provenanceSource(value) || Object.entries(obj(value)).some(([key, v]) => !BINARY_KEYS.has(key) && this.hasProvenance(v));
  }
  isWithheldQuestion = (question: string): boolean => {
    if (this.textProvenance(question)?.id.startsWith("benchmark:") || this.textProvenance(question)?.id.startsWith("starter:")) return true;
    if (marker(question)) return true;
    if (/\b(?:GA|Geoscience Australia|OzTemp|borehole layer)\b/i.test(question)) return false;
    return !!marker(question, true) && /report|scan|OCR|\bDST\b|perforat|bottom[- ]hole|shut[- ]in|temperature|pressure|porosity|permeability|salinity|core|assay/i.test(question);
  };
  isWithheldAnswer = (a: Answer5): boolean => {
    const extra = a as Answer5 & { evidence?: unknown; computations?: unknown };
    return a.citations.some(this.isWithheldPassage) || !!(a.fieldRef && (this.isWithheldWell(a.fieldRef.site) || this.isWithheldId(`${a.fieldRef.site}:${a.fieldRef.field}`)))
      || !!a.images?.some(this.isWithheldImage) || [a.table, extra.evidence, extra.computations, a.why.scores, a.validation?.removed].some((v) => this.hasProvenance(v))
      || a.paragraphs.some((p) => !!marker(p) || !!this.textProvenanceIn(p)) || (a.status === "unsupported" && this.referencesWithheld(a.paragraphs));
  };
  gateAnswer = <T extends Answer5>(a: T): T | null => this.isWithheldAnswer(a) ? null : { ...a, followUps: a.followUps.filter((q) => !this.referencesWithheld(q)) };

  isWithheldIngestResult = (value: unknown): boolean => {
    const v = obj(value);
    if (this.isWithheldDocument(v.title) || this.isWithheldAsset(str(v.fileName))) return true;
    if (Array.isArray(v.passageList) && v.passageList.some((p) => this.isWithheldPassage({ ...obj(p), visibility: "private" }))) return true;
    return Array.isArray(v.entities) && v.entities.some((e) => this.isWithheldGraphNode(str(obj(e).nodeId)));
  };

  private gateSite<T extends Site | LowcarbonSite>(site: T): T | null {
    if (this.isWithheldWell(site)) return null;
    const removed = new Set(site.documents.filter((d) => this.isWithheldDocument(d)).map((d) => d.docId));
    const explicitNotes = site.notes.filter((n) => !!this.textProvenance(n));
    const sourceNotes = site.notes.filter(this.referencesWithheld);
    const recompute = !!this.itemProvenance(`site:${site.siteId}:stats`);
    if (!removed.size && !explicitNotes.length && !sourceNotes.length && !recompute) return site;
    const documents = site.documents.filter((d) => !removed.has(d.docId));
    const pages = site.pages.filter((p) => !removed.has(p.docId));
    const fields = site.fields.filter((f) => !removed.has(f.docId)).map((f) => ({ ...f, label: this.retainedText(f.label) ?? "Retained report value" }));
    const findings = site.findings.filter((f) => !removed.has(f.docId)).map((f) => ({ ...f, text: this.retainedText(f.text) ?? "See the retained report quotation." }));
    const fieldIds = new Set(fields.map((f) => f.fieldId)), findingIds = new Set(findings.map((f) => f.findingId));
    const used = [...fields, ...findings, ...pages];
    const stats = { ...site.stats, docsInPackage: documents.length, docsSampled: new Set(used.map((x) => x.docId)).size,
      pagesSampled: pages.length, pagesReadable: pages.filter((p) => p.readability !== "poor").length,
      fieldsTotal: fields.length, fieldsNeedReview: fields.filter((f) => f.needsReview).length,
      ocrCompared: fields.filter((f) => !!f.ocrBaseline).length, ocrMatch: fields.filter((f) => f.ocrBaseline?.status === "match").length,
      ocrPartial: fields.filter((f) => f.ocrBaseline?.status === "partial").length, ocrGarbled: fields.filter((f) => f.ocrBaseline?.status === "garbled").length, ocrMissing: fields.filter((f) => f.ocrBaseline?.status === "missing").length };
    const out = { ...site, documents, pages, fields, findings, curves: site.curves?.filter((c) => !removed.has(c.docId)), stats,
      notes: [...new Set([...site.notes.filter((n) => !this.textProvenance(n) && !this.referencesWithheld(n)), "Counts describe the retained cloud evidence, not the complete original source package. Page counts cover included images, not every cited page."])], role: this.retainedText(site.role) ?? `Evidence from the retained ${site.name} well reports.` };
    if ("inputs" in site) {
      const inputs = Object.fromEntries(Object.entries(site.inputs).flatMap(([key, input]) => {
        if (Array.isArray(input)) return [[key, input.filter((id: string) => findingIds.has(id))]];
        if ("fieldIds" in input && !input.fieldIds.every((id: string) => fieldIds.has(id))) return [];
        return [[key, { ...input, ...("label" in input ? { label: this.retainedText(input.label) ?? "Retained report input" } : {}) }]];
      }));
      // The old headline and role combine report and workshop claims without separate citations.
      Object.assign(out, { inputs, headline: this.retainedText(site.headline) ?? "Evidence from retained well reports is available." });
    }
    return out as T;
  }

  cloudAppPack(app: AppPack): AppPack {
    const wells = app.wells.map((s) => this.gateSite(s)).filter((s): s is Site => !!s);
    const docs = app.docs.filter((d) => !this.isWithheldDocument(d));
    const entities = app.entities.filter((e) => !this.isWithheldGraphNode(e));
    const panels = app.core.panels.filter((p) => !this.isWithheldImage(p));
    const photos = app.core.photos.filter((p) => !this.isWithheldImage(p));
    const strips = app.core.strips.filter((s) => panels.some((p) => p.id === s.panel) && !this.isWithheldImage(s));
    const benchmarks = app.benchmarks.filter((q) => !this.referencesWithheld(q));
    const removedQuestions = app.benchmarks.filter((q) => !benchmarks.includes(q)).map((q) => q.id);
    const sum = (key: "fieldsTotal" | "fieldsNeedReview") => wells.reduce((n, w) => n + w.stats[key], 0);
    const counts: Record<string, number> = { "Documents in the catalogue": docs.length, "Values extracted from legacy scans": sum("fieldsTotal"), "Values flagged for review": sum("fieldsNeedReview"), "Knowledge-graph entities": entities.length };
    // These build timings and combined page counts have no per-source breakdown; don't relabel them as cloud measurements.
    const mixedMetrics = new Set(DERIVED_ITEM_PROVENANCE.filter((p) => p.id.startsWith("metric:") && p.action === "remove").map((p) => p.id.slice(7)));
    return { ...app, wells, docs, entities, core: { panels, strips, photos }, benchmarks,
      extraPassages: this.filterPassages(app.extraPassages), reportPages: app.reportPages.filter((p) => !this.isWithheldDocument(p.doc)),
      las: app.las && !this.isWithheldSource(app.las.source) ? app.las : null,
      figures: app.figures.filter((f) => !this.isWithheldImage(f)), charts: app.charts.filter((c) => !this.isWithheldImage(c)),
      datasets: app.datasets.filter((d) => !this.referencesWithheld(d)),
      velocity: app.velocity && !this.isWithheldSource(app.velocity.source) ? app.velocity : null,
      positions: app.positions && !this.isWithheldWell(app.positions.well) ? app.positions : null,
      checks: { validation: app.checks.validation.filter((r) => !this.referencesWithheld(r)), findings: app.checks.findings.filter((r) => !this.referencesWithheld(r)) },
      realness: app.realness.map((r) => {
        if (r.item === "Legacy well report pages") return { ...r, source: wells.map((w) => w.source.report).join("; "), note: "Only retained reports are included." };
        if (/^Values read from legacy scans/.test(r.item)) return { ...r, item: `Values read from retained legacy scans (${sum("fieldsTotal")})`, source: wells.map((w) => w.source.report).join("; "), note: "Retained values have page citations and confidence levels." };
        if (/^Knowledge-graph entities \(/.test(r.item)) return { ...r, item: `Knowledge-graph entities (${entities.length})`, source: "Retained GA tables and permitted well reports", note: "Counted from the retained cloud entities." };
        return { ...r, source: r.source.replace(/the two well reports/g, "retained well reports") };
      }).filter((r) => !this.referencesWithheld(r)),
      metrics: app.metrics.filter((m) => !this.referencesWithheld(m) && !mixedMetrics.has(m.label)).map((m) => m.label in counts ? { ...m, value: String(counts[m.label]), how: "Counted from the retained cloud evidence" } : m),
      learning: app.learning.filter((l) => !this.referencesWithheld(l) && !removedQuestions.some((id) => JSON.stringify(l).includes(id))),
      mapping: app.mapping.filter((m) => !this.referencesWithheld(m)).map((m) => this.itemProvenance(`mapping:${m.capability}`)?.action === "reword" ? { ...m, inFile: "Published rules over retained public well evidence" } : m),
    };
  }
  cloudLowcarbonPack(pack: LowcarbonPack): LowcarbonPack {
    return { ...pack, sites: pack.sites.map((s) => this.gateSite(s)).filter((s): s is LowcarbonSite => !!s),
      context: pack.context.map((p) => ({ ...p, facts: p.facts.filter((f) => !this.isWithheldSource(f.source)) })).filter((p) => p.facts.length > 0) };
  }
  metadata(): Metadata { return { passages: [...this.passages], docIds: [...this.docIds], ids: [...this.ids], documents: [...this.documents], sites: [...this.sites], assets: [...this.assets] }; }
}

export function createLicenceGate(app: AppPack, lowcarbon: LowcarbonPack) { return new LicenceGate(app, lowcarbon); }
export type { Passage5 };
