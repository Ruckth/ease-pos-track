import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useConversation(id: Id<"tickets">, enabled: boolean) {
  const messages = usePaginatedQuery(api.conversations.page, enabled ? { id } : "skip", { initialNumItems: 10 });
  const send = useMutation(api.conversations.send);
  return { messages, send };
}

export type TicketMessage = ReturnType<typeof useConversation>["messages"]["results"][number];
