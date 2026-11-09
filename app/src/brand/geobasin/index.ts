import logoOnDark from "@/assets/brand/geobasin-logo-on-dark.svg";
import type { BrandPack } from "../types";

export const BRAND: BrandPack = {
  id: "geobasin",
  title: "GeoBasin Explorer AI",
  header: {
    logos: [{ src: logoOnDark, alt: "GeoBasin Explorer AI", className: "h-10" }],
    tagline: "Geoscience AI on public basin data",
    note: { cloud: "Public data only · internal testers only", offline: "Public data only · works offline" },
  },
};
