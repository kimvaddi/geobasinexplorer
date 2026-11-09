// Drawn areas (app/src/lib/area.ts and geo.ts): outlines are accepted and measured alike in the browser and the service,
// the counts of the map's own layers hold up against known places, and the library filter hands Azure AI Search a
// closed, counterclockwise polygon.
//   node build.mjs --script src/area.test.ts && node --test dist/scripts/area.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { AREA_MAX_POINTS, areaFacts, areaKm2, areaProblem, counterClockwise, lengthInsideKm, openRing, sampleArea, selfIntersects } from "@/lib/area";
import { haversineKm, type LonLat } from "@/lib/basins";
import { areaFilter, parseArea, polygonLiteral } from "./geo";
import { SpatialError } from "./maps";

const R = 6371.0088, RAD = Math.PI / 180;
const SQUARE: LonLat[] = [[140, -28], [141, -28], [141, -27], [140, -27]];

test("an outline is kept without repeated corners, and its problems are said in words", () => {
  assert.deepEqual(openRing([[140, -28], [140, -28], [141, -28], [141, -27], [140, -28]]), [[140, -28], [141, -28], [141, -27]]);
  assert.equal(areaProblem(SQUARE), null);
  assert.match(areaProblem([[140, -28], [141, -28]]) ?? "", /at least three corners/);
  assert.match(areaProblem([[140, -28], [141, -28], [200, -27]]) ?? "", /on the map/);
  assert.match(areaProblem([[140, -28], [141, -27], [141, -28], [140, -27]]) ?? "", /crosses itself/);
  assert.match(areaProblem([[110, -45], [160, -45], [160, -5], [110, -5]]) ?? "", /larger than 500,000 km²/);
  assert.match(areaProblem(Array.from({ length: AREA_MAX_POINTS + 1 }, (_, i): LonLat => [140 + Math.cos(i / 10), -27 + Math.sin(i / 10)])) ?? "", /at most 60 corners/);
  assert.ok(selfIntersects([[140, -28], [141, -28], [140.5, -28], [140.5, -27]]), "a side doubling back along the one before it");
  assert.ok(!selfIntersects([[140, -28], [141, -28], [140.5, -27.5], [140.5, -27]]), "a concave outline is fine");
});

test("areas and lengths are on the mean sphere", () => {
  const exact = R * R * RAD * (Math.sin(-27 * RAD) - Math.sin(-28 * RAD));
  assert.ok(Math.abs(areaKm2(SQUARE) - exact) < 1e-6 * exact);
  assert.equal(areaKm2([...SQUARE].reverse()), areaKm2(SQUARE));
  // A line across the square from west to east: only the part inside counts.
  const inside = lengthInsideKm([[139.5, -27.5], [141.5, -27.5]], SQUARE);
  assert.ok(Math.abs(inside - haversineKm(140, -27.5, 141, -27.5)) < 1e-6);
  assert.equal(lengthInsideKm([[142, -27.5], [143, -27.5]], SQUARE), 0);
});

test("counterclockwise order is what Azure AI Search reads as the inside", () => {
  const cw: LonLat[] = [[140, -28], [140, -27], [141, -27], [141, -28]];
  assert.deepEqual(counterClockwise(cw), [...cw].reverse());
  assert.deepEqual(counterClockwise(SQUARE), SQUARE);
  assert.equal(polygonLiteral(cw), "geography'POLYGON((141.000000 -28.000000, 141.000000 -27.000000, 140.000000 -27.000000, 140.000000 -28.000000, 141.000000 -28.000000))'");
  assert.equal(areaFilter(SQUARE), `points/any(g: geo.intersects(g, ${polygonLiteral(SQUARE)}))`);
});

test("the service checks an outline as the browser does and keeps six decimals", () => {
  assert.deepEqual(parseArea({ ring: [[140.1234567, -28.1234567], [141, -28], [141, -27], [140.1234567, -28.1234567]] }), [[140.123457, -28.123457], [141, -28], [141, -27]]);
  for (const bad of [{}, { ring: "140,-28" }, { ring: [[140, -28], [141, "x"], [141, -27]] }, { ring: [[140, -28], [141, -27], [141, -28], [140, -27]] }])
    assert.throws(() => parseArea(bad), (e: unknown) => e instanceof SpatialError && e.status === 400);
});

test("counts inside an outline around Innamincka and Marabooka hold up", () => {
  const ring: LonLat[] = [[140.4, -28.4], [141.2, -28.4], [141.2, -27.3], [140.4, -27.3]];
  const f = areaFacts(ring);
  // Both wells lie inside, but the cloud data leave out Innamincka 1, whose report is withheld until its reuse terms are
  // confirmed (lib/licence.ts), so only Marabooka 1 can be offered here.
  assert.deepEqual(f.wells.map((w) => w.id), ["marabooka-1"]);
  assert.ok(f.boreholes.n > 50, `boreholes: ${f.boreholes.n}`);
  assert.equal(f.boreholes.keys.length, f.boreholes.n);
  assert.ok(f.boreholes.list.length > 0 && f.boreholes.list.length <= 6);
  assert.equal(f.basins[0]?.id, "cooper");
  assert.ok(f.basins[0].share > 0.95 && f.depth && f.depth.min > 0 && f.depth.max >= f.depth.min);
  assert.equal(f.seismic.lines, 0, "Cooper Basin seismic lines aren't bundled");
  assert.ok(f.faults.n > 0 && f.faults.km > 0);
  // The same counts with a filter that keeps nothing, and an outline out at sea.
  assert.equal(areaFacts(ring, () => false).boreholes.filtered, 0);
  const sea = areaFacts([[155, -40], [156, -40], [156, -39]]);
  assert.deepEqual([sea.boreholes.n, sea.wells.length, sea.basins.length, sea.depth], [0, 0, 0, null]);
  assert.equal(sampleArea([[155, -40], [156, -40], [156, -39]]).outside, 1);
});
