import { AIProjectClient, type KnownApiVersions, type PromptAgentDefinition } from "@azure/ai-projects";
import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { credential, table } from "../azure";
import { cfg } from "../config";
import { agentDefinition } from "./agent-definition";

export interface AgentReply {
  id: string; status: string | null | undefined; text: string; tokens?: number;
  output: { type: string; name?: string; arguments?: unknown; call_id?: string | null }[]; requestId?: string | null;
}
export interface AgentTransport {
  verify(signal: AbortSignal): Promise<void>;
  createConversation(signal: AbortSignal): Promise<string>;
  respond(conversation: string, input: ResponseInput, signal: AbortSignal, timeout: number): Promise<AgentReply>;
  listItems(conversation: string, signal: AbortSignal): Promise<string[]>;
  deleteItem(conversation: string, item: string, signal: AbortSignal): Promise<unknown>;
  deleteResponse(id: string, signal: AbortSignal): Promise<unknown>;
  getResponse(id: string, signal: AbortSignal): Promise<unknown>;
  deleteConversation(id: string, signal: AbortSignal): Promise<unknown>;
  getConversation(id: string, signal: AbortSignal): Promise<unknown>;
}
export interface CleanupRecord { requestId: string; conversationId: string; responseIds: string[]; agentName: string; agentVersion: string; ambiguousConversation?: boolean; ambiguousResponse?: boolean }
export interface AgentJournal { save(record: CleanupRecord, signal: AbortSignal): Promise<void>; complete(record: CleanupRecord, signal: AbortSignal): Promise<void> }
const options = (signal: AbortSignal, timeout = 5_000) => ({ signal, timeout, maxRetries: 0 });
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

// v1 project management and /openai/v1 responses use different version rules. Do not send an api-version query to
// the latter. agent_reference replaces the deprecated agent field. See docs/FOUNDRY_AGENTS.md.
// https://learn.microsoft.com/rest/api/microsoft-foundry/aiproject
// https://learn.microsoft.com/javascript/api/overview/azure/ai-projects-readme?view=azure-node-latest
export function makeAgentTransport(project: Pick<AIProjectClient, "agents">, openai: OpenAI, pin: { name: string; version: string }, model: string): AgentTransport {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(pin.name) || !/^[1-9]\d*$/.test(pin.version)) throw new Error("An immutable agent name and version are required");
  let verified = false;
  return {
    async verify(signal) {
      if (verified) return;
      const version = await project.agents.getVersion(pin.name, pin.version, { abortSignal: signal, requestOptions: { timeout: 5_000 } });
      const expected = agentDefinition(model), actual = version.definition as PromptAgentDefinition;
      if (actual.kind !== "prompt" || actual.model !== expected.model || actual.instructions !== expected.instructions || canonical(actual.tools) !== canonical(expected.tools) || canonical(actual.text) !== canonical(expected.text)
        || version.name !== pin.name || version.version !== pin.version) throw new Error("Pinned agent does not match this release's model, instructions and tools");
      verified = true;
    },
    async createConversation(signal) { return (await openai.conversations.create({}, options(signal))).id; },
    async respond(conversation, input, signal, timeout) {
      // The answer format lives on the agent definition; a per-request `text` is refused when an agent is referenced.
      const r = await openai.responses.create({ conversation, input, max_output_tokens: cfg.live.agentOutputTokens,
      }, { ...options(signal, timeout), body: { agent_reference: { type: "agent_reference", name: pin.name, version: pin.version } } }).withResponse();
      return { id: r.data.id, status: r.data.status, text: r.data.output_text, output: r.data.output,
        tokens: r.data.usage?.total_tokens, requestId: r.request_id };
    },
    async listItems(conversation, signal) {
      const page = await openai.conversations.items.list(conversation, { limit: 100 }, options(signal));
      if (page.hasNextPage() || page.data.some((i) => !i.id)) throw new Error("Conversation item cleanup exceeds the bounded inventory");
      return page.data.map((i) => i.id!);
    },
    // Item id is the first argument; conversation_id belongs in the second, not in the route's first slot.
    deleteItem: (conversation, item, signal) => openai.conversations.items.delete(item, { conversation_id: conversation }, options(signal)),
    deleteResponse: (id, signal) => openai.responses.delete(id, options(signal)),
    getResponse: (id, signal) => openai.responses.retrieve(id, options(signal)),
    deleteConversation: (id, signal) => openai.conversations.delete(id, options(signal)),
    getConversation: (id, signal) => openai.conversations.retrieve(id, options(signal)),
  };
}
let transport: AgentTransport | undefined;
export function agentTransport(): AgentTransport {
  if (transport) return transport;
  const endpoint = cfg.live.projectEndpoint();
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !/\/api\/projects\/[^/]+$/.test(url.pathname) || url.search || url.hash) throw new Error("Invalid Foundry project endpoint");
  const project = new AIProjectClient(endpoint, credential, { apiVersion: "v1" as KnownApiVersions, retryOptions: { maxRetries: 0 } });
  return transport = makeAgentTransport(project, project.getOpenAIClient({ timeout: 15_000, maxRetries: 0 }), { name: cfg.live.agentName, version: cfg.live.agentVersion }, cfg.deployments.answer);
}
// Persist request-local artifact IDs, never prompts or tool data. The existing usage table is already writable by
// serving. A crash or failed cleanup leaves an operator-reconcilable record rather than a silent retention leak.
// https://learn.microsoft.com/javascript/api/@azure/data-tables/tableclient#@azure-data-tables-tableclient-upsertentity
export const agentJournal: AgentJournal = {
  async save(r, signal) { await table("usage").upsertEntity({ partitionKey: "agent-cleanup", rowKey: r.requestId, conversationId: r.conversationId,
    responseIdsJson: JSON.stringify(r.responseIds), agentName: r.agentName, agentVersion: r.agentVersion, ambiguousConversation: !!r.ambiguousConversation, ambiguousResponse: !!r.ambiguousResponse, at: new Date().toISOString(), status: "pending" }, "Replace", { abortSignal: signal }); },
  async complete(r, signal) { await table("usage").deleteEntity("agent-cleanup", r.requestId, { abortSignal: signal }); },
};
