import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
  type KanbanCommitMeta,
} from "@/components/reui/kanban";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FeedbackCard } from "@/components/feedback-card";
import { statusMeta } from "@/components/feedback-status";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "@/lib/feedback-ui";
import {
  BOARD_COLUMNS,
  emptyColumns,
  normalizeColumns,
  reconcileColumns,
  settlePendingMoves,
  statusChangeFromDrag,
  withoutPendingMove,
  type BoardColumns,
  type PendingMoves,
} from "@/lib/kanban-board";
import type { Feedback, FeedbackStatus } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

/**
 * The staff board.
 *
 * Columns are fixed to the four workflow states and cannot be reordered: each
 * column is declared `draggable={false}`, so dnd-kit registers it as a drop target
 * only and no sensor can pick it up, and no column drag handle is rendered. Cards
 * are dragged from their grip, which is the only drag activator; the drop is
 * applied locally first, then persisted with the ticket's expected version. A
 * rejected move (someone else got there first) is rolled back to whatever the
 * server says.
 */
export function StaffBoard({
  items,
  onSelect,
  onMoveCard,
}: {
  /** Active tickets, newest first, already filtered by the workspace search. */
  items: Feedback[];
  onSelect: (id: Id<"feedback">) => void;
  /** Persists a status change. Resolves false when the move was rejected. */
  onMoveCard: (id: Id<"feedback">, status: FeedbackStatus) => Promise<boolean>;
}) {
  const pendingRef = useRef<PendingMoves>({});
  const itemsRef = useRef(items);
  const [columns, setColumns] = useState<BoardColumns<Feedback>>(() =>
    reconcileColumns(items, emptyColumns<Feedback>(), {})
  );

  // Convex pushes the authoritative list on every change. Fold it into what is
  // on screen instead of replacing it, so in-flight drags survive the update.
  useEffect(() => {
    itemsRef.current = items;
    pendingRef.current = settlePendingMoves(items, pendingRef.current);
    setColumns((current) => reconcileColumns(items, current, pendingRef.current));
  }, [items]);

  const rollback = useCallback((id: string) => {
    pendingRef.current = withoutPendingMove(pendingRef.current, id);
    setColumns((current) => reconcileColumns(itemsRef.current, current, pendingRef.current));
  }, []);

  const commitMove = useCallback(
    async (meta: KanbanCommitMeta<Feedback>) => {
      if (meta.kind !== "item") return;
      const status = statusChangeFromDrag(meta);
      // Reordering inside a column changes nothing that is stored.
      if (!status) return;
      const id = String(meta.event.active.id) as Id<"feedback">;
      pendingRef.current = { ...pendingRef.current, [id]: status };
      const persisted = await onMoveCard(id, status);
      if (!persisted) rollback(id);
    },
    [onMoveCard, rollback],
  );

  return (
    <Kanban
      value={columns}
      onValueChange={(next) => setColumns(normalizeColumns(next))}
      getItemValue={(item) => item._id}
      onValueCommit={(_value, meta) => void commitMove(meta)}
      restoreOnCancel
    >
      <KanbanBoard className="grid auto-rows-fr gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            items={columns[status]}
            onSelect={onSelect}
            onMoveCard={onMoveCard}
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
              <FeedbackCard item={dragged} onSelect={() => undefined} />
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
}: {
  status: FeedbackStatus;
  items: Feedback[];
  onSelect: (id: Id<"feedback">) => void;
  onMoveCard: (id: Id<"feedback">, status: FeedbackStatus) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const label = t(meta.labelKey);

  return (
    <KanbanColumn value={status} draggable={false} className="min-w-0 rounded-lg border bg-card">
      <div className={cn("flex items-center justify-between rounded-t-lg border-b px-3 py-3", meta.tone)}>
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0" />
          <h2 className="truncate text-sm font-semibold">{label}</h2>
        </div>
        <Badge variant="outline" className="bg-white/70" aria-label={t("boardColumnCards", { count: items.length, status: label })}>
          {items.length}
        </Badge>
      </div>
      <KanbanColumnContent value={status} className="min-h-24 space-y-3 p-3">
        {items.length === 0 ? (
          <div className="grid min-h-24 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          items.map((item) => (
            <KanbanItem key={item._id} value={item._id}>
              <FeedbackCard
                item={item}
                onSelect={onSelect}
                onMove={(id, next) => void onMoveCard(id, next)}
                handle={
                  <KanbanItemHandle
                    render={(props) => (
                      <Button
                        {...props}
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-9 touch-none bg-background/90"
                        aria-label={t("dragTicket", { ticket: formatTicketNumber(item.ticketNumber) })}
                      >
                        <GripVertical />
                      </Button>
                    )}
                  />
                }
              />
            </KanbanItem>
          ))
        )}
      </KanbanColumnContent>
    </KanbanColumn>
  );
}
