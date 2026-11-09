import { Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmt } from "@/lib/basins";
import { STATUS_CLS } from "@/lib/pack";
import { PRESETS, type Section } from "@/lib/section";

/* Which engine measured the section, and how its count compares with the reference method the reference fixture locks
   (1.3.1 and UC5: the 260 km Cooper section with 464 boreholes within 10 km). */
function engineNote(s: Section): string {
  if (s.engine === "browser") return ` The spatial service didn't answer (${s.fallback ?? "no reason given"}), so this section was measured in the browser with the prototype's method.`;
  if (s.engine !== "gdal" || !s.versions) return "";
  let note = ` Measured with GDAL ${s.versions.gdal} and PROJ ${s.versions.proj} along the geodesic on the GRS80 ellipsoid.`;
  const r = s.reference;
  if (r && (r.boreholes !== s.boreholes.length || Math.abs(r.lengthKm - s.lengthKm) >= 0.05))
    note += ` The prototype's reference method, which the reference fixture locks, gives ${fmt(r.lengthKm, 2)} km and ${fmt(r.boreholes)} boreholes on this line. The difference comes from boreholes near the edge of the 10 km corridor, because that method follows a straight line in longitude and latitude on a sphere rather than the geodesic.`;
  else if (r) note += " The prototype's reference method gives the same result.";
  return note;
}

/* Cross-section along the line drawn on the map: basin floor from the GA depth grids, boreholes within
   10 km, faults crossed and the basins passed through. */
export function SectionSheet({ s, onClose, onPreset, onSave, onBorehole, showBuild }: { s: Section; onClose: () => void; onPreset: (id: string) => void; onSave: () => void; onBorehole: (key: string) => void; showBuild: boolean }) {
  const W = 900, H = 210, padL = 52, padR = 12, padT = 30, padB = 26;
  const maxD = Math.max(1000, Math.ceil(((s.maxDepth ?? 0) * 1.1) / 1000) * 1000, ...s.boreholes.map((b) => Math.ceil((b.td ?? 0) / 1000) * 1000));
  const x = (d: number) => padL + (d / Math.max(1, s.lengthKm)) * (W - padL - padR);
  const y = (m: number) => padT + (m / maxD) * (H - padT - padB);
  const segs: string[] = []; let cur: string[] = [];
  for (const p of s.pts) { if (p.depth == null) { if (cur.length) { segs.push(cur.join(" ")); cur = []; } continue; } cur.push(`${x(p.d).toFixed(1)},${y(p.depth).toFixed(1)}`); }
  if (cur.length) segs.push(cur.join(" "));
  const ve = ((H - padT - padB) / (maxD / 1000)) / ((W - padL - padR) / Math.max(1, s.lengthKm));
  // draw named wells within 5 km of the line, deepest first, at most 60; label up to 8 with room between labels
  const drawn = s.boreholes.filter((b) => b.name !== "Unnamed" && (b.td ?? 0) > 0 && b.off <= 5).sort((a, b) => (b.td ?? 0) - (a.td ?? 0)).slice(0, 60);
  const labelled: typeof drawn = [];
  for (const b of drawn) { if (labelled.length >= 8) break; if (labelled.every((l) => Math.abs(x(l.d) - x(b.d)) > 70)) labelled.push(b); }
  return (
    <section aria-label="Cross-section" className="pointer-events-auto w-full overflow-hidden rounded-xl border bg-card text-card-foreground shadow-2xl">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <h2 className="text-sm font-semibold">Cross-section A to B · {fmt(s.lengthKm)} km</h2>
        <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Computed)}>Computed</Badge>
        <span className="text-xs text-muted-foreground">Basin floor from GA depth grids · {s.boreholes.length} boreholes within 10 km ({drawn.length} named wells within 5 km drawn) · {s.faults.length} faults crossed · vertical exaggeration about {fmt(ve, 0)}× · {s.ms} ms{s.engine === "gdal" ? " · GDAL/PROJ" : s.engine === "browser" ? " · measured in the browser" : ""}</span>
        <div className="ml-auto flex flex-wrap gap-1">
          <label className="sr-only" htmlFor="sec-preset">Preset sections</label>
          <select id="sec-preset" className="h-7 rounded-md border bg-background px-1.5 text-xs" value="" onChange={(e) => e.target.value && onPreset(e.target.value)}>
            <option value="">Preset sections</option>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <Button type="button" size="xs" variant="outline" onClick={onSave}><Save aria-hidden="true" /> Save to notes</Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close the section" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
      </header>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-[210px] w-full bg-white" role="img" aria-label={`Profile of the basin floor along ${fmt(s.lengthKm)} km, deepest ${s.maxDepth != null ? `${fmt(s.maxDepth)} m` : "not covered by a grid"}`}>
        <defs><linearGradient id="sec-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#BAE6FD" /><stop offset="100%" stopColor="#3B2F8F" /></linearGradient></defs>
        {Array.from({ length: maxD / 1000 + 1 }, (_, i) => i * 1000).map((m) => <g key={m}><line x1={padL} x2={W - padR} y1={y(m)} y2={y(m)} stroke="#EEEDF4" /><text x={padL - 6} y={y(m) + 3} fontSize={10} fill="#62617A" textAnchor="end">{m === 0 ? "0 m" : `${fmt(m)}`}</text></g>)}
        {s.basins.map((b) => <g key={`${b.id}${b.d0}`}><rect x={x(b.d0)} y={padT - 18} width={Math.max(2, x(b.d1) - x(b.d0))} height={6} className="fill-brand" opacity={0.2} /><text x={(x(b.d0) + x(b.d1)) / 2} y={padT - 21} fontSize={10} fontWeight={700} className="fill-brand" textAnchor="middle">{b.name}</text></g>)}
        {segs.map((pts, i) => { const first = pts.split(" ")[0].split(","), last = pts.split(" ").slice(-1)[0].split(",");
          return <polygon key={i} points={`${first[0]},${y(0)} ${pts} ${last[0]},${y(0)}`} fill="url(#sec-fill)" opacity={0.85} className="stroke-brand" strokeWidth={1} />; })}
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="stroke-brand" strokeWidth={1.2} />
        {s.faults.map((f, i) => <line key={i} x1={x(f.d)} x2={x(f.d)} y1={y(0)} y2={H - padB} stroke="#C2410C" strokeDasharray="3 3" strokeWidth={1} opacity={0.7}><title>Mapped fault crossed at {fmt(f.d)} km</title></line>)}
        {drawn.map((b) => <line key={b.key} x1={x(b.d)} x2={x(b.d)} y1={y(0)} y2={y(b.td!)} stroke="#081B26" strokeWidth={1.2} opacity={0.85} className="cursor-pointer" onClick={() => onBorehole(b.key)}><title>{`${b.name}: TD ${fmt(b.td!)} m${b.year ? `, ${b.year}` : ""}, ${fmt(b.off, 1)} km from the line`}</title></line>)}
        {labelled.map((b) => <text key={`l${b.key}`} x={x(b.d)} y={Math.min(H - padB - 2, y(b.td!) + 11)} fontSize={9} fill="#081B26" textAnchor="middle">{b.name.length > 16 ? `${b.name.slice(0, 15)}…` : b.name}</text>)}
        <text x={padL} y={H - 8} fontSize={10} fontWeight={700} fill="#C2410C">A</text><text x={W - padR} y={H - 8} fontSize={10} fontWeight={700} fill="#C2410C" textAnchor="end">B</text>
        {[0.25, 0.5, 0.75].map((t) => <text key={t} x={x(s.lengthKm * t)} y={H - 8} fontSize={10} fill="#62617A" textAnchor="middle">{fmt(s.lengthKm * t)} km</text>)}
      </svg>
      <p className="border-t px-3 py-1 text-[11px] text-muted-foreground">Depth in metres below sea level. Basin floor only: the bundled packages hold no horizon grids, so formation tops are not drawn. Lines show the total depth of named wells within 5 km of the line. Red dashes mark mapped faults the line crosses.{engineNote(s)}{showBuild ? " On Microsoft: a Fabric notebook spatial query, or Esri ArcGIS profile tools." : ""}</p>
    </section>
  );
}
