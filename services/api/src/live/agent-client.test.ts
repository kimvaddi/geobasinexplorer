import assert from "node:assert/strict";
import { test } from "node:test";
import type { AIProjectClient } from "@azure/ai-projects";
import type OpenAI from "openai";
import { makeAgentTransport } from "./agent-client";
import { agentDefinition } from "./agent-definition";
const pin = { name: "gbx-release-test", version: "1" };
function fixture() {
  const calls: string[] = []; let actual = agentDefinition("gbx-answer");
  const signal = AbortSignal.timeout(1000);
  const project = { agents: { getVersion: async (name: string, version: string, opts: { abortSignal: AbortSignal }) => { assert.equal(name, pin.name); assert.equal(version, pin.version); assert.ok(opts.abortSignal); calls.push("version"); return { name, version, definition: actual }; } } } as unknown as Pick<AIProjectClient, "agents">;
  const options = (o: { signal: AbortSignal; maxRetries: number; timeout: number }) => { assert.equal(o.signal, signal); assert.equal(o.maxRetries, 0); assert.ok(o.timeout > 0); };
  const sdk = { conversations: {
    create: async (body: object, o: never) => { options(o); assert.deepEqual(body, {}); calls.push("create"); return { id: "conv-1" }; },
    items: { list: async (id: string, p: { limit: number }, o: never) => { options(o); assert.equal(id, "conv-1"); assert.equal(p.limit, 100); return { data: [{ id: "item-1" }], hasNextPage: () => false }; },
      delete: async (id: string, p: { conversation_id: string }, o: never) => { options(o); assert.equal(id, "item-1", "Real SDK takes item id FIRST"); assert.equal(p.conversation_id, "conv-1"); calls.push("deleteItem"); } },
    delete: async (id: string, o: never) => { options(o); assert.equal(id, "conv-1"); calls.push("deleteConversation"); }, retrieve: async () => { throw { status: 404 }; },
  }, responses: {
    create: (body: { conversation: string; input: unknown; text: { format: { strict: boolean; type: string } } }, o: { body: unknown; signal: AbortSignal; maxRetries: number; timeout: number }) => {
      options(o); assert.equal(body.conversation, "conv-1"); for (const k of ["text", "tools", "instructions", "model", "temperature", "top_p", "tool_choice"]) if (k in body) throw Object.assign(new Error("400 Not allowed when agent is specified."), { status: 400 });
      assert.deepEqual(o.body, { agent_reference: { type: "agent_reference", ...pin } }); assert.ok(!("agent" in body)); assert.ok(!("query" in o)); calls.push("response");
      return { withResponse: async () => ({ data: { id: "r1", status: "completed", output: [{ type: "message" }], output_text: "{}", usage: { total_tokens: 100 } }, request_id: "service-request-1" }) };
    }, delete: async (id: string, o: never) => { options(o); assert.equal(id, "r1"); calls.push("deleteResponse"); }, retrieve: async () => { throw { status: 404 }; },
  } } as unknown as OpenAI;
  return { calls, signal, transport: makeAgentTransport(project, sdk, pin, "gbx-answer"), setDefinition: (d: typeof actual) => { actual = d; }, project, sdk };
}
test("adapter follows tested v1 SDK request and item deletion rules without creating an agent", async () => {
  const f = fixture(); await f.transport.verify(f.signal); await f.transport.verify(f.signal); assert.equal(f.calls.filter((x) => x === "version").length, 1);
  assert.equal(await f.transport.createConversation(f.signal), "conv-1"); const reply = await f.transport.respond("conv-1", [{ role: "user", content: "Question" }], f.signal, 1000);
  assert.equal(reply.tokens, 100); assert.equal(reply.requestId, "service-request-1"); assert.deepEqual(await f.transport.listItems("conv-1", f.signal), ["item-1"]);
  await f.transport.deleteItem("conv-1", "item-1", f.signal); await f.transport.deleteResponse("r1", f.signal); await f.transport.deleteConversation("conv-1", f.signal);
});
test("runtime refuses mutable version labels and a pin with changed tools/instructions/model", async () => {
  const f = fixture(); assert.throws(() => makeAgentTransport(f.project, f.sdk, { ...pin, version: "latest" }, "gbx-answer"), /immutable/);
  f.setDefinition({ ...agentDefinition("gbx-answer"), instructions: "changed" }); await assert.rejects(f.transport.verify(f.signal), /does not match/);
});
