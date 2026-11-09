import { PHASE1A_V1_DOC_IDS } from "./live/source-policy";
import { parseDataScope } from "./data-scope";
// Settings and hard limits. Every cap fails closed: if the usage store can't be read, the request is refused.
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing setting ${k}`);
  return v;
};
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export function parseLiveSources(value = ""): string[] {
  const ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.some((id) => !Object.hasOwn(PHASE1A_V1_DOC_IDS, id))) throw new Error("GBX_LIVE_SOURCES contains an unsupported source id");
  return ids;
}
// GBX_LIVE_ROUTE: which questions the prepared rules don't cover go to the live agent (serving-policy.ts routedLiveSources).
export type LiveRoute = "matched" | "all";
export function parseLiveRoute(value = ""): LiveRoute {
  const route = value.trim() || "matched";
  if (route !== "matched" && route !== "all") throw new Error("GBX_LIVE_ROUTE must be matched or all");
  return route;
}
// 48 is the most that eight rounds of six calls could make, and the size of the evidence registry (agent-tools.ts).
export function parseAgentToolCalls(value = ""): number {
  const calls = value.trim() ? Number(value) : 12;
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > 48) throw new Error("GBX_AGENT_TOOL_CALLS must be a whole number from 1 to 48");
  return calls;
}

export const cfg = {
  port: num("PORT", 8080),
  aiEnabled: (process.env.GBX_AI_ENABLED ?? "true") === "true",
  // Off while Microsoft Defender for Storage is paused (infra/defender.sh): uploads are then refused, never read unscanned.
  malwareScan: (process.env.GBX_MALWARE_SCAN ?? "on") !== "off",
  foundryEndpoint: () => env("FOUNDRY_ENDPOINT").replace(/\/+$/, ""),
  docIntelEndpoint: () => env("DOCINTEL_ENDPOINT").replace(/\/+$/, ""),
  searchEndpoint: () => env("SEARCH_ENDPOINT").replace(/\/+$/, ""),
  storageAccount: () => env("STORAGE_ACCOUNT"),
  index: process.env.GBX_INDEX ?? "gbx-passages",
  // Empty for the main app; a second site sharing the same storage (a demonstration site, say) sets its own scope (data-scope.ts).
  dataScope: parseDataScope(process.env.GBX_DATA_SCOPE),
  // Live-lane serving. Agent versions are provisioned by an operator, never in the answer request.
  // https://learn.microsoft.com/rest/api/microsoft-foundry/aiproject
  live: {
    sources: parseLiveSources(process.env.GBX_LIVE_SOURCES),
    route: parseLiveRoute(process.env.GBX_LIVE_ROUTE),
    projectEndpoint: () => env("FOUNDRY_PROJECT_ENDPOINT").replace(/\/+$/, ""),
    agentName: process.env.GBX_AGENT_NAME ?? "",
    agentVersion: process.env.GBX_AGENT_VERSION ?? "",
    // The agent phase ends 40 s before the deadline at the latest, leaving validation and the agent's cleanup, which run
    // side by side, their reserves inside Front Door's 120 s origin timeout (agent-runtime.ts).
    totalMs: 110_000, agentMs: 70_000, agentCallMs: 45_000, validationMs: 40_000, cleanupMs: 15_000, agentRounds: 8,
    // "off" takes ClamAV out of the live lane (owner exception 12, 4 Nov 2026): landing queues straight to processing and
    // lineage says "Not scanned". Every file must still match its registered SHA-256. On by default; never fails open.
    scan: (process.env.GBX_LIVE_SCAN ?? "on") !== "off",
    // "off" stops the Purview catalogue projection (owner exception 13); lineage stays in the app's own lineage table.
    purview: (process.env.GBX_PURVIEW ?? "on") !== "off",
    // Answer contract v2 allows fourteen statements, so the agent has its own output allowance and the library writer
    // keeps maxOutputTokens.answer. Each round's allowance counts in full towards gbx-answer's tokens-per-minute limit when
    // the request is admitted, so a larger one makes throttling likelier (agent-tools.ts, live/README.md).
    agentOutputTokens: 2_400, agentToolCalls: parseAgentToolCalls(process.env.GBX_AGENT_TOOL_CALLS),
  },
  deployments: {
    answer: process.env.GBX_ANSWER_DEPLOYMENT ?? "gbx-answer",
    validator: process.env.GBX_VALIDATOR_DEPLOYMENT ?? "gbx-validator",
    embed: process.env.GBX_EMBED_DEPLOYMENT ?? "gbx-embed",
  },
  models: { answer: "GPT-6 Astra", validator: "Grok 4.1 Fast", embed: "text-embedding-3-large" },
  canonicalHost: process.env.GBX_CANONICAL_HOST ?? "",
  // With GBX_APEX_HOST set, requests to the bare domain are redirected to GBX_CANONICAL_HOST.
  apexHost: process.env.GBX_APEX_HOST ?? "",
  requireAuth: (process.env.GBX_REQUIRE_AUTH ?? "true") === "true",
  // This app's own public address, used to confirm the Container Apps sign-in layer is in front of it.
  selfUrl: (process.env.GBX_SELF_URL ?? "").replace(/\/+$/, ""),
  owners: (process.env.GBX_OWNERS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
  // Azure Maps (keyless): the account's client ID goes to the browser with each token; the identity holds only render read.
  // us.atlas.microsoft.com keeps map requests in the United States geography (Learn: geographic-scope).
  maps: {
    accountClientId: process.env.MAPS_ACCOUNT_CLIENT_ID ?? "",
    identityClientId: process.env.MAPS_IDENTITY_CLIENT_ID ?? "",
    domain: process.env.MAPS_DOMAIN ?? "us.atlas.microsoft.com",
  },
  // Internal address of the GDAL/PROJ spatial service in the same Container Apps environment.
  spatialUrl: (process.env.GBX_SPATIAL_URL ?? "").replace(/\/+$/, ""),
  // Esri base maps (esri.ts): an ArcGIS Location Platform key, held as a Container Apps secret. Empty turns them off.
  esri: { apiKey: process.env.ESRI_API_KEY ?? "" },
  // Planetary Computer Pro overlays (planetary.ts): the GeoCatalog's address, the client ID of the relay identity that
  // holds GeoCatalog Reader on it, and each collection's registered mosaic as collection=searchid pairs. Empty turns
  // them off.
  planetary: {
    catalogUri: (process.env.PC_CATALOG_URI ?? "").replace(/\/+$/, ""),
    identityClientId: process.env.PC_IDENTITY_CLIENT_ID ?? "",
    searches: process.env.PC_SEARCHES ?? "",
  },
  // Owner budget: 1,500 USD a month (1 Nov 2026). Fixed infrastructure is about 600 USD (Front Door Premium, Search
  // Basic, private endpoints, always-on web replica, logs), or about 670 USD if both Container Apps private-endpoint
  // meters apply. Even if every capped token were billed at GPT-6 Astra's data-zone output price (55 USD per million),
  // 12 million tokens cost 660 USD, so a full month stays inside the budget; at a realistic input/output mix it is
  // about 240 USD (docs/DEPLOYMENT.md, "Spend controls"). Since 4 Nov 2026 the cloud deployments set the question
  // and token caps far above any real use, so there only the budget alerts and the
  // kill switch bound model spend, and these defaults apply only where no setting is given.
  caps: {
    questionsPerUserPerDay: num("GBX_CAP_USER_QUESTIONS", 60),
    questionsPerDay: num("GBX_CAP_QUESTIONS", 300),
    questionsPerMonth: num("GBX_CAP_QUESTIONS_MONTH", 3_000),
    tokensPerDay: num("GBX_CAP_TOKENS", 2_000_000),
    tokensPerMonth: num("GBX_CAP_TOKENS_MONTH", 12_000_000),
    ocrPagesPerDay: num("GBX_CAP_OCR_PAGES", 500),
    ocrPagesPerMonth: num("GBX_CAP_OCR_PAGES_MONTH", 5_000),
    uploadsPerUserPerDay: num("GBX_CAP_USER_UPLOADS", 20),
    evalRunsPerDay: num("GBX_CAP_EVAL_RUNS", 4),
    uploadBytes: num("GBX_CAP_UPLOAD_MB", 50) * 1024 * 1024,
    maxPages: num("GBX_CAP_MAX_PAGES", 300),
    // About 30 KB a passage with its vector, so 20,000 passages is roughly 600 MB of the Basic tier's 15 GB.
    indexPassages: num("GBX_CAP_INDEX_PASSAGES", 20_000),
    spatialPerUserPerMinute: num("GBX_CAP_SPATIAL_PER_MINUTE", 120),
    // Esri's free tier is 2 million base-map tiles a month (location.arcgis.com/pricing), and the account has no payment
    // method, so Esri can't bill. These caps keep the relay well inside the free tier. A busy minute of zooming and
    // panning on a 1,060 by 800 map took 186 tiles (measured 3 Nov 2026), and a large screen needs several times more,
    // so one person gets 15,000 a day; the shared daily and monthly caps hold the total. Tiles are booked in blocks of
    // 100 (esri.ts).
    esriTilesPerUserPerDay: num("GBX_CAP_USER_ESRI_TILES", 15_000),
    esriTilesPerDay: num("GBX_CAP_ESRI_TILES", 60_000),
    esriTilesPerMonth: num("GBX_CAP_ESRI_TILES_MONTH", 1_500_000),
    // Planetary Computer Pro bills each rendered tile as a data operation (0.007 USD per 10,000 on 4 Nov 2026), and the
    // relayed tiles add Front Door and inter-region transfer, so a capped month costs about 16 USD at most
    // (docs/DEPLOYMENT.md, "Spend controls"). One overlay of 512-pixel tiles over one basin needs about a quarter
    // of the tiles the Esri base map does; tiles served from the relay's cache aren't counted.
    pcTilesPerUserPerDay: num("GBX_CAP_USER_PC_TILES", 10_000),
    pcTilesPerDay: num("GBX_CAP_PC_TILES", 40_000),
    pcTilesPerMonth: num("GBX_CAP_PC_TILES_MONTH", 600_000),
    // A drawn area's Planetary Computer summary (planetary.ts) is two catalog searches and one statistics read for each
    // Copernicus DEM tile it touches, at most fourteen data operations, so even a capped month costs about ten US cents.
    pcAreasPerUserPerDay: num("GBX_CAP_USER_PC_AREAS", 200),
    pcAreasPerDay: num("GBX_CAP_PC_AREAS", 1_000),
    pcAreasPerMonth: num("GBX_CAP_PC_AREAS_MONTH", 10_000),
  },
  // Stage budgets (the Tier A target is p95 <= 8 s; these are timeouts, measured separately).
  // Grok's answer time varies a lot: the same four-statement check took 13 s and then more than 30 s, so validation gets
  // 45 s, well inside Front Door's 120 s origin timeout.
  timeoutsMs: { retrieval: 4_000, generation: 20_000, validation: num("GBX_VALIDATION_TIMEOUT_MS", 45_000), spatial: 15_000, esri: 8_000, planetary: 12_000 },
  maxOutputTokens: { answer: 1_200, validator: 3_000 },
  // Booked against the token caps before any model is called and settled to the real count afterwards, so concurrent
  // questions can't all slip under the cap. It must exceed what one question can use (docs/DEPLOYMENT.md).
  reserveTokensPerQuestion: num("GBX_RESERVE_TOKENS", 40_000),
  // Version 2's tool server for the scientists' hosted agents (v2/tool-server.ts), off unless GBX_TOOL_SERVER=on, so a
  // version 1 deployment is unchanged. GBX_TOOL_CALLERS lists the object IDs of the identities allowed to call it, and
  // GBX_RUN_TICKET_KEY is the base64 key that signs run tickets, held as a Container Apps secret from Key Vault.
  v2: {
    toolServer: (process.env.GBX_TOOL_SERVER ?? "off") === "on",
    toolCallers: (process.env.GBX_TOOL_CALLERS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
    ticketKey: () => env("GBX_RUN_TICKET_KEY"),
    // "memory" keeps run registers in the process, for a local run only; the cloud uses the table.
    runStore: process.env.GBX_RUN_STORE === "memory" ? "memory" as const : "table" as const,
    // The Co-Scientist on the hosted scientists (v2/cosci.ts), off unless GBX_V2_SCIENTISTS=on and the tool server runs.
    // GBX_V2_AGENTS_CLIENT_ID is the managed identity that may call the agent; a local run uses the Azure CLI sign-in.
    scientists: (process.env.GBX_V2_SCIENTISTS ?? "off") === "on",
    projectEndpoint: process.env.GBX_V2_PROJECT_ENDPOINT ?? "",
    coscientistAgent: process.env.GBX_V2_COSCIENTIST_AGENT ?? "gbx-coscientist",
    agentsClientId: process.env.GBX_V2_AGENTS_CLIENT_ID ?? "",
    // The copilot on the hosted scientists (v2/copilot.ts), off unless GBX_V2_COPILOT=on; a squad's token booking.
    copilot: (process.env.GBX_V2_COPILOT ?? "off") === "on",
    copilotAgent: process.env.GBX_V2_COPILOT_AGENT ?? "gbx-copilot",
    reserveTokens: num("GBX_V2_RESERVE_TOKENS", 300_000),
    // The library in OneLake (docs/LIBRARY_ONELAKE.md): live passages come from the index the OneLake files indexer fills
    // from gold, gbx-evidence-onelake, once it covers the current publication; empty keeps every read on the push index.
    libraryIndex: /^[a-z0-9][a-z0-9-]{1,127}$/.test(process.env.GBX_V2_LIBRARY_INDEX ?? "") ? process.env.GBX_V2_LIBRARY_INDEX! : "",
    // The Fabric knowledge graph behind the knowledge tools (v2/knowledge.ts), read with its own managed identity; any
    // empty value leaves the tools telling the scientists that the graph isn't connected.
    fabric: { workspaceId: process.env.GBX_V2_FABRIC_WORKSPACE ?? "", graphModelId: process.env.GBX_V2_FABRIC_GRAPH ?? "", clientId: process.env.GBX_V2_FABRIC_CLIENT_ID ?? "" },
    // The scientists ask Fabric IQ as the signed-in person (v2/obo.ts). GBX_OBO_CLIENT_ID is the sign-in
    // registration, GBX_OBO_TENANT_ID its tenant, and the agents identity its credential; without them, or without a
    // managed identity, every run starts as the app and the scientists use the typed knowledge tools.
    obo: process.env.GBX_OBO_CLIENT_ID && process.env.GBX_OBO_TENANT_ID && process.env.GBX_V2_AGENTS_CLIENT_ID && process.env.IDENTITY_ENDPOINT
      ? { clientId: process.env.GBX_OBO_CLIENT_ID, tenantId: process.env.GBX_OBO_TENANT_ID, identityClientId: process.env.GBX_V2_AGENTS_CLIENT_ID,
        audiences: [`api://${process.env.GBX_OBO_CLIENT_ID}`, process.env.GBX_OBO_CLIENT_ID] }
      : null,
  },
};
