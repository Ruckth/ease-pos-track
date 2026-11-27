import type { TicketAssignmentFilter } from "../../../shared/ticket-routing";
import { usePaginatedQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketStatus } from "@/lib/types";

function useLane(projectId: Id<"projects"> | undefined, status: TicketStatus, enabled: boolean, assignmentFilter?: TicketAssignmentFilter) {
  return usePaginatedQuery(api.tickets.pageTickets, projectId && enabled ? {
    projectId, lifecycle: "active", status, assignmentFilter,
  } : "skip", { initialNumItems: 20 });
}

/** Hooks stay in a fixed order. Only the lanes included in the current view subscribe. */
export function useStaffLanes(projectId: Id<"projects"> | undefined, enabled: readonly TicketStatus[], assignmentFilter?: TicketAssignmentFilter) {
  return {
    new: useLane(projectId, "new", enabled.includes("new"), assignmentFilter),
    acknowledged: useLane(projectId, "acknowledged", enabled.includes("acknowledged"), assignmentFilter),
    in_progress: useLane(projectId, "in_progress", enabled.includes("in_progress"), assignmentFilter),
    waiting: useLane(projectId, "waiting", enabled.includes("waiting"), assignmentFilter),
    done: useLane(projectId, "done", enabled.includes("done"), assignmentFilter),
  };
}
