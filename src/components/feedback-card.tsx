import type { ReactNode } from "react";
import { ChevronRight, Images, MapPin, PlayCircle } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { statusMeta } from "@/components/feedback-status";
import { cn } from "@/lib/utils";
import { formatTicketNumber, nextFeedbackStatus } from "@/lib/feedback-ui";
import { isActiveAnnotation, isVideoMedia, type Feedback, type FeedbackStatus } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

/**
 * A ticket tile: cover media, ticket number, media and pin counts, and the
 * status button that advances the workflow without dragging.
 *
 * `handle` receives the board's drag grip so the card body stays clickable.
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
  const extraCount = item.media.length - 1;
  const pinCount = item.annotations?.filter(isActiveAnnotation).length ?? 0;
  const ticketLabel = formatTicketNumber(item.ticketNumber);
  const nextStatus = nextFeedbackStatus(item.status);
  const currentStatus = statusMeta(item.status);
  const nextStatusLabel = nextStatus ? t(statusMeta(nextStatus).labelKey) : null;

  return (
    <article className="rounded-md border bg-background shadow-sm">
      <div className="relative">
        <button className="block w-full text-left" onClick={() => onSelect(item._id)}>
          <div className="relative overflow-hidden rounded-t-md bg-black">
            {cover ? (
              isVideoMedia(cover) ? (
                <>
                  <video className="aspect-video w-full object-cover opacity-80" src={cover.url} muted playsInline preload="metadata" />
                  <PlayCircle className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 text-white" />
                </>
              ) : (
                <img className="aspect-video w-full object-cover" src={cover.url} alt="" loading="lazy" />
              )
            ) : (
              <div className="grid aspect-video w-full place-items-center text-sm text-muted-foreground">{t("noMedia")}</div>
            )}
            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/80 px-2 py-1 font-mono text-sm font-semibold leading-5 text-white shadow-sm">
              {ticketLabel}
            </span>
            {extraCount > 0 ? (
              <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                <Images className="size-3" />
                +{extraCount}
              </span>
            ) : null}
            {pinCount > 0 ? (
              <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
                <MapPin className="size-3" />
                {pinCount}
              </span>
            ) : null}
          </div>
          <div className="space-y-2 p-3">
            <h3 className="line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
            {item.description ? <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">{item.description}</p> : null}
            <p className="text-sm leading-5 text-muted-foreground">{formatDate(item.createdAt)}</p>
          </div>
        </button>
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
