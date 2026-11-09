import { useMemo, useState } from "react";
import { Download, Network, Search, ShieldAlert, Table2, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BASINS, fmt } from "@/lib/basins";
import { PACK, STATUS_CLS } from "@/lib/pack";
import { flagKey, neighbors, schema, searchNodes, slug, toTurtle, CLASS_NAME, PRED_LABEL, TYPE_COLOR, TYPE_LABEL, type KG, type NType } from "@/lib/kg";
import type { KnowledgeSub } from "@/lib/track";

const SUBS: [KnowledgeSub, string, typeof Rows3][] = [["framework", "Framework", Rows3], ["graph", "Graph", Network], ["schema", "Schema", Table2], ["curation", "Curation", ShieldAlert]];
export function KnowledgeStage(p: {
  g: KG; sub: KnowledgeSub; setSub: (s: KnowledgeSub) => void; basin: string; sel: string | null; onSelect: (id: string) => void; ccs: boolean; topPad: number;
  onFinding: (id: string, action: string, title: string) => void; findingState: Record<string, string>; onOpenReview: () => void; showBuild: boolean;
}) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => searchNodes(p.g, q), [p.g, q]);
  const download = () => {
    try {
      const blob = new Blob([toTurtle(p.g)], { type: "text/turtle" }); const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "geobasin-explorer-ai-ontology.ttl"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast.success("Ontology downloaded (Turtle)");
    } catch { toast.error("The download could not start in this browser."); }
  };
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col bg-[#F5F5FA] text-foreground dark:bg-[#081B26]" style={{ top: p.topPad }}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-background/90 px-3 py-2">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Knowledge graph <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Real)}>Real data</Badge><Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Computed)}>Links computed</Badge></p>
          <h2 className="text-base font-semibold leading-tight">Four basins as connected knowledge</h2>
        </div>
        <div className="ml-2 flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Knowledge views">
          {SUBS.map(([k, label, Icon]) => <button key={k} type="button" role="tab" aria-selected={p.sub === k} onClick={() => p.setSub(k)} className={cn("flex items-center gap-1 rounded-md px-2.5 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring", p.sub === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon className="size-4" aria-hidden="true" />{label}</button>)}
        </div>
        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Find a formation, play, basin or well" placeholder="Find a formation, play, basin or well" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-7 text-sm" />
          {hits.length > 0 && <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-lg">{hits.map((n) => (
            <li key={n.id}><button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => { p.onSelect(n.id); setQ(""); if (p.sub === "schema" || p.sub === "curation") p.setSub("graph"); }}>
              <span className="size-2.5 rounded-full border border-black/20" style={{ background: TYPE_COLOR[n.type] }} aria-hidden="true" /><span className="flex-1 truncate">{n.label}</span><span className="text-[10px] uppercase text-muted-foreground">{TYPE_LABEL[n.type]}</span></button></li>))}</ul>}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={download}><Download aria-hidden="true" /> Download ontology (Turtle)</Button>
        {p.showBuild && <span className="rounded bg-[#BAE6FD] px-1.5 py-0.5 text-xs font-medium text-[#0b2a4a]">Fabric IQ ontology · Configured</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {p.sub === "framework" && <Framework basin={p.basin} sel={p.sel} onSelect={p.onSelect} ccs={p.ccs} />}
        {p.sub === "graph" && <EgoGraph g={p.g} center={p.sel ?? `basin:${p.basin}`} onSelect={p.onSelect} />}
        {p.sub === "schema" && <Schema g={p.g} />}
        {p.sub === "curation" && <Curation onFinding={p.onFinding} state={p.findingState} onOpenReview={p.onOpenReview} />}
      </div>
    </div>
  );
}

/* ---------- framework chart (one basin package) ---------- */
const LITH: [RegExp, string][] = [[/coal/i, "#E8D68A"], [/sandstone/i, "#FBEDA0"], [/siltstone/i, "#D9C6A3"], [/mudstone|shale|claystone/i, "#C9B38E"], [/limestone|dolomite|carbonate/i, "#C3D7EE"], [/volcan|tuff/i, "#E7B8C8"], [/diamictite|glacial/i, "#C8B9AA"], [/salt|evaporite/i, "#E3E9F3"], [/granite|basement/i, "#E9C1C1"]];
const lithColor = (l: string) => LITH.find(([re]) => re.test(l))?.[1] ?? "#ECEBF5";
const PERIODS: [number, number, string, string][] = [[0, 66, "Cenozoic", "#F7D06B"], [66, 145, "Cretaceous", "#9DC183"], [145, 201.4, "Jurassic", "#5DA9D6"], [201.4, 251.9, "Triassic", "#A5658E"], [251.9, 298.9, "Permian", "#E58C5A"], [298.9, 358.9, "Carboniferous", "#6F98A8"], [358.9, 419.2, "Devonian", "#CB8C37"], [419.2, 485, "Older", "#9AA1AE"]];
const FLAG_FILL: Record<string, string> = { "shale-high": "#E8A29A", "shale-medium": "#F2C6A0", "coal-seam-gas": "#C9B3E6", "tight-gas": "#F5D88A", ccs: "#9ED3E6" };
function lanes<T extends { top: number; base: number }>(items: T[]) {
  const ends: number[] = []; const out: { it: T; lane: number }[] = [];
  for (const it of [...items].sort((a, b) => a.top - b.top || b.base - a.base)) { let l = ends.findIndex((e) => e <= it.top + 1e-6); if (l < 0) { l = ends.length; ends.push(it.base); } else ends[l] = it.base; out.push({ it, lane: l }); }
  return { out, n: Math.max(1, ends.length) };
}
function Framework({ basin, sel, onSelect, ccs }: { basin: string; sel: string | null; onSelect: (id: string) => void; ccs: boolean }) {
  const b = BASINS.find((x) => x.id === basin) ?? BASINS[0];
  const L = useMemo(() => {
    const us = b.units.filter((u) => u.top != null && u.base != null).map((u) => ({ ...u, top: u.top as number, base: u.base as number, id: `unit:${slug(u.prov)}:${slug(u.n)}` }));
    const bounds = [...new Set(us.flatMap((u) => [u.top, u.base]))].sort((x, y) => x - y);
    const ys = [44];
    for (let i = 0; i < bounds.length - 1; i++) {
      const lo = bounds[i], hi = bounds[i + 1]; const cov = us.some((u) => u.top < hi - 1e-9 && u.base > lo + 1e-9);
      ys.push(ys[i] + (cov ? Math.max(15, Math.min(64, Math.round(8 + 8.5 * Math.log2(1 + hi - lo)))) : 10));
    }
    const y = (a: number) => { if (a <= bounds[0]) return ys[0]; for (let i = 0; i < bounds.length - 1; i++) if (a <= bounds[i + 1]) return ys[i] + ((a - bounds[i]) / (bounds[i + 1] - bounds[i] || 1)) * (ys[i + 1] - ys[i]); return ys[ys.length - 1]; };
    const fm = lanes(us.filter((u) => !/group/i.test(u.rank)));
    const gr = lanes(us.filter((u) => /group/i.test(u.rank)));
    const plays = PACK.plays.filter((pl) => pl.basins.includes(b.id) && pl.top != null && pl.base != null).map((pl) => ({ ...pl, top: pl.top as number, base: pl.base as number }));
    const pl = lanes(plays);
    const hyd = new Map<string, { top: number; base: number; id: string }>();
    for (const u of us) if (u.hydro) { const h = u.hydro.replace(/"/g, ""); const e = hyd.get(h); hyd.set(h, { top: Math.min(e?.top ?? u.top, u.top), base: Math.max(e?.base ?? u.base, u.base), id: `hydro:${slug(h)}` }); }
    const provs = new Map<string, { top: number; base: number }>();
    for (const u of us) { const e = provs.get(u.prov); provs.set(u.prov, { top: Math.min(e?.top ?? u.top, u.top), base: Math.max(e?.base ?? u.base, u.base) }); }
    const flags = us.filter((u) => u.unc || (ccs && u.ccs));
    return { us, bounds, ys, y, fm, gr, pl, hyd: [...hyd.entries()], provs: [...provs.entries()], flags, H: ys[ys.length - 1] + 24 };
  }, [b, ccs]);
  const X = { age: 8, prov: 60, grp: 128, fm: 236, play: 548, hyd: 676, flag: 790, W: 920 };
  const FMW = 300, GRW = 100, PLW = 120, HYW = 106, FLW = 120;
  const box = (key: string, x: number, y0: number, w: number, h: number, fill: string, label: string, id: string | null, title: string, vertical = false) => {
    const on = id && sel === id;
    return (
      <a key={key} href={id ? `#${id}` : undefined} aria-label={id ? title : undefined} className={id ? "cursor-pointer outline-none [&:focus-visible>rect]:stroke-brand-highlight [&:focus-visible>rect]:stroke-2" : undefined}
        onClick={id ? (e) => { e.preventDefault(); onSelect(id); } : undefined}>
        <title>{title}</title>
        <rect x={x} y={y0} width={Math.max(2, w)} height={Math.max(2, h)} rx={2} fill={fill} className={on ? "stroke-brand-highlight" : "stroke-brand/35"} strokeWidth={on ? 2.5 : 0.8} />
        {h >= 11 && w >= 22 && (vertical
          ? <text x={x + w / 2} y={y0 + h / 2} fontSize={10} fontWeight={600} className="fill-brand" textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${x + w / 2} ${y0 + h / 2})`}>{label.length * 5.6 > h ? `${label.slice(0, Math.max(3, Math.floor(h / 5.6) - 1))}…` : label}</text>
          : <text x={x + w / 2} y={y0 + Math.min(h / 2, 12)} fontSize={10} fill="#133A52" textAnchor="middle" dominantBaseline="middle">{label.length * 5.3 > w - 4 ? `${label.slice(0, Math.max(2, Math.floor((w - 6) / 5.3) - 1))}…` : label}</text>)}
      </a>);
  };
  const { y } = L;
  return (
    <div className="space-y-2 p-3">
      <p className="text-sm"><span className="font-semibold">{b.name} stratigraphic framework.</span> Built from Geoscience Australia's framework and play tables (eCat {b.catalogue.ecat}). Click any box for its relationships, core images, location and source. Older units sit lower; the time axis is compressed where nothing is recorded.</p>
      <svg role="group" aria-label={`${b.name} stratigraphic framework`} viewBox={`0 0 ${X.W} ${L.H}`} className="w-full min-w-[860px] max-w-[1200px] rounded-lg border bg-white" style={{ height: L.H }}>
        <rect x={0} y={0} width={X.W} height={30} fill="#F2F2F6" />
        {([["Age (Ma)", X.age, 48], ["Province", X.prov, 64], ["Group", X.grp, GRW], ["Formation or member", X.fm, FMW], ["Play interval", X.play, PLW], ["Hydro. interval", X.hyd, HYW], [ccs ? "Resource / CCS" : "Resource flag", X.flag, FLW]] as [string, number, number][])
          .map(([t, x, w]) => <text key={t} x={x + w / 2} y={19} fontSize={11} fontWeight={700} fill="#3B3A55" textAnchor="middle">{t}</text>)}
        {PERIODS.map(([a0, a1, name, c]) => { const lo = Math.max(a0, L.bounds[0]), hi = Math.min(a1, L.bounds[L.bounds.length - 1]); if (hi <= lo) return null; const y0 = y(lo), y1 = y(hi);
          return <g key={name}><rect x={X.age + 32} y={y0} width={12} height={y1 - y0} fill={c} opacity={0.85}><title>{name}</title></rect>{y1 - y0 > 46 && <text x={X.age + 38} y={(y0 + y1) / 2} fontSize={8.5} fill="#fff" fontWeight={700} textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${X.age + 38} ${(y0 + y1) / 2})`}>{name.toUpperCase()}</text>}</g>; })}
        {L.bounds.map((a, i) => { const yy = y(a); const prev = i ? y(L.bounds[i - 1]) : -99; return yy - prev >= 13 ? <g key={a}><line x1={X.age + 46} x2={X.W - 6} y1={yy} y2={yy} stroke="#EEEDF4" /><text x={X.age + 28} y={yy + 3} fontSize={9} fill="#62617A" textAnchor="end">{fmt(a, a < 10 ? 1 : 0)}</text></g> : null; })}
        {L.provs.map(([pv, r]) => box(`p${pv}`, X.prov, y(r.top), 60, y(r.base) - y(r.top), "#EEF0F7", pv.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ Basin$/, ""), `basin:${slug(pv) === "cooper-basin" ? "cooper" : slug(pv) === "adavale-basin" ? "adavale" : slug(pv) === "galilee-basin" ? "galilee" : slug(pv) === "north-bowen-basin" ? "northbowen" : slug(pv)}`, pv, true))}
        {L.gr.out.map(({ it, lane }) => box(`g${it.id}`, X.grp + lane * (GRW / L.gr.n), y(it.top), GRW / L.gr.n - 2, y(it.base) - y(it.top), "#F2F0FA", it.n, it.id, `${it.n} (${it.rank}), ${fmt(it.top, 1)}–${fmt(it.base, 1)} Ma`, true))}
        {L.fm.out.map(({ it, lane }) => box(`f${it.id}`, X.fm + lane * (FMW / L.fm.n), y(it.top), FMW / L.fm.n - 2, y(it.base) - y(it.top), lithColor(it.lith), it.n, it.id, `${it.n}: ${it.age}, ${fmt(it.top, 1)}–${fmt(it.base, 1)} Ma. ${it.lith}`))}
        {L.pl.out.map(({ it, lane }) => box(`pl${it.id}`, X.play + lane * (PLW / L.pl.n), y(it.top), PLW / L.pl.n - 2, y(it.base) - y(it.top), "#E6F7EA", it.play, `play:${it.id}`, `${it.play} (${it.province}), ${fmt(it.top, 1)}–${fmt(it.base, 1)} Ma`))}
        {L.hyd.map(([h, r]) => box(`h${h}`, X.hyd, y(r.top), HYW, y(r.base) - y(r.top), "#D3ECF8", h, r.id, h))}
        {L.flags.map((u) => { const f = u.unc ? flagKey(u.unc) : { key: "ccs", short: "CCS", label: "CCS potential" }; const both = !!(u.unc && ccs && u.ccs);
          return <g key={`fl${u.id}`}>{box(`fb${u.id}`, X.flag, y(u.top), both ? FLW / 2 - 1 : FLW, y(u.base) - y(u.top), FLAG_FILL[f.key] ?? "#F5D88A", f.short, u.id, `${u.n}: ${f.label}. Click for the unit, its core images and where it is.`)}
            {both && box(`fc${u.id}`, X.flag + FLW / 2 + 1, y(u.top), FLW / 2 - 1, y(u.base) - y(u.top), FLAG_FILL.ccs, "CCS", u.id, `${u.n}: CCS potential (Low-carbon lens)`)}</g>; })}
        {!L.flags.length && <text x={X.flag + FLW / 2} y={60} fontSize={10} fill="#62617A" textAnchor="middle">No flags in this table</text>}
      </svg>
      <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Legend">
        {LITH.slice(0, 6).map(([re, c]) => <li key={c} className="flex items-center gap-1"><span className="size-3 rounded-sm border" style={{ background: c }} aria-hidden="true" />{re.source.split("|")[0].replace(/\\/g, "")}</li>)}
        {Object.entries(FLAG_FILL).filter(([k]) => ccs || k !== "ccs").map(([k, c]) => <li key={k} className="flex items-center gap-1"><span className="size-3 rounded-sm border" style={{ background: c }} aria-hidden="true" />{k === "ccs" ? "CCS (Low-carbon lens)" : k.replace(/-/g, " ")}</li>)}
      </ul>
    </div>
  );
}

/* ---------- ego graph around the selected item ---------- */
const ORDER: NType[] = ["basin", "unit", "play", "flag", "role", "hydro", "core", "borehole", "chart", "feature", "document", "hypothesis"];
function EgoGraph({ g, center, onSelect }: { g: KG; center: string; onSelect: (id: string) => void }) {
  const c = g.nodes.get(center) ?? g.nodes.get("basin:cooper")!;
  const nb = useMemo(() => {
    const seen = new Set<string>(); const list = neighbors(g, c.id).filter((x) => (seen.has(x.node.id) ? false : (seen.add(x.node.id), true)));
    return list.sort((a, b) => ORDER.indexOf(a.node.type) - ORDER.indexOf(b.node.type));
  }, [g, c.id]);
  const shown = nb.slice(0, 30); const W = 960, H = 640, cx = W / 2, cy = H / 2;
  const two = shown.length > 14; const pos = shown.map((x, i) => {
    const ring = two ? (i % 2) : 0; const n = shown.length; const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const r = two ? (ring ? 270 : 175) : 215; return { ...x, x: cx + Math.cos(a) * r * 1.25, y: cy + Math.sin(a) * r * 0.92, a };
  });
  return (
    <div className="relative p-3">
      <p className="mb-2 text-sm">Centred on <span className="font-semibold">{c.label}</span> ({TYPE_LABEL[c.type]}). {nb.length} direct links{nb.length > shown.length ? `, the first ${shown.length} drawn` : ""}. Click any node to move the centre. Every link comes from a table column.</p>
      <svg role="group" aria-label={`Knowledge graph around ${c.label}`} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[760px] rounded-xl border bg-brand-bar" style={{ maxHeight: "calc(100dvh - 260px)" }}>
        <defs><radialGradient id="kg-glow"><stop offset="0%" stopColor="#BAE6FD" stopOpacity="0.35" /><stop offset="100%" stopColor="#BAE6FD" stopOpacity="0" /></radialGradient>
          <clipPath id="kg-clip"><circle r={17} /></clipPath></defs>
        {pos.map((p) => <g key={`e${p.node.id}`}><line x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="rgba(207,237,253,0.38)" strokeWidth={1.2} />
          {shown.length <= 16 && <text x={(cx + p.x) / 2} y={(cy + p.y) / 2 - 4} fontSize={10} fill="rgba(207,237,253,0.75)" textAnchor="middle">{p.label}</text>}</g>)}
        <circle cx={cx} cy={cy} r={70} fill="url(#kg-glow)" />
        <g><circle cx={cx} cy={cy} r={22} fill={TYPE_COLOR[c.type]} className="stroke-brand-highlight" strokeWidth={3} />
          {c.img && <image href={c.img} x={cx - 17} y={cy - 17} width={34} height={34} preserveAspectRatio="xMidYMid slice" clipPath="url(#kg-clip)" transform={`translate(0 0)`} />}
          <text x={cx} y={cy + 40} fontSize={14} fontWeight={700} fill="#fff" textAnchor="middle">{c.label.length > 40 ? `${c.label.slice(0, 39)}…` : c.label}</text></g>
        {pos.map((p) => { const right = Math.cos(p.a) > 0.25, left = Math.cos(p.a) < -0.25; const lab = p.node.short ?? p.node.label; return (
          <a key={p.node.id} href={`#${p.node.id}`} aria-label={`${TYPE_LABEL[p.node.type]}: ${p.node.label}, ${p.label}`} className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-white [&:focus-visible>circle]:stroke-[3px]"
            onClick={(e) => { e.preventDefault(); onSelect(p.node.id); }}>
            <title>{`${TYPE_LABEL[p.node.type]}: ${p.node.label} (${p.label})`}</title>
            <circle cx={p.x} cy={p.y} r={p.node.img ? 17 : 11} fill={TYPE_COLOR[p.node.type]} stroke="rgba(7,7,28,0.9)" strokeWidth={1.5} />
            {p.node.img && <image href={p.node.img} x={p.x - 15} y={p.y - 15} width={30} height={30} preserveAspectRatio="xMidYMid slice" style={{ clipPath: "circle(15px at 15px 15px)" }} />}
            <text x={p.x + (right ? 20 : left ? -20 : 0)} y={p.y + (right || left ? 4 : 30)} fontSize={11.5} fontWeight={600} fill="#fff" textAnchor={right ? "start" : left ? "end" : "middle"} stroke="rgba(7,7,28,0.85)" strokeWidth={3} paintOrder="stroke">{lab.length > 30 ? `${lab.slice(0, 29)}…` : lab}</text>
          </a>); })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-3 text-xs" aria-label="Node types">{ORDER.map((t) => <li key={t} className="flex items-center gap-1"><span className="size-3 rounded-full border border-black/30" style={{ background: TYPE_COLOR[t] }} aria-hidden="true" />{TYPE_LABEL[t]}</li>)}</ul>
    </div>
  );
}

/* ---------- schema ---------- */
function Schema({ g }: { g: KG }) {
  const s = useMemo(() => schema(g), [g]);
  return (
    <div className="space-y-3 p-3">
      <p className="text-sm">The classes and links in this file's knowledge graph. The same classes are in the ontology download. {g.nodes.size.toLocaleString("en-US")} items and {g.edges.length.toLocaleString("en-US")} links, built in your browser from the bundled tables.</p>
      <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">{s.classes.map(([t, n]) => <li key={t} className="rounded-lg border bg-background p-2"><p className="flex items-center gap-1.5 font-mono text-xs"><span className="size-3 rounded-full border border-black/20" style={{ background: TYPE_COLOR[t] }} aria-hidden="true" />{CLASS_NAME[t]}</p><p className="text-lg font-semibold tabular-nums">{n.toLocaleString("en-US")}</p><p className="text-xs text-muted-foreground">{TYPE_LABEL[t]}</p></li>)}</ul>
      <div className="overflow-x-auto rounded-lg border bg-background"><table className="w-full text-xs"><caption className="sr-only">Relationships in the knowledge graph</caption>
        <thead className="bg-muted/60"><tr>{["From", "Relationship", "To", "Links", "Comes from"].map((h) => <th key={h} scope="col" className="px-2 py-1.5 text-left">{h}</th>)}</tr></thead>
        <tbody>{s.rels.map((r) => <tr key={`${r.from}${r.p}${r.to}`} className="border-t"><td className="px-2 py-1 font-mono">{CLASS_NAME[r.from]}</td><td className="px-2 py-1">{PRED_LABEL[r.p]}</td><td className="px-2 py-1 font-mono">{CLASS_NAME[r.to]}</td><td className="px-2 py-1 tabular-nums">{r.n.toLocaleString("en-US")}</td><td className="px-2 py-1 text-muted-foreground">{FROM[r.p]}</td></tr>)}</tbody></table></div>
    </div>
  );
}
const FROM: Record<string, string> = {
  isPartOf: "Parent column in the framework table", belongsToBasin: "Province column", mappedIn: "Which package lists the unit", assignedToPlay: "Play-interval table", hasResourceFlag: "Resource column",
  hasCcsFlag: "CCS column (Low-carbon lens)", inHydroInterval: "Hydrostratigraphy column", hasRole: "Petroleum role column", depictsUnit: "Core photo metadata", depictsPlay: "Core photo metadata",
  fromBorehole: "Core photo metadata, matched to the borehole layer by name", partOfPanel: "Core panel layout", locatedIn: "Point in the basin outline", shownOn: "Chart for the package", describes: "Document record", reportFor: "Report title", tests: "Prepared hypothesis test",
};

/* ---------- curation queue: where the GA files disagree ---------- */
function Curation({ onFinding, state, onOpenReview }: { onFinding: (id: string, action: string, title: string) => void; state: Record<string, string>; onOpenReview: () => void }) {
  const items = [
    ...PACK.checks.findings.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, title: f.title, detail: f.detail, fix: f.fix })),
    ...PACK.checks.validation.filter((v) => v.match === false).map((v, i) => ({ id: `V${i + 1}`, kind: "Report against data", severity: "low", title: v.claim, detail: `Computed from the data: ${v.computed}`, fix: "Keep both with their sources and flag for the data owner." })),
  ];
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">Places where the public files disagree. A geoscientist decides; each decision goes in the change log and the Excel export. Entity-by-entity review is in the Review workspace.</p>
        <Button type="button" size="sm" variant="outline" onClick={onOpenReview}>Open Review</Button></div>
      <ul className="grid gap-2 lg:grid-cols-2">{items.map((f) => (
        <li key={f.id} className="space-y-1 rounded-lg border bg-background p-2.5 text-sm">
          <div className="flex items-center gap-1.5 text-xs"><Badge variant="outline">{f.id}</Badge><span className="font-medium">{f.kind}</span><Badge className={cn("h-4 px-1.5 text-[10px]", f.severity === "high" ? "bg-red-700 text-white" : f.severity === "medium" ? "bg-amber-500 text-black" : "bg-muted text-foreground")}>{f.severity}</Badge>{state[f.id] && <Badge className="h-4 bg-emerald-700 px-1.5 text-[10px] text-white">{state[f.id]}</Badge>}</div>
          <p className="font-semibold">{f.title}</p><p className="text-xs">{f.detail}</p><p className="text-xs text-muted-foreground">Suggested: {f.fix}</p>
          <div className="flex flex-wrap gap-1.5">{["Accept the suggestion", "Keep both", "Reject"].map((a) => <Button key={a} type="button" size="xs" variant={state[f.id] === a ? "default" : "outline"} onClick={() => onFinding(f.id, a, f.title)}>{a}</Button>)}</div>
        </li>))}</ul>
    </div>
  );
}
