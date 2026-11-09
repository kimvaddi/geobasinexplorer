// Version 2's Co-Scientist (docs/FOUNDRY_AGENTS.md, "How the app calls the squad"). In version 2, "Run the agents"
// starts the hosted agent gbx-coscientist for the signed-in person as a stored background response, and the browser polls
// until it ends, because a squad can outlast Front Door's 120-second origin timeout. Before a run the API checks the kill
// switch and the caps and issues the run ticket that the agents' tool calls must carry. It sends the person's object ID as
// x-ms-user-identity, so Foundry keeps the run in that person's own session, and it binds the run to that person with a
// signed handle, because Foundry doesn't fence one delegated person from another
// (https://learn.microsoft.com/azure/foundry/agents/how-to/isolate-sessions-per-user). When a run ends, the API checks
// the result again at its own gate before anyone sees it: every statement must cite a source passage in this run's
// evidence register, and every number in it must appear in that evidence or in the person's own statement, by version 1's
// number check. Only then are the sources attached.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../auth";
import { liveNumberCheck } from "../live/agent-answer";
import type { AgentEvidence } from "../live/agent-tools";
import type { RunStore } from "./run-store";
import { issueRunTicket } from "./run-ticket";
import type { PersonAuth } from "./obo";
import type { Reservation } from "../usage";

export const COSCI_PATH = "/api/v2/cosci";
export const SPECIALISTS = ["literature", "stratigraphy", "spatial", "rock", "stress"] as const;
export const STATEMENT_MAX = 1000;
const HANDLE_PREFIX = "gbxh1";
const HANDLE_MS = 30 * 60_000;
const TICKET_MS = 15 * 60_000;
const METADATA_PART = 512, METADATA_PARTS = 4;
const USER_IDENTITY = /^[A-Za-z0-9._:@-]{1,256}$/;
const RESPONSE_ID = /^[A-Za-z0-9_-]{8,200}$/;
const EVIDENCE_ID = /^[LPTK][0-9a-f]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The hosted agent's Responses endpoint ------------------------------------------------------------------------------
export class AgentEndpointError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface FoundryResponse {
  id?: string; status?: string; output?: unknown; error?: { message?: string } | null;
  agent_session_id?: string; created_at?: number; completed_at?: number | null;
  /* The agent version that served the response; a session stays on the version that created it. */
  agent_reference?: { name?: string; version?: string };
  /* Set by foundryAgentEndpoint.start: whose token started the run, the person's own or the app's. */
  gbx_identity?: "person" | "app";
}
export interface AgentEndpoint {
  /* With `person`, the run starts with the person's own token, so the scientists can ask Fabric IQ as them;
     if Foundry refuses that, or the exchange fails, it starts with the app's identity, and gbx_identity says which. */
  start(body: Record<string, unknown>, userIdentity: string, signal: AbortSignal, person?: PersonAuth | null): Promise<FoundryResponse>;
  get(responseId: string, userIdentity: string, signal: AbortSignal, person?: PersonAuth | null): Promise<FoundryResponse>;
}

/* Calls the agent with a token for https://ai.azure.com from an identity holding Foundry Agent Consumer and the custom
   impersonation role on the agent (infra/scripts/grant-agent-caller.sh).
   Foundry starts every call that names no session in a new sandbox, a cold start of several seconds, while a call that
   names a session in its request body lands in that sandbox (Microsoft Learn, Manage hosted agent sessions). So each
   endpoint remembers each person's last session on its agent and names it again while the sandbox is still warm, inside
   the agent version's idle timeout (deploy_hosted.py). A session stays on the agent version that created it, so a
   session is named again only while it is on the newest version, which every start without a session reports; at least
   every ten minutes one start goes without a session to notice a newly deployed version. Foundry keeps every session to
   the person it was made for, and if it refuses one, the call is made again without it. Every start asks for Foundry's
   latency headers and logs them.
   A run started with the person's own token (v2/obo.ts) needs no x-ms-user-identity, since the token itself
   names the person, and its sessions are kept apart from the app's, because a session belongs to the identity that made
   it. The run's metadata says which identity started it (gbx_identity), so the scientists ask Fabric IQ only as a person
   (host.py). */
export const SESSION_WARM_MS = 25 * 60_000;
export const VERSION_CHECK_MS = 10 * 60_000;
const SESSIONS_MAX = 2_000;
export interface EndpointOptions { warmMs?: number; now?: () => number; log?(message: string, detail: Record<string, unknown>): void }

export function foundryAgentEndpoint(projectEndpoint: string, agent: string, token: () => Promise<string>, opts: EndpointOptions = {}): AgentEndpoint {
  const base = `${projectEndpoint.replace(/\/+$/, "")}/agents/${encodeURIComponent(agent)}/endpoint/protocols/openai/responses`;
  const now = opts.now ?? Date.now, warmMs = opts.warmMs ?? SESSION_WARM_MS;
  const sessions = new Map<string, { id: string; at: number; version: string | null }>();
  let newest: { version: string; seenAt: number } | null = null;
  type Auth = { bearer: () => Promise<string>; person: boolean };
  const asApp: Auth = { bearer: token, person: false };
  const kind = (a: Auth) => a.person ? "person" as const : "app" as const;
  const remember = (key: string, id: unknown, version: string | null) => {
    if (typeof id !== "string" || !id) return;
    sessions.delete(key);
    sessions.set(key, { id, at: now(), version });
    if (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value!);
  };
  const call = async (url: string, init: RequestInit, userIdentity: string, auth: Auth, signal: AbortSignal, debug = false): Promise<{ body: FoundryResponse; headers: Headers }> => {
    const r = await fetch(url, { ...init, signal, headers: { Authorization: `Bearer ${await auth.bearer()}`, "Content-Type": "application/json",
      ...(auth.person ? {} : { "x-ms-user-identity": userIdentity }), ...(debug ? { "x-ms-debug-latency-enabled": "true" } : {}) } });
    const body = (await r.json().catch(() => ({}))) as FoundryResponse;
    if (!r.ok) throw new AgentEndpointError(String(body?.error?.message ?? `HTTP ${r.status}`).slice(0, 300), r.status);
    return { body, headers: r.headers };
  };
  const post = (body: Record<string, unknown>, userIdentity: string, auth: Auth, signal: AbortSignal) =>
    call(`${base}?api-version=v1`, { method: "POST", body: JSON.stringify(body) }, userIdentity, auth, signal, true);
  const startAs = async (request: Record<string, unknown>, userIdentity: string, signal: AbortSignal, auth: Auth): Promise<FoundryResponse> => {
    const key = `${kind(auth)}:${userIdentity}`;
    const body = { ...request, metadata: { ...(request.metadata as Record<string, string> | undefined), gbx_identity: kind(auth) } };
    const known = sessions.get(key);
    const current = newest && now() - newest.seenAt < VERSION_CHECK_MS ? newest.version : null;
    const reuse = known && current && known.version === current && now() - known.at < warmMs ? known.id : null;
    let res: { body: FoundryResponse; headers: Headers };
    try { res = await post(reuse ? { ...body, agent_session_id: reuse } : body, userIdentity, auth, signal); }
    catch (e) {
      if (!reuse || !(e instanceof AgentEndpointError) || e.status >= 500 || signal.aborted) throw e;
      sessions.delete(key);
      opts.log?.("agent session refused, starting a new one", { agent, status: e.status, error: e.message });
      res = await post(body, userIdentity, auth, signal);
    }
    const version = typeof res.body.agent_reference?.version === "string" ? res.body.agent_reference.version : null;
    const reused = !!reuse && res.body.agent_session_id === reuse;
    // A start without a session runs on the newest version, so it says which version is current. A reused session stays on
    // the version that made it, although its response names the agent's newest version: on 8 November 2026 a session made
    // on version 15 answered as version 16 and still ran version 15's code.
    if (!reused && version) newest = { version, seenAt: now() };
    const sessionVersion = reused ? known!.version : version;
    remember(key, res.body.agent_session_id, sessionVersion);
    const h = (name: string) => res.headers.get(`x-ms-debug-latency-${name}`);
    opts.log?.("agent start", { agent, identity: kind(auth), version: sessionVersion, newest: version, session: reused ? "reused" : "new", start: h("session-start-type"),
      beginMs: Number(h("response-begin-ms")) || null, readinessMs: Number(h("container-readiness-ms")) || null });
    return { ...res.body, gbx_identity: kind(auth) };
  };
  return {
    async start(body, userIdentity, signal, person) {
      if (person) {
        try { return await startAs(body, userIdentity, signal, { bearer: person, person: true }); }
        catch (e) {
          // Foundry refusing the person (no Foundry Agent Consumer role, no consent) or a failed exchange leaves the run to
          // the app's identity, whose scientists use the typed knowledge tools; Foundry itself failing is passed on.
          if (signal.aborted || (e instanceof AgentEndpointError && e.status >= 500)) throw e;
          opts.log?.("agent start as the person failed, starting as the app", { agent, status: e instanceof AgentEndpointError ? e.status : null,
            error: String((e as Error)?.message ?? e).slice(0, 200) });
        }
      }
      return startAs(body, userIdentity, signal, asApp);
    },
    async get(id, userIdentity, signal, person) {
      let auth = asApp;
      if (person) {
        try { const t = await person(); auth = { bearer: async () => t, person: true }; }
        catch (e) { opts.log?.("no token on the person's behalf for a poll, polling as the app", { agent, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
      }
      const key = `${kind(auth)}:${userIdentity}`;
      const { body } = await call(`${base}/${encodeURIComponent(id)}?api-version=v1`, { method: "GET" }, userIdentity, auth, signal);
      // A finished run restarts its sandbox's idle timer, so the person's session stays warm from here.
      const known = sessions.get(key);
      if (known && body.status !== "queued" && body.status !== "in_progress" && known.id === body.agent_session_id) remember(key, known.id, known.version);
      return body;
    },
  };
}

/* A metadata value holds at most 512 characters, so the ticket is split over gbx_ticket_0 to gbx_ticket_3 (host.py). */
export function ticketMetadata(ticket: string): Record<string, string> {
  if (ticket.length > METADATA_PART * METADATA_PARTS) throw new Error("The run ticket is too long for the request metadata");
  const out: Record<string, string> = {};
  for (let i = 0; i * METADATA_PART < ticket.length; i++) out[`gbx_ticket_${i}`] = ticket.slice(i * METADATA_PART, (i + 1) * METADATA_PART);
  return out;
}

// The run handle: which run and response belong to which person, and the run's token booking -------------------------
/* idn is present when the person's own token started the run, so its status is read the same way. */
export interface RunHandle { run: string; response: string; sub: string; statement: string; booking?: Reservation | null; idn?: "person"; iat: number; exp: number }
const handleMac = (key: Buffer, payload: string) => createHmac("sha256", key).update(`${HANDLE_PREFIX}.${payload}`).digest();

export function issueHandle(h: Omit<RunHandle, "iat" | "exp">, key: Buffer, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...h, iat: now, exp: now + HANDLE_MS })).toString("base64url");
  return `${HANDLE_PREFIX}.${payload}.${handleMac(key, payload).toString("base64url")}`;
}

export function verifyHandle(token: unknown, key: Buffer, now = Date.now()): RunHandle {
  const bad = () => new Error("Invalid run handle");
  if (typeof token !== "string" || token.length > 4096) throw bad();
  const [prefix, payload, signature, ...rest] = token.split(".");
  if (prefix !== HANDLE_PREFIX || !payload || !signature || rest.length) throw bad();
  const expected = handleMac(key, payload), given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  let h: RunHandle;
  try { h = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RunHandle; } catch { throw bad(); }
  const r = h?.booking;
  if (!h || typeof h.run !== "string" || !UUID.test(h.run) || typeof h.response !== "string" || !RESPONSE_ID.test(h.response)
    || typeof h.sub !== "string" || !USER_IDENTITY.test(h.sub) || typeof h.statement !== "string" || h.statement.length > STATEMENT_MAX
    || (r != null && (typeof r !== "object" || typeof r.id !== "string" || typeof r.key !== "string" || !Number.isFinite(r.amount)))
    || (h.idn !== undefined && h.idn !== "person") || !Number.isSafeInteger(h.iat) || !Number.isSafeInteger(h.exp)) throw bad();
  if (h.exp <= now) throw new Error("Expired run handle");
  return h;
}

// The squad's result, read defensively: it crossed a service boundary -------------------------------------------------
type Stance = "for" | "against" | "context";
type Status = "answered" | "not_found" | "validation_incomplete" | "blocked";
export interface Said { kind: "fact" | "interpretation"; stance: Stance; text: string; cites: string[] }
interface SaidFinding { specialist: string; chosen: boolean; statements: Said[]; missing: string[]; error: string | null; ms: number }
export interface SquadUsage { input: number; output: number; total: number; runs: number }
export interface SquadOutput {
  status: Status; sentences: Said[]; missing: string[]; dissent: string[]; verdicts: string[]; findings: SaidFinding[]; notes: string[];
  /* What the critic raised when it sent a draft back, whether the lead revised it, the run's tokens, and the statements
     the scientists removed with their reasons: those the critic still disputed after the revision, and those the
     validator couldn't confirm. */
  critique: string[]; rebutted: boolean; usage: SquadUsage | null; removed: { text: string; why: string; by: "critic" | "validator" }[];
  /* How the run asked Fabric IQ as the person: questions asked and answered, the time they took, and why it
     last fell back to the typed knowledge tools; null when it wasn't offered. */
  knowledge: SquadKnowledge | null;
}
export interface SquadKnowledge { asked: number; answered: number; ms: number; fallback: string }

export function outputText(r: FoundryResponse): string {
  const items = Array.isArray(r.output) ? r.output as { type?: string; content?: { type?: string; text?: unknown }[] }[] : [];
  return items.flatMap((i) => i?.type === "message" && Array.isArray(i.content)
    ? i.content.flatMap((c) => c?.type === "output_text" && typeof c.text === "string" ? [c.text] : []) : []).join("");
}

const texts = (v: unknown, max: number, len = 2000): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= len) ? v as string[] : null;
function said(v: unknown): Said | null {
  const s = v as Record<string, unknown>;
  if (!s || typeof s !== "object" || !["fact", "interpretation"].includes(s.kind as string) || !["for", "against", "context"].includes(s.stance as string)
    || typeof s.text !== "string" || !s.text.trim() || s.text.length > 2000) return null;
  const cites = texts(s.cites, 12, 11);
  if (!cites || !cites.every((c) => EVIDENCE_ID.test(c))) return null;
  return { kind: s.kind as Said["kind"], stance: s.stance as Stance, text: s.text.trim(), cites };
}
const saidAll = (v: unknown, max: number): Said[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = v.map(said);
  return out.every(Boolean) ? out as Said[] : null;
};

export function parseOutput(text: string): SquadOutput | null {
  let r: Record<string, unknown>;
  try { r = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!r || typeof r !== "object" || !["answered", "not_found", "validation_incomplete", "blocked"].includes(r.status as string)) return null;
  const sentences = saidAll(r.sentences ?? [], 14), missing = texts(r.missing ?? [], 24), dissent = texts(r.dissent ?? [], 24), notes = texts(r.notes ?? [], 24);
  if (!sentences || !missing || !dissent || !notes || !Array.isArray(r.verdicts ?? []) || !Array.isArray(r.findings ?? [])) return null;
  const verdicts = (r.verdicts as { verdict?: unknown }[] ?? []).slice(0, 14).map((v) => String(v?.verdict ?? ""));
  const findings: SaidFinding[] = [];
  for (const f of (r.findings as Record<string, unknown>[] ?? []).slice(0, SPECIALISTS.length)) {
    const statements = saidAll(f?.statements ?? [], 14), fm = texts(f?.missing ?? [], 24);
    if (!f || !SPECIALISTS.includes(f.specialist as never) || typeof f.chosen !== "boolean" || !statements || !fm) return null;
    findings.push({ specialist: f.specialist as string, chosen: f.chosen, statements, missing: fm,
      error: typeof f.error === "string" ? f.error.slice(0, 300) : null, ms: Number.isFinite(f.ms) ? Math.max(0, Math.round(f.ms as number)) : 0 });
  }
  const critique = texts(r.critique ?? [], 24) ?? [];
  const u = r.usage as Record<string, unknown> | null | undefined;
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
  const usage = u && typeof u === "object" && count(u.total) !== null
    ? { input: count(u.input) ?? 0, output: count(u.output) ?? 0, total: count(u.total)!, runs: count(u.runs) ?? 0 } : null;
  const removed = (Array.isArray(r.removed) ? r.removed as Record<string, unknown>[] : []).slice(0, 14)
    .filter((x) => x && typeof x.text === "string" && typeof x.why === "string")
    .map((x) => ({ text: String(x.text).slice(0, 2000), why: String(x.why).slice(0, 600), by: x.by === "critic" ? "critic" as const : "validator" as const }));
  const k = r.knowledge as Record<string, unknown> | null | undefined;
  const knowledge = k && typeof k === "object" && count(k.asked) !== null
    ? { asked: count(k.asked)!, answered: Math.min(count(k.answered) ?? 0, count(k.asked)!), ms: count(k.ms) ?? 0,
      fallback: typeof k.fallback === "string" ? k.fallback.replace(/[^\w .,()-]/g, "").slice(0, 80) : "" } : null;
  return { status: r.status as Status, sentences, missing, dissent, verdicts, findings, notes, critique, rebutted: r.rebutted === true, usage, removed, knowledge };
}

// The app's own gate ---------------------------------------------------------------------------------------------------
export interface ShownStatement { kind: Said["kind"]; stance: Stance; text: string; by: string[]; sources: { id: string; label: string }[] }
export interface CoSciResult {
  /* removed lists every statement taken out before anyone saw it, and who took it out: the critic, the validator or the
     app's own gate. */
  status: Status; statements: ShownStatement[]; removed: { text: string; why: string; by: "critic" | "validator" | "app" }[]; missing: string[]; dissent: string[];
  tally: { for: number; against: number; context: number; missing: number };
  scientists: { id: string; chosen: boolean; reported: number; inAnswer: number; missing: string[]; error: string | null; ms: number }[];
  checked: { judged: number; supported: number }; notes: string[]; session: string | null; ms: number | null;
}

/* The app's own gate for one statement, shared with the copilot (v2/copilot.ts): every cited ID must be in this run's
   register, at least one must be a source passage, and every number must be in that evidence or in the person's words. */
export function checkSaid(s: Pick<Said, "text" | "cites">, known: Map<string, AgentEvidence>, statement: string): string | null {
  const cited = [...new Set(s.cites)];
  if (!cited.length) return "it cites no evidence";
  const evidence = cited.map((id) => known.get(id));
  if (evidence.some((e) => !e)) return "it cites evidence this run did not retrieve";
  const found = evidence as AgentEvidence[], citations = found.flatMap((e) => e.citation ? [e.citation] : []);
  if (!citations.length) return "it cites no source passage";
  // Repeating a number from the person's own statement claims nothing from the evidence (FOUNDRY_AGENTS.md, number check).
  return liveNumberCheck(s.text, [...found.map((e) => e.text), statement].join("\n"), citations.map((c) => ({ page: c.page, doc: c.doc })));
}

export async function gate(out: SquadOutput, h: RunHandle, store: RunStore, meta: { session: string | null; ms: number | null }): Promise<CoSciResult> {
  const ids = [...new Set([...out.sentences, ...out.findings.flatMap((f) => f.statements)].flatMap((s) => s.cites))];
  const known = new Map((ids.length ? await store.get(h.run, ids) : []).map((e) => [e.id, e]));
  const removed: CoSciResult["removed"] = out.removed.map((r) => ({ ...r })), kept: Said[] = [];
  for (const s of out.sentences) { const w = checkSaid(s, known, h.statement); if (w) removed.push({ text: s.text, why: w, by: "app" }); else kept.push(s); }
  // A statement is credited to every chosen scientist who cited any of its evidence, in the workspace's order, because the
  // lead often merges what two scientists found into one statement.
  const by = (s: Said) => SPECIALISTS.filter((id) => out.findings.some((f) => f.specialist === id && f.chosen && f.statements.some((x) => x.cites.some((c) => s.cites.includes(c)))));
  const statements: ShownStatement[] = kept.map((s) => ({ kind: s.kind, stance: s.stance, text: s.text, by: by(s),
    sources: [...new Set(s.cites)].map((id) => ({ id, label: known.get(id)!.label })) }));
  const count = (st: Stance) => statements.filter((s) => s.stance === st).length;
  return {
    status: out.status === "answered" && !statements.length ? "validation_incomplete" : out.status,
    statements, removed, missing: out.missing, dissent: out.dissent,
    tally: { for: count("for"), against: count("against"), context: count("context"), missing: out.missing.length },
    scientists: SPECIALISTS.map((id) => {
      const f = out.findings.find((x) => x.specialist === id);
      return { id, chosen: !!f?.chosen, reported: f?.statements.length ?? 0, inAnswer: statements.filter((s) => s.by.includes(id)).length, missing: f?.missing ?? [], error: f?.error ?? null, ms: f?.ms ?? 0 };
    }),
    checked: { judged: out.verdicts.length, supported: out.verdicts.filter((v) => v === "supported").length },
    notes: out.notes, session: meta.session, ms: meta.ms,
  };
}

// Routes -------------------------------------------------------------------------------------------------------------
export interface CoScientistDeps {
  endpoint: AgentEndpoint; store: RunStore; ticketKey(): Buffer;
  who(req: FastifyRequest): User; fail(reply: FastifyReply, e: unknown): unknown;
  /** Counts the run against the caps and books a squad's tokens, refusing at a cap; the booking is settled when it ends. */
  aiEnabled(): boolean; book(user: User): Promise<Reservation | null>; settle(booking: Reservation, used: number | null): Promise<void>;
  log?(message: string, detail: Record<string, unknown>): void;
  /** Tokens on the person's behalf, so the scientists can ask Fabric IQ as them (v2/obo.ts); absent, runs start as the app. */
  person?(user: User): PersonAuth | null;
}

export function registerCoScientist(app: FastifyInstance, deps: CoScientistDeps): void {
  const unreachable = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof AgentEndpointError)) return deps.fail(reply, e);
    deps.log?.("scientists unreachable", { status: e.status, error: e.message });
    return reply.code(502).send({ error: `The scientists couldn't be reached (${e.status}). The rules over the bundled data still work.` });
  };

  app.post<{ Body: { statement?: unknown } }>(COSCI_PATH, async (req, reply) => {
    try {
      const user = deps.who(req);
      const statement = typeof req.body?.statement === "string" ? req.body.statement.replace(/\s+/g, " ").trim() : "";
      if (!statement || statement.length > STATEMENT_MAX) return reply.code(400).send({ error: `Write a statement of up to ${STATEMENT_MAX.toLocaleString("en")} characters.` });
      if (!deps.aiEnabled()) return reply.code(503).send({ error: "Model calls are switched off, so the scientists can't run. The rules over the bundled data still work." });
      if (!USER_IDENTITY.test(user.id)) return reply.code(403).send({ error: "Your sign-in can't be tied to a run." });
      const booking = await deps.book(user);
      const key = deps.ticketKey(), run = randomUUID();
      let started: FoundryResponse;
      try {
        const ticket = issueRunTicket({ run, sub: user.id, name: user.name, roles: user.roles, owner: user.owner, conversation: "", booking: booking?.id ?? "", near: null, requiredSourceIds: [] }, key, TICKET_MS);
        started = await deps.endpoint.start({ input: statement, background: true, store: true, metadata: ticketMetadata(ticket) }, user.id, AbortSignal.timeout(30_000), deps.person?.(user));
        if (typeof started.id !== "string" || !RESPONSE_ID.test(started.id)) throw new AgentEndpointError("no response ID", 502);
      } catch (e) {
        // Nothing ran, so the tokens booked for it are given back.
        if (booking) await deps.settle(booking, 0).catch(() => {});
        throw e;
      }
      return { handle: issueHandle({ run, response: started.id, sub: user.id, statement, booking, ...(started.gbx_identity === "person" ? { idn: "person" as const } : {}) }, key), status: "running" };
    } catch (e) { return unreachable(reply, e); }
  });

  app.post<{ Body: { handle?: unknown } }>(`${COSCI_PATH}/status`, async (req, reply) => {
    try {
      const user = deps.who(req);
      let h: RunHandle;
      try { h = verifyHandle(req.body?.handle, deps.ticketKey()); } catch { return reply.code(404).send({ error: "This run has ended or can't be found. Run the agents again." }); }
      if (h.sub !== user.id) return reply.code(403).send({ error: "This run belongs to someone else." });
      const r = await deps.endpoint.get(h.response, user.id, AbortSignal.timeout(20_000), h.idn === "person" ? deps.person?.(user) : null);
      const elapsedMs = Date.now() - h.iat;
      if (r.status === "queued" || r.status === "in_progress") return { status: "running", elapsedMs };
      if (r.status !== "completed") {
        deps.log?.("scientists run did not complete", { status: r.status, error: r.error?.message?.slice(0, 300) });
        return { status: "failed", error: "The scientists couldn't finish this run.", elapsedMs };
      }
      const out = parseOutput(outputText(r));
      // The booking is replaced by what the scientists report, once however often this is polled (usage.ts settle);
      // an unreadable result leaves it counted in full.
      if (h.booking) await deps.settle(h.booking, out?.usage?.total ?? null).catch(() => deps.log?.("scientists usage settlement failed", { booking: h.booking!.id }));
      if (!out) return { status: "failed", error: "The scientists returned a result the app couldn't read.", elapsedMs };
      const ms = typeof r.created_at === "number" && typeof r.completed_at === "number" ? (r.completed_at - r.created_at) * 1000 : null;
      return { status: "done", elapsedMs, result: await gate(out, h, deps.store, { session: r.agent_session_id ?? null, ms }) };
    } catch (e) { return unreachable(reply, e); }
  });
}
