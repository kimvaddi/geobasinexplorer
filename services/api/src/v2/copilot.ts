// Version 2's copilot (docs/FOUNDRY_AGENTS.md, "How the app calls the squad"). A question that version 1 sends to
// its live agent goes instead to the hosted agent gbx-copilot, as a stored background response, because a squad can
// outlast Front Door's 120-second origin timeout. The ask route returns at once with a signed handle, the browser polls
// with it, and when the run ends its result is checked again at the app's own gate (cosci.ts checkSaid) and becomes an
// ordinary answer with numbered citations, as version 1's are (live/agent-answer.ts). The person's object ID goes to
// Foundry as x-ms-user-identity, so the run sits in that person's own session, and the handle binds it to them, because
// Foundry doesn't fence one delegated person from another. The question's token booking travels in the handle and is
// settled against the run's reported usage when it ends (answer.ts copilotStatus).
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { basinById } from "@/lib/basins";
import type { Geotag } from "@/lib/geotag";
import type { User } from "../auth";
import type { CloudAnswer } from "../answer";
import { parseNear, type Near } from "../geo";
import type { Reservation } from "../usage";
import { INTERPRETATION_LABEL } from "../live/agent-answer";
import type { AgentEvidence } from "../live/agent-tools";
import type { PublicationManifest } from "../live/contracts";
import { livePlace } from "../live/source-policy";
import { AgentEndpointError, checkSaid, outputText, parseOutput, ticketMetadata, type AgentEndpoint, type Said, type SquadOutput } from "./cosci";
import type { RunStore } from "./run-store";
import { issueRunTicket } from "./run-ticket";
import type { PersonAuth } from "./obo";

export const COPILOT_STATUS_PATH = "/api/v2/ask/status";
const HANDLE_PREFIX = "gbxa1";
const HANDLE_MS = 30 * 60_000;
const TICKET_MS = 15 * 60_000;
/* Poll errors this soon after the start are taken as passing; later, the run is given up. */
const RETRY_MS = 9 * 60_000;
const USER_IDENTITY = /^[A-Za-z0-9._:@-]{1,256}$/;
const RESPONSE_ID = /^[A-Za-z0-9_-]{8,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export interface CopilotDeps {
  endpoint: AgentEndpoint; store: RunStore; ticketKey(): Buffer; log?(message: string, detail: Record<string, unknown>): void;
  /** Tokens on the person's behalf, so the scientists can ask Fabric IQ as them (v2/obo.ts); absent, runs start as the app. */
  person?(user: User): PersonAuth | null;
}
let deps: CopilotDeps | null = null;
/* Set by server.ts when GBX_V2_COPILOT=on and the tool server runs; null leaves every question on version 1's agent. */
export function configureCopilot(d: CopilotDeps | null): void { deps = d; }
export const copilotReady = (): boolean => !!deps;

// The handle -----------------------------------------------------------------------------------------------------------
/* What the question went through before the run began, and why it looked beyond a place, for the finished answer. */
export interface RunContext { steps: { step: string; detail: string; ms: number }[]; why: string | null }
export interface CopilotHandle {
  run: string; response: string; sub: string;
  /** The question, the basin the answer is shown on, the place it is limited to and the live sources it needs. */
  q: string; basin: string | null; near: Near | null; req: string[];
  /** The question's token booking, the tokens it used before the run, and the answer's ID. */
  booking: Reservation | null; pre: number; aid: string;
  ctx?: RunContext;
  /** Whose token started the run where tokens on the person's behalf are set up: "person", or "app" when it fell back. */
  idn?: "person" | "app";
  iat: number; exp: number;
}
const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(`${HANDLE_PREFIX}.${payload}`).digest();
const sign = (h: CopilotHandle, key: Buffer) => {
  const payload = Buffer.from(JSON.stringify(h)).toString("base64url");
  return `${HANDLE_PREFIX}.${payload}.${mac(key, payload).toString("base64url")}`;
};

export function issueHandle(h: Omit<CopilotHandle, "iat" | "exp">, key: Buffer, now = Date.now()): string {
  return sign({ ...h, iat: now, exp: now + HANDLE_MS }, key);
}

const validContext = (c: unknown): c is RunContext => {
  const x = c as RunContext;
  return !!x && typeof x === "object" && (x.why === null || (typeof x.why === "string" && x.why.length <= 400)) && Array.isArray(x.steps) && x.steps.length <= 6
    && x.steps.every((s) => s && typeof s.step === "string" && s.step.length <= 80 && typeof s.detail === "string" && s.detail.length <= 400 && Number.isFinite(s.ms));
};

/* The same handle with the question's context added, keeping its run, person and lifetime. */
export function annotateHandle(token: string, ctx: RunContext, now = Date.now()): string {
  if (!deps) return token;
  const key = deps.ticketKey(), h = verifyHandle(token, key, now);
  const trimmed: RunContext = { why: ctx.why?.slice(0, 400) ?? null, steps: ctx.steps.slice(0, 6).map((s) => ({ step: s.step.slice(0, 80), detail: s.detail.slice(0, 400), ms: Number.isFinite(s.ms) ? s.ms : 0 })) };
  return sign({ ...h, ctx: trimmed }, key);
}

export function verifyHandle(token: unknown, key: Buffer, now = Date.now()): CopilotHandle {
  const bad = () => new Error("Invalid answer handle");
  if (typeof token !== "string" || token.length > 8192) throw bad();
  const [prefix, payload, signature, ...rest] = token.split(".");
  if (prefix !== HANDLE_PREFIX || !payload || !signature || rest.length) throw bad();
  const expected = mac(key, payload), given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  let h: CopilotHandle;
  try { h = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CopilotHandle; } catch { throw bad(); }
  const r = h?.booking;
  if (!h || typeof h.run !== "string" || !UUID.test(h.run) || typeof h.response !== "string" || !RESPONSE_ID.test(h.response)
    || typeof h.sub !== "string" || !USER_IDENTITY.test(h.sub) || typeof h.q !== "string" || !h.q || h.q.length > 300
    || (h.basin !== null && typeof h.basin !== "string") || !Array.isArray(h.req) || !h.req.every((x) => typeof x === "string")
    || (r !== null && (typeof r !== "object" || typeof r.id !== "string" || typeof r.key !== "string" || !Number.isFinite(r.amount)))
    || !Number.isFinite(h.pre) || typeof h.aid !== "string" || !Number.isSafeInteger(h.iat) || !Number.isSafeInteger(h.exp)
    || (h.ctx !== undefined && !validContext(h.ctx)) || (h.idn !== undefined && h.idn !== "person" && h.idn !== "app")) throw bad();
  if (h.near !== null) { try { h.near = parseNear(h.near); } catch { throw bad(); } }
  if (h.exp <= now) throw new Error("Expired answer handle");
  return h;
}

export class HandleError extends Error {
  constructor(message: string, readonly status: 403 | 404) { super(message); }
}

// Starting and polling a run -------------------------------------------------------------------------------------------
export interface CopilotStart {
  question: string; user: User; near: Near | null; requiredSourceIds: string[]; basin: string | null; answerId: string; booking: Reservation | null; pre: number;
  /** The required live sources' titles, for the scientists' instructions (host.py required_of). */
  required?: { id: string; title: string }[];
}

/* The live documents the answer must cite, as the metadata key gbx_required; a metadata value holds 512 characters. */
export function requiredMetadata(list: { id: string; title: string }[]): Record<string, string> {
  const kept: { id: string; title: string }[] = [];
  for (const r of list) {
    const item = { id: r.id.slice(0, 60), title: r.title.slice(0, 160) };
    if (JSON.stringify([...kept, item]).length > 512) break;
    kept.push(item);
  }
  return kept.length ? { gbx_required: JSON.stringify(kept) } : {};
}

/* Starts gbx-copilot for the person and returns the handle, or null when the scientists can't be reached, so version 1's
   agent answers instead. */
export async function startCopilot(s: CopilotStart, signal: AbortSignal): Promise<string | null> {
  if (!deps || !USER_IDENTITY.test(s.user.id)) return null;
  const key = deps.ticketKey(), run = randomUUID();
  try {
    const ticket = issueRunTicket({ run, sub: s.user.id, name: s.user.name, roles: s.user.roles, owner: s.user.owner, conversation: "",
      booking: s.booking?.id ?? "", near: s.near, requiredSourceIds: s.requiredSourceIds.slice(0, 16) }, key, TICKET_MS);
    const person = deps.person?.(s.user) ?? null;
    const started = await deps.endpoint.start({ input: s.question, background: true, store: true, metadata: { ...ticketMetadata(ticket), ...requiredMetadata(s.required ?? []) } }, s.user.id,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]), person);
    if (typeof started.id !== "string" || !RESPONSE_ID.test(started.id)) throw new AgentEndpointError("no response ID", 502);
    const idn = started.gbx_identity === "person" ? "person" as const : deps.person ? "app" as const : undefined;
    return issueHandle({ run, response: started.id, sub: s.user.id, q: s.question, basin: s.basin, near: s.near, req: s.requiredSourceIds,
      booking: s.booking, pre: s.pre, aid: s.answerId, ...(idn ? { idn } : {}) }, key);
  } catch (e) {
    deps.log?.("copilot start failed", { error: (e as Error).message?.slice(0, 300), status: (e as AgentEndpointError).status });
    return null;
  }
}

/* What the scientists have read so far, from the run's register: how many sources and the latest few, newest first. */
export interface RunProgress { sources: number; latest: string[] }
export type CopilotPoll =
  | { state: "running"; elapsedMs: number; progress?: RunProgress }
  | { state: "failed"; h: CopilotHandle; reason: string }
  | { state: "done"; h: CopilotHandle; out: SquadOutput; evidence: Map<string, AgentEvidence>; session: string | null; ms: number | null };

export async function pollCopilot(handle: unknown, user: User, signal: AbortSignal, now = Date.now()): Promise<CopilotPoll> {
  if (!deps) throw new HandleError("The Foundry scientists aren't set up on this site.", 404);
  let h: CopilotHandle;
  try { h = verifyHandle(handle, deps.ticketKey(), now); } catch { throw new HandleError("This answer has ended or can't be found. Ask again.", 404); }
  if (h.sub !== user.id) throw new HandleError("This answer belongs to someone else.", 403);
  let r;
  try { r = await deps.endpoint.get(h.response, user.id, signal, h.idn === "person" ? deps.person?.(user) : null); }
  catch (e) {
    if (!(e instanceof AgentEndpointError) || now - h.iat > RETRY_MS) return { state: "failed", h, reason: `the scientists couldn't be reached (${(e as Error).message.slice(0, 120)})` };
    deps.log?.("copilot poll failed, retrying", { status: e.status });
    return { state: "running", elapsedMs: now - h.iat };
  }
  if (r.status === "queued" || r.status === "in_progress") {
    const read = await deps.store.recent(h.run, 3).catch(() => null);
    return { state: "running", elapsedMs: now - h.iat, ...(read ? { progress: { sources: read.total, latest: read.labels } } : {}) };
  }
  if (r.status !== "completed") {
    deps.log?.("copilot run did not complete", { status: r.status, error: r.error?.message?.slice(0, 300) });
    return { state: "failed", h, reason: `the run ended ${r.status ?? "without a status"}` };
  }
  const out = parseOutput(outputText(r));
  if (!out) return { state: "failed", h, reason: "its result couldn't be read" };
  const ids = [...new Set(out.sentences.flatMap((x) => x.cites))];
  const evidence = new Map((ids.length ? await deps.store.get(h.run, ids) : []).map((e) => [e.id, e]));
  const ms = typeof r.created_at === "number" && typeof r.completed_at === "number" ? (r.completed_at - r.created_at) * 1000 : null;
  return { state: "done", h, out, evidence, session: r.agent_session_id ?? null, ms };
}

// The scientists' result as an answer ----------------------------------------------------------------------------------
export interface SquadAnswerOptions {
  validator: string; manifest: PublicationManifest | null;
  withheld(a: CloudAnswer, why: string): CloudAnswer;
}

/* Builds the answer the copilot shows from a finished run, into `a`, a fresh answer shell for the same question. Facts
   come first and interpretations after them, under version 1's label; each statement must pass the app's own gate, a
   required live source must back a fact, and nothing the scientists didn't confirm is shown. */
export function squadAnswer(a: CloudAnswer, done: Extract<CopilotPoll, { state: "done" }>, o: SquadAnswerOptions): CloudAnswer {
  const { h, out } = done, trace = (a.trace ??= []);
  const chosen = out.findings.filter((f) => f.chosen).map((f) => f.specialist);
  trace.push({ step: "Asked the Foundry scientists", detail: `gbx-copilot's lead chose the ${chosen.length ? chosen.join(" and ") : "literature"} scientist${chosen.length === 1 ? "" : "s"}, who searched the published evidence through GeoBasin's tools, and drafted the answer from their findings.`, ms: done.ms ?? 0 });
  const struck = out.removed.filter((r) => r.by === "critic").length;
  if (out.rebutted) trace.push({ step: "The critic sent the draft back", detail: `The critic raised ${count(out.critique.length || 1, "problem")} with the first draft, and the lead revised it${out.status === "blocked" ? "; the critic didn't accept the revision either"
    : struck ? `; the critic still disputed ${count(struck, "statement")} of the revision, which ${struck === 1 ? "was" : "were"} removed before the independent check` : ""}.`, ms: 0 });
  const k = out.knowledge;
  const answered = k ? (k.answered === k.asked ? `${count(k.asked, "question")} answered` : `${k.answered} of ${count(k.asked, "question")} answered`) : "";
  if (k && k.asked > 0) trace.push(k.answered > 0
    ? { step: "Asked Fabric IQ as you", detail: `The scientists asked GeoBasin's knowledge ontology through Fabric IQ with your own Fabric permissions: ${answered} in ${(k.ms / 1000).toFixed(1)} s.`, ms: k.ms }
    : { step: "Fabric IQ didn't answer", detail: `Fabric IQ couldn't answer${k.fallback ? ` (${k.fallback})` : ""}, so the scientists used the typed knowledge tools over the knowledge graph instead.`, ms: k.ms });
  else if (h.idn === "app") trace.push({ step: "Fabric IQ wasn't asked", detail: "The run started with the app's identity rather than yours, and Fabric IQ acts only as the signed-in person, so the scientists used the typed knowledge tools over the knowledge graph.", ms: 0 });
  if (out.usage) trace.push({ step: "Counted the tokens", detail: `${out.usage.total.toLocaleString("en")} tokens across ${count(out.usage.runs, "model run")}, booked against the caps.`, ms: 0 });
  if (out.status === "blocked") {
    const w = o.withheld(a, "The scientists' critic didn't accept the draft after one revision.");
    w.reason = "Blocked by the critic"; w.validation.status = "blocked";
    return w;
  }
  if (out.status === "not_found") {
    a.reason = "No supported live evidence"; a.paragraphs = ["Not found in the published evidence. No supported answer was returned."];
    a.validation.note = "No claims were presented.";
    return a;
  }
  const searched = out.findings.filter((f) => f.chosen);
  if (out.status === "validation_incomplete" && searched.length && searched.every((f) => f.error)) {
    return o.withheld(a, "None of the scientists could finish its search, because their model calls failed, so nothing could be checked. Ask again in a minute.");
  }
  if (out.status !== "answered") return o.withheld(a, "The scientists' independent check didn't confirm any fact.");
  type Kept = { s: Said; evidence: AgentEvidence[] };
  const kept: Kept[] = [], gate: { text: string; why: string }[] = [];
  for (const s of out.sentences) {
    const why = checkSaid(s, done.evidence, h.q);
    if (why) gate.push({ text: s.text, why: `GeoBasin's check: ${why}.` });
    else kept.push({ s, evidence: [...new Set(s.cites)].map((id) => done.evidence.get(id)!) });
  }
  const removed = [...out.removed.map((r) => ({ text: r.text, why: `The scientists' check: ${r.why}.` })), ...gate];
  const facts = kept.filter((k) => k.s.kind === "fact"), interpretations = kept.filter((k) => k.s.kind === "interpretation");
  if (!facts.length) return o.withheld(a, "No fact passed GeoBasin's source and number check.");
  // As in version 1, packaged evidence can't stand in for a live source the question needs.
  if (h.req.length && !h.req.every((id) => facts.some((k) => k.evidence.some((e) => e.citation?.live?.sourceId === id)))) {
    return o.withheld(a, "The required live source was not cited. Packaged evidence cannot substitute for it.");
  }
  const order = new Map<string, NonNullable<AgentEvidence["citation"]>>();
  for (const k of [...facts, ...interpretations]) for (const e of k.evidence) if (e.citation) order.set(e.citation.id, e.citation);
  a.citations = [...order.values()];
  const number = new Map(a.citations.map((c, i) => [c.id, i + 1]));
  const cited = (list: Kept[]) => list.map((k) => `${k.s.text} ${[...new Set(k.evidence.flatMap((e) => e.citation ? [number.get(e.citation.id)] : []))].map((n) => `[${n}]`).join("")}`).join(" ");
  a.paragraphs = [cited(facts), ...(interpretations.length ? [`${INTERPRETATION_LABEL} ${cited(interpretations)}`] : [])];
  if (out.missing.length) a.paragraphs.push("Part of the question is not covered by these sources and remains unanswered.");
  const supported = out.verdicts.filter((v) => v === "supported").length;
  a.validation = { ...a.validation, status: "passed", checked: out.verdicts.length, supported, removed,
    note: removed.length ? `Every statement shown passed the scientists' independent check and GeoBasin's own source and number check. ${count(removed.length, "statement")} the checks couldn't confirm ${removed.length === 1 ? "was" : "were"} removed.`
      : "Every statement shown passed the scientists' independent check and GeoBasin's own source and number check." };
  trace.push({ step: "Validated", detail: `${o.validator} judged ${count(out.verdicts.length, "statement")} and found ${supported} supported; GeoBasin's own check then confirmed ${count(facts.length, "fact")} and ${count(interpretations.length, "interpretation")}, and ${count(removed.length, "statement")} ${removed.length === 1 ? "was" : "were"} removed in all.`, ms: 0 });
  a.status = "answered"; a.label = "Retrieved"; a.reason = "Written by the Foundry scientists from governed evidence and independently validated";
  a.provenance = ["published"];
  const sources = o.manifest?.sources ?? [];
  const wellLabel = (s: { sourceId: string; title: string }) => `${livePlace(s.sourceId)?.well ?? s.title} (live geotag)`;
  a.geo = Object.fromEntries(a.citations.map((c) => {
    const s = sources.find((x) => x.sourceId === c.live?.sourceId);
    const tags: Geotag[] = [];
    if (s?.wellLocation) tags.push({ label: wellLabel(s), kind: "point", lon: s.wellLocation.lon, lat: s.wellLocation.lat, basin: c.basin || null, method: "From the document's well" });
    const basin = basinById(c.basin);
    if (basin) tags.push({ label: `${basin.name} (packaged outline)`, kind: "polygon", lon: basin.labelAt[0], lat: basin.labelAt[1], basin: basin.id, method: "From the document's basin" });
    return [c.id, tags];
  }));
  a.focusBasin ??= a.citations.find((c) => basinById(c.basin))?.basin ?? null;
  const geotag = sources.find((s) => s.wellLocation && a.citations.some((c) => c.live?.sourceId === s.sourceId));
  if (geotag?.wellLocation) a.focus = { lon: geotag.wellLocation.lon, lat: geotag.wellLocation.lat, zoom: 8.2, label: wellLabel(geotag) };
  return a;
}
