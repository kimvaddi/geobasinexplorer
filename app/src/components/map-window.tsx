import { createContext, useContext, useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Move } from "lucide-react";
import { cn } from "@/lib/utils";

/* The window on the map that holds "What we know here", an area's summary or the documents tagged at a point. It opens
   where the card has always docked; drag its header or grip to move it anywhere on the map, and its left, right or
   bottom edge or a bottom corner to resize it. The grip and the corner also work with the keyboard: the arrow keys move
   or resize it by 16 px (64 with Shift), and on the corner Home gives the smallest size and End the largest that fits. A
   double-click on the header, the grip or an edge puts the window back where it docks. The page remembers the window
   (home.tsx), and it always stays inside the map. While it is dragged, its position and size are written straight to the
   element and kept when the drag ends, so the page renders once instead of at every pointer move, as resize-handle.tsx
   does for the panels. */

/* h is absent until the window is resized: it is then as tall as its content, up to the room below it. */
export interface WindowRect { x: number; y: number; w: number; h?: number }
export interface Stage { w: number; h: number; top: number }
export const WINDOW_MIN = { w: 300, h: 220 }, WINDOW_GAP = 8;
const STEP = 16, BIG_STEP = 64;
type Grab = "move" | "e" | "w" | "s" | "se" | "sw";
const CURSOR: Record<Grab, string> = { move: "move", e: "ew", w: "ew", s: "ns", se: "nwse", sw: "nesw" };

const span = (stage: Stage) => {
  const maxW = Math.max(160, stage.w - 2 * WINDOW_GAP), maxH = Math.max(120, stage.h - WINDOW_GAP - stage.top);
  return { maxW, maxH, minW: Math.min(WINDOW_MIN.w, maxW), minH: Math.min(WINDOW_MIN.h, maxH) };
};
const between = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));

/* A window remembered by the page, or null if what was stored is not one. */
export function asRect(v: unknown): WindowRect | null {
  if (!v || typeof v !== "object") return null;
  const { x, y, w, h } = v as Record<string, unknown>, ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return ok(x) && ok(y) && ok(w) && (h == null || ok(h)) ? (h == null ? { x, y, w } : { x, y, w, h }) : null;
}

/* Keeps a window inside the map: clear of its sides and bottom by WINDOW_GAP, and below the toolbar. */
export function clampRect(r: WindowRect, stage: Stage): WindowRect {
  const { maxW, minW, maxH, minH } = span(stage);
  const w = between(r.w, minW, maxW), x = between(r.x, WINDOW_GAP, stage.w - WINDOW_GAP - w);
  const h = r.h == null ? undefined : between(r.h, minH, maxH);
  const y = between(r.y, stage.top, stage.h - WINDOW_GAP - (h ?? minH));
  return h == null ? { x, y, w } : { x, y, w, h: between(h, minH, stage.h - WINDOW_GAP - y) };
}

/* The rectangle a drag of dx, dy gives from `from`; edges that are not dragged stay where they are. */
export function dragRect(grab: Grab, from: Required<WindowRect>, dx: number, dy: number, stage: Stage): WindowRect {
  const { maxW, minW, minH } = span(stage);
  if (grab === "move") return clampRect({ ...from, x: from.x + dx, y: from.y + dy }, stage);
  let { x, w, h } = from;
  if (grab === "e" || grab === "se") w = between(from.w + dx, minW, Math.min(maxW, stage.w - WINDOW_GAP - from.x));
  if (grab === "w" || grab === "sw") {
    const right = from.x + from.w;
    x = between(from.x + dx, Math.max(WINDOW_GAP, right - maxW), right - minW); w = right - x;
  }
  if (grab === "s" || grab === "se" || grab === "sw") h = between(from.h + dy, minH, stage.h - WINDOW_GAP - from.y);
  return { x, y: from.y, w, h };
}

/* The edge, corner, grip or header a press on `t` takes hold of; a header's buttons, links and fields keep their own. */
const handleOf = (t: Element): HTMLElement | null => t.closest<HTMLElement>("[data-window-edge], [data-window-grip]")
  ?? (t.closest("button, a, input, select, textarea, summary, [role=button]") ? null : t.closest<HTMLElement>("[data-window-drag]"));

const WindowContext = createContext<{ label: string; onGripKey: (e: KeyboardEvent<HTMLButtonElement>) => void } | null>(null);

/* The move grip, for a card's header. It renders nothing outside a map window. */
export function WindowGrip() {
  const win = useContext(WindowContext); if (!win) return null;
  return (
    <button type="button" data-window-grip aria-label={`Move ${win.label}`} onKeyDown={win.onGripKey}
      title="Drag to move this window, or use the arrow keys (Shift moves farther). Double-click to put it back."
      className="grid size-7 shrink-0 cursor-move touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <Move className="size-4" aria-hidden="true" />
    </button>
  );
}

export function MapWindow({ label, rect, bottomGap = WINDOW_GAP, stage, onChange, onReset, children }: {
  label: string;
  /* Where the window is now: the remembered rectangle, or where it docks, already kept inside the map. */
  rect: WindowRect;
  /* The room kept below a window that has no height of its own, which grows with its content down to there. */
  bottomGap?: number;
  stage: Stage;
  onChange: (r: WindowRect) => void; onReset: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; grab: Grab; x: number; y: number; from: Required<WindowRect>; auto: boolean; to: WindowRect; frame: number } | null>(null);
  const roomBelow = (y: number) => Math.min(stage.h - WINDOW_GAP - y, Math.max(span(stage).minH, stage.h - bottomGap - y));
  const paint = (r: WindowRect) => {
    const el = box.current; if (!el) return;
    el.style.left = `${r.x}px`; el.style.top = `${r.y}px`; el.style.width = `${r.w}px`;
    el.style.height = r.h == null ? "" : `${r.h}px`; el.style.maxHeight = r.h == null ? `${roomBelow(r.y)}px` : "";
  };
  // What the window shows now, including the height of one that still fits its content.
  const shown = (): Required<WindowRect> => ({ ...rect, h: rect.h ?? box.current?.offsetHeight ?? WINDOW_MIN.h });
  // A window that fits its content keeps doing so when it is moved or made wider or narrower; only its bottom edge,
  // a bottom corner, or the Up and Down keys give it a height of its own.
  const settle = (r: WindowRect, keepsAuto: boolean): WindowRect => (keepsAuto && rect.h == null ? { x: r.x, y: r.y, w: r.w } : r);
  const next = (d: NonNullable<typeof drag.current>, dx: number, dy: number): WindowRect => d.auto && d.grab === "move"
    ? clampRect({ x: d.from.x + dx, y: d.from.y + dy, w: d.from.w }, stage)
    : settle(dragRect(d.grab, d.from, dx, dy, stage), d.grab === "e" || d.grab === "w");
  const stop = () => {
    const d = drag.current; drag.current = null;
    if (d?.frame) cancelAnimationFrame(d.frame);
    delete document.documentElement.dataset.gbxDrag;
    return d;
  };
  // A window closed mid-drag must not leave the page in drag mode.
  useEffect(() => () => { stop(); }, []);
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    const d = stop(); if (!d) return;
    paint(d.to);
    if (d.to.x !== rect.x || d.to.y !== rect.y || d.to.w !== rect.w || d.to.h !== rect.h) onChange(d.to);
  };
  const nudge = (to: WindowRect) => { const r = clampRect(to, stage); if (r.x !== rect.x || r.y !== rect.y || r.w !== rect.w || r.h !== rect.h) onChange(r); };
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const [dx, dy] = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : [0, 0];
    if (!dx && !dy) return;
    e.preventDefault(); e.stopPropagation();
    nudge({ ...rect, x: rect.x + dx, y: rect.y + dy });
  };
  const onCornerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP, now = shown();
    const want: Required<WindowRect> | null = e.key === "ArrowLeft" ? { ...now, w: now.w - step } : e.key === "ArrowRight" ? { ...now, w: now.w + step }
      : e.key === "ArrowUp" ? { ...now, h: now.h - step } : e.key === "ArrowDown" ? { ...now, h: now.h + step }
      : e.key === "Home" ? { ...now, w: 0, h: 0 } : e.key === "End" ? { ...now, w: stage.w, h: stage.h } : null;
    if (!want) return;
    e.preventDefault(); e.stopPropagation();
    // Growing past the map's edge is limited where the window is; shrinking keeps its top-left corner.
    nudge(settle(dragRect("se", now, want.w - now.w, want.h - now.h, stage), e.key === "ArrowLeft" || e.key === "ArrowRight"));
  };
  const edge = (grab: Grab, className: string) => <div aria-hidden="true" data-window-edge={grab} className={cn("absolute z-10 touch-none", className)} />;
  return (
    <WindowContext.Provider value={{ label, onGripKey }}>
      <div ref={box} data-gbx-map-window role="group" aria-label={`${label} window`}
        className="pointer-events-auto absolute z-30 flex flex-col"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, maxHeight: rect.h == null ? roomBelow(rect.y) : undefined }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const handle = handleOf(e.target as Element); if (!handle) return;
          // A press always starts afresh, even if an earlier drag never saw its pointer released.
          if (drag.current) stop();
          const grab = (handle.dataset.windowEdge as Grab | undefined) ?? "move";
          e.preventDefault();
          // The handle itself holds the pointer, so a double-click on it is still seen as one on the handle.
          handle.setPointerCapture(e.pointerId);
          const from = shown();
          drag.current = { id: e.pointerId, grab, x: e.clientX, y: e.clientY, from, auto: rect.h == null, to: rect, frame: 0 };
          document.documentElement.dataset.gbxDrag = CURSOR[grab];
        }}
        onPointerMove={(e) => {
          const d = drag.current; if (d?.id !== e.pointerId) return;
          d.to = next(d, e.clientX - d.x, e.clientY - d.y);
          if (!d.frame) d.frame = requestAnimationFrame(() => { d.frame = 0; paint(d.to); });
        }}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onDoubleClick={(e) => { if (handleOf(e.target as Element)) onReset(); }}>
        {children}
        {edge("w", "-left-1 top-3 bottom-3 w-2 cursor-ew-resize")}
        {edge("e", "-right-1 top-3 bottom-3 w-2 cursor-ew-resize")}
        {edge("s", "-bottom-1 left-3 right-3 h-2 cursor-ns-resize")}
        {edge("sw", "-bottom-1 -left-1 size-3 cursor-nesw-resize")}
        <button type="button" data-window-edge="se" aria-label={`Resize ${label}`} onKeyDown={onCornerKey}
          title="Drag to resize this window, or use the arrow keys (Shift for bigger steps), Home for the smallest size and End for the largest. Double-click to put it back."
          className="absolute -bottom-0.5 -right-0.5 z-10 grid size-5 cursor-nwse-resize touch-none place-items-end rounded-br-xl p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true"><path d="M9 3 3 9M9 6 6 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
    </WindowContext.Provider>
  );
}
