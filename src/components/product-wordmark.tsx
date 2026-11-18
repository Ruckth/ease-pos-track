import { TicketCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function ProductWordmark() {
  const { t } = useI18n();
  return (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold tracking-tight">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
        <TicketCheck className="size-5" aria-hidden="true" />
      </span>
      {t("appName")}
    </span>
  );
}
