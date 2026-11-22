import { TicketInbox } from "./ticket-inbox";
import { errorCode } from "../../../shared/errors";
import { DiscardTicketDraft } from "./discard-ticket-draft";
import { ProductWordmark } from "@/components/product-wordmark";
import { queueNeighbors } from "@/lib/staff-ticket-queue";
import { LanguageSelector } from "@/components/auth-screens";
import { NoProjects, ProjectSwitcher, useCurrentProject } from "@/components/project-controls";
import { statusMeta } from "@/components/ticket-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CustomerTicketWizard } from "./customer-ticket-wizard";
import { useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { type ProjectSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { Images, Loader2, LogOut, MapPin, Plus, Search, UserRound } from "lucide-react";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { useCustomerTickets, useWorkspaceTicket } from "./adapter";
import { MAX_WORKSPACE_QUERY_LENGTH } from "@/app/workspace-search";
import { CustomerTicketDialog } from "./customer-ticket-dialog";
import { customerQueue, customerQueueCounts } from "./customer-queue";
import { useComposer } from "./use-composer";
import { useWorkspaceMenu } from "./use-workspace-menu";
import { CustomerAccountDialog } from "@/components/account-dialogs";
import { useWorkspaceNavigation } from "./use-workspace-navigation";

export function CustomerPortal({ viewer, onLogout }: {
  viewer: { username: string; displayName: string; needsRecoveryCode: boolean }; onLogout: () => Promise<void>;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const { language, setLanguage, t } = useI18n();
  const navigation = useWorkspaceNavigation("customer");
  const { projects, current: project, select: selectProject } = useCurrentProject(navigation.project, navigation.selectProject);
  const composer = useComposer(project, onLogout);
  const toolsMenu = useWorkspaceMenu();
  const projectId = project?._id;
  const ticket = project && (!navigation.project || navigation.project === project.key) ? navigation.ticket : null;
  const selected = useWorkspaceTicket(ticket, projectId);
  const selectedId = selected?._id ?? null;
  const [visible, setVisible] = useState<{ projectId?: Id<"projects">; ids: Id<"tickets">[] }>({ ids: [] });
  const visibleIds = visible.projectId === projectId ? visible.ids : [];
  const setVisibleIds = useCallback((ids: Id<"tickets">[]) => setVisible({ projectId, ids }), [projectId]);
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
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <ProductWordmark />
        <div className="flex flex-wrap items-center max-w-full gap-2 [&>select]:min-h-11 sm:[&>select]:w-auto [&>span]:min-h-11">
          {projects && project ? <ProjectSwitcher projects={projects} current={project} onSelect={selectProject} /> : null}
          {project && <TicketInbox role="customer" key={project._id} projectId={project._id} projectKey={project.key} openTicket={openTicket} />}
          <details {...toolsMenu.props} className="relative">
            <summary className="aurora-control flex min-h-11 cursor-pointer list-none items-center rounded-lg border px-3 text-sm font-medium text-foreground transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("customerQueueMore")}</summary>
            <div className="absolute right-0 z-30 mt-1.5 grid w-60 max-w-[calc(100vw-3rem)] gap-3 rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-lg">
              <p className="break-all text-xs text-muted-foreground">{viewer.displayName} · {viewer.username}</p>
              <Button variant="outline" className="aurora-control min-h-11 rounded-lg" onClick={() => { toolsMenu.close(); setAccountOpen(true); }}><UserRound aria-hidden="true" />{t("accountTitle")}</Button>
              <div className="[&_button]:min-h-11"><LanguageSelector language={language} onChange={setLanguage} /></div>
              <Button variant="outline" className="aurora-control min-h-11 rounded-lg" onClick={() => void composer.signOut()}><LogOut />{t("signOut")}</Button>
            </div>
          </details>
        </div>
      </div>
    </header>
    <CustomerAccountDialog open={accountOpen} onOpenChange={setAccountOpen} username={viewer.username} hasRecoveryCode={!viewer.needsRecoveryCode} />
    <div className="mx-auto max-w-6xl px-4 py-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
      {viewer.needsRecoveryCode ? <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/90 bg-amber-50/95 px-4 py-3 text-sm text-amber-950 shadow-sm dark:bg-amber-950/30 dark:text-amber-100">
        <span>{t("recoveryCodeNeeded")}</span>
        <Button className="min-h-11 rounded-lg" onClick={() => setAccountOpen(true)}>{t("recoveryCodeCreate")}</Button>
      </div> : null}
      <div className={cn("mb-5 flex flex-wrap items-center justify-between gap-3", ticket && "hidden lg:flex")}>
        <div><p className="text-sm text-muted-foreground">{project?.name ?? t("customerPortal")}</p><h1 id="customer-tickets-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("yourTickets")}</h1></div>
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
            onFilter={navigation.setFilter} onQuery={navigation.setQuery} onShowAll={() => navigation.setFilter("all", true)} onVisibleIds={setVisibleIds} />
        </ProjectTicketsBoundary>
        {project ? <CustomerTicketDialog ticket={selected} ticketId={ticket} onClose={navigation.closeTicket}
          inResults={selectedId && visible.projectId === projectId ? visibleIds.includes(selectedId) : undefined}
          inline initialSection={navigation.section} onPrevious={previousId ? () => navigation.changeTicket(previousId) : undefined}
          onNext={nextId ? () => navigation.changeTicket(nextId) : undefined} /> : null}
      </div>
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

function ProjectUnavailable() {
  const { t } = useI18n();
  return <p role="alert" className="aurora-panel p-4 text-sm text-foreground">{t("projectMissing")}</p>;
}

function CustomerTickets({ project, onNewTicket, onSelect, selectedId, ticketOpen, filter, query, onFilter, onQuery, onShowAll, onVisibleIds }: {
  project: ProjectSummary | null | undefined; onNewTicket: () => void; onSelect: (id: Id<"tickets">) => void;
  selectedId: Id<"tickets"> | null; ticketOpen: boolean; filter: string; query: string; onFilter: (filter: string) => void; onQuery: (query: string) => void;
  onShowAll: () => void;
  onVisibleIds: (ids: Id<"tickets">[]) => void;
}) {
  const { t } = useI18n();
  const page = useCustomerTickets(project?._id);
  const tickets = page.results;
  const counts = useMemo(() => customerQueueCounts(tickets), [tickets]);
  const visibleTickets = useMemo(() => customerQueue(tickets, filter, query), [tickets, filter, query]);
  useEffect(() => { onVisibleIds(visibleTickets.map(item => item._id)); }, [visibleTickets, onVisibleIds]);
  const options = [
    { value: "active", label: t("customerQueueAllActive"), count: counts.active },
    { value: "waiting", label: t("customerQueueWaiting"), count: counts.waiting },
    { value: "done", label: t("resolvedTickets"), count: counts.done },
    { value: "all", label: t("allTickets"), count: counts.all },
  ];
  const loaded = page.status !== "LoadingFirstPage";
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!loaded || !project) return;
    const timer = window.setTimeout(() => setAnnouncement(t("customerQueueCount", { shown: visibleTickets.length, loaded: tickets.length })), 250);
    return () => window.clearTimeout(timer);
  }, [loaded, project, visibleTickets.length, tickets.length, t]);
  if (project === null) return <NoProjects />;
  if (!project || !loaded) return <div className="aurora-panel grid min-h-48 place-items-center" role="status"><Loader2 className="size-6 animate-spin text-primary" /><span className="sr-only">{t("syncingTickets")}</span></div>;
  return <section className={cn("min-w-0", ticketOpen && "hidden lg:block")} aria-label={t("yourTickets")}>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div className="aurora-toolbar mb-3 flex flex-wrap items-end gap-3 p-3">
      <label className="min-w-40 flex-1 space-y-1 text-sm font-medium text-foreground">
        <span>{t("customerQueueSearch")}</span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="aurora-control min-h-11 rounded-lg bg-card/85 pl-9 font-normal" maxLength={MAX_WORKSPACE_QUERY_LENGTH} value={query} onChange={event => onQuery(event.target.value)} placeholder={t("search")} />
        </div>
      </label>
      <label className="grid gap-1 text-sm font-medium text-foreground">
        <span>{t("ticketStatus")}</span>
        <select className="aurora-control min-h-11 max-w-full rounded-lg border px-3 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={filter} onChange={event => onFilter(event.target.value)}>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}{loaded ? ` (${option.count})` : ""}</option>)}
        </select>
      </label>
    </div>
    <p className="mb-3 text-xs leading-5 text-muted-foreground">{t("customerQueueCountsHint")}</p>
    {tickets.length === 0 && page.status === "Exhausted" && !query.trim() && (filter === "all" || filter === "active") ? <div className="aurora-panel space-y-3 p-6"><h2 className="font-semibold text-foreground">{t("myTicketsEmpty")}</h2><p className="text-sm text-muted-foreground">{t("myTicketsEmptyHint")}</p><Button className="min-h-11 rounded-lg" onClick={onNewTicket}><Plus />{t("newTicket")}</Button></div>
      : <div className="aurora-panel overflow-hidden">
        <div className="flex flex-wrap justify-between gap-2 border-b border-border/60 px-4 py-3 text-xs text-muted-foreground"><p>{t("customerQueueCount", { shown: visibleTickets.length, loaded: tickets.length })}</p><span>{t("customerQueueOrder")}</span></div>
        {visibleTickets.length ? <ul className="space-y-2.5 p-3">{visibleTickets.map(ticket => <li key={ticket._id}><CustomerTicketRow item={ticket} selected={ticket._id === selectedId} onSelect={onSelect} /></li>)}</ul>
          : <div className="space-y-3 p-5 text-sm"><p className="text-foreground">{t("customerQueueEmpty")}</p><Button variant="outline" className="aurora-control min-h-11 rounded-lg" onClick={onShowAll}>{t("showAllTickets")}</Button></div>}
      </div>}
    {page.status !== "Exhausted" && project ? <Button className="mt-4 min-h-11 rounded-lg" disabled={page.status !== "CanLoadMore"} onClick={() => page.loadMore(20)}>{page.status === "LoadingMore" ? <Loader2 className="animate-spin" /> : null}{t("loadOlder")}</Button> : null}
  </section>;
}

function CustomerTicketRow({ item, selected, onSelect }: { item: TicketSummary; selected: boolean; onSelect: (id: Id<"tickets">) => void }) {
  const { t, formatDate } = useI18n();
  const meta = statusMeta(item.status);
  const StatusIcon = meta.icon;
  const label = formatTicketNumber(item.ticketNumber, item.projectKey);
  return <button type="button" data-ticket-id={item._id}
    className={cn(
      "aurora-ticket flex min-h-20 w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      selected && "border-primary/70 ring-2 ring-primary/35",
    )}
    aria-label={[t("viewTicket", { ticket: label }), item.title, t(meta.labelKey)].join(", ")} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item._id)}>
    <span className="break-words text-sm font-semibold text-foreground">{item.title}</span>
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
      <span className="font-mono text-foreground/80">{label}</span>
      <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium", meta.tone)}>
        <StatusIcon className="size-3.5" aria-hidden />
        {item.status === "waiting" ? t("customerQueueWaiting") : t(meta.labelKey)}
      </span>
      <time dateTime={new Date(item.createdAt).toISOString()}>{formatDate(item.createdAt)}</time>
    </span>
    {item.excerpt ? <span className="line-clamp-1 text-sm text-muted-foreground">{item.excerpt}</span> : null}
    {(item.mediaCount || item.annotationCount) ? <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {item.mediaCount ? <span className="inline-flex items-center gap-1"><Images className="size-3" aria-hidden="true" />{t("reviewMedia", { count: item.mediaCount })}</span> : null}
      {item.annotationCount ? <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden="true" />{t("reviewPins", { count: item.annotationCount })}</span> : null}
    </span> : null}
  </button>;
}
