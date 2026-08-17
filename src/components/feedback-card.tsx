import type { ReactNode } from "react";
import { ChevronRight, Images, MapPin, PlayCircle } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { statusMeta } from "@/components/feedback-status";
import { cn } from "@/lib/utils";
import { feedbackProgress, formatTicketNumber, nextFeedbackStatus } from "@/lib/feedback-ui";
import { isActiveAnnotation, isVideoMedia, type Feedback, type FeedbackStatus } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

/**
 * A ticket tile: cover media carrying the ticket number and creation time, the
 * title and a one-line description, the workflow progress bar, the media and pin
 * counts, and the status button that advances the workflow without dragging.
 *
 * The ticket number and time are laid over the bottom of the cover on a dark
 * scrim, so they read over any photo and over the empty-cover placeholder alike,
 * and the space below stays free for the title and description. The scrim never
 * takes pointer events, so it cannot swallow a click meant for the card.
 *
 * The card body is opened by a transparent button stretched over media and text
 * - it is the only tab stop for "open details", it carries the ticket number as
 * its accessible name, and it sits below the drag grip (`z-10`) and outside the
 * status footer, so neither control is covered by it.
 *
 * `handle` receives the board's drag grip.
 */
export function FeedbackCard({
  item,
  onSelect,
  onMove,
  handle,
}: {
  item: Feedback;
  onSelect: (id: Id<"feedback">) => void;
  onMove?: (id: Id<"feedback">, status: FeedbackStatus) => void;
  handle?: ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const cover = item.media[0];
  const mediaCount = item.media.length;
  const pinCount = item.annotations?.filter(isActiveAnnotation).length ?? 0;
  const ticketLabel = formatTicketNumber(item.ticketNumber);
  const nextStatus = nextFeedbackStatus(item.status);
  const currentStatus = statusMeta(item.status);
  const nextStatusLabel = nextStatus ? t(statusMeta(nextStatus).labelKey) : null;
  const progress = feedbackProgress(item.status);

  return (
    <article className="rounded-md border bg-background shadow-sm">
      <div className="relative">
        <div className="relative overflow-hidden rounded-t-md bg-black">
          {cover ? (
            isVideoMedia(cover) ? (
              <div className="relative">
                <video className="aspect-video w-full object-cover opacity-80" src={cover.url} muted playsInline preload="metadata" />
                <PlayCircle className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 text-white" aria-hidden="true" />
              </div>
            ) : (
              <img className="aspect-video w-full object-cover" src={cover.url} alt="" loading="lazy" />
            )
          ) : (
            <div className="grid aspect-video w-full place-items-center text-sm text-white/60">{t("noMedia")}</div>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-2 pt-8">
            <span className="font-mono text-sm font-semibold leading-5 text-white drop-shadow-sm">{ticketLabel}</span>
            <span className="truncate text-xs leading-5 text-white/85 drop-shadow-sm">{formatDate(item.createdAt)}</span>
          </div>
        </div>
        <div className="space-y-2 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
          {item.description ? <p className="truncate text-sm leading-5 text-muted-foreground">{item.description}</p> : null}
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
              <span className="ml-auto flex items-center gap-1" aria-label={t("reviewMedia", { count: mediaCount })}>
                <Images className="size-3.5" aria-hidden="true" />
                {mediaCount}
              </span>
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
      {onMove ? (
        <div className="flex items-center justify-end gap-2 border-t p-2">
          <Button
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
          </Button>
        </div>
      ) : null}
    </article>
  );
}
