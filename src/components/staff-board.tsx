import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { GripVertical } from "lucide-react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TicketCard } from "@/components/ticket-card";
import { statusMeta } from "@/components/ticket-status";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "@/lib/ticket-ui";
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

/**
 * Tailwind's `lg` breakpoint, the width at which the board becomes multi-column.
 *
 * Below it the five columns cannot sit side by side, so dragging between them is
 * impossible; the board switches to status tabs showing one column at a time and
 * cards are advanced with their status button instead. The breakpoint is read in
 * JS rather than with `lg:hidden` because both layouts must never be mounted at
 * once: duplicate column and card ids would break dnd-kit.
 */
const MULTI_COLUMN_QUERY = "(min-width: 1024px)";

function subscribeToViewport(onChange: () => void) {
  const query = window.matchMedia(MULTI_COLUMN_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isMultiColumnViewport = () => window.matchMedia(MULTI_COLUMN_QUERY).matches;

/** No `window` while rendering on the server; assume the wide layout. */
const isMultiColumnOnServer = () => true;

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
export function StaffBoard({ items, projectId, token, totals, pages, onSelect, onMoveCard }: {
  items: TicketSummary[];
  projectId: Id<"projects">;
  token: string;
  totals: Partial<Record<TicketStatus, number>>;
  pages: Record<TicketStatus, { status: string; loadMore: (count: number) => void }>;
  onSelect: (id: Id<"tickets">) => void;
  onMoveCard: (item: TicketSummary, status: TicketStatus) => Promise<number | null>;
}) {
  const { t } = useI18n();
  const [initialHighest] = useState(() => highestTicketNumber(items));
  const [pending, setPending] = useState<PendingMoves<TicketSummary>>({});
  const columns = reconcileColumns(projectId, items, pending);
  const multiColumn = useSyncExternalStore(subscribeToViewport, isMultiColumnViewport, isMultiColumnOnServer);
  const [visibleStatus, setVisibleStatus] = useState<TicketStatus>(BOARD_COLUMNS[0]);
  const tabsId = useId();
  const panelId = `${tabsId}-panel`;
  const tabId = (status: TicketStatus) => `${tabsId}-${status}`;
  const draggedRef = useRef<TicketSummary | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    setPending(current => settlePendingMoves(projectId, items, current));
  }, [items, projectId, pending]);

  const observe = useCallback((operationId: string, row: TicketSummary | null) => {
    setPending(current => observeMove(current, operationId, row));
  }, []);

  async function move(item: TicketSummary, status: TicketStatus) {
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
      {multiColumn ? null : (
        <StatusTabs
          totals={totals}
          value={visibleStatus}
          onValueChange={setVisibleStatus}
          panelId={panelId}
          tabId={tabId}
        />
      )}
      <KanbanBoard
        className="grid auto-rows-fr gap-4 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-5"
        {...(multiColumn ? {} : { id: panelId, role: "tabpanel", "aria-labelledby": tabId(visibleStatus) })}
      >
        {(multiColumn ? BOARD_COLUMNS : [visibleStatus]).map((status) => (
          <BoardColumn
            key={status}
            status={status}
            items={columns[status]}
            initialHighest={initialHighest}
            onSelect={onSelect}
            onMoveCard={(id, status) => {
              const item = columns[status].find(row => row._id === id) ?? Object.values(columns).flat().find(row => row._id === id);
              if (item) void move(item, status);
            }}
            total={totals[status] ?? 0}
            page={pages[status]}
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

/**
 * The mobile status switcher: one tab per column, the selected one being the only
 * column rendered. Roving tabindex plus arrow keys, per the ARIA tabs pattern.
 */
function StatusTabs({
  totals,
  value,
  onValueChange,
  panelId,
  tabId,
}: {
  totals: Partial<Record<TicketStatus, number>>;
  value: TicketStatus;
  onValueChange: (status: TicketStatus) => void;
  panelId: string;
  tabId: (status: TicketStatus) => string;
}) {
  const { t } = useI18n();
  const tabRefs = useRef<Partial<Record<TicketStatus, HTMLButtonElement | null>>>({});

  return (
    <div role="tablist" aria-label={t("boardStatusTabs")} className="mb-4 grid grid-cols-2 gap-1 rounded-lg border bg-card p-1 sm:grid-cols-3">
      {BOARD_COLUMNS.map((status, index) => {
        const meta = statusMeta(status);
        const Icon = meta.icon;
        const label = t(meta.labelKey);
        const selected = status === value;
        return (
          <button
            key={status}
            ref={(node) => {
              tabRefs.current[status] = node;
            }}
            type="button"
            role="tab"
            id={tabId(status)}
            aria-controls={panelId}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            aria-label={t("boardColumnCards", { count: totals[status] ?? 0, status: label })}
            onClick={() => onValueChange(status)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const next = BOARD_COLUMNS[(index + step + BOARD_COLUMNS.length) % BOARD_COLUMNS.length];
              onValueChange(next);
              tabRefs.current[next]?.focus();
            }}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? cn("border", meta.tone) : "text-muted-foreground hover:bg-accent",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
            <span className="tabular-nums">{totals[status] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

function BoardColumn({
  status,
  items,
  onSelect,
  onMoveCard,
  draggable,
  total,
  page,
  initialHighest,
}: {
  status: TicketStatus;
  items: TicketSummary[];
  onSelect: (id: Id<"tickets">) => void;
  onMoveCard: (id: Id<"tickets">, status: TicketStatus) => void;
  /** False below `lg`, where one column is shown at a time and no card can be dragged. */
  draggable: boolean;
  total: number;
  page: { status: string; loadMore: (count: number) => void };
  initialHighest: number;
}) {
  const { t } = useI18n();
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const label = t(meta.labelKey);

  return (
    <KanbanColumn value={status} draggable={false} className="min-w-0 rounded-lg border bg-card">
      {/* Below `lg` the selected tab already names the column and shows its count. */}
      {draggable ? (
        <div className={cn("flex items-center justify-between rounded-t-lg border-b px-3 py-3", meta.tone)}>
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <h2 className="truncate text-sm font-semibold">{label}</h2>
          </div>
          <Badge variant="outline" className="bg-white/70" aria-label={t("boardColumnCards", { count: total, status: label })}>
            {total}
          </Badge>
        </div>
      ) : null}
      <KanbanColumnContent value={status} className="min-h-24 space-y-3 p-3">
        {items.length === 0 ? (
          <div className="grid min-h-24 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          items.map((item) => (
            <KanbanItem key={item._id} value={item._id}>
              {isNewArrival(item, initialHighest) ? <p className="mb-1 text-xs text-muted-foreground">{t("liveArrival")}</p> : null}
              <TicketCard
                item={item}
                onSelect={onSelect}
                onMove={(id, next) => void onMoveCard(id, next)}
                handle={
                  draggable ? (
                    <KanbanItemHandle
                      render={(props) => (
                        <Button
                          {...props}
                          type="button"
                          variant="outline"
                          size="icon"
                          className="size-9 touch-none bg-background/90"
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
        {page.status === "CanLoadMore" || page.status === "LoadingMore" ? <Button type="button" variant="outline" className="w-full" disabled={page.status === "LoadingMore"} onClick={() => page.loadMore(20)}>{t("loadOlder")}</Button> : null}
      </KanbanColumnContent>
    </KanbanColumn>
  );
}

function MoveObservation({ token, entry, onObserve }: {
  token: string; entry: PendingMoves<TicketSummary>[string];
  onObserve: (operationId: string, row: TicketSummary | null) => void;
}) {
  const row = useQuery(api.tickets.getTicket, { token, id: entry.ticket._id });
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
