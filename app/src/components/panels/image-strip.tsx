import { useState } from "react";
import { FileText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ImageHit, ImageOpen } from "@/lib/images";

export function ImageStrip({ images, onAsk, onOpen, label = "Images" }: { images: ImageHit[]; onAsk: (q: string) => void; onOpen: (o: ImageOpen) => void; label?: string }) {
  const [img, setImg] = useState<ImageHit | null>(null);
  if (!images.length) return null;
  return (
    <section aria-label={label} className="space-y-1">
      <h4 className="text-xs font-semibold">{label} · {images.length}</h4>
      <ul className="flex gap-2 overflow-x-auto pb-1">{images.map((im) => (
        <li key={im.id} className="w-28 shrink-0">
          <button type="button" onClick={() => setImg(im)} className="block w-full overflow-hidden rounded-md border bg-white focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open image: ${im.title}`}><img src={im.src} alt="" className="h-20 w-full object-cover" /></button>
          <p className="mt-0.5 line-clamp-2 text-[11px] font-medium leading-tight">{im.title}</p>
          <p className="line-clamp-2 text-[10px] leading-tight text-muted-foreground">{im.why}</p>
        </li>))}</ul>
      <Dialog open={!!img} onOpenChange={(o) => !o && setImg(null)}>
        <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto">
          {img && (<>
            <DialogTitle>{img.title}</DialogTitle>
            <DialogDescription>{img.caption} · {img.why}</DialogDescription>
            <img src={img.src} alt={img.title} className="w-full rounded border bg-white" />
            <div className="flex flex-wrap gap-1.5">
              {img.askAbout && <Button type="button" size="sm" variant="secondary" onClick={() => { const q = img.askAbout!; setImg(null); onAsk(q); }}><Search aria-hidden="true" /> Find text about this</Button>}
              {img.open && <Button type="button" size="sm" variant="outline" onClick={() => { const o = img.open!; setImg(null); onOpen(o); }}><FileText aria-hidden="true" /> Open in Evidence</Button>}
            </div>
          </>)}
        </DialogContent>
      </Dialog>
    </section>
  );
}
