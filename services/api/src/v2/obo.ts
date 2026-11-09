// The scientists ask GeoBasin's knowledge ontology through Fabric IQ as the signed-in person, so Fabric applies
// that person's own permissions. Foundry's toolbox passes a person to Fabric only when the agent itself is called with
// that person's Entra token for https://ai.azure.com (Microsoft Learn, How toolbox authentication works; Configure user
// delegation for tools), so the API exchanges the person's own token for this API for one on their behalf (OAuth 2.0
// on-behalf-of). The site's agents identity stands in for a client secret through a federated credential on the
// sign-in registration (Microsoft Learn, Configure an application to trust a managed identity; v2/grant-fabric-iq.sh).
// The person's token never leaves this module: it is kept against the request's own User object in a WeakMap, so it is
// never serialized, logged or put in a ticket, and the token made on their behalf is cached per person until five
// minutes before it expires. Without a token, or if the exchange fails, the caller starts the run as the app instead and
// the scientists use the typed knowledge tools (cosci.ts foundryAgentEndpoint).
import { ManagedIdentityCredential, OnBehalfOfCredential } from "@azure/identity";
import type { FastifyRequest } from "fastify";
import type { User } from "../auth";

export const FOUNDRY_SCOPE = "https://ai.azure.com/.default";
const EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";
const MARGIN_MS = 2 * 60_000;
const REFRESH_MS = 5 * 60_000;

export interface OboConfig {
  /** The sign-in registration's tenant and client ID, and the audiences its tokens for this API carry. */
  tenantId: string; clientId: string; audiences: readonly string[];
  /** The managed identity the registration's federated credential trusts. */
  identityClientId: string;
}
/** A token for https://ai.azure.com on the person's behalf. */
export type PersonAuth = () => Promise<string>;

function claimsOf(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return null; }
}

/* A token qualifies only if this tenant issued it for this API to the very person the sign-in layer named, and it has two
   more minutes to run. Its signature isn't checked here: the sign-in layer validated a bearer token, the token store
   holds what it obtained itself, and Microsoft Entra ID validates the token again before it exchanges it. */
export function fitsPerson(token: string, user: User, o: Pick<OboConfig, "tenantId" | "audiences">, now = Date.now()): boolean {
  const c = claimsOf(token);
  return !!c && typeof c.aud === "string" && o.audiences.includes(c.aud) && c.tid === o.tenantId && c.oid === user.id
    && typeof c.exp === "number" && c.exp * 1000 > now + MARGIN_MS;
}

/* The person's own token for this API: the one the sign-in layer's token store holds for a browser session
   (X-MS-TOKEN-AAD-ACCESS-TOKEN, Microsoft Learn, Enable an authentication token store), or the bearer token a client
   sent. Front Door deletes x-ms-token-* headers that clients send (infra/bicep/edge.bicep). */
export function personAssertion(req: FastifyRequest, user: User, o: Pick<OboConfig, "tenantId" | "audiences">, now = Date.now()): string | null {
  const stored = req.headers["x-ms-token-aad-access-token"], auth = req.headers.authorization;
  const candidates = [typeof stored === "string" ? stored : "", typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : ""];
  return candidates.find((t) => t && fitsPerson(t, user, o, now)) ?? null;
}

const assertions = new WeakMap<User, string>();
export function rememberAssertion(user: User, token: string | null): void { if (token) assertions.set(user, token); }

export interface PersonTokenOptions {
  now?: () => number; max?: number;
  /* Replaced in tests; the default exchanges the token through Microsoft Entra ID. */
  exchange?(assertion: string): Promise<{ token: string; expiresOnTimestamp: number }>;
}

/* Returns, for a request's User, a provider of tokens on their behalf, or null when the request carried no qualifying
   token of theirs. */
export function personTokens(o: OboConfig, opts: PersonTokenOptions = {}): (user: User) => PersonAuth | null {
  const now = opts.now ?? Date.now, max = opts.max ?? 500;
  const mi = new ManagedIdentityCredential({ clientId: o.identityClientId });
  const getAssertion = async () => {
    const t = await mi.getToken(EXCHANGE_SCOPE);
    if (!t) throw new Error("The managed identity returned no token for the exchange");
    return t.token;
  };
  const exchange = opts.exchange ?? (async (assertion: string) => {
    const t = await new OnBehalfOfCredential({ tenantId: o.tenantId, clientId: o.clientId, getAssertion, userAssertionToken: assertion }).getToken(FOUNDRY_SCOPE);
    if (!t) throw new Error("Microsoft Entra ID returned no token on the person's behalf");
    return t;
  });
  const cache = new Map<string, { token: string; exp: number }>();
  return (user) => {
    const assertion = assertions.get(user);
    if (!assertion) return null;
    return async () => {
      const hit = cache.get(user.id);
      if (hit && hit.exp - now() > REFRESH_MS) return hit.token;
      const t = await exchange(assertion);
      cache.delete(user.id);
      cache.set(user.id, { token: t.token, exp: t.expiresOnTimestamp });
      if (cache.size > max) cache.delete(cache.keys().next().value!);
      return t.token;
    };
  };
}
