// Usage caps kept in Table storage: one row per counter per UTC day, and one per UTC month. They fail closed:
// if the counters can't be read or written, the request is refused rather than allowed through.
// Work whose size is only known afterwards (model tokens) is booked up front, topped up before any call that could use
// more, and settled to the real figure later. Bookings, top-ups and settlements are each applied exactly once (a marker
// row in the same transaction), and if settling fails the booking stays counted, so errors only make the cap stricter.
import { RestError } from "@azure/storage-blob";
import { table } from "./azure";
import { cfg } from "./config";
import { counterKeys } from "./data-scope";

export type Period = "day" | "month";
export class CapError extends Error {
  constructor(public readonly what: string, public readonly limit: number, public readonly per: Period = "day") {
    super(per === "day"
      ? `Daily limit reached: ${what} (${limit} a day). It resets at midnight UTC.`
      : `Monthly limit reached: ${what} (${limit} a month). It resets on the first day of next month (UTC).`);
  }
}
const partitionOf = (per: Period, at = new Date()) => { const iso = at.toISOString(); return per === "day" ? iso.slice(0, 10) : `month-${iso.slice(0, 7)}`; };

async function read(key: string, pk: string): Promise<{ n: number; etag?: string }> {
  try {
    const e = await table("usage").getEntity<{ n: number }>(pk, key);
    return { n: Number(e.n) || 0, etag: e.etag };
  } catch (err) {
    if ((err as RestError).statusCode === 404) return { n: 0 };
    throw new Error("Usage limits could not be checked, so the request was refused.");
  }
}

/* Refuse if adding `amount` would pass `limit`; otherwise record it, with optimistic concurrency on the row. */
async function bump(key: string, pk: string, amount: number, limit: number, what: string, per: Period): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await read(key, pk);
    if (amount > 0 && cur.n + amount > limit) throw new CapError(what, limit, per);
    try {
      if (cur.etag) await table("usage").updateEntity({ partitionKey: pk, rowKey: key, n: Math.max(0, cur.n + amount) }, "Replace", { etag: cur.etag });
      else await table("usage").createEntity({ partitionKey: pk, rowKey: key, n: Math.max(0, amount) });
      return cur.n + amount;
    } catch (err) {
      const code = (err as RestError).statusCode;
      if (code === 409 || code === 412) { await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1))); continue; }
      throw new Error("Usage limits could not be recorded, so the request was refused.");
    }
  }
  throw new Error("Usage limits are busy; try again in a moment.");
}

export async function take(key: string, amount: number, limit: number, what: string, per: Period = "day"): Promise<number> {
  return bump(key, partitionOf(per), amount, limit, what, per);
}

/* The monthly limit is checked first because it is the one that protects the budget. */
export async function takeBoth(key: string, amount: number, perDay: number, perMonth: number, what: string): Promise<void> {
  await take(key, amount, perMonth, what, "month");
  await take(key, amount, perDay, what, "day");
}

export interface Reservation { id: string; key: string; amount: number; day: string; month: string; tops: number }
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const isConflict = (err: unknown) => { const e = err as RestError & { code?: string }; return e.statusCode === 409 || e.statusCode === 412 || /AlreadyExists|ConditionNotSatisfied|ConditionNotMet/i.test(`${e.code ?? ""} ${e.message ?? ""}`); };
async function exists(pk: string, rk: string): Promise<boolean> {
  try { await table("usage").getEntity(pk, rk); return true; }
  catch (err) { if ((err as RestError).statusCode === 404) return false; throw new Error("Usage limits could not be checked, so the request was refused."); }
}

/* Apply `amount` to a counter exactly once. The counter update and a marker row named after the operation are written
   in one transaction, so a retry after a lost reply finds the marker and stops instead of applying the amount twice. */
async function applyOnce(key: string, pk: string, amount: number, limit: number, what: string, per: Period, op: string): Promise<void> {
  const marker = `op-${op}-${key}`.slice(0, 250);
  let unclear = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await exists(pk, marker)) return;
    const cur = await read(key, pk);
    if (amount > 0 && cur.n + amount > limit) throw new CapError(what, limit, per);
    const counter = { partitionKey: pk, rowKey: key, n: Math.max(0, cur.n + amount) };
    try {
      await table("usage").submitTransaction([cur.etag ? ["update", counter, "Replace", { etag: cur.etag }] : ["create", counter], ["create", { partitionKey: pk, rowKey: marker, amount, at: new Date().toISOString() }]]);
      return;
    } catch (err) {
      // A conflict means someone else counted at the same moment. Any other error may have committed with its reply
      // lost, so the next round looks for the marker before trying again.
      if (!isConflict(err) && ++unclear > 2) throw new Error("Usage limits could not be recorded, so the request was refused.");
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
    }
  }
  throw new Error("Usage limits are busy; try again in a moment.");
}

/* Book `amount` against both caps before the work starts. Fails closed like takeBoth. */
export async function reserve(key: string, amount: number, perDay: number, perMonth: number, what: string): Promise<Reservation> {
  const now = new Date();
  const r: Reservation = { id: newId(), key, amount, day: partitionOf("day", now), month: partitionOf("month", now), tops: 0 };
  await applyOnce(key, r.month, amount, perMonth, what, "month", `${r.id}-book`);
  try { await applyOnce(key, r.day, amount, perDay, what, "day", `${r.id}-book`); }
  catch (e) { await applyOnce(key, r.month, -amount, Number.MAX_SAFE_INTEGER, what, "month", `${r.id}-unbook`).catch(() => {}); throw e; }
  return r;
}

/* Book more before a call that could pass the current booking is sent. Fails closed: over the cap, the call isn't made. */
export async function topUp(r: Reservation, extra: number, perDay: number, perMonth: number, what: string): Promise<void> {
  if (extra <= 0) return;
  const op = `${r.id}-top${++r.tops}`;
  await applyOnce(r.key, r.month, extra, perMonth, what, "month", op);
  try { await applyOnce(r.key, r.day, extra, perDay, what, "day", op); }
  catch (e) { await applyOnce(r.key, r.month, -extra, Number.MAX_SAFE_INTEGER, what, "month", `${op}-undo`).catch(() => {}); throw e; }
  r.amount += extra;
}

/* Replace the booking with what was really used, in the same day and month it was booked in, exactly once. `used` is
   null when the real figure is unknown (a call failed part-way): the booking then stays counted in full. */
export async function settle(r: Reservation, used: number | null): Promise<void> {
  if (used === null) return;
  const delta = Math.ceil(used) - r.amount;
  if (!delta) return;
  for (const [pk, per] of [[r.month, "month"], [r.day, "day"]] as const) {
    // Never refuses: the tokens are already spent. A failure leaves the booking counted, which only errs on the safe side.
    await applyOnce(r.key, pk, delta, Number.MAX_SAFE_INTEGER, r.key, per, `${r.id}-settle`).catch((e) => console.warn(JSON.stringify({ m: "usage settle failed", key: r.key, delta, error: (e as Error).message })));
  }
}

/* Count work that has already happened (it can't be refused any more), on both the day and the month. */
export async function record(key: string, amount: number): Promise<void> {
  const op = newId();
  await applyOnce(key, partitionOf("month"), amount, Number.MAX_SAFE_INTEGER, key, "month", op);
  await applyOnce(key, partitionOf("day"), amount, Number.MAX_SAFE_INTEGER, key, "day", op);
}

export const keys = counterKeys(cfg.dataScope);
