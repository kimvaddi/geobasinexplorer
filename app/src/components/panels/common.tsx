import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PACK, TAG_CLS } from "@/lib/pack";
import { BASINS } from "@/lib/basins";
import type { AnswerLabel } from "@/lib/answer5";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

export function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <strong key={i} className="font-semibold text-foreground">{p}</strong> : <span key={i}>{p}</span>))}</>;
}
export const LABEL_CLS: Record<AnswerLabel, string> = { Precomputed: "bg-violet-700 text-white", Retrieved: "bg-sky-700 text-white", "Not found": "bg-muted text-foreground border" };
export function AnswerBadge({ label }: { label: AnswerLabel }) {
  return <Badge className={cn("shrink-0", LABEL_CLS[label])}>{label}</Badge>;
}
/* "How it's built" chip: the capability behind a panel, its service and how much is configuration. */
export function BuildChip({ cap }: { cap: string }) {
  const rows = PACK.mapping.filter((m) => m.capability === cap);
  if (!rows.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed p-2 text-xs" aria-label={`How it's built: ${cap}`}>
      <span className="font-semibold">How it's built · {cap}:</span>
      {rows.map((m) => <span key={m.service} className={cn("rounded px-1.5 py-0.5 font-medium", TAG_CLS[m.tag])}>{m.service} · {m.tag}</span>)}
    </div>
  );
}
const PASSAGES = new Map<string, { id: string; doc: string; page: number; h: string; t: string }>();
for (const b of BASINS) for (const p of b.passages) PASSAGES.set(p.id, p);
for (const p of PACK.extraPassages) PASSAGES.set(p.id, p);
export const passageById = (id: string) => GATED && LICENCE.isWithheldId(id) ? null : PASSAGES.get(id) ?? null;
export function registerPassages(list: { id: string; doc: string; page: number; h: string; t: string }[]) { for (const p of list) if (!GATED || !LICENCE.isWithheldPassage(p)) PASSAGES.set(p.id, p); }
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${n}%`);

/* Clipboard copy with a fallback for browsers that block the async API on local files. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}
