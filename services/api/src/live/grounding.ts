// A prepared answer computed from public datasets (an analog ranking, unit roles, a basin's depth) keeps its computation
// when a document it cites moves to the live lane. Each passage it cites from such a document is replaced by the same
// text in the current live publication, so the independent check reads the live source and never the packaged copy.
// When any of those passages can't be matched, nothing is replaced and the live agent answers, as before (answer.ts).
import type { Answer5 } from "@/lib/answer5";
import type { Citation } from "@/lib/ask";
import type { Geotag } from "@/lib/geotag";
import type { User } from "../auth";
import { accessFilter } from "../geo";
import { liveCitation, liveFilter, redactLinks } from "./agent-tools";
import type { PublicationManifest } from "./contracts";
import { liveGeotags } from "./geotags";
import type { EvidenceSearch } from "./serving-evidence";
import { liveSourceOf } from "./serving-policy";

// Rules that compute over GA datasets, the World Stress Map and the play tables, citing report pages only in support.
// Legacy-well values and glossary definitions quote the documents themselves, so the live agent keeps answering those.
export const COMPUTED_ON_DATA = /^(Analog question|Same-age question|Resource-flag question|Unit roles|Stratigraphic unit|Basin age|Basin depth|Basin overview|Comparison across|Count of boreholes|Named borehole|Named feature|Faults:|Stress:|Where is a basin|Core photo question)/;
// The share of a packaged passage's words that its live counterpart must contain.
export const MIN_OVERLAP = 0.6;
const words = (s: string) => new Set(s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));
export function overlap(packaged: string, live: string): number {
  const p = words(packaged), l = words(live);
  let n = 0;
  for (const w of p) if (l.has(w)) n++;
  return p.size ? n / p.size : 0;
}
// Plain words only, so nothing in a passage acts as a search operator.
const queryOf = (text: string) => [...words(text)].filter((w) => w.length > 3 && !/^\d+$/.test(w)).slice(0, 40).join(" ");

export interface Grounded { answer: Answer5; matched: { from: string; to: Citation }[] }
export async function groundOnLive(det: Answer5, manifest: PublicationManifest, reader: EvidenceSearch, user: User, signal: AbortSignal): Promise<Grounded | null> {
  if (det.label !== "Precomputed" || !COMPUTED_ON_DATA.test(det.why?.rule ?? "")) return null;
  const citations: Citation[] = [], matched: Grounded["matched"] = [];
  for (const c of det.citations) {
    const source = c.id.startsWith("ds:") ? null : liveSourceOf(c, manifest);
    if (!source) { citations.push(c); continue; }
    const query = queryOf(c.text);
    if (!query) return null;
    const hits = await reader.live(query, `(${accessFilter(user)}) and ${liveFilter(manifest)} and sourceId eq '${source.sourceId.replace(/'/g, "''")}'`, 24, signal);
    let best: { citation: Citation; score: number } | null = null;
    for (const h of hits) {
      const live = liveCitation(h, manifest);
      if (!live) continue;
      // The same page breaks a tie between passages that match equally well.
      const score = overlap(c.text, live.text) + (live.page === c.page ? 0.001 : 0);
      if (!best || score > best.score) best = { citation: live, score };
    }
    if (!best || best.score < MIN_OVERLAP) return null;
    const to: Citation = { ...best.citation, text: redactLinks(best.citation.text), heading: redactLinks(best.citation.heading), doc: redactLinks(best.citation.doc) };
    citations.push(to);
    matched.push({ from: `${c.doc}${c.page ? ` p. ${c.page}` : ""}`, to });
  }
  if (!matched.length) return null;
  const unique = [...new Map(citations.map((c) => [c.id, c])).values()];
  const geo: Record<string, Geotag[]> = Object.fromEntries(unique.map((c) => [c.id, c.live ? liveGeotags(c, manifest) : det.geo?.[c.id] ?? []]));
  return { answer: { ...det, citations: unique, geo }, matched };
}
