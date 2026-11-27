import { MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import type { TicketSummary } from "../../shared/ticket-contracts";

export function TicketCustomerReply({ item }: {
  item: Pick<TicketSummary, "latestReply" | "lifecycle" | "status">;
}) {
  const { t } = useI18n();
  if (item.lifecycle !== "active" || item.status === "done" || item.latestReply?.role !== "customer") return null;
  return <Badge variant="outline" className="gap-1 border-primary/25 bg-primary/5">
    <MessageCircle className="size-3" aria-hidden />{t("threadCustomerReplied")}
  </Badge>;
}
