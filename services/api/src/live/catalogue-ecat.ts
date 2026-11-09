// Geoscience Australia's product catalogue (eCat, GeoNetwork 4) as a live source. The importer fetches one record from
// the catalogue's search API, checks its identity and CC BY 4.0 licence, and renders the record's own fields as a short
// text PDF (pdf-text.ts). The PDF then lands, is extracted, reviewed and published like any document, and answers cite
// it by page. Only stable fields are rendered, never indexing dates, popularity or link lists, so a record gives the
// same bytes until Geoscience Australia revises it, and a revision shows up as a hash that no longer matches its pin.
// https://ecat.ga.gov.au/geonetwork (GeoNetwork 4 search API: POST /srv/api/search/records/_search)
import { sha256Of } from "../scan-verdict";
import { PipelineError } from "./pipeline-config";
import { boundedResponse } from "./pipeline-http";
import { textPdf, type TextBlock } from "./pdf-text";

export const ECAT_SEARCH_URL = "https://ecat.ga.gov.au/geonetwork/srv/api/search/records/_search";
export const ECAT_FIELDS = ["eCatId", "uuid", "resourceTitleObject", "resourceAbstractObject", "lineageObject", "resourceIdentifier",
  "OrgForResourceObject", "cl_status", "resourceType", "resourceDate", "crsDetails", "legalconstraints", "dateStamp"] as const;
export const CC_BY_4 = "Creative Commons Attribution 4.0 International";
const CC_BY_4_ENTRY = /^Creative Commons Attribution 4\.0 International(?: Licen[cs]e)?(?: \(CC BY 4\.0\))?\.?$/i;
const RESTRICTION = /all rights reserved|non-?commercial|no-?derivatives|share-?alike|\bBY-(?:NC|ND|SA)\b/i;
const RECORD_BYTES = 2 * 1024 * 1024, TEXT_CHARS = 60_000;
export interface EcatRecord {
  ecatId: string; uuid: string; title: string; abstract: string; lineage: string; pid: string | null; doi: string | null;
  organisation: string; status: string; resourceType: string; published: string | null; crs: string; licence: string; revision: string;
}

// HTML named character references: all of Latin-1, the Greek letters and the punctuation and mathematical signs
// catalogue text uses. A name is matched exactly first, so &Eacute; and &eacute; differ as in HTML, then in lower case
// so legacy capitals such as &AMP; still decode. An unknown name stays as written.
const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot "
  + "cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute "
  + "Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml "
  + "aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute "
  + "ucirc uuml yacute thorn yuml").split(" ");
const GREEK = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega".split(" ");
const OTHER: readonly (readonly [string, number])[] = [["quot", 34], ["amp", 38], ["apos", 39], ["lt", 60], ["gt", 62], ["OElig", 338], ["oelig", 339],
  ["Scaron", 352], ["scaron", 353], ["Yuml", 376], ["fnof", 402], ["circ", 710], ["tilde", 732], ["sigmaf", 962], ["ensp", 8194], ["emsp", 8195],
  ["thinsp", 8201], ["zwnj", 8204], ["zwj", 8205], ["lrm", 8206], ["rlm", 8207], ["ndash", 8211], ["mdash", 8212], ["lsquo", 8216], ["rsquo", 8217],
  ["sbquo", 8218], ["ldquo", 8220], ["rdquo", 8221], ["bdquo", 8222], ["dagger", 8224], ["Dagger", 8225], ["bull", 8226], ["hellip", 8230],
  ["permil", 8240], ["prime", 8242], ["Prime", 8243], ["lsaquo", 8249], ["rsaquo", 8250], ["oline", 8254], ["frasl", 8260], ["euro", 8364],
  ["trade", 8482], ["larr", 8592], ["uarr", 8593], ["rarr", 8594], ["darr", 8595], ["harr", 8596], ["part", 8706], ["nabla", 8711], ["isin", 8712],
  ["prod", 8719], ["sum", 8721], ["minus", 8722], ["lowast", 8727], ["radic", 8730], ["prop", 8733], ["infin", 8734], ["sim", 8764], ["asymp", 8776],
  ["ne", 8800], ["equiv", 8801], ["le", 8804], ["ge", 8805]];
export const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ...LATIN1.map((name, i): [string, string] => [name, String.fromCharCode(160 + i)]),
  ...GREEK.flatMap((name, i): [string, string][] => name === "-" ? [] : [[name, String.fromCharCode(913 + i)], [name.toLowerCase(), String.fromCharCode(945 + i)]]),
  ...OTHER.map(([name, code]): [string, string] => [name, String.fromCharCode(code)]),
]);
const entity = (match: string, name: string) => {
  if (name[0] !== "#") return NAMED_ENTITIES.get(name) ?? NAMED_ENTITIES.get(name.toLowerCase()) ?? match;
  const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
};
// Catalogue abstracts and lineage hold HTML. Block ends become line breaks, real tags (including Word's namespaced ones
// such as <o:p>) and comments are dropped, and a bare "<" or ">" in the text ("errors < 0.1 mGal") is kept.
export function plainText(html: string): string {
  return html.replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table)\s*\/?>/gi, "\n").replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<!--[\s\S]*?-->|<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, entity).replace(/[ \t\r\f\v\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const field = (v: unknown): string => typeof v === "string" ? v
  : v && typeof v === "object" && typeof (v as { default?: unknown }).default === "string" ? (v as { default: string }).default : "";
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

export function recordFrom(source: Record<string, unknown>, ecatId: string): EcatRecord {
  if (String(source.eCatId ?? "") !== ecatId) throw new PipelineError(409, "The catalogue returned a different record.");
  // One legal constraint must be the CC BY 4.0 licence itself, and none may reserve rights or name another licence.
  const constraints = list(source.legalconstraints).map(field).map(plainText).filter(Boolean);
  if (!constraints.some((c) => CC_BY_4_ENTRY.test(c)) || constraints.some((c) => RESTRICTION.test(c))) throw new PipelineError(403, "The catalogue record is not licensed CC BY 4.0.");
  const licence = constraints.join("; ");
  const title = plainText(field(source.resourceTitleObject)), abstract = plainText(field(source.resourceAbstractObject)), lineage = plainText(field(source.lineageObject));
  if (!title || !abstract) throw new PipelineError(422, "The catalogue record has no title or abstract.");
  if (title.length + abstract.length + lineage.length > TEXT_CHARS) throw new PipelineError(413, "The catalogue record exceeds its bound.");
  const ids = list(source.resourceIdentifier).map(record).filter((i) => typeof i.code === "string");
  const code = (space: RegExp) => ids.find((i) => space.test(String(i.codeSpace ?? "")))?.code as string | undefined;
  const pid = code(/persistent identifier/i), doi = code(/digital object identifier/i)?.match(/10\.\d{4,9}\/[^\s"<>]+/)?.[0] ?? null;
  const revision = typeof source.dateStamp === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(source.dateStamp) ? source.dateStamp : "";
  if (!revision) throw new PipelineError(422, "The catalogue record has no revision date.");
  return {
    ecatId, uuid: String(source.uuid ?? ""), title, abstract, lineage, doi,
    pid: pid && /^https:\/\/pid\.geoscience\.gov\.au\/dataset\/ga\/\d+$/.test(pid) ? pid : null,
    organisation: list(source.OrgForResourceObject).map(field).filter(Boolean).join("; "),
    status: list(source.cl_status).map(field).filter(Boolean).join("; "),
    resourceType: list(source.resourceType).map(field).filter(Boolean).join("; "),
    published: date(list(source.resourceDate).map(record).find((d) => d.type === "publication")?.date),
    crs: list(source.crsDetails).map((c) => field(record(c).name)).filter(Boolean).join("; "),
    licence, revision,
  };
}
export async function fetchEcatRecord(ecatId: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<EcatRecord> {
  if (!/^[1-9]\d{0,7}$/.test(ecatId)) throw new PipelineError(400, "Invalid eCat identifier.");
  const response = await fetchImpl(ECAT_SEARCH_URL, { method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity" },
    body: JSON.stringify({ query: { query_string: { query: `eCatId:${ecatId}` } }, size: 2, _source: ECAT_FIELDS }) });
  let body: unknown;
  try { body = JSON.parse((await boundedResponse(response, RECORD_BYTES)).toString("utf8")); } catch (e) { if (e instanceof PipelineError) throw e; throw new PipelineError(502, "The catalogue returned invalid JSON."); }
  const hits = record(record(body).hits).hits;
  if (!Array.isArray(hits) || hits.length !== 1 || !Object.keys(record(record(hits[0])._source)).length) throw new PipelineError(404, "The catalogue has no single record for this eCat identifier.");
  return recordFrom(record(record(hits[0])._source), ecatId);
}
export function renderEcatRecord(r: EcatRecord): Buffer {
  const meta = [`Geoscience Australia catalogue record, eCat ${r.ecatId}`, r.pid && `Persistent identifier: ${r.pid}`, r.doi && `DOI: ${r.doi}`,
    r.organisation && `Organisation: ${r.organisation}`, r.resourceType && `Resource type: ${r.resourceType}`, r.status && `Status: ${r.status}`,
    r.published && `Published: ${r.published}`, r.crs && `Coordinate reference system: ${r.crs}`, `Licence: ${r.licence}`, `Catalogue record revision: ${r.revision}`];
  const blocks: TextBlock[] = [{ text: r.title, size: 14, bold: true }, { text: meta.filter(Boolean).join("\n"), size: 9, gapBefore: 6 },
    { text: "Abstract", size: 12, bold: true, gapBefore: 12 }, { text: r.abstract, gapBefore: 4 },
    ...(r.lineage ? [{ text: "Lineage", size: 12, bold: true, gapBefore: 12 }, { text: r.lineage, gapBefore: 4 }] : []),
    { text: "Rendered by GeoBasin Explorer AI's catalogue importer from the eCat search API. The title, fields, abstract and lineage above are the catalogue record's own.", size: 8, gapBefore: 14 }];
  return textPdf(`${r.title} (eCat ${r.ecatId})`, blocks);
}
export async function ecatRecordArtifact(ecatId: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const r = await fetchEcatRecord(ecatId, signal, fetchImpl), bytes = renderEcatRecord(r);
  return { record: r, bytes, sha256: sha256Of(bytes) };
}
