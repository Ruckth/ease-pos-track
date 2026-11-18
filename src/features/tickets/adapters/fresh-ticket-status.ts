import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

/** After an ambiguous write, a one-off HTTP read avoids returning a cached subscription value. */
export function useFreshTicketStatus(token: string) {
  const client = useConvex();
  return useCallback(async (projectId: Id<"projects">, id: Id<"tickets">) => {
    const { ConvexHttpClient } = await import("convex/browser");
    const reader = new ConvexHttpClient(client.url, {
      fetch: (input, options) => fetch(input, { ...options, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    });
    const result = await reader.query(api.tickets.getWorkspaceTicket, { token, projectId, ticket: id });
    return result?.status ?? null;
  }, [client, token]);
}
