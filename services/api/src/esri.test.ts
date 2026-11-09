// Esri base-map relay (esri.ts): credits gate every layer, the key goes to Esri the way each service accepts it and
// nowhere else, tiles are validated and booked before Esri is asked, and blocks keep the usage table to one write per
// hundred tiles. The fake Esri below behaves like the real one did on 3 Nov 2026: the ibasemaps-api map tile services
// answer 499 "Token Required" unless the key is the token parameter, and the static tiles service needs the header.
//   node build.mjs --script src/esri.test.ts && node --test dist/scripts/esri.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { ESRI_LAYERS, EsriError, blockBooker, esriRelay, findCredit, tileCacheControl, type EsriDeps } from "./esri";

const KEY = "test-key-not-real";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CREDIT = { imagery: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community", hillshade: "Sources: Esri, USGS, NASA", labels: "Esri, TomTom, Garmin" };
class Capped extends Error {}

interface Call { url: string; host: string; auth: string | null; token: string | null }
const TOKEN_REQUIRED = () => new Response(JSON.stringify({ error: { code: 499, message: "Token Required.", details: [] } }), { headers: { "content-type": "text/plain" } });
function fixture(o: { key?: string; credits?: Partial<Record<keyof typeof CREDIT, unknown>>; tile?: () => Response | Promise<Response>; book?: EsriDeps["book"] } = {}) {
  const calls: Call[] = [], booked: string[] = [], warnings: string[] = [];
  let clock = Date.UTC(2026, 10, 3, 12);
  const credits = o.credits ?? { imagery: { copyrightText: CREDIT.imagery }, hillshade: { copyrightText: CREDIT.hillshade }, labels: { styleInfo: { attribution: CREDIT.labels } } };
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), u = new URL(url), auth = new Headers(init?.headers).get("authorization"), token = u.searchParams.get("token");
    calls.push({ url, host: u.host, auth, token });
    if (u.host.startsWith("ibasemaps-api.") ? token !== KEY : auth !== `Bearer ${KEY}`) return TOKEN_REQUIRED();
    u.searchParams.delete("token");
    const bare = u.toString();
    for (const id of Object.keys(ESRI_LAYERS) as (keyof typeof CREDIT)[]) {
      if (bare === ESRI_LAYERS[id].info) {
        const body = credits[id];
        return body === undefined ? new Response("{}", { status: 500 }) : Response.json(body);
      }
    }
    return o.tile ? o.tile() : new Response(PNG, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const relay = esriRelay({
    key: () => o.key ?? KEY, fetch: fetchFake, timeoutMs: 1000, now: () => clock, warn: (m) => warnings.push(m),
    book: o.book ?? (async (user, n) => { booked.push(`${user}:${n}`); }),
  });
  return { relay, calls, booked, warnings, tick: (ms: number) => { clock += ms; } };
}
const tileCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("/tile/"));

test("without a key Esri is reported off and no tile is relayed or booked", async () => {
  const f = fixture({ key: "" });
  assert.deepEqual(await f.relay.status(), { enabled: false, reason: "Esri isn't connected to this deployment yet.", styles: [] });
  await assert.rejects(f.relay.tile({ layer: "imagery", z: "3", y: "4", x: "7" }, "u1"), (e: unknown) => e instanceof EsriError && e.status === 404);
  assert.equal(f.calls.length, 0); assert.equal(f.booked.length, 0);
});

test("both styles are offered with labels on top and every credit, and the key goes only to Esri, the way each service accepts it", async () => {
  const f = fixture();
  const s = await f.relay.status();
  assert.equal(s.enabled, true);
  assert.deepEqual(s.styles.map((x) => [x.id, x.tiles.map((t) => `${t.id}:${t.size}:${t.overlay}`)]), [
    ["esri-imagery", ["imagery:256:false", "labels:512:true"]],
    ["esri-relief", ["hillshade:256:false", "labels:512:true"]],
  ]);
  assert.equal(s.styles[0].credits, `${CREDIT.imagery}; ${CREDIT.labels}`);
  assert.equal(s.styles[1].credits, `${CREDIT.hillshade}; ${CREDIT.labels}`);
  const labels = await f.relay.tile({ layer: "labels", z: "5", y: "18", x: "28" }, "u1");
  const imagery = await f.relay.tile({ layer: "imagery", z: "5", y: "18", x: "28" }, "u1");
  for (const c of f.calls) {
    if (c.host.startsWith("ibasemaps-api.")) { assert.equal(c.token, KEY); assert.equal(c.auth, null); }
    else { assert.equal(c.auth, `Bearer ${KEY}`); assert.equal(c.token, null); assert.ok(!c.url.includes(KEY)); }
  }
  assert.deepEqual(tileCalls(f.calls).map((c) => c.url.replace(KEY, "<key>")), [`${ESRI_LAYERS.labels.tiles}/5/18/28`, `${ESRI_LAYERS.imagery.tiles}/5/18/28?token=<key>`]);
  for (const out of [JSON.stringify(s), JSON.stringify(labels), JSON.stringify(imagery), ...f.warnings]) assert.ok(!out.includes(KEY));
});

test("Esri's own error is logged when it refuses the key, and the key is scrubbed from what it says", async () => {
  const f = fixture({ credits: { imagery: { error: { code: 498, message: `Invalid token: ${KEY}` } }, hillshade: { copyrightText: CREDIT.hillshade }, labels: { copyrightText: CREDIT.labels } } });
  const s = await f.relay.status();
  assert.deepEqual(s.styles.map((x) => x.id), ["esri-relief"]);
  assert.deepEqual(f.warnings, ["Esri credits unavailable for imagery: HTTP 200, Esri error 498: Invalid token: <key>"]);
  const g = fixture({ tile: TOKEN_REQUIRED });
  await g.relay.status();
  await assert.rejects(g.relay.tile({ layer: "imagery", z: "3", y: "4", x: "7" }, "u1"), (e: unknown) => e instanceof EsriError && e.status === 502);
  assert.deepEqual(g.warnings, ["Esri tile refused for imagery: HTTP 200, Esri error 499: Token Required."]);
});

test("a layer without confirmed credits is never offered or relayed", async () => {
  const f = fixture({ credits: { imagery: { copyrightText: CREDIT.imagery }, hillshade: { error: { code: 498, message: "Invalid token." } } } });
  const s = await f.relay.status();
  assert.deepEqual(s.styles.map((x) => [x.id, x.tiles.map((t) => t.id), x.credits]), [["esri-imagery", ["imagery"], CREDIT.imagery]]);
  for (const layer of ["hillshade", "labels"]) {
    await assert.rejects(f.relay.tile({ layer, z: "3", y: "4", x: "7" }, "u1"), (e: unknown) => e instanceof EsriError && e.status === 503);
  }
  assert.equal(f.booked.length, 0);
  assert.ok(f.warnings.some((w) => w.startsWith("Esri credits unavailable for hillshade: HTTP 200, Esri error 498")));
});

test("a rejected key turns Esri off, and the credits are asked for again after five minutes, not on every request", async () => {
  const f = fixture({ credits: {} });
  assert.equal((await f.relay.status()).enabled, false);
  const asked = f.calls.length;
  await f.relay.status(); assert.equal(f.calls.length, asked);
  f.tick(5 * 60_000 + 1); await f.relay.status(); assert.equal(f.calls.length, asked * 2);
});

test("credits are read from copyrightText or an attribution field, never from links or error replies", () => {
  assert.equal(findCredit({ currentVersion: 10.9, copyrightText: "  Source: Esri,\n Vantor " }), "Source: Esri, Vantor");
  assert.equal(findCredit({ styleInfo: { attribution: { text: "Esri, TomTom", url: "https://www.esri.com" } } }), "Esri, TomTom");
  assert.equal(findCredit({ attribution: ["Esri", "Garmin", "Esri"] }), "Esri, Garmin");
  assert.equal(findCredit({ error: { code: 498, message: "Invalid token.", copyrightText: "x" } }), null);
  assert.equal(findCredit({ description: "World imagery", name: "World_Imagery" }), null);
});

test("tile coordinates are checked before anything is booked or fetched", async () => {
  const f = fixture();
  await f.relay.status();
  const bad: [Record<string, string>, number][] = [
    [{ layer: "streets", z: "3", y: "4", x: "7" }, 404],
    [{ layer: "imagery", z: "3", y: "-1", x: "7" }, 400],
    [{ layer: "imagery", z: "3.5", y: "4", x: "7" }, 400],
    [{ layer: "imagery", z: "3", y: "8", x: "7" }, 400],
    [{ layer: "imagery", z: "3", y: "4", x: "8" }, 400],
    [{ layer: "labels", z: "23", y: "0", x: "0" }, 400],
    [{ layer: "imagery", z: "3", y: "4", x: "7/../../x" }, 400],
  ];
  for (const [p, status] of bad) {
    await assert.rejects(f.relay.tile(p as { layer: string; z: string; y: string; x: string }, "u1"), (e: unknown) => e instanceof EsriError && e.status === status, JSON.stringify(p));
  }
  assert.equal(f.booked.length, 0); assert.equal(tileCalls(f.calls).length, 0);
  const t = await f.relay.tile({ layer: "imagery", z: "3", y: "4", x: "7" }, "u1");
  assert.equal(t.type, "image/png"); assert.deepEqual(t.body, PNG); assert.deepEqual(f.booked, ["u1:1"]);
  assert.equal(t.cacheControl, "no-store", "a tile Esri gives no lifetime is not kept");
});

test("browsers keep a tile only as long as Esri's own caching headers allow, and never in a shared cache", async () => {
  const f = fixture({ tile: () => new Response(PNG, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400, s-maxage=604800" } }) });
  await f.relay.status();
  assert.equal((await f.relay.tile({ layer: "imagery", z: "3", y: "4", x: "7" }, "u1")).cacheControl, "private, max-age=86400");
  const cases: [string | null, string][] = [
    ["max-age=600, must-revalidate, stale-while-revalidate=60", "private, max-age=600, must-revalidate, stale-while-revalidate=60"],
    ["Max-Age = 3600, Public, Immutable", "private, max-age=3600, immutable"],
    ["private, max-age=0", "private, max-age=0"],
    ["no-cache", "no-store"],
    ["no-store, max-age=86400", "no-store"],
    ["public", "no-store"],
    ["max-age=abc", "no-store"],
    [null, "no-store"],
  ];
  for (const [upstream, want] of cases) assert.equal(tileCacheControl(upstream), want, String(upstream));
});

test("a cap refusal stops the request before Esri is asked", async () => {
  const f = fixture({ book: async () => { throw new Capped("Daily limit reached"); } });
  await f.relay.status();
  await assert.rejects(f.relay.tile({ layer: "imagery", z: "3", y: "4", x: "7" }, "u1"), Capped);
  assert.equal(tileCalls(f.calls).length, 0);
});

test("only an image counts as a tile: JSON errors, missing tiles, timeouts and oversized replies are refused", async () => {
  const cases: [() => Response | Promise<Response>, number][] = [
    [() => Response.json({ error: { code: 498, message: "Invalid token." } }), 502],
    [() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }), 502],
    [() => new Response(PNG, { status: 403, headers: { "content-type": "image/png" } }), 502],
    [() => new Response("", { status: 404 }), 404],
    [() => { throw new TypeError("fetch failed"); }, 504],
    [() => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { headers: { "content-type": "image/jpeg" } }), 502],
  ];
  for (const [tile, status] of cases) {
    const f = fixture({ tile });
    await f.relay.status();
    await assert.rejects(f.relay.tile({ layer: "imagery", z: "3", y: "4", x: "7" }, "u1"), (e: unknown) => e instanceof EsriError && e.status === status, String(status));
  }
});

test("tiles are booked in blocks: one booking serves a hundred tiles, and concurrent tiles share one booking", async () => {
  const charged: string[] = [];
  let clock = Date.UTC(2026, 10, 3, 23, 59);
  const book = blockBooker({ block: 100, now: () => clock, takeUser: async (u, n) => { charged.push(`user:${u}:${n}`); }, takeShared: async (n) => { charged.push(`shared:${n}`); } });
  await Promise.all(Array.from({ length: 60 }, () => book("u1", 1)));
  assert.deepEqual(charged, ["user:u1:100", "shared:100"]);
  for (let i = 0; i < 40; i++) await book("u1", 1);
  assert.equal(charged.length, 2);
  await book("u1", 1);
  assert.deepEqual(charged.slice(2), ["user:u1:100", "shared:100"]);
  clock += 2 * 60_000; // past midnight UTC: what is left of yesterday's block is dropped
  await book("u1", 1);
  assert.equal(charged.length, 6);
});

test("a person over their allowance is refused without charging the shared allowance", async () => {
  const charged: string[] = [];
  const book = blockBooker({ block: 100, now: Date.now, takeUser: async () => { throw new Capped("Daily limit reached"); }, takeShared: async (n) => { charged.push(`shared:${n}`); } });
  await assert.rejects(Promise.all(Array.from({ length: 5 }, () => book("u2", 1))), Capped);
  await assert.rejects(book("u2", 1), Capped);
  assert.deepEqual(charged, []);
});
