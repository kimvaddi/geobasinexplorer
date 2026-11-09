// The independent check's verdicts on a prepared answer, reused while nothing it judged has changed (answer.ts
// validateDeterministic). A prepared answer is computed, not written, so the same question over the same data gives the
// same statements against the same evidence every time, and the check, which took 5 to 20 seconds of every prepared
// answer on 8 November 2026, would reach the same verdicts again. The key is a hash of the validator, every statement and
// every piece of evidence it was checked against, the computation record, dataset extracts and cited page texts
// included, so any change in data, publication, wording or validator makes a new key and a fresh check. A verdict is
// reused for at most seven days, and the answer says when the check it reuses was made.
import { createHash } from "node:crypto";
import type { TableClient } from "@azure/data-tables";

export interface StoredVerdict { verdict: string; reason: string }
export interface CachedCheck { verdicts: StoredVerdict[]; checkedAt: string; tokens: number }
export interface VerdictStore { get(key: string): Promise<CachedCheck | null>; put(key: string, check: CachedCheck): Promise<void> }

export const VERDICT_MAX_AGE_MS = 7 * 24 * 3_600_000;
const fresh = (c: CachedCheck | null, now: number) => !!c && now - Date.parse(c.checkedAt) < VERDICT_MAX_AGE_MS;

export function verdictKey(validator: string, claims: { text: string; computed?: boolean }[], evidence: { id: string; label: string; text: string }[]): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, validator, claims: claims.map((c) => [c.text, !!c.computed]), evidence: evidence.map((e) => [e.id, e.label, e.text]) })).digest("hex");
}

export class MemoryVerdictStore implements VerdictStore {
  private readonly checks = new Map<string, CachedCheck>();
  constructor(private readonly max = 1_000, private readonly now = Date.now) {}
  async get(key: string) { const c = this.checks.get(key) ?? null; return fresh(c, this.now()) ? structuredClone(c) : null; }
  async put(key: string, check: CachedCheck) {
    this.checks.delete(key);
    this.checks.set(key, structuredClone(check));
    if (this.checks.size > this.max) this.checks.delete(this.checks.keys().next().value!);
  }
}

const status = (e: unknown) => (e as { statusCode?: number }).statusCode;
/* One row per check in the site's own table; the verdicts are short, well inside a property's 64 KiB. */
export class TableVerdictStore implements VerdictStore {
  private created: Promise<void> | null = null;
  constructor(private readonly client: TableClient, private readonly now = Date.now) {}
  private ready() {
    return this.created ??= this.client.createTable().catch((e) => { if (status(e) !== 409) { this.created = null; throw e; } });
  }
  async get(key: string) {
    await this.ready();
    try {
      const row = await this.client.getEntity<{ verdicts: string; checkedAt: string; tokens: number }>("checks", key);
      const c: CachedCheck = { verdicts: JSON.parse(row.verdicts), checkedAt: row.checkedAt, tokens: Number(row.tokens) || 0 };
      return fresh(c, this.now()) && Array.isArray(c.verdicts) ? c : null;
    } catch (e) { if (status(e) === 404) return null; throw e; }
  }
  async put(key: string, check: CachedCheck) {
    await this.ready();
    await this.client.upsertEntity({ partitionKey: "checks", rowKey: key, verdicts: JSON.stringify(check.verdicts).slice(0, 60_000), checkedAt: check.checkedAt, tokens: check.tokens }, "Replace");
  }
}
