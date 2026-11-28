import { localizeError, useI18n } from "@/lib/i18n";
import { toast } from "sonner";
import { useTicketAdapter } from "./adapter";
import { ticketOperations } from "./operations";

type Translate = ReturnType<typeof useI18n>["t"];

/** Success notices with an Undo bound to the exact change that produced them. */
export function operationNotices(t: Translate): Parameters<typeof ticketOperations>[1] {
  return {
    success: (message, reference, undo) => toast.success(`${reference} · ${t(message)}`, undo ? {
      action: { label: t("undo"), onClick: () => { void undo().catch(error => toast.error(`${reference} · ${localizeError(error, t)}`)); } },
    } : undefined),
  };
}

export function useTicketOperations() {
  const adapter = useTicketAdapter();
  const { t } = useI18n();
  return ticketOperations(adapter, operationNotices(t));
}
