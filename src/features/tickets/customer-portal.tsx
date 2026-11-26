import { TicketInbox } from "./ticket-inbox";
import { isTicketSearchWithinLimits, type TicketSummary } from "../../../shared/ticket-contracts";
import { errorCode } from "../../../shared/errors";
import { DiscardTicketDraft } from "./discard-ticket-draft";
import { ProductWordmark } from "@/components/product-wordmark";
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
import { ChevronDown, ChevronRight, KeyRound, Loader2, LogOut, Plus, UserRound } from "lucide-react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  viewer: { username: string; displayName: string; clerkManaged?: boolean; needsRecoveryCode: boolean }; onLogout: () => Promise<void>;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const { t } = useI18n();
  const navigation = useWorkspaceNavigation("customer");
  const { projects, current: project, select: selectProject } = useCurrentProject(navigation.project, navigation.selectProject);
  const composer = useComposer(project, onLogout);
  const toolsMenu = useMenuAction();
  const projectId = project?._id;
  const ticket = project && (!navigation.project || navigation.project === project.key) ? navigation.ticket : null;
  const selected = useWorkspaceTicket(ticket, projectId);
  const selectedId = selected?._id ?? null;
  const [visible, setVisible] = useState<{ projectId?: Id<"projects">; ids?: Id<"tickets">[] }>({});
  const visibleIds = visible.projectId === projectId ? visible.ids ?? [] : [];
  const setVisibleIds = useCallback((ids: Id<"tickets">[] | undefined) => setVisible({ projectId, ids }), [projectId]);
  const previousSelection = useRef(ticket);
  const focusTicket = useRef<Id<"tickets"> | null>(null);
  if (selectedId) focusTicket.current = selectedId;
  const scrollOrigin = useRef<number | null>(null);
  const activeProjectBeforeUpdate = useRef(projectId);
  useEffect(() => {
    if (projects === undefined) return;
    const previous = activeProjectBeforeUpdate.current;
    activeProjectBeforeUpdate.current = projectId;
    if (previous && !projects.some(member => member._id === previous)) toast.info(t("projectMissing"));
  }, [projects, projectId, t]);
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = ticket;
    if (!previous || ticket) return;
    const frame = requestAnimationFrame(() => {
      if (scrollOrigin.current !== null) window.scrollTo({ top: scrollOrigin.current, behavior: "instant" });
      scrollOrigin.current = null;
      // Filtering can close detail while focus remains in the search/select.
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
  const foreignDraft = composer.hasDraft && composer.project?._id !== project?._id;

  return <main className="aurora-canvas min-h-screen px-3 pt-3 sm:px-5">
    <header className="aurora-toolbar relative z-30 mx-auto max-w-6xl">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-3 py-2.5 sm:px-5 sm:py-3">
        <ProductWordmark />
        {projects && project ? <div className="order-last min-w-0 max-w-full basis-full sm:order-none sm:basis-auto sm:flex-1">
          <ProjectSwitcher projects={projects} current={project} onSelect={selectProject} />
        </div> : null}
        <div className="ml-auto flex items-center gap-2">
          {project && <TicketInbox role="customer" compact key={project._id} projectId={project._id} projectKey={project.key} openTicket={openTicket} />}
          <DropdownMenu {...toolsMenu.root}>
            <DropdownMenuTrigger ref={toolsMenu.triggerRef} render={<Button type="button" variant="outline" className="min-h-11 min-w-11 gap-1.5 rounded-lg px-3" />}
              aria-label={t("customerQueueMore")} title={t("customerQueueMore")}>
              <UserRound aria-hidden="true" /><span className="hidden sm:inline">{t("customerQueueMore")}</span><ChevronDown className="hidden text-muted-foreground sm:block" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <p className="break-all px-2.5 py-1.5 text-xs text-muted-foreground">{viewer.displayName} · {viewer.username}</p>
              <DropdownMenuItem onClick={() => toolsMenu.run(() => setAccountOpen(true))}><UserRound aria-hidden="true" />{t("accountTitle")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <LanguageMenuGroup />
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => toolsMenu.run(() => { void composer.signOut(); })}><LogOut aria-hidden="true" />{t("signOut")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
    <Dialog open={accountOpen} onOpenChange={setAccountOpen} title={t("accountTitle")} description={t("accountSignedInAs", { username: viewer.username })}>
      <Suspense fallback={<p role="status">{t("syncing")}</p>}>
        <CustomerAccount clerkManaged={viewer.clerkManaged} hasRecoveryCode={!viewer.needsRecoveryCode} />
      </Suspense>
    </Dialog>
    <div className="mx-auto max-w-6xl py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:py-5">
      {viewer.needsRecoveryCode && !ticket && <RecoveryReminder onOpen={() => setAccountOpen(true)} />}
      <div className={cn("mb-5 flex flex-wrap items-center justify-between gap-3", ticket && "hidden lg:flex")}>
        <div><p className="text-sm text-muted-foreground">{project?.name ?? t("customerPortal")}</p><h1 id="customer-tickets-heading" data-dialog-return-focus tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("yourTickets")}</h1></div>
        <div className="flex flex-wrap items-center gap-2">{composer.hasDraft && composer.project && <span id="customer-draft-project" className="text-sm text-muted-foreground">{composer.project.name} ({composer.project.key})</span>}
        <Button className="min-h-11 rounded-lg" type="button" aria-describedby={composer.hasDraft ? "customer-draft-project" : undefined} aria-expanded={composer.open} disabled={!project && !composer.owner} onClick={composer.show}>
          <Plus />{t(composer.hasDraft ? "resumeTicket" : "newTicket")}
        </Button></div>
      </div>
      {foreignDraft ? <div className="aurora-panel mb-4 px-4 py-3 text-sm text-foreground" role="status">{t("customerQueueDraftProject", { project: composer.project?.name ?? "" })}</div> : null}
      <div className={cn("grid items-start gap-4", ticket && "lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]")}>
        <ProjectTicketsBoundary key={project?._id ?? "none"}>
          <CustomerTickets project={project} onNewTicket={composer.show} onSelect={openTicket}
            ticketOpen={Boolean(ticket)} selectedId={selectedId} filter={navigation.filter} query={navigation.query}
            onFilter={navigation.setFilter} onQuery={navigation.setQuery} onVisibleIds={setVisibleIds} />
        </ProjectTicketsBoundary>
        {project ? <CustomerTicketDialog ticket={selected} ticketId={ticket} onClose={navigation.closeTicket}
          inResults={selectedId && visible.projectId === projectId ? visible.ids?.includes(selectedId) : undefined}
          inline initialSection={navigation.section} onPrevious={previousId ? () => navigation.changeTicket(previousId) : undefined}
          onNext={nextId ? () => navigation.changeTicket(nextId) : undefined} /> : null}
      </div>
      {viewer.needsRecoveryCode && ticket && <RecoveryReminder className="mt-4" onOpen={() => setAccountOpen(true)} />}
    </div>
    <Dialog open={composer.open} mobileFullScreen initialFocus={() => document.getElementById("customer-ticket-title")} onOpenChange={composer.setOpen}
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
      {composer.hasDraft && <div className="mt-3"><DiscardTicketDraft busy={composer.busy} onDiscard={composer.discard} /></div>}
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
  return <div role="status" className={cn("mb-4", className)}>
    <button type="button" onClick={onOpen} aria-label={t("recoveryCodeCreate")} aria-describedby="customer-recovery-hint"
      className="aurora-inset flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <KeyRound aria-hidden className="size-5 shrink-0 text-amber-800 dark:text-amber-200" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{t("recoveryCodeCreate")}</span>
        <span id="customer-recovery-hint" className="block text-xs leading-5 text-muted-foreground">{t("recoveryCodeNeeded")}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0" />
    </button>
  </div>;
}

function ProjectUnavailable() {
  const { t } = useI18n();
  return <p role="alert" className="aurora-panel p-4 text-sm text-foreground">{t("projectMissing")}</p>;
}

function CustomerTickets({ project, onNewTicket, onSelect, selectedId, ticketOpen, filter, query, onFilter, onQuery, onVisibleIds }: {
  project: ProjectSummary | null | undefined; onNewTicket: () => void; onSelect: (id: Id<"tickets">) => void;
  selectedId: Id<"tickets"> | null; ticketOpen: boolean; filter: string; query: string; onFilter: (filter: string) => void; onQuery: (query: string) => void;
  onVisibleIds: (ids: Id<"tickets">[] | undefined) => void;
}) {
  const { t } = useI18n();
  const page = useCustomerTickets(project?._id);
  const tickets = page.results;
  const counts = useMemo(() => customerQueueCounts(tickets), [tickets]);
  const statusScope = filter === "all" || filter === "waiting" || filter === "done" ? filter : "active";
  const browseTickets = useMemo(() => customerQueue(tickets, statusScope), [tickets, statusScope]);
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
  const pending = searching && !invalidSearch && search === undefined;
  const visibleTickets = searching ? search?.matches ?? EMPTY_TICKETS : browseTickets;
  const loaded = page.status !== "LoadingFirstPage";
  useEffect(() => {
    onVisibleIds(pending || (!searching && !loaded) ? undefined : visibleTickets.map(item => item._id));
  }, [pending, searching, loaded, visibleTickets, onVisibleIds]);
  const options: { value: CustomerQueueFilter; label: string; count: number }[] = [
    { value: "active", label: t("customerQueueAllActive"), count: counts.active },
    { value: "waiting", label: t("customerQueueWaiting"), count: counts.waiting },
    { value: "done", label: t("resolvedTickets"), count: counts.done },
    { value: "all", label: t("allTickets"), count: counts.all },
  ];
  const countLabel = searching
    ? t(search?.hasMore ? "searchLoaded" : "searchMatches", { count: visibleTickets.length })
    : t("customerQueueCount", { shown: visibleTickets.length, loaded: tickets.length });
  const [announcement, setAnnouncement] = useState("");
  const statusSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!loaded || !project || pending || invalidSearch) return;
    const timer = window.setTimeout(() => setAnnouncement(countLabel), 250);
    return () => window.clearTimeout(timer);
  }, [loaded, project, pending, invalidSearch, countLabel]);
  if (project === null) return <NoProjects />;
  if (!project || !loaded) return <div className="aurora-panel grid min-h-48 place-items-center" role="status"><Loader2 className="size-6 animate-spin text-primary" /><span className="sr-only">{t("syncingTickets")}</span></div>;
  return <section className={cn("min-w-0", ticketOpen && "hidden lg:block")} aria-label={t("yourTickets")}>
    <span className="sr-only" role="status" aria-live="polite">{pending || invalidSearch ? "" : announcement}</span>
    <div className="aurora-toolbar mb-3 flex flex-wrap items-end gap-3 p-3">
      <TicketSearchInput className="min-w-40 flex-1 basis-full space-y-1 text-sm font-medium text-foreground sm:basis-auto"
        value={query} onChange={onQuery} onClear={() => onQuery("")} showLabel />
      <div className="grid w-full gap-1 text-sm font-medium text-foreground sm:w-auto">
        <label htmlFor="customer-ticket-status">{t("ticketStatus")}</label>
        <select id="customer-ticket-status" ref={statusSelect} className="aurora-control min-h-11 max-w-full rounded-lg px-3 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={statusScope} onChange={event => onFilter(event.target.value)}>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}{!searching ? ` (${option.count})` : ""}</option>)}
        </select>
      </div>
    </div>
    {!searching && page.status !== "Exhausted" ? <p className="mb-3 text-xs leading-5 text-muted-foreground">{t("customerQueueCountsHint")}</p> : null}
    {invalidSearch ? <p role="alert" className="ticket-surface p-5 text-sm text-destructive">{t("searchLimit")}</p>
      : pending ? <div className="ticket-surface flex items-center gap-2 p-5 text-sm" role="status"><Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />{t("syncingTickets")}</div>
      : !searching && tickets.length === 0 && page.status === "Exhausted" && (statusScope === "all" || statusScope === "active") ? <div className="aurora-panel space-y-3 p-6"><h2 className="font-semibold text-foreground">{t("myTicketsEmpty")}</h2><p className="text-sm text-muted-foreground">{t("myTicketsEmptyHint")}</p><Button className="min-h-11 rounded-lg" onClick={onNewTicket}><Plus />{t("newTicket")}</Button></div>
      : <div>
        <p className="px-1 pb-2 text-xs text-muted-foreground">{countLabel}</p>
        {visibleTickets.length ? <ul className="space-y-2">{visibleTickets.map(ticket => <li key={ticket._id}><CustomerTicketRow item={ticket} selected={ticket._id === selectedId} onSelect={onSelect} /></li>)}</ul>
          : <div className="ticket-surface space-y-3 p-5 text-sm"><p className="text-foreground">{t(searching ? "customerQueueSearchEmpty" : "customerQueueEmpty")}</p>{statusScope !== "all" && <Button variant="outline" className="min-h-11 rounded-lg" onClick={() => { statusSelect.current?.focus(); onFilter("all"); }}>{t(searching ? "customerQueueSearchAllStatuses" : "showAllTickets")}</Button>}</div>}
      </div>}
    {!searching && page.status !== "Exhausted" ? <Button className="mt-4 min-h-11 rounded-lg" disabled={page.status !== "CanLoadMore"} onClick={() => page.loadMore(20)}>{page.status === "LoadingMore" ? <Loader2 className="animate-spin" /> : null}{t("loadOlder")}</Button> : null}
  </section>;
}
