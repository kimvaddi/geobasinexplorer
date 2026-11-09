import * as XLSX from "xlsx";
import { SHEETS } from "@/lib/score";

/* Builds the scorecard workbook inside the browser (no network) and downloads it. */
export function downloadWorkbook(rows: Record<keyof typeof SHEETS, (string | number)[][]>, about: [string, string][], fileName: string) {
  const wb = XLSX.utils.book_new();
  (Object.keys(SHEETS) as (keyof typeof SHEETS)[]).forEach((name) => {
    const ws = XLSX.utils.aoa_to_sheet([[...SHEETS[name]], ...rows[name]]);
    ws["!cols"] = SHEETS[name].map((h) => ({ wch: Math.min(60, Math.max(12, h.length + 2, ...rows[name].map((r) => String(r[SHEETS[name].indexOf(h as never)] ?? "").length).slice(0, 200))) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  const ab = XLSX.utils.aoa_to_sheet([["Item", "Value"], ...about]);
  ab["!cols"] = [{ wch: 28 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, ab, "About");
  XLSX.writeFile(wb, fileName, { compression: true });
}
