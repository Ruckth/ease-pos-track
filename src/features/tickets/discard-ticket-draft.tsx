import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@/components/ui/alert-dialog";

export function DiscardTicketDraft({ busy, onDiscard }: { busy: boolean; onDiscard: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  return <>
    <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => setConfirming(true)}>
      {t("discardDraft")}
    </Button>
    <AlertDialog open={confirming} onOpenChange={setConfirming} title={t("discardDraft")}
      description={t("draftDiscardDescription")}
      confirmLabel={t("discardDraft")} onConfirm={onDiscard} />
  </>;
}
