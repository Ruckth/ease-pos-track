import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useCustomerInbox(projectId: Id<"projects">) {
  const args = { projectId };
  return {
    items: usePaginatedQuery(api.inbox.page, args, { initialNumItems: 20 }),
    enabled: useQuery(api.inbox.preference, args),
    setPreference: useMutation(api.inbox.setPreference),
    markRead: useMutation(api.inbox.markRead),
  };
}

export function useStaffInbox(projectId: Id<"projects">) {
  const args = { projectId };
  return {
    items: usePaginatedQuery(api.staff_inbox.page, args, { initialNumItems: 20 }),
    settings: useQuery(api.staff_inbox.settings, args),
    setPreference: useMutation(api.staff_inbox.setPreference),
    markRead: useMutation(api.staff_inbox.markRead),
  };
}
