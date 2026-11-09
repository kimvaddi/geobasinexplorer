/* Learning loop: reviewers' thumbs up or down on an answer change how sources rank for similar
   questions in this browser. Simple, visible rules:
   - Up: each cited passage ranks higher (x1.4) for questions that share two or more search terms.
   - Down, "Wrong source": each cited passage ranks lower (x0.35) for those questions.
   - Other reasons are logged for the team; prepared answers use fixed rules, so they don't re-rank. */
export type Vote = "up" | "down";
export type Reason = "Right source" | "Wrong source" | "Missing facts" | "Wrong place" | "Other";
export const DOWN_REASONS: Reason[] = ["Wrong source", "Missing facts", "Wrong place", "Other"];
export interface Feedback { id: string; at: string; by: string; q: string; terms: string[]; vote: Vote; reason: Reason; passages: string[]; label: string; effect: string }
export const UP = 1.4, DOWN = 0.35;
let STORE: Feedback[] = [];
export function setFeedbackStore(list: Feedback[]) { STORE = list; }
export function feedbackCount() { return STORE.length; }
/* An entry applies to a new question when they share two or more search terms (one if the old question had one). */
export function applies(f: Feedback, terms: string[]) {
  const need = Math.min(2, f.terms.length); if (!need) return false;
  let n = 0; for (const t of terms) if (f.terms.includes(t)) n++;
  return n >= need;
}
export function factorFor(passageId: string, terms: string[]): { factor: number; n: number } {
  let factor = 1, n = 0;
  for (const f of STORE) {
    if (!f.passages.includes(passageId) || !applies(f, terms)) continue;
    if (f.vote === "up") { factor *= UP; n++; }
    else if (f.reason === "Wrong source") { factor *= DOWN; n++; }
  }
  return { factor, n };
}
/* Searchable passages only: datasets, extracted values and prepared rules are not re-ranked. */
export const rankable = (id: string) => !/^ds:/.test(id) && !/^(innamincka-1|marabooka-1):/.test(id);
export function effectText(vote: Vote, reason: Reason, label: string, passages: string[]): string {
  const n = passages.filter(rankable).length; const s = n === 1 ? "" : "s";
  if (vote === "up") return n && label === "Retrieved" ? `Thanks. ${n} source${s} will rank higher for similar questions in this browser.` : "Thanks. Logged as a good answer.";
  if (reason === "Wrong source") return n && label === "Retrieved" ? `${n} source${s} will rank lower for similar questions. Ask again to see the change.` : "Logged for the team. This answer comes from a fixed rule, so fixing it means changing the rule.";
  if (reason === "Missing facts") return "Logged as a gap. Add the question to Evaluate to track it.";
  if (reason === "Wrong place") return "Logged. Map places come from names in the text, so the team checks the place rules.";
  return "Logged for the team.";
}
