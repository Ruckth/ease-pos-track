import { useState, useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@/components/ui/alert-dialog";

import type { DisposableTicketDraft } from "./draft";

export function DiscardTicketDraft({ busy, owner, onDiscard, startCurrent = false }: {
  busy: boolean; owner: DisposableTicketDraft; onDiscard: () => void; startCurrent?: boolean;
}) {
  const { t, language } = useI18n();
  const draft = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const fields = Number(Boolean(draft.title)) + Number(Boolean(draft.description)) + Number(Boolean(draft.routingClassification));
  const summary = language === "th"
    ? `ข้อมูล ${fields} ช่อง ไฟล์ ${draft.items.length} ไฟล์ และหมายเหตุ ${draft.annotations.length} รายการจะถูกลบ`
    : `${fields} filled fields, ${draft.items.length} attachments, and ${draft.annotations.length} notes will be removed.`;
  const action = startCurrent
    ? (language === "th" ? "เริ่ม Ticket ในโครงการปัจจุบัน" : "Start Ticket in current Project")
    : t("discardDraft");
  const [confirming, setConfirming] = useState(false);
  return <>
    <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => setConfirming(true)}>
      {action}
    </Button>
    <AlertDialog open={confirming} onOpenChange={setConfirming} title={startCurrent ? action : t("discardDraft")}
      description={`${t("draftDiscardDescription")} ${summary}`}
      confirmLabel={startCurrent ? action : t("discardDraft")} onConfirm={onDiscard} />
  </>;
}
