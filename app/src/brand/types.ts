/* A brand pack is the logos, copy and colours one deployment shows. The GeoBasin pack is the product's own look and the
   default; another pack is chosen at build time with VITE_BRAND (vite.config.ts), so only that pack reaches the bundle. */
export interface BrandLogo { src: string; alt: string; className: string }
export interface BrandPack {
  id: string;
  /* Browser tab title. */
  title: string;
  /* Tab icon; the GeoBasin icon unless a pack brings its own. */
  favicon?: { href: string; type: string };
  /* Header: logos left to right with a divider between them, an optional product name in text after another divider, an
     optional tagline, and the note on the right. */
  header: { logos: BrandLogo[]; product?: string; tagline?: string; note: { lead?: string; cloud: string; offline: string } };
  /* Optional card at the top of the first screen. */
  welcome?: { logo: BrandLogo; title: string; text: string; disclaimer: string };
  /* Cloud only: replaces the upload invitation while the service refuses uploads. */
  uploadsPaused?: string;
  /* The Exploration copilot's mark: the GeoBasin speech bubble unless a pack chooses the neutral sparkle or an image of
     its own, and an optional line under the copilot's name saying what it is built on. */
  copilot?: { mark: "sparkle" | { src: string }; builtOn?: string };
}
