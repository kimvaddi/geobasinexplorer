import { MapPin, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { NOTEBOOK_PLACE, useDeleteNote, useNotebookRows, useNotebookTable, type NoteRow } from "@/lib/notebook";

export function NotesPanel({ onShow }: { onShow: (n: NoteRow) => void }) {
  const table = useNotebookTable();
  const [page, setPage] = useState(0);
  const rows = useNotebookRows(table.data, page);
  const del = useDeleteNote(table.data);
  const list = rows.data?.rows ?? [];
  return (
    <div className="space-y-3">
      <header className="space-y-1"><h2 className="text-base font-semibold">Notes</h2><p className="text-sm">Answers, analog rationales and map tags you saved. They stay in {NOTEBOOK_PLACE}.</p></header>
      {!list.length && <p className="rounded-lg border border-dashed p-3 text-sm">Nothing saved yet. Use “Save to notes” on an answer or “Save rationale” on an analog.</p>}
      <ul className="space-y-2">{list.map((n) => (
        <li key={n.id} className="space-y-1 rounded-lg border p-2.5 text-sm">
          <div className="flex items-start justify-between gap-2"><p className="min-w-0 font-medium">{n.title}</p><Badge variant="outline">{n.kind}</Badge></div>
          <p className="whitespace-pre-line text-xs">{n.note}</p>
          {n.sources && <p className="text-xs text-muted-foreground">Sources: {n.sources}</p>}
          <div className="flex items-center justify-between gap-2"><span className="text-xs tabular-nums text-muted-foreground">{n.created}{n.basin ? ` · ${n.basin}` : ""}</span>
            <span className="flex gap-1">{n.lon != null && n.lat != null && <Button type="button" size="xs" variant="ghost" onClick={() => onShow(n)}><MapPin aria-hidden="true" /> Map</Button>}<Button type="button" size="xs" variant="ghost" aria-label={`Delete note ${n.title}`} onClick={() => del.mutate(n.id)}><Trash2 aria-hidden="true" /></Button></span>
          </div>
        </li>
      ))}</ul>
      {(page > 0 || rows.data?.hasNext) && <div className="flex justify-between"><Button type="button" size="xs" variant="outline" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>Newer</Button><Button type="button" size="xs" variant="outline" disabled={!rows.data?.hasNext} onClick={() => setPage((x) => x + 1)}>Older</Button></div>}
    </div>
  );
}
