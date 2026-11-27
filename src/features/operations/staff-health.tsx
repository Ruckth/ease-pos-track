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
  if (!health) return <p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>;
  return <section className="space-y-3">
    <dl className="aurora-inset divide-y divide-border/60 rounded-xl px-3 text-sm">
      {([ ["healthStorage", health.configuration.uploadThingToken], ["healthCallback", health.configuration.callbackSecret],
        ["healthCleanup", health.configuration.mediaCleanupEnabled] ] as const).map(([label, enabled]) =>
        <div className="flex min-h-9 items-center justify-between gap-3 py-1.5" key={label}>
          <dt className="min-w-0 leading-5">{t(label)}</dt>
          <dd className={cn("ticket-chip shrink-0 text-xs font-semibold", enabled ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300")}>
            {enabled ? <CircleCheck aria-hidden className="size-3.5" /> : <CircleSlash aria-hidden className="size-3.5" />}{t(enabled ? "healthYes" : "healthNo")}
          </dd>
        </div>)}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5">
        <dt className="min-w-0 leading-5">{t("healthOldest")}</dt>
        <dd className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:text-sm"><Clock3 aria-hidden className="size-3.5 shrink-0" />
          {health.oldestPendingAt === null ? t("healthNone") : formatDate(health.oldestPendingAt)}</dd>
      </div>
    </dl>
    {/* A table from `md` (enough width for six columns in EN and TH); below it each kind
        becomes a compact row of labelled counts inside one inset container. Explicit roles
        keep table semantics through the display change. */}
    <div className="aurora-inset overflow-x-auto rounded-xl">
      <table role="table" aria-labelledby={counts} className="relative block w-full text-sm md:table">
        <caption id={counts} className="sr-only">{t("healthCounts")}</caption>
        <thead role="rowgroup" className="sr-only md:not-sr-only md:table-header-group">
          <tr role="row">
            <th role="columnheader" scope="col" className="py-2 pe-2 ps-3 text-start align-bottom text-xs font-medium text-muted-foreground">{t("healthKind")}</th>
            {Object.values(states).map((label, index, all) => <th role="columnheader" scope="col" key={label}
              className={cn("py-2 text-end align-bottom text-xs font-medium leading-4 text-muted-foreground", index === all.length - 1 ? "ps-2 pe-3" : "px-2")}>{t(label)}</th>)}
          </tr>
        </thead>
        <tbody role="rowgroup" className="block divide-y divide-border/60 md:table-row-group md:divide-y-0">
          {Object.entries(kinds).map(([kind, label]) => <tr role="row" key={kind}
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2 md:table-row md:p-0">
            <th role="rowheader" scope="row" className="w-full pb-0.5 text-start text-[13px] font-semibold leading-5 md:w-auto md:border-t md:border-border/60 md:py-2.5 md:pe-2 md:ps-3 md:text-sm md:font-medium">{t(label)}</th>
            {Object.entries(states).map(([state, stateLabel], index, all) => {
              const value = health.counts[`${kind}:${state}`] ?? 0;
              const alert = state === "failed" && value > 0;
              return <td role="cell" key={state} className={cn(
                "ticket-chip py-0.5 text-xs leading-4 text-muted-foreground md:table-cell md:rounded-none md:border-t md:border-border/60 md:bg-transparent md:py-2.5 md:text-end md:text-sm md:leading-5",
                index === all.length - 1 ? "md:ps-2 md:pe-3" : "md:px-2",
                alert && "text-destructive",
              )}>
                <span aria-hidden className="md:hidden">{t(stateLabel)}</span>
                <span className={cn("font-semibold tabular-nums", value > 0 && !alert && "text-foreground")}>{value}</span>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="space-y-2 pt-0.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 text-sm font-semibold text-foreground">{t(currentView.labelKey)}</h3>
        <TicketFilterPopover activeCount={view === "failed" ? 0 : 1} onClear={() => setView("failed")}>
          <FilterChoices label={t("healthDiagnosticView")} value={view} onChange={setView}
            options={diagnosticViews.map(option => ({ value: option.value, label: t(option.labelKey) }))} />
        </TicketFilterPopover>
      </div>
      <JobDiagnostics key={view} view={view} />
    </div>
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
  return <div className="space-y-2.5" aria-live="polite">
    <p className="text-xs leading-4 text-muted-foreground">{t("healthPageHint")}</p>
    {jobs.status === "LoadingFirstPage" ? <p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>
      : jobs.results.length === 0 ? <p className="rounded-xl border border-dashed border-border/70 px-3 py-3 text-center text-sm text-muted-foreground">{t("healthNone")}</p>
      : <ul className="space-y-2">
      {jobs.results.map(job => <li key={job.jobId} className={cn("aurora-inset flex flex-col gap-2.5 rounded-xl p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-3", job.state === "failed" && "border-destructive/40")}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-semibold leading-5 text-foreground">{t(kinds[job.kind])}</p>
            <span className={cn("ticket-chip py-0 text-xs font-medium leading-5", job.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
              {t(states[job.state])}
            </span>
          </div>
          {job.lastOutcome ? <p className="text-[13px] leading-5 text-foreground">{t(outcomes[job.lastOutcome])}</p> : null}
          {job.purgeBlocked ? <p className="flex items-start gap-1.5 text-xs font-medium leading-4 text-destructive"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span>{t("healthPurgeBlocked")}</span></p> : null}
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs leading-4 text-muted-foreground tabular-nums">
            <span>{t("healthAttempt", { attempt: job.attempt, max: job.maxAttempts })}</span>
            {job.exhausted ? <span className="font-medium text-destructive">{t("healthExhausted")}</span> : null}
            <span>{t(view === "expired" ? "healthLeaseTime" : "healthAvailable", { date: formatDate(view === "expired" ? job.leaseExpiresAt! : job.availableAt) })}</span>
          </p>
        </div>
        {job.state === "failed" ? <Button variant="outline" className="min-h-11 w-full sm:w-auto sm:shrink-0" aria-busy={busy === job.jobId} disabled={busy !== null} onClick={() => void requeue(job)}>
          {busy === job.jobId ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}{t("healthRequeue")}
        </Button> : null}
      </li>)}
    </ul>}
    {jobs.status !== "Exhausted" ? <Button variant="outline" className="min-h-11 w-full sm:w-auto" disabled={jobs.status !== "CanLoadMore"} onClick={() => jobs.loadMore(25)}>{t("loadOlder")}</Button> : null}
  </div>;
}
