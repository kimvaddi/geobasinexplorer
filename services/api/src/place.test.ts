// "Ask about this place" (place.ts, app/src/lib/place-answer.ts) and prepared computations whose pages moved to the live
// lane (live/grounding.ts): questions about the point's own figures are answered from them, questions that reach beyond
// the place are told apart with the reason in words, and a computation keeps its answer by citing the same live pages.
//   node build.mjs --script src/place.test.ts && node --test dist/scripts/place.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { answer5 } from "@/lib/answer5";
import { depthLabel } from "@/lib/basins";
import { placeAnswer, placeTopics } from "@/lib/place-answer";
import { cfg } from "./config";
import { placeFilter, type Near } from "./geo";
import { LICENCE } from "./licence";
import { beyondPlace, localFacts, nothingFound, widenReason } from "./place";
import { groundOnLive } from "./live/grounding";
import type { EvidenceSearch, LiveEvidenceHit } from "./live/serving-evidence";
import { bothManifestFixture, liveHit } from "./live/serving.test-fixtures";

// The points in the owner's screenshots (Adavale, Galilee) and Marabooka 1 (Cooper), GDA94.
const ADAVALE: Near = { lon: 144.7154, lat: -23.9472, km: 50 }, GALILEE: Near = { lon: 145.7489, lat: -25.7561, km: 50 }, COOPER: Near = { lon: 140.6102, lat: -28.176, km: 50 };
const user = { id: "caller", name: "Caller", owner: false, roles: [] };
const beyond = (q: string, near: Near) => { const b = placeFilter(near).basin; return beyondPlace(q, near, b, answer5(q, { basin: b?.id ?? null })); };
const notes = (note: string) => ({ status: "incomplete" as const, validator: "Grok 4.1 Fast", checked: 0, supported: 0, removed: [], note });

test("a question about the point's own figures is told apart from one about anything else", () => {
  const h = localFacts(GALILEE);
  assert.equal(h.basinName, "Galilee Basin");
  assert.deepEqual(placeTopics("How deep is the basin floor here?", h), ["depth"]);
  assert.deepEqual(placeTopics("Which boreholes are nearest?", h), ["boreholes"]);
  assert.deepEqual(placeTopics("How many boreholes are within 10 km of this point, and how confident is the seismic here?", h), ["boreholes", "confidence", "seismic"]);
  assert.equal(placeTopics("What do we know here?", h)?.length, 9);
  assert.deepEqual(placeTopics("How deep is the Galilee Basin here?", h), ["depth"], "the basin around the point may be named");
  for (const q of ["What do the sources near here say about the Toolachee Formation?", "How deep is the Patchawarra Formation here?", "How deep is the Cooper Basin here?",
    "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?", "What is the porosity here?", "Which plays are analogs to the Cooper Basin Patchawarra Play?"])
    assert.equal(placeTopics(q, h), null, q);
});

test("the place answer restates the card's figures, cites the record they come from and shows the point", () => {
  const h = localFacts(GALILEE);
  assert.ok(h.depth != null, "the Galilee point has a depth-to-basement value");
  const a = placeAnswer("How deep is the basin floor here?", h, ["depth"]);
  assert.equal(a.label, "Precomputed"); assert.equal(a.status, "answered"); assert.deepEqual(a.provenance, ["computed"]);
  assert.ok(a.paragraphs.some((p) => p.includes(`depth to the basin floor here is ${depthLabel(h.depth)}`)), a.paragraphs.join(" | "));
  const record = a.citations[0];
  assert.match(record.id, /^place:145\.7489,-25\.7561$/);
  assert.ok(record.text.includes(depthLabel(h.depth)) && record.text.includes("Galilee Basin"));
  assert.ok(a.citations.some((c) => c.id === "ds:depth"));
  assert.deepEqual([a.focus?.lon, a.focus?.lat], [GALILEE.lon, GALILEE.lat]);
  assert.equal(a.geo?.[record.id]?.[0]?.kind, "point");
  const all = placeAnswer("What do we know here?", h, placeTopics("What do we know here?", h)!), text = all.paragraphs.join(" ");
  assert.ok(text.includes(`${h.within10} borehole`) && text.includes(`Uncertainty here is ${h.uncertainty.toLowerCase()}`), text);
  for (const f of h.features) assert.ok(text.includes(`the ${f.name} (${Math.min(...h.features.filter((x) => x.name === f.name).map((x) => x.km)).toFixed(0)} km)`), `${f.name} at its nearest distance`);
  assert.ok(all.paragraphs.every((p) => !/\bundefined\b|NaN/.test(p)), text);
});

test("a place answer beside a well whose reports are withheld lists GA boreholes without withholding the answer", () => {
  const near: Near = { lon: 140.75, lat: -27.8, km: 50 }, h = localFacts(near);
  assert.ok(h.wells.every((w) => !LICENCE.isWithheldWell(w.id)), "withheld well reports are left out of the figures");
  const a = placeAnswer("What do we know here?", h, placeTopics("What do we know here?", h)!);
  assert.ok(LICENCE.gateAnswer(a), "the licence gate keeps the answer");
});

test("a question that reaches beyond the place is told apart, and the reason is said in words", () => {
  assert.match(beyond("Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?", ADAVALE) ?? "", /^Your question is about the Cooper Basin, and this place is in the Adavale Basin$/);
  assert.match(beyond("Which plays are analogs to the Cooper Basin Patchawarra Play?", GALILEE) ?? "", /about the Cooper Basin, and this place is in the Galilee Basin/);
  assert.match(beyond("Which plays are analogs to the Aramac Play?", GALILEE) ?? "", /rank or compare plays and basins/);
  assert.match(beyond("What was the gas rate on DST 6 in Marabooka 1?", GALILEE) ?? "", /names Marabooka 1, about \d{3} km from this place/);
  assert.match(beyond("What does the Habanero 1 caliper survey show?", ADAVALE) ?? "", /names Habanero 1, a Cooper Basin well, and this place is in the Adavale Basin/);
  assert.equal(beyond("What do the sources near here say about the Toolachee Formation?", COOPER), null);
  assert.equal(beyond("What are the reservoirs in the Galilee Basin?", GALILEE), null);
  // Porosity is only reported from Cooper Basin wells, so an answer about it here has to say it comes from there.
  assert.match(beyond("What is the porosity here?", GALILEE) ?? "", /^What answers it is about the Cooper Basin, and this place is in the Galilee Basin$/);
});

test("only an answer that found nothing near the place, or one the checks couldn't confirm, is asked again of the whole library", () => {
  for (const reason of ["No supported live evidence", "No passage was retrieved", "No supported statement", "Validation blocked every statement"]) assert.equal(nothingFound({ label: "Not found", reason }), true, reason);
  assert.equal(nothingFound({ label: "Not found", reason: "Validation incomplete", validation: notes("The required live source was not cited. Packaged evidence cannot substitute for it.") }), true);
  assert.equal(nothingFound({ label: "Not found", reason: "Validation incomplete", validation: notes("The live agent or independent validation did not complete within the request budget. Please try again.") }), false);
  assert.equal(nothingFound({ label: "Not found", reason: "Reuse terms not confirmed" }), false);
  assert.equal(nothingFound({ label: "Retrieved", reason: "Written by the pinned Foundry agent from governed evidence and independently validated" }), false);
  const basin = placeFilter(GALILEE).basin;
  assert.match(widenReason({ label: "Not found", reason: "No supported live evidence" }, GALILEE, basin) ?? "", /^No source geotagged within 50 km of this point, or about the Galilee Basin as a whole, answers this question$/);
  for (const note of ["The independent validator did not fully confirm every generated fact.", "A generated statement failed the deterministic citation and number checks.", "A generated statement did not cite a retrieved source."])
    assert.match(widenReason({ label: "Not found", reason: "Validation incomplete", validation: notes(note) }, GALILEE, basin) ?? "", /couldn't confirm the answer from the sources near this place/, note);
  for (const note of ["The live agent or independent validation did not complete within the request budget. Please try again.", "The live publication changed during the answer. Ask again against the current publication."])
    assert.equal(widenReason({ label: "Not found", reason: "Validation incomplete", validation: notes(note) }, GALILEE, basin), null, note);
});

test("a prepared computation keeps its answer by citing the same live pages, and fails closed without them", async () => {
  cfg.live.sources = ["peps-sa-marabooka-1", "ga-147461"];
  const manifest = bothManifestFixture(), signal = AbortSignal.timeout(5_000);
  const det = answer5("Which plays are analogs to the Cooper Basin Patchawarra Play?", { basin: null });
  const cooper = det.citations.find((c) => /cooper report/i.test(c.doc));
  assert.ok(cooper, "the ranking cites the Cooper Basin guide");
  const guide = (over: Partial<LiveEvidenceHit> = {}) => liveHit({ id: "live_g4_v1", sourceId: "ga-147461", sha256: "e".repeat(64), documentSha256: "f".repeat(64), docId: "guide",
    page: cooper.page, text: cooper.text, basin: "cooper", well: null, ...over });
  const reader = (hits: LiveEvidenceHit[], filters: string[] = []): EvidenceSearch => ({ live: async (_q, f) => { filters.push(f); return hits; }, packaged: async () => [] });

  const filters: string[] = [];
  const g = await groundOnLive(det, manifest, reader([guide()], filters), user, signal);
  assert.ok(g);
  assert.deepEqual(g.matched.map((m) => [m.from, m.to.id]), [[`${cooper.doc} p. ${cooper.page}`, "live_g4_v1"]]);
  const live = g.answer.citations.find((c) => c.id === "live_g4_v1");
  assert.equal(live?.provenanceLabel, "live"); assert.equal(live?.live?.sourceId, "ga-147461"); assert.equal(live?.doc, "Cooper guide");
  assert.ok(!g.answer.citations.some((c) => c.id === cooper.id), "the packaged copy is never cited");
  assert.ok(g.answer.citations.some((c) => c.id === "ds:plays"), "the play tables, still packaged, stay cited");
  assert.deepEqual(g.answer.paragraphs, det.paragraphs, "the computation itself is unchanged");
  assert.match(filters[0], /sourceId eq 'ga-147461'/); assert.match(filters[0], /publishAllowed eq true/);
  assert.deepEqual(g.answer.geo?.live_g4_v1?.map((t) => [t.kind, t.basin]), [["polygon", "cooper"]]);

  assert.equal(await groundOnLive(det, manifest, reader([guide({ text: "Groundwater recharge of the Great Artesian Basin aquifers along the eastern margin." })]), user, signal), null, "a passage the live text doesn't match");
  assert.equal(await groundOnLive(det, manifest, reader([guide({ sha256: "0".repeat(64) })]), user, signal), null, "a passage from another extraction");
  const well = answer5("What was the gas rate on DST 6 in Marabooka 1?", { basin: null }), none: string[] = [];
  assert.equal(await groundOnLive(well, manifest, reader([guide()], none), user, signal), null, "legacy-well values stay with the live agent");
  assert.deepEqual(none, []);
});
