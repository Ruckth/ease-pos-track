import { usePaginatedQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { BOARD_COLUMNS } from "./kanban-board";

export function useStaffLanes(token: string, projectId: Id<"projects"> | undefined, enabled: boolean) {
  const args = projectId && enabled ? { token, projectId, lifecycle: "active" as const } : null;
  const options = { initialNumItems: 20 };
  const lanes = {
    new: usePaginatedQuery(api.tickets.pageTickets, args ? { ...args, status: "new" } : "skip", options),
    acknowledged: usePaginatedQuery(api.tickets.pageTickets, args ? { ...args, status: "acknowledged" } : "skip", options),
    in_progress: usePaginatedQuery(api.tickets.pageTickets, args ? { ...args, status: "in_progress" } : "skip", options),
    waiting: usePaginatedQuery(api.tickets.pageTickets, args ? { ...args, status: "waiting" } : "skip", options),
    done: usePaginatedQuery(api.tickets.pageTickets, args ? { ...args, status: "done" } : "skip", options),
  };
  return { lanes, items: BOARD_COLUMNS.flatMap(status => lanes[status].results), loading: BOARD_COLUMNS.some(status => lanes[status].status === "LoadingFirstPage") };
}
