import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useLineBots(projectId: Id<"projects">) {
  return useQuery(api.line.listBots, { projectId });
}
export type LineBot = NonNullable<ReturnType<typeof useLineBots>>[number];

export function useLineChats(botId: Id<"lineBots">) {
  return useQuery(api.line.listChats, { botId });
}
export type LineChat = NonNullable<ReturnType<typeof useLineChats>>[number];

export function useLineActions() {
  return {
    add: useAction(api.line.addBot),
    updateCredentials: useAction(api.line.updateCredentials),
    remove: useAction(api.line.removeChat),
    updateBot: useMutation(api.line.updateBot),
    updateChat: useMutation(api.line.updateChat),
    setChatState: useMutation(api.line.setChatState),
    setAssistantEnabled: useMutation(api.line.setAssistantEnabled),
  };
}

export function useLineAiSettings(projectId: Id<"projects">) {
  return useQuery(api.line_ai_settings.get, { projectId });
}

export function useLineAiSetupActions() {
  return {
    testAndSave: useAction(api.line_ai_settings.testAndSave),
    disable: useMutation(api.line_ai_settings.disable),
    setPaused: useMutation(api.line_ai_settings.setPaused),
  };
}

export function useLineAiReviews(projectId: Id<"projects">) {
  return usePaginatedQuery(api.line_ai_reviews.list, { projectId }, { initialNumItems: 25 });
}

export type LineAiDraft = Extract<ReturnType<typeof useLineAiReviews>["results"][number], { state: "review" }>;

export function useLineAiReplies(projectId: Id<"projects">) {
  return usePaginatedQuery(api.line_ai_reviews.listReplies, { projectId }, { initialNumItems: 20 });
}

export function useLineAiReviewActions() {
  return {
    approve: useMutation(api.line_ai_reviews.approve),
    dismiss: useMutation(api.line_ai_reviews.dismiss),
    retryReply: useMutation(api.line_ai_reviews.retryReply),
  };
}
