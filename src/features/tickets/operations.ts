import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { AnnotationDraftInput, AnnotationUpdateInput } from "@/lib/types";
import type { TicketStatus } from "@/lib/types";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { errorCode } from "../../../shared/errors";

type Functions = {
  edit: typeof api.tickets.editTicket; undoEdit: typeof api.tickets.undoTicketEdit;
  status: typeof api.tickets.updateTicketStatus; undoStatus: typeof api.tickets.undoTicketStatus;
  urgency: typeof api.tickets.updateUrgencyScore; undoUrgency: typeof api.tickets.undoUrgencyScore;
  archive: typeof api.tickets.archiveTicket; restore: typeof api.tickets.restoreTicket;
  addAnnotation: typeof api.annotations.addAnnotation; updateAnnotation: typeof api.annotations.updateAnnotation;
  undoAnnotation: typeof api.annotations.undoAnnotationUpdate; removeAnnotation: typeof api.annotations.removeAnnotation;
  restoreAnnotation: typeof api.annotations.restoreAnnotation;
};
export type TicketAdapter = { [K in keyof Functions]: (args: FunctionArgs<Functions[K]>) => Promise<FunctionReturnType<Functions[K]>> };
type TicketTarget = { _id: Id<"tickets">; version: number; ticketNumber: number; projectKey: string };
type OperationMessage = "ticketUpdated" | "statusUpdated" | "urgencySaved" | "ticketArchived" | "ticketDeleted" | "ticketRestored" | "commentUpdated" | "commentDeleted" | "commentRestored";
export class TicketOperationFailure extends Error {
  readonly data: { code: string };
  readonly disposition: "conflict" | "rejected" | "unknown";
  constructor(error: unknown) {
    const code = errorCode(error);
    super(code ?? "UNKNOWN_OUTCOME");
    this.data = { code: code ?? "UNKNOWN_OUTCOME" };
    this.disposition = code === "VERSION_CONFLICT" ? "conflict" : code ? "rejected" : "unknown";
  }
}

/** Captures the version of the user's intent. Conflicts are never silently retried. */
export function ticketOperations(adapter: TicketAdapter, notices: {
  success: (message: OperationMessage, reference: string, undo?: () => Promise<unknown>) => void;
}) {
  async function run<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); } catch (error) { throw new TicketOperationFailure(error); }
  }
  const target = (item: TicketTarget) => ({ id: item._id, expectedVersion: item.version });
  const reference = (item: TicketTarget) => formatTicketNumber(item.ticketNumber, item.projectKey);
  async function announce<T extends { version: number; eventId?: string | null }>(item: TicketTarget, call: () => Promise<T>, message: OperationMessage, undo: (result: T) => Promise<unknown>) {
    const result = await run(call);
    if (result.eventId) notices.success(message, reference(item), () => run(() => undo(result)));
    return result;
  }
  return {
    edit: (item: TicketTarget, title: string, description: string) => announce(item, () => adapter.edit({ ...target(item), title, description }), "ticketUpdated", result => adapter.undoEdit({ eventId: result.eventId!, expectedVersion: result.version })),
    status: (item: TicketTarget, status: TicketStatus) => announce(item, () => adapter.status({ ...target(item), status }), "statusUpdated", result => adapter.undoStatus({ eventId: result.eventId!, expectedVersion: result.version })),
    urgency: (item: TicketTarget, urgencyScore: number | undefined) => announce(item, () => adapter.urgency({ ...target(item), urgencyScore }), "urgencySaved", result => adapter.undoUrgency({ eventId: result.eventId!, expectedVersion: result.version })),
    async archive(item: TicketTarget, customer = false) {
      const result = await run(() => adapter.archive(target(item)));
      notices.success(customer ? "ticketDeleted" : "ticketArchived", reference(item), customer ? undefined : () => run(() => adapter.restore({ id: item._id, expectedVersion: result.version })));
      return result;
    },
    async restore(item: TicketTarget) {
      const result = await run(() => adapter.restore(target(item)));
      notices.success("ticketRestored", reference(item));
      return result;
    },
    addAnnotation: (item: TicketTarget, input: AnnotationDraftInput) => run(() => adapter.addAnnotation({ ...target(item), ...input })),
    updateAnnotation: (item: TicketTarget, input: AnnotationUpdateInput) => announce(item, () => adapter.updateAnnotation({ ...target(item), ...input }), "commentUpdated", result => adapter.undoAnnotation({ eventId: result.eventId!, expectedVersion: result.version })),
    async removeAnnotation(item: TicketTarget, annotationId: string) {
      const result = await run(() => adapter.removeAnnotation({ ...target(item), annotationId }));
      notices.success("commentDeleted", reference(item), () => run(() => adapter.restoreAnnotation({ id: item._id, annotationId, expectedVersion: result.version })));
    },
    async restoreAnnotation(item: TicketTarget, annotationId: string) {
      await run(() => adapter.restoreAnnotation({ ...target(item), annotationId }));
      notices.success("commentRestored", reference(item));
    },
  };
}
