import { useMemo } from "react";
import { mergeQueueLanes } from "@/lib/staff-ticket-queue";
import { BOARD_COLUMNS } from "@/lib/kanban-board";
import { useStaffLanes } from "./lane-adapter";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { isTicketSearchWithinLimits } from "../../../shared/ticket-contracts";

/** Browser mutation transport. Operations and rendering never construct clients. */
export function useTicketAdapter() {
  return {
    edit: useMutation(api.tickets.editTicket),
    undoEdit: useMutation(api.tickets.undoTicketEdit),
    status: useMutation(api.tickets.updateTicketStatus),
    undoStatus: useMutation(api.tickets.undoTicketStatus),
    urgency: useMutation(api.tickets.updateUrgencyScore),
    undoUrgency: useMutation(api.tickets.undoUrgencyScore),
    archive: useMutation(api.tickets.archiveTicket),
    restore: useMutation(api.tickets.restoreTicket),
    addAnnotation: useMutation(api.annotations.addAnnotation),
    updateAnnotation: useMutation(api.annotations.updateAnnotation),
    undoAnnotation: useMutation(api.annotations.undoAnnotationUpdate),
    removeAnnotation: useMutation(api.annotations.removeAnnotation),
    restoreAnnotation: useMutation(api.annotations.restoreAnnotation),
  };
}

export function useDraftAdapter() {
  return {
    createTicket: useMutation(api.tickets.createTicket),
    createUploadIntent: useMutation(api.uploads.createUploadIntent),
  };
}

export function useWorkspaceTicket(token: string, ticket: string | null, projectId: Id<"projects"> | undefined) {
  return useQuery(api.tickets.getWorkspaceTicket, ticket && projectId ? { token, ticket, projectId } : "skip");
}

export function useSelectedTicket(token: string, id: Id<"tickets"> | null) {
  return useQuery(api.tickets.getTicket, id ? { token, id } : "skip");
}

export function useTicketActivity(token: string, id: Id<"tickets"> | null) {
  const args = id ? { token, id } : "skip";
  return {
    activity: useQuery(api.annotations.listAnnotationActivity, args),
    ticketActivity: useQuery(api.tickets.listTicketActivity, args),
  };
}

export function useCustomerTickets(token: string, projectId: Id<"projects"> | undefined) {
  return usePaginatedQuery(api.tickets.pageTickets, projectId ? { token, projectId, lifecycle: "active" } : "skip", { initialNumItems: 20 });
}


export function useStaffTickets(token: string, projectId: Id<"projects"> | undefined, view: string, filter: string, query: string) {
  const invalidSearch = !isTicketSearchWithinLimits(query);
  const archived = filter === "archive";
  const status = BOARD_COLUMNS.find(value => value === filter);
  const lifecycle = archived ? "archived" as const : "active" as const;
  // Active work spans four workflow states. Separate indexed lanes avoid
  // scanning page after page of resolved Tickets to find actionable work.
  const useLanes = !query && !archived && (view === "board" || filter === "active");
  const enabledLanes = useMemo(() => useLanes ? BOARD_COLUMNS.filter(lane =>
    status ? lane === status : filter !== "active" || lane !== "done"
  ) : [], [useLanes, status, filter]);
  const lanes = useStaffLanes(token, projectId, enabledLanes);
  const page = usePaginatedQuery(api.tickets.pageTickets, projectId && !query && !useLanes ? {
    token, projectId, lifecycle, status,
  } : "skip", { initialNumItems: 20 });
  const totals = useQuery(api.tickets.laneTotals, projectId && view === "board" && !query && !archived ? { token, projectId } : "skip");
  const matches = useQuery(api.tickets.searchTickets, projectId && query && !invalidSearch ? {
    token, projectId, lifecycle, search: query, status, activeOnly: filter === "active" || undefined,
  } : "skip");
  const pages = useLanes ? enabledLanes.map(lane => lanes[lane]) : query ? [] : [page];
  const rows = query ? matches?.matches ?? [] : useLanes
    ? mergeQueueLanes(pages.flatMap(page => page.results))
    : page.results;
  return {
    lanes, enabledLanes, totals, invalidSearch, items: rows,
    loading: query ? matches === undefined : pages.some(page => page.status === "LoadingFirstPage"),
    hasMore: pages.some(page => page.status === "CanLoadMore" || page.status === "LoadingMore"),
    loadingMore: pages.some(page => page.status === "LoadingMore"),
    loadMore: () => pages.forEach(page => { if (page.status === "CanLoadMore") page.loadMore(20); }),
    searchHasMore: matches?.hasMore,
  };
}

export function useTicketTags(token: string, enabled = true) {
  return useQuery(api.tickets.listTicketTags, enabled ? { token } : "skip");
}

export function useTagAdapter() {
  return { create: useMutation(api.tickets.createTicketTag), assign: useMutation(api.tickets.setTicketTags) };
}
