import type { FilterNode, FilterQuery, FilterRule } from "@/components/reui/filters/filters-types";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import type { TicketTag } from "./types";

export type ExplorerTicket = import("../../shared/ticket-contracts").TicketSummary & { description?: string };
export type ExplorerTag = TicketTag;
export type SortField = "ticketNumber" | "title" | "tags" | "status" | "createdAt" | "updatedAt" | "urgencyScore";
export type ExplorerSort = { field: SortField; direction: "asc" | "desc" };

/** Calendar arithmetic, rather than 24 hours, keeps inclusive dates correct across DST. */
export function dateBoundary(value: unknown, after = false): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (after) date.setDate(date.getDate() + 1);
  return date.getTime();
}

type TicketPredicate = (ticket: ExplorerTicket) => boolean;

function rulePredicate(rule: FilterRule): TicketPredicate | undefined {
  const field = rule.path[0];
  if (field === "urgencyScore" && rule.operator === "unset") return ticket => ticket.urgencyScore === undefined;
  if (!Array.isArray(rule.value)) return;
  const values = rule.value;
  if ((field === "tags" || field === "status") && rule.operator === "in") {
    const selected = values.filter(value => typeof value === "string" && value.length > 0);
    if (selected.length === 0) return;
    return field === "status" ? ticket => selected.includes(ticket.status)
      : ticket => ticket.tagIds?.some(id => selected.includes(id)) ?? false;
  }
  if (rule.operator !== "between" || values.length !== 2) return;
  if (field === "urgencyScore") {
    const [from, to] = values;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 100 || from > to) return;
    return ticket => ticket.urgencyScore !== undefined && ticket.urgencyScore >= from && ticket.urgencyScore <= to;
  }
  if (field === "createdAt" || field === "updatedAt") {
    const start = dateBoundary(values[0]);
    const end = dateBoundary(values[1], true);
    if (start === null || end === null || end <= start) return;
    return ticket => ticket[field] >= start && ticket[field] < end;
  }
}

/** Compile only committed conditions. A draft inside an OR group must not admit every Ticket. */
function compileFilters(node: FilterNode): { count: number; matches: TicketPredicate } {
  if (node.type === "rule") {
    const predicate = rulePredicate(node);
    if (!predicate) return { count: 0, matches: () => true };
    return { count: 1, matches: node.negated ? ticket => !predicate(ticket) : predicate };
  }
  const children = node.rules.map(compileFilters).filter(child => child.count > 0);
  const count = children.reduce((total, child) => total + child.count, 0);
  const matches: TicketPredicate = count === 0 ? () => true : node.combinator === "and"
    ? ticket => children.every(child => child.matches(ticket))
    : ticket => children.some(child => child.matches(ticket));
  return { count, matches };
}

export function countCommittedRules(node: FilterNode): number {
  return compileFilters(node).count;
}

export function filterTickets<T extends ExplorerTicket>(items: T[], search: string, query: FilterQuery): T[] {
  const text = search.trim().toLocaleLowerCase();
  const filters = compileFilters(query);
  if (!text && !filters.count) return items;
  return items.filter(item => (!text || `${formatTicketNumber(item.ticketNumber, item.projectKey)} ${item.title} ${item.description ?? item.excerpt ?? ""}`.toLocaleLowerCase().includes(text)) && filters.matches(item));
}

export function sortTickets<T extends ExplorerTicket>(items: T[], sort: ExplorerSort, tags: ExplorerTag[], language: string): T[] {
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  // A tag name list is a sort key. Build it once per Ticket, outside the comparator.
  let tagsByTicket: Map<string, string> | undefined;
  if (sort.field === "tags") {
    const tagNames = new Map(tags.map(tag => [tag._id, tag.name]));
    tagsByTicket = new Map(items.map(item => [
      item._id,
      (item.tagIds ?? []).map(id => tagNames.get(id) ?? "").sort(collator.compare).join(", "),
    ]));
  }
  const value = (item: T) => sort.field === "tags" ? tagsByTicket?.get(item._id) ?? "" : item[sort.field] ?? 0;
  return [...items].sort((a, b) => {
    if (sort.field === "urgencyScore" && (a.urgencyScore === undefined || b.urgencyScore === undefined)) {
      if (a.urgencyScore !== b.urgencyScore) return a.urgencyScore === undefined ? 1 : -1;
    }
    const av = value(a); const bv = value(b);
    const order = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv));
    return (sort.direction === "asc" ? order : -order) || String(a._id).localeCompare(String(b._id));
  });
}

export function paginateTickets<T>(items: T[], page: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return { page: current, pages, rows: items.slice((current - 1) * pageSize, current * pageSize) };
}
