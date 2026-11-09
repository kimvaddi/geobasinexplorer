import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cloudLicencePlugin } from "./scripts/cloud-licence";

// Offline (default): everything is inlined (images, fonts, data) so the build folds into one offline HTML file;
// scripts/inline-single-file.mjs runs after `vite build` and writes dist/geobasin-explorer-ai.html.
// Cloud (`--mode cloud`): served by the GeoBasin service on Azure, so assets stay as separate cacheable files, and the
// Azure Maps SDK is a separate file that loads only with the map (the offline build never includes it).
// VITE_BRAND picks the brand pack in src/brand (GeoBasin by default), so no other pack's logos or copy reach the bundle.
// This edition carries only sources whose reuse terms allow redistribution, so the source licence gate is always on.
export default defineConfig(({ mode }) => {
  const cloud = mode === "cloud";
  const packs = fs.readdirSync(new URL("./src/brand", import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const brand = process.env.VITE_BRAND || "geobasin";
  if (!packs.includes(brand)) throw new Error(`Unknown brand pack "${brand}". Choose one of: ${packs.join(", ")}.`);
  return {
    base: cloud ? "/" : "./",
    plugins: [cloudLicencePlugin(), react(), tailwindcss()],
    resolve: {
      alias: {
        "@brand": fileURLToPath(new URL(`./src/brand/${brand}`, import.meta.url)),
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      outDir: cloud ? "dist-cloud" : "dist",
      emptyOutDir: true,
      assetsInlineLimit: cloud ? 4096 : 100_000_000,
      cssCodeSplit: false,
      modulePreload: false,
      chunkSizeWarningLimit: 100_000,
      rollupOptions: { output: { inlineDynamicImports: !cloud } },
    },
  };
});
