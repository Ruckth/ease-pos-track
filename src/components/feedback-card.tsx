import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Images, MapPin } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { statusMeta } from "@/components/feedback-status";
import { cn } from "@/lib/utils";
import { feedbackProgress, formatTicketNumber, nextFeedbackStatus } from "@/lib/feedback-ui";
import { isActiveAnnotation, isVideoMedia, type Feedback, type FeedbackStatus } from "@/lib/types";
import { TicketTagList } from "@/components/ticket-tags";
import { useI18n } from "@/lib/i18n";

/** Compact Ticket summary with an independent attachment popup and status action. */
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
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaIndex, setMediaIndex] = useState(0);
  const selectedMedia = item.media[mediaIndex] ?? item.media[0];
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
        <div className={cn("flex items-center justify-between gap-3 px-3 pt-3", handle && "pr-10")}>
          <span className="font-mono text-sm font-semibold leading-5">{ticketLabel}</span>
          <span className="truncate text-xs leading-5 text-muted-foreground">{formatDate(item.createdAt)}</span>
        </div>
        <div className="space-y-2 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
          {item.description ? <p className="truncate text-sm leading-5 text-muted-foreground">{item.description}</p> : null}
          <TicketTagList tags={item.tags ?? []} />
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
                aria-label={t("viewTicketMedia", { ticket: ticketLabel, count: mediaCount })}
                aria-haspopup="dialog"
                onClick={() => {
                  setMediaIndex(0);
                  setMediaOpen(true);
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
      <Dialog
        open={mediaOpen}
        onOpenChange={setMediaOpen}
        title={ticketLabel}
        description={t("reviewMedia", { count: mediaCount })}
      >
        {mediaOpen && selectedMedia ? (
          <div className="space-y-3">
            <div className="flex h-[55dvh] items-center justify-center overflow-hidden rounded-lg bg-black">
              {isVideoMedia(selectedMedia) ? (
                <video key={selectedMedia.key} src={selectedMedia.url} controls playsInline preload="metadata" className="max-h-full max-w-full" />
              ) : (
                <img src={selectedMedia.url} alt={selectedMedia.name} className="h-full w-full object-contain" />
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Button type="button" variant="outline" size="icon" aria-label={t("previousSlide")} disabled={mediaIndex === 0} onClick={() => setMediaIndex((index) => index - 1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-0 text-center text-sm" aria-live="polite">
                <span className="block truncate">{selectedMedia.name}</span>
                <span className="text-muted-foreground">{Math.min(mediaIndex + 1, mediaCount)} / {mediaCount}</span>
              </span>
              <Button type="button" variant="outline" size="icon" aria-label={t("nextSlide")} disabled={mediaIndex >= mediaCount - 1} onClick={() => setMediaIndex((index) => index + 1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </article>
  );
}
