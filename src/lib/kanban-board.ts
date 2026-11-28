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

export type LaneSort = "newest" | "urgency";

/** Urgency order within loaded rows: highest score first, unscored last, then lower Ticket number. */
export function sortLane<T extends BoardTicket & { urgencyScore?: number }>(rows: T[], sort: LaneSort): T[] {
  if (sort === "newest") return rows;
  return [...rows].sort((a, b) => (b.urgencyScore ?? -1) - (a.urgencyScore ?? -1) || a.ticketNumber - b.ticketNumber);
}

/** The four non-Done lanes and Done, from the same lane totals. */
export function openAndDone(totals: Partial<Record<TicketStatus, number>>) {
  const done = totals.done ?? 0;
  const open = BOARD_COLUMNS.reduce((sum, status) => status === "done" ? sum : sum + (totals[status] ?? 0), 0);
  return { open, done };
}

/** Mirrors the 30-day archive retention rule; a purge claim, not this date, ends restoration. */
export const ARCHIVE_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export function purgeEligibility(archivedAt: number | undefined, now: number):
  { state: "unknown" } | { state: "eligible" } | { state: "future"; from: number } {
  if (archivedAt === undefined || !Number.isFinite(archivedAt)) return { state: "unknown" };
  const from = archivedAt + ARCHIVE_PURGE_AFTER_MS;
  return from <= now ? { state: "eligible" } : { state: "future", from };
}

/** Arrivals seen this session per Project: opened ones lose their marker; each is announced once. */
const openedArrivals = new Map<string, Set<string>>();
const announcedArrivals = new Map<string, Set<string>>();
function projectSet(map: Map<string, Set<string>>, projectId: string) {
  let set = map.get(projectId);
  if (!set) map.set(projectId, set = new Set());
  return set;
}
export function markArrivalOpened(projectId: string, id: string) { projectSet(openedArrivals, projectId).add(id); }
export function isArrivalOpened(projectId: string, id: string) { return openedArrivals.get(projectId)?.has(id) ?? false; }
/** Returns how many arrivals in `ids` have not been announced before, and records them. */
export function takeUnannouncedArrivals(projectId: string, ids: readonly string[]) {
  const seen = projectSet(announcedArrivals, projectId);
  let count = 0;
  for (const id of ids) if (!seen.has(id)) { seen.add(id); count++; }
  return count;
}
export function resetArrivalTracking() { openedArrivals.clear(); announcedArrivals.clear(); }
