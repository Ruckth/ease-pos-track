import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useRoutingVocabulary(projectId: Id<"projects">) {
  return useQuery(api.ticket_routing.getVocabulary, { projectId });
}
export function useRoutingSettings(projectId?: Id<"projects">) {
  return useQuery(api.ticket_routing.getSettings, projectId ? { projectId } : "skip");
}
export type RoutingSettings = NonNullable<ReturnType<typeof useRoutingSettings>>;

export function useRoutingAssignment(ticketId: Id<"tickets">) {
  return useQuery(api.ticket_routing.getAssignment, { ticketId });
}
export function useRoutingSuggestionQueue(projectId: Id<"projects">, policyGeneration: number) {
  return usePaginatedQuery(api.ticket_routing.listSuggestions, { projectId, policyGeneration }, { initialNumItems: 12 });
}
export function useRoutingActions() {
  return {
    assign: useMutation(api.ticket_routing.assign),
    classify: useMutation(api.ticket_routing.classify),
    checkRule: useMutation(api.ticket_routing.checkRule),
    review: useMutation(api.ticket_routing.reviewSuggestion),
    saveConfiguration: useMutation(api.ticket_routing.saveConfiguration),
    setAvailability: useMutation(api.ticket_routing.setAvailability),
  };
}
