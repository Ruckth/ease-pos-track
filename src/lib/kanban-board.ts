/**
 * Column bookkeeping for the staff Kanban board.
 *
 * The board is optimistic: a drag applies locally, then a status mutation
 * confirms it. Meanwhile Convex keeps streaming the authoritative ticket list,
 * which may include other people's edits. These pure helpers decide how the two
 * are merged, so the rules can be unit tested without a browser.
 */

import type { FeedbackStatus } from "@/lib/types";

/** Fixed board columns. Columns are never added, removed, or reordered. */
export const BOARD_COLUMNS: FeedbackStatus[] = ["new", "acknowledged", "in_progress", "waiting", "done"];

export type BoardColumns<T> = Record<FeedbackStatus, T[]>;

/** Tickets whose status change is in flight, keyed by ticket id. */
export type PendingMoves = Record<string, FeedbackStatus>;

export type BoardCard = {
  _id: string;
  status: FeedbackStatus;
};

export function isBoardStatus(value: string): value is FeedbackStatus {
  return (BOARD_COLUMNS as string[]).includes(value);
}

export function emptyColumns<T>(): BoardColumns<T> {
  return { new: [], acknowledged: [], in_progress: [], waiting: [], done: [] };
}

/**
 * Narrows the primitive's generic `Record<string, T[]>` back to the five fixed
 * columns, dropping anything unexpected.
 */
export function normalizeColumns<T>(value: Record<string, T[]>): BoardColumns<T> {
  const columns = emptyColumns<T>();
  for (const status of BOARD_COLUMNS) {
    columns[status] = value[status] ?? [];
  }
  return columns;
}

export function countCards<T>(columns: BoardColumns<T>) {
  return BOARD_COLUMNS.reduce((total, status) => total + columns[status].length, 0);
}

/**
 * Merges the authoritative ticket list into the columns currently on screen.
 *
 * - A ticket with a pending move is shown in its pending column, not the
 *   server's, so an in-flight drag does not visibly snap back.
 * - Tickets already on the board keep their position within their column, so a
 *   background update never reshuffles cards under the pointer.
 * - Tickets new to a column are placed on top, matching the newest-first order
 *   the server returns.
 */
export function reconcileColumns<T extends BoardCard>(
  serverItems: T[],
  previous: BoardColumns<T>,
  pending: PendingMoves = {},
): BoardColumns<T> {
  const previousPositions = new Map<string, { status: FeedbackStatus; index: number }>();
  for (const status of BOARD_COLUMNS) {
    previous[status].forEach((item, index) => {
      previousPositions.set(item._id, { status, index });
    });
  }

  const grouped = emptyColumns<T>();
  for (const item of serverItems) {
    const pendingStatus = pending[item._id];
    const status = pendingStatus !== undefined ? pendingStatus : item.status;
    if (!isBoardStatus(status)) continue;
    grouped[status].push(item);
  }

  const next = emptyColumns<T>();
  for (const status of BOARD_COLUMNS) {
    const known: T[] = [];
    const arrived: T[] = [];
    for (const item of grouped[status]) {
      const position = previousPositions.get(item._id);
      if (position && position.status === status) known.push(item);
      else arrived.push(item);
    }
    known.sort((left, right) =>
      (previousPositions.get(left._id)?.index ?? 0) - (previousPositions.get(right._id)?.index ?? 0)
    );
    next[status] = [...arrived, ...known];
  }
  return next;
}

/**
 * Drops pending moves the server has caught up with, plus any for tickets that
 * are gone. Called on every server update so a stuck entry cannot pin a card in
 * the wrong column forever.
 */
export function settlePendingMoves<T extends BoardCard>(serverItems: T[], pending: PendingMoves): PendingMoves {
  const byId = new Map(serverItems.map((item) => [item._id, item]));
  const next: PendingMoves = {};
  for (const [id, status] of Object.entries(pending)) {
    const item = byId.get(id);
    if (!item || item.status === status) continue;
    next[id] = status;
  }
  return next;
}

export function withoutPendingMove(pending: PendingMoves, id: string): PendingMoves {
  const next = { ...pending };
  delete next[id];
  return next;
}

/** Locates a card across the board. */
export function findCardStatus<T extends BoardCard>(columns: BoardColumns<T>, id: string) {
  return BOARD_COLUMNS.find((status) => columns[status].some((item) => item._id === id));
}

/**
 * Reads a drag result into the status change it implies. Returns null when the
 * card was only reordered inside its column, which the board does not persist
 * because card order is not stored.
 */
export function statusChangeFromDrag(input: {
  activeContainer: string;
  overContainer: string;
}): FeedbackStatus | null {
  if (input.activeContainer === input.overContainer) return null;
  if (!isBoardStatus(input.overContainer)) return null;
  return input.overContainer;
}
