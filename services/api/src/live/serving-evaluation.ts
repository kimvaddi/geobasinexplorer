import type { Bench } from "@/lib/pack";
import { LICENCE } from "../licence";

// The cloud build deliberately strips the withheld keys and excerpts. Keep only their benchmark identities and
// public withholding reason, so a licensing decision cannot quietly improve the denominator.
export const WITHHELD_BENCHMARKS = [
  { id: "Q08", sourceId: "gsq-cr000407", q: "Withheld benchmark Q08", reason: "Reuse terms not confirmed" },
  { id: "Q09", sourceId: "gsq-cr000407", q: "Withheld benchmark Q09", reason: "Reuse terms not confirmed" },
] as const;
export interface EvaluationItem { id: string; q: string; bench?: Bench; blocked?: string; benchmark?: boolean }
export function evaluationBenchmarks(benchmarks: Bench[]): EvaluationItem[] {
  const out = new Map<string, EvaluationItem>();
  for (const b of benchmarks) out.set(b.id, LICENCE.referencesWithheld(b)
    ? { id: b.id, q: `Withheld benchmark ${b.id}`, blocked: "Reuse terms not confirmed", benchmark: true }
    : { id: b.id, q: b.q, bench: b, benchmark: true });
  for (const b of WITHHELD_BENCHMARKS) out.set(b.id, { id: b.id, q: b.q, blocked: b.reason, benchmark: true });
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function blockedEvaluationRow(item: EvaluationItem): Record<string, unknown> {
  if (!item.blocked) throw new Error("Benchmark is not blocked");
  return { id: item.id, q: item.q, benchmark: true, status: "BLOCKED", reason: item.blocked, label: "BLOCKED", validation: "not-run", source: null, facts: null, tokens: 0 };
}
export function evaluationSummary(rows: Record<string, unknown>[]) {
  const blocked = rows.filter((r) => r.status === "BLOCKED"), errors = rows.filter((r) => r.error);
  const eligible = rows.filter((r) => r.status !== "BLOCKED" && !r.error);
  const benchmarks = rows.filter((r) => r.benchmark), measured = eligible.filter((r) => r.benchmark);
  const lat = eligible.map((r) => Number(r.ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (p: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
  const counts = (field: string) => rows.reduce((m: Record<string, number>, r) => { const k = String(r[field] ?? (r.error ? "ERROR" : "unknown")); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const facts = measured.reduce((n, r) => n + (Array.isArray(r.facts) ? Number(r.facts[0]) : 0), 0);
  const factTotal = measured.reduce((n, r) => n + (Array.isArray(r.facts) ? Number(r.facts[1]) : 0), 0);
  return {
    questions: rows.length, eligible: rows.length - blocked.length, blocked: blocked.length, errors: errors.length,
    blockedBenchmarks: blocked.map((r) => ({ id: r.id, reason: r.reason })), labels: counts("label"), validation: counts("validation"),
    citeOrNotFound: `${eligible.filter((r) => r.citeOrNotFound).length}/${rows.length}`,
    expectedSource: `${measured.filter((r) => r.source === true).length}/${benchmarks.length}`,
    keyFacts: `${facts}/${factTotal} eligible facts`,
    foundingGate: { expectedSources: 12, requiredKeyFacts: 46, totalKeyFacts: 51,
      status: benchmarks.length === 12 && !blocked.length && !errors.length && measured.every((r) => r.source === true) && facts >= 46 ? "PASS" : "NOT MET" },
    latencyMs: { p50: pct(0.5), p95: pct(0.95), max: lat.at(-1) ?? null }, tokens: eligible.reduce((n, r) => n + Number(r.tokens ?? 0), 0),
  };
}
