import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudAnswer } from "../answer";
import type { AgentEvidence } from "../live/agent-tools";
import { AgentEndpointError, type AgentEndpoint, type FoundryResponse } from "./cosci";
import { MemoryRunStore } from "./run-store";
import { ticketKey, verifyRunTicket } from "./run-ticket";
import { HandleError, annotateHandle, configureCopilot, issueHandle, pollCopilot, squadAnswer, startCopilot, verifyHandle, type CopilotPoll } from "./copilot";

const key = ticketKey(Buffer.alloc(32, 5).toString("base64"));
const person = (id: string) => ({ id, name: `${id}@contoso.com`, roles: ["GeoBasin.Tester"], owner: false });
const booking = { id: "bk1", key: "tokens", amount: 300_000, day: "d-2026-11-08", month: "m-2026-11", tops: 1 };
const Q = "Where is the top of the Toolachee Formation in Marabooka 1?";
const L1 = "L0a1b2c3d4e", L2 = "L5f6a7b8c9d", P1 = "P0123456789";
const cite = (doc: string, page: number, live?: string) => ({ id: `${doc}-${page}`, basin: "cooper", doc, page, heading: "", text: "",
  ...(live ? { live: { sourceId: live, documentSha256: "x", extractionVersion: "v", manifestVersion: 78 } } : {}) });
const EVIDENCE: AgentEvidence[] = [
  { id: L1, label: "Marabooka 1 WCR, native PDF page 25 (live)", text: "Toolachee Formation top 6326' K.B.", citation: cite("Marabooka 1 WCR", 25, "peps-sa-marabooka-1") },
  { id: L2, label: "Marabooka 1 WCR, native PDF page 61 (live)", text: "Core 1 cut from 6392' to 6454' in the Toolachee Formation.", citation: cite("Marabooka 1 WCR", 61, "peps-sa-marabooka-1") },
  { id: P1, label: "Cooper play table, page 4 (packaged snapshot)", text: "The Toolachee Formation is a fluvial sandstone reservoir.", citation: cite("Cooper play table", 4) },
];

function setup() {
  const store = new MemoryRunStore(), starts: { body: Record<string, unknown>; who: string }[] = [], gets: string[] = [];
  let next: FoundryResponse | Error = { id: "caresp_copilot1", status: "in_progress" };
  const endpoint: AgentEndpoint = {
    start: async (body, who) => { starts.push({ body, who }); return { id: "caresp_copilot1", status: "queued" }; },
    get: async (_id, who) => { gets.push(who); if (next instanceof Error) throw next; return next; },
  };
  configureCopilot({ endpoint, store, ticketKey: () => key });
  return { store, starts, gets, set: (r: FoundryResponse | Error) => { next = r; } };
}
const start = (id = "person-1") => startCopilot({ question: Q, user: person(id), near: null, requiredSourceIds: ["peps-sa-marabooka-1"], basin: "cooper", answerId: "az-1", booking, pre: 40,
  required: [{ id: "peps-sa-marabooka-1", title: "Marabooka 1 well completion report" }] }, AbortSignal.timeout(1000));

test("a question starts gbx-copilot for its person, with the ticket in the metadata and the booking in the handle", async () => {
  const s = setup();
  const handle = await start();
  assert.ok(handle);
  const { body, who } = s.starts[0];
  assert.deepEqual([who, body.input, body.background, body.store], ["person-1", Q, true, true]);
  const ticket = verifyRunTicket(Object.entries(body.metadata as Record<string, string>).filter(([k]) => k.startsWith("gbx_ticket_")).map(([, v]) => v).join(""), key);
  assert.deepEqual(JSON.parse((body.metadata as Record<string, string>).gbx_required), [{ id: "peps-sa-marabooka-1", title: "Marabooka 1 well completion report" }]);
  const h = verifyHandle(handle, key);
  assert.deepEqual([ticket.sub, ticket.run, ticket.booking, ticket.requiredSourceIds], ["person-1", h.run, "bk1", ["peps-sa-marabooka-1"]]);
  assert.deepEqual([h.response, h.q, h.basin, h.booking?.amount, h.pre, h.aid], ["caresp_copilot1", Q, "cooper", 300_000, 40, "az-1"]);
  configureCopilot(null);
  assert.equal(await start(), null);
});

test("while a run works, its poll says how many sources the scientists have read and the latest, newest first", async () => {
  const s = setup();
  const handle = (await start())!;
  const run = verifyHandle(handle, key).run;
  const first = await pollCopilot(handle, person("person-1"), AbortSignal.timeout(1000));
  assert.deepEqual(first.state === "running" && first.progress, { sources: 0, latest: [] });
  await s.store.add(run, EVIDENCE);
  const later = await pollCopilot(handle, person("person-1"), AbortSignal.timeout(1000));
  assert.deepEqual(later.state === "running" && later.progress, { sources: 3, latest: [EVIDENCE[2].label, EVIDENCE[1].label, EVIDENCE[0].label] });
  configureCopilot(null);
});

test("a started run carries what the question went through, and why it looked beyond a place, in its signed handle", async () => {
  setup();
  const handle = (await start())!;
  const steps = [{ step: "Limited to this place", detail: "First searched sources geotagged within 50 km of this point.", ms: 0 }, { step: "Checked the live pages", detail: "x".repeat(900), ms: 12 }];
  const carried = annotateHandle(handle, { steps, why: "Your question names Marabooka 1, about 282 km from this place" });
  const before = verifyHandle(handle, key), after = verifyHandle(carried, key);
  assert.deepEqual([after.run, after.sub, after.iat, after.exp, after.booking?.id], [before.run, before.sub, before.iat, before.exp, "bk1"]);
  assert.deepEqual(after.ctx?.steps.map((s) => [s.step, s.detail.length]), [["Limited to this place", steps[0].detail.length], ["Checked the live pages", 400]]);
  assert.match(after.ctx?.why ?? "", /282 km/);
  const [prefix, payload, signature] = carried.split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  forged.ctx.why = "Something the scientists never said";
  assert.throws(() => verifyHandle(`${prefix}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`, key));
  configureCopilot(null);
});

test("only the person who asked can poll, a passing error is retried, and a run that never ends is given up", async () => {
  const s = setup();
  const handle = (await start())!;
  assert.equal((await pollCopilot(handle, person("person-1"), AbortSignal.timeout(1000))).state, "running");
  await assert.rejects(pollCopilot(handle, person("person-2"), AbortSignal.timeout(1000)), (e: unknown) => e instanceof HandleError && e.status === 403);
  await assert.rejects(pollCopilot(handle.replace(/.$/, (c) => c === "A" ? "B" : "A"), person("person-1"), AbortSignal.timeout(1000)), (e: unknown) => e instanceof HandleError && e.status === 404);
  assert.deepEqual(s.gets, ["person-1"]);
  s.set(new AgentEndpointError("busy", 503));
  assert.equal((await pollCopilot(handle, person("person-1"), AbortSignal.timeout(1000))).state, "running");
  const late = await pollCopilot(handle, person("person-1"), AbortSignal.timeout(1000), Date.now() + 10 * 60_000);
  assert.equal(late.state, "failed");
  s.set({ id: "caresp_copilot1", status: "failed", error: { message: "boom" } });
  assert.equal((await pollCopilot(handle, person("person-1"), AbortSignal.timeout(1000))).state, "failed");
});

function shell(): CloudAnswer {
  return { id: "az-1", question: Q, status: "unsupported", basin: "cooper", paragraphs: [], provenance: [], citations: [], focus: null, focusBasin: "cooper",
    highlight: [], followUps: [], why: { terms: [], rule: "", scores: [] }, label: "Not found", hits: [], reason: "", trace: [], ms: 0, engine: "azure", tokens: 0,
    validation: { status: "not-run", validator: "Grok 4.1 Fast", checked: 0, supported: 0, removed: [], note: "" } } as CloudAnswer;
}
const withheld = (a: CloudAnswer, why: string) => Object.assign(a, { reason: "Validation incomplete", paragraphs: [`Validation incomplete. ${why}`], citations: [],
  validation: { ...a.validation, status: "incomplete" as const, note: why } });
const say = (kind: string, text: string, cites: string[], stance = "context") => ({ kind, stance, text, cites });
async function done(result: Record<string, unknown>, req = ["peps-sa-marabooka-1"]): Promise<Extract<CopilotPoll, { state: "done" }>> {
  const s = setup();
  const handle = (await start())!;
  const h = { ...verifyHandle(handle, key), req };
  await s.store.add(h.run, EVIDENCE);
  s.set({ id: "caresp_copilot1", status: "completed", created_at: 100, completed_at: 134, agent_session_id: "session-1",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ mode: "copilot", missing: [], dissent: [], verdicts: [], findings: [], notes: [], ...result }) }] }] });
  const r = await pollCopilot(issueHandle(h, key), person("person-1"), AbortSignal.timeout(1000));
  assert.equal(r.state, "done");
  return r as Extract<CopilotPoll, { state: "done" }>;
}

test("a finished run becomes a cited answer: facts first, interpretations after, and anything unchecked removed", async () => {
  const r = await done({
    status: "answered", rebutted: true, critique: ["The first draft said oil."], usage: { input: 90_000, output: 4_000, total: 94_000, runs: 9 },
    sentences: [say("fact", "The Toolachee Formation top is at 6326' K.B. in Marabooka 1.", [L1]), say("interpretation", "That makes the Toolachee the shallowest formation cored in the well.", [L1]),
      say("fact", "Core 1 was cut from 6392' to 6454' in the Toolachee.", [L2, P1]), say("fact", "The top is at 7,100 ft.", [L1])],
    verdicts: [{ verdict: "supported" }, { verdict: "supported" }, { verdict: "supported" }, { verdict: "supported" }, { verdict: "partial" }],
    removed: [{ text: "It is the main oil reservoir.", why: "the validator found it partial: gas, not oil" }],
    findings: [{ specialist: "literature", chosen: true, statements: [], missing: [], error: null, ms: 9000 }, { specialist: "stratigraphy", chosen: true, statements: [], missing: [], error: null, ms: 8000 }],
  });
  const a = squadAnswer(shell(), r, { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.deepEqual([a.status, a.label, a.validation.status], ["answered", "Retrieved", "passed"]);
  assert.deepEqual(a.citations.map((c) => c.id), ["Marabooka 1 WCR-25", "Marabooka 1 WCR-61", "Cooper play table-4"]);
  assert.deepEqual(a.paragraphs, ["The Toolachee Formation top is at 6326' K.B. in Marabooka 1. [1] Core 1 was cut from 6392' to 6454' in the Toolachee. [2][3]",
    "**Interpretation, reasoned from the cited sources:** That makes the Toolachee the shallowest formation cored in the well. [1]"]);
  assert.deepEqual(a.validation.removed.map((x) => x.why), ["The scientists' check: the validator found it partial: gas, not oil.", "GeoBasin's check: the number 7,100 is not in the cited source."]);
  assert.deepEqual([a.validation.checked, a.validation.supported], [5, 4]);
  const steps = a.trace!.map((t) => t.step);
  assert.deepEqual(steps, ["Asked the Foundry scientists", "The critic sent the draft back", "Counted the tokens", "Validated"]);
  assert.match(a.trace![2].detail, /94,000 tokens across 9 model runs/);
  assert.match(a.trace![0].detail, /literature and stratigraphy scientists/);
});

test("a required live source must back a fact, and blocked, not found and unconfirmed runs show nothing unchecked", async () => {
  const packagedOnly = await done({ status: "answered", sentences: [say("fact", "The Toolachee Formation is a fluvial sandstone reservoir.", [P1])], verdicts: [{ verdict: "supported" }] });
  const a = squadAnswer(shell(), packagedOnly, { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.deepEqual([a.reason, a.citations.length], ["Validation incomplete", 0]);
  assert.match(a.validation.note, /required live source/);
  const free = squadAnswer(shell(), await done({ status: "answered", sentences: [say("fact", "The Toolachee Formation is a fluvial sandstone reservoir.", [P1])], verdicts: [{ verdict: "supported" }] }, []),
    { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.deepEqual([free.status, free.citations.length], ["answered", 1]);
  const blocked = squadAnswer(shell(), await done({ status: "blocked", rebutted: true, critique: ["Contradicts L2."], dissent: ["Contradicts L2."] }), { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.deepEqual([blocked.reason, blocked.validation.status, blocked.paragraphs.join(" ").includes("Contradicts")], ["Blocked by the critic", "blocked", false]);
  const none = squadAnswer(shell(), await done({ status: "not_found", missing: ["a velocity survey"] }), { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.deepEqual([none.reason, none.paragraphs], ["No supported live evidence", ["Not found in the published evidence. No supported answer was returned."]]);
  const unconfirmed = squadAnswer(shell(), await done({ status: "validation_incomplete" }), { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.equal(unconfirmed.validation.status, "incomplete");
  const throttled = squadAnswer(shell(), await done({ status: "validation_incomplete", findings: [
    { specialist: "literature", chosen: true, statements: [], missing: [], error: "ChatClientException", ms: 20_000 },
    { specialist: "spatial", chosen: true, statements: [], missing: [], error: "ChatClientException", ms: 14_000 }] }), { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.match(throttled.validation.note, /None of the scientists could finish its search/);
  const struck = squadAnswer(shell(), await done({ status: "answered", rebutted: true, critique: ["Statement 3 cites the wrong survey."],
    sentences: [say("fact", "The Toolachee Formation top is at 6326' K.B. in Marabooka 1.", [L1])], verdicts: [{ verdict: "supported" }],
    removed: [{ text: "The threshold matched borehole bedrock depths.", why: "the critic still objected after the revision: it cites AusAEM records", by: "critic" }] }),
  { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.equal(struck.status, "answered");
  assert.match(struck.trace!.find((t) => t.step === "The critic sent the draft back")!.detail, /still disputed 1 statement of the revision, which was removed before the independent check/);
  assert.deepEqual(struck.validation.removed.map((x) => x.why), ["The scientists' check: the critic still objected after the revision: it cites AusAEM records."]);
});

test("a run started as the person is polled as them, and its trace says whether Fabric IQ answered as them", async () => {
  const store = new MemoryRunStore(), polledAsPerson: boolean[] = [];
  let identity: "person" | "app" = "person", startedAsPerson = false;
  const endpoint: AgentEndpoint = {
    start: async (_b, _w, _s, p) => { startedAsPerson = !!p; return { id: "caresp_copilot1", status: "queued", gbx_identity: identity }; },
    get: async (_id, _w, _s, p) => { polledAsPerson.push(!!p); return { id: "caresp_copilot1", status: "in_progress" }; },
  };
  const auth = async () => "person-token";
  configureCopilot({ endpoint, store, ticketKey: () => key, person: () => auth });
  const asPerson = verifyHandle((await start())!, key);
  assert.deepEqual([startedAsPerson, asPerson.idn], [true, "person"]);
  await pollCopilot(issueHandle(asPerson, key), person("person-1"), AbortSignal.timeout(1000));
  identity = "app";
  const asApp = verifyHandle((await start())!, key);
  assert.equal(asApp.idn, "app");
  await pollCopilot(issueHandle(asApp, key), person("person-1"), AbortSignal.timeout(1000));
  assert.deepEqual(polledAsPerson, [true, false]);
  configureCopilot(null);

  const fact = [say("fact", "The Toolachee Formation top is at 6326' K.B. in Marabooka 1.", [L1])];
  const asked = squadAnswer(shell(), await done({ status: "answered", sentences: fact, verdicts: [{ verdict: "supported" }], knowledge: { asked: 2, answered: 1, ms: 17_400, fallback: "" } }),
    { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.match(asked.trace!.find((t) => t.step === "Asked Fabric IQ as you")!.detail, /1 of 2 questions answered in 17\.4 s/);
  const failed = squadAnswer(shell(), await done({ status: "not_found", knowledge: { asked: 1, answered: 0, ms: 75_000, fallback: "TimeoutError" } }), { validator: "Grok 4.1 Fast", manifest: null, withheld });
  assert.match(failed.trace!.find((t) => t.step === "Fabric IQ didn't answer")!.detail, /\(TimeoutError\).*typed knowledge tools/);
  const fellBack = await done({ status: "not_found" });
  fellBack.h.idn = "app";
  assert.ok(squadAnswer(shell(), fellBack, { validator: "Grok 4.1 Fast", manifest: null, withheld }).trace!.some((t) => t.step === "Fabric IQ wasn't asked"));
});
