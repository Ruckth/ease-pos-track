import { useCallback, useEffect, useRef, useState } from "react";
import { FolderPlus, HeartPulse, Loader2, LogOut, MoreHorizontal, Plus, Search, Users } from "lucide-react";
import { toast, Toaster } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { StaffHealth } from "@/features/operations/staff-health";
import { LanguageSelector } from "@/components/auth-screens";
import { NewProjectDialog, NoProjects, ProjectMembersDialog, ProjectSwitcher, useCurrentProject } from "@/components/project-controls";
import { TicketExplorer } from "@/components/ticket-explorer";
import { statuses } from "@/components/ticket-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { localizeError, useI18n } from "@/lib/i18n";
import { queueNeighbors } from "@/lib/staff-ticket-queue";
import { type Ticket, type TicketStatus } from "@/lib/types";
import { useStaffTickets, useTicketTags, useWorkspaceTicket } from "./adapter";
import { SubmitTicket } from "./staff-composer";
import { StaffTicketDialog } from "./staff-ticket-dialog";
import { useComposer } from "./use-composer";
import { useTicketOperations } from "./use-ticket-operations";
import { useWorkspaceNavigation } from "./use-workspace-navigation";

const selectClass = "min-h-11 max-w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground";
type TicketId = Id<"tickets">;

export function StaffWorkspace({ token, onLogout }: { token: string; onLogout: () => Promise<void> }) {
  const { language, setLanguage, t } = useI18n();
  const copy = useExplorerCopy();
  const { projects, current: project, select: selectProject } = useCurrentProject(token);
  const nav = useWorkspaceNavigation("staff", project?.key);
  const composer = useComposer(project);
  const operations = useTicketOperations(token);
  const [tool, setTool] = useState<"project" | "members" | "health" | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const menu = useRef<HTMLDetailsElement>(null);
  const focusSource = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const query = nav.query.trim();
  const filter = ["active", "all", "archive", ...statuses.map(status => status.value)].includes(nav.filter) ? nav.filter : "active";
  const showArchived = filter === "archive";
  const data = useStaffTickets(token, project?._id, nav.view, filter, query);
  const tags = useTicketTags(token, filtersOpen);
  const selected = useWorkspaceTicket(token, nav.ticketId, project?._id);
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
      if (focusSource.current?.isConnected && focusSource.current.getClientRects().length) focusSource.current.focus({ preventScroll: true });
      else searchInput.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [nav.ticketId]);
  const closeDetail = () => {
    if (nav.view === "focus") nav.setView("queue");
    else nav.closeTicket();
  };
  const openTool = (nextTool: typeof tool) => {
    if (menu.current) menu.current.open = false;
    setTool(nextTool);
  };

  async function moveItem(item: TicketSummary | Ticket, status: TicketStatus) {
    if (inFlight.current.has(item._id)) return null;
    inFlight.current.add(item._id);
    setBusy(new Set(inFlight.current));
    try { return (await operations.status(item, status)).version; }
    catch (error) { toast.error(localizeError(error, t)); return null; }
    finally { inFlight.current.delete(item._id); setBusy(new Set(inFlight.current)); }
  }
  async function restoreItem(id: TicketId) {
    const item = data.items.find(row => row._id === id) ?? (selected?._id === id ? selected : null);
    if (!item || inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusy(new Set(inFlight.current));
    try { await operations.restore(item); }
    finally { inFlight.current.delete(id); setBusy(new Set(inFlight.current)); }
  }
  async function archiveItem(id: TicketId) {
    if (!selected || selected._id !== id) return;
    await operations.archive(selected);
  }
  const afterSubmit = (id?: TicketId) => {
    const draftProject = composer.project;
    composer.complete();
    if (draftProject && draftProject.key !== project?.key) selectProject(draftProject.key);
    if (id) onSelect(id);
  };

  const inlineDetail = nav.view === "queue" || nav.view === "focus";
  const split = inlineDetail && Boolean(nav.ticketId);
  const single = nav.view === "focus" && split;
  const detail = <StaffTicketDialog ticket={selected} ticketId={nav.ticketId} token={token} onClose={closeDetail} inline={inlineDetail}
    onPrevious={previous ? () => nav.changeTicket(previous) : undefined} onNext={next ? () => nav.changeTicket(next) : undefined}
    initialSection={nav.section} onMove={(_id, status) => { if (selected) void moveItem(selected, status); }} onArchive={archiveItem} onRestore={restoreItem} />;

  return <main className="min-h-screen">
    <a href="#staff-ticket-results" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:ring-2" onClick={event => {
      event.preventDefault();
      document.getElementById("staff-ticket-results")?.focus();
    }}>{t("queueSkip")}</a>
    <Toaster richColors position="bottom-right" />
    <header className={`border-b bg-card ${split ? "hidden lg:block" : ""}`}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2 [&_select]:min-h-11">
          <span className="font-semibold">{t("appName")}</span>
          {project && projects && <ProjectSwitcher projects={projects} current={project} onSelect={selectProject} />}
        </div>
        <details ref={menu} className="relative" onKeyDown={event => {
          if (event.key !== "Escape" || !event.currentTarget.open) return;
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4" />{t("queueMore")}</summary>
          <div className="absolute right-0 z-30 mt-1 grid w-56 max-w-[calc(100vw-2rem)] gap-1 rounded-lg border bg-card p-2 shadow-lg">
            <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("project")}><FolderPlus />{t("newProject")}</Button>
            {project && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("members")}><Users />{t("projectMembers")}</Button>}
            <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("health")}><HeartPulse />{t("healthTitle")}</Button>
            <div className="border-t pt-2 [&_button]:min-h-11 [&_button]:min-w-11 [&_select]:min-h-11"><LanguageSelector language={language} onChange={setLanguage} /></div>
            <Button variant="ghost" className="min-h-11 justify-start" onClick={() => void onLogout()}><LogOut />{t("signOut")}</Button>
          </div>
        </details>
      </div>
    </header>

    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
      <div className={`mb-4 flex-wrap items-center justify-between gap-2 ${split ? "hidden lg:flex" : "flex"}`}>
        <h1 className="text-2xl font-semibold tracking-tight">{showArchived ? t("archive") : t("queueTitle")}</h1>
        <Button type="button" className="min-h-11" aria-expanded={composer.open} disabled={!project && !composer.owner} onClick={composer.show}>
          <Plus />{composer.hasDraft ? t("resumeTicket") : t("newTicket")}
        </Button>
      </div>
      {project === null ? <NoProjects action={<Button onClick={() => openTool("project")}>{t("newProject")}</Button>} /> :
        project === undefined ? <div role="status" aria-label={t("syncing")} className="grid min-h-32 place-items-center"><Loader2 className="size-6 animate-spin" /></div> : <>
          <div className={`mb-2 flex-wrap items-end gap-2 ${split ? "hidden lg:flex" : "flex"}`}>
            <label className="relative min-w-0 grow basis-full text-xs text-muted-foreground sm:basis-52">
              {t("search")}<Search className="pointer-events-none absolute bottom-3 left-3 size-4" aria-hidden />
              <Input ref={searchInput} className="mt-1 min-h-11 pl-9" placeholder={t("search")} maxLength={200} value={nav.query} onChange={event => nav.setQuery(event.target.value)} />
            </label>
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{t("ticketStatus")}
              <select className={selectClass} value={filter} onChange={event => nav.setFilter(event.target.value)}>
                <option value="active">{t("activeTickets")}</option><option value="all">{t("allTickets")}</option>
                {statuses.map(status => <option key={status.value} value={status.value}>{t(status.labelKey)}</option>)}
                <option value="archive">{t("archive")}</option>
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{copy.view}
              <select id="staff-ticket-layout" className={selectClass} value={nav.view} onChange={event => nav.setView(event.target.value as typeof nav.view)}>
                <option value="queue">{t("queueLabel")}</option><option value="board">{copy.board}</option>
                <option value="table">{copy.table}</option><option value="focus">{t("queueFocus")}</option>
              </select>
            </label>
          </div>
          <div id="staff-ticket-results" tabIndex={-1} className={split && !single ? "lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start lg:gap-4" : undefined}>
            <div className={single ? "hidden" : split ? "hidden lg:block" : "min-w-0"}>
          {data.invalidSearch ? <p role="alert" className="text-sm text-destructive">{t("searchLimit")}</p> : <TicketExplorer
            key={project._id} projectId={project._id} token={token} items={showArchived ? [] : data.items} archivedItems={showArchived ? data.items : []}
            tags={tags ?? data.items.flatMap(item => item.tags)} search={query} onSearch={nav.setQuery} showArchived={showArchived}
            totals={data.totals ?? {}} pages={data.lanes} loading={data.loading}
            searchHasMore={data.searchHasMore} archiveSearchHasMore={data.searchHasMore}
            onSelect={onSelect} onMove={moveItem} onRestore={id => { void restoreItem(id).catch(error => toast.error(localizeError(error, t))); }}
            workspace={{ view: nav.view, visibleStatuses: data.enabledLanes, selectedId: nav.ticketId, orderKey: `${project.key}/${filter}`, onOrder: orderChanged,
              onFocusFirst: focusFirst, onFiltersOpen: setFiltersOpen, hasMore: data.hasMore, loadingMore: data.loadingMore, loadMore: data.loadMore, busy }} />}
            </div>
            {inlineDetail && <div className="min-w-0 space-y-2">
              {detail}
              {selected && !next && data.hasMore && <Button variant="outline" className="min-h-11" disabled={data.loadingMore} onClick={data.loadMore}>{t("loadOlder")}</Button>}
            </div>}
          </div>
        </>}
    </div>

    <Dialog open={composer.open} mobileFullScreen initialFocus={() => document.getElementById("title")}
      onOpenChange={composer.setOpen} title={t("newTicket")} description={composer.project ? `${composer.project.name} (${composer.project.key})` : undefined}>
      {composer.owner && <SubmitTicket key={composer.project?._id} token={token} draftOwner={composer.owner} active={composer.open} onSubmissionComplete={afterSubmit} />}
      {composer.hasDraft && <Button className="mt-3 min-h-11" variant="ghost" disabled={composer.busy} onClick={composer.discard}>{t("discardDraft")}</Button>}
    </Dialog>
    <Dialog open={tool === "health"} onOpenChange={() => setTool(null)} title={t("healthTitle")} description={t("healthDescription")}>
      {tool === "health" && <StaffHealth token={token} />}
    </Dialog>
    <NewProjectDialog token={token} open={tool === "project"} onOpenChange={() => setTool(null)} onCreated={selectProject} />
    {tool === "members" && project && <ProjectMembersDialog token={token} project={project} open onOpenChange={() => setTool(null)} />}
    {!inlineDetail && detail}

  </main>;
}
