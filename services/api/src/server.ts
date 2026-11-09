// The GeoBasin Explorer AI cloud service: serves the cloud build of the app and its API.
// Sign-in: Container Apps authentication (Microsoft Entra ID, AllowAnonymous) performs the sign-in and injects
// identity headers; this server requires them on every route except the health check and certificate validation.
import "./otel";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fstatic from "@fastify/static";
import { cfg } from "./config";
import { signInLayerState, userOf, verifySignInLayer, type User } from "./auth";
import { askCloud, configureVerdicts, copilotStatus } from "./answer";
import { TableVerdictStore } from "./verdict-cache";
import { CapError, keys, reserve, settle, take, takeBoth } from "./usage";
import { jobStatus, startIngest } from "./ingest-api";
import { decideReview, listReviews, rollbackReview } from "./reviews";
import { recordFeedback } from "./feedback";
import { sourcePassage } from "./sources";
import { SpatialError, mapsToken, spatialHere, spatialSection, spatialTransform } from "./maps";
import { EsriError, blockBooker, esriRelay } from "./esri";
import { PlanetaryError, catalogToken, parseSearches, planetaryRelay } from "./planetary";
import { parseArea, parseNear, sourcesInArea, sourcesNear } from "./geo";
import { cacheHeaders } from "./static-cache";
import { counterClockwise } from "@/lib/area";
// Live-lane owner-only landing, review and pending-page routes.
import { registerLiveAdminRoutes } from "./live/pipeline-admin";
import { registerLiveServingRoutes } from "./live/serving-pages";
import { evidenceSearch } from "./live/serving-evidence";
import { liveManifest } from "./live/serving-manifest";
import { table } from "./azure";
import { scopedTable } from "./data-scope";
import { registerToolServer } from "./v2/tool-server";
import { MemoryRunStore, TableRunStore } from "./v2/run-store";
import { ticketKey } from "./v2/run-ticket";
import { foundryAgentEndpoint, registerCoScientist } from "./v2/cosci";
import { COPILOT_STATUS_PATH, HandleError, configureCopilot } from "./v2/copilot";
import { fabricGraph } from "./v2/knowledge";
import { personAssertion, personTokens, rememberAssertion } from "./v2/obo";
import { AzureCliCredential, ManagedIdentityCredential, getBearerTokenProvider } from "@azure/identity";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, "../public");
const VERSION = process.env.GBX_VERSION ?? "0.9.0";

const app = Fastify({
  trustProxy: true,
  bodyLimit: 64 * 1024,
  // Live-lane extraction versions are 111 characters and fully bound chunk IDs are longer still.
  routerOptions: { maxParamLength: 512 },
  logger: { level: "info", redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-ms-client-principal"]', 'req.headers["x-ms-token-aad-id-token"]', 'req.headers["x-ms-token-aad-access-token"]'] },
});
await app.register(multipart, { limits: { fileSize: cfg.caps.uploadBytes, files: 1, fields: 4 } });
// In the cloud the independent check's verdicts on prepared answers are kept in the site's own table and reused while
// nothing they judged has changed (verdict-cache.ts); a local run keeps them in memory.
if (process.env.IDENTITY_ENDPOINT) configureVerdicts(new TableVerdictStore(table(scopedTable(cfg.dataScope, "verdicts"))));

// Azure Maps: tiles, styles, fonts (glyphs and the control's TTF fonts) and sprites come from the Maps service, the map renders in web workers, and the
// depth tints and overlays it draws are images generated in the browser (data: and blob: URLs).
const ATLAS = "https://atlas.microsoft.com https://*.atlas.microsoft.com";
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", `img-src 'self' data: blob: ${ATLAS}`, `font-src 'self' data: ${ATLAS}`, `connect-src 'self' ${ATLAS} data: blob:`, "worker-src 'self' blob:", "child-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
const OPEN = (url: string) => url === "/api/health" || url.startsWith("/.well-known/");
const callers = new WeakMap<FastifyRequest, User>();
class AuthError extends Error {}
// Where the sign-in registration trusts the agents' identity, the scientists ask Fabric IQ as the person.
const obo = cfg.v2.obo;
const person = obo ? personTokens(obo) : undefined;

app.addHook("onRequest", async (req, reply) => {
  reply.header("x-gbx-origin", "app"); // lets the sign-in check tell this app's answers from the platform's
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  reply.header("Content-Security-Policy", CSP);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  // One canonical host: the apex (and anything else that isn't the container's own name) goes to the canonical host before sign-in.
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0].toLowerCase();
  if (host === cfg.apexHost) return reply.code(301).redirect(`https://${cfg.canonicalHost}${req.url}`);
  if (OPEN(req.url)) return;
  if (!cfg.requireAuth) return;
  // The caller is fixed here, before any body is read, so a later change in the sign-in check can't alter who a
  // long upload belongs to.
  const u = userOf(req);
  if (u) { callers.set(req, u); if (obo) rememberAssertion(u, personAssertion(req, u, obo)); return; }
  if (!signInLayerState().ok) return reply.code(503).send({ error: "Sign-in is being confirmed. Try again in a minute." });
  if (req.url.startsWith("/api/")) return reply.code(401).send({ error: "Sign-in required.", login: "/.auth/login/aad" });
  return reply.code(302).redirect(`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(req.url)}`);
});

/* Only a local run without sign-in (GBX_REQUIRE_AUTH=false) has an implicit operator; otherwise no identity means 401. */
const who = (req: FastifyRequest): User => {
  const u = callers.get(req);
  if (u) return u;
  if (!cfg.requireAuth) return { id: "local", name: "local operator", roles: [], owner: true };
  throw new AuthError();
};
const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof AuthError) return reply.code(401).send({ error: "Sign-in required.", login: "/.auth/login/aad" });
  if (e instanceof CapError) return reply.code(429).send({ error: e.message });
  if (e instanceof SpatialError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof EsriError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof PlanetaryError) return reply.code(e.status).send({ error: e.message });
  const msg = (e as Error).message ?? "Unexpected error";
  app.log.error({ err: msg }, "request failed");
  return reply.code(500).send({ error: "The service couldn't complete that request. Please try again." });
};

// Live-lane read-only publication and authenticated page reopening.
registerLiveServingRoutes(app, who);

// Version 2: the scientists' tool server, only where GBX_TOOL_SERVER=on (v2/tool-server.ts).
if (cfg.v2.toolServer) {
  const store = cfg.v2.runStore === "memory" ? new MemoryRunStore() : new TableRunStore(table(scopedTable(cfg.dataScope, "toolruns")));
  const f = cfg.v2.fabric;
  // A local run reads the graph as the signed-in operator; the cloud reads it with the site's Fabric identity.
  const knowledge = f.workspaceId && f.graphModelId && (f.clientId || !process.env.IDENTITY_ENDPOINT)
    ? fabricGraph({ workspaceId: f.workspaceId, graphModelId: f.graphModelId, token: getBearerTokenProvider(process.env.IDENTITY_ENDPOINT
      ? new ManagedIdentityCredential({ clientId: f.clientId }) : new AzureCliCredential(), "https://api.fabric.microsoft.com/.default") }) : null;
  let key: Buffer | null = null;
  registerToolServer(app, {
    reader: evidenceSearch, store, version: VERSION, knowledge,
    manifest: async (signal) => (await liveManifest.read({ signal })).manifest,
    ticketKey: () => key ??= ticketKey(cfg.v2.ticketKey()),
    allowedCallers: () => cfg.v2.toolCallers,
    caller: (req) => { try { return who(req); } catch { return null; } },
  });
  // "Run the agents" in the Co-Scientist workspace, on the hosted gbx-coscientist (v2/cosci.ts).
  if (cfg.v2.scientists && cfg.v2.projectEndpoint) {
    const credential = process.env.IDENTITY_ENDPOINT ? new ManagedIdentityCredential({ clientId: cfg.v2.agentsClientId }) : new AzureCliCredential();
    const endpointLog = { log: (message: string, detail: Record<string, unknown>) => app.log.info(detail, message) };
    registerCoScientist(app, {
      endpoint: foundryAgentEndpoint(cfg.v2.projectEndpoint, cfg.v2.coscientistAgent, getBearerTokenProvider(credential, "https://ai.azure.com/.default"), endpointLog),
      store, ticketKey: () => key ??= ticketKey(cfg.v2.ticketKey()), who, fail,
      aiEnabled: () => cfg.aiEnabled,
      // A run counts as one question for the person and across all users, and books a squad's tokens against the token
      // caps, which the scientists' reported usage then replaces.
      book: async (u) => {
        await take(keys.userQuestions(u.id), 1, cfg.caps.questionsPerUserPerDay, "questions per person");
        await takeBoth(keys.questions, 1, cfg.caps.questionsPerDay, cfg.caps.questionsPerMonth, "questions across all users");
        return reserve(keys.tokens, cfg.v2.reserveTokens, cfg.caps.tokensPerDay, cfg.caps.tokensPerMonth, "AI tokens");
      },
      settle,
      log: (message, detail) => app.log.warn(detail, message),
      person,
    });
    // The copilot's questions for the live agent go to the hosted gbx-copilot instead (v2/copilot.ts, answer.ts squad).
    if (cfg.v2.copilot) {
      configureCopilot({ endpoint: foundryAgentEndpoint(cfg.v2.projectEndpoint, cfg.v2.copilotAgent, getBearerTokenProvider(credential, "https://ai.azure.com/.default"), endpointLog),
        store, ticketKey: () => key ??= ticketKey(cfg.v2.ticketKey()), log: (message, detail) => app.log.warn(detail, message), person });
      app.post<{ Body: { handle?: unknown } }>(COPILOT_STATUS_PATH, async (req, reply) => {
        try { return await copilotStatus(req.body?.handle, who(req)); }
        catch (e) { if (e instanceof HandleError) return reply.code(e.status).send({ error: e.message }); return fail(reply, e); }
      });
    }
  }
}
const scientistsOn = cfg.v2.toolServer && cfg.v2.scientists && !!cfg.v2.projectEndpoint;

// Revision metadata enables the read-only paired revision/publication rollback acceptance check.
// https://learn.microsoft.com/azure/container-apps/environment-variables#built-in-environment-variables
app.get("/api/health", async () => ({ ok: true, version: VERSION, revision: process.env.CONTAINER_APP_REVISION ?? null, ai: cfg.aiEnabled, signIn: cfg.requireAuth ? signInLayerState().ok : "off" }));
// Also tells the copilot how answers are made right now (kill switch, model names), behind sign-in.
app.get("/api/me", async (req, reply) => { try { const u = who(req); return { name: u.name, id: u.id, owner: u.owner, liveSources: cfg.live.sources, ai: cfg.aiEnabled, uploads: cfg.aiEnabled && cfg.malwareScan, models: { writer: scientistsOn && cfg.v2.copilot ? "the Foundry scientists on the model router" : cfg.models.answer, checker: cfg.models.validator }, scientists: scientistsOn && cfg.aiEnabled }; } catch (e) { return fail(reply, e); } });

app.post<{ Body: { q?: string; basin?: string | null; near?: unknown } }>("/api/ask", async (req, reply) => {
  const q = String(req.body?.q ?? "").trim();
  if (!q) return reply.code(400).send({ error: "Ask a question." });
  try {
    // Optional: limit the answer to sources near a place on the map (geo.ts).
    const near = req.body?.near == null ? null : parseNear(req.body.near);
    const disconnected = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) disconnected.abort(); };
    req.raw.once("aborted", abort); reply.raw.once("close", abort);
    // The basin in the request body, if an older client still sends the map's selection, is ignored (answer.ts askCloud).
    try { return await askCloud(q, who(req), { near, signal: disconnected.signal }); }
    finally { req.raw.off("aborted", abort); reply.raw.off("close", abort); }
  } catch (e) { return fail(reply, e); }
});

app.get<{ Params: { id: string } }>("/api/source/:id", async (req, reply) => {
  try { const p = await sourcePassage(req.params.id, who(req)); return p ?? reply.code(404).send({ error: "Source not found." }); } catch (e) { return fail(reply, e); }
});

app.post("/api/ingest", async (req, reply) => {
  try {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Attach one file." });
    const r = await startIngest(file, who(req));
    return reply.code(r.status).send(r.body);
  } catch (e) { return fail(reply, e); }
});
app.get<{ Params: { id: string } }>("/api/ingest/:id", async (req, reply) => {
  try { const j = await jobStatus(req.params.id, who(req)); return j ?? reply.code(404).send({ error: "No such job." }); } catch (e) { return fail(reply, e); }
});

app.get("/api/reviews", async (_req, reply) => { try { return await listReviews(); } catch (e) { return fail(reply, e); } });
app.post<{ Body: { entityId?: string; status?: string; label?: string; note?: string } }>("/api/reviews", async (req, reply) => {
  try { const r = await decideReview(req.body ?? {}, who(req)); return reply.code(r.status).send(r.body); } catch (e) { return fail(reply, e); }
});
app.post<{ Params: { id: string }; Body: { version?: number } }>("/api/reviews/:id/rollback", async (req, reply) => {
  try { const r = await rollbackReview(req.params.id, Number(req.body?.version), who(req)); return reply.code(r.status).send(r.body); } catch (e) { return fail(reply, e); }
});

app.post<{ Body: Record<string, unknown> }>("/api/feedback", async (req, reply) => {
  try { await recordFeedback(req.body ?? {}, who(req)); return reply.code(202).send({ ok: true, note: "Thanks. Feedback is reviewed before it changes how sources rank for anyone." }); } catch (e) { return fail(reply, e); }
});

app.get("/api/maps/token", async (req, reply) => {
  try { who(req); reply.header("Cache-Control", "no-store"); return await mapsToken(); } catch (e) { return fail(reply, e); }
});
// Esri base maps (esri.ts): which styles are available with their credits, and the tile relay. Tiles log only warnings,
// since a screen of map is dozens of requests.
const esri = esriRelay({
  key: () => cfg.esri.apiKey, fetch, timeoutMs: cfg.timeoutsMs.esri, now: Date.now, warn: (m) => app.log.warn(m),
  book: blockBooker({
    block: 100, now: Date.now,
    takeUser: (user, n) => take(keys.userEsriTiles(user), n, cfg.caps.esriTilesPerUserPerDay, "Esri map tiles for one person"),
    takeShared: (n) => takeBoth(keys.esriTiles, n, cfg.caps.esriTilesPerDay, cfg.caps.esriTilesPerMonth, "Esri map tiles"),
  }),
});
app.get("/api/basemap/esri", async (req, reply) => {
  try { who(req); reply.header("Cache-Control", "no-store"); return await esri.status(); } catch (e) { return fail(reply, e); }
});
app.get<{ Params: { layer: string; z: string; y: string; x: string } }>("/api/basemap/esri/:layer/:z/:y/:x", { logLevel: "warn" }, async (req, reply) => {
  try {
    const t = await esri.tile(req.params, who(req).id);
    return reply.header("Cache-Control", t.cacheControl).type(t.type).send(t.body);
  } catch (e) { return fail(reply, e); }
});
// Planetary Computer Pro overlays for the Esri option (planetary.ts): which overlays are loaded, with their credits, and
// the tile relay. A malformed mosaic setting leaves them off rather than stopping the app.
let pcSearches: Record<string, string> = {};
try { pcSearches = parseSearches(cfg.planetary.searches); } catch (e) { app.log.warn((e as Error).message); }
const planetary = planetaryRelay({
  catalog: () => cfg.planetary.catalogUri, searches: () => pcSearches, token: catalogToken(cfg.planetary.identityClientId),
  fetch, timeoutMs: cfg.timeoutsMs.planetary, warn: (m) => app.log.warn(m),
  book: blockBooker({
    block: 100, now: Date.now,
    takeUser: (user, n) => take(keys.userPcTiles(user), n, cfg.caps.pcTilesPerUserPerDay, "Planetary Computer overlay tiles for one person"),
    takeShared: (n) => takeBoth(keys.pcTiles, n, cfg.caps.pcTilesPerDay, cfg.caps.pcTilesPerMonth, "Planetary Computer overlay tiles"),
  }),
  bookArea: async (user) => {
    await take(keys.userPcAreas(user), 1, cfg.caps.pcAreasPerUserPerDay, "Planetary Computer area summaries for one person");
    await takeBoth(keys.pcAreas, 1, cfg.caps.pcAreasPerDay, cfg.caps.pcAreasPerMonth, "Planetary Computer area summaries");
  },
});
app.get("/api/overlay/planetary", async (req, reply) => {
  try { who(req); reply.header("Cache-Control", "no-store"); return planetary.status(); } catch (e) { return fail(reply, e); }
});
app.get<{ Params: { layer: string; z: string; x: string; y: string } }>("/api/overlay/planetary/:layer/:z/:x/:y", { logLevel: "warn" }, async (req, reply) => {
  try {
    const t = await planetary.tile(req.params, who(req).id);
    return reply.header("Cache-Control", t.cacheControl).type(t.type).send(t.body);
  } catch (e) { return fail(reply, e); }
});
const spatialRoutes = { section: spatialSection, here: spatialHere, transform: spatialTransform };
for (const [name, run] of Object.entries(spatialRoutes)) {
  app.post<{ Body: Record<string, unknown> }>(`/api/spatial/${name}`, async (req, reply) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      return await run(body, who(req).id);
    } catch (e) { return fail(reply, e); }
  });
}
app.post("/api/search/near", async (req, reply) => {
  try { return await sourcesNear(req.body, who(req)); } catch (e) { return fail(reply, e); }
});
// "What we know in this area": an outline drawn on the map (lib/area.ts). The library's sources geotagged inside it, and
// what Planetary Computer Pro holds there, each checked against the same outline rules.
app.post("/api/search/area", async (req, reply) => {
  try { return await sourcesInArea(req.body, who(req)); } catch (e) { return fail(reply, e); }
});
app.post("/api/overlay/planetary/area", async (req, reply) => {
  try { const u = who(req); return await planetary.area(counterClockwise(parseArea(req.body)), u.id); } catch (e) { return fail(reply, e); }
});

// Live-lane admin routes are encapsulated; binary parsing is never enabled on other APIs.
await registerLiveAdminRoutes(app, who);

// A release reaches open browsers on their next load (static-cache.ts).
await app.register(fstatic, { root: PUBLIC, wildcard: false, index: ["index.html"], maxAge: "1h", setHeaders: cacheHeaders });
app.setNotFoundHandler((req, reply) => {
  if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.header("Cache-Control", "no-store").sendFile("index.html");
  return reply.code(404).send({ error: "Not found." });
});

await app.listen({ host: "0.0.0.0", port: cfg.port });
if (cfg.requireAuth) {
  // Confirm the sign-in layer quickly at start, then keep re-confirming it.
  const check = async () => { const before = signInLayerState().ok; await verifySignInLayer(); const now = signInLayerState(); if (now.ok !== before) app.log.warn({ signIn: now }, "sign-in layer state changed"); return now.ok; };
  void (async () => { for (let i = 0; i < 40 && !(await check()); i++) await new Promise((r) => setTimeout(r, 15_000)); })();
  setInterval(() => void check(), 5 * 60_000).unref();
}
