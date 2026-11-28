import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Announcements, UniqueIdentifier } from "@dnd-kit/core";
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
import { useStaffCopy } from "@/lib/staff-copy";
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
  isArrivalOpened,
  markArrivalOpened,
  takeUnannouncedArrivals,
  sortLane,
  statusChangeFromDrag,
  type LaneSort,
  type PendingMoves,
} from "@/lib/kanban-board";
import type { TicketStatus } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

type LaneCounts = Partial<Record<TicketStatus, number>>;
type LanePage = { status: string; loadMore: (count: number) => void };
const compactStatusLabels: Partial<Record<TicketStatus, Record<"en" | "th", string>>> = {
  acknowledged: { en: "Ack.", th: "รับเรื่อง" },
  waiting: { en: "Waiting", th: "รอข้อมูล" },
};

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
export function StaffBoard({ items, projectId, totals, pages, onSelect, onMoveCard, shownByLane, loadedByLane, chosenStatus, onChooseStatus, constrained, busy, visibleStatuses = BOARD_COLUMNS }: {
  items: TicketSummary[];
  visibleStatuses?: readonly TicketStatus[];
  projectId: Id<"projects">;
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
  const { t, language } = useI18n();
  const [initialHighest] = useState(() => highestTicketNumber(items));
  const [pending, setPending] = useState<PendingMoves<TicketSummary>>({});
  const columns = useMemo(() => reconcileColumns(projectId, items, constrained ? {} : pending), [projectId, items, pending, constrained]);
  const enableDrag = useMediaQuery("(min-width: 1024px)");
  const standardShortcuts = useMediaQuery("(min-width: 768px)");
  const c = useExplorerCopy();
  const s = useStaffCopy();
  const boardId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [laneSort, setLaneSort] = useState<LaneSort>("newest");
  const [dragFrom, setDragFrom] = useState<TicketStatus | null>(null);
  const [, setOpenedRevision] = useState(0);
  const [arrivalNotice, setArrivalNotice] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  // Below 1280px only the chosen lane renders, full width; the others leave the tab order.
  const wide = useMediaQuery("(min-width: 1280px)");
  const chooser = !wide && visibleStatuses.length > 1;
  const preferredStatus = visibleStatuses.includes(chosenStatus) ? chosenStatus : visibleStatuses[0];
  const [currentStatus, setCurrentStatus] = useState(preferredStatus);
  useEffect(() => { setCurrentStatus(preferredStatus); }, [preferredStatus]);
  const shownStatuses = chooser ? [visibleStatuses.includes(currentStatus) ? currentStatus : preferredStatus] : visibleStatuses;
  const laneCount = (status: TicketStatus) => shownByLane?.[status] ?? totals[status] ?? columns[status].length;
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const draggedRef = useRef<TicketSummary | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    setPending(current => settlePendingMoves(projectId, items, current));
  }, [items, projectId, pending]);

  // Announce each newly observed arrival once per Project session; opened arrivals lose their marker.
  // Opening an arrival re-renders (setOpenedRevision) so its marker clears from the session-scoped set.
  const arrivals = items.filter(item => isNewArrival(item, initialHighest) && !isArrivalOpened(projectId, item._id)).map(item => item._id);
  const arrivalKey = arrivals.join(",");
  useEffect(() => {
    const count = takeUnannouncedArrivals(projectId, arrivalKey ? arrivalKey.split(",") : []);
    if (count > 0) setArrivalNotice(s.arrivals(count));
  }, [arrivalKey, projectId, s]);
  const openTicket: OpenTicket = (id, section) => {
    if (arrivals.includes(id)) { markArrivalOpened(projectId, id); setOpenedRevision(value => value + 1); }
    onSelect(id, section);
  };
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const statusOf = (id: UniqueIdentifier | undefined): TicketStatus | null => {
    if (id === undefined) return null;
    const key = String(id);
    if ((BOARD_COLUMNS as string[]).includes(key)) return key as TicketStatus;
    return BOARD_COLUMNS.find(status => columnsRef.current[status].some(row => row._id === key)) ?? null;
  };
  const referenceOf = (id: UniqueIdentifier) => {
    const row = BOARD_COLUMNS.flatMap(status => columnsRef.current[status]).find(item => item._id === String(id));
    return row ? formatTicketNumber(row.ticketNumber, row.projectKey) : t("ticket");
  };
  const statusName = (status: TicketStatus | null) => status ? t(statusMeta(status).labelKey) : "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => s.dragStart(referenceOf(active.id), statusName(statusOf(active.id))),
    onDragOver: ({ active, over }) => { const status = statusOf(over?.id); return status ? s.dragOver(referenceOf(active.id), statusName(status)) : s.dragOutside(referenceOf(active.id)); },
    onDragEnd: ({ active, over }) => { const status = statusOf(over?.id); return status ? s.dragEnd(referenceOf(active.id), statusName(status)) : s.dragCancel(referenceOf(active.id)); },
    onDragCancel: ({ active }) => s.dragCancel(referenceOf(active.id)),
  };

  const chooseStatus = (status: TicketStatus, focus = false) => {
    setCurrentStatus(status);
    onChooseStatus(status);
    if (focus) tabsRef.current?.querySelector<HTMLElement>(`[data-status="${status}"]`)?.focus();
    // Keep the chosen lane's heading visible beneath the pinned chooser.
    const tabs = tabsRef.current;
    const region = viewportRef.current;
    if (tabs && region) {
      const offset = tabs.getBoundingClientRect().height;
      const top = region.getBoundingClientRect().top;
      if (top < offset) window.scrollTo({ top: window.scrollY + top - offset - 8, behavior: "instant" });
    }
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = visibleStatuses.indexOf(currentStatus);
    const target = event.key === "Home" ? 0 : event.key === "End" ? visibleStatuses.length - 1
      : event.key === "ArrowRight" ? (index + 1) % visibleStatuses.length
      : event.key === "ArrowLeft" ? (index - 1 + visibleStatuses.length) % visibleStatuses.length : -1;
    if (target < 0) return;
    event.preventDefault();
    chooseStatus(visibleStatuses[target], true);
  };

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
      accessibility={{ announcements, screenReaderInstructions: { draggable: s.dragInstructions } }}
      onDragStart={(event) => {
        draggedRef.current = Object.values(columns).flat().find(row => row._id === event.active.id) ?? null;
        setDragFrom(draggedRef.current?.status ?? null);
      }}
      onDragCancel={() => { draggedRef.current = null; setDragFrom(null); }}
      onDragEnd={() => setDragFrom(null)}
      onMove={(meta) => {
        const status = statusChangeFromDrag(meta);
        const item = draggedRef.current;
        draggedRef.current = null;
        setDragFrom(null);
        if (item && status) void move(item, status);
      }}
    >
      <p role="status" aria-live="polite" className="sr-only">{arrivalNotice}</p>
      {Object.values(pending).map(entry => <MoveObservation key={entry.operationId} entry={entry} onObserve={observe} />)}
      <div className={cn("mb-3 flex flex-wrap items-center gap-2", chooser && "sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80")} ref={tabsRef}>
      {chooser && <div className="flex min-w-0 flex-[1_1_100%] flex-wrap gap-0.5 md:flex-[1_1_auto] md:gap-1.5" role="group" aria-label={t("boardStatusTabs")} onKeyDown={onTabKey}>
        {visibleStatuses.map(status => {
          const meta = statusMeta(status);
          const Icon = meta.icon;
          const label = t(meta.labelKey);
          const visibleLabel = (!standardShortcuts && compactStatusLabels[status]?.[language]) || label;
          const accessibleLabel = label === visibleLabel || label.startsWith(`${visibleLabel} `) ? label : `${visibleLabel} (${label})`;
          const count = laneCount(status);
          return <Button key={status} type="button" variant={status === currentStatus ? "secondary" : "outline"} size="sm"
            className="h-auto min-h-11 min-w-11 flex-[1_1_0] flex-col gap-0.5 whitespace-normal px-px py-1.5 text-center text-[0.6875rem] leading-tight md:flex-none md:flex-row md:gap-2 md:whitespace-nowrap md:px-3 md:text-xs"
            aria-label={`${accessibleLabel}, ${t("boardColumnCards", { count, status: label })}`}
            aria-pressed={status === currentStatus}
            aria-controls={`${boardId}-lanes`}
            data-status={status}
            tabIndex={status === currentStatus ? 0 : -1}
            title={label}
            onClick={() => chooseStatus(status)}>
            <Icon aria-hidden="true" />
            <span className="[overflow-wrap:anywhere]">{visibleLabel}</span>
            <span className="tabular-nums font-semibold">{count}</span>
          </Button>;
        })}
      </div>}
      <label className="ml-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{s.sort}
        <select className="aurora-control min-h-11 rounded-lg px-2 text-sm text-foreground md:min-h-8" value={laneSort} onChange={event => setLaneSort(event.target.value === "urgency" ? "urgency" : "newest")}>
          <option value="newest">{s.sortNewest}</option><option value="urgency">{s.sortUrgency}</option>
        </select>
      </label>
      </div>
      <div ref={viewportRef} id={`${boardId}-lanes`} className="min-w-0 max-w-full rounded-xl pb-3"
        role="region" aria-label={c.board}
        // A horizontal swipe still moves between lanes while one lane is shown.
        onTouchStart={chooser ? event => { const touch = event.touches[0]; swipe.current = { x: touch.clientX, y: touch.clientY }; } : undefined}
        onTouchEnd={chooser ? event => {
          const start = swipe.current; swipe.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) return;
          const dx = touch.clientX - start.x;
          if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(touch.clientY - start.y) * 1.5) return;
          const index = visibleStatuses.indexOf(currentStatus) + (dx < 0 ? 1 : -1);
          if (index >= 0 && index < visibleStatuses.length) chooseStatus(visibleStatuses[index]);
        } : undefined}>
        <KanbanBoard
          className="items-start gap-3 grid-cols-[repeat(var(--lane-count),minmax(0,1fr))]"
          style={{ "--lane-count": shownStatuses.length } as CSSProperties}
        >
          {shownStatuses.map(status => (
            <BoardColumn
              key={status}
              id={`${boardId}-${status}`}
              status={status}
              items={sortLane(columns[status], laneSort)}
              arrivals={arrivals}
              dropTarget={dragFrom !== null && dragFrom !== status}
              saving={id => Boolean(pending[id] && pending[id].resultVersion === undefined)}
              onSelect={openTicket}
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
  arrivals,
  dropTarget,
  saving,
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
  arrivals: readonly string[];
  dropTarget: boolean;
  saving: (id: string) => boolean;
}) {
  const { t } = useI18n();
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const label = t(meta.labelKey);
  const count = shown ?? total ?? items.length;
  const c = useExplorerCopy();
  const s = useStaffCopy();
  const loadingMore = page?.status === "LoadingMore";

  return (
    <KanbanColumn id={id} value={status} draggable={false} className="ticket-lane relative min-w-0 snap-start overflow-hidden">
      <div className="flex min-h-12 items-center justify-between gap-2 px-3.5 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("size-[1.125rem] shrink-0", meta.text)} aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase leading-5 tracking-wide [overflow-wrap:anywhere]">{label}</h2>
        </div>
        <Badge variant="outline" className="shrink-0 rounded-full border-border/50 bg-card/50 px-1.5 font-medium tabular-nums text-muted-foreground" aria-label={t("boardColumnCards", { count, status: label })}>
          {count}
        </Badge>
      </div>
      <KanbanColumnContent value={status} className="min-h-40 space-y-2.5 p-2.5">
        {shown !== undefined && loaded !== undefined && <p className="text-xs text-muted-foreground">
          {c.matching(shown, loaded)}{total !== undefined && ` · ${c.laneTotal(total)}`}
        </p>}
        {items.length === 0 ? (
          <div className={cn("grid min-h-32 place-items-center rounded-xl border border-dashed px-3 py-4 text-center text-sm text-muted-foreground",
            draggable && dropTarget && "border-primary bg-primary/5 font-medium text-primary")}>
            {draggable && dropTarget ? s.dropHere(label) : shown === undefined ? s.emptyLane(label) : c.loadedEmpty}
          </div>
        ) : (
          items.map((item) => {
            const itemBusy = Boolean(busy?.has(item._id) || saving(item._id));
            return <KanbanItem key={item._id} value={item._id} disabled={itemBusy}>
              {arrivals.includes(item._id) ? <p className="mb-1 text-xs text-muted-foreground">{t("liveArrival")}</p> : null}
              <TicketCard
                item={item}
                inLane
                showUnscored
                onSelect={onSelect}
                busy={itemBusy}
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
                          aria-disabled={itemBusy || undefined}
                          className="-mr-2 -mt-2 size-11 shrink-0 cursor-grab touch-none text-muted-foreground hover:bg-transparent hover:text-foreground active:cursor-grabbing aria-disabled:cursor-progress"
                          aria-label={t("dragTicket", { ticket: formatTicketNumber(item.ticketNumber, item.projectKey) })}
                        >
                          <GripVertical />
                        </Button>
                      )}
                    />
                  ) : undefined
                }
              />
            </KanbanItem>;
          })
        )}
        {page && (page.status === "CanLoadMore" || loadingMore) ? <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="min-h-11 flex-1" disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => page.loadMore(20)}>{loadingMore ? s.loadingOlder : t("loadOlder")}</Button>
          {total !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{s.laneLoaded(items.length, total)}</span>}
        </div> : null}
      </KanbanColumnContent>
    </KanbanColumn>
  );
}

function MoveObservation({ entry, onObserve }: {
  entry: PendingMoves<TicketSummary>[string];
  onObserve: (operationId: string, row: TicketSummary | null) => void;
}) {
  const row = useSelectedTicket(entry.ticket._id);
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
