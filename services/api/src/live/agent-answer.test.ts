import assert from "node:assert/strict";
import { test } from "node:test";
import { answerLive, titleNames, setAsideTitleNames, setAsidePages, liveNumberCheck, CORRECTION_NOTE, INTERPRETATION_LABEL, type LiveAnswerDependencies } from "./agent-answer";
import { AGENT_MAX_STATEMENTS } from "./agent-definition";
import { cfg } from "../config";
import { deterministicCheck, type Claim, type Verdict } from "../validate";
import { baseAnswer, contextFixture, evidenceFixture, fakeAgent, functionReply, answerReply, statementsReply, manifestFixture, liveHit, type FixtureStatement } from "./serving.test-fixtures";
import type { AgentReply } from "./agent-client";
const options = () => ({ deadline: Date.now() + 90_000 });
// When asked to correct, this fake agent repeats its answer, so a bad statement still meets the final gate.
function fixture(text?: string, cites?: string[]) {
  const f = fakeAgent([functionReply(), answerReply(text, cites), { ...answerReply(text, cites), id: "r3" }]);
  const deps: LiveAnswerDependencies = { client: () => f.client, journal: f.journal, reader: evidenceFixture(), current: async () => ({ manifest: manifestFixture(), etag: '"a"' }), validate: async (claims, _s, _n, before, control) => { assert.ok(control.signal); assert.ok(control.deadline); await before(200); return { verdicts: claims.map(() => ({ verdict: "supported", reason: "Confirmed" })), tokens: 100, ms: 1 }; } };
  return { f, deps };
}
test("live answer preserves contract, validates every claim and exposes only native API page identities", async () => {
  const { deps } = fixture(); let booked = 0; const r = await answerLive(baseAnswer(), contextFixture(), async () => { booked++; }, options(), deps);
  assert.equal(r.answer.label, "Retrieved"); assert.equal(r.answer.validation.status, "passed"); assert.equal(r.tokens, 457); assert.equal(booked, 3);
  assert.equal(r.answer.citations[0].live?.sourceId, "peps-sa-marabooka-1"); assert.ok(!JSON.stringify(r.answer).includes("blob.core"));
});
// The agent's cleanup runs beside validation (5 Nov 2026), but an answer is still shown only once it is confirmed.
test("the agent's cleanup runs beside the independent validation, and the answer is shown only once cleanup is confirmed", async () => {
  const previous = cfg.live.cleanupMs; cfg.live.cleanupMs = 1_000;
  try {
    const { f, deps } = fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const del = f.client.deleteConversation; f.client.deleteConversation = async (id, s) => { await gate; return del(id, s); };
    let overlapped = false; const validate = deps.validate;
    deps.validate = async (...args) => { overlapped = !f.calls.includes("complete"); release(); return validate(...args); };
    const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
    assert.equal(overlapped, true); assert.equal(r.answer.label, "Retrieved"); assert.ok(f.calls.includes("complete"));
  } finally { cfg.live.cleanupMs = previous; }
});
test("a cleanup that cannot be confirmed withholds an answer the validator confirmed, and a Not found reply as well", async () => {
  const { f, deps } = fixture(); let validated = false; const validate = deps.validate;
  deps.validate = async (...args) => { validated = true; return validate(...args); };
  f.client.deleteResponse = async () => { throw new Error("denied"); };
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(validated, true); assert.equal(r.answer.reason, "Validation incomplete"); assert.deepEqual(r.answer.citations, []);
  const notFound: AgentReply = { id: "r2", status: "completed", text: JSON.stringify({ answerable: false, sentences: [], missing: ["No evidence"] }), output: [{ type: "message" }], tokens: 10 };
  const none = fakeAgent([functionReply(), notFound]); none.client.deleteResponse = async () => { throw new Error("denied"); };
  const n = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), { ...deps, client: () => none.client, journal: none.journal });
  assert.equal(n.answer.reason, "Validation incomplete");
});
test("a withheld answer is returned only after the agent's cleanup has settled", async () => {
  const { f, deps } = fixture("Top is 9999 ft below KB.", ["L1"]);
  const del = f.client.deleteConversation; f.client.deleteConversation = async (id, s) => { await new Promise((resolve) => setTimeout(resolve, 30)); return del(id, s); };
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(r.answer.reason, "Validation incomplete"); assert.ok(f.calls.includes("deleteConversation") && f.calls.includes("complete"));
});
for (const [text, cites] of [["Top is 9999 ft below KB.", ["L1"]], ["Top is 6326 ft below KB.", ["L999"]]] as const) test(`deterministic failure is Validation incomplete, never a partial answer: ${text} ${cites}`, async () => {
  const { deps } = fixture(text, [...cites]); deps.validate = async () => { throw new Error("Must not validate a bad deterministic claim"); };
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps); assert.equal(r.answer.reason, "Validation incomplete"); assert.deepEqual(r.answer.citations, []); assert.ok(!r.answer.paragraphs.join().includes("9999"));
});
// The fixture passage has no standalone 1, like the live formation-tops table, and its document is "Marabooka 1 report".
for (const text of ["Top Toolachee in Marabooka 1 is 6326 ft below KB.", "Top Toolachee in Marabooka-1 is 6326 ft below KB.", "Top Toolachee in Marabooka No. 1 is 6326 ft below KB."]) test(`a numbered well name from a cited title is a name, not an unsupported number: ${text}`, async () => {
  const { deps } = fixture(text, ["L1"]); const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(r.answer.label, "Retrieved"); assert.equal(r.answer.validation.status, "passed");
});
// Grok's review: a name must never swallow the start of a longer number (fixture evidence holds only 6326 and 181.9).
for (const text of ["Top Toolachee in Marabooka 1 is 6400 ft below KB.", "Innamincka 1 has its Toolachee top at 6326 ft below KB.", "Toolachee top is Marabooka 16326 ft below KB.",
  "KB is Marabooka 1181.9 ft.", "Toolachee top is Marabooka 1,6326 ft below KB.", "Toolachee top is Marabooka-16326 ft below KB.", "Toolachee top is Marabooka No. 16326 ft below KB.", "Toolachee top in Marabooka 1.5 is 6326 ft below KB."]) test(`numbers outside a cited title's name are still checked: ${text}`, async () => {
  const { deps } = fixture(text, ["L1"]); deps.validate = async () => { throw new Error("Must not validate a bad deterministic claim"); };
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps); assert.equal(r.answer.reason, "Validation incomplete");
  // The number check itself must refuse it; a validator error would also end as Validation incomplete.
  assert.equal(r.answer.validation.note, "A generated statement failed the deterministic citation and number checks.");
});
// The live page 6 OCR writes table cells on separate lines with a detached sign ("6326'\n- 6144'"), and so do bullets and
// wrapped ranges, so a detached sign is never read as a minus. An attached sign the evidence does not write is refused, and
// the one correction request asks for the number as the evidence writes it.
const page6 = "Late Permian\nToolachee\n6326'\n- 6144'\n200'\nEarly Permian\nPatchawarra\n6526'\n- 6344'";
test("signs are read the same way in the sentence and the live OCR evidence", () => {
  const cited = [{ page: 6, doc: "Marabooka 1 well completion report" }];
  for (const s of ["The report\u2019s formation table lists the subsea elevation as - 6144'.", "The Toolachee top is 6144 ft below sea level."]) assert.equal(liveNumberCheck(s, page6, cited), null, s);
  for (const s of ["The report\u2019s formation table lists the subsea elevation as \u22126144 ft.", "The subsea elevation is -6144'.", "The subsea elevation is - 6145'."]) assert.notEqual(liveNumberCheck(s, page6, cited), null, s);
});
test("a catalogue identifier gets no exemption: every form is checked, and Grok's unit placements cannot hide a quantity", () => {
  const title = "Cooper Basin regional geology (GA 147461)", evidence = "GEOLOGY: Cooper Basin region. Wainman et al. 2023. The succession is divided into 16 play intervals.";
  assert.deepEqual(titleNames(title), []);
  const check = (s: string) => deterministicCheck(setAsideTitleNames(s, [title]), evidence, { pages: [4], titles: [title] });
  assert.equal(check("GEOLOGY: Cooper Basin region, by Wainman and colleagues (2023), uses 16 play intervals."), null);
  for (const s of ["GEOLOGY: Cooper Basin region (GA 147461; Wainman et al., 2023) uses 16 play intervals.", "The guide (GA-147461) uses 16 play intervals.",
    "The subsea elevation is (GA 147461; Wainman et al., 2023) ft.", "The value is (GA 147461, cited) ft.", "The value is (GA 147461). ft.", "The value is (GA 147461)\nft",
    "The value is (GA 147461) mKB.", "The top is GA 147461 ft below KB.", "The guide uses 147461 play intervals."]) assert.notEqual(check(s), null, s);
  const marabooka = (s: string) => deterministicCheck(setAsideTitleNames(s, ["Marabooka 1 well completion report"]), "Top Toolachee 6326 ft below KB.", { pages: [25], titles: [] });
  assert.notEqual(marabooka("The top is Marabooka 1 ft below KB."), null); assert.notEqual(marabooka("The top is Marabooka 1' below KB."), null);
  assert.equal(marabooka("Marabooka 1's Toolachee top is 6326 ft below KB."), null); assert.equal(marabooka('The "Marabooka 1" well has its Toolachee top at 6326 ft below KB.'), null);
  for (const s of ["The volume is Marabooka 1 bbl.", "The thickness is Marabooka 1 mm.", "The rate is Marabooka 1 stb.", "The size is Marabooka 1 in.", "The top is Marabooka 1 mKB.", "The top is Marabooka 1 ftSS."]) assert.notEqual(marabooka(s), null, s);
  assert.equal(marabooka("Marabooka 1 in the Cooper Basin has its Toolachee top at 6326 ft below KB."), null);
});
// Grok's eighth review: the live path must not hand titles or pages to the shared check, which strips them unguarded, and
// a unit may follow a name or page reference after punctuation, quotes, brackets, a dash or a line break.
test("the live number check strips no title prefix and keeps a unit after punctuation", () => {
  const marabooka = [{ page: 25, doc: "Marabooka 1 well completion report" }], evidence = "Top Toolachee 6326 ft below KB. Report KB elevation 181.9 ft.";
  assert.notEqual(liveNumberCheck("The top is Innamincka 16326 ft.", evidence, [{ page: 3, doc: "Innamincka 1 \u00b7 Appendix 6 (formation testing)" }]), null);
  assert.notEqual(liveNumberCheck("The subsea elevation is Cooper Basin regional geology (GA 147461) ft.", "16 play intervals. 2023.", [{ page: 4, doc: "Cooper Basin regional geology (GA 147461)" }]), null);
  for (const s of ["The top is Marabooka 1, ft below KB.", "The top is Marabooka 1. ft", "The top is Marabooka 1\nft", "The top is Marabooka 1-ft", "The top is Marabooka 1 (ft).",
    'The top is "Marabooka 1" ft.', "The top is Marabooka 1\u2019 below KB.", "The size is Marabooka 1 in.", "The top is Marabooka 1 \u2013 mKB.",
    // Grok's ninth review: a unit after "in", after a middle dot or after a few words is still a unit.
    "The top is Marabooka 1 in ft below KB.", "The top is Marabooka 1 \u00b7 ft.", "The top is Marabooka 1 | ft.", "The top is Marabooka 1 measured in ft.",
    "The top is Marabooka 1 in units of ft.", "The top is Marabooka 1\u2019s ft.", "The top is Marabooka 1 = ft."]) assert.notEqual(liveNumberCheck(s, evidence, marabooka), null, s);
  for (const s of ["Marabooka 1, the Toolachee top is 6326 ft below KB.", "Marabooka 1 in the Cooper Basin has its Toolachee top at 6326 ft below KB.", "Marabooka 1 in 1980 had its Toolachee top at 6326 ft below KB.",
    "Marabooka 1\u2019s Toolachee top is 6326 ft below KB.", 'The "Marabooka 1" well has its Toolachee top at 6326 ft below KB.', "Marabooka 1 (PEPS SA) has its Toolachee top at 6326 ft below KB.",
    "Marabooka 1 kelly bushing elevation is 181.9 ft.", "Marabooka 1 (KB 181.9 ft) has its Toolachee top at 6326 ft below KB.", "The top of the Toolachee Formation in Marabooka 1 is 6326' below the kelly bushing."]) {
    if (s.includes("1980")) assert.equal(liveNumberCheck(s, `${evidence} Drilled in 1980.`, marabooka), null, s); else assert.equal(liveNumberCheck(s, evidence, marabooka), null, s);
  }
});
test("a cited page reference is a pointer only as a complete number with no unit after it", () => {
  const evidence = "Top Toolachee 6326 ft below KB.", cited = [{ page: 25, doc: "Cooper guide" }, { page: 13, doc: "Cooper guide" }];
  for (const s of ["The Toolachee top is 6326 ft below KB, on native PDF page 25.", "On page 25, the Toolachee top is 6326 ft below KB.", "Pages 25 and 13 give the Toolachee top as 6326 ft below KB.", "See p. 25 in the report: 6326 ft below KB."])
    assert.equal(liveNumberCheck(s, evidence, cited), null, s);
  assert.equal(liveNumberCheck("On native PDF page 25 in the report, the top is 6326 ft below KB.", evidence, cited), null);
  for (const s of ["The top is page 25 ft below KB.", "The top is page 25, ft below KB.", "The top is page 25.5 ft below KB.", "The top is page 25,000 ft.", "The top is on page 26.", "Pages 25-26 give the top.",
    "The depth is page 25 in ft.", "The depth is page 25 \u00b7 ft."])
    assert.notEqual(liveNumberCheck(s, evidence, cited), null, s);
  assert.equal(setAsidePages("page 25 and page 99", [25]).trim(), "and page 99");
});
// Grok's tenth review: every digit must be read as part of an ordinary number, or its token quoted verbatim from the evidence.
test("digits the shared reader cannot see, and composite notations, must be quoted verbatim from the evidence", () => {
  const cited = [{ page: 25, doc: "Marabooka 1 well completion report" }], evidence = "Top Toolachee 6326 ft below KB. Report KB elevation 181.9 ft. Values 6, 400 and 65 and 3.";
  for (const s of ["The top is6400 ft below KB.", "The top.6400 ft below KB.", "The top,6400 ft below KB.", "The top is 6326e3 ft.", "The top is 6 400 ft.", "The top is 6,5 ft.",
    "The value is 10^3 ft.", "The value is 10\u00b3 ft.", "The top is \uff16\uff14\uff10\uff10 ft.", "The top is \u0666\u0664\u0660\u0660 ft.", "The value is .5 ft.", "The well was spudded on 30.12.81."])
    assert.notEqual(liveNumberCheck(s, evidence, cited), null, s);
  const quoted = "Spudded 30.12.80. Permeability 1.2e-3 md. Gas with CO2 and H\u2082S. Depth 6 000 ft. Exponent 10\u00b3 ft.";
  for (const s of ["The well was spudded on 30.12.80.", "The permeability is 1.2e-3 md.", "The gas contained CO2.", "The gas contained H\u2082S.", "The depth is 6 000 ft.", "The value is 10\u00b3 ft.", "The top is \uff16\uff13\uff12\uff16 ft."])
    assert.equal(liveNumberCheck(s, `${quoted} Top 6326 ft.`, cited), null, s);
  for (const s of ["The permeability is 1.2e-5 md.", "The gas contained CO2."]) assert.notEqual(liveNumberCheck(s, "Permeability 1.2e-3 md and 5 samples.", cited), null, s);
  assert.notEqual(liveNumberCheck("The value is 10^3 ft.", "Values 10 and 3.", cited), null); assert.notEqual(liveNumberCheck("The value is 10\u00b3 ft.", "Value 103 ft.", cited), null);
  // Grok's eleventh review: digit runs glued by any other joiner are one composite, quoted verbatim; a range keeps two endpoints.
  const parts = "Zone 6 and 326 m. Values 10 and 3. Ratio 1 and 2. Interval 6412-6454 ft.";
  for (const s of ["The top is 6\u00b7326 ft.", "The top is 6'326 ft.", "The top is 6\u2019326 ft.", "The value is 10**3 ft.", "The ratio is \u00bd.", "The top is 6326\u00b15 ft.", "The interval is 6412-6455 ft."])
    assert.notEqual(liveNumberCheck(s, parts, cited), null, s);
  const written = "Map scale 1:250,000. Spudded 30/12/80. Interval 6412-6454 ft. Ratio \u00bd.";
  for (const s of ["The map scale is 1:250,000.", "The well was spudded on 30/12/80.", "The interval is 6412-6454 ft.", "The ratio is \u00bd."]) assert.equal(liveNumberCheck(s, written, cited), null, s);
  assert.equal(liveNumberCheck("The tested interval is 6412\u20136454 ft.", "Tested interval 6412' - 6454'.", cited), null);
});
test("title names cover numbered well names only, not years, catalogue numbers, document parts or plain titles", () => {
  assert.deepEqual(titleNames("Marabooka 1 well completion report"), [{ name: "Marabooka", number: "1" }]);
  assert.deepEqual(titleNames("Dullingari North 1A report"), [{ name: "Dullingari North", number: "1A" }]);
  for (const t of ["Cooper Basin regional geology (GA 147461)", "TEGI glossary", "Volume 2 of the report", "Section 12 geology", "Cooper Basin 2018 review", "Top 6326 summary"]) assert.deepEqual(titleNames(t), [], t);
  assert.equal(setAsideTitleNames("In Marabooka 1, Marabooka-1 and MARABOOKA No. 1 the top is 6326 ft.", ["Marabooka 1 well completion report"]).match(/\d+/g)?.join(), "6326");
  assert.equal(setAsideTitleNames("Marabooka 16326 ft", ["Marabooka 1 well completion report"]), "Marabooka 16326 ft");
});
test("a statement quoting a number its evidence lacks gets one correction request, and the corrected answer passes", async () => {
  const f = fakeAgent([functionReply(), answerReply("Top Toolachee is \u22126326 ft below KB."), { ...answerReply("Top Toolachee is 6326 ft below KB."), id: "r3" }]);
  const { deps } = fixture(); deps.client = () => f.client; deps.journal = f.journal;
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(r.answer.label, "Retrieved"); assert.ok(r.answer.trace?.some((t) => t.step === "Asked the agent to correct its numbers"));
  const sent = JSON.stringify(f.submitted[2]); assert.ok(sent.includes(CORRECTION_NOTE.slice(0, 40)) && sent.includes("Statement 1"));
  assert.equal(f.calls.filter((c) => c === "respond").length, 3);
});
test("a draft naming a catalogue identifier is corrected once, and the corrected answer passes", async () => {
  const f = fakeAgent([functionReply(), answerReply("Top Toolachee is 6326 ft below KB (GA 147461; Wainman et al., 2023)."), { ...answerReply("Top Toolachee is 6326 ft below KB."), id: "r3" }]);
  const { deps } = fixture(); deps.client = () => f.client; deps.journal = f.journal;
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(r.answer.label, "Retrieved"); assert.ok(JSON.stringify(f.submitted[2]).includes("147461"));
});
test("only one correction is asked; a second failing draft is withheld at the number check", async () => {
  const f = fakeAgent([functionReply(), answerReply("Top Toolachee is 9999 ft below KB."), { ...answerReply("Top Toolachee is 9998 ft below KB."), id: "r3" }, { ...answerReply(), id: "r4" }]);
  const { deps } = fixture(); deps.client = () => f.client; deps.journal = f.journal; deps.validate = async () => { throw new Error("Must not validate a bad deterministic claim"); };
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(r.answer.validation.note, "A generated statement failed the deterministic citation and number checks."); assert.equal(f.calls.filter((c) => c === "respond").length, 3);
});
for (const verdict of ["partial", "unsupported"] as const) test(`Grok ${verdict} on a fact blocks the entire live answer`, async () => {
  const { deps } = fixture(); deps.validate = async () => ({ verdicts: [{ verdict, reason: "Not certain" }], tokens: 10, ms: 1 });
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps); assert.equal(r.answer.reason, "Validation incomplete"); assert.deepEqual(r.answer.citations, []);
});
test("a publication swap while validating withholds the superseded answer", async () => {
  const { deps } = fixture(); deps.current = async () => ({ manifest: manifestFixture(2), etag: '"b"' });
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps); assert.equal(r.answer.reason, "Validation incomplete"); assert.deepEqual(r.answer.citations, []);
});
test("computed evidence is passed to the existing deterministic and independent gates", async () => {
  const f = fakeAgent([functionReply(), { ...functionReply(), id: "r2", output: [{ type: "function_call", name: "convert_depth_kb_to_subsea", call_id: "math", arguments: JSON.stringify({ depthBelowKbFt: 6326, kbElevationFt: 181.9, depthEvidenceId: "L1", kbEvidenceId: "L1" }) }] }, { ...answerReply("Top Toolachee is 6326 ft below KB; minus KB elevation 181.9 ft gives 6144.1 ft below sea level.", ["T2"]), id: "r3" }]);
  const { deps } = fixture(); deps.client = () => f.client; deps.journal = f.journal;
  deps.validate = async (claims) => { assert.equal(claims[0].computed, true); assert.equal(claims[0].evidence.length, 2); assert.ok(claims[0].evidence.some((e) => /6144.1/.test(e.text))); return { verdicts: [{ verdict: "supported", reason: "Recomputed" }], tokens: 20, ms: 1 }; };
  const r = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps); assert.equal(r.answer.validation.status, "passed"); assert.equal(r.answer.computations?.[0].output.value, 6144.1); assert.equal(r.answer.citations.length, 1); assert.deepEqual(r.answer.computations?.[0].sourceIds, [r.answer.citations[0].id]); assert.ok(r.answer.computations?.[0].inputs.every((i) => r.answer.citations.some((c) => c.id === i.evidenceId))); assert.ok(r.answer.trace?.some((t) => t.step === "Computed from source evidence"));
});

test("packaged-only evidence cannot substitute for a question's required live source", async () => {
  const f = fakeAgent([functionReply("search_packaged_evidence"), answerReply("Top is 6326 ft below KB.", ["P1"])]);
  const { deps } = fixture(); deps.client = () => f.client; deps.journal = f.journal;
  deps.reader = { ...evidenceFixture(), packaged: async () => [{ id: "p1", docId: "independent-log", doc: "Independent packaged log", page: 1, heading: "Test", text: "Top is 6326 ft below KB.", basin: "cooper", kind: "report", well: null, visibility: "public", owner: "", source: "Geoscience Australia" }] };
  deps.validate = async () => { throw new Error("Do not send substituted evidence for validation"); };
  const result = await answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps);
  assert.equal(result.answer.reason, "Validation incomplete"); assert.match(result.answer.validation.note, /required live source/); assert.deepEqual(result.answer.citations, []);
});

test("Validation incomplete clears map effects, tables, computations and every reopening action", async () => {
  const { deps } = fixture(); deps.validate = async () => ({ verdicts: [{ verdict: "unsupported", reason: "No support" }], tokens: 10, ms: 1 });
  const a = baseAnswer(); a.focus = { lon: 140.6, lat: -28.1, zoom: 8 }; a.highlight = ["old"]; a.followUps = ["stale"];
  a.table = { columns: ["Old"], rows: [["Value"]] }; a.geo = {}; a.layers = { depth: true }; a.fieldRef = { site: "marabooka-1", field: "old" }; a.computations = [];
  a.trace = [{ step: "Computed from source evidence", detail: "Stale computation", ms: 0 }];
  const { answer } = await answerLive(a, contextFixture(), async () => {}, options(), deps);
  assert.equal(answer.reason, "Validation incomplete"); assert.equal(answer.focus, null); assert.equal(answer.focusBasin, null); assert.deepEqual(answer.highlight, []); assert.deepEqual(answer.followUps, []);
  for (const key of ["table", "geo", "layers", "fieldRef", "computations"]) assert.equal(key in answer, false);
  assert.ok(!answer.trace?.some((t) => t.detail === "Stale computation"));
});

// Answer contract v2. The fixture evidence L1 reads "Top Toolachee 6326 ft below KB. Report KB elevation 181.9 ft."
const F1: FixtureStatement = { kind: "fact", text: "Top Toolachee is 6326 ft below KB.", cites: ["L1"] };
const F2: FixtureStatement = { kind: "fact", text: "The report gives a KB elevation of 181.9 ft.", cites: ["L1"] };
const I1: FixtureStatement = { kind: "interpretation", text: "This suggests the top should be compared with other wells only after it is reduced to a common datum.", cites: ["L1"] };
const I2: FixtureStatement = { kind: "interpretation", text: "So a sea-level figure would rest on the KB elevation from the same report.", cites: ["L1"] };
// A two-round fake agent that repeats its answer if asked to correct it, and a validator that judges each claim by its text.
function contract(statements: FixtureStatement[], judge: (c: Claim) => Verdict["verdict"] = () => "supported", replies?: AgentReply[]) {
  const f = fakeAgent(replies ?? [functionReply(), statementsReply(statements), statementsReply(statements, "r3")]);
  const { deps } = fixture(); deps.client = () => f.client; deps.journal = f.journal;
  const sent: Claim[][] = [];
  deps.validate = async (claims, _s, _n, before) => { sent.push(claims); await before(200); return { verdicts: claims.map((c) => ({ verdict: judge(c), reason: judge(c) === "supported" ? "Confirmed" : "The reasoning does not follow from the evidence" })), tokens: 100, ms: 1 }; };
  return { f, deps, sent, ask: () => answerLive(baseAnswer(), contextFixture(), async () => {}, options(), deps) };
}
const step = (a: { trace?: { step: string; detail: string }[] }, name: string) => a.trace?.find((t) => t.step === name)?.detail ?? "";
test("contract v2: confirmed interpretations follow the facts in their own labelled paragraph, with citations", async () => {
  const c = contract([F1, I1, F2]), { answer } = await c.ask();
  assert.equal(answer.label, "Retrieved"); assert.equal(answer.validation.status, "passed"); assert.deepEqual(answer.validation.removed, []);
  assert.deepEqual(c.sent[0].map((x) => x.interpretation), [false, true, false]);
  assert.deepEqual(answer.paragraphs, [`${F1.text} [1] ${F2.text} [1]`, `${INTERPRETATION_LABEL} ${I1.text} [1]`]);
  assert.equal(answer.validation.note, "Every statement passed deterministic checks and the independent provenance challenge.");
  assert.equal(step(answer, "Validated"), "Grok 4.1 Fast confirmed 2 facts and 1 interpretation against their cited evidence; 0 interpretations removed.");
});
test("an interpretation the validator does not confirm is removed with its reason, and the facts are still shown", async () => {
  const c = contract([F1, I1, I2], (claim) => claim.text === I1.text ? "unsupported" : "supported"), { answer } = await c.ask();
  assert.equal(answer.label, "Retrieved"); assert.equal(answer.validation.status, "passed");
  assert.deepEqual(answer.paragraphs, [`${F1.text} [1]`, `${INTERPRETATION_LABEL} ${I2.text} [1]`]);
  assert.deepEqual(answer.validation.removed, [{ text: I1.text, why: "Grok 4.1 Fast: not supported. The reasoning does not follow from the evidence" }]);
  assert.match(answer.validation.note, /1 interpretation the checks could not fully confirm was removed/);
  assert.equal(step(answer, "Validated"), "Grok 4.1 Fast confirmed 1 fact and 1 interpretation against their cited evidence; 1 interpretation removed.");
  const none = await contract([F1, I1, I2], (claim) => claim.interpretation ? "partial" : "supported").ask();
  assert.deepEqual(none.answer.paragraphs, [`${F1.text} [1]`]); assert.equal(none.answer.validation.removed.length, 2); assert.match(none.answer.validation.removed[0].why, /only partly supported/);
});
test("an unconfirmed fact still withholds the whole answer, whatever the interpretations' verdicts", async () => {
  for (const verdict of ["partial", "unsupported"] as const) {
    const { answer } = await contract([F1, I1], (claim) => claim.interpretation ? "supported" : verdict).ask();
    assert.equal(answer.reason, "Validation incomplete"); assert.deepEqual(answer.citations, []); assert.deepEqual(answer.validation.removed, []);
    assert.equal(answer.validation.note, "The independent validator did not fully confirm every generated fact."); assert.ok(!answer.paragraphs.join().includes("datum"));
  }
});
test("an interpretation quoting a number its evidence lacks, or citing evidence never returned, fails the deterministic gate and is removed before validation", async () => {
  const bad: FixtureStatement = { kind: "interpretation", text: "This suggests the top lies about 9999 ft below the surface.", cites: ["L1"] };
  const unretrieved: FixtureStatement = { kind: "interpretation", text: "So the datum question remains open.", cites: ["L9"] };
  const c = contract([F1, bad, I1, unretrieved]), { answer } = await c.ask();
  assert.equal(c.f.calls.filter((x) => x === "respond").length, 3, "the one correction request is still asked first");
  assert.deepEqual(c.sent[0].map((x) => x.text), [F1.text, I1.text]);
  assert.deepEqual(answer.paragraphs, [`${F1.text} [1]`, `${INTERPRETATION_LABEL} ${I1.text} [1]`]);
  assert.deepEqual(answer.validation.removed, [{ text: bad.text, why: "Deterministic check: the number 9999 is not in the cited source." }, { text: unretrieved.text, why: "Deterministic check: it cites evidence IDs the tools did not return." }]);
  assert.match(step(answer, "Checked citations and numbers"), /^2 interpretations removed for citing evidence the tools did not return or a number its evidence lacks/);
  assert.ok(!JSON.stringify(answer.paragraphs).includes("9999"));
});
test("statements beyond the old five are shown up to the cap, and an answer over the cap is withheld", async () => {
  const full = Array.from({ length: AGENT_MAX_STATEMENTS }, (_, i) => [F1, I1, F2, I2][i % 4]);
  const c = contract(full), { answer } = await c.ask();
  assert.equal(answer.label, "Retrieved"); assert.equal(answer.validation.checked, AGENT_MAX_STATEMENTS); assert.equal(c.sent[0].length, AGENT_MAX_STATEMENTS);
  assert.equal(answer.paragraphs.length, 2); assert.ok(answer.paragraphs[1].startsWith(INTERPRETATION_LABEL));
  const over = contract([...full, F1]); over.deps.validate = async () => { throw new Error("Must not validate an answer over the cap"); };
  const r = await over.ask(); assert.equal(r.answer.reason, "Validation incomplete"); assert.deepEqual(r.answer.citations, []);
});
test("an answer with only interpretations is not an answer", async () => {
  const c = contract([I1, I2]); c.deps.validate = async () => { throw new Error("Must not validate an answer without facts"); };
  const { answer } = await c.ask();
  assert.equal(answer.reason, "No supported live evidence"); assert.deepEqual(answer.paragraphs, ["Not found in the published evidence. No supported answer was returned."]); assert.deepEqual(answer.citations, []);
});
test("a required live source must back a fact, so an interpretation can't stand in for it", async () => {
  const both: AgentReply = { ...functionReply(), output: [{ type: "function_call", name: "search_live_evidence", arguments: JSON.stringify({ query: "Toolachee KB" }), call_id: "call-1" }, { type: "function_call", name: "search_packaged_evidence", arguments: JSON.stringify({ query: "Toolachee" }), call_id: "call-2" }] };
  const packaged = { id: "p1", docId: "independent-log", doc: "Independent packaged log", page: 1, heading: "Test", text: "Top is 6326 ft below KB.", basin: "cooper", kind: "report", well: null, visibility: "public", owner: "", source: "Geoscience Australia" };
  const agree = "This suggests the packaged log and the live report agree on the top.";
  const cases: [FixtureStatement[], boolean][] = [
    [[{ kind: "fact", text: "Top is 6326 ft below KB.", cites: ["P2"] }, { kind: "interpretation", text: agree, cites: ["L1"] }], false],
    [[{ kind: "fact", text: "Top Toolachee is 6326 ft below KB.", cites: ["L1"] }, { kind: "interpretation", text: agree, cites: ["P2"] }], true],
  ];
  for (const [statements, shown] of cases) {
    const c = contract(statements, () => "supported", [both, statementsReply(statements), statementsReply(statements, "r3")]);
    c.deps.reader = { ...evidenceFixture(), packaged: async () => [packaged] };
    const { answer } = await c.ask();
    if (shown) { assert.equal(answer.label, "Retrieved"); assert.ok(answer.citations.some((x) => x.live?.sourceId === "peps-sa-marabooka-1")); }
    else { assert.equal(answer.reason, "Validation incomplete"); assert.match(answer.validation.note, /required live source/); assert.equal(c.sent.length, 0); }
  }
});
test("the live answer uses the configured tool-call limit", async () => {
  const previous = cfg.live.agentToolCalls; cfg.live.agentToolCalls = 1;
  try {
    const two: AgentReply = { ...functionReply(), output: [1, 2].map((n) => ({ type: "function_call", name: "search_live_evidence", arguments: JSON.stringify({ query: `Toolachee ${n}` }), call_id: `call-${n}` })) };
    const c = contract([F1], undefined, [two, answerReply()]); c.deps.validate = async () => { throw new Error("Must not validate after the tool budget is exceeded"); };
    const { answer } = await c.ask(); assert.equal(answer.reason, "Validation incomplete");
  } finally { cfg.live.agentToolCalls = previous; }
});
