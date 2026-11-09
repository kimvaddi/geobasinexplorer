import { ChevronDown, Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ASK_ROWS, LENSES, lensById, type Kpi } from "@/lib/lenses";
import type { Action, LensId } from "@/lib/track";

export function LensPicker({ lens, setLens }: { lens: LensId; setLens: (l: LensId) => void }) {
  const cur = lensById(lens);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="border-white/25 bg-brand-bar/90 text-white shadow-md hover:bg-brand-hover hover:text-white" aria-label={`Role: ${cur.title}. Change role`}>
          <Eye aria-hidden="true" /><span className="max-w-[9rem] truncate 2xl:max-w-[13rem]"><span className="hidden 2xl:inline">Role: </span>{cur.title}</span><ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Your role (same data for every role)</DropdownMenuLabel>
        {LENSES.filter((l) => !l.secondary).map((l) => <DropdownMenuItem key={l.id} onSelect={() => setLens(l.id)} className={cn("flex-col items-start gap-0", l.id === lens && "bg-muted")}><span className="font-medium">{l.title}</span><span className="text-xs text-muted-foreground">{l.who}</span></DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Secondary</DropdownMenuLabel>
        {LENSES.filter((l) => l.secondary).map((l) => <DropdownMenuItem key={l.id} onSelect={() => setLens(l.id)} className={cn("flex-col items-start gap-0", l.id === lens && "bg-muted")}><span className="font-medium">{l.title}</span><span className="text-xs text-muted-foreground">{l.who}</span></DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function LensCard({ lens, kpis, run, onAsk, onClose, maxHeight }: { lens: LensId; kpis: Kpi[]; run: (a: Action[]) => void; onAsk: (q: string) => void; onClose: () => void; maxHeight: number }) {
  const l = lensById(lens);
  return (
    <section aria-labelledby="lens-h" className="pointer-events-auto flex w-[340px] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xl" style={{ maxHeight }}>
      <header className="flex items-start gap-2 bg-brand px-3 py-2 text-white">
        <div className="min-w-0 flex-1"><p className="text-[11px] font-semibold uppercase tracking-wide text-white/75">Role{l.secondary ? " · secondary" : ""}</p><h2 id="lens-h" className="text-sm font-semibold leading-tight">{l.title}</h2></div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close the role card" className="text-white hover:bg-white/15 hover:text-white" onClick={onClose}><X aria-hidden="true" /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3 text-sm">
        <p>{l.who}</p>
        <dl className="grid grid-cols-3 gap-1.5">{kpis.map((k) => <div key={k.label} className="rounded-md border bg-muted/40 p-1.5"><dt className="text-[11px] leading-tight text-muted-foreground">{k.label}</dt><dd className="text-sm font-semibold tabular-nums leading-tight">{k.value}</dd></div>)}</dl>
        {lens === "lead" && <section aria-label="Capabilities and where to see them" className="space-y-1">
          <h3 className="text-xs font-semibold">Capabilities, and where to see each</h3>
          <ul className="space-y-1">{ASK_ROWS.map((r) => <li key={r.id}><button type="button" onClick={() => run(r.acts)} className="flex w-full items-start gap-2 rounded-md border px-2 py-1 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
            <span className="w-9 shrink-0 font-mono font-semibold">{r.id}</span><span className="flex-1"><span className="font-medium">{r.ask}</span><span className="block text-muted-foreground">{r.where}</span></span></button></li>)}</ul>
        </section>}
        <section aria-label="Start here" className="space-y-1">
          <h3 className="text-xs font-semibold">Start here</h3>
          <ul className="space-y-1">{l.actions.map((a) => <li key={a.label}><Button type="button" variant="secondary" size="sm" className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs" onClick={() => run(a.acts)}>{a.label}</Button></li>)}</ul>
        </section>
        {l.questions.length > 0 && <section aria-label="Questions to try" className="space-y-1"><h3 className="text-xs font-semibold">Questions to try</h3>
          <ul className="space-y-1">{l.questions.map((q) => <li key={q}><button type="button" className="w-full rounded-md border px-2 py-1 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onAsk(q)}>{q}</button></li>)}</ul></section>}
      </div>
    </section>
  );
}
