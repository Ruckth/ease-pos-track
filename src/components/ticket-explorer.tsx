import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Columns3, Table2 } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { TicketExplorerFilters } from "@/components/ticket-explorer-filters";
import { TicketTable } from "@/components/ticket-table";
import { useTicketTags } from "@/components/ticket-tags";
import { createFilterQuery } from "@/components/reui/filters/filters-query";
import type { FilterQuery } from "@/components/reui/filters/filters-types";
import { filterTickets, matchesFilters, sortTickets, type ExplorerSort, type ExplorerTicket } from "@/lib/ticket-explorer";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";

/**
 * Board/Table switch over the Tickets the workspace has loaded (lane pages or
 * search matches, plus loaded archives when shown). Search stays on the server;
 * filters, sorting and table pagination run on those loaded rows only.
 */
export function TicketExplorer({ items, archived, search, onClearSearch, onSelect, board }: {
  items: ExplorerTicket[];
  archived: ExplorerTicket[];
  search: string;
  onClearSearch: () => void;
  onSelect: (id: Id<"tickets">) => void;
  /** Renders the board, hiding Tickets that fail `visible`. */
  board: (visible: (item: ExplorerTicket) => boolean) => ReactNode;
}) {
  const { language } = useI18n();
  const c = useExplorerCopy();
  const tags = useTicketTags() ?? [];
  const [view, setView] = useState<"board" | "table">("board");
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => createFilterQuery());
  const [sort, setSort] = useState<ExplorerSort>({ field: "createdAt", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const visible = useCallback((item: ExplorerTicket) => matchesFilters(item, filterQuery), [filterQuery]);
  const rows = useMemo(() => filterTickets([...items, ...archived], filterQuery), [items, archived, filterQuery]);
  const sorted = useMemo(() => sortTickets(rows, sort, tags, language), [rows, sort, tags, language]);
  useEffect(() => { setPage(1); }, [search, filterQuery, sort, pageSize, archived.length > 0]);
  useEffect(() => { setPage((current) => Math.min(current, Math.max(1, Math.ceil(sorted.length / pageSize)))); }, [sorted.length, pageSize]);

  return (
    <section className="min-w-0">
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="order-2 w-full min-w-0 sm:order-none sm:w-auto sm:flex-1"><TicketExplorerFilters query={filterQuery} onChange={setFilterQuery} tags={tags} /></div>
          <div className="flex items-center gap-2">
            {(search || filterQuery.rules.length > 0) && <Button variant="ghost" size="sm" onClick={() => { onClearSearch(); setFilterQuery(createFilterQuery()); }}>{c.clearAll}</Button>}
            <div className="flex rounded-md border bg-card p-1" role="group" aria-label={c.view}>
              <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 />{c.board}</Button>
              <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} aria-pressed={view === "table"} onClick={() => setView("table")}><Table2 />{c.table}</Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{c.semantics}</p>
      </div>
      {view === "table"
        ? <TicketTable items={sorted} sort={sort} onSort={setSort} page={page} onPage={setPage} pageSize={pageSize} onPageSize={setPageSize} onSelect={onSelect} />
        : board(visible)}
    </section>
  );
}
