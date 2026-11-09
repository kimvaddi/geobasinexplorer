// Operator-only provisioning/reconciliation. Default is a local plan; --create or --cleanup <requestId> is explicit.
// This is never imported or executed by the HTTP service. One immutable version is created per release/digest name.
// https://learn.microsoft.com/javascript/api/overview/azure/ai-projects-readme?view=azure-node-latest
// https://learn.microsoft.com/rest/api/microsoft-foundry/aiproject
import { AIProjectClient, type KnownApiVersions } from "@azure/ai-projects";
import { credential, table } from "../src/azure";
import { cfg } from "../src/config";
import { agentDefinition, agentDefinitionDigest, agentReleaseName } from "../src/live/agent-definition";
import { agentJournal, makeAgentTransport, type CleanupRecord } from "../src/live/agent-client";
import { cleanupAgentArtifacts } from "../src/live/agent-runtime";

const args = process.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const create = args.includes("--create"), cleanupId = value("--cleanup");
if (create && cleanupId) throw new Error("Choose provisioning or cleanup, not both");
for (let i = 0; i < args.length; i++) {
  if (["--release", "--cleanup"].includes(args[i])) { if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing option value"); }
  else if (args[i] !== "--create") throw new Error(`Unknown option ${args[i]}`);
}
if (cleanupId) {
  if (!/^[a-f0-9-]{36}$/.test(cleanupId)) throw new Error("Invalid cleanup request id");
  const row = await table("usage").getEntity<{ conversationId: string; responseIdsJson: string; agentName: string; agentVersion: string; ambiguousConversation?: boolean; ambiguousResponse?: boolean }>("agent-cleanup", cleanupId);
  const record: CleanupRecord = { requestId: cleanupId, conversationId: row.conversationId, responseIds: JSON.parse(row.responseIdsJson), agentName: row.agentName, agentVersion: row.agentVersion, ambiguousConversation: row.ambiguousConversation, ambiguousResponse: row.ambiguousResponse };
  if (record.ambiguousConversation && !record.conversationId) throw new Error("An ambiguous conversation creation needs service-log reconciliation before cleanup can be certified");
  if (!/^conv_[A-Za-z0-9]+$/.test(record.conversationId) || !Array.isArray(record.responseIds) || record.responseIds.length > 5 || record.responseIds.some((id) => !/^resp_[A-Za-z0-9]+$/.test(id))) throw new Error("Invalid stored cleanup identities");
  const project = new AIProjectClient(cfg.live.projectEndpoint(), credential, { apiVersion: "v1" as KnownApiVersions, retryOptions: { maxRetries: 0 } });
  const transport = makeAgentTransport(project, project.getOpenAIClient({ maxRetries: 0 }), { name: record.agentName, version: record.agentVersion }, cfg.deployments.answer);
  const complete = await cleanupAgentArtifacts(record, transport, agentJournal, 30_000);
  console.log(JSON.stringify({ requestId: cleanupId, complete })); if (!complete) process.exitCode = 1;
} else {
  const release = value("--release"); if (!release) throw new Error("Supply --release <version>. Without --create this command makes no service calls.");
  const name = agentReleaseName(release, cfg.deployments.answer);
  console.log(JSON.stringify({ status: create ? "IN PROGRESS" : "PLANNED", release, name, model: cfg.deployments.answer, definitionSha256: agentDefinitionDigest(cfg.deployments.answer) }));
  if (create) {
    const signal = AbortSignal.timeout(30_000);
    const project = new AIProjectClient(cfg.live.projectEndpoint(), credential, { apiVersion: "v1" as KnownApiVersions, retryOptions: { maxRetries: 0 } });
    let version = "1", exists = false;
    try { await project.agents.getVersion(name, version, { abortSignal: signal }); exists = true; }
    catch (e) { if ((e as { statusCode?: number }).statusCode !== 404) throw e; }
    if (!exists) version = (await project.agents.createVersion(name, agentDefinition(cfg.deployments.answer), { abortSignal: signal, requestOptions: { timeout: 30_000 } })).version;
    if (version !== "1") throw new Error("Concurrent or unexpected release creation: reconcile this agent before configuring serving");
    const transport = makeAgentTransport(project, project.getOpenAIClient({ maxRetries: 0 }), { name, version }, cfg.deployments.answer);
    await transport.verify(signal);
    console.log(JSON.stringify({ GBX_AGENT_NAME: name, GBX_AGENT_VERSION: version, created: !exists }));
  }
}
