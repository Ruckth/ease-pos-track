import { TicketCreatedDate } from "@/components/ticket-created-date";
import { TicketStatusDot } from "@/components/ticket-status-dot";
import { statusMeta } from "@/components/ticket-status";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { Images, MapPin } from "lucide-react";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { formatTicketNumber } from "../../../shared/ticket-numbers";

/**
 * One customer Ticket in the queue. Below 640 px the row shows a single shaped
 * status mark beside the title and omits the excerpt and written status; the
 * translated status stays in the accessible name and the open detail.
 */
export function CustomerTicketRow({ item, selected, onSelect }: { item: TicketSummary; selected: boolean; onSelect: (id: Id<"tickets">) => void }) {
  const { t } = useI18n();
  const meta = statusMeta(item.status);
  const StatusIcon = meta.icon;
  const label = formatTicketNumber(item.ticketNumber, item.projectKey);
  const status = item.status === "waiting" ? t("customerQueueWaiting") : t(meta.labelKey);
  return <button type="button" data-ticket-id={item._id}
    className={cn(
      "ticket-surface flex min-h-16 w-full flex-col gap-1.5 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-20 sm:gap-2",
      selected && "ticket-surface-selected",
    )}
    aria-label={[t("viewTicket", { ticket: label }), item.title, status].join(", ")} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item._id)}>
    <span className="hidden flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground sm:flex">
      <span data-status-label className={cn("ticket-chip font-medium", meta.text)}>
        <StatusIcon className="size-3.5" aria-hidden />
        {status}
      </span>
      <span className="ml-auto font-mono">{label}</span>
    </span>
    <span className="flex min-w-0 items-start gap-2.5">
      <TicketStatusDot status={item.status} className="mt-[0.4rem] sm:hidden" />
      <span className="min-w-0 break-words text-base font-semibold leading-snug text-foreground">{item.title}</span>
    </span>
    {item.excerpt ? <span data-ticket-excerpt className="hidden text-sm text-muted-foreground sm:line-clamp-1">{item.excerpt}</span> : null}
    <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 pl-[1.375rem] text-xs text-muted-foreground sm:mt-1 sm:pl-0">
      <span className="font-mono sm:hidden">{label}</span>
      <TicketCreatedDate timestamp={item.createdAt} />
      {item.mediaCount ? <span className="inline-flex items-center gap-1"><Images className="size-3" aria-hidden="true" />{t("reviewMedia", { count: item.mediaCount })}</span> : null}
      {item.annotationCount ? <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden="true" />{t("reviewPins", { count: item.annotationCount })}</span> : null}
    </span>
  </button>;
}
