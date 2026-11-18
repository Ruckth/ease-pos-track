import { usePaginatedQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketStatus } from "@/lib/types";

function useLane(token: string, projectId: Id<"projects"> | undefined, status: TicketStatus, enabled: boolean) {
  return usePaginatedQuery(api.tickets.pageTickets, projectId && enabled ? {
    token, projectId, lifecycle: "active", status,
  } : "skip", { initialNumItems: 20 });
}

/** Hooks stay in a fixed order. Only the lanes included in the current view subscribe. */
export function useStaffLanes(token: string, projectId: Id<"projects"> | undefined, enabled: readonly TicketStatus[]) {
  return {
    new: useLane(token, projectId, "new", enabled.includes("new")),
    acknowledged: useLane(token, projectId, "acknowledged", enabled.includes("acknowledged")),
    in_progress: useLane(token, projectId, "in_progress", enabled.includes("in_progress")),
    waiting: useLane(token, projectId, "waiting", enabled.includes("waiting")),
    done: useLane(token, projectId, "done", enabled.includes("done")),
  };
}
