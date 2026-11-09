// Run tickets (docs/FOUNDRY_AGENTS.md, Identity and the run ticket). When the API admits a question for the scientist
// squad it issues a short-lived ticket naming the person, their scope and the run. The workflow sends it as a header on
// every tool call and the model never sees it, and the tool server serves a call only when it carries a valid ticket,
// applying that person's access and place filters from it. The ticket is signed with HMAC-SHA256 under a key that only
// the API holds (GBX_RUN_TICKET_KEY), so it can be neither forged nor widened, and it expires within minutes.
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseNear, type Near } from "../geo";

export const TICKET_PREFIX = "gbx1";
export const TICKET_MAX_MS = 15 * 60_000;
const SKEW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEXT = /^[^\u0000-\u001f]{1,320}$/;

export interface RunTicket {
  /** The run, which keys its evidence register. */
  run: string;
  /** The person the run serves: their object ID, sign-in name, roles and whether they own the app. */
  sub: string; name: string; roles: string[]; owner: boolean;
  /** The Foundry conversation and the caps booking the run belongs to, when they exist. */
  conversation: string; booking: string;
  /** The place the person limited the copilot to, and the live sources the question needs. */
  near: Near | null; requiredSourceIds: string[];
  iat: number; exp: number;
}

const encode = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(`${TICKET_PREFIX}.${payload}`).digest();

export function ticketKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length < 32) throw new Error("GBX_RUN_TICKET_KEY must be at least 32 random bytes, base64-encoded");
  return key;
}

export function issueRunTicket(claims: Omit<RunTicket, "iat" | "exp">, key: Buffer, ttlMs = 10 * 60_000, now = Date.now()): string {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > TICKET_MAX_MS) throw new Error("A run ticket lives at most fifteen minutes");
  const ticket = check({ ...claims, iat: now, exp: now + ttlMs }, now);
  const payload = encode(JSON.stringify(ticket));
  return `${TICKET_PREFIX}.${payload}.${encode(mac(key, payload))}`;
}

export function verifyRunTicket(token: unknown, key: Buffer, now = Date.now()): RunTicket {
  if (typeof token !== "string" || token.length > 4096) throw new Error("Invalid run ticket");
  const [prefix, payload, signature, ...rest] = token.split(".");
  if (prefix !== TICKET_PREFIX || !payload || !signature || rest.length) throw new Error("Invalid run ticket");
  const expected = mac(key, payload), given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("Invalid run ticket");
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Invalid run ticket"); }
  return check(claims, now);
}

// Every claim is checked on issue and on use, so a ticket the API signed by mistake is refused as well.
function check(value: unknown, now: number): RunTicket {
  const t = value as Record<string, unknown>;
  const keys = ["booking", "conversation", "exp", "iat", "name", "near", "owner", "requiredSourceIds", "roles", "run", "sub"];
  if (!t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).sort().join() !== keys.join()) throw new Error("Invalid run ticket");
  const strings = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && TEXT.test(s));
  if (typeof t.run !== "string" || !UUID.test(t.run) || typeof t.sub !== "string" || !TEXT.test(t.sub) || typeof t.name !== "string" || t.name.length > 320
    || typeof t.owner !== "boolean" || !strings(t.roles, 16) || !strings(t.requiredSourceIds, 16)
    || typeof t.conversation !== "string" || t.conversation.length > 200 || typeof t.booking !== "string" || t.booking.length > 200
    || typeof t.iat !== "number" || typeof t.exp !== "number" || !Number.isSafeInteger(t.iat) || !Number.isSafeInteger(t.exp)) throw new Error("Invalid run ticket");
  if (t.exp <= now) throw new Error("Expired run ticket");
  if (t.iat > now + SKEW_MS || t.exp - t.iat > TICKET_MAX_MS || t.exp <= t.iat) throw new Error("Invalid run ticket");
  let near: Near | null = null;
  if (t.near !== null) { try { near = parseNear(t.near); } catch { throw new Error("Invalid run ticket"); } }
  return { run: t.run, sub: t.sub, name: t.name, roles: [...t.roles as string[]], owner: t.owner, conversation: t.conversation, booking: t.booking,
    near, requiredSourceIds: [...t.requiredSourceIds as string[]], iat: t.iat, exp: t.exp };
}
