import { getRouteApi } from "@tanstack/react-router";
import type { CustomerTicketFilter } from "@/app/workspace-search";
import { errorCode } from "../../../shared/errors";
import { LanguageSelector } from "@/components/auth-screens";
import { NoProjects, ProjectSwitcher, useCurrentProject } from "@/components/project-controls";
import { statusMeta } from "@/components/ticket-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { CustomerTicketWizard } from "@/features/tickets/customer-ticket-wizard";
import { useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { ticketProgress } from "@/lib/ticket-ui";
import { type ProjectSummary, type TicketStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Headphones,
  Images,
  Loader2,
  LogOut,
  MapPin,
  Plus,
  Sparkles,
  UserRound
} from "lucide-react";
import { Component, useCallback, useMemo, type ReactNode } from "react";
import type { TicketSummary as TicketSummaryRow } from "../../../shared/ticket-contracts";
import { useCustomerTickets } from "./adapter";
import { CustomerTicketDialog } from "./customer-ticket-dialog";
import { useComposer } from "./use-composer";

const customerRoute = getRouteApi("/customer");

function ticketMatchesFilter(status: TicketStatus, filter: CustomerTicketFilter) {
  if (filter === "all") return true;
  if (filter === "active") return status !== "waiting" && status !== "done";
  return status === filter;
}

/**
 * The customer portal: only the tickets this account owns, and only the actions
 * a customer is allowed to perform — create, view, edit, annotate, delete. Status
 * changes, archive restore, and the board itself stay staff-only, enforced on the
 * server as well as hidden here.
 */
export function CustomerPortal({
  token,
  email,
  onLogout,
}: {
  token: string;
  email: string | null;
  onLogout: () => Promise<void>;
}) {
  const { language, setLanguage, t } = useI18n();
  const navigate = customerRoute.useNavigate();
  const { project: requestedProject, filter, ticket } = customerRoute.useSearch();
  const navigateProject = useCallback((key: string, replace: boolean) => {
    void navigate({
      search: (current) => ({ ...current, project: key, ticket: replace ? current.ticket : undefined }),
      replace,
    });
  }, [navigate]);
  const { projects, current: project, select: selectProject } = useCurrentProject(token, requestedProject, navigateProject);
  const composer = useComposer(project, onLogout);

  function selectTicket(id: Id<"tickets">) {
    void navigate({ search: (current) => ({ ...current, ticket: id }), resetScroll: false });
  }

  function closeTicket() {
    void navigate({
      search: (current) => current.ticket === ticket ? { ...current, ticket: undefined } : current,
      replace: true, resetScroll: false,
    });
  }

  function setFilter(value: CustomerTicketFilter) {
    void navigate({
      search: (current) => ({ ...current, filter: value === "all" ? undefined : value }),
      replace: true, resetScroll: false,
    });
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--secondary)/0.8),transparent_32rem)]">
      <header className="sticky top-0 z-20 border-b bg-card/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Headphones className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-5">{t("appName")}</p>
              <p className="truncate text-xs leading-4 text-muted-foreground">{t("customerPortal")}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {projects && project ? <ProjectSwitcher projects={projects} current={project} onSelect={selectProject} /> : null}
            <LanguageSelector language={language} onChange={setLanguage} />
            <Button variant="ghost" size="icon" onClick={() => void composer.signOut()} aria-label={t("signOut")}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
        <section className="relative overflow-hidden rounded-2xl border border-primary/15 bg-primary px-5 py-7 text-primary-foreground shadow-lg shadow-primary/10 sm:px-8 sm:py-9">
          <div className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full bg-white/10 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-28 right-28 size-56 rounded-full bg-cyan-300/15 blur-2xl" />
          <div className="relative flex flex-col gap-7 md:flex-row md:items-end md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/90">
                <Sparkles className="size-3.5" aria-hidden="true" />
                {t("customerSupport")}
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("customerPortalTitle")}</h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/75 sm:text-base">{t("customerPortalIntro")}</p>
              {email ? (
                <p className="mt-5 flex items-center gap-2 text-xs text-white/70 sm:text-sm">
                  <UserRound className="size-4" aria-hidden="true" />
                  {t("signedInAs", { email })}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="w-full shrink-0 rounded-xl bg-white text-primary shadow-md hover:bg-white/90 md:w-auto"
              aria-expanded={composer.open}
              disabled={!project && !composer.owner}
              onClick={composer.show}
            >
              <Plus className="size-5" />
              {t("newTicket")}
            </Button>
          </div>
        </section>

        <ProjectTicketsBoundary key={project?._id ?? "none"}>
          <CustomerTickets token={token} project={project} filter={filter ?? "all"} setFilter={setFilter} onNewTicket={composer.show} onSelect={selectTicket} />
        </ProjectTicketsBoundary>
      </div>

      <Dialog
        open={composer.open}
        initialFocus={() => document.getElementById("customer-ticket-title")}
        onOpenChange={composer.setOpen}
        title={t("newTicket")}
        description={composer.project ? `${composer.project.name} (${composer.project.key})` : t("customerPortalSubtitle")}
      >
        {composer.owner ? <Button type="button" variant="outline" disabled={composer.busy} onClick={composer.discard}>{t("discardDraft")}</Button> : null}
        {composer.project ? (
          <CustomerTicketWizard
            key={composer.project._id}
            token={token}
            draftOwner={composer.owner!}
            active={composer.open}
            onSubmitted={composer.complete}
          />
        ) : null}
      </Dialog>

      <CustomerTicketDialog
        key={project?._id}
        token={token}
        ticketId={ticket}
        projectId={project === null ? null : project?._id}
        onClose={closeTicket}
      />
    </main>
  );
}

/** Access can disappear before the Project subscription changes. Keep the draft
 * owner outside this boundary so a stale list subscription cannot dispose it. */
class ProjectTicketsBoundary extends Component<{ children: ReactNode }, { denied: boolean }> {
  state = { denied: false };
  static getDerivedStateFromError(error: unknown) {
    if (errorCode(error) !== "PROJECT_NOT_FOUND") throw error;
    return { denied: true };
  }
  render() { return this.state.denied ? <NoProjects /> : this.props.children; }
}

function CustomerTickets({ token, project, filter, setFilter, onNewTicket, onSelect }: {
  token: string;
  project: ProjectSummary | null | undefined;
  filter: CustomerTicketFilter;
  setFilter: (filter: CustomerTicketFilter) => void;
  onNewTicket: () => void;
  onSelect: (id: Id<"tickets">) => void;
}) {
  const { t } = useI18n();
  const page = useCustomerTickets(token, project?._id);
  const tickets = page.results;

  const ticketCounts = useMemo(() => {
    const rows = tickets ?? [];
    return {
      all: rows.length,
      active: rows.filter((ticket) => ticketMatchesFilter(ticket.status, "active")).length,
      waiting: rows.filter((ticket) => ticket.status === "waiting").length,
      done: rows.filter((ticket) => ticket.status === "done").length,
    };
  }, [tickets]);
  const visibleTickets = useMemo(
    () => (tickets ?? []).filter((ticket) => ticketMatchesFilter(ticket.status, filter)),
    [filter, tickets],
  );
  const filters: Array<{ value: CustomerTicketFilter; label: string; count: number }> = [
    { value: "all", label: t("allTickets"), count: ticketCounts.all },
    { value: "active", label: t("activeTickets"), count: ticketCounts.active },
    { value: "waiting", label: t("awaitingReply"), count: ticketCounts.waiting },
    { value: "done", label: t("resolvedTickets"), count: ticketCounts.done },
  ];

  return (
    <>
        <p className="mt-4 text-sm text-muted-foreground">{t("loadedCountsHint")}</p>
        <section aria-label={t("ticketSummary")} className="mt-5 grid grid-cols-3 gap-2 sm:gap-4">
          <TicketSummary icon={CircleDot} label={t("activeTickets")} value={ticketCounts.active} tone="text-sky-700 bg-sky-50" />
          <TicketSummary icon={Clock3} label={t("awaitingReply")} mobileLabel={t("awaitingReplyShort")} value={ticketCounts.waiting} tone="text-violet-700 bg-violet-50" />
          <TicketSummary icon={CheckCircle2} label={t("resolvedTickets")} value={ticketCounts.done} tone="text-emerald-700 bg-emerald-50" />
        </section>

        <section className="mt-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{t("yourTickets")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {project === null ? t("noProjectsTitle") : t("loadedTickets", { count: tickets.length })}
              </p>
            </div>
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border bg-card p-1 shadow-sm" aria-label={t("filterTickets")}>
              {filters.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setFilter(item.value)}
                  aria-pressed={filter === item.value}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === item.value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {item.label}
                  <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] tabular-nums", filter === item.value ? "bg-white/20" : "bg-muted text-foreground")}>
                    {item.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="mt-4">
        {project === null ? (
          <NoProjects />
        ) : page.status === "LoadingFirstPage" ? (
          <div className="grid min-h-72 place-items-center rounded-2xl border bg-card shadow-sm">
            <div className="space-y-3 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto size-7 animate-spin" />
              <p>{t("syncingTickets")}</p>
            </div>
          </div>
        ) : tickets.length === 0 ? (
          <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed bg-card px-6 text-center shadow-sm">
            <div className="max-w-sm space-y-3">
              <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
                <Sparkles className="size-5" />
              </div>
              <p className="text-lg font-semibold">{t("myTicketsEmpty")}</p>
              <p className="text-sm leading-6 text-muted-foreground">{t("myTicketsEmptyHint")}</p>
              <Button className="mt-1 rounded-xl" type="button" onClick={onNewTicket}>
                <Plus /> {t("newTicket")}
              </Button>
            </div>
          </div>
        ) : visibleTickets.length === 0 ? (
          <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed bg-card px-6 text-center">
            <div>
              <p className="font-semibold">{t("noFilteredTickets")}</p>
              <Button type="button" variant="ghost" className="mt-2" onClick={() => setFilter("all")}>{t("showAllTickets")}</Button>
            </div>
          </div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {visibleTickets.map((ticket) => (
              <li key={ticket._id}>
                <CustomerTicketCard item={ticket} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
        </div>
        {page.status !== "Exhausted" && project ? <Button className="mt-4" disabled={page.status !== "CanLoadMore"} onClick={() => page.loadMore(20)}>{t("loadOlder")}</Button> : null}
    </>
  );
}

function TicketSummary({
  icon: Icon,
  label,
  mobileLabel,
  value,
  tone,
}: {
  icon: typeof CircleDot;
  label: string;
  mobileLabel?: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-card p-3 shadow-sm sm:gap-3 sm:p-4">
      <div className={cn("hidden size-10 shrink-0 place-items-center rounded-xl sm:grid", tone)}>
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground sm:text-sm">
          {mobileLabel ? <><span className="sm:hidden">{mobileLabel}</span><span className="hidden sm:inline">{label}</span></> : label}
        </p>
      </div>
    </div>
  );
}

const statusHintKeys: Record<TicketStatus, "statusNextNew" | "statusNextAcknowledged" | "statusNextInProgress" | "statusNextWaiting" | "statusNextDone"> = {
  new: "statusNextNew",
  acknowledged: "statusNextAcknowledged",
  in_progress: "statusNextInProgress",
  waiting: "statusNextWaiting",
  done: "statusNextDone",
};

function CustomerTicketCard({ item, onSelect }: { item: TicketSummaryRow; onSelect: (id: Id<"tickets">) => void }) {
  const { t, formatDate } = useI18n();
  const meta = statusMeta(item.status);
  const StatusIcon = meta.icon;
  const progress = ticketProgress(item.status);
  const pinCount = item.annotationCount;
  const ticketLabel = formatTicketNumber(item.ticketNumber, item.projectKey);

  return (
    <article className={cn("group relative overflow-hidden rounded-2xl border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md", item.status === "waiting" && "border-violet-200 bg-violet-50/20")}>
      <button
        type="button"
        className="absolute inset-0 z-10 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t("viewTicket", { ticket: ticketLabel })}
        onClick={() => onSelect(item._id)}
      />
      <div className="flex min-h-52 flex-col sm:min-h-48 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("gap-1.5 rounded-full border px-2.5 py-1", meta.tone)}>
              <StatusIcon className="size-3.5" aria-hidden="true" />
              {t(meta.labelKey)}
            </Badge>
            <span className="font-mono text-xs font-semibold text-muted-foreground">{ticketLabel}</span>
            <span className="text-xs text-muted-foreground">· {formatDate(item.createdAt)}</span>
          </div>
          <h3 className="mt-3 line-clamp-2 text-base font-semibold leading-6 group-hover:text-primary">{item.title}</h3>
          <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{item.excerpt || t("noDescription")}</p>

          <div className="mt-auto pt-4">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className={cn("font-medium", item.status === "waiting" ? "text-violet-700" : "text-muted-foreground")}>{t(statusHintKeys[item.status])}</span>
              <span className="shrink-0 font-semibold tabular-nums">{progress.percent}%</span>
            </div>
            <Progress value={progress.percent} className="h-1.5" aria-label={t("ticketProgress", { ticket: ticketLabel, step: progress.step, total: progress.total, percent: progress.percent })} />
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              {item.mediaCount > 0 ? <span className="flex items-center gap-1"><Images className="size-3.5" />{item.mediaCount}</span> : null}
              {pinCount > 0 ? <span className="flex items-center gap-1"><MapPin className="size-3.5" />{pinCount}</span> : null}
              <span className="ml-auto inline-flex items-center gap-1 font-medium text-primary">{t("openTicket")}<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
