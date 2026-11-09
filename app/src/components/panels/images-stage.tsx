import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, ScanSearch, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BASINS } from "@/lib/basins";
import { STATUS_CLS } from "@/lib/pack";
import { GATED } from "@/lib/cloud";
import { LICENCE } from "@/lib/licensed-data";
import { allFeatures, featureOfFile, rankSimilar, type ImgItem } from "@/lib/imgsim";

/* Image search over the bundled core images: filter by basin, unit, play and depth, then find
   core that looks like a picture, including one of your own. */
export interface SimilarQuery { id: string | null; title: string; src: string; f?: Float32Array }
/* Hidden 96 x 96 buffer used only to read pixels for the look-alike match; nothing is drawn on screen. */
const pixelCtx = () => { const cv = document.getElementById("imgsim-canvas") as HTMLCanvasElement | null; return cv ? cv.getContext("2d", { willReadFrequently: true }) : null; };
export function ImagesStage(p: {
  items: ImgItem[]; topPad: number; query: SimilarQuery | null; setQuery: (q: SimilarQuery | null) => void; onSelect: (it: ImgItem) => void; sel: string | null; showBuild: boolean;
  onFeatMs?: (ms: number) => void;
}) {
  const [kind, setKind] = useState<"all" | ImgItem["kind"]>("all");
  const [basin, setBasin] = useState("all");
  const [text, setText] = useState("");
  const [feats, setFeats] = useState<Map<string, Float32Array> | null>(null);
  const [prog, setProg] = useState<[number, number] | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const needFeats = !!p.query;
  const onMs = useRef(p.onFeatMs); onMs.current = p.onFeatMs;
  const items = useMemo(() => GATED ? p.items.filter((i) => !LICENCE.isWithheldImage(i)) : p.items, [p.items]);
  useEffect(() => {
    if (!needFeats || feats) return; let live = true;
    void allFeatures(items, pixelCtx(), (n, t) => { if (live) setProg([n, t]); }).then((r) => { if (!live) return; setFeats(r.map); setMs(r.ms); setProg(null); onMs.current?.(r.ms); });
    return () => { live = false; };
  }, [needFeats, feats, items]);
  const qf = p.query?.f ?? (p.query?.id && feats ? feats.get(p.query.id) : undefined);
  const ranked = useMemo(() => (qf && feats ? rankSimilar(qf, feats, p.query?.id ?? undefined, 24) : null), [qf, feats, p.query]);
  const score = new Map(ranked?.map((r) => [r.id, r.score]) ?? []);
  const t = text.trim().toLowerCase();
  const list = (ranked ? ranked.map((r) => items.find((i) => i.id === r.id)!).filter(Boolean) : items)
    .filter((i) => (kind === "all" || i.kind === kind) && (basin === "all" || i.basin === basin) && (!t || `${i.title} ${i.sub} ${i.unit ?? ""} ${i.play ?? ""} ${i.wells.join(" ")}`.toLowerCase().includes(t)));
  const best = ranked?.[0]?.score ?? 1;
  const onFile = async (f: File | null | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    if (GATED && LICENCE.isWithheldAsset(f.name)) return;
    const { f: vec, url } = await featureOfFile(f, pixelCtx());
    p.setQuery({ id: null, title: f.name || "Your photo", src: url, f: vec });
  };
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col bg-[#F5F5FA] dark:bg-[#081B26]" style={{ top: p.topPad }}
      onPaste={(e) => { const it = [...e.clipboardData.items].find((x) => x.type.startsWith("image/")); if (it) void onFile(it.getAsFile()); }}>
      <canvas id="imgsim-canvas" width={96} height={96} className="hidden" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-2 border-b bg-background/90 px-3 py-2">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Image search <Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Real)}>Real photos</Badge><Badge className={cn("h-4 px-1.5 text-[10px]", STATUS_CLS.Computed)}>Look-alike computed</Badge></p>
          <h2 className="text-base font-semibold leading-tight">{items.length} core images from Geoscience Australia</h2>
        </div>
        <div className="ml-2 flex flex-wrap gap-1" role="group" aria-label="Image type">
          {(["all", "Photo", "Panel", "Strip"] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring", kind === k ? "border-brand bg-brand text-white" : "bg-background hover:bg-muted")}>{k === "all" ? "All" : `${k}s`}</button>)}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Basin">
          {[["all", "All basins"], ...BASINS.map((b) => [b.id, b.short] as [string, string])].map(([k, l]) => <button key={k} type="button" aria-pressed={basin === k} onClick={() => setBasin(k)} className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring", basin === k ? "border-brand bg-brand text-white" : "bg-background hover:bg-muted")}>{l}</button>)}
        </div>
        <Input aria-label="Filter by unit, play or well" placeholder="Unit, play or well" value={text} onChange={(e) => setText(e.target.value)} className="h-8 w-48 text-sm" />
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-label="Choose a core photo" onChange={(e) => void onFile(e.target.files?.[0])} />
        <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => fileRef.current?.click()}><ImagePlus aria-hidden="true" /> Use your own photo</Button>
        {p.showBuild && <span className="rounded bg-[#BAE6FD] px-1.5 py-0.5 text-xs font-medium text-[#0b2a4a]">Azure AI Search with Azure AI Vision embeddings · Configured</span>}
      </div>
      {p.query && (!GATED || !LICENCE.isWithheldImage(p.query)) && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-brand px-3 py-2 text-white" aria-live="polite">
          <img src={p.query.src} alt="" className="h-14 w-14 rounded border border-white/30 bg-white object-contain" />
          <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">Core that looks like: {p.query.title}</p>
            <p className="text-xs text-white/80">{prog ? `Reading colour and texture… ${prog[0]} of ${prog[1]} images` : `Ranked by colour and texture, computed in this browser${ms != null ? ` in ${ms} ms` : ""}. It stands in for AI image embeddings and knows nothing about geology.${p.query.id ? "" : " Your photo stays in this browser."}`}</p></div>
          <Button type="button" size="sm" variant="secondary" onClick={() => p.setQuery(null)}><X aria-hidden="true" /> Clear</Button>
        </div>)}
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-3", drag && "outline-2 outline-dashed outline-brand-highlight")}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((x) => x.kind === "file")) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void onFile(e.dataTransfer.files?.[0]); }}>
        {!p.query && <p className="mb-2 text-xs text-muted-foreground">Drop a core photo anywhere here, paste one, or use <span className="font-medium">Find core that looks like this</span> on any image.</p>}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">{list.map((it) => { const sc = score.get(it.id); return (
          <li key={it.id} className={cn("overflow-hidden rounded-lg border bg-background", p.sel === it.id && "ring-2 ring-brand-highlight")}>
            <button type="button" onClick={() => p.onSelect(it)} className="block w-full text-left focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open ${it.title}`}>
              <div className="flex h-32 items-center justify-center bg-white"><img src={it.src} alt="" loading="lazy" className="max-h-32 max-w-full object-contain" /></div>
              <div className="space-y-0.5 p-1.5"><p className="line-clamp-2 text-xs font-medium leading-tight">{it.title}</p><p className="truncate text-[11px] text-muted-foreground">{it.kind}{it.sub ? ` · ${it.sub}` : ""}</p>
                {sc != null && <div className="flex items-center gap-1.5" aria-label={`Look-alike match ${Math.round(sc * 100)}%`}><div className="h-1.5 flex-1 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(4, (sc / best) * 100)}%` }} /></div><span className="text-[11px] tabular-nums">{Math.round(sc * 100)}%</span></div>}
              </div>
            </button>
            <div className="border-t px-1.5 py-1"><button type="button" className="flex items-center gap-1 text-[11px] font-medium text-brand hover:underline dark:text-sky-200" onClick={() => p.setQuery({ id: it.id, title: it.title, src: it.src })}><ScanSearch className="size-3" aria-hidden="true" /> Find similar</button></div>
          </li>); })}</ul>
        {!list.length && <p className="text-sm text-muted-foreground">No image matches these filters.</p>}
      </div>
    </div>
  );
}
