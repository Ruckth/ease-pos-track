import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns3, Loader2, RotateCw, Table2 } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { TicketCard, type OpenTicket } from "@/components/ticket-card";
import { createFilterQuery } from "@/components/reui/filters/filters-query";
import type { FilterQuery } from "@/components/reui/filters/filters-types";
import { filterTickets, sortTickets, type ExplorerSort, type ExplorerTag } from "@/lib/ticket-explorer";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";
import { stableQueue } from "@/lib/staff-ticket-queue";
import type { TicketSummary } from "../../shared/ticket-contracts";
import type { TicketStatus } from "@/lib/types";

const TicketExplorerFilters = lazy(() => import("@/components/ticket-explorer-filters").then(module => ({ default: module.TicketExplorerFilters })));
const TicketTable = lazy(() => import("@/components/ticket-table").then(module => ({ default: module.TicketTable })));
const StaffBoard = lazy(() => import("@/components/staff-board").then(module => ({ default: module.StaffBoard })));

type Page = { status: string; loadMore: (count: number) => void };
type View = "queue" | "focus" | "board" | "table";
type Workspace = {
  view: View;
  selectedId: Id<"tickets"> | null;
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

export function TicketExplorer({ projectId, token, items, archivedItems, tags, search, onSearch, showArchived, totals, pages, archive, loading, searchHasMore, archiveSearchHasMore, onSelect, onMove, onRestore, workspace }: {
  projectId: Id<"projects">; token: string; items: TicketSummary[]; archivedItems: TicketSummary[];
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
  const [sort, setSort] = useState<ExplorerSort>({ field: "createdAt", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [revision, setRevision] = useState(0);
  const priorOrder = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const orderKey = JSON.stringify([workspace?.orderKey, search, revision]);
  const active = useMemo(() => filterTickets(items, "", filterQuery), [items, filterQuery]);
  const archived = useMemo(() => filterTickets(archivedItems, "", filterQuery), [archivedItems, filterQuery]);
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
  useEffect(() => { setPage(1); }, [search, filterQuery, sort, showArchived, pageSize]);
  const first = ordered[0]?._id;
  const focusFirst = workspace?.onFocusFirst;
  const selectedId = workspace?.selectedId;
  useEffect(() => {
    if (view === "focus" && !selectedId && !loading && first) focusFirst?.(first);
  }, [view, selectedId, loading, first, focusFirst]);

  const onFiltersOpen = workspace?.onFiltersOpen;
  useEffect(() => {
    onFiltersOpen?.(filtersOpen);
    return () => onFiltersOpen?.(false);
  }, [onFiltersOpen, filtersOpen]);

  const rules = filterQuery.rules.length;
  const filteredTotals = rules ? Object.fromEntries(Object.keys(pages).map(status => [status, active.filter(item => item.status === status).length])) : totals;
  const legacyPages = [...Object.values(pages), ...(showArchived && archive ? [archive] : [])];
  const morePages = workspace?.hasMore ?? (!search && legacyPages.some(page => page.status === "CanLoadMore"));
  const loadingMore = workspace?.loadingMore ?? legacyPages.some(page => page.status === "LoadingMore");
  const loadMore = workspace?.loadMore ?? (() => legacyPages.forEach(page => { if (page.status === "CanLoadMore") page.loadMore(20); }));
  const board = view === "board" && !search && (!workspace || !showArchived);
  const fallback = <p role="status" className="py-3 text-sm text-muted-foreground">{t("syncing")}</p>;
  const filters = <Suspense fallback={fallback}><TicketExplorerFilters query={filterQuery} onChange={setFilterQuery} tags={tags} /></Suspense>;
  const reset = () => { onSearch(""); setFilterQuery(createFilterQuery()); };
  const summary = (item: TicketSummary) => <TicketCard key={item._id} item={item} onSelect={onSelect} selected={item._id === selectedId}
    busy={workspace?.busy.has(item._id)} onMove={(_id, status) => { void onMove(item, status); }} onRestore={onRestore} />;

  return <section className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {workspace ? <details className="min-w-0 flex-1" open={filtersOpen} onToggle={event => {
        const open = event.currentTarget.open;
        setFiltersOpen(open);
      }}>
        <summary className="w-fit min-h-11 cursor-pointer rounded py-3 text-sm font-medium text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {t("queueFilters")}{rules > 0 ? ` (${rules})` : ""}
        </summary>
        {filtersOpen && <div className="space-y-2 pb-2">{filters}<p className="text-xs text-muted-foreground">{c.loadedScope}</p></div>}
      </details> : <div className="min-w-0 flex-1">{filters}</div>}
      {(search || rules > 0) && <Button variant="ghost" size="sm" className="min-h-11" onClick={reset}>{c.clearAll}</Button>}
      {!workspace && <div className="flex rounded-md border bg-card p-1" role="group" aria-label={c.view}>
        <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} aria-pressed={view === "board"} onClick={() => setLocalView("board")}><Columns3 />{c.board}</Button>
        <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} aria-pressed={view === "table"} onClick={() => setLocalView("table")}><Table2 />{c.table}</Button>
      </div>}
      {workspace && view === "queue" && !search && !showArchived && <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setRevision(current => current + 1)}><RotateCw />{t("queueRefresh")}</Button>}
    </div>
    {search && !loading && <p role="status" className="text-sm text-muted-foreground">
      {t((showArchived ? archiveSearchHasMore : searchHasMore) ? "searchLoaded" : "searchMatches", { count: combined.length })}
    </p>}
    <Suspense fallback={fallback}>
    {loading ? <div role="status" aria-label={t("syncing")} className="grid min-h-32 place-items-center"><Loader2 aria-hidden className="size-6 animate-spin text-muted-foreground" /></div>
      : view === "table" ? <TicketTable items={ordered} sort={sort} onSort={setSort} page={page} onPage={setPage} pageSize={pageSize} onPageSize={setPageSize} onSelect={onSelect} />
      : board ? <StaffBoard projectId={projectId} token={token} items={active} totals={filteredTotals} visibleStatuses={workspace?.visibleStatuses} pages={pages} onSelect={onSelect} onMoveCard={onMove} />
      : ordered.length ? <div className="space-y-2">
        {!search && <p className="text-xs text-muted-foreground">{t("loadedTickets", { count: ordered.length })}{!showArchived ? ` · ${t("queuePriority")}` : ""}</p>}
        {ordered.map(summary)}
      </div> : <div role="status" className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{c.noResults}</div>}
    </Suspense>
    {board && !workspace && showArchived && <section className="space-y-2"><h2>{t("archivedTicket")}</h2>{archived.map(summary)}</section>}
    {!loading && !board && morePages && <Button variant="outline" className="min-h-11" disabled={loadingMore} onClick={loadMore}>{t("loadOlder")}</Button>}
  </section>;
}
