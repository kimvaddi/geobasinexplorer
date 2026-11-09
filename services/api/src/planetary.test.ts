// Planetary Computer Pro overlay relay (planetary.ts): only listed layers with a registered mosaic are offered, each tile
// request is checked before it is booked or sent, the token goes only to the catalog, tiles outside the data come back
// transparent, and the catalog's failures turn into answers the map can act on.
//   node build.mjs --script src/planetary.test.ts && node --test dist/scripts/planetary.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { API_VERSION, COLLECTIONS, COOPER_BOUNDS, EMPTY_TILE, PC_LAYERS, PlanetaryError, parseSearches, planetaryRelay, tileTouches, type PlanetaryDeps } from "./planetary";

const CATALOG = "https://geo-test.abc123.northcentralus.geocatalog.spatio.azure.com";
const TOKEN = "test-token-not-real";
const SEARCHES = { [COLLECTIONS.dem]: "aaaabbbbccccdddd0000111122223333", [COLLECTIONS.s2]: "ffffeeeeddddcccc9999888877776666" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
class Capped extends Error {}

/* Tile z/x/y holding a point, in the Web Mercator grid the relay uses. */
function tileOf(lon: number, lat: number, z: number) {
  const k = 2 ** z, r = (lat * Math.PI) / 180;
  return { z: String(z), x: String(Math.floor(((lon + 180) / 360) * k)), y: String(Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * k)) };
}
const INNAMINCKA = (z: number) => tileOf(140.75, -27.8, z);

function fixture(o: { catalog?: string; searches?: Record<string, string>; reply?: () => Response | Promise<Response>; book?: PlanetaryDeps["book"]; token?: PlanetaryDeps["token"] } = {}) {
  const calls: { url: string; auth: string | null }[] = [], booked: string[] = [], warnings: string[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return o.reply ? o.reply() : new Response(PNG, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const relay = planetaryRelay({
    catalog: () => o.catalog ?? CATALOG, searches: () => o.searches ?? SEARCHES, token: o.token ?? (async () => TOKEN),
    fetch: fetchFake, timeoutMs: 1000, warn: (m) => warnings.push(m),
    book: o.book ?? (async (user, n) => { booked.push(`${user}:${n}`); }),
  });
  return { relay, calls, booked, warnings };
}
const refused = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (e: unknown) => e instanceof PlanetaryError && e.status === status);
};

test("without a catalog the overlays are reported off and no tile is relayed or booked", async () => {
  const f = fixture({ catalog: "" });
  const s = f.relay.status();
  assert.equal(s.enabled, false);
  assert.match(s.reason ?? "", /isn't connected/);
  await refused(f.relay.tile({ layer: "imagery", ...INNAMINCKA(8) }, "u1"), 404);
  assert.equal(f.calls.length + f.booked.length, 0);
});

test("only layers whose collection has a registered mosaic are offered, each with the basin's bounds and its credits", () => {
  const dem = fixture({ searches: { [COLLECTIONS.dem]: SEARCHES[COLLECTIONS.dem] } }).relay.status();
  assert.deepEqual(dem.layers.map((l) => l.id), ["elevation", "hillshade"]);
  for (const l of dem.layers) {
    assert.deepEqual(l.bounds, COOPER_BOUNDS);
    assert.equal(l.size, 512);
    assert.match(l.credits, /^Produced using Copernicus WorldDEM-30 © DLR e\.V\. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved\./);
    assert.match(l.credits, /do not incur any liability for any use of the Copernicus WorldDEM-30\.$/);
  }
  const all = fixture().relay.status();
  assert.deepEqual(all.layers.map((l) => l.id), ["imagery", "elevation", "hillshade"]);
  assert.equal(all.layers[0].credits, "Contains modified Copernicus Sentinel data 2025");
  assert.equal(fixture({ searches: {} }).relay.status().enabled, false);
});

test("a tile is booked, then fetched from the layer's mosaic with the token, at twice the scale, with the layer's options", async () => {
  const f = fixture();
  const t = await f.relay.tile({ layer: "hillshade", ...INNAMINCKA(8) }, "u1");
  assert.deepEqual(t.body, PNG);
  assert.equal(t.type, "image/png");
  assert.equal(t.cacheControl, "private, max-age=21600");
  assert.deepEqual(f.booked, ["u1:1"]);
  assert.equal(f.calls.length, 1);
  const { x, y } = INNAMINCKA(8);
  const u = new URL(f.calls[0].url);
  assert.equal(`${u.origin}${u.pathname}`, `${CATALOG}/data/mosaic/searches/${SEARCHES[COLLECTIONS.dem]}/tiles/WebMercatorQuad/8/${x}/${y}@2x.jpeg`);
  assert.equal(u.searchParams.get("api-version"), API_VERSION);
  assert.equal(u.searchParams.get("algorithm"), "hillshade");
  assert.deepEqual(JSON.parse(u.searchParams.get("algorithm_params")!), { azimuth: 315, angle_altitude: 45 });
  assert.equal(u.searchParams.get("items_limit"), "100");
  assert.equal(f.calls[0].auth, `Bearer ${TOKEN}`);
  const img = fixture();
  await img.relay.tile({ layer: "imagery", ...INNAMINCKA(9) }, "u1");
  assert.match(img.calls[0].url, new RegExp(`/searches/${SEARCHES[COLLECTIONS.s2]}/tiles/WebMercatorQuad/9/\\d+/\\d+@2x\\.jpeg\\?`));
  assert.equal(new URL(img.calls[0].url).searchParams.get("assets"), "visual");
  assert.equal(new URL(img.calls[0].url).searchParams.get("pixel_selection"), "highest");
});

test("a tile wholly inside a layer's data comes as JPEG, and one at its edge as PNG so the map shows through", async () => {
  // 8/227/148 spans 139.2 to 140.6 E: past the basin's western edge (139.37 E), but inside the DEM's block (from 139 E).
  const edge = { z: "8", x: "227", y: "148" };
  const f = fixture();
  await f.relay.tile({ layer: "imagery", ...edge }, "u1");
  await f.relay.tile({ layer: "hillshade", ...edge }, "u1");
  assert.match(f.calls[0].url, /\/8\/227\/148@2x\.png\?/);
  assert.match(f.calls[1].url, /\/8\/227\/148@2x\.jpeg\?/);
});

test("layers, coordinates and zoom are checked, and tiles beyond the basin answered empty, before anything is booked or fetched", async () => {
  const f = fixture();
  const { minZoom, maxZoom } = PC_LAYERS.elevation;
  await refused(f.relay.tile({ layer: "satellite", ...INNAMINCKA(8) }, "u1"), 404);
  await refused(f.relay.tile({ layer: "__proto__", ...INNAMINCKA(8) }, "u1"), 404);
  await refused(f.relay.tile({ layer: "elevation", z: "8", x: "1e2", y: "148" }, "u1"), 400);
  await refused(f.relay.tile({ layer: "elevation", z: "8", x: "-1", y: "148" }, "u1"), 400);
  await refused(f.relay.tile({ layer: "elevation", ...INNAMINCKA(minZoom - 1) }, "u1"), 400);
  await refused(f.relay.tile({ layer: "elevation", ...INNAMINCKA(maxZoom + 1) }, "u1"), 400);
  await refused(f.relay.tile({ layer: "elevation", z: "8", x: "256", y: "148" }, "u1"), 400);
  assert.equal(await f.relay.tile({ layer: "elevation", ...tileOf(151.2, -33.87, 8) }, "u1"), EMPTY_TILE);
  await refused(fixture({ searches: { [COLLECTIONS.dem]: SEARCHES[COLLECTIONS.dem] } }).relay.tile({ layer: "imagery", ...INNAMINCKA(8) }, "u1"), 404);
  assert.equal(f.calls.length + f.booked.length, 0);
});

test("where the mosaic has no data the map gets a transparent tile, and neither that nor a fetched tile is asked for twice", async () => {
  const replies = [
    () => Response.json({ error: { code: "ResourceNotFound", message: "No assets found for tile 8-228-148" } }, { status: 404 }),
    () => Response.json({ error: { code: "TileOutsideBounds", message: "Tile outside data extent" } }, { status: 424 }),
  ];
  for (const reply of replies) {
    const f = fixture({ reply });
    assert.equal(await f.relay.tile({ layer: "elevation", ...INNAMINCKA(8) }, "u1"), EMPTY_TILE);
    assert.equal(await f.relay.tile({ layer: "elevation", ...INNAMINCKA(8) }, "u2"), EMPTY_TILE);
    assert.equal(f.calls.length, 1);
    assert.equal(f.warnings.length, 0);
  }
  const f = fixture();
  await f.relay.tile({ layer: "imagery", ...INNAMINCKA(10) }, "u1");
  await f.relay.tile({ layer: "imagery", ...INNAMINCKA(10) }, "u2");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.booked, ["u1:1"]);
  await f.relay.tile({ layer: "hillshade", ...INNAMINCKA(10) }, "u2");
  assert.equal(f.calls.length, 2);
});

test("a cap refusal stops the request before the catalog is asked", async () => {
  const f = fixture({ book: async () => { throw new Capped("over"); } });
  await assert.rejects(f.relay.tile({ layer: "elevation", ...INNAMINCKA(8) }, "u1"), Capped);
  assert.equal(f.calls.length, 0);
});

test("the catalog's refusals, errors in place of images, timeouts, oversized replies and sign-in failures are reported, never the token", async () => {
  const cases: [() => Response | Promise<Response>, number][] = [
    [() => Response.json({ detail: "Forbidden" }, { status: 403 }), 502],
    [() => Response.json({ detail: "Unauthorized" }, { status: 401 }), 502],
    [() => Response.json({ detail: "Too many requests" }, { status: 429 }), 503],
    [() => Response.json({ detail: "Internal error" }, { status: 500 }), 502],
    // The catalog's own rendering failure, seen when asked for WebP on 4 Nov 2026.
    [() => Response.json({ error: { code: "ServerError", message: "Could not encode array of shape (3,512,512) and of datatype `uint8` using WEBP driver" } }, { status: 424 }), 502],
    [() => Response.json({ ok: true }), 502],
    [() => { throw new Error("timeout"); }, 504],
    [() => new Response(Buffer.alloc(4 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }), 502],
  ];
  for (const [reply, status] of cases) {
    const f = fixture({ reply });
    await refused(f.relay.tile({ layer: "elevation", ...INNAMINCKA(8) }, "u1"), status);
    assert.ok(f.warnings.every((w) => !w.includes(TOKEN)));
  }
  const f = fixture({ reply: () => Response.json({ detail: "Forbidden" }, { status: 403 }) });
  await refused(f.relay.tile({ layer: "elevation", ...INNAMINCKA(8) }, "u1"), 502);
  assert.match(f.warnings[0], /HTTP 403/);
  const signin = fixture({ token: async () => { throw new Error("ManagedIdentityCredential: no identity"); } });
  await refused(signin.relay.tile({ layer: "elevation", ...INNAMINCKA(8) }, "u1"), 503);
  assert.equal(signin.calls.length, 0);
  assert.match(signin.warnings[0], /token unavailable/);
});

test("the mosaic setting accepts only known collections, once each, with plain search IDs", () => {
  assert.deepEqual(parseSearches(""), {});
  assert.deepEqual(parseSearches(` ${COLLECTIONS.dem}=${SEARCHES[COLLECTIONS.dem]} , ${COLLECTIONS.s2}=${SEARCHES[COLLECTIONS.s2]}`), SEARCHES);
  for (const bad of [`other=${SEARCHES[COLLECTIONS.dem]}`, `${COLLECTIONS.dem}=abc`, `${COLLECTIONS.dem}=../../x`, `${COLLECTIONS.dem}=${SEARCHES[COLLECTIONS.dem]},${COLLECTIONS.dem}=${SEARCHES[COLLECTIONS.s2]}`])
    assert.throws(() => parseSearches(bad), /PC_SEARCHES/);
});

test("tiles are matched to the basin's extent at every zoom", () => {
  assert.ok(tileTouches(0, 0, 0, COOPER_BOUNDS));
  for (const z of [6, 9, 12]) {
    const t = INNAMINCKA(z);
    assert.ok(tileTouches(z, Number(t.x), Number(t.y), COOPER_BOUNDS));
    const syd = tileOf(151.2, -33.87, z), perth = tileOf(115.86, -31.95, z);
    assert.ok(!tileTouches(z, Number(syd.x), Number(syd.y), COOPER_BOUNDS));
    assert.ok(!tileTouches(z, Number(perth.x), Number(perth.y), COOPER_BOUNDS));
  }
});

/* Drawn areas: the catalog is asked only about outlines that reach its data, each answer is booked once and remembered,
   the DEM statistics of each tile are combined by pixel count, and its failures become errors the card can show. */
const RING: [number, number][] = [[140.6, -27.9], [141.2, -27.9], [141.3, -27.5], [140.7, -27.4]];
function areaFixture(o: { dem?: string[]; stats?: Record<string, Response | (() => Response)>; search?: () => Response; bookArea?: PlanetaryDeps["bookArea"] } = {}) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [], booked: string[] = [];
  const dem = o.dem ?? ["Copernicus_DSM_COG_10_S28_00_E141_00_DEM", "Copernicus_DSM_COG_10_S28_00_E140_00_DEM"];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
    if (url.includes("/stac/search")) {
      if (o.search) return o.search();
      return (body.collections as string[])[0] === COLLECTIONS.dem
        ? json({ type: "FeatureCollection", features: dem.map((id) => ({ id })) })
        : json({ type: "FeatureCollection", features: [
          { id: "S2A_MSIL2A_20250914T003721_R059_T54JWQ_20250914T034314", properties: { datetime: "2025-09-14T00:37:21.024000Z", "eo:cloud_cover": 0.000368, "s2:mgrs_tile": "54JWQ" } },
          { id: "S2C_MSIL2A_20250813T003721_R059_T54JVQ_20250813T044212", properties: { datetime: "2025-08-13T00:37:21.025000Z", "eo:cloud_cover": 0.381407, "s2:mgrs_tile": "54JVQ" } },
        ] });
    }
    const id = decodeURIComponent(/\/items\/([^/]+)\/statistics/.exec(url)?.[1] ?? "");
    const s = o.stats?.[id];
    if (s) return typeof s === "function" ? s() : s;
    return json({ type: "Feature", properties: { statistics: { data_b1: id.includes("E141")
      ? { min: 47.5, max: 188.44, mean: 85.35, count: 57997, valid_pixels: 57997 }
      : { min: 38.03, max: 226.94, mean: 81.4, count: 90101, valid_pixels: 90101 } } } });
  }) as typeof fetch;
  const relay = planetaryRelay({
    catalog: () => CATALOG, searches: () => SEARCHES, token: async () => TOKEN, fetch: fetchFake, timeoutMs: 1000,
    book: async () => { throw new Error("tiles aren't booked for an area"); },
    bookArea: o.bookArea ?? (async (user) => { booked.push(user); }),
  });
  return { relay, calls, booked };
}

test("an outline clear of the catalog's data is answered without asking the catalog or booking", async () => {
  const f = areaFixture();
  const r = await f.relay.area([[150, -35], [151, -35], [151, -34]], "u1");
  assert.equal(r.covered, false);
  assert.equal(r.elevation, null);
  assert.equal(f.calls.length + f.booked.length, 0);
});

test("an outline over the basin books once, searches both collections, combines the DEM statistics and is remembered", async () => {
  const f = areaFixture();
  const r = await f.relay.area(RING, "u1");
  assert.deepEqual(f.booked, ["u1"]);
  const searches = f.calls.filter((c) => c.url.includes("/stac/search"));
  assert.equal(searches.length, 2);
  for (const s of searches) {
    assert.ok(s.url.startsWith(`${CATALOG}/stac/search?api-version=${API_VERSION}`));
    assert.equal(s.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(s.body.intersects, { type: "Polygon", coordinates: [[...RING, RING[0]]] });
  }
  const stats = f.calls.filter((c) => c.url.includes("/statistics"));
  assert.equal(stats.length, 2);
  assert.ok(stats.every((c) => c.url.startsWith(`${CATALOG}/data/mosaic/collections/${COLLECTIONS.dem}/items/`) && c.url.includes("assets=data") && c.url.includes("max_size=512")));
  assert.equal(r.covered, true);
  assert.equal(r.elevation?.min, 38.03);
  assert.equal(r.elevation?.max, 226.94);
  assert.equal(r.elevation?.samples, 148098);
  assert.equal(r.elevation?.tiles, 2);
  assert.ok(Math.abs((r.elevation?.mean ?? 0) - (85.35 * 57997 + 81.4 * 90101) / 148098) < 1e-9);
  assert.deepEqual(r.scenes.map((s) => [s.date, s.tile]), [["2025-08-13", "54JVQ"], ["2025-09-14", "54JWQ"]]);
  assert.equal(r.credits.imagery, "Contains modified Copernicus Sentinel data 2025");
  assert.match(r.credits.elevation, /^Produced using Copernicus WorldDEM-30/);
  const again = await f.relay.area(RING, "u2");
  assert.deepEqual(again, r);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.booked, ["u1"]);
});

test("a tile the outline only grazes is skipped and that answer isn't remembered, and an outline over too many DEM tiles gets no statistics", async () => {
  const graze = areaFixture({ stats: { Copernicus_DSM_COG_10_S28_00_E140_00_DEM: () => new Response("{}", { status: 404 }) } });
  const r = await graze.relay.area(RING, "u1");
  assert.equal(r.elevation?.tiles, 1);
  assert.equal(r.elevation?.samples, 57997);
  await graze.relay.area(RING, "u1");
  assert.equal(graze.calls.length, 8, "asked again, because a skipped tile might have been a passing refusal");
  const many = areaFixture({ dem: Array.from({ length: 13 }, (_, i) => `Copernicus_DSM_COG_10_S2${i % 10}_00_E14${i % 5}_00_DEM_${i}`) });
  const big = await many.relay.area(RING, "u1");
  assert.equal(big.elevation, null);
  assert.match(big.elevationNote ?? "", /touches 13 one-degree Copernicus DEM tiles/);
  assert.equal(many.calls.filter((c) => c.url.includes("/statistics")).length, 0);
});

test("the catalog's own rendering failure (424 ServerError) is a failure, not an absence of data", async () => {
  const f = areaFixture({ stats: { Copernicus_DSM_COG_10_S28_00_E141_00_DEM: () => new Response('{"code":"ServerError","description":"Could not read"}', { status: 424 }) } });
  await refused(f.relay.area(RING, "u1"), 502);
  const nodata = areaFixture({ stats: { Copernicus_DSM_COG_10_S28_00_E141_00_DEM: () => new Response('{"detail":"No data found in GeoJSON"}', { status: 424 }) } });
  assert.equal((await nodata.relay.area(RING, "u1")).elevation?.samples, 90101);
});

test("the catalog's failures and a used-up allowance become errors, and a failure isn't remembered", async () => {
  const down = areaFixture({ search: () => new Response("boom", { status: 500 }) });
  await refused(down.relay.area(RING, "u1"), 502);
  await refused(down.relay.area(RING, "u1"), 502);
  assert.equal(down.calls.length, 4);
  const busy = areaFixture({ stats: { Copernicus_DSM_COG_10_S28_00_E141_00_DEM: () => new Response("slow down", { status: 429 }) } });
  await refused(busy.relay.area(RING, "u1"), 503);
  const capped = areaFixture({ bookArea: async () => { throw new Capped("cap"); } });
  await assert.rejects(capped.relay.area(RING, "u1"), Capped);
  assert.equal(capped.calls.length, 0);
});
