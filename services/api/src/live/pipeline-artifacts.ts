import type { PipelineStore, Row } from "./pipeline-store";
import { sha256Of } from "../scan-verdict";
import { PIPELINE_LIMITS, statusOf } from "./pipeline-config";
export async function immutableBlob(store: PipelineStore, container: string, name: string, bytes: Buffer, contentType: string, metadata: Record<string, string>, signal?: AbortSignal) {
  const hash = sha256Of(bytes);
  try { await store.write(container, name, bytes, { ifNoneMatch: "*" }, contentType, { ...metadata, sha256: hash }, signal); }
  catch (e) {
    if (![409, 412].includes(statusOf(e) ?? 0)) throw e;
    const existing = await store.read(container, name, Math.max(bytes.length, 1), signal);
    if (!existing || sha256Of(existing.buffer) !== hash || existing.info.contentType !== contentType || Object.entries({ ...metadata, sha256: hash }).some(([key, value]) => existing.info.metadata[key] !== value)) throw new Error("An immutable artifact differs from this extraction; no overwrite was attempted.");
  }
  const info = await store.stat(container, name, signal); if (!info) throw new Error("Immutable artifact did not persist."); return info;
}
export async function immutableJson(store: PipelineStore, name: string, value: unknown, signal?: AbortSignal) {
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > PIPELINE_LIMITS.jsonBytes) throw new Error(`JSON artifact cap reached (${bytes.length} bytes, cap ${PIPELINE_LIMITS.jsonBytes}).`);
  return immutableBlob(store, "processed", name, bytes, "application/json", {}, signal);
}
export async function readJson<T>(store: PipelineStore, name: string, signal?: AbortSignal): Promise<T | null> {
  const value = await store.read("processed", name, PIPELINE_LIMITS.jsonBytes, signal);
  if (!value) return null;
  if (value.info.contentType !== "application/json" || value.info.metadata.sha256 !== sha256Of(value.buffer)) throw new Error("JSON artifact integrity check failed.");
  return JSON.parse(value.buffer.toString("utf8")) as T;
}
export async function immutableRow(store: PipelineStore, name: string, row: Row, signal?: AbortSignal) {
  try { await store.put(name, row, undefined, signal); }
  catch (e) { if (statusOf(e) !== 409) throw e;
    const old = await store.get<Record<string, unknown>>(name, row.partitionKey, row.rowKey, signal);
    if (!old || Object.entries(row).some(([k, v]) => JSON.stringify(old[k]) !== JSON.stringify(v))) throw new Error("Immutable silver row mismatch."); }
}
export async function parallelBounded<T, R>(values: T[], concurrency: number, run: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => { for (;;) { const i = cursor++; if (i >= values.length) break; out[i] = await run(values[i], i); } }));
  return out;
}
