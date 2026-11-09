import { Fragment, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { CLOUD, cloud, type Me } from "@/lib/cloud";
import { motion } from "motion/react";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { BRAND } from "@brand";

/* App frame: the brand pack's logos and header note (src/brand), the page, and toasts. */
export function AppShell() {
  const { pathname } = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { if (CLOUD) void cloud.me().then(setMe).catch(() => setMe(null)); }, []);
  const { logos, product, tagline, note } = BRAND.header;
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#gbx-stage"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:ring-2 focus:ring-ring"
      >
        Skip to the workspace
      </a>
      <header className="flex h-14 shrink-0 items-center gap-3 bg-header px-4 text-header-foreground">
        {logos.map((l, i) => (
          <Fragment key={l.alt}>
            {i > 0 && <span className="h-8 w-px shrink-0 bg-header-foreground/20" aria-hidden="true" />}
            <img src={l.src} alt={l.alt} className={cn("block w-auto shrink-0 select-none", l.className)} draggable={false} />
          </Fragment>
        ))}
        {product && <>
          <span className="h-6 w-px shrink-0 bg-header-foreground/30" aria-hidden="true" />
          <span className="min-w-0 truncate text-lg font-semibold tracking-tight">{product}</span>
        </>}
        {tagline && <span className="hidden text-sm text-header-foreground/75 sm:inline">{tagline}</span>}
        <span className="ml-auto hidden text-xs text-header-foreground/70 md:inline">{note.lead && <><span className="font-semibold text-brand-highlight">{note.lead}</span> · </>}{CLOUD ? <>{note.cloud}{me ? <> · {me.name} · <a className="underline underline-offset-2 hover:text-header-foreground" href="/.auth/logout?post_logout_redirect_uri=/">Sign out</a></> : null}</> : note.offline}</span>
      </header>
      <main className="flex flex-1 flex-col">
        <motion.div
          key={pathname}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex flex-1 flex-col"
        >
          <Outlet />
        </motion.div>
      </main>
      <Toaster />
    </div>
  );
}

export default AppShell;
