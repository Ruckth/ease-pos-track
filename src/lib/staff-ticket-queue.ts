import type { TicketStatus } from "@/lib/types";

export const staffTicketActions = {
  new: { status: "acknowledged", label: "queueAcknowledge" },
  acknowledged: { status: "in_progress", label: "queueStart" },
  in_progress: { status: "done", label: "queueResolve" },
  waiting: { status: "in_progress", label: "queueResume" },
  done: { status: "in_progress", label: "queueReopen" },
} as const satisfies Record<TicketStatus, { status: TicketStatus; label: string }>;

/** A workflow move can arrive in separate paginated lane subscriptions.
 * Use the latest version while the source and destination pages overlap. */
export function mergeQueueLanes<T extends { _id: string; version: number }>(rows: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const existing = newest.get(row._id);
    if (!existing || row.version > existing.version) newest.set(row._id, row);
  }
  return [...newest.values()];
}

type QueueEntry = { _id: string; urgencyScore?: number; updatedAt: number };

/** Existing rows keep their positions while staff works. On refresh, or when a
 * bounded page introduces new rows, urgency orders the newly ranked group. */
export function stableQueue<T extends QueueEntry>(rows: readonly T[], previous: readonly string[]): T[] {
  const positions = new Map(previous.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    const aPosition = positions.get(a._id);
    const bPosition = positions.get(b._id);
    if (aPosition !== undefined || bPosition !== undefined) {
      return (aPosition ?? Infinity) - (bPosition ?? Infinity);
    }
    return (b.urgencyScore ?? -1) - (a.urgencyScore ?? -1)
      || b.updatedAt - a.updatedAt
      || a._id.localeCompare(b._id);
  });
}

/** A move can take a Ticket out of a filtered view. Keep walking the original
 * order, skipping rows no longer available without changing the open detail. */
export function queueNeighbors<Id extends string>(id: Id | null, items: readonly Id[], snapshot: readonly Id[]) {
  if (!id) return {};
  const original = new Set(snapshot);
  const order = original.has(id) ? [...snapshot, ...items.filter(item => !original.has(item))] : items;
  const index = order.indexOf(id);
  if (index < 0) return {};
  const visible = new Set(items);
  return {
    previous: order.slice(0, index).reverse().find(value => visible.has(value)),
    next: order.slice(index + 1).find(value => visible.has(value)),
  };
}
