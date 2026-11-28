import { TicketInbox } from "./ticket-inbox";
import { isTicketSearchWithinLimits, type TicketSummary } from "../../../shared/ticket-contracts";
import { errorCode } from "../../../shared/errors";
import { DiscardTicketDraft } from "./discard-ticket-draft";
import type { DisposableTicketDraft } from "./draft";
import { queueNeighbors } from "@/lib/staff-ticket-queue";
import { LanguageMenuGroup } from "@/components/language-menu";
import { NoProjects, ProjectSwitcher, useCurrentProject } from "@/components/project-controls";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CustomerTicketWizard } from "./customer-ticket-wizard";
import { useI18n } from "@/lib/i18n";
import { type ProjectSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { ChevronDown, ChevronRight, Copy, KeyRound, Loader2, LogOut, PenLine, Plus, UserRound } from "lucide-react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { useCustomerTickets, useCustomerTicketSearch, useWorkspaceTicket } from "./adapter";
import { TicketSearchInput } from "./ticket-search-input";
import { CustomerTicketDialog } from "./customer-ticket-dialog";
import { customerQueue, customerQueueCounts, type CustomerQueueFilter } from "./customer-queue";
import { useComposer } from "./use-composer";
import { CustomerTicketRow } from "./customer-ticket-row";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, useMenuAction,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceNavigation } from "./use-workspace-navigation";

const EMPTY_TICKETS: TicketSummary[] = [];

const CustomerAccount = lazy(() => import("@/components/account-dialogs").then(module => ({ default: module.CustomerAccount })));

export function CustomerPortal({ viewer, onLogout }: {
  viewer: { username: string; displayName: string; email?: string | null; clerkManaged?: boolean; needsRecoveryCode: boolean }; onLogout: () => Promise<void>;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const { t, language } = useI18n();
  const navigation = useWorkspaceNavigation("customer");
  const { ticket, project: requestedProject, selectProject: selectWorkspaceProject } = navigation;
  const canonicalizeProject = useCallback((key: string, replace: boolean) => {
    // Keep an invalid deep link visible until the customer closes its unavailable Ticket.
    if (replace && ticket && requestedProject && requestedProject !== key) return;
    selectWorkspaceProject(key, replace);
  }, [requestedProject, selectWorkspaceProject, ticket]);
  const { projects, current: project, select: selectProject } = useCurrentProject(navigation.project, canonicalizeProject);
  const composer = useComposer(project, onLogout);
  const toolsMenu = useMenuAction();
  const projectId = project?._id;
  const matchesProject = Boolean(project && (!navigation.project || navigation.project === project.key));
  const workspaceTicket = useWorkspaceTicket(matchesProject ? ticket : null, projectId);
  const selected = projects === undefined || matchesProject ? workspaceTicket : null;
  const selectedId = selected?._id ?? null;
  const [visible, setVisible] = useState<{ projectId?: Id<"projects">; ids?: Id<"tickets">[] }>({});
  const visibleIds = visible.projectId === projectId ? visible.ids ?? [] : [];
  const setVisibleIds = useCallback((ids: Id<"tickets">[] | undefined) => setVisible({ projectId, ids }), [projectId]);
  const previousSelection = useRef(ticket);
  const focusTicket = useRef<Id<"tickets"> | null>(null);
  if (selectedId) focusTicket.current = selectedId;
  const scrollOrigin = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = ticket;
    if (!previous || ticket) return;
    const frame = requestAnimationFrame(() => {
      if (scrollOrigin.current !== null) window.scrollTo({ top: scrollOrigin.current, behavior: "instant" });
      scrollOrigin.current = null;
      // Filtering can close detail while focus remains in the search or filter controls.
      // Browser Back removes the focused panel; recover that lost focus only.
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
      const row = focusTicket.current && document.querySelector<HTMLElement>(`button[data-ticket-id="${CSS.escape(focusTicket.current)}"]`);
      const target = row?.getClientRects().length ? row : document.getElementById("customer-tickets-heading");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ticket]);
  const sequence = useRef<Id<"tickets">[]>([]);
  const previousProject = useRef(project?._id);
  if (previousProject.current !== project?._id) {
    previousProject.current = project?._id;
    sequence.current = [];
  }
  function openTicket(id: Id<"tickets">) {
    sequence.current = visibleIds;
    scrollOrigin.current = window.scrollY;
    navigation.openTicket(id);
  }
  if (selectedId && sequence.current.length === 0 && visibleIds.includes(selectedId)) sequence.current = visibleIds;
  const { previous: previousId, next: nextId } = queueNeighbors(selectedId, visibleIds, sequence.current);
  const foreignDraft = composer.foreignDraft;
  const composerLabel = foreignDraft
    ? (language === "th" ? "ทำฉบับร่างต่อ" : "Continue draft")
    : t(composer.hasDraft ? "resumeTicket" : "newTicket");
  const draftStrip = composer.hasDraft && !composer.open && !ticket;
  function discardDraft() {
    composer.discard();
    requestAnimationFrame(() => document.getElementById("customer-new-ticket")?.focus());
  }

  return <main className="aurora-canvas min-h-screen px-3 sm:px-5 sm:pt-3">
    <a href={ticket ? "#customer-ticket-detail" : "#customer-results-heading"} onClick={event => {
      const heading = document.querySelector<HTMLElement>(event.currentTarget.hash) ?? document.getElementById("customer-tickets-heading");
      if (!heading) return;
      event.preventDefault();
      heading.focus();
    }} className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-background focus:p-3 focus:ring-2 focus:ring-ring">{t("skipToTickets")}</a>
    {/* Phones get one flat, full-bleed 44px bar: Project key, labeled create, inbox and account. */}
    <header className="aurora-toolbar sticky top-0 z-30 mx-auto max-w-6xl max-sm:-mx-3 max-sm:rounded-none max-sm:border-x-0 max-sm:border-t-0 max-sm:shadow-none max-sm:[&_button:focus-visible]:ring-inset">
      <div className="flex min-h-11 min-w-0 items-center gap-1 px-1 sm:flex-wrap sm:gap-3 sm:px-4 sm:py-1">
        <div className="min-w-[4.25rem] flex-1 sm:min-w-0">
          {projects && project ? <ProjectSwitcher compact projects={projects} current={project} onSelect={selectProject} />
            : <p className="truncate px-2 text-sm font-medium">{viewer.displayName}</p>}
        </div>
        {(project || composer.owner) && <Button className="glass-action h-auto min-h-11 min-w-11 max-w-full shrink gap-1 rounded-lg whitespace-normal px-2.5 text-sm leading-tight font-semibold max-[359px]:[&_svg]:hidden sm:px-4" type="button" id="customer-new-ticket"
          aria-describedby={draftStrip ? "customer-draft-project" : undefined} aria-expanded={composer.open} onClick={composer.show}>
          {composer.hasDraft ? <PenLine aria-hidden="true" /> : <Plus aria-hidden="true" />}{composerLabel}
        </Button>}
        {project && <TicketInbox role="customer" compact key={project._id} projectId={project._id} projectKey={project.key} openTicket={openTicket} />}
        <DropdownMenu {...toolsMenu.root}>
          <DropdownMenuTrigger ref={toolsMenu.triggerRef} render={<Button type="button" variant="outline" className="min-h-11 min-w-11 shrink-0 gap-1.5 rounded-lg px-2" />}
            aria-label={t("customerQueueMore")} title={t("customerQueueMore")}>
            <UserRound aria-hidden="true" /><span className="hidden sm:inline">{t("accountTitle")}</span><ChevronDown className="hidden text-muted-foreground sm:block" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 max-w-[var(--available-width)]">
            <p className="break-all px-2.5 py-1.5 text-xs text-muted-foreground">{viewer.displayName} · {viewer.email ?? viewer.username}</p>
            <DropdownMenuItem onClick={() => toolsMenu.run(() => setAccountOpen(true))}><UserRound aria-hidden="true" />{t("accountTitle")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <LanguageMenuGroup />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => toolsMenu.run(() => { void composer.signOut(); })}><LogOut aria-hidden="true" />{t("signOut")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    <Dialog open={accountOpen} onOpenChange={setAccountOpen} title={t("accountTitle")} description={t("accountSignedInAs", { username: viewer.username })}>
      <Suspense fallback={<p role="status">{t("syncing")}</p>}>
        <CustomerAccount clerkManaged={viewer.clerkManaged} hasRecoveryCode={!viewer.needsRecoveryCode} />
      </Suspense>
    </Dialog>
    <div className={cn("mx-auto py-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:py-5", ticket ? "max-w-6xl" : "max-w-3xl")}>
      {viewer.needsRecoveryCode && !ticket && <RecoveryReminder onOpen={() => setAccountOpen(true)} />}
      <h1 id="customer-tickets-heading" data-dialog-return-focus tabIndex={-1} className={cn("mb-2 scroll-mt-20 text-xl font-semibold sm:mb-3 tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-3xl", ticket && "hidden lg:block")}>{t("yourTickets")}</h1>
      {draftStrip && composer.owner && composer.project
        ? <DraftStrip owner={composer.owner} project={composer.project} foreign={foreignDraft} busy={composer.busy}
            onDiscard={discardDraft} onStartCurrent={composer.startCurrentProject} /> : null}
      <div className={cn("grid items-start gap-4", ticket && "lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]")}>
        <ProjectTicketsBoundary key={project?.key ?? requestedProject ?? "none"}>
          <CustomerTickets project={project} email={viewer.email} composerLabel={composerLabel} onNewTicket={composer.show} onSelect={openTicket}
            ticketOpen={Boolean(ticket)} selectedId={selectedId} filter={navigation.filter} query={navigation.query}
            onFilter={navigation.setFilter} onQuery={navigation.setQuery} onVisibleIds={setVisibleIds} />
        </ProjectTicketsBoundary>
        <CustomerTicketDialog ticket={selected} ticketId={ticket} onClose={navigation.closeTicket}
          inResults={selectedId && visible.projectId === projectId ? visible.ids?.includes(selectedId) : undefined}
          inline initialSection={navigation.section} onPrevious={previousId ? () => navigation.changeTicket(previousId) : undefined}
          onNext={nextId ? () => navigation.changeTicket(nextId) : undefined} />
      </div>
      {viewer.needsRecoveryCode && ticket && <RecoveryReminder className="mt-4" onOpen={() => setAccountOpen(true)} />}
    </div>
    <Dialog open={composer.open} mobileFullScreen dismissible={!composer.busy} initialFocus={() => document.querySelector<HTMLElement>("[data-composer-step-heading]") ?? document.getElementById("customer-ticket-title")} onOpenChange={composer.setOpen}
      title={t("newTicket")} description={composer.project ? `${composer.project.name} (${composer.project.key})` : t("customerPortalSubtitle")}>

      {composer.project ? <CustomerTicketWizard key={composer.project._id} draftOwner={composer.owner!}
        active={composer.open} onSubmitted={id => {
          const createdProject = composer.project;
          composer.complete();
          if (id) {
            sequence.current = createdProject?._id === projectId ? [id, ...visibleIds.filter(item => item !== id)] : [];
            navigation.openTicket(id, undefined, createdProject && createdProject._id !== project?._id ? { key: createdProject.key } : undefined);
          }
        }} /> : null}
      {composer.hasDraft && composer.owner && <div className="mt-3"><DiscardTicketDraft busy={composer.busy} owner={composer.owner} onDiscard={composer.discard} /></div>}
    </Dialog>
  </main>;
}

/** Keep draft ownership outside a denied Project subscription. */
class ProjectTicketsBoundary extends Component<{ children: ReactNode }, { denied: boolean }> {
  state = { denied: false };
  static getDerivedStateFromError(error: unknown) {
    if (errorCode(error) !== "PROJECT_NOT_FOUND") throw error;
    return { denied: true };
  }
  render() { return this.state.denied ? <ProjectUnavailable /> : this.props.children; }
}

function RecoveryReminder({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const { t } = useI18n();
  return <div role="status" className={cn("aurora-inset mb-3 rounded-xl px-3 sm:mb-4 sm:pb-2", className)}>
    <button type="button" onClick={onOpen} aria-describedby="customer-recovery-hint"
      className="flex min-h-11 w-full items-center gap-3 rounded-xl text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <KeyRound aria-hidden className="size-5 shrink-0 text-amber-800 dark:text-amber-200" />
      <span className="min-w-0 flex-1 text-sm font-semibold">{t("recoveryCodeCreate")}</span>
      <ChevronRight aria-hidden className="size-4 shrink-0" />
    </button>
    <p id="customer-recovery-hint" className="pl-8 text-xs leading-5 text-muted-foreground max-sm:sr-only">{t("recoveryCodeNeeded")}</p>
  </div>;
}

/** Names the unsent draft beside the list; the header button continues it. */
function DraftStrip({ owner, project, foreign, busy, onDiscard, onStartCurrent }: {
  owner: DisposableTicketDraft; project: ProjectSummary; foreign: boolean; busy: boolean; onDiscard: () => void; onStartCurrent: () => void;
}) {
  const { t } = useI18n();
  const title = useSyncExternalStore(owner.subscribe, () => owner.getSnapshot().title).trim();
  return <div role="status" className="aurora-inset mb-4 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl px-3.5 py-2.5 text-sm sm:items-center">
    <PenLine aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary sm:mt-0" />
    <p id="customer-draft-project" className="min-w-0 flex-1 basis-56">
      <span className="font-semibold text-foreground">{t("customerQueueDraftLabel")}: </span>
      <span className="break-words text-foreground [overflow-wrap:anywhere]">{title || t("composerUntitled")}</span>
      <span className="block text-xs text-muted-foreground">
        {foreign ? t("customerQueueDraftProject", { project: project.name }) : `${project.name} (${project.key}) · ${t("customerQueueDraftHint")}`}
      </span>
      <span className="block text-xs text-muted-foreground">{t("draftSessionHint")}</span>
    </p>
    <div className="-my-1 ml-auto flex flex-wrap">
      {foreign && <DiscardTicketDraft busy={busy} owner={owner} startCurrent onDiscard={onStartCurrent} />}
      <DiscardTicketDraft busy={busy} owner={owner} onDiscard={onDiscard} />
    </div>
  </div>;
}

function ProjectUnavailable() {
  const { t } = useI18n();
  return <p role="alert" className="aurora-panel p-4 text-sm text-foreground">{t("projectMissing")}</p>;
}

function CustomerTickets({ project, email, composerLabel, onNewTicket, onSelect, selectedId, ticketOpen, filter, query, onFilter, onQuery, onVisibleIds }: {
  project: ProjectSummary | null | undefined; email?: string | null; composerLabel: string; onNewTicket: () => void;
  onSelect: (id: Id<"tickets">) => void; selectedId: Id<"tickets"> | null; ticketOpen: boolean;
  filter: string; query: string; onFilter: (filter: string | undefined) => void; onQuery: (query: string) => void;
  onVisibleIds: (ids: Id<"tickets">[] | undefined) => void;
}) {
  const { t, language } = useI18n();
  const statusScope = filter === "all" || filter === "waiting" || filter === "done" ? filter : "active";
  const all = useCustomerTickets(project?._id, "all");
  const scoped = useCustomerTickets(project?._id, statusScope, statusScope !== "all");
  const page = statusScope === "all" ? all : scoped;
  const loaded = page.status !== "LoadingFirstPage" && !page.scanning;
  const counts = useMemo(() => customerQueueCounts(all.results), [all.results]);
  const browseTickets = useMemo(() => customerQueue(page.results, statusScope), [page.results, statusScope]);
  const text = query.trim();
  const searching = text.length > 0;
  const invalidSearch = !isTicketSearchWithinLimits(text);
  const [settledText, setSettledText] = useState(text);
  useEffect(() => {
    if (text === settledText) return;
    const timer = window.setTimeout(() => setSettledText(text), 300);
    return () => window.clearTimeout(timer);
  }, [text, settledText]);
  const search = useCustomerTicketSearch(project?._id, text === settledText && !invalidSearch ? text : "", statusScope);
  const pending = searching ? !invalidSearch && search === undefined : !loaded;
  const visibleTickets = pending ? EMPTY_TICKETS : searching ? search?.matches ?? EMPTY_TICKETS : browseTickets;
  useEffect(() => {
    onVisibleIds(pending ? undefined : visibleTickets.map(item => item._id));
  }, [pending, visibleTickets, onVisibleIds]);

  // Phones show a short visible word inside the full accessible name, so all four fit one row.
  const options = [
    { value: "active", label: t("customerQueueAllActive"), short: language === "th" ? "ยังดำเนินการ" : "Active" },
    { value: "waiting", label: t("customerQueueWaiting"), short: t("customerQueueWaiting") },
    { value: "done", label: t("resolvedTickets"), short: t("resolvedTickets") },
    { value: "all", label: t("allTickets"), short: t("allTickets") },
  ] as const;
  const countLabel = searching
    ? t(search?.hasMore ? "searchLoaded" : "searchMatches", { count: visibleTickets.length })
    : t("loadedTickets", { count: visibleTickets.length });
  const loadingOlder = language === "th" ? "กำลังโหลด Ticket เก่ากว่า…" : "Loading older Tickets…";
  const results = useRef<HTMLHeadingElement>(null);

  function selectFilter(value: CustomerQueueFilter) {
    if (value !== statusScope) onFilter(value === "active" ? undefined : value);
    requestAnimationFrame(() => results.current?.focus());
  }

  if (project === null) return <NoProjects account={email ? <div className="space-y-2">
    <p className="break-all text-sm">{email}</p>
    <Button className="min-h-11" variant="outline" onClick={async () => {
      try {
        await navigator.clipboard.writeText(email);
        toast.success(language === "th" ? "คัดลอกอีเมลแล้ว" : "Email copied");
      } catch {
        toast.error(language === "th" ? "คัดลอกอีเมลไม่สำเร็จ" : "Unable to copy email");
      }
    }}><Copy aria-hidden />{language === "th" ? "คัดลอกอีเมล" : "Copy email"}</Button>
  </div> : undefined} />;

  return <section className={cn("min-w-0", ticketOpen && "hidden lg:block")} aria-labelledby="customer-results-heading">
    {/* Flat on phones: the search field and one row of status chips sit directly on the page. */}
    <div className="aurora-toolbar mb-2 space-y-2 max-sm:border-0 max-sm:bg-transparent max-sm:bg-none max-sm:p-0 max-sm:shadow-none max-sm:backdrop-blur-none sm:mb-3 sm:p-3.5">
      <TicketSearchInput className="min-w-0 space-y-1 text-sm font-medium text-foreground"
        value={query} onChange={onQuery} onClear={() => onQuery("")} label={t("customerQueueSearch")} />
      <div role="group" aria-label={t("filterTickets")} aria-describedby="customer-filter-count-label" className="flex flex-wrap gap-1.5 sm:grid sm:grid-cols-4">
        {options.map(item => {
          const active = statusScope === item.value;
          const count = active && !pending ? visibleTickets.length : counts[item.value];
          const showCount = !pending && !searching && (active || all.status !== "LoadingFirstPage");
          return <button key={item.value} type="button" aria-pressed={active} onClick={() => selectFilter(item.value)}
            className={cn("flex min-h-11 min-w-11 flex-auto items-center justify-center gap-1 rounded-full border px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere] sm:justify-between sm:rounded-lg sm:px-2 sm:text-left",
              active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card/85 text-foreground hover:border-primary/45")}>
            <span aria-hidden="true" className="sm:hidden">{item.short}</span><span className="max-sm:sr-only">{item.label}</span>
            {/* Loaded-item counts need the wider layout to read as counts, not totals; phones keep the status line below. */}
            {!searching && <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums max-sm:hidden", active ? "bg-primary-foreground text-primary" : "bg-muted text-muted-foreground")}>
              {showCount ? count : <span className="block h-2 w-2" aria-hidden="true" />}
            </span>}
          </button>;
        })}
      </div>
      <p id="customer-filter-count-label" className="sr-only">{language === "th" ? "จำนวน Ticket ที่โหลดแล้วตามสถานะ" : "Counts reflect loaded Tickets by status"}</p>
    </div>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-1 pb-1.5 sm:block sm:pb-0">
      <h2 id="customer-results-heading" ref={results} tabIndex={-1} className="scroll-mt-20 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pb-1">
        {options.find(item => item.value === statusScope)?.label}
      </h2>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground sm:pb-2">
        {invalidSearch ? "" : pending ? t("syncingTickets") : page.status === "LoadingMore" && !searching ? loadingOlder : countLabel}
      </p>
    </div>
    {invalidSearch ? <p role="alert" className="ticket-surface p-5 text-sm text-destructive">{t("searchLimit")}</p>
      : pending ? <div className="ticket-surface grid min-h-24 place-items-center" aria-hidden="true"><Loader2 className="size-5 animate-spin text-primary" /></div>
      : !searching && all.status === "Exhausted" && all.results.length === 0
        ? <div className="aurora-panel space-y-3 p-6"><h3 className="font-semibold text-foreground">{t("myTicketsEmpty")}</h3><p className="text-sm text-muted-foreground">{t("myTicketsEmptyHint")}</p><Button variant="outline" className="min-h-11 rounded-lg" onClick={onNewTicket}><Plus aria-hidden />{composerLabel}</Button></div>
      : visibleTickets.length ? <ul className="max-sm:border-t max-sm:border-border/70 sm:space-y-2">{visibleTickets.map(ticket => <li key={ticket._id}><CustomerTicketRow item={ticket} selected={ticket._id === selectedId} onSelect={onSelect} /></li>)}</ul>
      : <div className="ticket-surface space-y-3 p-5 text-sm"><p className="text-foreground">{t(searching ? "customerQueueSearchEmpty" : "customerQueueEmpty")}</p>{statusScope !== "all" && <Button variant="outline" className="min-h-11 rounded-lg" onClick={() => selectFilter("all")}>{t(searching ? "customerQueueSearchAllStatuses" : "showAllTickets")}</Button>}</div>}
    {!searching && loaded && (page.status !== "Exhausted" || page.results.length > 20) ? <Button className="mt-4 min-h-11 rounded-lg"
      aria-disabled={page.status !== "CanLoadMore"} onClick={() => { if (page.status === "CanLoadMore") page.loadMore(20); }}>
      {page.status === "LoadingMore" ? <Loader2 aria-hidden className="animate-spin" /> : null}
      {page.status === "LoadingMore" ? loadingOlder : page.status === "Exhausted" ? (language === "th" ? "โหลดครบแล้ว" : "All Tickets loaded") : t("loadOlder")}
    </Button> : null}
  </section>;
}
