// Operator tool; it makes no Azure call. It fetches Geoscience Australia catalogue records from eCat, renders each as the
// live lane's record PDF (src/live/catalogue-ecat.ts) and prints the pin a reviewed commit adds to SOURCE_ARTIFACTS for a
// new catalogue source. With --out it also writes the PDFs, so the owner can read them before clearing the sources.
//   node build.mjs --script scripts/ecat-records.ts && node dist/scripts/ecat-records.mjs [--out <folder>] <eCat id>...
import fs from "node:fs";
import path from "node:path";
import { ecatRecordArtifact } from "../src/live/catalogue-ecat";

const args = process.argv.slice(2), at = args.indexOf("--out"), out = at >= 0 ? args[at + 1] : null;
const ids = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
if (!ids.length || ids.some((id) => !/^[1-9]\d{0,7}$/.test(id)) || (at >= 0 && !out)) {
  console.error("Usage: ecat-records.mjs [--out <folder>] <eCat id>...");
  process.exit(2);
}
if (out) fs.mkdirSync(out, { recursive: true });
for (const id of ids) {
  const { record, bytes, sha256 } = await ecatRecordArtifact(id, AbortSignal.timeout(60_000));
  const name = `ecat-${id}-record.pdf`;
  if (out) fs.writeFileSync(path.join(out, name), bytes);
  console.log(JSON.stringify({ sourceId: `ga-ecat-${id}`, name, sha256, bytes: bytes.length, url: record.pid, title: record.title,
    status: record.status, published: record.published, revision: record.revision, licence: record.licence }));
}
