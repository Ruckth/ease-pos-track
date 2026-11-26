import type { TicketAssignmentFilter } from "../../../shared/ticket-routing";
import { useMemo } from "react";
import { mergeQueueLanes } from "@/lib/staff-ticket-queue";
import { BOARD_COLUMNS } from "@/lib/kanban-board";
import { useStaffLanes } from "./lane-adapter";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { customerSearchScope, type CustomerQueueFilter } from "./customer-queue";
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

export function useTicketCapabilities() {
  return useQuery(api.pilot_release.ticketCapabilities, {});
}

export function useDraftAdapter() {
  return {
    createTicket: useMutation(api.tickets.createTicket),
    createUploadIntent: useMutation(api.uploads.createUploadIntent),
  };
}

export function useWorkspaceTicket(ticket: string | null, projectId: Id<"projects"> | undefined) {
  return useQuery(api.tickets.getWorkspaceTicket, ticket && projectId ? { ticket, projectId } : "skip");
}

export function useSelectedTicket(id: Id<"tickets"> | null) {
  return useQuery(api.tickets.getTicket, id ? { id } : "skip");
}

export function useTicketActivity(id: Id<"tickets"> | null) {
  const args = id ? { id } : "skip";
  const mediaEnabled = useTicketCapabilities()?.mediaEnabled === true;
  return {
    activity: useQuery(api.annotations.listAnnotationActivity, mediaEnabled ? args : "skip") ?? (mediaEnabled ? undefined : []),
    ticketActivity: useQuery(api.tickets.listTicketActivity, args),
  };
}

export function useCustomerTickets(projectId: Id<"projects"> | undefined) {
  return usePaginatedQuery(api.tickets.pageTickets, projectId ? { projectId, lifecycle: "active" } : "skip", { initialNumItems: 20 });
}

export function useCustomerTicketSearch(projectId: Id<"projects"> | undefined, query: string, filter: CustomerQueueFilter) {
  return useQuery(api.tickets.searchTickets, projectId && query ? {
    projectId, lifecycle: "active", search: query, ...customerSearchScope(filter),
  } : "skip");
}

export function useStaffTickets(projectId: Id<"projects"> | undefined, view: string, filter: string, query: string, assignmentFilter?: TicketAssignmentFilter) {
  const invalidSearch = !isTicketSearchWithinLimits(query);
  const archived = filter === "archive";
  const status = BOARD_COLUMNS.find(value => value === filter);
  const lifecycle = archived ? "archived" as const : "active" as const;
  // Active work spans four workflow states. Separate indexed lanes avoid
  // scanning page after page of resolved Tickets to find actionable work.
  const useLanes = !query && !archived && (view === "board" || filter === "active");
  const visibleStatuses = useMemo(() => BOARD_COLUMNS.filter(lane =>
    status ? lane === status : filter !== "active" || lane !== "done"
  ), [status, filter]);
  const enabledLanes = useLanes ? visibleStatuses : [];
  const lanes = useStaffLanes(projectId, enabledLanes, assignmentFilter);
  const page = usePaginatedQuery(api.tickets.pageTickets, projectId && !query && !useLanes ? {
    projectId, lifecycle, status, assignmentFilter,
  } : "skip", { initialNumItems: 20 });
  const totals = useQuery(api.tickets.laneTotals, projectId && view === "board" && !query && !archived && !assignmentFilter ? { projectId } : "skip");
  const matches = useQuery(api.tickets.searchTickets, projectId && query && !invalidSearch ? {
    projectId, lifecycle, search: query, status, assignmentFilter, activeOnly: filter === "active" || undefined,
  } : "skip");
  const pages = useLanes ? enabledLanes.map(lane => lanes[lane]) : query ? [] : [page];
  const { new: { results: newRows }, acknowledged: { results: acknowledged },
    in_progress: { results: inProgress }, waiting: { results: waiting }, done: { results: done } } = lanes;
  // Pagination returns fresh wrappers even when their results are identical.
  // Keep the merged array stable so opening detail does not re-sort the list.
  const laneRows = useMemo(() => {
    const rows = { new: newRows, acknowledged, in_progress: inProgress, waiting, done };
    return useLanes ? mergeQueueLanes(visibleStatuses.flatMap(lane => rows[lane])) : [];
  }, [useLanes, visibleStatuses, newRows, acknowledged, inProgress, waiting, done]);
  const rows = query ? matches?.matches ?? laneRows : useLanes ? laneRows : page.results;
  return {
    lanes, enabledLanes, visibleStatuses, totals, invalidSearch, items: rows,
    loading: query ? matches === undefined : pages.some(page => page.status === "LoadingFirstPage"),
    hasMore: pages.some(page => page.status === "CanLoadMore" || page.status === "LoadingMore"),
    loadingMore: pages.some(page => page.status === "LoadingMore"),
    loadMore: () => pages.forEach(page => { if (page.status === "CanLoadMore") page.loadMore(20); }),
    searchHasMore: matches?.hasMore,
  };
}

export function useTicketTags(enabled = true) {
  return useQuery(api.tickets.listTicketTags, enabled ? {} : "skip");
}

export function useTagAdapter() {
  return { create: useMutation(api.tickets.createTicketTag), assign: useMutation(api.tickets.setTicketTags) };
}
