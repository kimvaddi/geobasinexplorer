import { PACK, type Play5 } from "@/lib/pack";

/* Analog ranking: deterministic similarity on attributes tabulated in the GA play-interval tables.
   A setting or rock type missing on either side is left out of the score, and the coverage says so.
   Resource flags count when one side has them: no flag is a recorded value. */
export type Crit = "age" | "env" | "lith" | "res" | "roles";
export const CRITERIA: { id: Crit; label: string; hint: string }[] = [
  { id: "age", label: "Age", hint: "Full marks when the shorter age range sits inside the other. Half marks when they only touch. Zero at 40 Myr apart." },
  { id: "env", label: "Depositional environment", hint: "Shared depositional settings" },
  { id: "lith", label: "Lithology", hint: "Shared rock types" },
  { id: "res", label: "Resource type", hint: "Tight gas, shale and coal seam gas flags" },
  { id: "roles", label: "Petroleum roles", hint: "Reservoir, seal or source, where recorded" },
];
export type Weights = Record<Crit, number>;
export const DEFAULT_WEIGHTS: Weights = { age: PACK.weights.age ?? 30, env: PACK.weights.env ?? 30, lith: PACK.weights.lith ?? 20, res: PACK.weights.res ?? 10, roles: PACK.weights.roles ?? 10 };
const jacc = (a: string[], b: string[]) => { if (!a.length && !b.length) return null; const A = new Set(a), Bs = new Set(b); let i = 0; for (const x of A) if (Bs.has(x)) i++; return i / new Set([...a, ...b]).size; };
const jaccBoth = (a: string[], b: string[]) => (!a.length || !b.length ? null : jacc(a, b));
/* Overlap as a share of the shorter range: 1 when it sits inside the other, 0.5 when they touch, falling to 0 at 40 Myr apart. */
export function ageScore(a: Play5, b: Play5) {
  if (a.top == null || b.top == null || a.base == null || b.base == null) return null;
  const ov = Math.min(a.base, b.base) - Math.max(a.top, b.top);
  const shorter = Math.max(0.1, Math.min(a.base - a.top, b.base - b.top));
  return ov >= 0 ? 0.5 + 0.5 * Math.min(1, ov / shorter) : 0.5 * Math.max(0, 1 + ov / 40);
}
export interface Ranked { play: Play5; score: number; coverage: number; parts: Record<Crit, number | null>; shared: Record<"env" | "lith" | "res" | "roles", string[]>; overlapMyr: number | null }
export function rank(ref: Play5, w: Weights, sameProvince = false): Ranked[] {
  const total = Object.values(w).reduce((s, x) => s + x, 0) || 1;
  return PACK.plays.filter((p) => p.id !== ref.id && (sameProvince || p.province !== ref.province)).map((p) => {
    const parts: Record<Crit, number | null> = { age: ageScore(ref, p), env: jaccBoth(ref.env, p.env), lith: jaccBoth(ref.lith, p.lith), res: jacc(ref.res, p.res), roles: !ref.roles.length || !p.roles.length ? null : jacc(ref.roles, p.roles) };
    let tw = 0, s = 0;
    (Object.keys(parts) as Crit[]).forEach((k) => { const v = parts[k]; if (v != null) { tw += w[k]; s += w[k] * v; } });
    const ov = ref.top != null && p.top != null && ref.base != null && p.base != null ? Math.min(ref.base, p.base) - Math.max(ref.top, p.top) : null;
    return { play: p, score: tw ? Math.round((1000 * s) / tw) / 10 : 0, coverage: Math.round((100 * tw) / total), parts, overlapMyr: ov,
      shared: { env: ref.env.filter((x) => p.env.includes(x)), lith: ref.lith.filter((x) => p.lith.includes(x)), res: ref.res.filter((x) => p.res.includes(x)), roles: ref.roles.filter((x) => p.roles.includes(x)) } };
  }).sort((x, y) => y.score - x.score);
}
export function rationale(ref: Play5, r: Ranked): string[] {
  const p = r.play; const out: string[] = [];
  const ages = `${ref.top}–${ref.base} Ma and ${p.top}–${p.base} Ma`;
  if (r.overlapMyr != null) out.push(r.overlapMyr >= 1 ? `Age: the ranges share ${r.overlapMyr.toFixed(1)} Myr (${ages}).` : r.overlapMyr >= 0 ? `Age: the ranges only touch at a stage boundary (${ages}), so age earns half marks.` : `Age: the ranges are ${(-r.overlapMyr).toFixed(1)} Myr apart (${ages}).`);
  if (r.parts.env == null) out.push(`Setting: not recorded for ${!ref.env.length ? "the reference play" : "this play"}, so not scored.`);
  else out.push(r.shared.env.length ? `Shared settings: ${r.shared.env.join(", ")}.` : `No shared setting (${ref.env.join(", ")} against ${p.env.join(", ")}).`);
  if (r.parts.lith == null) out.push(`Rock type: not recorded for ${!ref.lith.length ? "the reference play" : "this play"}, so not scored.`);
  else out.push(r.shared.lith.length ? `Shared rock types: ${r.shared.lith.join(", ")}.` : `No shared rock types (${ref.lith.join(", ")} against ${p.lith.join(", ")}).`);
  if (r.parts.res == null) out.push("Resource type: no flags recorded for either play.");
  else out.push(r.shared.res.length ? `Shared resource flags: ${r.shared.res.join(", ")}.` : `Resource flags differ (${ref.res.join(", ") || "none"} against ${p.res.join(", ") || "none"}).`);
  if (r.parts.roles == null) out.push(`Petroleum roles: not recorded for ${!ref.roles.length ? "the reference play" : "this play"} in the public table, so not scored.`);
  return out;
}
export const playById = (id: string) => PACK.plays.find((p) => p.id === id) ?? null;
