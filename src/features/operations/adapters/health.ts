import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export function useHealth() { return useQuery(api.retention.health, {}); }
export function useJobDiagnostics(view: "failed" | "pending" | "expired") {
  return { ...usePaginatedQuery(api.retention.diagnostics, { view }, { initialNumItems: 25 }),
    requeue: useMutation(api.retention.requeueFailed) };
}
