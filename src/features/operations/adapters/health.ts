import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export function useHealth(token: string) { return useQuery(api.retention.health, { token }); }
export function useJobDiagnostics(token: string, view: "failed" | "pending" | "expired") {
  return { ...usePaginatedQuery(api.retention.diagnostics, { token, view }, { initialNumItems: 25 }),
    requeue: useMutation(api.retention.requeueFailed) };
}
