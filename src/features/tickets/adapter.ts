import { useStaffLanes } from "./lane-adapter";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketTag } from "@/lib/types";
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

/** Staff tag catalogue (one bounded read) and tag writes. */
export function useTicketTagCatalogue(token: string) {
  return useQuery(api.tickets.listTicketTags, { token });
}

export function useTagAdapter(token: string) {
  const create = useMutation(api.tickets.createTicketTag);
  const assign = useMutation(api.tickets.setTicketTags);
  return {
    create: (name: string, color: TicketTag["color"]) => create({ token, name, color }),
    assign: (item: { _id: Id<"tickets">; version: number }, tagIds: TicketTag["_id"][]) =>
      assign({ token, id: item._id, expectedVersion: item.version, tagIds }),
  };
}

export function useDraftAdapter() {
  return {
    createTicket: useMutation(api.tickets.createTicket),
    createUploadIntent: useMutation(api.uploads.createUploadIntent),
  };
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

export function useStaffTickets(token: string, projectId: Id<"projects"> | undefined, showArchived: boolean, query: string) {
  const invalidSearch = !isTicketSearchWithinLimits(query);
  const lanes = useStaffLanes(token, projectId, !query);
  const totals = useQuery(api.tickets.laneTotals, projectId ? { token, projectId } : "skip");
  const matches = useQuery(api.tickets.searchTickets, projectId && query && !invalidSearch ? {
    token, projectId, lifecycle: "active", search: query,
  } : "skip");
  const archive = usePaginatedQuery(api.tickets.pageTickets, projectId && showArchived && !query ? {
    token, projectId, lifecycle: "archived",
  } : "skip", { initialNumItems: 20 });
  const archiveMatches = useQuery(api.tickets.searchTickets, projectId && showArchived && query && !invalidSearch ? {
    token, projectId, lifecycle: "archived", search: query,
  } : "skip");
  return { ...lanes, invalidSearch, totals, matches, archive, archiveMatches, archivedItems: query ? archiveMatches?.matches ?? [] : archive.results };
}
