import assert from "node:assert/strict";
import { test } from "node:test";
import { runPromptAgent, parseAgentAnswer, AgentRunError, abortable, failureLog, FINAL_ROUND_NOTE, TRANSCRIPT_BUDGET, ANSWER_RESERVE, CORRECTION_MIN_MS, VALIDATION_RESERVE_MS, type AgentRunOptions } from "./agent-runtime";
import { AgentTools, BUDGET_NOTICE } from "./agent-tools";
import { AGENT_ANSWER_CHARS, AGENT_MAX_STATEMENTS } from "./agent-definition";
import { CapError } from "../usage";
import { contextFixture, evidenceFixture, fakeAgent, functionReply, answerReply, liveHit } from "./serving.test-fixtures";
function fixture(replies = [functionReply(), answerReply()]) {
  const f = fakeAgent(replies), bookings: number[] = [];
  const options: AgentRunOptions = { ...f, question: "Toolachee top?", tools: new AgentTools(contextFixture(), evidenceFixture()), before: async (n) => { f.calls.push("before"); bookings.push(n); }, pin: { name: "gbx-test", version: "1" }, deadline: Date.now() + 90_000, outputTokens: 1200, cleanupMs: 1000 };
  return { ...f, options, bookings };
}
test("one conversation, serialized tool round trip, booking before EVERY model call, verified cleanup", async () => {
  const f = fixture(); const r = await runPromptAgent(f.options); assert.equal(r.tokens, 357); assert.equal(r.known, true); assert.equal(f.bookings.length, 2); assert.ok(f.bookings[1] > f.bookings[0]);
  let last = -1; for (let i = 0; i < f.calls.length; i++) if (f.calls[i] === "respond") { assert.ok(f.calls.slice(last + 1, i).includes("before")); assert.equal(f.calls[i - 1], "save"); last = i; }
  assert.equal(f.calls.filter((x) => x === "conversation").length, 1); assert.ok(f.calls.includes("deleteItem:item-1")); assert.ok(f.calls.includes("deleteResponse:r1")); assert.ok(f.calls.includes("deleteResponse:r2")); assert.ok(f.calls.includes("deleteConversation")); assert.ok(f.calls.includes("complete"));
  assert.equal((f.submitted[1] as { type: string; call_id: string }[])[0].type, "function_call_output"); assert.equal((f.submitted[1] as { call_id: string }[])[0].call_id, "call-1");
});
test("a token cap refusal makes no model call and still deletes the conversation", async () => {
  const f = fixture(); f.options.before = async () => { throw new CapError("tokens", 1); };
  await assert.rejects(runPromptAgent(f.options), CapError); assert.ok(!f.calls.includes("respond")); assert.ok(f.calls.includes("deleteConversation"));
});
test("unknown tools, incomplete responses and malformed final JSON never produce an answer", async () => {
  for (const reply of [functionReply("shell"), { ...answerReply(), status: "incomplete" }, { ...answerReply(), text: "not JSON" }]) {
    const f = fixture([reply]); await assert.rejects(runPromptAgent(f.options), AgentRunError); assert.ok(f.calls.includes("deleteConversation"));
  }
});
test("deadline actively aborts an in-flight model and leaves full booking counted", async () => {
  const f = fixture(); let aborted = false; f.options.agentMs = 300;
  f.client.respond = async (_c, _i, s) => new Promise((_res, reject) => s.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
  const keepAlive = setInterval(() => {}, 50);
  try { const started = Date.now(); await assert.rejects(runPromptAgent(f.options), (e) => e instanceof AgentRunError && !e.known); assert.ok(Date.now() - started < 1000); assert.equal(aborted, true); assert.ok(f.calls.includes("deleteConversation")); } finally { clearInterval(keepAlive); }
});
test("disconnect cancels generation but cleanup uses an independent signal", async () => {
  const f = fixture(), c = new AbortController(); f.options.signal = c.signal;
  f.options.before = async () => { c.abort(); };
  await assert.rejects(runPromptAgent(f.options)); assert.ok(!f.calls.includes("respond")); assert.ok(f.calls.includes("deleteConversation"));
});
test("failed cleanup keeps durable IDs and withholds otherwise valid output", async () => {
  const f = fixture(); f.client.deleteResponse = async () => { throw new Error("denied"); };
  await assert.rejects(runPromptAgent(f.options), /cleanup/); assert.ok(!f.calls.includes("complete")); assert.deepEqual(f.journalRecords.at(-1)?.responseIds, ["r1", "r2"]); assert.ok(f.calls.includes("deleteConversation"));
});
test("conversation items are deleted one at a time because the live service refuses overlapping deletes with 412", async () => {
  const f = fixture(), ids = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`); f.setItems(ids);
  await runPromptAgent(f.options);
  for (const id of ids) assert.ok(f.calls.includes(`deleteItem:${id}`)); assert.ok(f.calls.includes("complete"));
});
test("an item that cannot be deleted withholds the answer after a bounded second pass and keeps the journal record", async () => {
  const f = fixture(); let deletes = 0; f.client.deleteItem = async () => { deletes++; throw { status: 500 }; };
  await assert.rejects(runPromptAgent(f.options), /cleanup/); assert.equal(deletes, 2); assert.ok(!f.calls.includes("complete")); assert.ok(f.calls.includes("deleteConversation"));
});
test("from the next-to-last model call the runtime asks for the answer, so the last call stays free for a correction, and later tool calls are not run", async () => {
  const call = (n: number) => ({ ...functionReply("search_live_evidence", { query: `Toolachee ${n}` }), id: `r${n}`, output: [{ type: "function_call", name: "search_live_evidence", arguments: JSON.stringify({ query: `Toolachee ${n}` }), call_id: `call-${n}` }] });
  const f = fixture([call(1), call(2), { ...answerReply(), id: "r3" }]); f.options.rounds = 3;
  let searches = 0; f.options.tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async () => { searches++; return [liveHit()]; } });
  const r = await runPromptAgent(f.options); assert.equal(r.answer.answerable, true); assert.equal(searches, 1);
  const notes = f.submitted.map((input) => (input as { role?: string; content?: string }[]).filter((i) => i.role === "user" && i.content === FINAL_ROUND_NOTE).length);
  assert.deepEqual(notes, [0, 1, 1]); assert.equal((f.submitted[2] as Item[])[0].output, BUDGET_NOTICE);
});
test("a review asks for one correction only while another call is allowed, and never twice", async () => {
  const f = fixture([functionReply(), answerReply("Draft one"), { ...answerReply("Draft two"), id: "r3" }, { ...answerReply("Draft three"), id: "r4" }]);
  let reviews = 0; f.options.review = () => { reviews++; return "Please correct."; };
  const r = await runPromptAgent(f.options); assert.equal(r.corrections, 1); assert.equal(reviews, 1); assert.equal(r.answer.sentences[0].text, "Draft two");
  assert.ok(JSON.stringify(f.submitted[2]).includes("Please correct."));
  const last = fixture([functionReply(), answerReply("Only draft")]); last.options.rounds = 2; let asked = 0; last.options.review = () => { asked++; return "Please correct."; };
  const r2 = await runPromptAgent(last.options); assert.equal(asked, 0); assert.equal(r2.corrections, 0); assert.equal(r2.answer.sentences[0].text, "Only draft");
});
// Astra's final review: the correction call is booked like every other, cleanup is confirmed by GET, and the last call
// carries the final-round note even after a correction.
test("the correction call is booked before it is sent, and a cap refusal there still cleans up", async () => {
  const f = fixture([functionReply(), answerReply("Draft one"), { ...answerReply("Draft two"), id: "r3" }]); f.options.review = () => "Please correct.";
  const r = await runPromptAgent(f.options); assert.equal(r.corrections, 1); assert.equal(f.bookings.length, 3);
  let last = -1; for (let i = 0; i < f.calls.length; i++) if (f.calls[i] === "respond") { assert.ok(f.calls.slice(last + 1, i).includes("before")); last = i; }
  const capped = fixture([functionReply(), answerReply("Draft one"), { ...answerReply("Draft two"), id: "r3" }]); capped.options.review = () => "Please correct.";
  let n = 0; capped.options.before = async () => { if (++n === 3) throw new CapError("tokens", 1); };
  await assert.rejects(runPromptAgent(capped.options), CapError); assert.equal(capped.calls.filter((c) => c === "respond").length, 2); assert.ok(capped.calls.includes("deleteConversation"));
});
test("a response or conversation that is still readable after its delete is not confirmed cleanup", async () => {
  const response = fixture(); response.client.getResponse = async () => ({ id: "r1" });
  await assert.rejects(runPromptAgent(response.options), /cleanup/); assert.ok(!response.calls.includes("complete"));
  const conversation = fixture(); conversation.client.getConversation = async () => ({ id: "conv-1" });
  await assert.rejects(runPromptAgent(conversation.options), /cleanup/); assert.ok(!conversation.calls.includes("complete"));
});
test("a correction on the next-to-last round still sends the final-round note with it", async () => {
  const f = fixture([functionReply(), answerReply("Draft one"), { ...answerReply("Draft two"), id: "r3" }]); f.options.rounds = 3; f.options.review = () => "Please correct.";
  const r = await runPromptAgent(f.options); assert.equal(r.corrections, 1);
  const last = JSON.stringify(f.submitted[2]); assert.ok(last.includes("Please correct.") && last.includes(FINAL_ROUND_NOTE));
});
// Live Wave 4 runs (5 Nov 2026): Q6 sent four searches in one round and crossed the transcript bound, Q9 reached the
// evidence limit on its seventh search, and Q13 lost a finished answer when its correction request crossed the bound.
const searches = (id: string, queries: string[]) => ({ id, status: "completed", text: "", tokens: 50,
  output: queries.map((query, i) => ({ type: "function_call", name: "search_live_evidence", arguments: JSON.stringify({ query }), call_id: `${id}-call-${i + 1}` })) });
type Item = { type?: string; output?: string; role?: string; content?: string };
test("parallel searches share the transcript room, and once a budget is spent every later call asks for the answer and tool calls are not run", async () => {
  const f = fixture([searches("r1", ["q1", "q2", "q3", "small"]), searches("r2", ["small"]), { ...answerReply(), id: "r3" }]), queries: string[] = [];
  const tools = new AgentTools(contextFixture(), { ...evidenceFixture(), live: async (q) => { queries.push(q);
    return q === "small" ? [liveHit()] : Array.from({ length: 8 }, (_, i) => liveHit({ id: `${q}c${i}_v1`, text: `${q} passage ${i} `.padEnd(6_000, "x") })); } });
  f.options.tools = tools;
  const r = await runPromptAgent(f.options); assert.equal(r.answer.answerable, true); assert.equal(tools.spent, "transcript"); assert.ok(!queries.includes("small"));
  assert.ok(JSON.stringify(f.submitted).length < TRANSCRIPT_BUDGET - ANSWER_RESERVE);
  const [, second, third] = f.submitted as Item[][], outputs = second.filter((x) => x.type === "function_call_output");
  assert.equal(outputs.at(-1)?.output, BUDGET_NOTICE); assert.equal(second.at(-1)?.content, FINAL_ROUND_NOTE);
  assert.deepEqual(third.map((x) => x.output === BUDGET_NOTICE), [true, false]); assert.equal(third.at(-1)?.content, FINAL_ROUND_NOTE);
  // Every registered passage was returned to the model, and nothing returned is missing from the registry.
  const returned = outputs.flatMap((x) => x.output === BUDGET_NOTICE ? [] : (JSON.parse(x.output!) as { id: string }[]).map((row) => row.id));
  assert.deepEqual([...tools.evidence.keys()].sort(), returned.sort()); assert.ok(returned.length > 8 && returned.length < 24);
});
test("a correction that would push the transcript past its bound is not asked, and the draft is returned for the final checks", async () => {
  const f = fixture([functionReply(), answerReply("Draft one")]); let asked = 0; f.options.review = () => { asked++; return "x".repeat(TRANSCRIPT_BUDGET); };
  const r = await runPromptAgent(f.options); assert.equal(asked, 1); assert.equal(r.corrections, 0); assert.equal(r.answer.sentences[0].text, "Draft one");
  assert.equal(f.calls.filter((c) => c === "respond").length, 2);
});
test("a correction that could not finish before the agent phase ends is not asked, and the draft is returned for the final checks", async () => {
  const f = fixture([functionReply(), answerReply("Draft one")]); let asked = 0; f.options.review = () => { asked++; return "Please correct."; };
  f.options.agentMs = CORRECTION_MIN_MS - 1_000;
  const r = await runPromptAgent(f.options); assert.equal(asked, 1); assert.equal(r.corrections, 0); assert.equal(r.answer.sentences[0].text, "Draft one");
  assert.equal(f.calls.filter((c) => c === "respond").length, 2);
});
// Live cleanup took a median of 0.7 s, yet the agent phase reserved 15 s for it before validation; Q10's corrections
// needed that time (5 Nov 2026). A deferred cleanup runs beside validation instead.
test("deferring cleanup gives its reserve to the agent, but never validation's 40 s", async () => {
  const plain = fixture(); Object.assign(plain.options, { deadline: Date.now() + 41_000, cleanupMs: 1_000 });
  await assert.rejects(runPromptAgent(plain.options), /Insufficient budget/);
  const deferred = fixture(); Object.assign(deferred.options, { deadline: Date.now() + 41_000, cleanupMs: 1_000, deferCleanup: true });
  const r = await runPromptAgent(deferred.options); assert.equal(r.answer.answerable, true); assert.equal(await r.cleanup, true);
  const late = fixture(); Object.assign(late.options, { deadline: Date.now() + VALIDATION_RESERVE_MS - 1_000, cleanupMs: 1_000, deferCleanup: true });
  await assert.rejects(runPromptAgent(late.options), /Insufficient budget/);
});
test("a deferred run returns its answer while cleanup is still running; cleanup resolves to whether it was confirmed, and a failed run still waits for it", async () => {
  const f = fixture(); f.options.deferCleanup = true;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const del = f.client.deleteConversation; f.client.deleteConversation = async (id, s) => { await gate; return del(id, s); };
  const r = await runPromptAgent(f.options);
  assert.ok(!f.calls.includes("deleteConversation") && !f.calls.includes("complete"));
  release(); assert.equal(await r.cleanup, true); assert.ok(f.calls.includes("deleteConversation") && f.calls.includes("complete"));
  const denied = fixture(); denied.options.deferCleanup = true; denied.client.deleteResponse = async () => { throw new Error("denied"); };
  assert.equal(await (await runPromptAgent(denied.options)).cleanup, false); assert.ok(!denied.calls.includes("complete"));
  const failed = fixture([functionReply("shell")]); failed.options.deferCleanup = true;
  await assert.rejects(runPromptAgent(failed.options), AgentRunError); assert.ok(failed.calls.includes("deleteConversation"));
});
test("a deferred cleanup keeps its own budget after an agent phase that used all of its time", async () => {
  const f = fixture(); Object.assign(f.options, { deadline: Date.now() + VALIDATION_RESERVE_MS + 400, cleanupMs: 1_500, deferCleanup: true });
  const del = f.client.deleteConversation; f.client.deleteConversation = async (id, s) => { await new Promise((resolve) => setTimeout(resolve, 700)); return del(id, s); };
  assert.equal(await (await runPromptAgent(f.options)).cleanup, true);
});
test("a late start still reserves the full cleanup budget and validation time", async () => {
  const f = fixture(), timeouts: number[] = [], respond = f.client.respond; f.options.cleanupMs = 15_000; f.options.deadline = Date.now() + 62_000;
  f.client.respond = async (c, i, s, timeout) => { timeouts.push(timeout); return respond(c, i, s, timeout); };
  await runPromptAgent(f.options); assert.ok(timeouts[0] <= 7_000, `agent phase must end 55 s before the deadline, got ${timeouts[0]} ms`);
});
test("a model call may use the configured call budget, so a long answer isn't cut off at 15 s", async () => {
  const f = fixture(), timeouts: number[] = [], respond = f.client.respond;
  Object.assign(f.options, { deadline: Date.now() + 110_000, agentMs: 55_000, callMs: 45_000, cleanupMs: 15_000 });
  f.client.respond = async (c, i, s, timeout) => { timeouts.push(timeout); return respond(c, i, s, timeout); };
  await runPromptAgent(f.options); assert.ok(timeouts[0] > 40_000 && timeouts[0] <= 45_000, `expected the 45 s call budget, got ${timeouts[0]} ms`);
});
test("operator logs carry fixed reasons, statuses and allowlisted tool names, never model or parser text", async () => {
  const lines: string[] = [], info = console.info; console.info = (s: string) => { lines.push(s); };
  try { await assert.rejects(runPromptAgent(fixture([functionReply("search Q10 Toolachee secret question")]).options), AgentRunError); } finally { console.info = info; }
  assert.ok(lines.some((l) => l.includes('"tools":["unlisted"]'))); assert.ok(!lines.join().includes("secret question"));
  let parse: unknown; try { JSON.parse("query is The Toolachee top"); } catch (e) { parse = e; }
  assert.deepEqual(failureLog(parse), { reason: "unclassified", kind: "SyntaxError" });
  assert.deepEqual(failureLog(new AgentRunError("429 rate limit for gbx-answer with echoed text", 0, true, 429, "RateLimitError")), { reason: "unclassified", kind: "RateLimitError", status: 429 });
  // The runtime wraps the underlying failure with its class, as runPromptAgent does for an app-authored Error.
  assert.deepEqual(failureLog(new AgentRunError("Agent cleanup could not be confirmed", 0, true, undefined, "Error")), { reason: "Agent cleanup could not be confirmed", kind: "Error" });
});
test("missing model usage is not reported as zero billable usage", async () => { const f = fixture([{ ...answerReply(), tokens: undefined }]); const r = await runPromptAgent(f.options); assert.equal(r.known, false); });
test("every request has distinct cleanup identity; conversations are never cached by the loop", async () => {
  const a = fixture(), b = fixture(); await Promise.all([runPromptAgent(a.options), runPromptAgent(b.options)]);
  assert.notEqual(a.journalRecords[0].requestId, b.journalRecords[0].requestId); assert.equal(a.calls.filter((x) => x === "conversation").length, 1); assert.equal(b.calls.filter((x) => x === "conversation").length, 1);
});
test("schema rejects unknown fields, fabricated citation shapes, URLs and inconsistent answerability", () => {
  for (const text of ['{}', '{"answerable":true,"sentences":[],"missing":[]}', JSON.stringify({ answerable: true, sentences: [{ kind: "fact", text: "https://account.blob.core.windows.net/page?sig=x", cites: ["L1"] }], missing: [] }), JSON.stringify({ answerable: true, sentences: [{ kind: "fact", text: "A claim", cites: ["invented-id"] }], missing: [] })]) assert.throws(() => parseAgentAnswer(text));
  assert.equal(parseAgentAnswer('{"answerable":false,"sentences":[],"missing":["No evidence"]}').answerable, false);
});
test("abortable does not leave a late rejecting operation unhandled", async () => { const c = new AbortController(); c.abort(); await assert.rejects(abortable(Promise.reject(new Error("late")), c.signal)); });

test("a lost conversation-create reply leaves a durable ambiguity marker instead of claiming cleanup", async () => {
  const f = fixture(); f.client.createConversation = async () => { throw new Error("Lost create reply"); };
  await assert.rejects(runPromptAgent(f.options), /Lost create reply/);
  assert.equal(f.journalRecords.at(-1)?.ambiguousConversation, true); assert.equal(f.journalRecords.at(-1)?.conversationId, "");
  assert.ok(!f.calls.includes("complete")); assert.ok(!f.calls.includes("respond"));
});
test("a lost response-create reply deletes known objects but retains the unresolved response marker", async () => {
  const f = fixture(); f.client.respond = async () => { throw new Error("Lost response reply"); };
  await assert.rejects(runPromptAgent(f.options), (e) => e instanceof AgentRunError && !e.known);
  assert.ok(f.calls.includes("deleteConversation")); assert.ok(!f.calls.includes("complete"));
  assert.equal(f.journalRecords.at(-1)?.ambiguousResponse, true); assert.equal(f.journalRecords.at(-1)?.conversationId, "conv-1");
});
test("contract v2: every statement has a kind, and statements beyond the old five are accepted up to the cap but not past it", () => {
  const statement = (i: number) => ({ kind: i % 2 ? "interpretation" : "fact", text: "The Toolachee top is cited from the report.", cites: ["L1"] });
  const reply = (n: number) => JSON.stringify({ answerable: true, sentences: Array.from({ length: n }, (_, i) => statement(i)), missing: [] });
  assert.equal(parseAgentAnswer(reply(6)).sentences.length, 6);
  assert.deepEqual(parseAgentAnswer(reply(AGENT_MAX_STATEMENTS)).sentences.map((s) => s.kind).slice(0, 2), ["fact", "interpretation"]);
  assert.throws(() => parseAgentAnswer(reply(AGENT_MAX_STATEMENTS + 1)), /Invalid answer schema/);
  for (const bad of [{ text: "A fact.", cites: ["L1"] }, { kind: "opinion", text: "A view.", cites: ["L1"] }, { kind: "fact", text: "A fact.", cites: ["L1"], confidence: "high" }])
    assert.throws(() => parseAgentAnswer(JSON.stringify({ answerable: true, sentences: [bad], missing: [] })), /Invalid cited sentence/);
  assert.throws(() => parseAgentAnswer(reply(1).replace("The Toolachee", "x".repeat(AGENT_ANSWER_CHARS))), /schema limit/);
});
