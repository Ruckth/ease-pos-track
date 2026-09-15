import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { statusMeta } from "@/components/feedback-status";
import { useI18n } from "@/lib/i18n";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { formatTicketNumber } from "@/lib/feedback-ui";
import { paginateTickets, type ExplorerSort, type ExplorerTag, type ExplorerTicket, type SortField } from "@/lib/ticket-explorer";

/** Adapted from @reui/c-table-14 and @reui/c-pagination-15 for real Tickets. */
export function TicketTable({ items, tags, sort, onSort, page, onPage, pageSize, onPageSize, onSelect }: {
  items: ExplorerTicket[]; tags: ExplorerTag[]; sort: ExplorerSort; onSort: (sort: ExplorerSort) => void;
  page: number; onPage: (page: number) => void; pageSize: number; onPageSize: (size: number) => void;
  onSelect: (id: Id<"feedback">) => void;
}) {
  const { t, formatDate } = useI18n(); const c = useExplorerCopy();
  const result = paginateTickets(items, page, pageSize);
  const columns: { field: SortField; label: string }[] = [{ field: "ticketNumber", label: c.ticketNumber }, { field: "title", label: c.title }, { field: "tags", label: c.tags }, { field: "status", label: c.status }, { field: "createdAt", label: c.createdDate }, { field: "updatedAt", label: c.updatedDate }];
  const visiblePages = [...new Set([1, result.page - 1, result.page, result.page + 1, result.pages])].filter((n) => n > 0 && n <= result.pages).sort((a,b) => a-b);
  return <section className="min-w-0 space-y-3" aria-label={c.table}>
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table aria-label={c.table}>
        <TableHeader><TableRow>{columns.map(({field,label}) => <TableHead key={field} aria-sort={sort.field === field ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
          <Button size="sm" variant="ghost" className="-ml-2" onClick={() => onSort({field,direction: sort.field === field && sort.direction === "asc" ? "desc" : "asc"})}>{label}{sort.field === field ? sort.direction === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden /> : <ArrowUpDown aria-hidden />}</Button>
        </TableHead>)}</TableRow></TableHeader>
        <TableBody>{result.rows.map((item) => <TableRow key={item._id}>
          <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatTicketNumber(item.ticketNumber)}</TableCell>
          <TableCell><button type="button" className="max-w-xs break-words rounded text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(item._id)} aria-label={`${c.open} ${formatTicketNumber(item.ticketNumber)}: ${item.title}`}>{item.title}</button>{item.deletedAt !== undefined && <Badge className="ml-2">{c.archived}</Badge>}</TableCell>
          <TableCell><div className="flex min-w-24 flex-wrap gap-1">{(item.tagIds ?? []).map((id) => { const tag = tags.find((tag) => tag._id === id); return tag ? <Badge key={id}>{tag.name}</Badge> : null; })}</div></TableCell>
          <TableCell><Badge className={`${statusMeta(item.status).tone} whitespace-nowrap`}>{t(statusMeta(item.status).labelKey)}</Badge></TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(item.createdAt)}</TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(item.updatedAt)}</TableCell>
        </TableRow>)}{!result.rows.length && <TableRow><TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">{c.noResults}</TableCell></TableRow>}</TableBody>
      </Table>
    </div>
    <nav aria-label={c.page} className="flex flex-wrap items-center justify-between gap-3">
      <p aria-live="polite" className="text-sm text-muted-foreground">{c.page} <span className="font-medium text-foreground">{result.page}</span> {c.of} {result.pages} · {items.length} {c.results}</p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" disabled={result.page === 1} aria-label={c.first} onClick={() => onPage(1)}><ChevronsLeft /></Button>
        <Button variant="outline" size="icon-sm" disabled={result.page === 1} aria-label={c.previous} onClick={() => onPage(result.page - 1)}><ChevronLeft /></Button>
        {visiblePages.map((n,index) => <span key={n} className="hidden items-center gap-1 sm:flex">{index > 0 && n - visiblePages[index - 1] > 1 && <MoreHorizontal className="size-4" aria-hidden />}<Button size="icon-sm" variant={n === result.page ? "default" : "ghost"} aria-label={`${c.page} ${n}`} aria-current={n === result.page ? "page" : undefined} onClick={() => onPage(n)}>{n}</Button></span>)}
        <Button variant="outline" size="icon-sm" disabled={result.page === result.pages} aria-label={c.next} onClick={() => onPage(result.page + 1)}><ChevronRight /></Button>
        <Button variant="outline" size="icon-sm" disabled={result.page === result.pages} aria-label={c.last} onClick={() => onPage(result.pages)}><ChevronsRight /></Button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">{c.perPage}<select className="h-9 rounded-md border border-input bg-background px-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>{[10,25,50].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
    </nav>
  </section>;
}
