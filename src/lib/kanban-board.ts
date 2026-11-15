import type { TicketStatus } from "@/lib/types";

export const BOARD_COLUMNS: TicketStatus[] = ["new", "acknowledged", "in_progress", "waiting", "done"];
type BoardColumns<T> = Record<TicketStatus, T[]>;
export type BoardTicket = { _id: string; projectId: string; status: TicketStatus; version: number; ticketNumber: number; lifecycle: string };
type PendingMove<T extends BoardTicket> = {
  operationId: string; ticket: T; target: TicketStatus; resultVersion?: number;
  observed?: T;
  retained?: T;
};
export type PendingMoves<T extends BoardTicket> = Record<string, PendingMove<T>>;

function isBoardStatus(value: string): value is TicketStatus {
  return (BOARD_COLUMNS as string[]).includes(value);
}
export function emptyColumns<T>(): BoardColumns<T> {
  return { new: [], acknowledged: [], in_progress: [], waiting: [], done: [] };
}

export function highestTicketNumber(rows: BoardTicket[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.ticketNumber), 0);
}
export function isNewArrival(row: BoardTicket, initialHighest: number): boolean {
  return row.ticketNumber > initialHighest;
}
export function pendingMoveCount<T extends BoardTicket>(pending: PendingMoves<T>): number {
  return Object.values(pending).filter(move => !move.observed).length;
}

/** Missing pages never acknowledge a move. A result and an observation at or
 * beyond that result's version are both required; newer concurrent edits win.
 */
export function settlePendingMoves<T extends BoardTicket>(projectId: string, observed: T[], pending: PendingMoves<T>): PendingMoves<T> {
  const byId = newestRows(observed.filter(row => row.projectId === projectId));
  const entries = Object.entries(pending).filter(([id, move]) => {
    if (move.ticket.projectId !== projectId) return false;
    const row = byId.get(id);
    if (move.resultVersion === undefined) return true;
    if (row && row.version >= Math.max(move.resultVersion, move.observed?.version ?? 0)) return false;
    return true;
  });
  return entries.length === Object.keys(pending).length ? pending : Object.fromEntries(entries);
}

/** Fence late responses, including responses from a previous Project view. */
export function finishMove<T extends BoardTicket>(pending: PendingMoves<T>, id: string, operationId: string, version: number | null): PendingMoves<T> {
  if (pending[id]?.operationId !== operationId) return pending;
  const next = { ...pending };
  if (version === null) {
    const retained = next[id].observed ? undefined : next[id].retained;
    if (retained) next[id] = { operationId, ticket: retained, target: retained.status, resultVersion: retained.version, observed: retained };
    else delete next[id];
  }
  else next[id] = { ...next[id], resultVersion: version };
  return next;
}

/** Keep acknowledged rows until destination pages cover them or the board unmounts.
 * Continue observing them so subsequent moves/archive remain authoritative.
 */
export function observeMove<T extends BoardTicket>(pending: PendingMoves<T>, operationId: string, row: T | null): PendingMoves<T> {
  if (!row) {
    const move = Object.values(pending).find(move => move.operationId === operationId && move.observed);
    return move ? finishMove(pending, move.ticket._id, operationId, null) : pending;
  }
  const move = pending[row._id];
  if (move?.operationId !== operationId || move.resultVersion === undefined || row.version < move.resultVersion) return pending;
  if (move.observed && move.observed.version >= row.version) return pending;
  return { ...pending, [row._id]: { ...move, observed: row } };
}

function newestRows<T extends BoardTicket>(rows: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const row of rows) if (!byId.has(row._id) || byId.get(row._id)!.version < row.version) byId.set(row._id, row);
  return byId;
}

/** Pages are authoritative; only in-flight operations retain a small snapshot.
 * Observed moves retain their authoritative row outside loaded page ranges.
 * Deduplicate overlapping lane deliveries by version, then sort by Ticket number.
 * Older pages naturally append; live arrivals precede them.
 */
export function reconcileColumns<T extends BoardTicket>(projectId: string, rows: T[], pending: PendingMoves<T> = {}): BoardColumns<T> {
  const byId = newestRows([...rows, ...Object.values(pending).flatMap(move => move.observed ? [move.observed] : [])]
    .filter(row => row.projectId === projectId));
  for (const [id, move] of Object.entries(pending)) {
    if (move.ticket.projectId !== projectId || move.observed) continue;
    const row = byId.get(id);
    // An intervening subscription is authoritative even while a response is held.
    if (!row || row.version <= move.ticket.version) byId.set(id, { ...(row ?? move.ticket), status: move.target });
  }
  const columns = emptyColumns<T>();
  for (const row of byId.values()) if (row.lifecycle === "active" && isBoardStatus(row.status)) columns[row.status].push(row);
  for (const status of BOARD_COLUMNS) columns[status].sort((a, b) => b.ticketNumber - a.ticketNumber);
  return columns;
}

export function statusChangeFromDrag(input: { activeContainer: string; overContainer: string }): TicketStatus | null {
  return input.activeContainer !== input.overContainer && isBoardStatus(input.overContainer) ? input.overContainer : null;
}
