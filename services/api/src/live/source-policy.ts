// Public migration identities only; importing this file must never construct clients or load evidence text.
// Every live source, mapped to the packaged (v1) documents its publication replaces.
export const PHASE1A_V1_DOC_IDS = {
  "ga-147461": ["cooper-report", "tegi-glossary", "cooper-references"],
  "peps-sa-marabooka-1": [
    "marabooka-1-marabooka-no-1-well-completion-report-env-4324-vols-1-2-additional-s",
    "marabooka-1-completion-report", "marabooka-1-checkshot-table-enclosure-1", "marabooka-1-velocity-chart-enclosure-2",
  ],
  // Sources cleared on 4 Nov 2026. Each guide replaces only its packaged report: the play-interval references
  // come from the _02 archives, which are not ingested, so they stay packaged. Habanero 1 has no packaged documents.
  "ga-147459": ["north-bowen-report"],
  "ga-147460": ["galilee-report"],
  "ga-147462": ["adavale-report"],
  "peps-sa-habanero-1": [],
  // Wave 1 national sources (owner request, 4 Nov 2026): Geoscience Australia documents on the 2019 national gravity
  // grids, AusAEM and the national conductivity grids, and eCat catalogue records rendered by the catalogue importer
  // (catalogue-ecat.ts). None has a packaged copy.
  "ga-144233": [], "ga-133023-points": [], "ga-145744": [], "ga-147688": [], "ga-146380": [], "ga-81486": [],
  "ga-ecat-133023": [], "ga-ecat-145744": [], "ga-ecat-147688": [], "ga-ecat-148588": [], "ga-ecat-67240": [], "ga-ecat-65388": [],
  "ga-ecat-126310": [], "ga-ecat-100520": [],
  // Wave 2 national sources (owner request to prepare, 5 Nov 2026): Honeysuckle Creek, AusAEM inversion products, isostatic
  // residual gravity, the River Murray Corridor and Lower Macquarie River AEM surveys, and the Capel and Faust basins and Lord
  // Howe Rise. None has a packaged copy.
  "ga-74123-userguide": [], "ga-74123-inversion": [], "ga-74123-fugro": [], "ga-74123-metadata": [], "ga-ecat-74123": [], "ga-ecat-65384":
  [], "ga-ecat-84308": [], "ga-132709": [], "ga-ecat-132709": [], "ga-149375": [], "ga-ecat-149375": [], "ga-145984-report": [],
  "ga-ecat-145984": [], "ga-ecat-144778": [], "ga-ecat-144775": [], "ga-ecat-144783": [], "ga-144414": [], "ga-ecat-144414": [],
  "ga-67212-fugro": [], "ga-ecat-67212": [], "ga-68792-methodology": [], "ga-68792-userguide": [], "ga-ecat-68792": [], "ga-67211-report":
  [], "ga-ecat-67211": [], "ga-74137-userguide": [], "ga-74137-inversion": [], "ga-ecat-74137": [], "ga-69470": [], "ga-ecat-69470": [],
  "ga-69190": [], "ga-ecat-69190": [], "ga-70711": [], "ga-ecat-70711": [], "ga-65704": [], "ga-ecat-65704": [], "ga-ecat-65395": [],
  "ga-ecat-65231": [], "ga-ecat-140140": [], "ga-ecat-140141": [], "ga-ecat-75582": [], "ga-112283-metadata": [], "ga-ecat-112283": [],
  "ga-ecat-123889": [], "ga-116461": [], "ga-ecat-116461": [], "ga-ecat-114642": [],
  "linz-s25000": [], "linz-s25002": [], "linz-s25009": [], "linz-g25700": [], "linz-g25702": [], "linz-g25703": [], "linz-itrf-nzgd2000": [], "icsm-gda2020-manual": [],
  "nzpam-basins-part-one": [], "nzpam-basins-part-two": [], "linz-hannah-2001": [],
} as const;
export type LiveSourceId = keyof typeof PHASE1A_V1_DOC_IDS;

// Basin of every chunk except the general TEGI glossary and acknowledgements, and the well a point geotag names.
// Habanero 1's published coordinates state no datum, so it is registered without a location and keeps a basin geotag.
// National sources cover no single basin, so their chunks are general: no basin and no basin geotag.
export interface LivePlace { basin: string | null; well: string | null }
const NATIONAL: LivePlace = { basin: null, well: null };
export const LIVE_SOURCE_PLACES: Readonly<Record<LiveSourceId, LivePlace>> = {
  "ga-147461": { basin: "cooper", well: null },
  "peps-sa-marabooka-1": { basin: "cooper", well: "Marabooka 1" },
  "ga-147459": { basin: "northbowen", well: null },
  "ga-147460": { basin: "galilee", well: null },
  "ga-147462": { basin: "adavale", well: null },
  "peps-sa-habanero-1": { basin: "cooper", well: "Habanero 1" },
  "ga-144233": NATIONAL, "ga-133023-points": NATIONAL, "ga-145744": NATIONAL, "ga-147688": NATIONAL, "ga-146380": NATIONAL, "ga-81486": NATIONAL,
  "ga-ecat-133023": NATIONAL, "ga-ecat-145744": NATIONAL, "ga-ecat-147688": NATIONAL, "ga-ecat-148588": NATIONAL, "ga-ecat-67240": NATIONAL,
  "ga-ecat-65388": NATIONAL, "ga-ecat-126310": NATIONAL, "ga-ecat-100520": NATIONAL,
  "ga-74123-userguide": NATIONAL, "ga-74123-inversion": NATIONAL, "ga-74123-fugro": NATIONAL, "ga-74123-metadata": NATIONAL,
  "ga-ecat-74123": NATIONAL, "ga-ecat-65384": NATIONAL, "ga-ecat-84308": NATIONAL, "ga-132709": NATIONAL, "ga-ecat-132709": NATIONAL,
  "ga-149375": NATIONAL, "ga-ecat-149375": NATIONAL, "ga-145984-report": NATIONAL, "ga-ecat-145984": NATIONAL, "ga-ecat-144778": NATIONAL,
  "ga-ecat-144775": NATIONAL, "ga-ecat-144783": NATIONAL, "ga-144414": NATIONAL, "ga-ecat-144414": NATIONAL, "ga-67212-fugro": NATIONAL,
  "ga-ecat-67212": NATIONAL, "ga-68792-methodology": NATIONAL, "ga-68792-userguide": NATIONAL, "ga-ecat-68792": NATIONAL, "ga-67211-report":
  NATIONAL, "ga-ecat-67211": NATIONAL, "ga-74137-userguide": NATIONAL, "ga-74137-inversion": NATIONAL, "ga-ecat-74137": NATIONAL,
  "ga-69470": NATIONAL, "ga-ecat-69470": NATIONAL, "ga-69190": NATIONAL, "ga-ecat-69190": NATIONAL, "ga-70711": NATIONAL, "ga-ecat-70711":
  NATIONAL, "ga-65704": NATIONAL, "ga-ecat-65704": NATIONAL, "ga-ecat-65395": NATIONAL, "ga-ecat-65231": NATIONAL, "ga-ecat-140140":
  NATIONAL, "ga-ecat-140141": NATIONAL, "ga-ecat-75582": NATIONAL, "ga-112283-metadata": NATIONAL, "ga-ecat-112283": NATIONAL,
  "ga-ecat-123889": NATIONAL, "ga-116461": NATIONAL, "ga-ecat-116461": NATIONAL, "ga-ecat-114642": NATIONAL,
  "linz-s25000": NATIONAL, "linz-s25002": NATIONAL, "linz-s25009": NATIONAL, "linz-g25700": NATIONAL, "linz-g25702": NATIONAL, "linz-g25703": NATIONAL, "linz-itrf-nzgd2000": NATIONAL, "icsm-gda2020-manual": NATIONAL,
  "nzpam-basins-part-one": NATIONAL, "nzpam-basins-part-two": NATIONAL, "linz-hannah-2001": NATIONAL,
};
export const livePlace = (sourceId: string) => (LIVE_SOURCE_PLACES as Readonly<Record<string, LivePlace>>)[sourceId] ?? null;

// Sources that are Geoscience Australia catalogue records, by eCat identifier. live-connect fetches and renders these
// from eCat instead of downloading a file; each is registered under the record's persistent identifier.
export const CATALOGUE_RECORDS: Readonly<Partial<Record<LiveSourceId, string>>> = {
  "ga-ecat-133023": "133023", "ga-ecat-145744": "145744", "ga-ecat-147688": "147688", "ga-ecat-148588": "148588",
  "ga-ecat-67240": "67240", "ga-ecat-65388": "65388", "ga-ecat-126310": "126310", "ga-ecat-100520": "100520",
  "ga-ecat-74123": "74123", "ga-ecat-65384": "65384", "ga-ecat-84308": "84308", "ga-ecat-132709": "132709", "ga-ecat-149375": "149375",
  "ga-ecat-145984": "145984", "ga-ecat-144778": "144778", "ga-ecat-144775": "144775", "ga-ecat-144783": "144783", "ga-ecat-144414":
  "144414", "ga-ecat-67212": "67212", "ga-ecat-68792": "68792", "ga-ecat-67211": "67211", "ga-ecat-74137": "74137", "ga-ecat-69470":
  "69470", "ga-ecat-69190": "69190", "ga-ecat-70711": "70711", "ga-ecat-65704": "65704", "ga-ecat-65395": "65395", "ga-ecat-65231": "65231",
  "ga-ecat-140140": "140140", "ga-ecat-140141": "140141", "ga-ecat-75582": "75582", "ga-ecat-112283": "112283", "ga-ecat-123889": "123889",
  "ga-ecat-116461": "116461", "ga-ecat-114642": "114642",
};

// The four TEGI packages carry byte-identical glossary and acknowledgement PDFs. Only the listed source publishes each,
// so retrieval never returns four copies of one page.
export const SHARED_ARCHIVE_MEMBERS: Readonly<Record<string, LiveSourceId>> = {
  "3965a640329f1c7782057b9ad0c890e6f09c2d9c3fd0b8d0bf2945910639860e": "ga-147461", // TEGI_Glossary.pdf
  "a24634171efefaa45e4feb4b0c5135159eaa7ee5212c9f8bd7627b0790b58cfa": "ga-147461", // TEGI Contributors - Acknowledgement - Funding.pdf
};

// Document titles for archive members that would otherwise all carry the source title.
export const MEMBER_TITLES: Readonly<Partial<Record<LiveSourceId, Readonly<Record<string, string>>>>> = {
  "peps-sa-habanero-1": {
    "HABANERO_001_01.pdf": "Habanero 1 downhole completion diagram, October 2003",
    "HABANERO_001_02.pdf": "Habanero 1 downhole completion diagram, September 2009",
    "HABANERO_001_03.pdf": "Habanero 1 well status diagram (suspended)",
    "HABANERO_001_04.pdf": "Habanero 1 well status diagram (plugged and abandoned)",
    "habanero_1_multi_finger_cali_report.pdf": "Habanero 1 multi-finger caliper survey, December 2011",
    "habanero_1_pts_23sept2005_presstemp.pdf": "Habanero 1 PTS pressure and temperature log, September 2005",
  },
};
