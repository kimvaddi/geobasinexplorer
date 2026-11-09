// State of an upload's ingestion job (table "ingestjobs"). Two rules keep it consistent when queue messages are
// delivered more than once: a finished job (done, rejected or failed) is never changed again, and an execution works on
// a job only while it holds its lease, so a duplicate delivery can't process the same file at the same time.
import type { RestError } from "@azure/storage-blob";
import { table } from "./azure";

export const TERMINAL = ["done", "rejected", "failed"];
const LEASE_MS = 31 * 60_000; // a little longer than the job's 30-minute replica timeout
const T = () => table("ingestjobs");
const code = (e: unknown) => (e as RestError).statusCode;

interface Row { status: string; leaseUntil?: string; etag: string }
async function load(jobId: string): Promise<Row> {
  const e = await T().getEntity<{ status: string; leaseUntil?: string }>("job", jobId);
  return { status: e.status, leaseUntil: e.leaseUntil, etag: e.etag };
}

/* Merge `patch` into the job unless it has already finished. Returns false when the job was left as it was. */
export async function setJob(jobId: string, patch: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await load(jobId);
    if (TERMINAL.includes(cur.status)) return false;
    try {
      await T().updateEntity({ partitionKey: "job", rowKey: jobId, ...patch, updatedAt: new Date().toISOString() }, "Merge", { etag: cur.etag });
      return true;
    } catch (e) { if (code(e) !== 412) throw e; }
  }
  throw new Error("The job record kept changing; it will be tried again.");
}

export type Claim = "claimed" | "finished" | "busy";
/* Take the job for this execution: refused if it has finished, or if another execution holds a current lease. */
export async function claimJob(jobId: string, patch: Record<string, unknown>): Promise<Claim> {
  const cur = await load(jobId);
  if (TERMINAL.includes(cur.status)) return "finished";
  if (cur.leaseUntil && Date.parse(cur.leaseUntil) > Date.now()) return "busy";
  try {
    await T().updateEntity({ partitionKey: "job", rowKey: jobId, ...patch, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: new Date().toISOString() }, "Merge", { etag: cur.etag });
    return "claimed";
  } catch (e) { if (code(e) === 412) return "busy"; throw e; }
}

export async function jobStatusOf(jobId: string): Promise<string> { return (await load(jobId)).status; }
