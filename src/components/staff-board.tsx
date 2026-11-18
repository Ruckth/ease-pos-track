import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useSelectedTicket } from "@/features/tickets/adapter";
import type { TicketSummary } from "../../shared/ticket-contracts";
import type { Id } from "@convex/_generated/dataModel";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from "@/components/reui/kanban";
import { useMediaQuery } from "@/lib/use-media-query";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TicketCard, type OpenTicket } from "@/components/ticket-card";
import { statusMeta } from "@/components/ticket-status";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import {
  BOARD_COLUMNS,
  reconcileColumns,
  settlePendingMoves,
  finishMove,
  observeMove,
  pendingMoveCount,
  highestTicketNumber,
  isNewArrival,
  statusChangeFromDrag,
  type PendingMoves,
} from "@/lib/kanban-board";
import type { TicketStatus } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

type LaneCounts = Partial<Record<TicketStatus, number>>;
type LanePage = { status: string; loadMore: (count: number) => void };

/**
 * The staff board.
 *
 * Columns are fixed to the five workflow states and cannot be reordered: each
 * column is declared `draggable={false}`, so dnd-kit registers it as a drop target
 * only and no sensor can pick it up, and no column drag handle is rendered. Cards
 * are dragged from their grip, which is the only drag activator; the drop is
 * applied locally first, then persisted with the ticket's expected version. A
 * rejected move removes its overlay; authoritative pages stay untouched.
 */
export function StaffBoard({ items, projectId, token, totals, pages, onSelect, onMoveCard, shownByLane, loadedByLane, chosenStatus, onChooseStatus, constrained, busy, visibleStatuses = BOARD_COLUMNS }: {
  items: TicketSummary[];
  visibleStatuses?: readonly TicketStatus[];
  projectId: Id<"projects">;
  token: string;
  totals: Partial<Record<TicketStatus, number>>;
  pages?: Record<TicketStatus, LanePage>;
  shownByLane?: LaneCounts;
  loadedByLane?: LaneCounts;
  chosenStatus: TicketStatus;
  onChooseStatus: (status: TicketStatus) => void;
  constrained: boolean;
  busy?: ReadonlySet<string>;
  onSelect: OpenTicket;
  onMoveCard: (item: TicketSummary, status: TicketStatus) => Promise<number | null>;
}) {
  const { t } = useI18n();
  const [initialHighest] = useState(() => highestTicketNumber(items));
  const [pending, setPending] = useState<PendingMoves<TicketSummary>>({});
  const columns = useMemo(() => reconcileColumns(projectId, items, constrained ? {} : pending), [projectId, items, pending, constrained]);
  const multiColumn = useMediaQuery("(min-width: 1024px)");
  const visibleStatus = visibleStatuses.includes(chosenStatus) ? chosenStatus : visibleStatuses[0];
  const draggedRef = useRef<TicketSummary | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    setPending(current => settlePendingMoves(projectId, items, current));
  }, [items, projectId, pending]);

  const observe = useCallback((operationId: string, row: TicketSummary | null) => {
    setPending(current => {
      const next = observeMove(current, operationId, row);
      if (!row || next[row._id]?.operationId !== operationId || !next[row._id].observed) return next;
      if (row.lifecycle === "active" && visibleStatuses.includes(row.status)) return next;
      const remaining = { ...next };
      delete remaining[row._id];
      return remaining;
    });
  }, [visibleStatuses]);

  async function move(item: TicketSummary, status: TicketStatus) {
    // Filtered results are bounded by the current query. Only its subscription
    // can decide whether a moved Ticket still belongs in that result set.
    if (constrained) {
      await onMoveCard(item, status);
      return;
    }
    if (pendingRef.current[item._id] && !pendingRef.current[item._id].observed) return;
    if (pendingMoveCount(pendingRef.current) >= 10) {
      toast.info(t("pendingMoveLimit"));
      return;
    }
    const operationId = crypto.randomUUID();
    const entry = { operationId, ticket: item, target: status, retained: pendingRef.current[item._id]?.observed };
    pendingRef.current = { ...pendingRef.current, [item._id]: entry };
    setPending(pendingRef.current);
    const version = await onMoveCard(item, status);
    setPending(current => finishMove(current, item._id, operationId, version));
  }

  return (
    <Kanban
      value={columns}
      onValueChange={() => undefined}
      getItemValue={(item) => item._id}
      onDragStart={(event) => { draggedRef.current = Object.values(columns).flat().find(row => row._id === event.active.id) ?? null; }}
      onDragCancel={() => { draggedRef.current = null; }}
      onMove={(meta) => {
        const status = statusChangeFromDrag(meta);
        const item = draggedRef.current;
        draggedRef.current = null;
        if (item && status) void move(item, status);
      }}
    >
      {Object.values(pending).map(entry => <MoveObservation key={entry.operationId} token={token} entry={entry} onObserve={observe} />)}
      {!multiColumn && <label className="mb-2 flex min-w-0 items-center gap-2 text-sm font-medium">
        {t("boardStatusTabs")}
        <select className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-2" value={visibleStatus}
          onChange={event => onChooseStatus(event.target.value as TicketStatus)}>
          {visibleStatuses.map(status => <option key={status} value={status}>
            {t(statusMeta(status).labelKey)} · {shownByLane?.[status] ?? totals[status] ?? columns[status].length}
          </option>)}
        </select>
      </label>}
      <KanbanBoard
        className={cn("grid items-start gap-3", multiColumn && "grid-flow-col overflow-x-auto pb-2")}
        style={{ gridTemplateColumns: multiColumn ? `repeat(${visibleStatuses.length}, minmax(14rem, 1fr))` : "minmax(0, 1fr)" }}
      >
        {(multiColumn ? visibleStatuses : [visibleStatus]).map((status) => (
          <BoardColumn
            key={status}
            status={status}
            items={columns[status]}
            initialHighest={initialHighest}
            onSelect={onSelect}
            onMoveCard={move}
            total={totals[status]}
            shown={shownByLane?.[status]}
            loaded={loadedByLane?.[status]}
            busy={busy}
            page={pages?.[status]}
            draggable={multiColumn}
          />
        ))}
      </KanbanBoard>
      <KanbanOverlay>
        {({ value, variant }) => {
          if (variant === "column") return null;
          const dragged = BOARD_COLUMNS.flatMap((status) => columns[status]).find((item) => item._id === value);
          if (!dragged) return null;
          return (
            <div className="w-72 max-w-[90vw] rotate-1 opacity-95">
              <TicketCard item={dragged} onSelect={() => undefined} />
            </div>
          );
        }}
      </KanbanOverlay>
    </Kanban>
  );
}

function BoardColumn({
  status,
  items,
  onSelect,
  onMoveCard,
  draggable,
  total,
  shown,
  loaded,
  busy,
  page,
  initialHighest,
}: {
  status: TicketStatus;
  items: TicketSummary[];
  onSelect: OpenTicket;
  onMoveCard: (item: TicketSummary, status: TicketStatus) => void;
  /** False below `lg`, where one column is shown at a time and no card can be dragged. */
  draggable: boolean;
  total?: number;
  shown?: number;
  loaded?: number;
  busy?: ReadonlySet<string>;
  page?: LanePage;
  initialHighest: number;
}) {
  const { t } = useI18n();
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const label = t(meta.labelKey);
  const count = shown ?? total ?? items.length;
  const c = useExplorerCopy();

  return (
    <KanbanColumn value={status} draggable={false} className="min-w-0 rounded-lg border bg-card">
      {/* Below `lg` the selected tab already names the column and shows its count. */}
      {draggable ? (
        <div className={cn("flex items-center justify-between rounded-t-lg border-b px-3 py-3", meta.tone)}>
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <h2 className="break-words text-sm font-semibold">{label}</h2>
          </div>
          <Badge variant="outline" className="bg-white/70" aria-label={t("boardColumnCards", { count, status: label })}>
            {count}
          </Badge>
        </div>
      ) : null}
      <KanbanColumnContent value={status} className="min-h-24 space-y-3 p-3">
        {shown !== undefined && loaded !== undefined && <p className="text-xs text-muted-foreground">
          {c.matching(shown, loaded)}{total !== undefined && ` · ${c.laneTotal(total)}`}
        </p>}
        {items.length === 0 ? (
          <div className="grid min-h-24 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
            {shown === undefined ? t("empty") : c.loadedEmpty}
          </div>
        ) : (
          items.map((item) => (
            <KanbanItem key={item._id} value={item._id}>
              {isNewArrival(item, initialHighest) ? <p className="mb-1 text-xs text-muted-foreground">{t("liveArrival")}</p> : null}
              <TicketCard
                item={item}
                inLane
                onSelect={onSelect}
                busy={busy?.has(item._id)}
                onMove={(_id, next) => void onMoveCard(item, next)}
                handle={
                  draggable ? (
                    <KanbanItemHandle
                      render={(props) => (
                        <Button
                          {...props}
                          type="button"
                          variant="outline"
                          size="icon"
                          className="size-11 touch-none bg-background/90"
                          aria-label={t("dragTicket", { ticket: formatTicketNumber(item.ticketNumber, item.projectKey) })}
                        >
                          <GripVertical />
                        </Button>
                      )}
                    />
                  ) : undefined
                }
              />
            </KanbanItem>
          ))
        )}
        {page && (page.status === "CanLoadMore" || page.status === "LoadingMore") ? <Button type="button" variant="outline" className="min-h-11 w-full" disabled={page.status === "LoadingMore"} onClick={() => page.loadMore(20)}>{t("loadOlder")}</Button> : null}
      </KanbanColumnContent>
    </KanbanColumn>
  );
}

function MoveObservation({ token, entry, onObserve }: {
  token: string; entry: PendingMoves<TicketSummary>[string];
  onObserve: (operationId: string, row: TicketSummary | null) => void;
}) {
  const row = useSelectedTicket(token, entry.ticket._id);
  useEffect(() => {
    if (row === undefined) return;
    if (!row) { onObserve(entry.operationId, null); return; }
    const { description, media, annotations, _creationTime: _time, origin: _origin, createdVia: _via, ...summary } = row;
    onObserve(entry.operationId, { ...summary, urgencyScore: row.urgencyScore, archivedAt: row.archivedAt,
      excerpt: Array.from(description).slice(0, 200).join(""),
      mediaCount: media.length, annotationCount: annotations.filter(annotation => annotation.deletedAt === undefined).length });
  }, [row, entry.operationId, entry.resultVersion, onObserve]);
  return null;
}
