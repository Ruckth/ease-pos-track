import { Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";
import { urgencyBand, urgencyTone } from "@/lib/urgency-score";

type UrgencyBand = ReturnType<typeof urgencyBand>;

const urgencyText: Record<UrgencyBand, string> = {
  unscored: "text-muted-foreground",
  low: "text-emerald-700 dark:text-emerald-300",
  medium: "text-amber-700 dark:text-amber-300",
  high: "text-orange-700 dark:text-orange-300",
  critical: "text-red-700 dark:text-red-300",
};

/** `plain` renders the band as coloured text for compact Ticket surfaces. */
export function TicketUrgency({ score, plain = false }: { score?: number; plain?: boolean }) {
  const { t } = useI18n();
  const copy = useExplorerCopy();
  if (score === undefined) return <span className="text-xs text-muted-foreground">{t("urgencyUnscoredShort")}</span>;
  const band = urgencyBand(score);
  const content = <><span className="sr-only">{copy.urgency} · </span>{copy.bands[band]} · {score}</>;
  if (plain) return <span className={`ticket-chip whitespace-nowrap text-xs font-medium tabular-nums ${urgencyText[band]}`}><Flag className="size-3" aria-hidden />{content}</span>;
  return <Badge variant="outline" className={`whitespace-nowrap tabular-nums ${urgencyTone[band]}`}>{content}</Badge>;
}
