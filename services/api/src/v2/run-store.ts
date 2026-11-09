// The evidence register of a scientist run, shared by every replica of the tool server (tool-server.ts). Each record is
// keyed by the run and by its stable ID, is written once and never changed, and a second copy that differs is refused,
// as version 1's in-process register refuses conflicting immutable records (live/agent-tools.ts). The cloud store is the
// table "toolruns" in the app's private storage account; local runs and tests keep the register in memory.
import type { TableClient } from "@azure/data-tables";
import type { AgentEvidence } from "../live/agent-tools";

export interface RunStore {
  count(run: string): Promise<number>;
  get(run: string, ids: string[]): Promise<AgentEvidence[]>;
  /** Returns how many of the records were new to the register. */
  add(run: string, entries: AgentEvidence[]): Promise<number>;
  /** How many records the run has registered, and the labels of the latest, newest first: the run's visible progress. */
  recent(run: string, n: number): Promise<{ total: number; labels: string[] }>;
}

const same = (a: AgentEvidence, b: AgentEvidence) => a.text === b.text && a.label === b.label;
const conflict = () => new Error("Conflicting immutable evidence records");

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Map<string, AgentEvidence>>();
  async count(run: string) { return this.runs.get(run)?.size ?? 0; }
  async get(run: string, ids: string[]) {
    const register = this.runs.get(run);
    return ids.flatMap((id) => { const e = register?.get(id); return e ? [structuredClone(e)] : []; });
  }
  async add(run: string, entries: AgentEvidence[]) {
    let register = this.runs.get(run), added = 0;
    if (!register) this.runs.set(run, register = new Map());
    for (const e of entries) {
      const prior = register.get(e.id);
      if (prior) { if (!same(prior, e)) throw conflict(); continue; }
      register.set(e.id, structuredClone(e)); added++;
    }
    return added;
  }
  async recent(run: string, n: number) {
    const all = [...(this.runs.get(run)?.values() ?? [])];
    return { total: all.length, labels: all.slice(-n).reverse().map((e) => e.label) };
  }
}

interface Row { partitionKey: string; rowKey: string; label: string; text: string; citation?: string; computation?: string; savedAt: string }
const status = (e: unknown) => (e as { statusCode?: number }).statusCode;

// A table string property holds at most 64 KiB, so a citation is stored without its copy of the text, which version 1
// keeps identical to the record's own text, and the copy is restored on reading.
export class TableRunStore implements RunStore {
  private created: Promise<void> | null = null;
  constructor(private readonly client: TableClient) {}
  private ready() {
    return this.created ??= this.client.createTable().catch((e) => { if (status(e) !== 409) { this.created = null; throw e; } });
  }
  async count(run: string) {
    await this.ready();
    let n = 0;
    for await (const _ of this.client.listEntities({ queryOptions: { filter: `PartitionKey eq '${run.replace(/'/g, "''")}'`, select: ["RowKey"] } })) n++;
    return n;
  }
  async get(run: string, ids: string[]) {
    await this.ready();
    const out: AgentEvidence[] = [];
    for (const id of ids) {
      try { out.push(fromRow(await this.client.getEntity<Row>(run, id))); } catch (e) { if (status(e) !== 404) throw e; }
    }
    return out;
  }
  async add(run: string, entries: AgentEvidence[]) {
    await this.ready();
    let added = 0;
    for (const e of entries) {
      try { await this.client.createEntity<Row>(toRow(run, e)); added++; }
      catch (err) {
        if (status(err) !== 409) throw err;
        if (!same(fromRow(await this.client.getEntity<Row>(run, e.id)), e)) throw conflict();
      }
    }
    return added;
  }
  async recent(run: string, n: number) {
    await this.ready();
    const rows: { label: string; savedAt: string }[] = [];
    for await (const r of this.client.listEntities<{ label: string; savedAt: string }>({ queryOptions: { filter: `PartitionKey eq '${run.replace(/'/g, "''")}'`, select: ["label", "savedAt"] } })) rows.push({ label: r.label, savedAt: r.savedAt });
    rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return { total: rows.length, labels: rows.slice(0, n).map((r) => r.label) };
  }
}

function toRow(run: string, e: AgentEvidence): Row {
  const citation = e.citation ? JSON.stringify({ ...e.citation, text: undefined }) : undefined;
  return { partitionKey: run, rowKey: e.id, label: e.label, text: e.text, savedAt: new Date().toISOString(),
    ...(citation ? { citation } : {}), ...(e.computation ? { computation: JSON.stringify(e.computation) } : {}) };
}
function fromRow(r: Row): AgentEvidence {
  return { id: r.rowKey, label: r.label, text: r.text, ...(r.citation ? { citation: { ...JSON.parse(r.citation), text: r.text } } : {}),
    ...(r.computation ? { computation: JSON.parse(r.computation) } : {}) };
}
