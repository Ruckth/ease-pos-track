import { ConnectT3Code } from "@/features/t3/connect-t3-code";
import { useT3Proof, useT3ReleaseAvailable } from "@/features/t3/adapters/connection";
import { TicketInbox } from "./ticket-inbox";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { toast, Toaster } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { useRoutingSettings } from "@/features/routing/adapters/convex";
import { RoutingWorkspace } from "@/features/routing/routing-workspace";
import { useRoutingCopy } from "@/features/routing/routing-copy";
import type { TicketAssignmentFilter } from "../../../shared/ticket-routing";
import { StaffHealth } from "@/features/operations/staff-health";
import { NewProjectDialog, NoProjects, ProjectMembersDialog, useCurrentProject } from "@/components/project-controls";
import { TicketExplorer } from "@/components/ticket-explorer";
import { statuses } from "@/components/ticket-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { localizeError, useI18n } from "@/lib/i18n";
import { queueNeighbors } from "@/lib/staff-ticket-queue";
import { useStaffTickets, useTicketCapabilities, useTicketTags, useWorkspaceTicket } from "./adapter";
import { SubmitTicket } from "./staff-composer";
import { StaffTicketDialog } from "./staff-ticket-dialog";
import { useComposer } from "./use-composer";
import { useTicketOperations } from "./use-ticket-operations";
import { useWorkspaceNavigation, type ListView } from "./use-workspace-navigation";
import { TeamDialog } from "@/components/account-dialogs";
import { StaffViewSwitcher, StaffWorkspaceNavigation, type ProjectTool } from "./staff-workspace-navigation";
import { useTicketStatusMoves } from "./use-ticket-status-moves";
import { DiscardTicketDraft } from "./discard-ticket-draft";

const selectClass = "min-h-11 max-w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground";
type TicketId = Id<"tickets">;
const emptyTickets: TicketSummary[] = [];

export function StaffWorkspace({ viewer, onLogout, t3Settings = false, onT3Settings }: {
  viewer: { staffId: string; name: string; email: string; role: "owner" | "staff" };
  onLogout: () => Promise<void>;
  /** The mounted T3 Settings route (APP_PATHS.staffT3Settings). */
  t3Settings?: boolean;
  onT3Settings?: (open: boolean) => void;
}) {
  const owner = viewer.role === "owner";
  const { t } = useI18n();
  const copy = useExplorerCopy();
  const { copy: routingCopy } = useRoutingCopy();
  const { projects, current: project, select: selectProject } = useCurrentProject();
  const nav = useWorkspaceNavigation("staff", project?.key);
  const composer = useComposer(project);
  const operations = useTicketOperations();
  // Media, retention health and Project creation stay closed in a named pilot.
  const legacyToolsEnabled = useTicketCapabilities()?.mediaEnabled === true;
  const requestT3Proof = useT3Proof();
  const t3Available = useT3ReleaseAvailable();
  const [tool, setTool] = useState<ProjectTool | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [restoring, setRestoring] = useState<Set<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const moves = useTicketStatusMoves(project?._id, operations.status);
  const busy = useMemo(() => new Set([...moves.busy, ...restoring]), [moves.busy, restoring]);
  const routing = useRoutingSettings(project?._id);
  // The T3 tool is a route, so the signed kit's settingsUrl opens it directly.
  const openTool = (next: ProjectTool) => next === "t3" ? onT3Settings?.(true) : setTool(next);
  const [assignmentScope, setAssignmentScope] = useState<TicketAssignmentFilter>();
  const projectViews = useRef(new Map<string, ListView>());
  const chooseProject = (key: string) => {
    if (project) projectViews.current.set(project.key, nav.listView);
    setAssignmentScope(undefined);
    selectProject(key, projectViews.current.get(key) ?? "queue");
  };
  const focusSource = useRef<HTMLElement | null>(null);
  const returnPoint = useRef<{ project: string; id: TicketId; scroll: number } | null>(null);
  const query = nav.query.trim();
  const filter = nav.filter;
  const showArchived = filter === "archive";
  const listView = showArchived && nav.listView === "board" ? "table" : nav.listView;
  const assignmentFilter = !showArchived && routing ? assignmentScope : undefined;
  const data = useStaffTickets(project?._id, listView, filter, query, assignmentFilter);
  const allTags = useTicketTags(filtersOpen);
  const tags = useMemo(() => allTags ?? data.items.flatMap(item => item.tags), [allTags, data.items]);
  const selected = useWorkspaceTicket(nav.ticketId, project?._id);
  const [order, setOrder] = useState<TicketId[]>([]);
  const snapshot = useRef<TicketId[]>([]);
  const currentOrder = useRef<TicketId[]>([]);
  const orderChanged = useCallback((ids: TicketId[]) => {
    currentOrder.current = ids;
    setOrder(last => last.length === ids.length && last.every((id, i) => id === ids[i]) ? last : ids);
  }, []);
  useEffect(() => {
    if (nav.ticketId && !snapshot.current.includes(nav.ticketId) && order.includes(nav.ticketId)) snapshot.current = order;
  }, [nav.ticketId, order]);
  const { previous, next } = queueNeighbors(nav.ticketId, order, snapshot.current);
  const onSelect = (id: TicketId, section?: "media") => {
    focusSource.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (project) returnPoint.current = { project: project.key, id, scroll: window.scrollY };
    snapshot.current = currentOrder.current;
    nav.openTicket(id, section);
  };
  const focusFirst = (id: TicketId) => {
    snapshot.current = currentOrder.current;
    nav.changeTicket(id);
  };
  const lastSelection = useRef(nav.ticketId);
  useEffect(() => {
    const wasOpen = lastSelection.current;
    lastSelection.current = nav.ticketId;
    if (!wasOpen || nav.ticketId) return;
    const frame = requestAnimationFrame(() => {
      const results = document.getElementById("staff-ticket-results");
      const point = returnPoint.current;
      const sameProject = point?.project === project?.key;
      const source = sameProject ? focusSource.current : null;
      const row = (id?: TicketId) => {
        if (!id) return null;
        const triggers = results?.querySelectorAll<HTMLElement>(`[data-ticket-id="${CSS.escape(id)}"]`);
        return Array.from(triggers ?? []).find(trigger => trigger.getClientRects().length > 0);
      };
      const neighbors = point && sameProject ? queueNeighbors(point.id, currentOrder.current, snapshot.current) : {};
      const target = source?.isConnected && source.getClientRects().length ? source
        : row(sameProject ? point?.id : undefined) ?? row(neighbors.next) ?? row(neighbors.previous) ?? results;
      if (point && sameProject) window.scrollTo(0, point.scroll);
      target?.focus({ preventScroll: true });
      const rect = target?.getBoundingClientRect();
      if (rect && target && target !== results && (rect.bottom <= 0 || rect.top >= innerHeight)) {
        target.scrollIntoView({ block: "nearest" });
      }
      returnPoint.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [nav.ticketId, project?.key]);

  async function restoreItem(id: TicketId) {
    const item = data.items.find(row => row._id === id) ?? (selected?._id === id ? selected : null);
    if (!item || busy.has(id) || inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setRestoring(new Set(inFlight.current));
    try { await operations.restore(item); }
    finally { inFlight.current.delete(id); setRestoring(new Set(inFlight.current)); }
  }
  async function archiveItem(id: TicketId) {
    if (!selected || selected._id !== id) return;
    await operations.archive(selected);
  }
  const afterSubmit = (id?: TicketId) => {
    const draftProject = composer.project;
    composer.complete();
    if (draftProject && draftProject.key !== project?.key) chooseProject(draftProject.key);
    if (id) onSelect(id);
  };

  const inlineDetail = listView === "queue";
  const split = inlineDetail && Boolean(nav.ticketId);
  const single = nav.view === "focus" && split;
  const detail = <StaffTicketDialog ticket={selected} ticketId={nav.ticketId} onClose={nav.closeTicket} inline={inlineDetail} focusMode={nav.view === "focus"}
    inResults={nav.ticketId && !data.loading ? order.includes(nav.ticketId) : undefined}
    onToggleFocus={nav.view === "focus" ? nav.leaveFocus : nav.enterFocus}
    statusRecovery={nav.ticketId ? moves.recoveryFor(nav.ticketId) : null} statusBusy={Boolean(selected && busy.has(selected._id))}
    onPrevious={previous ? () => nav.changeTicket(previous) : undefined} onNext={next ? () => nav.changeTicket(next) : undefined}
    initialSection={nav.section} onMove={(_id, status) => { if (selected) void moves.moveItem(selected, status); }} onArchive={archiveItem} onRestore={restoreItem} />;

  return <main className="min-h-screen">
    {!single && <a href="#staff-ticket-results" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:ring-2" onClick={event => {
      event.preventDefault();
      document.getElementById("staff-ticket-results")?.focus();
    }}>{t("queueSkip")}</a>}
    <Toaster richColors position="bottom-right" />
    <div className={single ? "mx-auto max-w-4xl" : "xl:grid xl:grid-cols-[14rem_minmax(0,1fr)]"}>
      <div className={single ? "hidden" : "contents"}>
      <StaffWorkspaceNavigation projects={projects} current={project} archived={showArchived} hideOnPhone={split}
        legacyToolsEnabled={legacyToolsEnabled} t3Available={t3Available} routingAvailable={!!routing}
        onArchive={archived => nav.setFilter(archived ? "archive" : "active")} onSelectProject={chooseProject} onTool={openTool} onLogout={onLogout} owner={owner} signedInAs={viewer.email} />
      </div>
      <div className="mx-auto w-full min-w-0 max-w-[100rem] px-3 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-5 xl:px-7 xl:pt-7">
        <div className={`mb-3 flex-wrap items-center justify-between gap-2 ${single ? "hidden" : split ? "hidden lg:flex" : "flex"}`}>
          <h1 className="text-2xl font-semibold tracking-tight">{showArchived ? t("archive") : nav.listView === "queue" ? t("queueTitle") : copy.results}</h1>
          {(project || composer.owner) && <div className="flex min-w-0 flex-wrap items-center gap-2">
            {project && <TicketInbox key={project._id} role="staff" projectId={project._id} projectKey={project.key} openTicket={onSelect} />}
            {composer.hasDraft && composer.project && <span id="staff-draft-project" className="max-w-32 truncate text-xs font-medium text-muted-foreground" title={composer.project.name}>
              {composer.project.name} ({composer.project.key})
            </span>}
            <Button type="button" className="min-h-11" aria-describedby={composer.hasDraft ? "staff-draft-project" : undefined} aria-expanded={composer.open} onClick={composer.show}>
              <Plus aria-hidden />{composer.hasDraft ? t("resumeTicket") : t("newTicket")}
            </Button>
          </div>}
        </div>
        {!nav.ticketId && moves.recovery}
        {project === null ? <NoProjects action={owner && legacyToolsEnabled ? <Button onClick={() => setTool("project")}>{t("newProject")}</Button> : undefined} /> :
          project === undefined ? <div role="status" aria-label={t("syncing")} className="grid min-h-32 place-items-center"><Loader2 className="size-6 animate-spin" /></div> : <>
            <div className={`mb-2 flex-wrap items-end gap-2 ${single ? "hidden" : split ? "hidden lg:flex" : "flex"}`}>
              <label className="relative min-w-0 grow basis-full text-xs text-muted-foreground sm:basis-52">
                {t("search")}<Search className="pointer-events-none absolute bottom-3 left-3 size-4" aria-hidden />
                <Input className="mt-1 min-h-11 pl-9" placeholder={t("search")} maxLength={200} value={nav.query} onChange={event => nav.setQuery(event.target.value)} />
              </label>
              {!showArchived && <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{t("ticketStatus")}
                <select className={selectClass} value={filter} onChange={event => nav.setFilter(event.target.value)}>
                  <option value="active">{t("activeTickets")}</option><option value="all">{t("allTickets")}</option>
                  {statuses.map(status => <option key={status.value} value={status.value}>{t(status.labelKey)}</option>)}
                </select>
              </label>}
              {!showArchived && routing && <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{routingCopy.assignment}
                <select className={selectClass} value={assignmentScope ?? ""} onChange={event => {
                  const scope = event.target.value;
                  setAssignmentScope(scope === "mine" || scope === "unassigned" ? scope : undefined);
                }}>
                  <option value="">{routingCopy.all}</option><option value="mine">{routingCopy.mine}</option>
                  <option value="unassigned">{routingCopy.unassigned}</option>
                </select>
              </label>}
              <StaffViewSwitcher archived={showArchived} view={listView} onSelect={nav.setView} />
            </div>
            <div id="staff-ticket-results" tabIndex={-1} className={split && !single ? "lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start lg:gap-4" : undefined}>
              <div className={single ? "hidden" : split ? "hidden lg:block" : "min-w-0"}>
            {data.invalidSearch ? <p role="alert" className="text-sm text-destructive">{t("searchLimit")}</p> : <TicketExplorer
              key={project._id} projectId={project._id} items={showArchived ? emptyTickets : data.items} archivedItems={showArchived ? data.items : emptyTickets}
              tags={tags} search={query} onSearch={nav.setQuery} showArchived={showArchived}
              totals={data.totals ?? {}} pages={data.lanes} loading={data.loading}
              searchHasMore={data.searchHasMore} archiveSearchHasMore={data.searchHasMore}
              onSelect={onSelect} onMove={moves.moveItem} onRestore={id => { void restoreItem(id).catch(error => toast.error(localizeError(error, t))); }}
              workspace={{ view: nav.view === "focus" && listView === "queue" ? "focus" : listView, visibleStatuses: data.visibleStatuses, selectedId: nav.ticketId, orderKey: `${project.key}/${filter}/${assignmentFilter ?? ""}`, onOrder: orderChanged,
                onFocusFirst: focusFirst, onFiltersOpen: setFiltersOpen, hasMore: data.hasMore, loadingMore: data.loadingMore, loadMore: data.loadMore, busy }} />}
              </div>
              {inlineDetail && <div className="min-w-0 space-y-2">
                {detail}
                {selected && !next && data.hasMore && <Button variant="outline" className="min-h-11" disabled={data.loadingMore} onClick={data.loadMore}>{t("loadOlder")}</Button>}
              </div>}
            </div>
          </>}
      </div>
    </div>

    <Dialog open={composer.open} mobileFullScreen initialFocus={() => document.getElementById("title")}
      onOpenChange={composer.setOpen} title={t("newTicket")} description={composer.project ? `${composer.project.name} (${composer.project.key})` : undefined}>
      {composer.owner && <SubmitTicket key={composer.project?._id} draftOwner={composer.owner} active={composer.open} onSubmissionComplete={afterSubmit} />}
      {composer.hasDraft && <DiscardTicketDraft busy={composer.busy} onDiscard={composer.discard} />}
    </Dialog>
    {t3Settings && <Dialog open onOpenChange={() => onT3Settings?.(false)} title={t("connectT3")}>
      <ConnectT3Code key={viewer.staffId} requestProof={requestT3Proof} />
    </Dialog>}
    {legacyToolsEnabled && <Dialog open={tool === "health"} onOpenChange={() => setTool(null)} title={t("healthTitle")} description={t("healthDescription")}>
      {tool === "health" && <StaffHealth />}
    </Dialog>}
    {tool === "routing" && project && routing && <Dialog open onOpenChange={() => setTool(null)} title={routingCopy.routing} mobileFullScreen>
      <RoutingWorkspace key={project._id} projectId={project._id} settings={routing} openTicket={id => {
        setTool(null);
        onSelect(id);
      }} />
    </Dialog>}
    {owner && legacyToolsEnabled && <NewProjectDialog open={tool === "project"} onOpenChange={() => setTool(null)} onCreated={chooseProject} />}
    {tool === "members" && project && <ProjectMembersDialog project={project} owner={owner} open onOpenChange={() => setTool(null)} />}
    {owner && tool === "team" && <TeamDialog ownerStaffId={viewer.staffId} onClose={() => setTool(null)} />}
    {!inlineDetail && detail}

  </main>;
}
