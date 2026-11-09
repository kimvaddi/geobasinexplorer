import { Database, FileBadge, Network, Monitor } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_CLS } from "@/lib/pack";
import { TYPE_LABEL, type KG } from "@/lib/kg";
import { lineage } from "@/lib/lineage";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";

const ICON = [FileBadge, Database, Network, Monitor];
/* "Where did this come from?" for any item: four steps, then governance. */
export function LineageSheet({ g, id, open, onOpenChange, showBuild }: { g: KG; id: string | null; open: boolean; onOpenChange: (v: boolean) => void; showBuild: boolean }) {
  const n = id ? g.nodes.get(id) : null;
  const blocked = GATED && !!id && LICENCE.isWithheldGraphNode(n ?? id);
  const L = n && !blocked ? lineage(g, n) : null;
  return (
    <Dialog open={open && !!n && !blocked} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-5xl overflow-y-auto">
        <DialogTitle>{`Where this came from: ${n?.label ?? ""}`}</DialogTitle>
        <DialogDescription>{n ? TYPE_LABEL[n.type] : ""}. Published record, the table it was loaded into, its place in the knowledge graph, and the screens that show it.</DialogDescription>
        {L && n && <div className="space-y-3">
          <ol className="grid gap-2 md:grid-cols-4">
            {L.steps.map((s, i) => { const Icon = ICON[i]; return (
              <li key={s.n} className="relative space-y-1 rounded-lg border bg-muted/30 p-2.5 text-xs">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" aria-hidden="true" />{s.n} · {s.title}</p>
                {s.lines.map((l, j) => <p key={j} className={cn(j === 0 && "font-medium text-foreground")}>{l}</p>)}
                {showBuild && <p className="mt-1 rounded-md border border-dashed border-sky-700/60 bg-sky-50 px-1.5 py-1 text-[11px] text-sky-950 dark:bg-sky-950/40 dark:text-sky-100">On Microsoft: {s.product}</p>}
              </li>); })}
          </ol>
          <section aria-label="Governance" className="grid gap-2 md:grid-cols-3">
            <div className="space-y-1 rounded-lg border p-2.5 text-xs"><p className="flex items-center gap-1.5 font-semibold">Licence and credit <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Real)}>Real</Badge></p><p>{L.gov.licence}</p><p className="text-muted-foreground">{L.gov.attribution}</p><p className="text-muted-foreground">The credit travels with answers and with the Excel export.</p></div>
            <div className="space-y-1 rounded-lg border p-2.5 text-xs"><p className="flex items-center gap-1.5 font-semibold">Sensitivity label and OSDU kind <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Proposed)}>Proposed</Badge></p>
              <p>Label: <span className="font-medium">{L.gov.label}</span>, from the source licence</p><p className="font-mono text-[11px]">{L.gov.osdu}</p><p className="text-muted-foreground">{L.gov.osduNote}</p>
              {showBuild && <p className="text-sky-900 dark:text-sky-200">On Microsoft: Microsoft Purview sensitivity labels; Azure Data Manager for Energy for OSDU kinds.</p>}</div>
            <div className="space-y-1 rounded-lg border p-2.5 text-xs"><p className="flex items-center gap-1.5 font-semibold">How it would stay in sync <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Proposed)}>Proposed</Badge></p><p>{L.gov.sync}</p>
              {showBuild && <p className="text-sky-900 dark:text-sky-200">On Microsoft: Microsoft Purview lineage on Fabric pipelines.</p>}</div>
          </section>
          <p className="text-xs text-muted-foreground">Steps 1 to 4 describe how this file was built. Labels, OSDU kinds and sync rules are a proposed design: no label service runs in this file.</p>
        </div>}
      </DialogContent>
    </Dialog>
  );
}
