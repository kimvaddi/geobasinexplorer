// Operator tool: reads registered archive-member sources from their publishers' archives by byte-range requests and
// prints each member's size and SHA-256, so a reviewed commit can pin or re-pin them. Makes no Azure call.
//   archive-members.mjs [--out <folder>] [source id ...]   (default: every archive-member source)
import { writeFileSync } from "node:fs";
import { sha256Of } from "../src/scan-verdict";
import { fetchArchiveMember } from "../src/live/archive-member";
import { SOURCE_ARTIFACTS, sourceArtifact, sourceBytesFor, type SliceSourceId } from "../src/live/pipeline-registry";
const args = process.argv.slice(2), out = args[0] === "--out" ? args[1] : null, ids = (out ? args.slice(2) : args) as SliceSourceId[];
const chosen = ids.length ? ids : (Object.keys(SOURCE_ARTIFACTS) as SliceSourceId[]).filter((id) => sourceArtifact(id).member);
for (const id of chosen) {
  const artifact = sourceArtifact(id);
  if (!artifact.member) throw new Error(`${id} is not an archive-member source`);
  const bytes = await fetchArchiveMember(artifact.url, artifact.member, sourceBytesFor(id), AbortSignal.timeout(300_000));
  const sha256 = sha256Of(bytes);
  if (out) writeFileSync(`${out}/${artifact.name}`, bytes);
  console.log(JSON.stringify({ sourceId: id, name: artifact.name, member: artifact.member, bytes: bytes.length, sha256, pinned: sha256 === artifact.sha256 }));
}
