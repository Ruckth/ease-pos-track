import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAccessToken } from "@/app/adapter";

/** After an ambiguous write, a one-off HTTP read avoids returning a cached subscription value. */
export function useFreshTicketStatus() {
  const client = useConvex();
  // The one-off client carries the live session's access token as its auth header.
  const accessToken = useAccessToken();
  return useCallback(async (projectId: Id<"projects">, id: Id<"tickets">) => {
    const { ConvexHttpClient } = await import("convex/browser");
    const reader = new ConvexHttpClient(client.url, {
      fetch: (input, options) => fetch(input, { ...options, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    });
    if (accessToken) reader.setAuth(accessToken);
    const result = await reader.query(api.tickets.getWorkspaceTicket, { projectId, ticket: id });
    return result?.status ?? null;
  }, [client, accessToken]);
}
