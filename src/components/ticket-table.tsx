import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TicketCustomerReply } from "./ticket-customer-reply";
import { TicketCard, type OpenTicket } from "./ticket-card";
import { TicketUrgency } from "./ticket-urgency";
import { TicketRowAction } from "./ticket-row-action";
import { TicketPurgeEligibility } from "./ticket-purge-eligibility";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import type { TicketStatus } from "@/lib/types";
import { TicketTagList } from "@/components/ticket-tags";
import { statusMeta } from "@/components/ticket-status";
import { useI18n } from "@/lib/i18n";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import { paginateTickets, type ExplorerSort, type ExplorerTicket, type SortField } from "@/lib/ticket-explorer";

/** Adapted from @reui/c-table-14 and @reui/c-pagination-15 for real Tickets. */
export function TicketTable({ items, sort, onSort, page, onPage, pageSize, onPageSize, onSelect, onMove, onRestore, busy, emptyText }: {
  items: ExplorerTicket[]; sort: ExplorerSort; onSort: (sort: ExplorerSort) => void;
  page: number; onPage: (page: number) => void; pageSize: number; onPageSize: (size: number) => void;
  onSelect: OpenTicket;
  onMove: (item: ExplorerTicket, status: TicketStatus) => void;
  onRestore: (id: Id<"tickets">) => void;
  busy?: ReadonlySet<string>;
  emptyText: string;
}) {
  const { t, formatDate } = useI18n(); const c = useExplorerCopy();
  const desktop = useMediaQuery("(min-width: 768px)");
  const result = paginateTickets(items, page, pageSize);
  const columns: { field: SortField; label: string; className?: string }[] = [
    { field: "ticketNumber", label: c.ticketNumber },
    { field: "title", label: c.title },
    { field: "tags", label: c.tags, className: "hidden xl:table-cell" },
    { field: "status", label: c.status },
    { field: "urgencyScore", label: c.urgency },
    { field: "createdAt", label: c.createdDate, className: "hidden lg:table-cell" },
    { field: "updatedAt", label: c.updatedDate, className: "hidden 2xl:table-cell" },
  ];
  const pager = "size-10 rounded-md md:size-8";
  const visiblePages = [...new Set([1, result.page - 1, result.page, result.page + 1, result.pages])].filter((n) => n > 0 && n <= result.pages).sort((a,b) => a-b);
  return <section className="min-w-0 space-y-3" aria-label={c.table}>
      <label className="flex min-w-0 items-center gap-2 text-sm font-medium md:max-w-xs 2xl:hidden">{c.sort}
        <select className="aurora-control min-h-11 min-w-0 flex-1 rounded-lg px-2 md:min-h-9" value={`${sort.field}:${sort.direction}`}
          onChange={event => {
            const [field, direction] = event.target.value.split(":") as [SortField, ExplorerSort["direction"]];
            onSort({ field, direction });
          }}>
          {columns.map(column => <optgroup key={column.field} label={column.label}>
            {(["asc", "desc"] as const).map(direction => <option key={direction} value={`${column.field}:${direction}`}>
              {column.label} · {direction === "asc" ? c.ascending : c.descending}
            </option>)}
          </optgroup>)}
        </select>
      </label>
    {desktop ? <div className="aurora-panel overflow-hidden rounded-xl">
      <Table aria-label={c.table}>
        <TableHeader className="aurora-toolbar"><TableRow className="hover:bg-transparent">{columns.map(({field,label,className}) => <TableHead key={field} scope="col" className={cn("h-9", className)} aria-sort={sort.field === field ? sort.direction === "asc" ? "ascending" : "descending" : undefined}>
          <Button size="sm" variant="ghost" className="-ml-2 h-8 text-xs font-medium text-muted-foreground" onClick={() => onSort({field,direction: sort.field === field && sort.direction === "asc" ? "desc" : "asc"})}>{label}{sort.field === field ? sort.direction === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden /> : <ArrowUpDown aria-hidden />}</Button>
        </TableHead>)}<TableHead scope="col" className="h-9 text-xs">{c.action}</TableHead></TableRow></TableHeader>
        <TableBody className="[&_td]:py-1">{result.rows.map((item) => <TableRow key={item._id} className="hover:bg-primary/5">
          <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatTicketNumber(item.ticketNumber, item.projectKey)}</TableCell>
          <TableCell><button type="button" data-ticket-id={item._id} className="min-h-9 min-w-28 max-w-xs break-words rounded text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(item._id)} aria-label={`${c.open} ${formatTicketNumber(item.ticketNumber, item.projectKey)}: ${item.title}`}>{item.title}</button>{item.archivedAt !== undefined && <Badge className="ml-2">{c.archived}</Badge>}
            {item.lifecycle === "archived" && <TicketPurgeEligibility archivedAt={item.archivedAt} blocked={"purgeBlocked" in item && item.purgeBlocked === true} />}</TableCell>
          <TableCell className="hidden xl:table-cell"><div className="min-w-24"><TicketTagList tags={item.tags ?? []} /></div></TableCell>
          <TableCell><Badge className={`${statusMeta(item.status).tone} whitespace-nowrap`}>{t(statusMeta(item.status).labelKey)}</Badge><TicketCustomerReply item={item} /></TableCell>
          <TableCell><TicketUrgency score={item.urgencyScore} /></TableCell>
          <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{formatDate(item.createdAt)}</TableCell>
          <TableCell className="hidden whitespace-nowrap text-muted-foreground 2xl:table-cell">{formatDate(item.updatedAt)}</TableCell>
          <TableCell><TicketRowAction item={item} busy={busy?.has(item._id)}
            onMove={(_id, status) => onMove(item, status)} onRestore={onRestore} /></TableCell>
        </TableRow>)}{!result.rows.length && <TableRow><TableCell colSpan={columns.length + 1} className="h-32 text-center text-muted-foreground">{emptyText}</TableCell></TableRow>}</TableBody>
      </Table>
    </div> : <div className="space-y-2">
      {result.rows.map(item => <TicketCard key={item._id} item={item} onSelect={onSelect} showUnscored
        onMove={(_id, status) => onMove(item, status)} onRestore={onRestore} busy={busy?.has(item._id)} />)}
      {!result.rows.length && <p className="aurora-panel rounded-xl p-4 text-sm text-muted-foreground">{emptyText}</p>}
    </div>}
    <nav aria-label={c.page} className="flex flex-wrap items-center justify-between gap-3">
      <p aria-live="polite" className="text-sm text-muted-foreground">{c.page} <span className="font-medium text-foreground">{result.page}</span> {c.of} {result.pages} · {items.length} {c.results}</p>
      <div className="aurora-control flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
        <Button variant="ghost" size="icon-sm" className={pager} disabled={result.page === 1} aria-label={c.first} onClick={() => onPage(1)}><ChevronsLeft /></Button>
        <Button variant="ghost" size="icon-sm" className={pager} disabled={result.page === 1} aria-label={c.previous} onClick={() => onPage(result.page - 1)}><ChevronLeft /></Button>
        {visiblePages.map((n,index) => <span key={n} className="hidden items-center gap-1 sm:flex">{index > 0 && n - visiblePages[index - 1] > 1 && <MoreHorizontal className="size-4" aria-hidden />}<Button size="icon-sm" className={cn(pager, n === result.page && "bg-primary/15 text-primary hover:bg-primary/15")} variant="ghost" aria-label={`${c.page} ${n}`} aria-current={n === result.page ? "page" : undefined} onClick={() => onPage(n)}>{n}</Button></span>)}
        <Button variant="ghost" size="icon-sm" className={pager} disabled={result.page === result.pages} aria-label={c.next} onClick={() => onPage(result.page + 1)}><ChevronRight /></Button>
        <Button variant="ghost" size="icon-sm" className={pager} disabled={result.page === result.pages} aria-label={c.last} onClick={() => onPage(result.pages)}><ChevronsRight /></Button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">{c.perPage}<select className="aurora-control min-h-11 rounded-lg px-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>{[10,25,50].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
    </nav>
  </section>;
}
