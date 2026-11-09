// Feedback is recorded for governed review. No single vote changes how sources rank for anyone.
import { table } from "./azure";
import { cfg } from "./config";
import { scopedTable } from "./data-scope";
import type { User } from "./auth";

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

export async function recordFeedback(b: Record<string, unknown>, user: User) {
  const at = new Date().toISOString();
  await table(scopedTable(cfg.dataScope, "feedback")).createEntity({
    partitionKey: at.slice(0, 10), rowKey: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    by: user.name, byId: user.id, answerId: clip(b.answerId, 80), question: clip(b.question, 300),
    vote: b.vote === "up" ? "up" : "down", reason: clip(b.reason, 60), citations: clip(Array.isArray(b.citations) ? (b.citations as unknown[]).join("; ") : "", 1000),
    label: clip(b.label, 20), status: "awaiting review",
  });
}
