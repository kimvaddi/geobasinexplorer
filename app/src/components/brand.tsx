import { Sparkles } from "lucide-react";
import { BRAND } from "@brand";
import copilotAvatar from "@/assets/brand/geobasin-copilot-avatar.svg";
import favicon from "@/assets/brand/geobasin-favicon.svg";
import { cn } from "@/lib/utils";

/* GeoBasin brand art (source: /brand at the project root): the speech-bubble mark for the copilot and the tab icon. The
   header logos come from the active brand pack (src/brand), and a pack may give the copilot the neutral sparkle or an
   image of its own instead of the bubble, and bring its own tab icon. The offline build inlines every image into its
   single file. */

// A faint light edge keeps the bubble's navy top and tail readable against the dark copilot surfaces.
export function CopilotAvatar({ className }: { className?: string }) {
  const mark = BRAND.copilot?.mark;
  if (mark === "sparkle") return (
    // The pack's own blues, white sparkles, and a light edge so the circle reads on the navy copilot surfaces.
    <span aria-hidden="true" data-gbx-copilot-mark="sparkle" className={cn("grid shrink-0 select-none place-items-center rounded-full text-white ring-1 ring-white/45", className)}
      style={{ background: "linear-gradient(135deg, var(--ring), var(--brand-hover))" }}>
      <Sparkles className="size-[58%]" strokeWidth={2.1} />
    </span>
  );
  // A pack's own mark, such as the Microsoft pack's Copilot logo, is shown whole and as supplied: no circle, crop or tint.
  if (mark) return <img src={mark.src} alt="" aria-hidden="true" data-gbx-copilot-mark="image" className={cn("block shrink-0 select-none object-contain", className)} draggable={false} />;
  return <img src={copilotAvatar} alt="" aria-hidden="true" className={cn("block shrink-0 select-none [filter:drop-shadow(0_0_1px_rgba(204,251,241,0.6))]", className)} draggable={false} />;
}

/* The tab icon is set from code, because the build leaves a favicon link in index.html as a separate file that the
   single offline file could not load, whereas this import is inlined into both builds. */
export function installFavicon() {
  const icon = BRAND.favicon ?? { href: favicon, type: "image/svg+xml" };
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.head.appendChild(document.createElement("link"));
  link.rel = "icon"; link.type = icon.type; link.href = icon.href;
}
