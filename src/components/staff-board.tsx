import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  const enableDrag = useMediaQuery("(min-width: 1024px)");
  const c = useExplorerCopy();
  const boardId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const preferredStatus = visibleStatuses.includes(chosenStatus) ? chosenStatus : visibleStatuses[0];
  const [currentStatus, setCurrentStatus] = useState(preferredStatus);
  const scrollTarget = useRef<number | null>(null);

  const scrollToStatus = useCallback((status: TicketStatus) => {
    const viewport = viewportRef.current;
    const lane = document.getElementById(`${boardId}-${status}`);
    if (!viewport || !lane) return;
    setCurrentStatus(status);
    // Sortable transforms can still be animating when the viewport changes size.
    const laneStart = lane.offsetLeft;
    const target = Math.max(0, Math.min(laneStart, viewport.scrollWidth - viewport.clientWidth));
    scrollTarget.current = target;
    viewport.scrollTo({ left: target, behavior: "instant" });
  }, [boardId]);

  function syncStatusFromScroll(viewport: HTMLDivElement) {
    const maxScroll = viewport.scrollWidth - viewport.clientWidth;
    if (maxScroll <= 1 || (scrollTarget.current !== null && Math.abs(viewport.scrollLeft - scrollTarget.current) <= 1)) return;
    scrollTarget.current = null;
    if (maxScroll - viewport.scrollLeft <= 1) {
      setCurrentStatus(visibleStatuses[visibleStatuses.length - 1]);
      return;
    }
    const start = viewport.getBoundingClientRect().left;
    let nearest = visibleStatuses[0];
    let closest = Infinity;
    for (const status of visibleStatuses) {
      const lane = document.getElementById(`${boardId}-${status}`);
      if (!lane) continue;
      const distance = Math.abs(lane.getBoundingClientRect().left - start);
      if (distance >= closest) continue;
      closest = distance;
      nearest = status;
    }
    setCurrentStatus(nearest);
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateOverflow = () => setHasOverflow(viewport.scrollWidth - viewport.clientWidth > 1);
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [visibleStatuses]);

  useLayoutEffect(() => {
    if (hasOverflow) scrollToStatus(preferredStatus);
  }, [hasOverflow, preferredStatus, scrollToStatus, visibleStatuses]);

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
      className="min-w-0"
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
      {Object.values(pending).map(entry => <MoveObservation token={token} key={entry.operationId} entry={entry} onObserve={observe} />)}
      {hasOverflow && <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label={t("boardStatusTabs")}>
        {visibleStatuses.map(status => {
          const meta = statusMeta(status);
          const Icon = meta.icon;
          return <Button key={status} type="button" variant={status === currentStatus ? "secondary" : "outline"} size="sm"
            className="min-h-11"
            aria-pressed={status === currentStatus}
            aria-controls={`${boardId}-${status}`}
            onClick={() => {
              scrollToStatus(status);
              onChooseStatus(status);
            }}>
            <Icon aria-hidden="true" />
            {t(meta.labelKey)}
          </Button>;
        })}
      </div>}
      <div ref={viewportRef} className="min-w-0 max-w-full snap-x snap-proximity overflow-x-auto rounded-xl pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region" aria-label={c.board} tabIndex={hasOverflow ? 0 : undefined}
        onScroll={event => syncStatusFromScroll(event.currentTarget)}>
        <KanbanBoard
          className={cn("relative items-start gap-3", visibleStatuses.length === 1
            ? "grid-cols-1 sm:grid-cols-1"
            : "grid-cols-[repeat(var(--lane-count),minmax(85%,1fr))] sm:grid-cols-[repeat(var(--lane-count),minmax(min(85%,13rem),1fr))]")}
          style={{ "--lane-count": visibleStatuses.length } as CSSProperties}
        >
          {visibleStatuses.map(status => (
            <BoardColumn
              key={status}
              id={`${boardId}-${status}`}
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
              draggable={enableDrag}
            />
          ))}
        </KanbanBoard>
      </div>
      <KanbanOverlay className="hidden lg:block">
        {({ value, variant }) => {
          if (variant === "column") return null;
          const dragged = BOARD_COLUMNS.flatMap((status) => columns[status]).find((item) => item._id === value);
          if (!dragged) return null;
          return (
            <div className="w-72 max-w-[90vw] rotate-1 opacity-95">
              <TicketCard item={dragged} inLane onSelect={() => undefined} />
            </div>
          );
        }}
      </KanbanOverlay>
    </Kanban>
  );
}

function BoardColumn({
  id,
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
  id: string;
  status: TicketStatus;
  items: TicketSummary[];
  onSelect: OpenTicket;
  onMoveCard: (item: TicketSummary, status: TicketStatus) => void;
  /** Direct status actions are available even when the drag handle is hidden. */
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
    <KanbanColumn id={id} value={status} draggable={false} className="ticket-lane relative min-w-0 snap-start overflow-hidden">
      <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-3.5 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("size-[1.125rem] shrink-0", meta.text)} aria-hidden="true" />
          <h2 className="break-words text-xs font-semibold uppercase leading-5 tracking-wide">{label}</h2>
        </div>
        <Badge variant="outline" className="rounded-full border-border/50 bg-card/50 px-1.5 font-medium tabular-nums text-muted-foreground" aria-label={t("boardColumnCards", { count, status: label })}>
          {count}
        </Badge>
      </div>
      <KanbanColumnContent value={status} className="min-h-40 space-y-2.5 p-2.5">
        {shown !== undefined && loaded !== undefined && <p className="text-xs text-muted-foreground">
          {c.matching(shown, loaded)}{total !== undefined && ` · ${c.laneTotal(total)}`}
        </p>}
        {items.length === 0 ? (
          <div className="grid min-h-32 place-items-center rounded-xl border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
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
                          variant="ghost"
                          size="icon"
                          className="-mr-2 -mt-2 size-11 shrink-0 cursor-grab touch-none text-muted-foreground hover:bg-transparent hover:text-foreground active:cursor-grabbing"
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
  token: string;
  entry: PendingMoves<TicketSummary>[string];
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
