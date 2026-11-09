import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readKey, writeKey, KEYS } from "@/lib/persist";

/* Field notes kept in this browser (or in memory when the browser blocks storage for local files). */
export const NOTEBOOK = { tableName: "Notes", webUrl: "" } as const;
export const NOTEBOOK_PLACE = "your notes in this browser";
export const PAGE_SIZE = 25;
export interface NoteRow { id: string; kind: string; title: string; note: string; basin: string; lon: number | null; lat: number | null; sources: string; created: string; keyOk: boolean }
export interface NewNote { kind: "Tag" | "Answer" | "Review" | "Analog" | "Hypothesis" | "Section" | "Area"; title: string; note: string; basin: string; lon: number | null; lat: number | null; sources: string }
const readAll = () => readKey<NoteRow[]>(KEYS.notes, []);
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
export function useNotebookTable() { return useQuery({ queryKey: ["notebook-table"], staleTime: Infinity, queryFn: async () => "local" }); }
export function useNotebookRows(table: string | undefined, page: number) {
  return useQuery({ queryKey: ["notebook-rows", { table, page }], enabled: !!table, queryFn: async () => { const all = readAll(); return { rows: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), hasNext: all.length > (page + 1) * PAGE_SIZE }; } });
}
export function useAddNote(table: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (n: NewNote) => {
      if (!table) throw new Error("Notes are not ready.");
      const row: NoteRow = { id: newId(), kind: n.kind, title: n.title.slice(0, 200), note: n.note.slice(0, 4000), basin: n.basin, lon: n.lon, lat: n.lat, sources: n.sources.slice(0, 800), created: new Date().toISOString().slice(0, 16).replace("T", " "), keyOk: true };
      writeKey(KEYS.notes, [row, ...readAll()]); return row.id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notebook-rows"] }),
  });
}
export function useDeleteNote(table: string | undefined) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: async (id: string) => { if (!table) throw new Error("Notes are not ready."); writeKey(KEYS.notes, readAll().filter((r) => r.id !== id)); return id; }, onSuccess: () => qc.invalidateQueries({ queryKey: ["notebook-rows"] }) });
}
