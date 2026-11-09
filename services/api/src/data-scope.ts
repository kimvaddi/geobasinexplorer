// One deployment's question and token counts, reviews and feedback, kept apart from another deployment's in the same
// storage account. The main app has no scope; a second site, such as a demonstration site, runs with GBX_DATA_SCOPE=demo.
// OCR pages, uploads, evaluation runs and Esri tiles are allowances of one account, so every deployment shares them.

/* A scope becomes part of table names, which must be letters and digits, so it is kept to a short lower-case word. */
export function parseDataScope(value = ""): string {
  const scope = value.trim();
  if (scope && !/^[a-z]{2,12}$/.test(scope)) throw new Error("GBX_DATA_SCOPE must be 2 to 12 lower-case letters");
  return scope;
}

export const scopedTable = (scope: string, name: string) => `${scope}${name}`;

export function counterKeys(scope: string) {
  const own = (key: string) => (scope ? `${scope}-${key}` : key);
  return {
    userQuestions: (id: string) => own(`q-user-${id}`),
    questions: own("q-all"),
    tokens: own("tokens-all"),
    ocrPages: "ocr-pages-all",
    userUploads: (id: string) => `up-user-${id}`,
    evalRuns: "eval-all",
    esriTiles: "esri-tiles-all",
    userEsriTiles: (id: string) => `esri-tiles-user-${id}`,
    pcTiles: "pc-tiles-all",
    userPcTiles: (id: string) => `pc-tiles-user-${id}`,
    pcAreas: "pc-areas-all",
    userPcAreas: (id: string) => `pc-areas-user-${id}`,
  };
}
