import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "@/components/error-boundary";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { AppShortcutProvider } from "@/components/shortcut-provider";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/pages/home";
import { queryClient } from "@/lib/query-client";
import { installFavicon } from "@/components/brand";
import { BRAND } from "@brand";
import "./index.css";
import "@brand/theme.css";

/* GeoBasin Explorer AI single-file build: no network, no login, no telemetry; notes and scores stay in this browser. */
installFavicon();
document.title = BRAND.title;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          <AppShortcutProvider>
            <ConfirmDialogProvider>
              <MemoryRouter>
                <Routes>
                  <Route path="/" element={<AppShell />}>
                    <Route index element={<HomePage />} />
                  </Route>
                </Routes>
              </MemoryRouter>
            </ConfirmDialogProvider>
          </AppShortcutProvider>
        </MotionConfig>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
