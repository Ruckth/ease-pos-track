import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Columns3, Table2, Loader2 } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { TicketExplorerFilters } from "@/components/ticket-explorer-filters";
import { TicketTable } from "@/components/ticket-table";
import { StaffBoard } from "@/components/staff-board";
import { createFilterQuery } from "@/components/reui/filters/filters-query";
import type { FilterQuery } from "@/components/reui/filters/filters-types";
import { filterTickets, sortTickets, type ExplorerSort, type ExplorerTag } from "@/lib/ticket-explorer";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "@/lib/feedback-ui";
import type { Feedback, FeedbackStatus } from "@/lib/types";

export function TicketExplorer({ items, tags = [], search, onSearch, showArchived, onSelect, onMove, onRestore }: {
  items: Feedback[] | undefined; tags?: ExplorerTag[]; search: string; onSearch: (search: string) => void; showArchived: boolean;
  onSelect: (id: Id<"feedback">) => void; onMove: (id: Id<"feedback">, status: FeedbackStatus) => Promise<boolean>; onRestore: (id: Id<"feedback">) => void;
}) {
  const { language, t, formatDate } = useI18n();
  const explorerCopy = useExplorerCopy();
  const [view, setView] = useState<"board" | "table">("board");
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => createFilterQuery());
  const [sort, setSort] = useState<ExplorerSort>({ field: "createdAt", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const filtered = useMemo(() => filterTickets((items ?? []).filter((item) => showArchived || item.deletedAt === undefined), search, filterQuery), [items, search, filterQuery, showArchived]);
  const sorted = useMemo(() => sortTickets(filtered, sort, tags, language), [filtered, sort, tags, language]);
  const activeItems = useMemo(() => filtered.filter((item) => item.deletedAt === undefined), [filtered]);
  const archivedItems = useMemo(() => filtered.filter((item) => item.deletedAt !== undefined), [filtered]);
  useEffect(() => { setPage(1); }, [search, filterQuery, sort, showArchived, pageSize]);
  useEffect(() => { setPage((current) => Math.min(current, Math.max(1, Math.ceil(sorted.length / pageSize)))); }, [sorted.length, pageSize]);
  return (        <section className="min-w-0">
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1"><TicketExplorerFilters query={filterQuery} onChange={setFilterQuery} tags={tags} /></div>
              <div className="flex items-center gap-2">
                {(search || filterQuery.rules.length > 0) && <Button variant="ghost" size="sm" onClick={() => { onSearch(""); setFilterQuery(createFilterQuery()); }}>{explorerCopy.clearAll}</Button>}
                <div className="flex rounded-md border bg-card p-1" role="group" aria-label={explorerCopy.view}>
                  <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} aria-pressed={view === "board"} onClick={() => setView("board")}><Columns3 />{explorerCopy.board}</Button>
                  <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} aria-pressed={view === "table"} onClick={() => setView("table")}><Table2 />{explorerCopy.table}</Button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{explorerCopy.semantics}</p>
          </div>
          {items === undefined ? (
            <div className="grid min-h-72 place-items-center rounded-lg border bg-card">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
          ) : view === "table" ? (
            <TicketTable items={sorted} tags={tags} sort={sort} onSort={setSort} page={page} onPage={setPage} pageSize={pageSize} onPageSize={setPageSize} onSelect={onSelect} />
          ) : (
            <StaffBoard items={activeItems} onSelect={onSelect} onMoveCard={onMove} />
          )}
          {view === "board" && showArchived && archivedItems.length > 0 ? (
            <section className="mt-5 rounded-lg border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Archive className="size-4" />{t("archivedFeedback")}</h2>
              <div className="space-y-2">
                {archivedItems.map((item) => (
                  <div key={item._id} className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="text-sm leading-5 text-muted-foreground">
                        <span className="font-mono">{formatTicketNumber(item.ticketNumber)}</span>
                        {" · "}{t("archivedOn", { date: formatDate(item.deletedAt ?? item.updatedAt) })}
                      </span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => onRestore(item._id)}>
                      <ArchiveRestore /> {t("restore")}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </section>
  );
}
