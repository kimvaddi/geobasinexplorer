import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { liveApi, reviewPagePath, reviewReasonError, REVIEW_REASON_MAX_LENGTH, type LiveReviewDetail } from "@/lib/live";
import type { SourceReview, SourceRegistry } from "../../../../services/api/src/live/contracts";
import { PrivatePageImage } from "./live-page";

export function LiveReviewPanel({ owner, onPublished }: { owner: boolean; onPublished: () => void }) {
  const [reviews, setReviews] = useState<SourceReview[]>([]), [registry, setRegistry] = useState<SourceRegistry[]>([]);
  const [detail, setDetail] = useState<LiveReviewDetail | null>(null), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const remaining = REVIEW_REASON_MAX_LENGTH - reason.length;
  const invalidReason = reviewReasonError(reason) !== null;
  const refresh = async () => { const r = await liveApi.reviews(); setReviews(r.reviews); setRegistry(r.registry); };
  useEffect(() => { if (!owner) return; let active = true; void liveApi.reviews().then((r) => { if (active) { setReviews(r.reviews); setRegistry(r.registry); } }).catch(() => { if (active) setNotice("The steward queue could not be read. Nothing can be approved until it is available."); }); return () => { active = false; }; }, [owner]);
  if (!owner) return null;
  const inspect = async (r: SourceReview, preserveReason = false) => {
    setBusy(true); setNotice(""); setDecisionError(""); setDetail(null);
    if (!preserveReason) setReason("");
    try { setDetail(await liveApi.review(r)); } catch (e) { setNotice(e instanceof Error ? e.message : "Review could not be read."); } finally { setBusy(false); }
  };
  const decide = async (decision: "approved" | "rejected") => {
    if (!detail || busy) return;
    const decisionReason = detail.review.status === "approved" && decision === "approved" ? detail.review.decision?.reason ?? "" : reason.trim();
    const reasonError = reviewReasonError(decisionReason);
    if (reasonError) { setDecisionError(reasonError); return; }
    setBusy(true); setNotice(""); setDecisionError("");
    try {
      const r = detail.review;
      const result = await liveApi.decide({ sourceId: r.sourceId, sha256: r.sha256, extractionVersion: r.extractionVersion, decision, reason: decisionReason }, detail.etag);
      setDetail({ ...detail, ...result }); onPublished();
      const refreshed = await refresh().then(() => true).catch(() => false);
      const message = decision === "approved" ? result.publication.status === "published" ? "This approval is already published; no new publication was queued." : "Approval recorded. Publication is queued; going live also requires the serving revision's source commitment." : "Extraction rejected. No publication was requested.";
      setNotice(`${message}${refreshed ? "" : " The queue could not be refreshed."}`);
    } catch (e) { setDecisionError(e instanceof Error ? e.message : "Decision failed. No publication is assumed."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Live source steward review" className="space-y-3 rounded-xl border p-4">
    <h2 className="text-base font-semibold">Live source steward review</h2>
    <p className="text-sm">Owner-only prototype review. A decision binds the landed artifact hash and this extraction version. Approval queues publication; it does not itself make the source live.</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refresh().then(onPublished).catch(() => setNotice("The queue could not be refreshed.")); }}>Refresh publications and reviews</Button>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {decisionError && <div className="space-y-1">
      <p role="alert" className="text-sm">{decisionError}</p>
      <p className="text-xs">Your reason has been kept. If the review changed, reload it before retrying.</p>
      {detail && <Button size="xs" variant="outline" disabled={busy} onClick={() => void inspect(detail.review, true)}>Reload review, keep reason</Button>}
    </div>}
    <ul className="space-y-2">{reviews.map((r) => <li key={`${r.sourceId}:${r.sha256}:${r.extractionVersion}`} className="rounded-lg border p-2 text-sm">
      <p>{registry.find((s) => s.sourceId === r.sourceId)?.title ?? r.sourceId} · {r.status} · {r.pageCount} pages</p>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void inspect(r)}>Inspect extraction</Button>
    </li>)}</ul>
    {!reviews.length && <p className="text-sm">No extractions are available for review.</p>}
    {detail && <div className="space-y-3 border-t pt-3">
      <h3 className="font-semibold">{detail.source.title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>Licence</dt><dd>{detail.source.licence} · {detail.source.publishAllowed ? "Cleared for publication" : "Publication withheld"}</dd>
        <dt>Licence basis</dt><dd>{detail.source.licenceBasis}</dd>
        <dt>Attribution</dt><dd>{detail.source.attribution}</dd>
        <dt>Landed SHA-256</dt><dd className="break-all font-mono">{detail.review.sha256}</dd>
        <dt>Extraction</dt><dd className="break-all font-mono">{detail.review.extractionVersion}</dd>
        <dt>Pages and chunks</dt><dd>{detail.review.pageCount} pages; {detail.review.chunkCount} chunks</dd>
        <dt>Confidence</dt><dd>Mean {detail.review.confidence.mean ?? "unmeasured"}; minimum {detail.review.confidence.minimum ?? "unmeasured"}; {detail.review.confidence.lowConfidencePages} low-confidence pages of {detail.review.confidence.measuredPages} measured</dd>
        <dt>Publication</dt><dd>{detail.publication.status}{detail.publication.manifestVersion ? ` · generation ${detail.publication.manifestVersion}` : ""}</dd>
      </dl>
      {detail.samples.map((chunk) => { const src = reviewPagePath(detail, chunk); return <details key={chunk.id} className="rounded-lg border p-2">
        <summary className="cursor-pointer text-sm">Sample chunk · native PDF page {chunk.page}</summary><p className="my-2 whitespace-pre-wrap text-xs">{chunk.text}</p>
        {src && <PrivatePageImage key={src} src={src} label={`Steward preview, PDF page ${chunk.page}`} />}
      </details>; })}
      {detail.review.status === "pending" && <div className="space-y-2">
        <label className="block text-sm" htmlFor="live-review-reason">Decision reason</label>
        <textarea id="live-review-reason" className="w-full rounded-lg border bg-transparent p-2 text-sm" rows={3} maxLength={REVIEW_REASON_MAX_LENGTH} aria-describedby="live-review-reason-count" aria-invalid={remaining < 0 || undefined} value={reason} onChange={(e) => setReason(e.target.value)} />
        <p id="live-review-reason-count" aria-live="polite" className="text-xs">{remaining >= 0 ? `${remaining} characters remaining` : `${-remaining} character${remaining === -1 ? "" : "s"} over the limit`}</p>
        <div className="flex gap-2"><Button disabled={busy || invalidReason || !detail.etag || !detail.source.publishAllowed} onClick={() => void decide("approved")}>Approve extraction</Button><Button variant="outline" disabled={busy || invalidReason || !detail.etag} onClick={() => void decide("rejected")}>Reject extraction</Button></div>
      </div>}
      {detail.review.status === "approved" && detail.publication.status === "failed" && <Button variant="outline" disabled={busy || !detail.etag || !detail.source.publishAllowed || !detail.review.decision?.reason} onClick={() => void decide("approved")}>Retry approved publication</Button>}
      {detail.review.decision && <p className="text-xs">{detail.review.decision.decision} by {detail.review.decision.by} at {detail.review.decision.at}. {detail.review.decision.reason}</p>}
    </div>}
  </section>;
}
export default LiveReviewPanel;
