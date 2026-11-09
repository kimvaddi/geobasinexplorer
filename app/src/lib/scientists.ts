// Version 2: "Run the agents" in the Co-Scientist workspace runs the Foundry scientists, the hosted agent
// gbx-coscientist, through the API (services/api/src/v2/cosci.ts), and shows the result in the same workspace. Every
// statement shown passed the validator and the app's own source and number check, and the person still makes the call.
import { api } from "@/lib/cloud";
import { AGENTS, entitiesIn, type AgentId, type AgentOut, type CoSciRun } from "@/lib/cosci";
import { imagesForPlays } from "@/lib/images";
import type { HDef, HItem } from "@/lib/hypothesis";

export type SquadStatus = "answered" | "not_found" | "validation_incomplete" | "blocked";
/* by lists every scientist whose cited evidence the statement uses, in the workspace's order; empty means the lead's own. */
export interface SquadStatement { kind: "fact" | "interpretation"; stance: "for" | "against" | "context"; text: string; by: string[]; sources: { id: string; label: string }[] }
/* by says who removed a statement before anyone saw it: the critic, the validator or the app's own source and number check. */
export interface SquadResult {
  status: SquadStatus; statements: SquadStatement[]; removed: { text: string; why: string; by?: "critic" | "validator" | "app" }[]; missing: string[]; dissent: string[];
  tally: { for: number; against: number; context: number; missing: number };
  scientists: { id: string; chosen: boolean; reported: number; inAnswer: number; missing: string[]; error: string | null; ms: number }[];
  checked: { judged: number; supported: number }; notes: string[]; session: string | null; ms: number | null;
}
type Poll = { status: "running"; elapsedMs: number } | { status: "failed"; error: string; elapsedMs: number } | { status: "done"; elapsedMs: number; result: SquadResult };

export const SQUAD_STATUS: Record<SquadStatus, string> = {
  answered: "Checked against the sources", not_found: "Not found", validation_incomplete: "Validation incomplete", blocked: "Blocked by the critic",
};
/* What each Foundry scientist asks, from its instructions (services/scientists/gbx_scientists/prompts.py). */
export const SQUAD_ROLE: Record<AgentId, string> = {
  literature: "What the reports, well files and surveys say", stratigraphy: "Units, ages, depths and how they relate", spatial: "Where things are, distances and analogs",
  rock: "Core, lithology, porosity and permeability", stress: "Stress regime, orientation and faults",   critic: "Reads the draft and can strike or block it",
};
const REMOVED_BY = { critic: "Critic", validator: "Validator", app: "GeoBasin source and number check" } as const;

export class SquadError extends Error {}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  const t = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); fail(new DOMException("Stopped", "AbortError")); }, { once: true });
});

/* Starts a run and polls until it ends; a run takes about a minute and a half. */
export async function runSquad(statement: string, opts: { signal: AbortSignal; onTick?: (elapsedMs: number) => void; everyMs?: number; limitMs?: number }): Promise<SquadResult> {
  const { handle } = await api<{ handle: string }>("/api/v2/cosci", { method: "POST", body: JSON.stringify({ statement }), signal: opts.signal });
  const t0 = Date.now(), every = opts.everyMs ?? 3000, limit = opts.limitMs ?? 8 * 60_000;
  for (;;) {
    await pause(every, opts.signal);
    const p = await api<Poll>("/api/v2/cosci/status", { method: "POST", body: JSON.stringify({ handle }), signal: opts.signal });
    if (p.status === "done") return p.result;
    if (p.status === "failed") throw new SquadError(p.error);
    opts.onTick?.(p.elapsedMs);
    if (Date.now() - t0 > limit) throw new SquadError("The scientists took longer than eight minutes.");
  }
}

const nameOf = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;
const item = (s: SquadStatement): HItem => ({ stance: s.stance, text: s.kind === "interpretation" ? `Interpretation: ${s.text}` : s.text,
  source: `${s.sources.map((x) => x.label).join("; ")}${s.by.length > 1 ? `. Also found by ${s.by.slice(1).map(nameOf).join(" and ")}` : ""}` });

/* The squad's result in the workspace's own shape, so it renders, saves and logs like a run of the rules. */
export function squadToRun(statement: string, prepared: HDef["id"] | null, r: SquadResult): CoSciRun {
  const entities = entitiesIn(statement);
  const agents: AgentOut[] = AGENTS.map((a) => {
    if (a.id === "critic") {
      const items: HItem[] = [
        ...r.dissent.map((text) => ({ stance: "against" as const, text, source: "Critic" })),
        ...r.missing.map((text) => ({ stance: "missing" as const, text, source: "Critic and scientists" })),
        ...r.removed.map((x) => ({ stance: "judge" as const, text: `Removed before you saw it, because ${x.why}: ${x.text}`, source: REMOVED_BY[x.by ?? "app"] })),
      ];
      if (!items.length) items.push({ stance: "context", text: "The critic passed the answer, and nothing obvious is missing.", source: "Critic" });
      return { id: a.id, items, images: [], ms: 0, note: "" };
    }
    const sc = r.scientists.find((x) => x.id === a.id);
    // Each statement appears once, under the first scientist credited with it.
    const items = r.statements.filter((s) => s.by[0] === a.id).map(item);
    const images = a.id === "rock" && sc?.chosen
      ? imagesForPlays(entities.filter((e) => e.type === "play" || e.type === "unit").map((e) => e.label), entities.map((e) => e.basin ?? "").filter(Boolean)) : [];
    const under = [...new Set(r.statements.filter((s) => s.by.includes(a.id)).map((s) => nameOf(s.by[0])))];
    const note = !sc?.chosen ? "Stood down for this statement" : sc.error ? "Could not finish its search" : items.length ? ""
      : sc.inAnswer ? `Shared ${sc.inAnswer} finding${sc.inAnswer === 1 ? "" : "s"} shown under ${under.join(" and ")}`
      : sc.reported ? `Reported ${sc.reported}, none used in the checked answer` : "Found nothing for this statement";
    return { id: a.id, items, images, ms: sc?.ms ?? 0, note };
  });
  const removed = r.removed.length, by = (who: string) => r.removed.filter((x) => (x.by ?? "app") === who).length;
  const struck = by("critic"), gated = by("app");
  return {
    statement, prepared, label: r.statements.length ? "Retrieved" : "Not found", agents, verdict: "Not judged",
    rule: `Written by the Foundry scientists.${struck ? ` The critic struck ${struck} statement${struck === 1 ? "" : "s"} it still disputed after the lead's revision.` : ""} The validator judged ${r.checked.judged} statement${r.checked.judged === 1 ? "" : "s"} and found ${r.checked.supported} supported${gated ? `, and the app's own check removed ${gated} more` : ""}. Read each finding and make the call.`,
    change: [], next: [], ms: r.ms ?? 0, entities, counts: { for: r.tally.for, against: r.tally.against, missing: r.tally.missing },
    engine: { status: r.status, label: SQUAD_STATUS[r.status], judged: r.checked.judged, supported: r.checked.supported, removed, session: r.session, tally: r.tally,
      lead: r.statements.filter((s) => !s.by.length).map(item) },
  };
}
