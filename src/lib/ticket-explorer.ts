import type { FilterNode, FilterQuery, FilterRule } from "@/components/reui/filters/filters-types";
import { formatTicketNumber } from "./feedback-ui";
import type { Feedback } from "./types";

export type ExplorerTicket = Feedback & { tagIds?: string[] };
export type ExplorerTag = { _id: string; name: string; color: string };
export type SortField = "ticketNumber" | "title" | "tags" | "status" | "createdAt" | "updatedAt";
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

function matchRule(item: ExplorerTicket, rule: FilterRule): boolean {
  const field = rule.path[0];
  let match = true;
  const values = Array.isArray(rule.value) ? rule.value : [];
  if (field === "tags" || field === "status") {
    const actual = field === "tags" ? item.tagIds ?? [] : [item.status];
    match = values.length === 0 || values.some((value) => actual.includes(value));
  } else if (field === "createdAt" || field === "updatedAt") {
    const from = dateBoundary(values[0]);
    const until = dateBoundary(values[1], true);
    // An incomplete editor draft never narrows the list.
    if (from !== null && until !== null) match = item[field] >= from && item[field] < until;
  }
  return rule.negated ? !match : match;
}

function matches(item: ExplorerTicket, node: FilterNode): boolean {
  if (node.type === "rule") return matchRule(item, node);
  if (!node.rules.length) return true;
  return node.combinator === "and" ? node.rules.every((rule) => matches(item, rule)) : node.rules.some((rule) => matches(item, rule));
}

export function filterTickets<T extends ExplorerTicket>(items: T[], search: string, query: FilterQuery): T[] {
  const text = search.trim().toLocaleLowerCase();
  return items.filter((item) => (!text || `${formatTicketNumber(item.ticketNumber)} ${item.title} ${item.description}`.toLocaleLowerCase().includes(text)) && matches(item, query));
}

export function sortTickets<T extends ExplorerTicket>(items: T[], sort: ExplorerSort, tags: ExplorerTag[], language: string): T[] {
  const tagNames = new Map(tags.map((tag) => [tag._id, tag.name]));
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  const value = (item: T) => sort.field === "tags"
    ? (item.tagIds ?? []).map((id) => tagNames.get(id) ?? "").sort(collator.compare).join(", ")
    : item[sort.field] ?? 0;
  return [...items].sort((a, b) => {
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
