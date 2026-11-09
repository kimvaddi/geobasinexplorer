import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { prepareCloudData } from "./cloud-data";

/* Hiding controls alone would still distribute the embedded scans and sample PDF. Cloud builds must
   remove those bytes before Vite sees the raw packs or emits their assets. Offline builds never use this plugin. */
export function cloudLicencePlugin(): Plugin {
  const { gate, packs } = prepareCloudData(fileURLToPath(new URL("../src", import.meta.url)));
  return {
    name: "cloud-source-licences", enforce: "pre",
    load(id) {
      const file = id.split("?")[0];
      const json = packs.get(file);
      if (json) return id.endsWith("?raw") ? `export default ${JSON.stringify(json)};` : json;
      if (/\.(?:webp|png|jpe?g|tiff?|pdf)(?:\?|$)/i.test(id) && gate.isWithheldAsset(file)) return 'export default "";';
      return null;
    },
  };
}
