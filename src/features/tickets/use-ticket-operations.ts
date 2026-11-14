import { localizeError, useI18n } from "@/lib/i18n";
import { toast } from "sonner";
import { useTicketAdapter } from "./adapter";
import { ticketOperations } from "./operations";

export function useTicketOperations(token: string) {
  const adapter = useTicketAdapter();
  const { t } = useI18n();
  return ticketOperations(adapter, token, {
    success: (message, undo) => toast.success(t(message), undo ? {
      action: { label: t("undo"), onClick: () => { void undo().catch(error => toast.error(localizeError(error, t))); } },
    } : undefined),
  });
}
