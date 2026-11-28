import { ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { statuses, statusMeta } from "@/components/ticket-status";
import { staffTicketActions } from "@/lib/staff-ticket-queue";
import { useStaffCopy } from "@/lib/staff-copy";
import { useI18n } from "@/lib/i18n";
import type { TicketStatus } from "@/lib/types";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import type { TicketSummary } from "../../shared/ticket-contracts";

/**
 * The named next move plus Move to for every other status. Both share the caller's versioned move and Undo.
 * Phones show only the verb; the destination stays in the accessible name and the row's status line.
 */
export function TicketRowAction({ item, busy, onMove, onRestore }: {
  item: TicketSummary;
  busy?: boolean;
  onMove?: (id: TicketSummary["_id"], status: TicketStatus) => void;
  onRestore?: (id: TicketSummary["_id"]) => void;
}) {
  const { t } = useI18n();
  const s = useStaffCopy();
  const archived = item.lifecycle === "archived";
  if (archived ? !onRestore : !onMove) return null;
  const reference = formatTicketNumber(item.ticketNumber, item.projectKey);
  const pending = busy ? <span role="status" className="text-xs font-medium text-muted-foreground">{archived ? s.restoring : s.saving}</span> : null;
  if (archived) {
    const label = t("restore");
    return <span className="ml-auto inline-flex items-center gap-2">
      {pending}
      <Button type="button" variant="outline" size="sm" className="min-h-11 px-2.5 text-xs md:h-8 md:min-h-8" disabled={busy}
        aria-label={`${label} · ${reference}`} onClick={() => onRestore?.(item._id)}>{label}</Button>
    </span>;
  }
  // Resolved has no advance: its status stays as neutral text and Move to offers every other state.
  const advance = item.status === "done" ? null : staffTicketActions[item.status];
  const label = advance ? t(advance.label) : "";
  const destination = advance ? t(statusMeta(advance.status).labelKey) : "";
  return <span className="ml-auto inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
    {pending}
    {!advance && <span className="text-xs text-muted-foreground">{t(statusMeta(item.status).labelKey)}</span>}
    <span className={advance ? "inline-grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto]" : "inline-flex"}>
      {advance && <Button type="button" variant="outline" size="sm" className="h-auto min-h-11 min-w-0 rounded-e-none whitespace-normal px-2 py-1.5 text-xs md:min-h-8" disabled={busy}
        aria-label={`${label} · ${reference} (${destination})`} onClick={() => onMove?.(item._id, advance.status)}>
        <span className="[overflow-wrap:anywhere]">{label}</span><ArrowRight aria-hidden className="size-3 shrink-0" /><span className="font-normal text-muted-foreground [overflow-wrap:anywhere] max-sm:hidden">{destination}</span>
      </Button>}
      <DropdownMenu>
        <DropdownMenuTrigger disabled={busy} render={<Button type="button" variant="outline" size={advance ? "icon" : "sm"} className={advance
          ? "-ms-px h-auto min-h-11 min-w-11 self-stretch rounded-s-none md:min-h-8 md:min-w-8" : "min-h-11 gap-1 px-2.5 text-xs md:h-8 md:min-h-8"} />}
          aria-label={s.moveToLabel(reference)} title={s.moveTo}>
          {!advance && s.moveTo}<ChevronDown aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuRadioGroup value={item.status} onValueChange={value => {
            const next = statuses.find(option => option.value === value);
            if (next && next.value !== item.status && !busy) onMove?.(item._id, next.value);
          }}>
            <DropdownMenuLabel>{s.moveTo}</DropdownMenuLabel>
            {statuses.map(option => {
              const Icon = option.icon;
              const current = option.value === item.status;
              return <DropdownMenuRadioItem key={option.value} value={option.value} disabled={current} closeOnClick>
                <Icon aria-hidden className={option.text} />{t(option.labelKey)}{current && <span className="ms-auto text-xs text-muted-foreground">({s.current})</span>}
              </DropdownMenuRadioItem>;
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  </span>;
}
