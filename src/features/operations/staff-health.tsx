import { useId, useState } from "react";
import { CircleCheck, CircleSlash, Clock3, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { FilterChoices, TicketFilterPopover } from "@/components/ticket-filter-popover";
import { Button } from "@/components/ui/button";
import { localizeError, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useHealth, useJobDiagnostics } from "./adapters/health";

const kinds = { cancellation: "healthCancellation", intent_expiry: "healthExpiry", rejected_upload: "healthRejected", ticket_purge: "healthPurge" } as const;
const states = { pending: "healthPending", running: "healthRunning", completed: "healthCompleted", failed: "healthFailed", superseded: "healthSuperseded" } as const;
const outcomes = { deleted: "healthDeleted", absent_verified: "healthDeleted", failed_retryable: "healthRetry", failed_permanent: "healthPermanent",
  unknown: "healthUnknown", not_configured: "healthNotConfigured", ownership_unverified: "healthUnverified", ownership_conflict: "healthConflict" } as const;
const diagnosticViews = [
  { value: "failed", labelKey: "healthFailed" },
  { value: "pending", labelKey: "healthPending" },
  { value: "expired", labelKey: "healthExpired" },
] as const;

export function StaffHealth() {
  const { t, formatDate } = useI18n();
  const health = useHealth();
  const [view, setView] = useState<"failed" | "pending" | "expired">("failed");
  const currentView = diagnosticViews.find(option => option.value === view) ?? diagnosticViews[0];
  const counts = useId();
  if (!health) return <p role="status">{t("syncing")}</p>;
  return <section className="space-y-4">
    <dl className="aurora-inset divide-y divide-border/60 rounded-xl px-3 text-sm">
      {([ ["healthStorage", health.configuration.uploadThingToken], ["healthCallback", health.configuration.callbackSecret],
        ["healthCleanup", health.configuration.mediaCleanupEnabled] ] as const).map(([label, enabled]) =>
        <div className="flex min-h-11 items-center justify-between gap-3 py-2" key={label}>
          <dt className="min-w-0">{t(label)}</dt>
          <dd className={cn("ticket-chip shrink-0 text-xs font-semibold", enabled ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300")}>
            {enabled ? <CircleCheck aria-hidden className="size-3.5" /> : <CircleSlash aria-hidden className="size-3.5" />}{t(enabled ? "healthYes" : "healthNo")}
          </dd>
        </div>)}
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        <dt className="min-w-0">{t("healthOldest")}</dt>
        <dd className="inline-flex items-center gap-1.5 text-muted-foreground"><Clock3 aria-hidden className="size-3.5" />
          {health.oldestPendingAt === null ? t("healthNone") : formatDate(health.oldestPendingAt)}</dd>
      </div>
    </dl>
    {/* A table from `sm`; below it each kind becomes a card of labelled counts.
        Explicit roles keep table semantics through the display change. */}
    <table role="table" aria-labelledby={counts} className="block w-full text-sm sm:aurora-inset sm:table sm:overflow-hidden sm:rounded-xl">
      <caption id={counts} className="sr-only">{t("healthCounts")}</caption>
      <thead role="rowgroup" className="sr-only sm:not-sr-only sm:table-header-group">
        <tr role="row">
          <th role="columnheader" scope="col" className="px-3 py-2 text-start align-bottom text-xs font-medium text-muted-foreground">{t("healthKind")}</th>
          {Object.values(states).map(label => <th role="columnheader" scope="col" key={label}
            className="px-2 py-2 text-end align-bottom text-xs font-medium leading-4 text-muted-foreground">{t(label)}</th>)}
        </tr>
      </thead>
      <tbody role="rowgroup" className="grid gap-2 sm:table-row-group">
        {Object.entries(kinds).map(([kind, label]) => <tr role="row" key={kind}
          className="aurora-inset flex flex-wrap gap-1.5 rounded-xl p-2.5 sm:table-row sm:rounded-none sm:border-0 sm:bg-transparent sm:bg-none sm:p-0 sm:shadow-none">
          <th role="rowheader" scope="row" className="w-full px-0.5 text-start font-semibold sm:w-auto sm:border-t sm:border-border/60 sm:px-3 sm:py-2.5 sm:font-medium">{t(label)}</th>
          {Object.entries(states).map(([state, stateLabel]) => {
            const value = health.counts[`${kind}:${state}`] ?? 0;
            const alert = state === "failed" && value > 0;
            return <td role="cell" key={state} className={cn("ticket-chip min-h-8 text-muted-foreground sm:table-cell sm:rounded-none sm:border-t sm:border-border/60 sm:bg-transparent sm:px-2 sm:py-2.5 sm:text-end",
              alert && "text-destructive")}>
              <span aria-hidden className="text-xs sm:hidden">{t(stateLabel)}</span>
              <span className={cn("font-semibold tabular-nums", value > 0 && !alert && "text-foreground")}>{value}</span>
            </td>;
          })}
        </tr>)}
      </tbody>
    </table>
    <div className="flex items-center justify-between gap-3">
      <h3 className="min-w-0 text-sm font-semibold text-foreground">{t(currentView.labelKey)}</h3>
      <TicketFilterPopover activeCount={view === "failed" ? 0 : 1} onClear={() => setView("failed")}>
        <FilterChoices label={t("healthDiagnosticView")} value={view} onChange={setView}
          options={diagnosticViews.map(option => ({ value: option.value, label: t(option.labelKey) }))} />
      </TicketFilterPopover>
    </div>
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
    <p className="text-xs leading-5 text-muted-foreground">{t("healthPageHint")}</p>
    {jobs.status === "LoadingFirstPage" ? <p className="text-sm">{t("syncing")}</p>
      : jobs.results.length === 0 ? <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">{t("healthNone")}</p>
      : <ul className="space-y-2">
      {jobs.results.map(job => <li key={job.jobId} className={cn("aurora-inset flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-xl p-3 text-sm", job.state === "failed" && "border-destructive/40")}>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold leading-5">{t(kinds[job.kind])} <span className="font-normal text-muted-foreground">· {t(states[job.state])}</span></p>
          <p className="text-xs leading-5 text-muted-foreground">{t("healthAttempt", { attempt: job.attempt, max: job.maxAttempts })}{job.exhausted ? ` · ${t("healthExhausted")}` : ""}
            {" · "}{t(view === "expired" ? "healthLeaseTime" : "healthAvailable", { date: formatDate(view === "expired" ? job.leaseExpiresAt! : job.availableAt) })}</p>
          {job.lastOutcome ? <p className="leading-5">{t(outcomes[job.lastOutcome])}</p> : null}
          {job.purgeBlocked ? <p className="flex items-start gap-1.5 leading-5 text-destructive"><ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{t("healthPurgeBlocked")}</p> : null}
        </div>
        {job.state === "failed" ? <Button variant="outline" className="min-h-11 shrink-0" disabled={busy !== null} onClick={() => void requeue(job)}>
          {busy === job.jobId ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}{t("healthRequeue")}
        </Button> : null}
      </li>)}
    </ul>}
    {jobs.status !== "Exhausted" ? <Button variant="outline" className="min-h-11 w-full sm:w-auto" disabled={jobs.status !== "CanLoadMore"} onClick={() => jobs.loadMore(25)}>{t("loadOlder")}</Button> : null}
  </div>;
}
