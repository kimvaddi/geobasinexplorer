import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import type { AgentEvidence } from "../live/agent-tools";
import { personAssertion, personTokens, rememberAssertion } from "./obo";
import { MemoryRunStore } from "./run-store";
import { ticketKey, verifyRunTicket } from "./run-ticket";
import { AgentEndpointError, COSCI_PATH, VERSION_CHECK_MS, foundryAgentEndpoint, issueHandle, registerCoScientist, verifyHandle, type AgentEndpoint, type FoundryResponse } from "./cosci";

const key = ticketKey(Buffer.alloc(32, 9).toString("base64"));
const STATEMENT = "The Toolachee Formation at Marabooka 1 lies deeper than 6,000 ft below KB";
const L1 = "L0a1b2c3d4e", L2 = "L5f6a7b8c9d", P1 = "P0123456789", T1 = "T0123456789";
const cite = (doc: string, page: number) => ({ id: `${doc}-${page}`, basin: "cooper", doc, page, heading: "", text: "" });
const EVIDENCE: AgentEvidence[] = [
  { id: L1, label: "Marabooka 1 well completion report, native PDF page 12 (live)", text: "Toolachee Formation 6,326' K.B.", citation: cite("Marabooka 1 well completion report", 12) },
  { id: L2, label: "Marabooka 1 well completion report, native PDF page 30 (live)", text: "Formation tops, depth K.B. feet: Toolachee 6326.", citation: cite("Marabooka 1 well completion report", 30) },
  { id: P1, label: "Cooper Basin play table, page 4 (packaged snapshot)", text: "The Toolachee Formation is a fluvial sandstone reservoir.", citation: cite("Cooper Basin play table", 4) },
  { id: T1, label: "Tool-derived depth conversion (verify the source datum)", text: "Depth below KB 6326 ft minus KB elevation 181.9 ft equals 6144.1 ft below sea level." },
];

function server(person = "person-1", personAuth?: () => Promise<string>) {
  const app = Fastify(), store = new MemoryRunStore();
  const starts: { body: Record<string, unknown>; who: string; person: boolean }[] = [], gets: { id: string; who: string; person: boolean }[] = [], settled: [string, number | null][] = [];
  let next: FoundryResponse = { id: "caresp_abc12345", status: "in_progress" }, ai = true, booked = 0, caller = person, down = false;
  const endpoint: AgentEndpoint = {
    start: async (body, who, _signal, p) => {
      if (down) throw new AgentEndpointError("unavailable", 503);
      starts.push({ body, who, person: !!p });
      return { id: "caresp_abc12345", status: "in_progress", gbx_identity: p ? "person" : "app" };
    },
    get: async (id, who, _signal, p) => { gets.push({ id, who, person: !!p }); return next; },
  };
  registerCoScientist(app, { endpoint, store, ticketKey: () => key, who: () => ({ id: caller, name: `${caller}@contoso.com`, roles: ["GeoBasin.Tester"], owner: false }),
    fail: (reply, e) => reply.code(500).send({ error: (e as Error).message }), aiEnabled: () => ai,
    book: async () => { booked++; return { id: `res-${booked}`, key: "tokens", amount: 300_000, day: "2026-11-08", month: "2026-11", tops: 0 }; },
    settle: async (r, used) => { settled.push([r.id, used]); }, ...(personAuth ? { person: () => personAuth } : {}) });
  const post = async (url: string, payload: unknown) => { const r = await app.inject({ method: "POST", url, payload: payload as object }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  return { store, starts, gets, post, settled, booked: () => booked, set: (r: FoundryResponse) => { next = r; }, ai: (v: boolean) => { ai = v; }, as: (p: string) => { caller = p; }, down: (v: boolean) => { down = v; } };
}
const done = (result: unknown): FoundryResponse => ({ id: "caresp_abc12345", status: "completed", created_at: 100, completed_at: 191, agent_session_id: "session-1",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] });

test("a run starts for the signed-in person: caps booked, ticket in the metadata, identity delegated, nothing without a statement or with AI off", async () => {
  const s = server();
  const r = await s.post(COSCI_PATH, { statement: `  ${STATEMENT}  ` });
  assert.equal(r.status, 200);
  assert.equal(s.booked(), 1);
  const { body, who } = s.starts[0];
  assert.equal(who, "person-1");
  assert.equal(body.input, STATEMENT);
  assert.equal(body.background, true);
  assert.equal(body.store, true);
  const parts = Object.entries(body.metadata as Record<string, string>);
  assert.ok(parts.every(([k, v]) => /^gbx_ticket_[0-3]$/.test(k) && v.length <= 512));
  const ticket = verifyRunTicket(parts.map(([, v]) => v).join(""), key);
  const handle = verifyHandle(r.body.handle, key);
  assert.deepEqual([ticket.sub, ticket.run, handle.sub, handle.response, handle.statement], ["person-1", handle.run, "person-1", "caresp_abc12345", STATEMENT]);
  assert.equal((await s.post(COSCI_PATH, { statement: "  " })).status, 400);
  s.ai(false);
  assert.equal((await s.post(COSCI_PATH, { statement: STATEMENT })).status, 503);
  assert.equal(s.starts.length, 1);
});

test("a run books a squad's tokens and settles them to what the scientists used; a run that never starts gives them back", async () => {
  const s = server();
  const { body } = await s.post(COSCI_PATH, { statement: STATEMENT });
  assert.equal(verifyHandle(body.handle, key).booking?.id, "res-1");
  s.set(done({ status: "not_found", mode: "coscientist", sentences: [], missing: ["No stress records."], dissent: [], verdicts: [], notes: [], usage: { input: 12_000, output: 3_170, total: 15_170, runs: 6 } }));
  assert.equal((await s.post(`${COSCI_PATH}/status`, { handle: body.handle })).body.status, "done");
  assert.deepEqual(s.settled, [["res-1", 15_170]]);
  s.down(true);
  assert.equal((await s.post(COSCI_PATH, { statement: STATEMENT })).status, 502);
  assert.deepEqual(s.settled, [["res-1", 15_170], ["res-2", 0]]);
});

test("only the person who started a run can read it, and a forged or expired handle is refused", async () => {
  const s = server();
  const { body } = await s.post(COSCI_PATH, { statement: STATEMENT });
  assert.equal((await s.post(`${COSCI_PATH}/status`, { handle: body.handle })).body.status, "running");
  assert.deepEqual(s.gets[0], { id: "caresp_abc12345", who: "person-1", person: false });
  s.as("person-2");
  const theirs = await s.post(`${COSCI_PATH}/status`, { handle: body.handle });
  assert.equal(theirs.status, 403);
  assert.equal(s.gets.length, 1);
  const forged = issueHandle({ run: verifyHandle(body.handle, key).run, response: "caresp_abc12345", sub: "person-2", statement: STATEMENT }, ticketKey(Buffer.alloc(32, 1).toString("base64")));
  assert.equal((await s.post(`${COSCI_PATH}/status`, { handle: forged })).status, 404);
  const old = issueHandle({ run: verifyHandle(body.handle, key).run, response: "caresp_abc12345", sub: "person-2", statement: STATEMENT }, key, Date.now() - 31 * 60_000);
  assert.equal((await s.post(`${COSCI_PATH}/status`, { handle: old })).status, 404);
});

test("the app's gate keeps only statements whose sources and numbers check out, and says who found each", async () => {
  const s = server();
  const { body } = await s.post(COSCI_PATH, { statement: STATEMENT });
  await s.store.add(verifyHandle(body.handle, key).run, EVIDENCE);
  const say = (stance: string, text: string, cites: string[], kind = "fact") => ({ kind, stance, text, cites });
  s.set(done({ status: "answered", mode: "coscientist",
    sentences: [
      say("for", "The completion report puts the Toolachee top at 6,326' K.B.", [L1, L2]),
      say("for", "That is deeper than the 6,000 ft in the hypothesis.", [L2], "interpretation"),
      say("context", "The Toolachee Formation is a fluvial sandstone reservoir with 18% porosity.", [P1]),
      say("against", "A later survey moved the top.", ["L9999999999"]),
      say("context", "Below sea level the top is at 6144.1 ft.", [T1]),
    ],
    missing: ["No independent survey of the formation pick."], dissent: [], verdicts: [{ verdict: "supported" }, { verdict: "supported" }, { verdict: "partial" }, { verdict: "supported" }, { verdict: "supported" }],
    findings: [
      { specialist: "literature", chosen: true, statements: [say("for", "Toolachee at 6,326' K.B.", [L1]), say("for", "Tops chart: Toolachee 6326.", [L2])], missing: [], error: null, ms: 9100 },
      { specialist: "stratigraphy", chosen: true, statements: [say("context", "Fluvial sandstone.", [P1]), say("context", "Toolachee top 6326.", [L2])], missing: [], error: null, ms: 8000 },
      { specialist: "spatial", chosen: false, statements: [], missing: [], error: null, ms: 0 },
    ], notes: [],
    removed: [{ text: "The top is shallower than 6,000 ft.", why: "the critic still objected after the revision: L2 puts it deeper", by: "critic" },
      { text: "It is an oil reservoir.", why: "the validator found it partial: gas, not oil" }] }));
  const r = await s.post(`${COSCI_PATH}/status`, { handle: body.handle });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "done");
  const res = r.body.result;
  assert.equal(res.status, "answered");
  assert.deepEqual(res.statements.map((x: { text: string; by: string[] }) => [x.text.slice(0, 20), x.by]), [["The completion repor", ["literature", "stratigraphy"]], ["That is deeper than ", ["literature", "stratigraphy"]]]);
  assert.deepEqual(res.statements[0].sources.map((x: { id: string }) => x.id), [L1, L2]);
  assert.deepEqual(res.removed.map((x: { by: string; why: string }) => [x.by, x.why]), [["critic", "the critic still objected after the revision: L2 puts it deeper"],
    ["validator", "the validator found it partial: gas, not oil"], ["app", "the number 18 is not in the cited source"], ["app", "it cites evidence this run did not retrieve"],
    ["app", "it cites no source passage"]]);
  assert.deepEqual(res.tally, { for: 2, against: 0, context: 0, missing: 1 });
  assert.deepEqual(res.scientists.slice(0, 3).map((x: { id: string; chosen: boolean; reported: number; inAnswer: number }) => [x.id, x.chosen, x.reported, x.inAnswer]),
    [["literature", true, 2, 2], ["stratigraphy", true, 2, 2], ["spatial", false, 0, 0]]);
  assert.deepEqual([res.checked, res.session, res.ms], [{ judged: 5, supported: 4 }, "session-1", 91_000]);

  s.set(done({ status: "answered", mode: "coscientist", sentences: [say("for", "The top is at 7,000 ft.", [L1])], missing: [], dissent: [], verdicts: [], notes: [] }));
  const none = (await s.post(`${COSCI_PATH}/status`, { handle: body.handle })).body.result;
  assert.deepEqual([none.status, none.statements.length, none.removed.length], ["validation_incomplete", 0, 1]);
  s.set({ id: "caresp_abc12345", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] });
  assert.equal((await s.post(`${COSCI_PATH}/status`, { handle: body.handle })).body.status, "failed");
});

test("the agent endpoint names a person's warm session again, never another person's, and starts afresh if it's refused", async () => {
  const bodies: { who: string; session?: string; debug?: string }[] = [];
  let clock = 0, refuse = false, n = 0, serving = "10";
  const versions = new Map<string, string>();
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>, b = JSON.parse(String(init.body ?? "{}"));
    bodies.push({ who: h["x-ms-user-identity"], session: b.agent_session_id, debug: h["x-ms-debug-latency-enabled"] });
    if (refuse && b.agent_session_id) { refuse = false; return new Response(JSON.stringify({ error: { message: "session not found" } }), { status: 404 }); }
    const session = b.agent_session_id ?? `s${++n}`;
    if (!versions.has(session)) versions.set(session, serving);
    return new Response(JSON.stringify({ id: `caresp_${bodies.length}`, status: "queued", agent_session_id: session, agent_reference: { name: "gbx-copilot", version: versions.get(session) } }), { status: 200 });
  }) as typeof fetch;
  try {
    const warm = foundryAgentEndpoint("https://aif.example/api/projects/p", "gbx-copilot", async () => "t0ken", { warmMs: 60_000, now: () => clock });
    const ask = (ep: AgentEndpoint, who: string) => ep.start({ input: "x" }, who, AbortSignal.timeout(1000));
    await ask(warm, "person-1");
    await ask(warm, "person-1");
    await ask(warm, "person-2");
    clock = 61_000;
    await ask(warm, "person-1");
    refuse = true;
    await ask(warm, "person-1");
    assert.deepEqual(bodies.map((b) => [b.who, b.session ?? null]), [
      ["person-1", null], ["person-1", "s1"], ["person-2", null], ["person-1", null], ["person-1", "s3"], ["person-1", null],
    ]);
    assert.ok(bodies.every((b) => b.debug === "true"));

    // A new agent version: sessions stay on the version that made them, so the endpoint stops naming the old ones once a
    // start without a session, at least every VERSION_CHECK_MS, has shown the new version.
    bodies.length = 0; clock = 0;
    const versioned = foundryAgentEndpoint("https://aif.example/api/projects/p", "gbx-copilot", async () => "t0ken", { warmMs: 30 * 60_000, now: () => clock });
    await ask(versioned, "person-1");
    clock = 30_000; await ask(versioned, "person-2");
    clock = 60_000; await ask(versioned, "person-1");
    serving = "11";
    clock = 120_000; await ask(versioned, "person-1");
    clock = 30_000 + VERSION_CHECK_MS + 1; await ask(versioned, "person-1");
    clock += 30_000; await ask(versioned, "person-2");
    clock += 30_000; await ask(versioned, "person-1");
    const sent = bodies.map((b) => b.session ?? null);
    assert.deepEqual(sent.map((s) => s === null ? null : versions.get(s)), [null, null, "10", "10", null, null, "11"]);
  } finally { globalThis.fetch = real; }
});

test("the agent endpoint delegates the person on every call and reports refusals", async () => {
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
    return seen.length === 1 ? new Response(JSON.stringify({ id: "caresp_1", status: "queued" }), { status: 200 }) : new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 });
  }) as typeof fetch;
  try {
    const ep = foundryAgentEndpoint("https://aif.example/api/projects/p/", "gbx-coscientist", async () => "t0ken");
    assert.equal((await ep.start({ input: "x" }, "person-1", AbortSignal.timeout(1000))).id, "caresp_1");
    await assert.rejects(ep.get("caresp_1", "person-1", AbortSignal.timeout(1000)), (e: unknown) => e instanceof AgentEndpointError && e.status === 403);
    assert.deepEqual(seen.map((c) => [c.method, c.url, c.headers["x-ms-user-identity"], c.headers.Authorization]), [
      ["POST", "https://aif.example/api/projects/p/agents/gbx-coscientist/endpoint/protocols/openai/responses?api-version=v1", "person-1", "Bearer t0ken"],
      ["GET", "https://aif.example/api/projects/p/agents/gbx-coscientist/endpoint/protocols/openai/responses/caresp_1?api-version=v1", "person-1", "Bearer t0ken"],
    ]);
  } finally { globalThis.fetch = real; }
});

test("the agent endpoint starts with the person's own token when it has one, and as the app when Foundry refuses the person or the exchange fails", async () => {
  const seen: { auth: string; who: string | null; identity: string | null; ticket: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>, b = init.body ? JSON.parse(String(init.body)) : {};
    seen.push({ auth: h.Authorization, who: h["x-ms-user-identity"] ?? null, identity: b.metadata?.gbx_identity ?? null, ticket: b.metadata?.gbx_ticket_0 ?? null });
    if (h.Authorization === "Bearer refused-token") return new Response(JSON.stringify({ error: { message: "missing role" } }), { status: 403 });
    return new Response(JSON.stringify({ id: `caresp_${seen.length}`, status: "queued", agent_session_id: `s${seen.length}`, agent_reference: { version: "12" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const ep = foundryAgentEndpoint("https://aif.example/api/projects/p", "gbx-copilot", async () => "app-token");
    const run = (p?: () => Promise<string>, who = "person-1") => ep.start({ input: "x", metadata: { gbx_ticket_0: "t" } }, who, AbortSignal.timeout(1000), p);
    assert.equal((await run(async () => "person-token")).gbx_identity, "person");
    await ep.get("caresp_1", "person-1", AbortSignal.timeout(1000), async () => "person-token");
    // The person's own session isn't named for a run the app starts for them, and the reverse.
    assert.equal((await run()).gbx_identity, "app");
    assert.equal((await run(async () => "refused-token", "person-2")).gbx_identity, "app");
    assert.equal((await run(async () => { throw new Error("exchange failed"); }, "person-3")).gbx_identity, "app");
    assert.deepEqual(seen.map((s) => [s.auth, s.who, s.identity, s.ticket]), [
      ["Bearer person-token", null, "person", "t"], ["Bearer person-token", null, null, null], ["Bearer app-token", "person-1", "app", "t"],
      ["Bearer refused-token", null, "person", "t"], ["Bearer app-token", "person-2", "app", "t"], ["Bearer app-token", "person-3", "app", "t"],
    ]);
  } finally { globalThis.fetch = real; }
});

test("a Co-Scientist run started with the person's own token is read back with it", async () => {
  const s = server("person-1", async () => "person-token");
  const r = await s.post(COSCI_PATH, { statement: STATEMENT });
  assert.equal(verifyHandle(r.body.handle, key).idn, "person");
  await s.post(`${COSCI_PATH}/status`, { handle: r.body.handle });
  assert.deepEqual([s.starts[0].person, s.gets[0].person], [true, true]);
  const app = server();
  assert.equal(verifyHandle((await app.post(COSCI_PATH, { statement: STATEMENT })).body.handle, key).idn, undefined);
});

test("only the person's own current token for this API is exchanged on their behalf, and the result is cached per person", async () => {
  const o = { tenantId: "tenant-1", clientId: "app-1", audiences: ["api://app-1", "app-1"], identityClientId: "mi-1" };
  const now = 1_800_000_000_000, user = { id: "oid-1", name: "p@contoso.com", roles: [], owner: false };
  const jwt = (over: Record<string, unknown> = {}) => `e30.${Buffer.from(JSON.stringify({ aud: "api://app-1", tid: "tenant-1", oid: "oid-1", exp: now / 1000 + 3600, ...over })).toString("base64url")}.sig`;
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
  const good = jwt();
  assert.equal(personAssertion(req({ "x-ms-token-aad-access-token": good }), user, o, now), good);
  assert.equal(personAssertion(req({ authorization: `Bearer ${good}` }), user, o, now), good);
  for (const over of [{ aud: "https://graph.microsoft.com" }, { tid: "tenant-2" }, { oid: "oid-2" }, { exp: now / 1000 + 60 }])
    assert.equal(personAssertion(req({ authorization: `Bearer ${jwt(over)}` }), user, o, now), null);
  assert.equal(personAssertion(req({ authorization: "Bearer not-a-token" }), user, o, now), null);
  let exchanged = 0, clock = now;
  const tokens = personTokens(o, { now: () => clock, exchange: async (a) => { exchanged++; assert.equal(a, good); return { token: `foundry-${exchanged}`, expiresOnTimestamp: clock + 3_600_000 }; } });
  assert.equal(tokens(user), null);
  rememberAssertion(user, good);
  const auth = tokens(user)!;
  assert.deepEqual([await auth(), await auth()], ["foundry-1", "foundry-1"]);
  clock += 3_600_000 - 4 * 60_000;
  assert.equal(await auth(), "foundry-2");
  // A token is kept against the request's own User object, so another object for the same person carries none.
  assert.equal(tokens({ ...user }), null);
});

test("a reused session keeps the version that made it, although Foundry's response names the newest one", async () => {
  const sent: (string | null)[] = [];
  let n = 0, serving = "10";
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body ?? "{}"));
    sent.push(b.agent_session_id ?? null);
    return new Response(JSON.stringify({ id: `caresp_${sent.length}`, status: "queued", agent_session_id: b.agent_session_id ?? `s${++n}`, agent_reference: { version: serving } }), { status: 200 });
  }) as typeof fetch;
  try {
    let clock = 0;
    const ep = foundryAgentEndpoint("https://aif.example/api/projects/p", "gbx-copilot", async () => "t0ken", { warmMs: 30 * 60_000, now: () => clock });
    const ask = (who: string) => ep.start({ input: "x" }, who, AbortSignal.timeout(1000));
    await ask("person-1");                 // s1, made on version 10
    serving = "11";                        // a new version is deployed
    clock = 30_000; await ask("person-1"); // still warm and on the newest version known, so s1 is named; the response says 11
    clock = 60_000; await ask("person-2"); // a fresh start shows that version 11 is current
    clock = 90_000; await ask("person-1"); // s1 still runs version 10, so it isn't named again
    assert.deepEqual(sent, [null, "s1", null, null]);
  } finally { globalThis.fetch = real; }
});
