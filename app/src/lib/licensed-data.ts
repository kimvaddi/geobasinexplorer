import appRaw from "@/data/app-pack.json?raw";
import lowcarbonRaw from "@/data/lowcarbon-pack.json?raw";
import { createLicenceGate } from "./licence";
import { GATED } from "./cloud";
import type { Pack as AppPack } from "./pack";
import type { Pack as LowcarbonPack } from "./lowcarbon";

const app = JSON.parse(appRaw) as AppPack;
const lowcarbon = JSON.parse(lowcarbonRaw) as LowcarbonPack;
export const LICENCE = createLicenceGate(app, lowcarbon);
export const APP_DATA = GATED ? LICENCE.cloudAppPack(app) : app;
export const LOWCARBON_DATA = GATED ? LICENCE.cloudLowcarbonPack(lowcarbon) : lowcarbon;
