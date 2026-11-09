import type { Answer5 } from "@/lib/answer5";
import type { Bench } from "@/lib/pack";

/* Live test run: a helper for reviewers, not the mark. For each question it checks whether the answer
   cites the expected source and how many key facts from the answer key appear in the answer. */
const norm = (s: string) => s.toLowerCase().replace(/[‐‑–—]/g, "-").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\s+/g, " ");
const STOPCAPS = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by", "with", "this", "that", "these", "it", "its", "no", "not", "yes", "reservoirs", "seals", "source", "rocks", "figure", "page"]);
export function keyFacts(key: string): string[] {
  const out = new Set<string>();
  for (const m of key.matchAll(/\d[\d,]*(?:\.\d+)?/g)) { const v = m[0].replace(/,/g, "").replace(/\.$/, ""); if (v.length >= 2) out.add(v); }
  for (const m of key.matchAll(/\b[A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+)*/g)) {
    const t = m[0].trim().replace(/^(?:The|A|An|In|On|At|By|For|From|With|To|Of)\s+/, ""); const low = t.toLowerCase();
    // A single capitalised word at the start of a sentence is just grammar ("About", "Only"), unless it's an acronym.
    const atStart = m.index === 0 || /[.:;!?]\s*$/.test(key.slice(0, m.index));
    if (!/\s|-/.test(t) && atStart && t !== t.toUpperCase()) continue;
    if (t.length < 4 || STOPCAPS.has(low) || /^(The|A|An|In|On|At|By|For|From|With|This|That|Reservoirs|Seals|Source)$/.test(t)) continue;
    out.add(low);
  }
  return [...out].slice(0, 10);
}
const docTokens = (s: string) => norm(s).replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((t) => t.length > 3 && !["page", "report", "dataset", "data", "table", "tables"].includes(t));
function docMatch(cited: string, expected: string) {
  const x = new Set(docTokens(cited)); const y = docTokens(expected);
  if (!y.length) return false;
  return y.filter((t) => x.has(t) || [...x].some((u) => u.startsWith(t.slice(0, 5)))).length / y.length >= 0.5;
}
export interface AutoCheck { source: boolean | null; facts: [number, number] | null }
export function autoCheck(q: Bench, a: Answer5): AutoCheck {
  const text = norm([...a.paragraphs, ...(a.table ? a.table.rows.flat().map(String) : []), ...a.citations.map((c) => `${c.doc} ${c.heading}`)].join(" "));
  let source: boolean | null = null;
  if (q.evidence.length) {
    source = q.evidence.some((e) => {
      const ep = e as { doc: string; page: number; passage?: string };
      if (ep.passage && a.citations.some((c) => c.id === ep.passage)) return true;
      if (a.citations.some((c) => docMatch(c.doc, ep.doc) && (!ep.page || !c.page || c.page === ep.page))) return true;
      // A table or dataset (page 0) also counts when the answer cites the same basin's package.
      const basin = ["cooper", "adavale", "galilee", "bowen"].find((b) => ep.doc.toLowerCase().includes(b));
      return !ep.page && !!basin && a.citations.some((c) => c.doc.toLowerCase().includes(basin));
    });
  }
  const kf = q.key ? keyFacts(q.key) : [];
  const facts: [number, number] | null = kf.length ? [kf.filter((f) => text.includes(norm(f))).length, kf.length] : null;
  return { source, facts };
}
export interface TestRow { id: string; q: string; label: string; source: boolean | null; facts: [number, number] | null; ms: number }
export interface TestRun { at: string; rows: TestRow[]; totalMs: number; fb?: number; added?: number }
