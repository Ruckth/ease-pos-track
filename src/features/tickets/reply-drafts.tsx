import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Id } from "@convex/_generated/dataModel";
import type { MessageEvidenceInput } from "../../../shared/ticket-evidence";
import type { TicketMessage } from "./adapters/conversation";
import { DisposableTicketDraft } from "./draft";

export type ReplyLink = { kind: "external"; url: string } | { kind: "page"; pageId: Id<"ticketPages"> };
export type QuotedTicketMessage = Pick<TicketMessage, "_id" | "body" | "link">;

type ReplySelection = {
  replyTo?: QuotedTicketMessage;
  evidence?: MessageEvidenceInput;
  link?: ReplyLink;
  requestReply: boolean;
  answerVersion?: number;
  submittedAnswerVersion?: number;
};

export class TicketReplyDraft {
  readonly owner: DisposableTicketDraft;
  private selection: ReplySelection = { requestReply: false };
  private listeners = new Set<() => void>();

  constructor(projectId: Id<"projects">) {
    this.owner = new DisposableTicketDraft(projectId);
  }

  getSelection = () => this.selection;

  canQuote = () => {
    const { retryLocked } = this.owner.getSnapshot();
    return !this.owner.isSubmitting() && !retryLocked;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update = (selection: Partial<ReplySelection>) => {
    this.selection = { ...this.selection, ...selection };
    this.listeners.forEach(listener => listener());
  };

  clear = () => this.update({ replyTo: undefined, evidence: undefined, link: undefined, requestReply: false, answerVersion: undefined, submittedAnswerVersion: undefined });
}

const ReplyDrafts = createContext<Map<Id<"tickets">, TicketReplyDraft> | null>(null);

/** Bound to the keyed authenticated workspace, so drafts survive navigation and leave on sign-out. */
export function TicketReplyDraftProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => new Map<Id<"tickets">, TicketReplyDraft>());
  const lifetime = useRef({ generation: 0 });
  useEffect(() => {
    const active = lifetime.current;
    const mounted = ++active.generation;
    return () => queueMicrotask(() => {
      if (mounted !== active.generation) return;
      for (const draft of drafts.values()) draft.owner.dispose();
      drafts.clear();
    });
  }, [drafts]);
  return <ReplyDrafts value={drafts}>{children}</ReplyDrafts>;
}

export function useTicketReplyDraft(id: Id<"tickets">, projectId: Id<"projects">) {
  const drafts = useContext(ReplyDrafts);
  if (!drafts) throw new Error("TicketReplyDraftProvider is required");
  const [draft] = useState(() => {
    const existing = drafts.get(id);
    if (existing) return existing;
    const created = new TicketReplyDraft(projectId);
    drafts.set(id, created);
    return created;
  });
  return draft;
}
