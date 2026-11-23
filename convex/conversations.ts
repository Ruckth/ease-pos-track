import { actorMutation, actorQuery } from "./functions";
import * as conversation from "./domain/conversation";

export const page = actorQuery({ name: "conversations:page", ...conversation.pageMessages });
export const send = actorMutation({ name: "conversations:send", ...conversation.sendMessage });
