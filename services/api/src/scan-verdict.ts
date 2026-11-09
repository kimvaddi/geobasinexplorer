// Shared by the live processor and, in a later integration, the existing upload worker.
import { createHash } from "node:crypto";
import type { BlobClient } from "@azure/storage-blob";
import type { ClamAvTags } from "./live/contracts";

const REQUIRED = ["gbx-clamav-scan-result", "gbx-clamav-sha256", "gbx-clamav-engine", "gbx-clamav-signature-version", "gbx-clamav-signature-date", "gbx-clamav-scanned-at"] as const;
// 72 hours (docs/SECURITY.md, malware scanning); 24 is the stricter setting. Keep in step with scanner/scan.py.
const AGE_MS = 72 * 60 * 60_000;
export class ScanVerdictError extends Error {}
const refuse = (message: string): never => { throw new ScanVerdictError(message); };
export const sha256Of = (buffer: Uint8Array) => createHash("sha256").update(buffer).digest("hex");
function utc(value: string): number {
  const n = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(n)
    || new Date(n).toISOString() !== value.replace(/(?<!\.\d{3})Z$/, ".000Z")) return NaN;
  return n;
}
export function requireCleanScan(tags: Record<string, string>, now = Date.now()): ClamAvTags {
  if (!Number.isFinite(now) || REQUIRED.some((key) => !Object.hasOwn(tags, key) || typeof tags[key] !== "string")
    || Object.keys(tags).some((key) => key.startsWith("gbx-clamav-") && !REQUIRED.includes(key as typeof REQUIRED[number]))) refuse("Missing or unexpected scan tags.");
  if (tags[REQUIRED[0]] !== "No threats found") refuse("A current exact clean verdict is required.");
  if (!/^[a-f0-9]{64}$/.test(tags[REQUIRED[1]]) || !/^\d+\.\d+\.\d+(?: outdated)?$/.test(tags[REQUIRED[2]])
    || !/^main:[1-9]\d*\/daily:[1-9]\d*\/bytecode:[1-9]\d*$/.test(tags[REQUIRED[3]])) refuse("Invalid scan metadata.");
  const signature = utc(tags[REQUIRED[4]]), scanned = utc(tags[REQUIRED[5]]);
  if (!Number.isFinite(signature) || !Number.isFinite(scanned) || signature > scanned || scanned > now
    || now - signature > AGE_MS || now - scanned > AGE_MS) refuse("Scan or signatures are stale, future-dated or out of order.");
  return Object.fromEntries(REQUIRED.map((key) => [key, tags[key]])) as unknown as ClamAvTags;
}
// tags is null only for a file read with the live scan switched off (owner exception 12).
export interface ScannedBuffer { buffer: Buffer; sha256: string; tags: ClamAvTags | null; etag: string }
// getTags is not a content lock. Download exactly once, ETag-conditionally, into one bounded buffer, then hash that buffer.
// https://learn.microsoft.com/javascript/api/@azure/storage-blob/blobdownloadtobufferoptions
// https://learn.microsoft.com/rest/api/storageservices/set-blob-tags
export async function readScannedBlob(client: Pick<BlobClient, "getTags" | "getProperties" | "downloadToBuffer">,
  options: { maxBytes: number; expectedSha256: string; signal?: AbortSignal; now?: () => number; timeoutMs?: number }): Promise<ScannedBuffer> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 200_000_000
    || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) refuse("Invalid scan download limits or expected hash.");
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) refuse("Invalid scan validation timeout.");
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
  const now = options.now ?? Date.now;
  const read = async () => {
    signal.throwIfAborted();
    const tags = requireCleanScan((await client.getTags({ abortSignal: signal })).tags, now());
    if (tags["gbx-clamav-sha256"] !== options.expectedSha256) refuse("Scan hash differs from the authorized source hash.");
    const props = await client.getProperties({ abortSignal: signal });
    const size = props.contentLength;
    if (!Number.isSafeInteger(size) || !size || size < 1 || size > options.maxBytes || !props.etag) refuse("Invalid or oversized quarantine blob.");
    const buffer = Buffer.alloc(size!);
    // The SDK requires an explicit offset when a count is supplied. Tests enforce this overload.
    await client.downloadToBuffer(buffer, 0, size, { abortSignal: signal, conditions: { ifMatch: props.etag }, concurrency: 1, maxRetryRequestsPerBlock: 0 });
    signal.throwIfAborted();
    const sha256 = sha256Of(buffer);
    if (sha256 !== tags["gbx-clamav-sha256"]) refuse("Quarantine bytes do not match the scan verdict.");
    requireCleanScan(tags as unknown as Record<string, string>, now());
    return { buffer, sha256, tags, etag: props.etag! };
  };
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      onAbort = () => reject(new ScanVerdictError("Scan validation was cancelled or timed out."));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
// The same bounded, ETag-conditional single download and hash check, without a scan verdict. Only for the live lane
// with GBX_LIVE_SCAN=off; the caller still compares the hash with the registered source.
export async function readUnscannedBlob(client: Pick<BlobClient, "getProperties" | "downloadToBuffer">,
  options: { maxBytes: number; expectedSha256: string; signal?: AbortSignal }): Promise<ScannedBuffer> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 200_000_000
    || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) refuse("Invalid download limits or expected hash.");
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  const props = await client.getProperties({ abortSignal: signal });
  const size = props.contentLength;
  if (!Number.isSafeInteger(size) || !size || size < 1 || size > options.maxBytes || !props.etag) refuse("Invalid or oversized quarantine blob.");
  const buffer = Buffer.alloc(size!);
  await client.downloadToBuffer(buffer, 0, size, { abortSignal: signal, conditions: { ifMatch: props.etag }, concurrency: 1, maxRetryRequestsPerBlock: 0 });
  signal.throwIfAborted();
  const sha256 = sha256Of(buffer);
  if (sha256 !== options.expectedSha256) refuse("Quarantine bytes do not match the registered source hash.");
  return { buffer, sha256, tags: null, etag: props.etag! };
}
// A clean verdict is mandatory while the live scan is on; with it off, the lineage records that nothing was scanned.
export function liveScanVerdict(tags: ClamAvTags | null, scanOn: boolean): "No threats found" | "Not scanned" {
  if (!scanOn) return "Not scanned";
  requireCleanScan({ ...(tags ?? {}) });
  return "No threats found";
}
