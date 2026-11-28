import { useId, useRef, useState } from "react";
import { CircleCheck, CircleMinus, CircleSlash, Clock3, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { FilterChoices, TicketFilterPopover } from "@/components/ticket-filter-popover";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { APP_PATHS } from "@/lib/app-routes";
import { localizeError, useI18n } from "@/lib/i18n";
import { useStaffCopy } from "@/lib/staff-copy";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { cn } from "@/lib/utils";
import { useHealth, useJobDiagnostics } from "./adapters/health";

import { stateTotals } from "./health-totals";

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
  const s = useStaffCopy();
  const health = useHealth();
  const [view, setView] = useState<"failed" | "pending" | "expired">("failed");
  const currentView = diagnosticViews.find(option => option.value === view) ?? diagnosticViews[0];
  const counts = useId();
  if (!health) return <p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>;
  const totals = stateTotals(health.counts);
  const { uploadThingToken, callbackSecret, mediaCleanupEnabled } = health.configuration;
  // Credentials are Configured or Missing; cleanup is an intentional switch, Enabled or Disabled.
  const rows = [
    { label: s.storageLabel, ok: uploadThingToken, state: uploadThingToken ? s.configured : s.missing, effect: s.storageEffect(uploadThingToken), Icon: uploadThingToken ? CircleCheck : CircleSlash },
    { label: s.callbackLabel, ok: callbackSecret, state: callbackSecret ? s.configured : s.missing, effect: s.callbackEffect(callbackSecret), Icon: callbackSecret ? CircleCheck : CircleSlash },
    { label: s.cleanupLabel, ok: mediaCleanupEnabled, state: mediaCleanupEnabled ? s.enabled : s.disabled, effect: s.cleanupEffect(mediaCleanupEnabled), Icon: mediaCleanupEnabled ? CircleCheck : CircleMinus, intentional: true },
  ];
  return <section className="space-y-3">
    <dl className="aurora-inset divide-y divide-border/60 rounded-xl px-3 text-sm">
      {rows.map(row =>
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5" key={row.label}>
          <dt className="min-w-0 leading-5">{row.label}</dt>
          <dd className={cn("ticket-chip shrink-0 text-xs font-semibold", row.ok ? "text-emerald-700 dark:text-emerald-300" : row.intentional ? "text-muted-foreground" : "text-amber-800 dark:text-amber-300")}>
            <row.Icon aria-hidden className="size-3.5" />{row.state}
          </dd>
          <dd className="basis-full text-xs leading-4 text-muted-foreground">{row.effect}</dd>
        </div>)}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5">
        <dt className="min-w-0 leading-5">{t("healthOldest")}</dt>
        <dd className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:text-sm"><Clock3 aria-hidden className="size-3.5 shrink-0" />
          {health.oldestPendingAt === null ? t("healthNone") : formatDate(health.oldestPendingAt)}</dd>
      </div>
    </dl>
    <p className="text-xs text-muted-foreground">{s.configurationOnly}</p>
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
              const cell = cn(
                "ticket-chip py-0.5 text-xs leading-4 text-muted-foreground md:table-cell md:rounded-none md:border-t md:border-border/60 md:bg-transparent md:py-2.5 md:text-end md:text-sm md:leading-5",
                index === all.length - 1 ? "md:ps-2 md:pe-3" : "md:px-2",
                alert && "bg-destructive/10 font-semibold text-destructive md:bg-destructive/10",
              );
              return <td role="cell" key={state} className={cell}>
                <span aria-hidden className="md:hidden">{t(stateLabel)}</span>
                {alert && <ShieldAlert aria-hidden className="size-3.5 md:me-1 md:inline" />}
                <span className={cn("font-semibold tabular-nums", value > 0 && !alert && "text-foreground")}>{value}</span>
                {alert && <span className="ms-1 text-xs font-medium">{s.failedMark}</span>}
              </td>;
            })}
          </tr>)}
          <tr role="row" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2 md:table-row md:p-0">
            <th role="rowheader" scope="row" className="w-full pb-0.5 text-start text-[13px] font-semibold leading-5 md:w-auto md:border-t-2 md:border-border md:py-2.5 md:pe-2 md:ps-3 md:text-sm">{s.total}</th>
            {Object.entries(states).map(([state, stateLabel], index, all) => {
              const value = totals[state as keyof typeof states];
              const alert = state === "failed" && value > 0;
              return <td role="cell" key={state} className={cn(
                "ticket-chip py-0.5 text-xs font-semibold leading-4 md:table-cell md:rounded-none md:border-t-2 md:border-border md:bg-transparent md:py-2.5 md:text-end md:text-sm md:leading-5",
                index === all.length - 1 ? "md:ps-2 md:pe-3" : "md:px-2",
                alert ? "bg-destructive/10 text-destructive md:bg-destructive/10" : "text-foreground",
              )}>
                <span aria-hidden className="md:hidden">{t(stateLabel)}</span>
                <span className="tabular-nums">{value}</span>{alert && <span className="ms-1 text-xs font-medium">{s.failedMark}</span>}
              </td>;
            })}
          </tr>
        </tbody>
      </table>
    </div>
    <div className="space-y-2 pt-0.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 text-sm font-semibold text-foreground">{view === "expired" ? t(currentView.labelKey) : s.viewCount(t(currentView.labelKey), totals[view])}</h3>
        <TicketFilterPopover activeCount={view === "failed" ? 0 : 1} onClear={() => setView("failed")}>
          <FilterChoices label={t("healthDiagnosticView")} value={view} onChange={setView}
            options={diagnosticViews.map(option => ({ value: option.value, label: t(option.labelKey),
              // Expired leases have no aggregate counter, so that option shows no count.
              count: option.value === "expired" ? undefined : totals[option.value] }))} />
        </TicketFilterPopover>
      </div>
      <JobDiagnostics key={view} view={view} />
    </div>
  </section>;
}

function JobDiagnostics({ view }: { view: "failed" | "pending" | "expired" }) {
  const { t, formatDate } = useI18n();
  const s = useStaffCopy();
  const jobs = useJobDiagnostics(view);
  const inFlight = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmPurge, setConfirmPurge] = useState<typeof jobs.results[number] | null>(null);
  async function requeue(job: typeof jobs.results[number], confirmed = false) {
    // A purge requeue can end restoration, so it always needs the in-app confirmation first.
    if (job.kind === "ticket_purge" && !confirmed) { setConfirmPurge(job); return; }
    const jobId = job.jobId;
    if (inFlight.current.has(jobId)) return;
    inFlight.current.add(jobId);
    setBusy(new Set(inFlight.current));
    try {
      if (await jobs.requeue({ jobId })) toast.success(t("healthRequeued"));
      else toast.error(t("healthRepairRequired"));
    }
    catch (error) { toast.error(localizeError(error, t)); }
    finally { inFlight.current.delete(jobId); setBusy(new Set(inFlight.current)); }
  }
  return <div className="space-y-2.5" aria-live="polite">
    <p className="text-xs leading-4 text-muted-foreground">{t("healthPageHint")}</p>
    {jobs.status === "LoadingFirstPage" ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden className="size-4 animate-spin" />{s.loadingJobs}</p>
      : jobs.results.length === 0 ? <p className="rounded-xl border border-dashed border-border/70 px-3 py-3 text-center text-sm text-muted-foreground">{s.emptyJobs[view]}</p>
      : <ul className="space-y-2">
      {jobs.results.map(job => <li key={job.jobId} className={cn("aurora-inset flex flex-col gap-2.5 rounded-xl p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-3", job.state === "failed" && "border-destructive/40")}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-semibold leading-5 text-foreground">{t(kinds[job.kind])}</p>
            <span className={cn("ticket-chip py-0 text-xs font-medium leading-5", job.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
              {t(states[job.state])}
            </span>
          </div>
          {job.ticket ? <p className="flex flex-wrap items-center gap-x-2 text-[13px] leading-5">
            <span className="font-mono">{s.purgeTicket(formatTicketNumber(job.ticket.ticketNumber, job.ticket.projectKey))}</span>
            <a className="text-primary underline-offset-4 hover:underline" href={`${APP_PATHS.staffHome}?${new URLSearchParams({ project: job.ticket.projectKey, ...(job.ticket.archived ? { filter: "archive" } : {}), ticket: job.ticket.id })}`}>
              {job.ticket.archived ? s.openArchived : t("viewTicket", { ticket: formatTicketNumber(job.ticket.ticketNumber, job.ticket.projectKey) })}
            </a>
          </p> : null}
          {job.lastOutcome ? <p className="text-[13px] leading-5 text-foreground">{t(outcomes[job.lastOutcome])}</p> : null}
          {job.purgeBlocked ? <p className="flex items-start gap-1.5 text-xs font-medium leading-4 text-destructive"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span>{t("healthPurgeBlocked")}</span></p> : null}
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs leading-4 text-muted-foreground tabular-nums">
            <span>{t("healthAttempt", { attempt: job.attempt, max: job.maxAttempts })}</span>
            {job.exhausted ? <span className="font-medium text-destructive">{t("healthExhausted")}</span> : null}
            <span>{t(view === "expired" ? "healthLeaseTime" : "healthAvailable", { date: formatDate(view === "expired" ? job.leaseExpiresAt! : job.availableAt) })}</span>
          </p>
        </div>
        {job.state === "failed" ? <Button variant="outline" className="min-h-11 w-full sm:w-auto sm:shrink-0" aria-busy={busy.has(job.jobId)} disabled={busy.has(job.jobId)} onClick={() => void requeue(job)}>
          {busy.has(job.jobId) ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}{t("healthRequeue")}
        </Button> : null}
      </li>)}
    </ul>}
    <AlertDialog open={confirmPurge !== null} onOpenChange={open => { if (!open) setConfirmPurge(null); }}
      title={s.requeuePurgeTitle} description={s.requeuePurgeBody} confirmLabel={s.requeuePurgeConfirm}
      onConfirm={() => { const job = confirmPurge; setConfirmPurge(null); if (job) void requeue(job, true); }} />
    {jobs.status !== "Exhausted" ? <Button variant="outline" className="min-h-11 w-full sm:w-auto" disabled={jobs.status !== "CanLoadMore"} onClick={() => jobs.loadMore(25)}>{t("loadOlder")}</Button> : null}
  </div>;
}
