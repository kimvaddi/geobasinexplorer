import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LENSES } from "@/lib/lenses";
import type { LensId } from "@/lib/track";
import { BRAND } from "@brand";

/* First screen: pick a role. Same data for everyone; the role sets the starting view and the questions to try. */
export function RolePicker({ open, onPick, onTrack, onClose }: { open: boolean; onPick: (id: LensId, q?: string) => void; onTrack: () => void; onClose: () => void }) {
  const main = LENSES.filter((l) => !l.secondary); const sec = LENSES.filter((l) => l.secondary);
  const welcome = BRAND.welcome;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[94dvh] max-w-3xl overflow-y-auto">
        {welcome && <div className="mr-8 flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 sm:flex-nowrap">
          <img src={welcome.logo.src} alt={welcome.logo.alt} className={cn("block w-auto shrink-0 select-none", welcome.logo.className)} draggable={false} />
          <div className="min-w-0 flex-1 space-y-0.5 sm:border-l sm:pl-3">
            <p className="text-sm font-semibold text-brand-highlight">{welcome.title}</p>
            <p className="text-sm">{welcome.text}</p>
            <p className="text-xs text-muted-foreground">{welcome.disclaimer}</p>
          </div>
        </div>}
        <DialogTitle>Who's exploring today?</DialogTitle>
        <DialogDescription>Same public data for everyone. Your role sets where you start and the questions to try. You can switch at any time.</DialogDescription>
        <ul className="grid gap-2 sm:grid-cols-2">
          {main.map((l) => (
            <li key={l.id} className={cn("flex flex-col gap-2 rounded-xl border p-3", l.id === "geo" && "border-brand ring-1 ring-brand")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="text-sm font-semibold leading-tight">{l.title}{l.id === "geo" && <span className="ml-1.5 rounded bg-brand px-1.5 py-0.5 align-middle text-[10px] font-semibold text-white">Default</span>}</p>
                  <p className="text-xs text-muted-foreground">{l.who}</p></div>
                <Button type="button" size="sm" variant={l.id === "geo" ? "default" : "secondary"} className="shrink-0" aria-label={`Start as ${l.title}`} onClick={() => onPick(l.id)}>Start</Button>
              </div>
              <ul className="space-y-1">{l.questions.slice(0, 2).map((q) => <li key={q}><button type="button" className="w-full rounded-md border px-2 py-1 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onPick(l.id, q)}>{q}</button></li>)}</ul>
            </li>))}
          {sec.map((l) => (
            <li key={l.id} className="flex items-start justify-between gap-2 rounded-xl border border-dashed p-3">
              <div className="min-w-0"><p className="text-sm font-semibold leading-tight">{l.title}</p><p className="text-xs text-muted-foreground">{l.who} Off by default.</p></div>
              <Button type="button" size="sm" variant="outline" className="shrink-0" aria-label={`Start as ${l.title}`} onClick={() => onPick(l.id)}>Start</Button>
            </li>))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">New here? The guided tour takes about 60 minutes.</p>
          <Button type="button" size="sm" variant="outline" onClick={onTrack}><Play className="text-brand-highlight" aria-hidden="true" /> Start the guided tour</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
