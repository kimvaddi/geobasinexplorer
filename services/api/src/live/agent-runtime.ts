// Request envelope and separate artifact cleanup follow docs/FOUNDRY_AGENTS.md.
// https://learn.microsoft.com/rest/api/microsoft-foundry/aiproject
import { randomUUID } from "node:crypto";
import type { ResponseInput } from "openai/resources/responses/responses";
import { estimateTokens, ValidationError, type BeforeCall } from "../validate";
import { AGENT_ANSWER_CHARS, AGENT_ANSWER_SCHEMA, AGENT_INSTRUCTIONS, AGENT_MAX_STATEMENTS, AGENT_TOOLS } from "./agent-definition";
import { BUDGET_NOTICE, type AgentTools } from "./agent-tools";
import type { AgentTransport, AgentJournal, CleanupRecord } from "./agent-client";

export class AgentRunError extends Error {
  constructor(message: string, readonly tokens: number, readonly known: boolean, readonly status?: number, readonly kind?: string) { super(message); }
}
// App-authored failure messages are fixed text. Parser and provider messages can echo fragments of the question or the
// evidence, so operator logs report those only as "unclassified" with an HTTP status and an error class.
const FIXED_FAILURES = new Set([
  "Answer exceeds its schema limit", "Invalid answer schema", "Invalid cited sentence", "Inconsistent answerability", "Deadline exceeded",
  "Insufficient budget for the agent and independent validation", "Conversation creation returned no identity", "Conversation evidence budget reached",
  "Agent loop budget exhausted", "Agent response incomplete", "Unapproved agent tool output", "Too many function calls in one response",
  "Incomplete function call", "Agent did not finish within the tool-round limit", "Agent cleanup could not be confirmed", "Tool arguments exceed the limit",
  "Invalid tool arguments", "Invalid search query", "Evidence text exceeds the bounded read", "Conflicting immutable evidence records", "Evidence limit reached",
  "Invalid tool call id", "Tool call id reused with different arguments", "Tool call limit reached", "Invalid page identity", "Page is not currently published",
  "Page text exceeds the bounded read", "Complete page text unavailable within the limit", "Invalid depth or elevation", "Conversion inputs lack retrieved source evidence",
  "Tool is not allowlisted", "Tool output limit reached", "Answer cited evidence that was not retrieved", "Missing computation source",
  "An immutable agent name and version are required", "Pinned agent does not match this release's model, instructions and tools",
  "Conversation item cleanup exceeds the bounded inventory", "Invalid Foundry project endpoint", "Validation budget exhausted",
  "validator returned no JSON", "validator JSON had no verdicts",
]);
const kindOf = (e: unknown) => e instanceof Error ? (e.name && e.name !== "Error" ? e.name : e.constructor.name) : typeof e;
export function failureLog(e: unknown): Record<string, number | string> {
  const message = e instanceof Error ? e.message : "", run = e instanceof AgentRunError || e instanceof ValidationError ? e : undefined;
  const code = run?.status ?? (e && typeof e === "object" ? status(e) : undefined);
  return { reason: FIXED_FAILURES.has(message) ? message : "unclassified", kind: run?.kind ?? kindOf(e), ...(typeof code === "number" ? { status: code } : {}) };
}
export interface AgentStatement { kind: "fact" | "interpretation"; text: string; cites: string[] }
export interface AgentOutput { answerable: boolean; sentences: AgentStatement[]; missing: string[] }
export function parseAgentAnswer(text: string): AgentOutput {
  if (text.length > AGENT_ANSWER_CHARS) throw new Error("Answer exceeds its schema limit");
  const a: unknown = JSON.parse(text);
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(a) || Object.keys(a).sort().join() !== "answerable,missing,sentences" || typeof a.answerable !== "boolean"
    || !Array.isArray(a.sentences) || a.sentences.length > AGENT_MAX_STATEMENTS || !Array.isArray(a.missing) || a.missing.length > 8
    || a.missing.some((s) => typeof s !== "string" || s.length > 1000)) throw new Error("Invalid answer schema");
  for (const s of a.sentences) if (!object(s) || Object.keys(s).sort().join() !== "cites,kind,text" || (s.kind !== "fact" && s.kind !== "interpretation")
    || typeof s.text !== "string" || !s.text.trim() || s.text.length > 2000
    || /(?:https?:\/\/|(?:blob|data|javascript):|[?&]sig=)/i.test(s.text) || !Array.isArray(s.cites) || !s.cites.length || s.cites.length > 12
    || s.cites.some((id) => typeof id !== "string" || !/^[LPT][1-9]\d*$/.test(id))) throw new Error("Invalid cited sentence");
  if (a.answerable !== (a.sentences.length > 0)) throw new Error("Inconsistent answerability");
  return a as unknown as AgentOutput;
}
// An abort signal is propagated to every SDK call. The race bounds non-network hooks too, without allowing a timed-
// out booking to start a model later. All promises get rejection handlers and the SDK work is actively cancelled.
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error("Deadline exceeded"));
    signal.addEventListener("abort", stop, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
function status(e: unknown) { return (e as { status?: number; statusCode?: number }).status ?? (e as { statusCode?: number }).statusCode; }
export const FINAL_ROUND_NOTE = "Tool budget nearly used. Answer now from the evidence already returned, citing it, or set answerable to false and list what is missing.";
// The conversation transcript is bounded. Tool results are admitted only while ANSWER_RESERVE characters stay free, so
// the final-round note, the answer itself and one correction request still fit; a live Q13 lost a finished answer when
// its correction request crossed the bound (5 Nov 2026).
export const TRANSCRIPT_BUDGET = 160_000, ANSWER_RESERVE = 24_000;
// A correction rewrites the whole answer, which took 14 to 16 s live. One that cannot finish before the agent phase ends
// is cut off, and its unconfirmed response then withholds the answer, so it is asked only while this much time remains.
export const CORRECTION_MIN_MS = 16_000;
// Independent validation needs up to 40 s after the agent phase and stops SETTLE_MS before the deadline, so at least 35 s
// of it always remain. Live validator calls took a median of 8.9 s and up to 43 s over four days (586 calls, 5 Nov 2026).
export const VALIDATION_RESERVE_MS = 40_000, SETTLE_MS = 5_000;
const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));
const toolName = (name: unknown) => typeof name === "string" && TOOL_NAMES.has(name) ? name : "unlisted";
export async function cleanupAgentArtifacts(record: CleanupRecord, client: AgentTransport, journal: AgentJournal, ms: number): Promise<boolean> {
  const signal = AbortSignal.timeout(Math.max(1, ms)); let ok = !record.ambiguousConversation && !record.ambiguousResponse;
  const attempt = async (fn: () => Promise<unknown>) => { try { await abortable(fn(), signal); } catch (e) { if (status(e) !== 404) ok = false; } };
  // Persist the latest known IDs with an independent signal even when the last loop journal write was cancelled.
  try { await abortable(journal.save(record, signal), signal); } catch { ok = false; }
  if (!record.conversationId) {
    console.warn(JSON.stringify({ m: "agent creation requires reconciliation", requestId: record.requestId, agent: record.agentName, version: record.agentVersion }));
    return false;
  }
  // The live service answers concurrent item deletes in one conversation with 412 Precondition Failed (reproduced
  // 2 Nov 2026: three of six parallel deletes refused), so items are deleted one at a time. A second pass covers a
  // transient conflict; the re-list, not the individual delete replies, decides whether the items are gone.
  try {
    let ids = await abortable(client.listItems(record.conversationId, signal), signal);
    for (let pass = 0; pass < 2 && ids.length; pass++) {
      for (const id of ids) { try { await abortable(client.deleteItem(record.conversationId, id, signal), signal); } catch { /* re-list below */ } }
      ids = await abortable(client.listItems(record.conversationId, signal), signal);
    }
    if (ids.length) ok = false;
  } catch (e) { if (status(e) !== 404) ok = false; }
  // Responses are separate resources; parallel delete and 404 verification was confirmed live on 2 Nov 2026.
  await Promise.all(record.responseIds.map(async (id) => {
    await attempt(() => client.deleteResponse(id, signal));
    try { await abortable(client.getResponse(id, signal), signal); ok = false; } catch (e) { if (status(e) !== 404) ok = false; }
  }));
  // Always attempt conversation deletion, even after an item/response cleanup error or a caller disconnect.
  await attempt(() => client.deleteConversation(record.conversationId, signal));
  try { await abortable(client.getConversation(record.conversationId, signal), signal); ok = false; } catch (e) { if (status(e) !== 404) ok = false; }
  if (ok) { try { await abortable(journal.complete(record, signal), signal); } catch { ok = false; } }
  if (!ok) console.warn(JSON.stringify({ m: "agent cleanup pending", requestId: record.requestId, conversationId: record.conversationId, responseIds: record.responseIds, ambiguousResponse: !!record.ambiguousResponse }));
  return ok;
}
export interface AgentRunOptions {
  question: string; tools: AgentTools; client: AgentTransport; journal: AgentJournal; before: BeforeCall;
  pin: { name: string; version: string }; deadline: number; signal?: AbortSignal;
  // callMs bounds one model call inside the agent phase; writing a fourteen-statement answer can take far longer than a tool choice.
  agentMs?: number; callMs?: number; cleanupMs?: number; rounds?: number; outputTokens: number;
  // Returns a correction request when a finished answer fails the answer path's own checks; asked at most once.
  review?: (answer: AgentOutput) => string | null;
  // A finished answer returns as soon as it is written, with its cleanup still running in `cleanup`, so the caller can
  // run cleanup beside the independent validation. The caller must await `cleanup` and show nothing unless it is true.
  // A failed run still waits for its cleanup before throwing.
  deferCleanup?: boolean;
}
export interface AgentRunResult { answer: AgentOutput; tokens: number; known: boolean; ms: number; corrections: number; cleanup: Promise<boolean> }
export async function runPromptAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  // Reserve the validation time before the deadline, even for a late start, and the full cleanup budget as well unless
  // cleanup is deferred to run beside validation. Cleanup took a median of 0.7 s live (5 Nov 2026), so running it before
  // validation used to cost the agent its 15 s reserve while saving almost nothing.
  const start = Date.now(), reserve = VALIDATION_RESERVE_MS + (o.deferCleanup ? 0 : o.cleanupMs ?? 5_000);
  const phaseEnd = Math.min(o.deadline - reserve, start + (o.agentMs ?? 35_000));
  if (phaseEnd <= start) throw new AgentRunError("Insufficient budget for the agent and independent validation", 0, true);
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, phaseEnd - start)), ...(o.signal ? [o.signal] : [])]);
  const record: CleanupRecord = { requestId: randomUUID(), conversationId: "", responseIds: [], agentName: o.pin.name, agentVersion: o.pin.version };
  let tokens = 0, known = true, corrections = 0, output: AgentOutput | undefined, failure: unknown, cleanup: Promise<boolean> = Promise.resolve(true);
  try {
    await abortable(o.client.verify(signal), signal);
    // Journal the ambiguity BEFORE creating anything. A lost creation reply or process crash must not erase the
    // only record that an unidentified conversation/response may still exist in the service.
    record.ambiguousConversation = true;
    await abortable(o.journal.save(record, signal), signal);
    record.conversationId = await abortable(o.client.createConversation(signal), signal);
    if (!record.conversationId) throw new Error("Conversation creation returned no identity");
    record.ambiguousConversation = false;
    await abortable(o.journal.save(record, signal), signal);
    let input: ResponseInput = [{ role: "user", content: `Current approved sources: ${o.tools.context.manifest.sources.map((s) => s.sourceId).join(", ")}. Required live sources for this question: ${o.tools.context.requiredSourceIds?.join(", ") || "the current publication"}.\nQuestion: ${o.question}` }];
    let transcript = AGENT_INSTRUCTIONS + JSON.stringify(AGENT_TOOLS) + JSON.stringify(AGENT_ANSWER_SCHEMA);
    const rounds = o.rounds ?? 8;
    // Set from the next-to-last model call, or earlier once a tool reports a spent evidence budget. From then on every
    // model call asks for the answer, and tool calls are answered with the budget notice without being run.
    let wrapUp = false;
    for (let round = 0; round < rounds; round++) {
      // From the next-to-last model call the runtime asks for the answer from the evidence already returned, whatever
      // input came before it (tool results or the one correction request), so the last call stays free for the one
      // correction a draft may need. A live Q10 run spent all eight rounds searching (3 Nov 2026), and Wave 4 Q10 runs
      // that drafted in the last call could not correct a misquoted number (5 Nov 2026). This runtime-authored message
      // is ordinary input, which an agent reference permits.
      if (round > 0 && round >= rounds - 2) wrapUp = true;
      if (round > 0 && wrapUp) input = [...input, { role: "user", content: FINAL_ROUND_NOTE }];
      transcript += JSON.stringify(input);
      if (transcript.length > TRANSCRIPT_BUDGET) throw new Error("Conversation evidence budget reached");
      // Book the schema, framing headroom and every prior output allowance, not just displayed text.
      await abortable(o.before(Math.max(estimateTokens(transcript), Buffer.byteLength(transcript, "utf8")) + o.outputTokens * (round + 1) + 512), signal);
      signal.throwIfAborted();
      const remaining = phaseEnd - Date.now(); if (remaining < 250) throw new Error("Agent loop budget exhausted");
      let reply;
      record.ambiguousResponse = true;
      await abortable(o.journal.save(record, signal), signal);
      signal.throwIfAborted();
      try { reply = await abortable(o.client.respond(record.conversationId, input, signal, Math.min(o.callMs ?? 15_000, remaining)), signal); }
      catch (e) { known = false; throw e; }
      if (reply.id) { record.responseIds.push(reply.id); record.ambiguousResponse = false; }
      if (typeof reply.tokens === "number" && Number.isSafeInteger(reply.tokens) && reply.tokens >= 0) tokens += reply.tokens; else known = false;
      await abortable(o.journal.save(record, signal), signal);
      console.info(JSON.stringify({ m: "agent response", requestId: record.requestId, agent: o.pin.name, version: o.pin.version,
        conversationId: record.conversationId, responseId: reply.id, serviceRequestId: reply.requestId, round, status: reply.status, tokens: reply.tokens, ms: Date.now() - start }));
      if (reply.status !== "completed" || !reply.id) throw new Error("Agent response incomplete");
      transcript += JSON.stringify(reply.output) + reply.text;
      if (reply.output.some((item) => !["function_call", "message", "reasoning"].includes(item.type))) throw new Error("Unapproved agent tool output");
      const calls = reply.output.filter((item) => item.type === "function_call");
      if (!calls.length) {
        const parsed = parseAgentAnswer(reply.text);
        // One correction, only while another model call is allowed; the corrected answer still faces every gate.
        let correction: string | null = null;
        if (!corrections && round < rounds - 1 && o.review) { try { correction = o.review(parsed); } catch { correction = null; } }
        // A correction that would push the transcript past its bound, or could not finish before the agent phase ends, is
        // not asked. The draft is returned instead, and it faces the same final checks the correction was meant to anticipate.
        const skip = !correction ? null
          : transcript.length + JSON.stringify([{ role: "user", content: correction }, { role: "user", content: FINAL_ROUND_NOTE }]).length > TRANSCRIPT_BUDGET ? "transcript budget"
          : phaseEnd - Date.now() < CORRECTION_MIN_MS ? "time" : null;
        if (skip) {
          console.info(JSON.stringify({ m: "agent correction skipped", requestId: record.requestId, round, reason: skip }));
          correction = null;
        }
        if (correction) {
          corrections++; input = [{ role: "user", content: correction }];
          console.info(JSON.stringify({ m: "agent correction requested", requestId: record.requestId, round }));
          continue;
        }
        output = parsed; break;
      }
      if (calls.length > 6) throw new Error("Too many function calls in one response");
      // Operator telemetry: tool names only, never arguments or evidence text.
      console.info(JSON.stringify({ m: "agent tool calls", requestId: record.requestId, round, tools: calls.map((c) => toolName(c.name)) }));
      input = [];
      for (const call of calls) {
        if (!call.name || typeof call.arguments !== "string" || !call.call_id) throw new Error("Incomplete function call");
        let result: string;
        if (wrapUp) {
          if (!TOOL_NAMES.has(call.name)) throw new Error("Tool is not allowlisted");
          result = BUDGET_NOTICE;
        } else {
          // The escaped characters this call's output may add to the transcript before the answer reserve.
          const room = TRANSCRIPT_BUDGET - ANSWER_RESERVE - transcript.length - JSON.stringify(input).length - 1
            - JSON.stringify({ type: "function_call_output", call_id: call.call_id, output: "" }).length;
          const toolSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
          result = await abortable(o.tools.execute(call.name, call.arguments, call.call_id, toolSignal, room), toolSignal);
          if (o.tools.spent) {
            wrapUp = true;
            console.info(JSON.stringify({ m: "agent evidence budget used", requestId: record.requestId, round, budget: o.tools.spent }));
          }
        }
        input.push({ type: "function_call_output", call_id: call.call_id, output: result });
        console.info(JSON.stringify({ m: "agent tool result", requestId: record.requestId, round, tool: toolName(call.name), bytes: Buffer.byteLength(result, "utf8"), ...(result === BUDGET_NOTICE ? { notice: true } : {}) }));
      }
    }
    if (!output) throw new Error("Agent did not finish within the tool-round limit");
  } catch (e) { failure = e; }
  finally {
    if (record.conversationId || record.ambiguousConversation) {
      // Deferred, cleanup runs beside validation and must finish by the time the answer is settled. Otherwise it runs
      // first and leaves validation its reserve. It never rejects: an unconfirmed cleanup resolves false.
      const room = o.deferCleanup ? o.deadline - SETTLE_MS - Date.now() : o.deadline - Date.now() - VALIDATION_RESERVE_MS;
      const pending = cleanupAgentArtifacts(record, o.client, o.journal, Math.min(o.cleanupMs ?? 5_000, Math.max(1, room))).catch(() => false);
      if (o.deferCleanup && !failure) cleanup = pending;
      else if (!(await pending)) failure ??= new Error("Agent cleanup could not be confirmed");
    }
  }
  if (failure) {
    // Preserve token-cap errors so the existing request admission path returns the correct refusal.
    if ((failure as Error).constructor.name === "CapError") throw failure;
    throw new AgentRunError((failure as Error).message ?? "Agent failed", tokens, known, failure && typeof failure === "object" ? status(failure) : undefined, kindOf(failure));
  }
  return { answer: output!, tokens, known, ms: Date.now() - start, corrections, cleanup };
}
