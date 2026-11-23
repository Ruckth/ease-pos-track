import { CalendarDays } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const shortDate = {
  en: new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }),
  th: new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }),
};

export function TicketCreatedDate({ timestamp }: { timestamp: number }) {
  const { t, language, formatDate } = useI18n();
  const label = t("createdAt", { date: formatDate(timestamp) });
  return <time className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" dateTime={new Date(timestamp).toISOString()} title={label}>
    <CalendarDays className="size-3.5 shrink-0" aria-hidden />
    <span className="sr-only">{label}</span><span aria-hidden>{shortDate[language].format(timestamp)}</span>
  </time>;
}
