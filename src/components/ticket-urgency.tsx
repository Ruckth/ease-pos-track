import { Badge } from "@/components/ui/badge";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useI18n } from "@/lib/i18n";
import { urgencyBand, urgencyTone } from "@/lib/urgency-score";

export function TicketUrgency({ score }: { score?: number }) {
  const { t } = useI18n();
  const copy = useExplorerCopy();
  if (score === undefined) return <span className="text-xs text-muted-foreground">{t("urgencyUnscoredShort")}</span>;
  const band = urgencyBand(score);
  return <Badge variant="outline" className={`whitespace-nowrap tabular-nums ${urgencyTone[band]}`}>
    <span className="sr-only">{copy.urgency} · </span>{copy.bands[band]} · {score}
  </Badge>;
}
