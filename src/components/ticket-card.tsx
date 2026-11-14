import { type ReactNode } from "react";
import { ChevronRight, Gauge, Images, MapPin } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { statusMeta } from "@/components/ticket-status";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import { ticketProgress, nextTicketStatus } from "@/lib/ticket-ui";
import { urgencyBand, urgencyTone } from "@/lib/urgency-score";
import { type TicketStatus } from "@/lib/types";
import type { TicketSummary } from "../../shared/ticket-contracts";
import { useI18n } from "@/lib/i18n";

/** Compact Ticket summary with detail selection and a status action. */
export function TicketCard({
  item,
  onSelect,
  onMove,
  handle,
}: {
  item: TicketSummary;
  onSelect: (id: Id<"tickets">) => void;
  onMove?: (id: Id<"tickets">, status: TicketStatus) => void;
  handle?: ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const mediaCount = item.mediaCount;
  const pinCount = item.annotationCount;
  const ticketLabel = formatTicketNumber(item.ticketNumber, item.projectKey);
  const nextStatus = nextTicketStatus(item.status);
  const currentStatus = statusMeta(item.status);
  const nextStatusLabel = nextStatus ? t(statusMeta(nextStatus).labelKey) : null;
  const progress = ticketProgress(item.status);
  const urgency = urgencyBand(item.urgencyScore);

  return (
    <article className="rounded-md border bg-background shadow-sm">
      <div className="relative">
        <div className={cn("flex items-center justify-between gap-3 px-3 pt-3", handle && "pr-10")}>
          <span className="shrink-0 whitespace-nowrap font-mono text-sm font-semibold leading-5">{ticketLabel}</span>
          <span className="truncate text-xs leading-5 text-muted-foreground">{formatDate(item.createdAt)}</span>
        </div>
        <div className="space-y-2 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
          {item.excerpt ? <p className="truncate text-sm leading-5 text-muted-foreground">{item.excerpt}</p> : null}
          {/* The bar is labelled with the whole sentence, so the percent and step
              beside it are decoration a screen reader would only repeat. */}
          <Progress
            value={progress.percent}
            className="h-1.5"
            aria-label={t("ticketProgress", {
              ticket: ticketLabel,
              step: progress.step,
              total: progress.total,
              percent: progress.percent,
            })}
          />
          <div className="flex items-center gap-3 text-xs leading-4 text-muted-foreground">
            <span className="flex items-center gap-2" aria-hidden="true">
              <span className="font-semibold tabular-nums text-foreground">{progress.percent}%</span>
              <span className="tabular-nums">{t("ticketStep", { step: progress.step, total: progress.total })}</span>
            </span>
            {mediaCount > 0 ? (
              <button
                type="button"
                className="relative z-10 ml-auto flex min-h-9 min-w-9 items-center justify-center gap-1 rounded-md px-2 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("viewTicket", { ticket: ticketLabel })}
                onClick={() => {
                  onSelect(item._id);
                }}
              >
                <Images className="size-3.5" aria-hidden="true" />
                {mediaCount}
              </button>
            ) : null}
            {pinCount > 0 ? (
              <span className={cn("flex items-center gap-1", mediaCount > 0 ? null : "ml-auto")} aria-label={t("reviewPins", { count: pinCount })}>
                <MapPin className="size-3.5" aria-hidden="true" />
                {pinCount}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className={cn(
            "absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            onMove ? "rounded-t-md" : "rounded-md",
          )}
          aria-label={t("viewTicket", { ticket: ticketLabel })}
          onClick={() => onSelect(item._id)}
        />
        {handle ? <div className="absolute right-1.5 top-1.5 z-10">{handle}</div> : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t p-2">
          <Badge
            variant="outline"
            className={cn("gap-1 whitespace-nowrap rounded-full px-2.5 py-1 font-semibold tabular-nums", urgencyTone[urgency])}
            aria-label={item.urgencyScore === undefined
              ? t("urgencyUnscored")
              : t("urgencyScoreValue", { score: item.urgencyScore })}
          >
            <Gauge className="size-3.5" aria-hidden="true" />
            {item.urgencyScore === undefined
              ? t("urgencyUnscoredShort")
              : t("urgencyScoreShort", { score: item.urgencyScore })}
          </Badge>
          {onMove ? <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!nextStatus}
            onClick={() => {
              if (nextStatus) onMove(item._id, nextStatus);
            }}
            aria-label={nextStatusLabel ? t("movedTo", { ticket: ticketLabel, status: nextStatusLabel }) : t("ticketComplete", { ticket: ticketLabel })}
            title={nextStatusLabel ? t("movedTo", { ticket: ticketLabel, status: nextStatusLabel }) : t("ticketCompleteTitle")}
            className={cn("h-9 rounded-full px-3 text-sm disabled:opacity-100", currentStatus.tone)}
          >
            {t(currentStatus.labelKey)}
            {nextStatus ? <ChevronRight className="size-3" /> : null}
          </Button> : null}
      </div>
    </article>
  );
}
