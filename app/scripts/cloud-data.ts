import fs from "node:fs";
import path from "node:path";
import { createLicenceGate } from "../src/lib/licence";
import type { Pack as AppPack } from "../src/lib/pack";
import type { Pack as LowcarbonPack } from "../src/lib/lowcarbon";

/* Build-time only. Both targets use this exact projection; the original packs remain available to offline builds. */
export function prepareCloudData(src: string) {
  const appFile = path.join(src, "data/app-pack.json"), lowcarbonFile = path.join(src, "data/lowcarbon-pack.json");
  const app = JSON.parse(fs.readFileSync(appFile, "utf8")) as AppPack;
  const lowcarbon = JSON.parse(fs.readFileSync(lowcarbonFile, "utf8")) as LowcarbonPack;
  const gate = createLicenceGate(app, lowcarbon);
  const retainedApp = { ...gate.cloudAppPack(app), withheldProvenance: gate.metadata() };
  const retainedLowcarbon = gate.cloudLowcarbonPack(lowcarbon);
  return {
    gate, app: retainedApp, lowcarbon: retainedLowcarbon,
    packs: new Map([[appFile, JSON.stringify(retainedApp)], [lowcarbonFile, JSON.stringify(retainedLowcarbon)]]),
  };
}
