import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useConversation(id: Id<"tickets">, enabled: boolean) {
  const messages = usePaginatedQuery(api.conversations.page, enabled ? { id } : "skip", { initialNumItems: 10 });
  const send = useMutation(api.conversations.send);
  return { messages, send };
}

export function useOpenReplyRequest(id: Id<"tickets">, enabled: boolean) {
  return useQuery(api.conversations.openRequest, enabled ? { id } : "skip");
}

export type TicketMessage = ReturnType<typeof useConversation>["messages"]["results"][number];
