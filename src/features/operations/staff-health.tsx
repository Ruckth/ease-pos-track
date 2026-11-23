import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { localizeError, useI18n } from "@/lib/i18n";
import { useHealth, useJobDiagnostics } from "./adapters/health";

const kinds = { cancellation: "healthCancellation", intent_expiry: "healthExpiry", rejected_upload: "healthRejected", ticket_purge: "healthPurge" } as const;
const states = { pending: "healthPending", running: "healthRunning", completed: "healthCompleted", failed: "healthFailed", superseded: "healthSuperseded" } as const;
const outcomes = { deleted: "healthDeleted", absent_verified: "healthDeleted", failed_retryable: "healthRetry", failed_permanent: "healthPermanent",
  unknown: "healthUnknown", not_configured: "healthNotConfigured", ownership_unverified: "healthUnverified", ownership_conflict: "healthConflict" } as const;

export function StaffHealth() {
  const { t, formatDate } = useI18n();
  const health = useHealth();
  const [view, setView] = useState<"failed" | "pending" | "expired">("failed");
  if (!health) return <p role="status">{t("syncing")}</p>;
  return <section className="space-y-4">
    <dl className="grid gap-2 text-sm">
      {([ ["healthStorage", health.configuration.uploadThingToken], ["healthCallback", health.configuration.callbackSecret],
        ["healthCleanup", health.configuration.mediaCleanupEnabled] ] as const).map(([label, enabled]) =>
        <div className="flex justify-between gap-4" key={label}><dt>{t(label)}</dt><dd>{t(enabled ? "healthYes" : "healthNo")}</dd></div>)}
      <div><dt>{t("healthOldest")}</dt><dd>{health.oldestPendingAt === null ? t("healthNone") : formatDate(health.oldestPendingAt)}</dd></div>
    </dl>
    <div className="overflow-x-auto"><table className="w-full text-sm">
      <caption className="sr-only">{t("healthCounts")}</caption>
      <thead><tr><th scope="col" className="text-left">{t("healthKind")}</th>{Object.values(states).map(label => <th scope="col" key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{Object.entries(kinds).map(([kind, label]) => <tr key={kind}><th scope="row" className="py-2 text-left">{t(label)}</th>
        {Object.keys(states).map(state => <td className="text-center" key={state}>{health.counts[`${kind}:${state}`]}</td>)}</tr>)}</tbody>
    </table></div>
    <div className="flex flex-wrap gap-2">{(["failed", "pending", "expired"] as const).map(mode => <Button key={mode} variant={view === mode ? "default" : "outline"}
      aria-pressed={view === mode} onClick={() => setView(mode)}>{t(mode === "expired" ? "healthExpired" : states[mode])}</Button>)}</div>
    <JobDiagnostics key={view} view={view} />
  </section>;
}

function JobDiagnostics({ view }: { view: "failed" | "pending" | "expired" }) {
  const { t, formatDate } = useI18n();
  const jobs = useJobDiagnostics(view);
  const [busy, setBusy] = useState<string | null>(null);
  async function requeue(job: typeof jobs.results[number]) {
    if (job.kind === "ticket_purge" && !window.confirm(t("healthPurgeConfirm"))) return;
    const jobId = job.jobId;
    setBusy(jobId);
    try {
      if (await jobs.requeue({ jobId })) toast.success(t("healthRequeued"));
      else toast.error(t("healthRepairRequired"));
    }
    catch (error) { toast.error(localizeError(error, t)); }
    finally { setBusy(null); }
  }
  return <div className="space-y-3" aria-live="polite">
    <p className="text-xs text-muted-foreground">{t("healthPageHint")}</p>
    {jobs.status === "LoadingFirstPage" ? <p>{t("syncing")}</p> : jobs.results.length === 0 ? <p>{t("healthNone")}</p> : <ul className="space-y-2">
      {jobs.results.map(job => <li key={job.jobId} className="space-y-1 rounded-md border border-transparent bg-muted/40 p-3 text-sm">
        <p className="font-medium">{t(kinds[job.kind])} · {t(states[job.state])}</p>
        <p>{t("healthAttempt", { attempt: job.attempt, max: job.maxAttempts })}{job.exhausted ? ` · ${t("healthExhausted")}` : ""}</p>
        {job.lastOutcome ? <p>{t(outcomes[job.lastOutcome])}</p> : null}
        {job.purgeBlocked ? <p>{t("healthPurgeBlocked")}</p> : null}
        <p>{t(view === "expired" ? "healthLeaseTime" : "healthAvailable", { date: formatDate(view === "expired" ? job.leaseExpiresAt! : job.availableAt) })}</p>
        {job.state === "failed" ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void requeue(job)}>{t("healthRequeue")}</Button> : null}
      </li>)}
    </ul>}
    {jobs.status !== "Exhausted" ? <Button disabled={jobs.status !== "CanLoadMore"} onClick={() => jobs.loadMore(25)}>{t("loadOlder")}</Button> : null}
  </div>;
}
