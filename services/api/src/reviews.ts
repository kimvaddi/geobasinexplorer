// Expert review: decisions on extracted entities, on values read from the legacy well reports and on
// the low-carbon lens values. Shared by every signed-in reviewer, versioned, with a change log and owner-only rollback.
// Each item has its own partition in table "reviews": row "current" holds its state and rows 000001, 000002, ... its
// history. A decision writes both rows in one transaction, so the history and the current state can't disagree, and
// two reviewers deciding at once can't both take the same version number (the loser retries).
import { APP_DATA, LOWCARBON_DATA } from "@/lib/licensed-data";
import { LICENCE } from "./licence";
import { table } from "./azure";
import { cfg } from "./config";
import { scopedTable } from "./data-scope";
import type { User } from "./auth";

type Status = "accepted" | "rejected" | "edited";
interface Current { status: Status | "cleared"; label?: string; version: number; at: string; by: string }
interface Item { label: string; note: string; value: boolean }
type Field = { fieldId: string; label: string; value: unknown; unit?: string };
type SiteRow = { siteId: string; name: string; fields: Field[] };

const PACK = LICENCE.cloudAppPack(APP_DATA);
const WELLS = PACK.wells;
const LOWC = LICENCE.cloudLowcarbonPack(LOWCARBON_DATA);
const valueText = (f: Field) => `${f.label}: ${String(f.value)}${f.unit ? ` ${f.unit}` : ""}`;
const ITEMS = new Map<string, Item>([
  ...PACK.entities.map((e) => [e.id, { label: e.label, note: "", value: false }] as const),
  ...(WELLS as unknown as SiteRow[]).flatMap((s) => s.fields.map((f) => [`field:${s.siteId}:${f.fieldId}`, { label: valueText(f), note: s.name, value: true }] as const)),
  ...((LOWC as unknown as { sites: SiteRow[] }).sites ?? []).flatMap((s) => s.fields.map((f) => [`lowc:${s.siteId}:${f.fieldId}`, { label: valueText(f), note: `${s.name} (Low-carbon lens)`, value: true }] as const)),
]);

const T = () => table(scopedTable(cfg.dataScope, "reviews"));
const keyOf = (id: string) => Buffer.from(id, "utf8").toString("base64url");
const rowOf = (v: number) => String(v).padStart(6, "0");
const now16 = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const codeOf = (e: unknown) => (e as { statusCode?: number }).statusCode;

async function current(id: string): Promise<(Current & { etag: string }) | null> {
  try {
    const e = await T().getEntity<{ status: Status | "cleared"; label?: string; version: number; at: string; by: string }>(keyOf(id), "current");
    return { status: e.status, label: e.label || undefined, version: Number(e.version), at: e.at, by: e.by, etag: e.etag };
  } catch (err) { if (codeOf(err) === 404) return null; throw err; }
}

/* Writes the next version and the new current state together. */
async function write(id: string, next: (prev: Current | null) => { state: Omit<Current, "version">; action: string; before: string; after: string; note: string }, user: User) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prev = await current(id);
    const version = (prev?.version ?? 0) + 1;
    const n = next(prev);
    const pk = keyOf(id);
    const cur = { partitionKey: pk, rowKey: "current", entity: id, status: n.state.status, label: n.state.label ?? "", version, at: n.state.at, by: user.name };
    const hist = { partitionKey: pk, rowKey: rowOf(version), entity: id, version, action: n.action, status: n.state.status, label: n.state.label ?? "", by: user.name, byId: user.id, at: n.state.at, before: n.before, after: n.after, note: n.note };
    try {
      await T().submitTransaction([prev ? ["update", cur, "Replace", { etag: prev.etag }] : ["create", cur], ["create", hist]]);
      return version;
    } catch (err) {
      if ([409, 412].includes(codeOf(err) ?? 0) || /conflict|precondition/i.test((err as Error).message)) { await new Promise((r) => setTimeout(r, 50 + Math.random() * 150)); continue; }
      throw err;
    }
  }
  throw new Error("Several reviewers changed this item at once; please try again.");
}

export async function listReviews() {
  const review: Record<string, { status: Status; label?: string; at: string; by: string; version: number }> = {};
  const log: { at: string; by: string; entity: string; action: string; before: string; after: string; note: string; version: number }[] = [];
  for await (const e of T().listEntities<{ entity: string; status: Status | "cleared"; label?: string; at: string; by: string; version: number; action?: string; before?: string; after?: string; note?: string }>()) {
    if (!ITEMS.has(e.entity) || LICENCE.referencesWithheld(e)) continue;
    if (e.rowKey === "current") { if (e.status !== "cleared") review[e.entity] = { status: e.status as Status, label: e.label || undefined, at: e.at, by: e.by, version: Number(e.version) }; }
    else log.push({ at: e.at, by: e.by, entity: e.entity, action: e.action ?? "", before: e.before ?? "", after: e.after ?? "", note: e.note ?? "", version: Number(e.version) });
  }
  log.sort((a, b) => b.at.localeCompare(a.at) || b.version - a.version);
  return { review, log: log.slice(0, 300) };
}

export async function decideReview(b: { entityId?: string; status?: string; label?: string; note?: string }, user: User) {
  const id = String(b.entityId ?? "");
  const item = ITEMS.get(id);
  if (!item) return { status: 400, body: { error: "Unknown item." } };
  if (LICENCE.referencesWithheld([b.label, b.note])) return { status: 400, body: { error: "This review refers to evidence withheld until its reuse terms are confirmed." } };
  const status = b.status as Status | "clear";
  if (!["accepted", "rejected", "edited", "clear"].includes(status)) return { status: 400, body: { error: "Status must be accepted, rejected, edited or clear." } };
  const label = status === "edited" ? String(b.label ?? "").trim().slice(0, 120) : undefined;
  if (status === "edited" && !label) return { status: 400, body: { error: "An edit needs the corrected value or label." } };
  const note = [item.note, String(b.note ?? "").slice(0, 300)].filter(Boolean).join(" · ");
  const at = now16();
  const verb = { accepted: "Accepted", rejected: "Rejected", edited: item.value ? "Corrected" : "Edited" } as const;
  const version = await write(id, (prev) => {
    const before = prev?.label ?? item.label;
    if (status === "clear") return { state: { status: "cleared", at, by: user.name }, action: `Cleared ${prev?.status ?? "decision"}`, before, after: item.label, note };
    return { state: { status, label, at, by: user.name }, action: `${verb[status]}${item.value ? " value" : ""}`, before, after: status === "edited" ? label! : before, note };
  }, user);
  return { status: 200, body: { entityId: id, version, state: status === "clear" ? null : { status, label, at, by: user.name, version } } };
}

/* Owner-only: restore the state an item had at an earlier version, as a new version (history is never rewritten). */
export async function rollbackReview(id: string, toVersion: number, user: User) {
  if (!user.owner) return { status: 403, body: { error: "Only the owner can roll back a review." } };
  const item = ITEMS.get(id);
  if (!item || !Number.isInteger(toVersion) || toVersion < 1) return { status: 400, body: { error: "Give an item and a version number." } };
  let old: { status: Status | "cleared"; label?: string };
  try { old = await T().getEntity<{ status: Status | "cleared"; label?: string }>(keyOf(id), rowOf(toVersion)); }
  catch { return { status: 404, body: { error: "That version doesn't exist." } }; }
  if (LICENCE.referencesWithheld(old)) return { status: 404, body: { error: "That version is not available in the cloud build." } };
  const version = await write(id, (prev) => ({
    state: { status: old.status, label: old.label || undefined, at: now16(), by: user.name },
    action: `Rolled back to version ${toVersion}`, before: prev?.label ?? item.label, after: old.label || item.label, note: item.note,
  }), user);
  return { status: 200, body: { entityId: id, version, restoredFrom: toVersion } };
}
