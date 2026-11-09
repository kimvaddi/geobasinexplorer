// Who is calling. Container Apps authentication signs users in with Microsoft Entra ID and injects these headers;
// external requests can't set them while that sign-in layer is running (Microsoft Learn, container-apps/authentication).
// Two further guards make sure forged headers are never trusted:
//  1. Front Door deletes every x-ms-client-principal* and x-ms-token-* header a client sends (infra/bicep/edge.bicep), and
//     the environment takes no traffic except from Front Door, so these headers can only come from the sign-in layer.
//  2. The service trusts them only while it can confirm the sign-in layer is in front of it (verifySignInLayer),
//     re-checked every five minutes. A failed check is tolerated once; after that, or if the last confirmation is
//     older than eleven minutes, every request is refused until the layer is confirmed again.
import type { FastifyRequest } from "fastify";
import { cfg } from "./config";

export interface User { id: string; name: string; roles: string[]; owner: boolean }

const STALE_MS = 11 * 60_000;
let signInLayer: { ok: boolean; checkedAt: string; detail: string } = { ok: false, checkedAt: "", detail: "not checked yet" };
let lastConfirmed = 0;
let failedChecks = 0;
export const signInLayerState = () => {
  if (signInLayer.ok && Date.now() - lastConfirmed > STALE_MS) signInLayer = { ...signInLayer, ok: false, detail: "last confirmation is too old" };
  return signInLayer;
};

/* The sign-in layer answers /.auth/login/aad itself with a redirect to Microsoft Entra ID; this app never does. */
export async function verifySignInLayer(): Promise<void> {
  const at = new Date().toISOString();
  if (!cfg.selfUrl) { signInLayer = { ok: false, checkedAt: at, detail: "GBX_SELF_URL is not set" }; return; }
  try {
    const r = await fetch(`${cfg.selfUrl}/.auth/login/aad`, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    const loc = r.headers.get("location") ?? "";
    const ok = r.status >= 300 && r.status < 400 && loc.startsWith("https://login.microsoftonline.com/") && r.headers.get("x-gbx-origin") !== "app";
    signInLayer = { ok, checkedAt: at, detail: ok ? "Container Apps sign-in confirmed" : `unexpected answer ${r.status}` };
    if (ok) { lastConfirmed = Date.now(); failedChecks = 0; }
  } catch (e) {
    // One failed round (a network blip) keeps the last confirmation; a second one in a row refuses everything.
    failedChecks += 1;
    const keep = signInLayer.ok && failedChecks < 2;
    signInLayer = { ok: keep, checkedAt: at, detail: `check failed (${failedChecks} in a row): ${(e as Error).message}` };
  }
}

export function userOf(req: FastifyRequest): User | null {
  if (cfg.requireAuth && !signInLayerState().ok) return null;
  const id = String(req.headers["x-ms-client-principal-id"] ?? "");
  const name = String(req.headers["x-ms-client-principal-name"] ?? "");
  if (!id) return null;
  let roles: string[] = [];
  let upn = "";
  const raw = req.headers["x-ms-client-principal"];
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { claims?: { typ: string; val: string }[]; role_typ?: string };
      const roleTyp = p.role_typ ?? "roles";
      roles = (p.claims ?? []).filter((c) => c.typ === roleTyp || c.typ === "roles").map((c) => c.val);
      upn = (p.claims ?? []).find((c) => c.typ === "preferred_username" || c.typ === "upn" || c.typ.endsWith("/claims/upn"))?.val ?? "";
    } catch { /* malformed principal: no roles */ }
  }
  // Owners hold the GeoBasin.Owner app role; GBX_OWNERS may also list object IDs or sign-in names (never display names).
  const owner = roles.includes("GeoBasin.Owner") || cfg.owners.includes(id.toLowerCase()) || (!!upn && cfg.owners.includes(upn.toLowerCase()));
  return { id, name: upn || name, roles, owner };
}
