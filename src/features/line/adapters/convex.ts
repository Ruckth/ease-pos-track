import { useAction, useMutation, useQuery } from "convex/react";
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
  };
}
