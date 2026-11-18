import type { Id } from "@convex/_generated/dataModel";
import type { TicketStatus } from "@/lib/types";
import { errorCode } from "../../../shared/errors";
import { TicketOperationFailure } from "./operations";

type TicketId = Id<"tickets">;
export type MoveSource = {
  _id: TicketId;
  projectId: Id<"projects">;
  ticketNumber: number;
  projectKey: string;
  version: number;
};
type PendingMove = { item: MoveSource; phase: "moving" | "checking" | "retry" };

type Dependencies = {
  write: (item: MoveSource, status: TicketStatus) => Promise<{ version: number }>;
  read: (project: Id<"projects">, id: TicketId) => Promise<TicketStatus | null>;
  onRead: (item: MoveSource, current: TicketStatus | null) => void;
  onRejected: (item: MoveSource, error: unknown) => void;
};

/** One in-flight intent per Ticket. Recovery reads the current status and never repeats the write. */
export class TicketStatusMoves {
  private entries = new Map<TicketId, PendingMove>();
  private listeners = new Set<() => void>();

  snapshot = () => this.entries;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private set(item: MoveSource, phase?: PendingMove["phase"]) {
    const next = new Map(this.entries);
    if (phase) next.set(item._id, { item, phase });
    else next.delete(item._id);
    this.entries = next;
    this.listeners.forEach(fn => fn());
  }

  async move(item: MoveSource, status: TicketStatus, deps: Dependencies) {
    if (this.entries.has(item._id)) return null;
    this.set(item, "moving");
    try {
      const result = await deps.write(item, status);
      this.set(item);
      return result.version;
    } catch (error) {
      if (error instanceof TicketOperationFailure && error.disposition === "rejected") {
        this.set(item);
        deps.onRejected(item, error);
      } else {
        await this.check(item, deps);
      }
      return null;
    }
  }

  retry(id: TicketId, deps: Omit<Dependencies, "write">) {
    const entry = this.entries.get(id);
    if (entry?.phase === "retry") return this.check(entry.item, deps);
  }

  private async check(item: MoveSource, deps: Omit<Dependencies, "write">) {
    this.set(item, "checking");
    let current: TicketStatus | null;
    try {
      current = await deps.read(item.projectId, item._id);
    } catch (error) {
      if (errorCode(error)) {
        this.set(item);
        deps.onRejected(item, error);
        return;
      }
      this.set(item, "retry");
      return;
    }
    this.set(item);
    deps.onRead(item, current);
  }
}
