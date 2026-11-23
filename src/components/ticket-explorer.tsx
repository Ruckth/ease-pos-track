import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns3, ListFilter, Loader2, RotateCw, Table2 } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { TicketCard, type OpenTicket } from "@/components/ticket-card";
import { createFilterQuery, createFilterRule } from "@/components/reui/filters/filters-query";
import type { FilterQuery } from "@/components/reui/filters/filters-types";
import { filterTickets, sortTickets, type ExplorerSort, type ExplorerTag } from "@/lib/ticket-explorer";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BOARD_COLUMNS } from "@/lib/kanban-board";
import { DEFAULT_STAFF_LANE } from "@/app/workspace-search";
import { stableQueue } from "@/lib/staff-ticket-queue";
import type { TicketSummary } from "../../shared/ticket-contracts";
import type { TicketStatus } from "@/lib/types";

const TicketExplorerFilters = lazy(() => import("@/components/ticket-explorer-filters").then(module => ({ default: module.TicketExplorerFilters })));
const TicketTable = lazy(() => import("@/components/ticket-table").then(module => ({ default: module.TicketTable })));
const StaffBoard = lazy(() => import("@/components/staff-board").then(module => ({ default: module.StaffBoard })));

const priorityRule = createFilterRule({ id: "high-or-critical", path: ["urgencyScore"], operator: "between", value: [51, 100] });

function laneCounts(rows: TicketSummary[]) {
  const counts = { new: 0, acknowledged: 0, in_progress: 0, waiting: 0, done: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

type Page = { status: string; loadMore: (count: number) => void };
type View = "queue" | "focus" | "board" | "table";
type Workspace = {
  view: View;
  selectedId: Id<"tickets"> | null;
  ticketOpen: boolean;
  lane?: TicketStatus;
  onLaneChange: (status: TicketStatus) => void;
  visibleStatuses: readonly TicketStatus[];
  orderKey: string;
  onOrder: (ordered: Id<"tickets">[]) => void;
  onFocusFirst: (id: Id<"tickets">) => void;
  onFiltersOpen: (open: boolean) => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  busy: ReadonlySet<string>;
};

export function TicketExplorer({ projectId, items, archivedItems, tags, search, onSearch, showArchived, totals, pages, archive, loading, searchHasMore, archiveSearchHasMore, onSelect, onMove, onRestore, workspace }: {
  projectId: Id<"projects">; items: TicketSummary[]; archivedItems: TicketSummary[];
  tags: ExplorerTag[]; search: string; onSearch: (search: string) => void; showArchived: boolean;
  totals: Partial<Record<TicketStatus, number>>; pages: Record<TicketStatus, Page>; archive?: Page;
  loading: boolean; searchHasMore?: boolean; archiveSearchHasMore?: boolean;
  onSelect: OpenTicket;
  onMove: (item: TicketSummary, status: TicketStatus) => Promise<number | null>;
  onRestore: (id: Id<"tickets">) => void;
  workspace?: Workspace;
}) {
  const { language, t } = useI18n();
  const c = useExplorerCopy();
  const [localView, setLocalView] = useState<"board" | "table">("board");
  const view = workspace?.view ?? localView;
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => createFilterQuery());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [highUrgency, setHighUrgency] = useState(false);
  const [searchLane, setSearchLane] = useState<{ query: string; lane: TicketStatus } | null>(null);
  const [boardLane, setBoardLane] = useState<TicketStatus>(DEFAULT_STAFF_LANE);
  const effectiveQuery = useMemo(() => highUrgency
    ? createFilterQuery([filterQuery, priorityRule])
    : filterQuery, [filterQuery, highUrgency]);
  const [sort, setSort] = useState<ExplorerSort>({ field: "createdAt", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [revision, setRevision] = useState(0);
  const priorOrder = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const orderKey = JSON.stringify([workspace?.orderKey, search, revision]);
  const active = useMemo(() => filterTickets(items, "", effectiveQuery), [items, effectiveQuery]);
  const archived = useMemo(() => filterTickets(archivedItems, "", effectiveQuery), [archivedItems, effectiveQuery]);
  const combined = useMemo(() => showArchived ? [...active, ...archived] : active, [active, archived, showArchived]);
  const ordered = useMemo(() => {
    if (view === "table") return sortTickets(combined, sort, tags, language);
    if (search || showArchived || view === "board") return combined;
    return stableQueue(combined, priorOrder.current.key === orderKey ? priorOrder.current.ids : []);
  }, [view, combined, search, showArchived, orderKey, sort, tags, language]);
  const onOrder = workspace?.onOrder;
  useLayoutEffect(() => {
    if (loading) return;
    const ids = ordered.map(item => item._id);
    if (!search && !showArchived && (view === "queue" || view === "focus")) priorOrder.current = { key: orderKey, ids };
    onOrder?.(ids);
  }, [ordered, loading, onOrder, orderKey, view, search, showArchived]);
  useEffect(() => { setPage(1); }, [search, effectiveQuery, sort, showArchived, pageSize, workspace?.orderKey]);
  const first = ordered[0]?._id;
  const focusFirst = workspace?.onFocusFirst;
  const selectedId = workspace?.selectedId;
  const ticketOpen = workspace?.ticketOpen;
  useEffect(() => {
    if (view === "focus" && !ticketOpen && !loading && first) focusFirst?.(first);
  }, [view, ticketOpen, loading, first, focusFirst]);

  const onFiltersOpen = workspace?.onFiltersOpen;
  useEffect(() => {
    onFiltersOpen?.(filtersOpen);
    return () => onFiltersOpen?.(false);
  }, [onFiltersOpen, filtersOpen]);

  const rules = filterQuery.rules.length;
  const filtering = rules > 0 || highUrgency;
  const board = view === "board" && (!workspace || !showArchived);
  const loadedByLane = useMemo(() => board ? laneCounts(items) : undefined, [board, items]);
  const shownByLane = useMemo(() => board && (filtering || search) ? laneCounts(active) : undefined, [board, filtering, search, active]);
  const loaded = items.length + (showArchived ? archivedItems.length : 0);
  const capped = Boolean(search && (searchHasMore || (showArchived && archiveSearchHasMore)));
  const legacyPages = [...Object.values(pages), ...(showArchived && archive ? [archive] : [])];
  const morePages = workspace?.hasMore ?? (!search && legacyPages.some(page => page.status === "CanLoadMore"));
  const loadingMore = workspace?.loadingMore ?? legacyPages.some(page => page.status === "LoadingMore");
  const loadMore = workspace?.loadMore ?? (() => legacyPages.forEach(page => { if (page.status === "CanLoadMore") page.loadMore(20); }));
  const partial = capped || morePages;
  const emptyText = partial ? c.loadedEmpty : filtering || search ? c.noResults : c.emptyView;
  const resultSummary = capped ? c.cappedMatches(combined.length, loaded)
    : filtering ? c.matching(combined.length, loaded)
    : search ? t("searchMatches", { count: combined.length })
    : morePages && view === "table" ? t("loadedTickets", { count: loaded }) : undefined;
  const preferredLane = workspace
    ? workspace.lane ?? (search ? active[0]?.status : undefined) ?? DEFAULT_STAFF_LANE
    : search && searchLane?.query === search ? searchLane.lane : search ? active[0]?.status ?? boardLane : boardLane;
  const chooseLane = (lane: TicketStatus) => {
    if (workspace) workspace.onLaneChange(lane);
    else if (search) setSearchLane({ query: search, lane });
    else setBoardLane(lane);
  };
  const fallback = <p role="status" className="py-3 text-sm text-muted-foreground">{t("syncing")}</p>;
  const filters = <Suspense fallback={fallback}><TicketExplorerFilters query={filterQuery} onChange={setFilterQuery} tags={tags} /></Suspense>;
  const reset = () => { onSearch(""); setFilterQuery(createFilterQuery()); setHighUrgency(false); };
  const summary = (item: TicketSummary) => <TicketCard key={item._id} item={item} onSelect={onSelect} selected={item._id === selectedId}
    busy={workspace?.busy.has(item._id)} onMove={(_id, status) => { void onMove(item, status); }} onRestore={onRestore} />;

  return <section className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center gap-1.5">
      <Button type="button" variant="ghost" size="sm" className={cn("aurora-control min-h-11 rounded-lg md:min-h-8", highUrgency && "bg-primary/15 text-primary")} aria-pressed={highUrgency}
        onClick={() => setHighUrgency(value => !value)}>{c.highOrCritical}</Button>
      {workspace ? <details className="min-w-0 flex-1 open:basis-full" open={filtersOpen} onToggle={event => {
        const open = event.currentTarget.open;
        setFiltersOpen(open);
      }}>
        <summary className="aurora-control flex w-fit min-h-11 cursor-pointer list-none items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:min-h-8">
          <ListFilter aria-hidden className="size-4" />{t("queueFilters")}{rules > 0 ? ` (${rules})` : ""}
        </summary>
        {filtersOpen && <div className="aurora-panel mt-1.5 space-y-2 rounded-xl p-2">{filters}<p className="text-xs text-muted-foreground">{c.loadedScope}</p></div>}
      </details> : <div className="min-w-0 basis-full md:flex-1">{filters}</div>}
      {(search || filtering) && <Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={reset}>{c.clearAll}</Button>}
      {!workspace && <div className="flex rounded-md border border-transparent bg-field p-1" role="group" aria-label={c.view}>
        <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} aria-pressed={view === "board"} onClick={() => setLocalView("board")}><Columns3 />{c.board}</Button>
        <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} aria-pressed={view === "table"} onClick={() => setLocalView("table")}><Table2 />{c.table}</Button>
      </div>}
      {workspace && view === "queue" && !search && !showArchived && <Button size="sm" variant="ghost" className="min-h-11 md:min-h-8" onClick={() => setRevision(current => current + 1)}><RotateCw />{t("queueRefresh")}</Button>}
    </div>
    {!loading && resultSummary && <p role="status" className="text-sm text-muted-foreground">{resultSummary}</p>}
    <Suspense fallback={fallback}>
    {loading ? <div role="status" aria-label={t("syncing")} className="grid min-h-32 place-items-center"><Loader2 aria-hidden className="size-6 animate-spin text-muted-foreground" /></div>
      : view === "table" ? <TicketTable items={ordered} sort={sort} onSort={setSort} page={page} onPage={setPage} pageSize={pageSize} onPageSize={setPageSize} onSelect={onSelect}
          onMove={onMove} onRestore={onRestore} busy={workspace?.busy} emptyText={emptyText} />
      : board ? <StaffBoard projectId={projectId} items={active} totals={totals} shownByLane={shownByLane} loadedByLane={filtering && !search ? loadedByLane : undefined}
          visibleStatuses={workspace?.visibleStatuses ?? BOARD_COLUMNS} pages={search ? undefined : pages} constrained={Boolean(search || filtering)}
          chosenStatus={preferredLane} onChooseStatus={chooseLane} busy={workspace?.busy}
          onSelect={onSelect} onMoveCard={onMove} />
      : ordered.length ? <div className="space-y-2">
        {!search && !filtering && <p className="text-xs text-muted-foreground">{t("loadedTickets", { count: ordered.length })}{!showArchived ? ` · ${t("queuePriority")}` : ""}</p>}
        {ordered.map(summary)}
      </div> : <div role="status" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{emptyText}</div>}
    </Suspense>
    {board && !workspace && showArchived && <section className="space-y-2"><h2>{t("archivedTicket")}</h2>{archived.map(summary)}</section>}
    {!loading && !board && morePages && <Button variant="outline" className="min-h-11" disabled={loadingMore} onClick={loadMore}>{t("loadOlder")}</Button>}
  </section>;
}
