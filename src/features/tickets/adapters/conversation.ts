import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useConversation(token: string, id: Id<"tickets">) {
  const messages = usePaginatedQuery(api.conversations.page, { token, id }, { initialNumItems: 10 });
  const send = useMutation(api.conversations.send);
  return { messages, send };
}
