import { MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_CLS } from "@/lib/pack";
import { passageById } from "@/components/panels/common";
import type { DocPoint } from "@/lib/doctags";
import { WindowGrip } from "@/components/map-window";

/* Documents placed at one spot on the tagged documents layer. */
export function DocsHereCard({ pt, onClose, onAsk }: { pt: DocPoint; onClose: () => void; onAsk: (q: string) => void }) {
  const items = pt.passages.map((id) => passageById(id)).filter((x): x is NonNullable<typeof x> => !!x);
  return (
    <section aria-label={`Documents tagged at ${pt.label}`} className="pointer-events-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl">
      <header data-window-drag className="flex items-start gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1"><p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tagged documents <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Computed)}>Computed</Badge></p>
          <h2 className="text-sm font-semibold">{pt.label} · {pt.n} passage{pt.n === 1 ? "" : "s"}</h2>
          <p className="text-xs text-muted-foreground">{Math.abs(pt.lat).toFixed(3)}°S {pt.lon.toFixed(3)}°E (GDA94) · {pt.how}</p></div>
        <div className="flex shrink-0 items-center gap-0.5"><WindowGrip /><Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></Button></div>
      </header>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3 text-xs">{items.slice(0, 25).map((p) => <li key={p.id} className="rounded-md bg-muted/50 px-2 py-1.5"><p className="font-medium">{p.doc}{p.page ? ` · p. ${p.page}` : ""} <span className="font-normal text-muted-foreground">{p.h}</span></p><p className="line-clamp-3">{p.t}</p></li>)}</ul>
      <footer className="shrink-0 border-t px-3 py-2"><Button type="button" size="xs" variant="secondary" onClick={() => onAsk(`Tell me about ${pt.label}`)}><MessageSquare aria-hidden="true" /> Ask about {pt.label}</Button></footer>
    </section>
  );
}
