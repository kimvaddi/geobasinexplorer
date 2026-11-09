import { basinById } from "@/lib/basins";
import type { CloudAnswer } from "../answer";
import { cfg } from "../config";
import { CapError } from "../usage";
import { NUM, deterministicCheck, validateInBatches, ValidationError, type BeforeCall, type Claim, type ValidationControl, type ValidationResult } from "../validate";
import { agentTransport, agentJournal, type AgentJournal, type AgentTransport } from "./agent-client";
import { AgentTools, type AgentEvidence, type ToolComputation, type ToolContext } from "./agent-tools";
import { runPromptAgent, AgentRunError, abortable, failureLog, type AgentOutput, type AgentStatement } from "./agent-runtime";
import { evidenceSearch, type EvidenceSearch } from "./serving-evidence";
import { liveManifest, type ManifestSnapshot } from "./serving-manifest";
import { liveGeotags, wellLabel } from "./geotags";

export interface LiveAnswerDependencies {
  client: () => AgentTransport; journal: AgentJournal; reader: EvidenceSearch;
  current: (options: { fresh: boolean; signal: AbortSignal }) => Promise<ManifestSnapshot>;
  validate: (claims: Claim[], shared: Claim["evidence"], size: number, before: BeforeCall, control: ValidationControl) => Promise<ValidationResult>;
}
const dependencies: LiveAnswerDependencies = { client: agentTransport, journal: agentJournal, reader: evidenceSearch, current: (options) => liveManifest.read(options), validate: validateInBatches };
export interface LiveAnswerResult { answer: CloudAnswer; tokens: number; known: boolean }
const computationText = (c: ToolComputation, citationNumbers: Map<string, number>) => `${c.inputs[0].value} ft below KB minus ${c.inputs[1].value} ft KB elevation = ${c.output.value} ft below sea level (rounded to one decimal; input sources ${c.inputs.map((i) => `[${citationNumbers.get(i.evidenceId)}]`).join(", ")}).`;
// A numbered well name in a cited document title ("Marabooka 1") is a name, not a quantity. Live Q10 was withheld because
// "Marabooka 1" put a bare 1 in a sentence citing a table without one (3 Nov 2026). Such a name is set aside from the
// sentence before the shared number check, but only as a whole word ("Marabooka 1, the" is a name): "Marabooka 16326", "Marabooka 1,6326" or
// "Marabooka 1181.9" keep their numbers, which must still be in the cited evidence. Well numbers have one to three
// digits; years, catalogue numbers and document parts ("Volume 2", "Section 12") are not names.
const NOT_NAMES = new Set(["volume", "vol", "section", "part", "chapter", "table", "figure", "fig", "appendix", "plate", "page", "top", "base",
  "phase", "stage", "zone", "unit", "sheet", "map", "line", "edition", "version", "report", "no", "number", "item", "step", "level", "run"]);
const WELL_NAME = /(?<![\w])([A-Z][A-Za-z'’]*(?:[ -][A-Z][A-Za-z'’]*)*)[ -]+(?:No\.?\s*)?(\d{1,3}[A-Za-z]?)(?!\w|[.,]\d)/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function titleNames(title: string): { name: string; number: string }[] {
  return [...title.matchAll(WELL_NAME)].map(([, name, number]) => ({ name, number }))
    .filter(({ name }) => !NOT_NAMES.has(name.split(/[ -]/).at(-1)!.toLowerCase()));
}
// A well name or page reference followed by a unit is being used as a quantity, so it stays in the sentence and is
// checked. The unit may come after any symbols, punctuation, quotes, brackets, dashes or line breaks ("Marabooka 1, ft",
// "Marabooka 1 · ft") and after up to three words, as long as no number comes first ("Marabooka 1 in ft", "measured in
// ft", "in units of ft"); compound datum units count ("mKB", "ftSS"). An apostrophe or prime is a feet mark only when no
// letter follows ("Marabooka 1's top" is a possessive), and "in" is inches only when no word or number follows
// ("Marabooka 1 in the Cooper Basin", "Marabooka 1 in 1980"). A double quote is read as punctuation, never as inches,
// because quoted well names are common.
// The guarantee this gives, whatever the phrasing: the only numbers that can ever pass without appearing in the cited
// evidence are the one-to-three-digit numbers of well names in cited titles and cited native page numbers. Every other
// number is checked, and the independent validator still judges what each statement claims.
// Catalogue identifiers in titles ("GA 147461") get no exemption: each way of setting them aside could be defeated by
// where a unit was placed, so they are checked like any other number and the one correction request asks the agent to
// leave them out (3 Nov 2026).
const UNIT_WORDS = String.raw`(?:m|ft|feet|metres?|meters?)(?:kb|rt|ss|gl|df|md|tvd|tvdss|ahd|msl|bsl|bgl)|mbsl|mbgl|mbrt|ftbsl|ft|feet|foot|inch(?:es)?|in(?!\s*[A-Za-z0-9])|mi|m|mm|cm|km|metres?|meters?|bbls?|stb|mmbbls?|mmstb|bcf|tcf|mcf|mmcf|mmscf|scf|psi[ag]?|kpa|mpa|bar|atm|deg|degf|degc|ppm|ppb|mg|kg|g|t|tonnes?|tons?|lbs?|md|darcys?|cp|cc|l|litres?|liters?|ac|acres?|ha|hrs?|h|min|s|sec|ms|days?|d|yrs?|years?|ma|ka|api|ppg|sg`;
const LETTER = String.raw`A-Za-z\u00C0-\u024F`;
const UNIT_SEPARATOR = String.raw`(?:['\u2019\u2032](?![A-Za-z])|[^${LETTER}0-9'\u2019\u2032\u2033°%])*`;
const NEAR_WORD = String.raw`(?:['\u2019]s\b|[${LETTER}][${LETTER}'\u2019]*\b)`;
const UNIT_AHEAD = String.raw`(?:${UNIT_SEPARATOR}${NEAR_WORD}){0,3}${UNIT_SEPARATOR}(?:['\u2019\u2032\u2033](?![A-Za-z])|°|%|(?:m3|ft3)(?!\w)|(?:${UNIT_WORDS})\b)`;
const UNIT_FOLLOWS = String.raw`(?!${UNIT_AHEAD})`;
export function setAsideTitleNames(text: string, titles: string[]): string {
  for (const { name, number } of titles.flatMap(titleNames)) {
    // Name and number are joined by one hyphen or by spaces with an optional "No."; a space then a hyphen is a minus sign.
    const pattern = `(?<![\\w])${name.split(/[ -]+/).map(escape).join("[\\s-]+")}(?:-|\\s+(?:No\\.?\\s*)?)${escape(number)}(?!\\w|[.,]\\d)${UNIT_FOLLOWS}`;
    text = text.replace(new RegExp(pattern, "gi"), " ");
  }
  return text;
}
// A reference to a cited native page ("on native PDF page 32", "pp. 29 and 30") is a pointer, not a quantity. It is set
// aside only when every page it names is cited, each page number is complete ("page 25.5" and "page 25,000" stay) and no
// unit follows ("page 25 ft" stays). The shared check strips page references and titles without these guards, so the
// live path never passes them to it (Grok's review, 3 Nov 2026).
const PAGE_REF = new RegExp(String.raw`\b(?:pages?|pp?\.)\s*(\d+)(?!\w|[.,]\d)(?:\s*(?:[\u2013-]|and|to)\s*(\d+)(?!\w|[.,]\d))?${UNIT_FOLLOWS}`, "gi");
export function setAsidePages(text: string, pages: number[]): string {
  const cited = new Set(pages.filter((p) => Number.isSafeInteger(p) && p > 0));
  return text.replace(PAGE_REF, (m, a: string, b?: string) => cited.has(Number(a)) && (!b || cited.has(Number(b))) ? " " : m);
}
// Every digit in a statement must be read by the shared check as part of an ordinary number, or the token that holds it
// must appear verbatim in the cited evidence. The shared reader skips a digit right after a letter, point or comma, so
// "The top is6400 ft" or "top.6400" would otherwise go unchecked, and it reads composite notations piecemeal ("6326e3",
// "1.2e-5", "10^3", "10³", "6 400", "6,5", "30.12.81", "6·326", "6'326", "10**3", "½"). Such tokens, and any digits outside
// ASCII, must therefore be quoted exactly as the evidence writes them, or the statement goes to the one correction request
// (Grok's tenth and eleventh reviews). Digit runs joined without whitespace by anything other than the plain-number comma
// and point, or a range dash, are one composite; a range such as "6412-6454" keeps two separately checked endpoints.
// The check reads lexical tokens: arithmetic written across separate tokens ("6.3 × 10", "6326 − 181.9") is two numbers,
// each checked, and whether the stated result follows is for the independent validator.
const TOKEN = String.raw`A-Za-z0-9_.,`;
const SCRIPT_DIGITS = /[A-Za-z0-9_.,]*[\u00B2\u00B3\u00B9\u2070-\u209F][A-Za-z0-9_.,\u00B2\u00B3\u00B9\u2070-\u209F]*/g;
const COMPOSITES = [
  /\d(?:[\d,]*\d)?(?:\.\d+)?[eE][+\-\u2212]?\d+/g,
  /[\d.,]*\d\s*\^\s*[+\-\u2212]?\d+/g,
  /(?<![\d.,])\d{1,3}(?: \d{3})+(?:\.\d+)?(?!\d|[.,]\d)/g,
  /\d[\d.,]*(?:[^\s\dA-Za-z.,\-\u2013\u2014\u2212]+[\d.,]*\d)+/g,
];
const PLAIN_NUMBER = /^[-\u2212]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
function verbatimIn(evidence: string, token: string): boolean {
  const t = token.replace(/\s+/g, " ").trim();
  if (!t) return true;
  return new RegExp(String.raw`(?<![${TOKEN}])${escape(t).replace(/ /g, String.raw`\s+`)}(?![A-Za-z0-9_]|[.,][A-Za-z0-9_])`, "i").test(evidence);
}
function tokenAround(s: string, at: number): { token: string; start: number; end: number } {
  let start = at, end = at + 1;
  while (start > 0 && /[A-Za-z0-9_.,]/.test(s[start - 1])) start--;
  while (end < s.length && /[A-Za-z0-9_.,]/.test(s[end])) end++;
  return { token: s.slice(start, end).replace(/[.,]+$/, ""), start, end };
}
export function liveNumberCheck(text: string, evidenceText: string, cited: { page: number; doc: string }[]): string | null {
  const plainEvidence = evidenceText.normalize("NFKC"), missing = (token: string) => `the number ${token} is not in the cited source`;
  // Superscript and subscript digits must match the evidence exactly as written, before normalisation would read "10³" as
  // "103" on either side.
  for (const m of text.matchAll(SCRIPT_DIGITS)) if (!verbatimIn(evidenceText, m[0])) return missing(m[0]);
  let sentence = text.replace(SCRIPT_DIGITS, " ").normalize("NFKC");
  sentence = setAsidePages(setAsideTitleNames(sentence, cited.map((c) => c.doc)), cited.map((c) => c.page));
  const foreign = sentence.match(/(?![0-9])\p{Nd}+/u);
  if (foreign) return missing(foreign[0]);
  for (const pattern of COMPOSITES) {
    for (const m of sentence.matchAll(pattern)) if (!verbatimIn(plainEvidence, m[0])) return missing(m[0]);
    sentence = sentence.replace(pattern, " ");
  }
  const read = new Uint8Array(sentence.length);
  for (const m of sentence.matchAll(new RegExp(NUM.source, "g"))) {
    const raw = m[0].replace(/,$/, "");
    if (!PLAIN_NUMBER.test(raw) && !verbatimIn(plainEvidence, raw)) return missing(raw);
    read.fill(1, m.index!, m.index! + m[0].length);
  }
  for (let i = 0; i < sentence.length; i++) {
    if (/[0-9]/.test(sentence[i]) && !read[i]) {
      const { token, start, end } = tokenAround(sentence, i);
      if (!verbatimIn(plainEvidence, token)) return missing(token);
      read.fill(1, start, end);
    }
  }
  // Signs are read the same way on both sides: a detached sign ("- 6144'") is a dash in the sentence and in the evidence.
  // A statement that attaches a sign the evidence writes detached ("-6144 ft") gets the one correction request, which asks
  // for the number exactly as the evidence writes it, including its sign.
  return deterministicCheck(sentence, evidenceText);
}
export const CORRECTION_NOTE = "Before this answer can be shown, every number must appear in the evidence its statement cites. Quote each number exactly as that evidence writes it, including its sign and unit, cite the evidence that contains it, or remove the statement. Return the corrected answer in the same JSON format.";
// The per-statement gate, shared by the one correction request and the final check so the two can never disagree.
function checkStatement(tools: AgentTools, sentence: { text: string; cites: string[] }): { evidence: AgentEvidence[]; citation?: string; number?: string } {
  let evidence: AgentEvidence[];
  try { evidence = tools.expand([...new Set(sentence.cites)]); } catch { return { evidence: [], citation: "it cites evidence IDs the tools did not return" }; }
  if (!evidence.some((e) => e.citation)) return { evidence, citation: "it cites no retrieved source passage" };
  const citations = evidence.flatMap((e) => e.citation ? [e.citation] : []);
  const number = liveNumberCheck(sentence.text, evidence.map((e) => e.text).join("\n"), citations.map((c) => ({ page: c.page, doc: c.doc })));
  return number ? { evidence, number } : { evidence };
}
// Answer contract v2 shows confirmed interpretations after the facts, under this label.
export const INTERPRETATION_LABEL = "**Interpretation, reasoned from the cited sources:**";
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
export function correctionFor(tools: AgentTools, answer: AgentOutput): string | null {
  if (!answer.answerable) return null;
  const problems = answer.sentences.flatMap((s, i) => { const r = checkStatement(tools, s), why = r.citation ?? r.number; return why ? [`Statement ${i + 1}: ${why}.`] : []; });
  return problems.length ? `${CORRECTION_NOTE}\n${problems.join("\n")}` : null;
}
export async function answerLive(a: CloudAnswer, context: ToolContext, before: BeforeCall, options: { deadline: number; signal?: AbortSignal }, deps = dependencies): Promise<LiveAnswerResult> {
  let tokens = 0, known = true;
  const fail = (note: string, detail: Record<string, number | string> = {}): LiveAnswerResult => {
    // Operator log: the fixed note and stage details only, never question, sentence or evidence text.
    console.warn(JSON.stringify({ m: "live answer withheld", note, ...detail }));
    a.status = "unsupported"; a.label = "Not found"; a.reason = "Validation incomplete"; a.citations = []; a.paragraphs = [`Validation incomplete, so no answer is shown. ${note}`];
    a.focus = null; a.focusBasin = null; a.highlight = []; a.hits = []; a.followUps = []; a.provenance = [];
    a.why = { terms: [], rule: "", scores: [] };
    delete a.table; delete a.images; delete a.geo; delete a.layers; delete a.analogRef; delete a.fieldRef; delete a.hypothesisRef; delete a.computations;
    a.trace = a.trace?.filter((step) => step.step !== "Computed from source evidence");
    a.validation.status = "incomplete"; a.validation.note = note; a.validation.removed = [];
    return { answer: a, tokens, known };
  };
  // The agent's cleanup runs beside validation. Nothing is shown unless it is confirmed, and every answer, withheld or
  // not, is returned only after it has settled; an unconfirmed cleanup stays in the journal for reconciliation.
  let cleanup: Promise<boolean> = Promise.resolve(true);
  const confirmed = async () => { if (!(await cleanup)) throw new AgentRunError("Agent cleanup could not be confirmed", 0, true, undefined, "Error"); };
  try {
    const tools = new AgentTools(context, deps.reader, cfg.live.agentToolCalls);
    const run = await runPromptAgent({ question: a.question, tools, client: deps.client(), journal: deps.journal, before,
      pin: { name: cfg.live.agentName, version: cfg.live.agentVersion }, deadline: options.deadline, signal: options.signal, deferCleanup: true,
      agentMs: cfg.live.agentMs, callMs: cfg.live.agentCallMs, cleanupMs: cfg.live.cleanupMs, rounds: cfg.live.agentRounds, outputTokens: cfg.live.agentOutputTokens, review: (out) => correctionFor(tools, out) });
    cleanup = run.cleanup;
    tokens += run.tokens; known = run.known;
    a.trace!.push({ step: "Wrote with the Foundry agent", detail: `Pinned agent ${cfg.live.agentName}, version ${cfg.live.agentVersion}; read-only tools used caller-scoped evidence from publication ${context.manifest.manifestVersion}.`, ms: run.ms });
    if (run.corrections) a.trace!.push({ step: "Asked the agent to correct its numbers", detail: "A first draft quoted a number its cited evidence does not contain. The agent was asked once to quote the evidence exactly; the revised answer was checked again from the start.", ms: 0 });
    // Interpretations alone are not an answer.
    if (!run.answer.answerable || !run.answer.sentences.some((s) => s.kind === "fact")) {
      await confirmed();
      a.reason = "No supported live evidence"; a.paragraphs = ["Not found in the published evidence. No supported answer was returned."]; a.validation.note = "No claims were presented.";
      return { answer: a, tokens, known };
    }
    // Facts stay all or nothing: one that fails a check withholds the whole answer. An interpretation that fails one is
    // removed and listed with the reason, and the rest of the answer is still shown. Logs carry indices, never text.
    type Candidate = { index: number; kind: AgentStatement["kind"]; text: string; evidence: AgentEvidence[] };
    const remove = (c: Pick<Candidate, "index" | "text">, why: string, detail: Record<string, string>) => {
      a.validation.removed.push({ text: c.text, why });
      console.info(JSON.stringify({ m: "live interpretation removed", sentence: c.index, ...detail }));
    };
    const candidates: Candidate[] = [];
    for (const [index, sentence] of run.answer.sentences.entries()) {
      const r = checkStatement(tools, sentence), text = sentence.text.trim();
      if (sentence.kind === "interpretation" && (r.citation || r.number)) { remove({ index, text }, `Deterministic check: ${r.citation ?? r.number}.`, { stage: "deterministic" }); continue; }
      if (r.citation) return fail("A generated statement did not cite a retrieved source.", { sentence: index });
      if (r.number) return fail("A generated statement failed the deterministic citation and number checks.", { sentence: index });
      candidates.push({ index, kind: sentence.kind, text, evidence: r.evidence });
    }
    // A required live source must back a fact: an interpretation is judged by looser rules, so it can't stand in for it.
    const uncited = (list: Candidate[]) => (context.requiredSourceIds ?? []).some((required) => !list.some((c) => c.kind === "fact" && c.evidence.some((e) => e.citation?.live?.sourceId === required)));
    if (uncited(candidates)) return fail("The required live source was not cited. Packaged evidence cannot substitute for it.");
    const dropped = a.validation.removed.length;
    a.trace!.push({ step: "Checked citations and numbers", detail: `${dropped ? `${count(dropped, "interpretation")} removed for citing evidence the tools did not return or a number its evidence lacks. Every other` : "Every generated"} statement cites retrieved evidence. Computed values carry the tool's input sources, units, formula and output.`, ms: 0 });
    const end = Math.min(options.deadline - 5_000, Date.now() + cfg.live.validationMs);
    if (end <= Date.now()) return fail("The independent validation budget was exhausted.");
    const signal = AbortSignal.any([AbortSignal.timeout(end - Date.now()), ...(options.signal ? [options.signal] : [])]);
    const claims: Claim[] = candidates.map((c) => ({ text: c.text, computed: c.evidence.some((e) => !!e.computation), interpretation: c.kind === "interpretation", evidence: c.evidence.map(({ id, label, text }) => ({ id, label, text })) }));
    const v = await abortable(deps.validate(claims, [], 3, (max) => abortable(before(max), signal), { signal, deadline: end }), signal);
    tokens += v.tokens;
    a.validation.checked = claims.length; a.validation.supported = v.verdicts.filter((r) => r.verdict === "supported").length;
    if (v.verdicts.length !== claims.length || v.verdicts.some((r, i) => r.verdict !== "supported" && candidates[i].kind === "fact")) return fail("The independent validator did not fully confirm every generated fact.");
    const kept = candidates.filter((c, i) => {
      const r = v.verdicts[i]; if (r.verdict === "supported") return true;
      remove(c, `${cfg.models.validator}: ${r.verdict === "partial" ? "only partly supported" : "not supported"}. ${r.reason}`.trim(), { stage: "validator", verdict: r.verdict });
      return false;
    });
    if (uncited(kept)) return fail("The required live source was not cited. Packaged evidence cannot substitute for it.");
    await confirmed();
    const current = await abortable(deps.current({ fresh: true, signal }), signal);
    if (!current.manifest || JSON.stringify(current.manifest) !== JSON.stringify(context.manifest)) return fail("The live publication changed during the answer. Ask again against the current publication.");
    const facts = kept.filter((c) => c.kind === "fact"), interpretations = kept.filter((c) => c.kind === "interpretation"), shown = [...facts, ...interpretations];
    const order = new Map<string, NonNullable<AgentEvidence["citation"]>>();
    for (const c of shown) for (const e of c.evidence) if (e.citation) order.set(e.citation.id, e.citation);
    a.citations = [...order.values()];
    const number = new Map(a.citations.map((c, i) => [c.id, i + 1]));
    const cited = (list: Candidate[]) => list.map((c) => `${c.text} ${[...new Set(c.evidence.flatMap((e) => e.citation ? [number.get(e.citation.id)] : []))].map((n) => `[${n}]`).join("")}`).join(" ");
    a.paragraphs = [cited(facts), ...(interpretations.length ? [`${INTERPRETATION_LABEL} ${cited(interpretations)}`] : [])];
    if (run.answer.missing.length) a.paragraphs.push("Part of the question is not covered by these sources and remains unanswered.");
    const derived = [...new Map(shown.flatMap((c) => c.evidence.filter((e) => e.computation).map((e) => [e.id, e.computation!] as const))).values()];
    // Request-local L/P aliases are useful to the model, but the public audit record must reference the actual
    // returned citation IDs so a reader can resolve every input to its native source page.
    a.computations = derived.map((c) => ({ ...c,
      inputs: c.inputs.map((input) => ({ ...input, evidenceId: tools.evidence.get(input.evidenceId)!.citation!.id })),
      sourceIds: c.sourceIds.map((id) => tools.evidence.get(id)!.citation!.id),
    }));
    for (const computation of a.computations) a.trace!.push({ step: "Computed from source evidence", detail: computationText(computation, number), ms: 0 });
    a.status = "answered"; a.label = "Retrieved"; a.reason = "Written by the pinned Foundry agent from governed evidence and independently validated";
    a.provenance = a.computations.length ? ["published", "computed"] : ["published"];
    const removed = a.validation.removed.length;
    a.validation.status = "passed"; a.validation.note = removed
      ? `Every fact and interpretation shown passed deterministic checks and the independent provenance challenge. ${count(removed, "interpretation")} the checks could not fully confirm ${removed === 1 ? "was" : "were"} removed.`
      : "Every statement passed deterministic checks and the independent provenance challenge.";
    a.trace!.push({ step: "Validated", detail: `${cfg.models.validator} confirmed ${count(facts.length, "fact")} and ${count(interpretations.length, "interpretation")} against their cited evidence; ${count(removed, "interpretation")} removed.`, ms: v.ms });
    a.geo = Object.fromEntries(a.citations.map((c) => [c.id, liveGeotags(c, context.manifest)]));
    // A question that names no basin has no focus basin, so the map follows the evidence instead, as library answers do:
    // the basin of the first cited passage that has one.
    a.focusBasin ??= a.citations.find((c) => basinById(c.basin))?.basin ?? null;
    const geotag = context.manifest.sources.find((s) => s.wellLocation && a.citations.some((c) => c.live?.sourceId === s.sourceId));
    if (geotag?.wellLocation) a.focus = { lon: geotag.wellLocation.lon, lat: geotag.wellLocation.lat, zoom: 8.2, label: wellLabel(geotag) };
    return { answer: a, tokens, known };
  } catch (e) {
    if (e instanceof CapError) throw e;
    if (e instanceof AgentRunError || e instanceof ValidationError) { tokens += e.tokens; known &&= e.known; } else known = false;
    return fail("The live agent or independent validation did not complete within the request budget. Please try again.", failureLog(e));
  } finally {
    await cleanup;
  }
}
