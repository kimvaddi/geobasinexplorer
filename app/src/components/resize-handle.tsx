import { useEffect, useRef, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

const STEP = 16, BIG_STEP = 64;

/* The edge of a panel that changes its width, following the WAI-ARIA window splitter pattern. Drag it, or focus it and
   use the arrow keys (Shift for bigger steps), Home for the narrowest width and End for the widest; a double-click puts
   the default width back. While it is dragged, the width is written straight to the panel and kept when the drag ends,
   so the page renders once instead of at every pointer move. It sits inside the panel named by panelId. */
export function ResizeHandle({ panelId, label, edge, width, min, max, onResize, onReset, className, lineClassName }: {
  panelId: string; label: string;
  /* The panel edge it sits on: moving it away from the panel makes the panel wider. */
  edge: "left" | "right";
  width: number; min: number; max: number;
  onResize: (width: number) => void; onReset: () => void;
  className?: string; lineClassName?: string;
}) {
  const drag = useRef<{ id: number; x: number; from: number; to: number; frame: number } | null>(null);
  const hi = Math.max(min, max);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, min), hi));
  const setPanel = (w: number) => { const el = document.getElementById(panelId); if (el) el.style.width = `${w}px`; };
  const stop = () => {
    const d = drag.current; drag.current = null;
    if (d?.frame) cancelAnimationFrame(d.frame);
    document.documentElement.classList.remove("gbx-resizing");
    return d;
  };
  // A handle removed mid-drag (the window crossed a breakpoint) must not leave the page in drag mode.
  useEffect(() => () => { stop(); }, []);
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    delete e.currentTarget.dataset.dragging;
    const d = stop(); if (!d) return;
    // Written even when the drag ends where it began, to replace any width a frame showed on the way.
    setPanel(d.to);
    if (d.to !== d.from) onResize(d.to);
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-controls={panelId} tabIndex={0}
      aria-valuenow={width} aria-valuemin={min} aria-valuemax={hi} aria-valuetext={`${width} pixels wide`}
      title="Drag to resize. Double-click for the default width."
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = "true";
        drag.current = { id: e.pointerId, x: e.clientX, from: width, to: width, frame: 0 };
        document.documentElement.classList.add("gbx-resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current; if (d?.id !== e.pointerId) return;
        const dx = e.clientX - d.x;
        d.to = clamp(d.from + (edge === "left" ? -dx : dx));
        if (!d.frame) d.frame = requestAnimationFrame(() => { d.frame = 0; setPanel(d.to); });
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? BIG_STEP : STEP;
        const by = (dx: number) => width + (edge === "left" ? -dx : dx);
        const next = e.key === "ArrowLeft" ? by(-step) : e.key === "ArrowRight" ? by(step) : e.key === "Home" ? min : e.key === "End" ? hi : null;
        if (next == null) return;
        e.preventDefault(); e.stopPropagation();
        if (clamp(next) !== width) onResize(clamp(next));
      }}
      className={cn("group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none select-none focus-visible:outline-none", edge === "left" ? "left-0" : "-right-1.5", className)}>
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-y-0 left-0 w-0.5 transition-colors group-focus-visible:w-1", lineClassName)} />
    </div>
  );
}
