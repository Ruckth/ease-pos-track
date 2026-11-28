import { useT3Proof, useT3ReleaseAvailable } from "@/features/t3/adapters/connection";
import { TicketInbox } from "./ticket-inbox";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Archive, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { useRoutingSettings } from "@/features/routing/adapters/convex";
import { useRoutingCopy } from "@/features/routing/routing-copy";
import { NewProjectDialog, NoProjects, ProjectMembersDialog, useCurrentProject } from "@/components/project-controls";
import { TicketExplorer, TicketFilterFields, useTicketFilterRules } from "@/components/ticket-explorer";
import { TicketFilterPopover } from "@/components/ticket-filter-popover";
import { statuses } from "@/components/ticket-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useMediaQuery } from "@/lib/use-media-query";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useStaffCopy } from "@/lib/staff-copy";
import { openAndDone } from "@/lib/kanban-board";
import { localizeError, useI18n } from "@/lib/i18n";
import { TicketSearchInput } from "./ticket-search-input";
import { queueNeighbors } from "@/lib/staff-ticket-queue";
import { useStaffTickets, useTicketCapabilities, useTicketTags, useWorkspaceTicket } from "./adapter";
import { SubmitTicket } from "./staff-composer";
import { StaffTicketDialog } from "./staff-ticket-dialog";
import { useComposer } from "./use-composer";
import { useTicketOperations } from "./use-ticket-operations";
import { TicketOperationFailure } from "./operations";
import { useFreshTicket } from "./adapters/fresh-ticket-status";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { useWorkspaceNavigation, type ListView } from "./use-workspace-navigation";
import { StaffViewSwitcher, StaffWorkspaceNavigation, type ProjectTool } from "./staff-workspace-navigation";
import { useTicketStatusMoves } from "./use-ticket-status-moves";
import { DiscardTicketDraft } from "./discard-ticket-draft";
import { SavedSearchMenu } from "./saved-search-menu";
import { clearSavedSearches } from "./saved-searches";

const LineSettings = lazy(() => import("@/features/line/line-settings").then(module => ({ default: module.LineSettings })));
const ConnectT3Code = lazy(() => import("@/features/t3/connect-t3-code").then(module => ({ default: module.ConnectT3Code })));
const RoutingWorkspace = lazy(() => import("@/features/routing/routing-workspace").then(module => ({ default: module.RoutingWorkspace })));
const StaffHealth = lazy(() => import("@/features/operations/staff-health").then(module => ({ default: module.StaffHealth })));
const TeamAdministration = lazy(() => import("@/components/account-dialogs").then(module => ({ default: module.TeamAdministration })));

const selectClass = "aurora-control min-h-11 w-full rounded-lg px-2.5 text-sm md:min-h-9";
type TicketId = Id<"tickets">;
const emptyTickets: TicketSummary[] = [];

// Mount the full tag subscription with the open panel, including its portal lifetime.
function StaffFilterFields(props: ComponentProps<typeof TicketFilterFields>) {
  const allTags = useTicketTags();
  return <TicketFilterFields {...props} tags={allTags ?? props.tags} />;
}

export function StaffWorkspace({ viewer, onLogout, t3Settings = false, onT3Settings, lineSettings, onLineSettings }: {
  viewer: { staffId: string; name: string; email: string; role: "owner" | "staff" };
  onLogout: () => Promise<void>;
  /** The mounted T3 Settings route (APP_PATHS.staffT3Settings). */
  t3Settings?: boolean;
  onT3Settings?: (open: boolean) => void;
  lineSettings?: { bot?: string };
  onLineSettings?: (open: boolean, bot?: string) => void;
}) {
  const owner = viewer.role === "owner";
  const { t, language } = useI18n();
  const copy = useExplorerCopy();
  const staffCopy = useStaffCopy();
  const { copy: routingCopy } = useRoutingCopy();
  const nav = useWorkspaceNavigation("staff");
  const { projects, current: project, select: selectProject } = useCurrentProject(nav.project, nav.selectProject);
  // Saved searches never outlive the signed-in session that made them.
  const composer = useComposer(project, async () => { clearSavedSearches(); await onLogout(); });
  const composerLabel = composer.foreignDraft
    ? (language === "th" ? "ทำฉบับร่างต่อ" : "Continue draft")
    : t(composer.hasDraft ? "resumeTicket" : "newTicket");
  const operations = useTicketOperations();
  const readTicket = useFreshTicket();
  // Media, retention health and Project creation stay closed in a named pilot.
  const capabilities = useTicketCapabilities();
  const legacyToolsEnabled = capabilities?.mediaEnabled === true;
  const lineEnabled = capabilities?.lineEnabled === true;
  const requestT3Proof = useT3Proof();
  const t3Available = useT3ReleaseAvailable();
  const [tool, setTool] = useState<ProjectTool | null>(null);
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [restoring, setRestoring] = useState<Set<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const moves = useTicketStatusMoves(project?._id, operations.status);
  const busy = useMemo(() => new Set([...moves.busy, ...restoring]), [moves.busy, restoring]);
  // The signed-in staff viewer and active Project list already gate routing navigation.
  // The routing panel and assignment editor subscribe to the full settings when used.
  const routing = useRoutingSettings(tool === "routing" ? project?._id : undefined);
  // The T3 tool is a route, so the signed kit's settingsUrl opens it directly.
  const openTool = (next: ProjectTool) => {
    if (next === "t3") onT3Settings?.(true);
    else if (next === "line") onLineSettings?.(true);
    else if (next === "health") nav.setHealth(true);
    else setTool(next);
  };
  const projectViews = useRef(new Map<string, ListView>());
  const chooseProject = (key: string) => {
    if (project) projectViews.current.set(project.key, nav.listView);
    selectProject(key, projectViews.current.get(key) ?? "board");
  };
  const focusSource = useRef<HTMLElement | null>(null);
  const returnPoint = useRef<{ project: string; id: TicketId; scroll: number } | null>(null);
  const exactProject = project && nav.project === project.key;
  const scopedQuery = exactProject ? nav.query : "";
  const [searchInput, setSearchInput] = useState(scopedQuery);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    setSearchInput(scopedQuery);
    return () => clearTimeout(searchTimer.current);
  }, [nav.locationKey, scopedQuery, project?._id]);
  const commitSearch = nav.setQuery;
  const typeSearch = (value: string) => {
    setSearchInput(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => commitSearch(value, nav.locationKey), 300);
  };
  const clearSearch = () => {
    clearTimeout(searchTimer.current);
    setSearchInput("");
    if (scopedQuery) commitSearch("");
  };
  const withSearch = (action: () => void) => {
    clearTimeout(searchTimer.current);
    nav.withQuery(searchInput, action);
  };
  const query = scopedQuery.trim();
  const filter = nav.filter;
  const showArchived = filter === "archive";
  const listView = showArchived && nav.listView === "board" ? "table" : nav.listView;
  const assignmentFilter = !showArchived && project ? nav.assignment : undefined;
  const data = useStaffTickets(exactProject ? project._id : undefined, listView, filter, query, assignmentFilter);
  const totals = data.totals ? openAndDone(data.totals) : null;
  const tags = useMemo(() => Array.from(new Map(data.items.flatMap(item => item.tags.map(tag => [tag._id, tag] as const))).values()), [data.items]);
  const rules = useTicketFilterRules(project?._id ?? "");
  // Archive has no status or assignment scope; its loaded rules and shortcut still apply.
  const filterCount = rules.count + (showArchived ? 0 : Number(filter !== nav.defaultFilter) + Number(nav.assignment !== undefined));
  const clearFilters = () => {
    rules.reset();
    withSearch(() => { void nav.resetFilters(); });
  };
  const ticket = project && (!nav.project || nav.project === project.key) ? nav.ticket : null;
  const selected = useWorkspaceTicket(ticket, project?._id);
  const selectedId = selected?._id ?? null;
  const [order, setOrder] = useState<TicketId[]>([]);
  const snapshot = useRef<TicketId[]>([]);
  const currentOrder = useRef<TicketId[]>([]);
  const orderChanged = useCallback((ids: TicketId[]) => {
    currentOrder.current = ids;
    setOrder(last => last.length === ids.length && last.every((id, i) => id === ids[i]) ? last : ids);
  }, []);
  useEffect(() => {
    if (selectedId && !snapshot.current.includes(selectedId) && order.includes(selectedId)) snapshot.current = order;
  }, [selectedId, order]);
  const { previous, next } = queueNeighbors(selectedId, order, snapshot.current);
  const onSelect = (id: TicketId, section?: "media") => {
    focusSource.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (project) returnPoint.current = { project: project.key, id, scroll: window.scrollY };
    snapshot.current = currentOrder.current;
    withSearch(() => { void nav.openTicket(id, section); });
  };
  const focusFirst = (id: TicketId) => {
    snapshot.current = currentOrder.current;
    nav.changeTicket(id);
  };
  const lastSelection = useRef(ticket);
  useEffect(() => {
    const wasOpen = lastSelection.current;
    lastSelection.current = ticket;
    if (!wasOpen || ticket) return;
    const frame = requestAnimationFrame(() => {
      const results = document.getElementById("staff-ticket-results");
      const point = returnPoint.current;
      returnPoint.current = null;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement && active !== focusSource.current) return;
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
    });
    return () => cancelAnimationFrame(frame);
  }, [ticket, project?.key]);

  /** Resolves true only once the restore is confirmed, so callers keep the Ticket open otherwise. */
  async function restoreItem(id: TicketId): Promise<boolean> {
    const item = data.items.find(row => row._id === id) ?? (selected?._id === id ? selected : null);
    if (!item || busy.has(id) || inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    setRestoring(new Set(inFlight.current));
    try { await operations.restore(item); return true; }
    catch (error) {
      // A conflict or rejection is reported; the row's live subscription carries the latest version.
      if (!(error instanceof TicketOperationFailure) || error.disposition !== "unknown") throw error;
      // Absence from the archive cannot tell restore, purge claim and lost access apart, so read the Ticket by ID.
      const reference = formatTicketNumber(item.ticketNumber, item.projectKey);
      const current = await readTicket(item.projectId, item._id).catch(() => undefined);
      if (current?.lifecycle === "active") { toast.success(staffCopy.restoreConfirmed(reference)); return true; }
      if (current?.lifecycle === "archived") toast.info(staffCopy.restoreStillArchived(reference));
      else toast.error(staffCopy.restoreUnresolved(reference));
      return false;
    }
    finally { inFlight.current.delete(id); setRestoring(new Set(inFlight.current)); }
  }
  async function archiveItem(id: TicketId) {
    if (!selected || selected._id !== id) return;
    await operations.archive(selected);
  }
  const afterSubmit = (id?: TicketId) => {
    const draftProject = composer.project;
    composer.complete();
    if (draftProject && draftProject.key !== project?.key) {
      if (project) projectViews.current.set(project.key, nav.listView);
      if (id) nav.openTicket(id, undefined, { key: draftProject.key, view: projectViews.current.get(draftProject.key) ?? "board" });
      else chooseProject(draftProject.key);
    } else if (id) onSelect(id);
  };

  const inlineDetail = listView === "queue";
  const split = inlineDetail && Boolean(ticket);
  const single = nav.view === "focus" && split;
  const skipTarget = split && (!desktop || single) ? "staff-ticket-detail" : project ? "staff-results-heading" : "staff-ticket-results";
  const toolLoading = <p role="status" className="text-sm text-muted-foreground">{t("syncing")}</p>;
  const detail = <StaffTicketDialog ticket={selected} ticketId={ticket} onClose={nav.closeTicket} inline={inlineDetail} focusMode={nav.view === "focus"}
    inResults={selectedId && !data.loading ? order.includes(selectedId) : undefined}
    onToggleFocus={nav.view === "focus" ? nav.leaveFocus : nav.enterFocus}
    statusRecovery={selectedId ? moves.recoveryFor(selectedId) : null} statusBusy={Boolean(selected && busy.has(selected._id))}
    onPrevious={previous ? () => nav.changeTicket(previous) : undefined} onNext={next ? () => nav.changeTicket(next) : undefined}
    initialSection={nav.section} onMove={(_id, status) => { if (selected) void moves.moveItem(selected, status); }} onArchive={archiveItem} onRestore={restoreItem} />;

  return <main className="aurora-canvas min-h-screen">
    <a href={`#${skipTarget}`} className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:ring-2" onClick={event => {
      event.preventDefault();
      const target = document.getElementById(skipTarget);
      (target?.querySelector<HTMLElement>("h2") ?? target)?.focus();
    }}>{t("queueSkip")}</a>
    <div className={single ? "mx-auto max-w-4xl" : "mx-auto max-w-[100rem] px-3 sm:px-5 lg:pt-3 xl:px-7"}>
      <div className={single ? "hidden" : "contents"}>
      <StaffWorkspaceNavigation inbox={project && <TicketInbox compact key={project._id} role="staff" projectId={project._id} projectKey={project.key} openTicket={onSelect} />} projects={projects} current={project} archived={showArchived} hideOnPhone={split}
        search={exactProject && <div className="flex min-w-0 items-center gap-1">
          <TicketSearchInput className="min-w-0 flex-1" label={staffCopy.searchLabel(project.key)} value={searchInput} onChange={typeSearch} onClear={clearSearch} />
          <SavedSearchMenu key={project._id} staffId={viewer.staffId} projectId={project._id} projectKey={project.key} query={searchInput} archived={showArchived} onRestore={saved => {
            clearTimeout(searchTimer.current);
            setSearchInput(saved.query);
            nav.withQuery(saved.query, () => { if (saved.archived !== showArchived) void nav.setFilter(saved.archived ? "archive" : undefined); }, true);
          }} />
        </div>}
        searchQuery={searchInput}
        newTicket={(project || composer.owner) && <>
          <Button type="button" className="min-h-11 min-w-11 px-2.5 sm:px-3" aria-describedby={composer.hasDraft && !composer.open ? "staff-draft-project" : undefined} aria-expanded={composer.open}
            aria-label={composerLabel} title={composerLabel} onClick={composer.show}>
            <Plus aria-hidden /><span className={composer.foreignDraft ? undefined : "max-sm:sr-only"}>{composerLabel}</span>
          </Button>
        </>}
        legacyToolsEnabled={legacyToolsEnabled} lineEnabled={lineEnabled} t3Available={t3Available}
        onArchive={archived => withSearch(() => { void nav.setFilter(archived ? "archive" : undefined); })} onSelectProject={chooseProject} onTool={openTool} onLogout={composer.signOut} owner={owner} signedInAs={viewer.email} />
      </div>
      <div className="mx-auto w-full min-w-0 py-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pt-4">
        {composer.hasDraft && !composer.open && composer.owner && composer.project &&
          <aside className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <div id="staff-draft-project" className="min-w-0">
              <p className="break-words text-sm font-medium">{composer.project.name} ({composer.project.key})</p>
              <p className="text-xs text-muted-foreground">{t("draftSessionHint")}</p>
            </div>
            {composer.foreignDraft && <DiscardTicketDraft owner={composer.owner} busy={composer.busy} startCurrent onDiscard={composer.startCurrentProject} />}
          </aside>}
        {!ticket && moves.recovery}
        {project === null ? <NoProjects headingId="staff-ticket-results" action={owner && legacyToolsEnabled ? <Button onClick={() => setTool("project")}>{t("newProject")}</Button> : undefined} /> :
          project === undefined ? <div id="staff-ticket-results" tabIndex={-1} role="status" aria-label={t("syncing")} className="grid min-h-32 place-items-center"><Loader2 className="size-6 animate-spin" /></div> : <>
            <div className={`mb-2 flex-wrap items-center gap-x-3 gap-y-1 sm:mb-3 sm:gap-y-2 ${single ? "hidden" : split ? "hidden lg:flex" : "flex"}`}>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 sm:block">
                <h1 id="staff-results-heading" tabIndex={-1} className="text-lg font-semibold leading-tight tracking-tight sm:text-2xl">{showArchived ? t("archive") : nav.listView === "queue" ? t("queueTitle") : copy.results}</h1>
                {!showArchived && totals && <p className="text-xs tabular-nums text-muted-foreground sm:text-sm">
                  <span className="sr-only">{copy.results}: </span>{staffCopy.totals(totals.open, totals.done)}
                </p>}
              </div>
              <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1 lg:gap-1.5">
                {/* Phones reach Archive from More › Show; the h1 names the open list. */}
                <Button type="button" variant="ghost" aria-pressed={showArchived}
                  className={`min-h-11 min-w-11 gap-1.5 px-2.5 max-lg:hidden md:min-h-9 ${showArchived ? "bg-primary/15 text-primary hover:bg-primary/15" : "text-muted-foreground"}`}
                  onClick={() => withSearch(() => { void nav.setFilter(showArchived ? undefined : "archive"); })}>
                  <Archive aria-hidden /><span className="max-sm:sr-only">{staffCopy.showArchived}</span>
                </Button>
                {!single && (!split || desktop) && <TicketFilterPopover key={project._id} activeCount={filterCount} onClear={clearFilters}>
                  <StaffFilterFields rules={rules} tags={tags}>
                    {!showArchived && <>
                      <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">{t("ticketStatus")}
                        <select className={selectClass} value={filter} onChange={event => {
                          const status = event.target.value;
                          withSearch(() => { void nav.setFilter(status); });
                        }}>
                          <option value="active">{t("activeTickets")}</option><option value="all">{t("allTickets")}</option>
                          {statuses.map(status => <option key={status.value} value={status.value}>{t(status.labelKey)}</option>)}
                        </select>
                      </label>
                      <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">{routingCopy.assignment}
                        <select className={selectClass} value={nav.assignment ?? ""} onChange={event => {
                          const scope = event.target.value;
                          withSearch(() => { void nav.setAssignment(scope === "mine" || scope === "unassigned" ? scope : undefined); });
                        }}>
                          <option value="">{routingCopy.all}</option><option value="mine">{routingCopy.mine}</option>
                          <option value="unassigned">{routingCopy.unassigned}</option>
                        </select>
                      </label>
                    </>}
                  </StaffFilterFields>
                </TicketFilterPopover>}
                <StaffViewSwitcher archived={showArchived} view={listView} onSelect={view => withSearch(() => { void nav.setView(view); })} />
              </div>
            </div>
            <div id="staff-ticket-results" data-dialog-return-focus tabIndex={-1} className={split && !single ? "lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start lg:gap-4" : undefined}>
              <div className={single ? "hidden" : split ? "hidden lg:block" : "min-w-0"}>
            {data.invalidSearch ? <p role="alert" className="text-sm text-destructive">{t("searchLimit")}</p> : <TicketExplorer
              key={project._id} projectId={project._id} items={showArchived ? emptyTickets : data.items} archivedItems={showArchived ? data.items : emptyTickets}
              tags={tags} search={query} showArchived={showArchived} filters={rules}
              totals={data.totals ?? {}} pages={data.lanes} loading={data.loading}
              searchHasMore={data.searchHasMore} archiveSearchHasMore={data.searchHasMore}
              onSelect={onSelect} onMove={moves.moveItem} onRestore={id => { void restoreItem(id).catch(error => toast.error(localizeError(error, t))); }}
              workspace={{ view: nav.view === "focus" && inlineDetail ? "focus" : listView, lane: nav.lane, onLaneChange: lane => withSearch(() => { void nav.setLane(lane); }), ticketOpen: Boolean(ticket), visibleStatuses: data.visibleStatuses, selectedId: selectedId, orderKey: `${project.key}/${filter}/${assignmentFilter ?? ""}`, onOrder: orderChanged,
                onFocusFirst: focusFirst, hasMore: data.hasMore, loadingMore: data.loadingMore, loadMore: data.loadMore, busy }} />}
              </div>
              {inlineDetail && <div className="min-w-0 space-y-2">
                {detail}
                {selected && !next && data.hasMore && <Button variant="outline" className="min-h-11" disabled={data.loadingMore} onClick={data.loadMore}>{t("loadOlder")}</Button>}
              </div>}
            </div>
          </>}
      </div>
    </div>

    <Dialog open={composer.open} mobileFullScreen dismissible={!composer.busy} initialFocus={() => document.getElementById("title")}
      onOpenChange={composer.setOpen} title={t("newTicket")} description={composer.project ? `${composer.project.name} (${composer.project.key})` : undefined}>
      {composer.owner && <SubmitTicket key={composer.project?._id} draftOwner={composer.owner} active={composer.open} onSubmissionComplete={afterSubmit} />}
      {composer.hasDraft && composer.owner && <DiscardTicketDraft busy={composer.busy} owner={composer.owner} onDiscard={composer.discard} />}
    </Dialog>
    {t3Settings && <Dialog open onOpenChange={() => onT3Settings?.(false)} title={t("connectT3")}>
      <Suspense fallback={toolLoading}><ConnectT3Code key={viewer.staffId} requestProof={requestT3Proof} /></Suspense>
    </Dialog>}
    {legacyToolsEnabled && <Dialog open={nav.health} onOpenChange={nav.setHealth} title={t("healthTitle")} description={t("healthDescription")}>
      {nav.health && <Suspense fallback={toolLoading}><StaffHealth /></Suspense>}
    </Dialog>}
    {lineEnabled && lineSettings && project && <Dialog open onOpenChange={() => onLineSettings?.(false)} title="LINE" mobileFullScreen>
      <Suspense fallback={toolLoading}>
        <LineSettings key={project._id} project={project} selected={lineSettings.bot} owner={viewer.role === "owner"}
          onSelect={bot => onLineSettings?.(true, bot)} />
      </Suspense>
    </Dialog>}
    {tool === "routing" && project && routing !== null && <Dialog open onOpenChange={() => setTool(null)} title={routingCopy.routing} mobileFullScreen>
      {routing === undefined ? toolLoading : <Suspense fallback={toolLoading}>
        <RoutingWorkspace key={project._id} projectId={project._id} settings={routing} openTicket={id => {
          setTool(null);
          onSelect(id);
        }} />
      </Suspense>}
    </Dialog>}
    {owner && legacyToolsEnabled && <NewProjectDialog open={tool === "project"} onOpenChange={() => setTool(null)} onCreated={chooseProject} />}
    {tool === "members" && project && <ProjectMembersDialog project={project} owner={owner} open onOpenChange={() => setTool(null)} />}
    {owner && tool === "team" && <Dialog open onOpenChange={() => setTool(null)} title={t("teamTitle")} description={t("teamDescription")}>
      <Suspense fallback={toolLoading}><TeamAdministration ownerStaffId={viewer.staffId} /></Suspense>
    </Dialog>}
    {!inlineDetail && detail}

  </main>;
}
