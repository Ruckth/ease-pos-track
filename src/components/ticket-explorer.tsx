import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Columns3, Table2, Loader2 } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { TicketExplorerFilters } from "@/components/ticket-explorer-filters";
import { TicketTable } from "@/components/ticket-table";
import { StaffBoard } from "@/components/staff-board";
import { TicketCard } from "@/components/ticket-card";
import { createFilterQuery } from "@/components/reui/filters/filters-query";
import type { FilterQuery } from "@/components/reui/filters/filters-types";
import { filterTickets, sortTickets, type ExplorerSort, type ExplorerTag } from "@/lib/ticket-explorer";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import type { TicketSummary } from "../../shared/ticket-contracts";
import type { TicketStatus } from "@/lib/types";

type Page = { status: string; loadMore: (count: number) => void };

/** Filters and table pages operate on the explicitly loaded server pages. Search
 * is resolved by the backend before summaries arrive, including full descriptions. */
export function TicketExplorer({ projectId, token, items, archivedItems, tags, search, onSearch, showArchived, totals, pages, archive, loading, searchHasMore, archiveSearchHasMore, visibleLane, onLaneChange, onSelect, onMove, onRestore }: {
  projectId: Id<"projects">; token: string; items: TicketSummary[]; archivedItems: TicketSummary[];
  tags: ExplorerTag[]; search: string; onSearch: (search: string) => void; showArchived: boolean;
  totals: Partial<Record<TicketStatus, number>>; pages: Record<TicketStatus, Page>; archive: Page;
  loading: boolean; searchHasMore?: boolean; archiveSearchHasMore?: boolean;
  visibleLane: TicketStatus;
  onLaneChange: (status: TicketStatus) => void;
  onSelect: (id: Id<"tickets">) => void;
  onMove: (item: TicketSummary, status: TicketStatus) => Promise<number | null>;
  onRestore: (id: Id<"tickets">) => void;
}) {
  const { language, t, formatDate } = useI18n();
  const c = useExplorerCopy();
  const [view, setView] = useState<"board" | "table">("board");
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => createFilterQuery());
  const [sort, setSort] = useState<ExplorerSort>({ field: "createdAt", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const active = useMemo(() => filterTickets(items, "", filterQuery), [items, filterQuery]);
  const archived = useMemo(() => filterTickets(archivedItems, "", filterQuery), [archivedItems, filterQuery]);
  const sorted = useMemo(() => sortTickets([...active, ...(showArchived ? archived : [])], sort, tags, language), [active, archived, showArchived, sort, tags, language]);
  useEffect(() => { setPage(1); }, [search, filterQuery, sort, showArchived, pageSize]);
  const filteredTotals = filterQuery.rules.length ? Object.fromEntries(Object.keys(pages).map(status => [status, active.filter(item => item.status === status).length])) : totals;
  const morePages = !search && (Object.values(pages).some(p => p.status !== "Exhausted") || (showArchived && archive.status !== "Exhausted"));
  return <section className="min-w-0">
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="order-2 w-full min-w-0 sm:order-none sm:w-auto sm:flex-1"><TicketExplorerFilters query={filterQuery} onChange={setFilterQuery} tags={tags} /></div>
        <div className="flex items-center gap-2">
          {(search || filterQuery.rules.length > 0) && <Button variant="ghost" size="sm" onClick={() => { onSearch(""); setFilterQuery(createFilterQuery()); }}>{c.clearAll}</Button>}
          <div className="flex rounded-md border bg-card p-1" role="group" aria-label={c.view}>
            <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 />{c.board}</Button>
            <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} aria-pressed={view === "table"} onClick={() => setView("table")}><Table2 />{c.table}</Button>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{c.semantics} {c.loadedScope}</p>
      {search ? <><p className="text-sm text-muted-foreground">{t("searchHint")}</p><p className="text-sm">{t(searchHasMore ? "searchLoaded" : "searchMatches", { count: items.length })}</p></> : null}
    </div>
    {loading ? <div className="grid min-h-72 place-items-center rounded-lg border bg-card"><Loader2 className="size-7 animate-spin text-muted-foreground" /></div> : view === "table" ? <TicketTable items={sorted} sort={sort} onSort={setSort} page={page} onPage={setPage} pageSize={pageSize} onPageSize={setPageSize} onSelect={onSelect} />
      : search ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{active.map(item => <TicketCard key={item._id} item={item} onSelect={onSelect} />)}</div>
      : <StaffBoard projectId={projectId} token={token} items={active} totals={filteredTotals} pages={pages} visibleLane={visibleLane} onLaneChange={onLaneChange} onSelect={onSelect} onMoveCard={onMove} />}
    {view === "table" && morePages ? <Button className="mt-4" disabled={Object.values(pages).some(p => p.status === "LoadingMore") || archive.status === "LoadingMore"} onClick={() => {
      Object.values(pages).forEach(p => { if (p.status === "CanLoadMore") p.loadMore(20); });
      if (showArchived && archive.status === "CanLoadMore") archive.loadMore(20);
    }}>{t("loadOlder")}</Button> : null}
    {view === "board" && showArchived ? <section className="mt-5 rounded-lg border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Archive />{t("archivedTicket")}</h2>
      <div className="space-y-2">{archived.map(item => <div key={item._id} className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
        <button type="button" className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(item._id)}>
          <span className="block truncate text-sm font-medium">{item.title}</span>
          <span className="text-sm text-muted-foreground"><span className="font-mono">{formatTicketNumber(item.ticketNumber, item.projectKey)}</span>{" · "}{t("archivedOn", { date: formatDate(item.archivedAt ?? item.updatedAt) })}</span>
        </button>
        <Button type="button" variant="outline" size="sm" onClick={() => onRestore(item._id)}><ArchiveRestore />{t("restore")}</Button>
      </div>)}</div>
      {search ? archiveSearchHasMore ? <p className="text-sm text-muted-foreground">{t("searchLoaded", { count: archivedItems.length })}</p> : null : archive.status !== "Exhausted" ? <Button className="mt-3" disabled={archive.status !== "CanLoadMore"} onClick={() => archive.loadMore(20)}>{t("loadOlder")}</Button> : null}
    </section> : null}
  </section>;
}
