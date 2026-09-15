import { useState } from "react";
import { ArchiveRestore, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TicketTagList } from "@/components/ticket-tags";
import { formatTicketNumber } from "@/lib/feedback-ui";
import { useI18n, localizeError } from "@/lib/i18n";
import { isActiveAnnotation, isVideoMedia, type Feedback } from "@/lib/types";

/** Archived Tickets are inspectable, but must be restored before editing. */
export function ArchivedTicketDialog({ item, onClose, onRestore }: {
  item: Feedback; onClose: () => void; onRestore: () => Promise<void>;
}) {
  const { t, formatDate } = useI18n(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <Dialog open onOpenChange={(open) => {if (!open && !busy) onClose();}} title={`${formatTicketNumber(item.ticketNumber)} · ${item.title}`}>
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("archivedOn", {date:formatDate(item.deletedAt ?? item.updatedAt)})}</p>
      <TicketTagList tags={item.tags ?? []} />
      <p className="whitespace-pre-wrap break-words text-sm">{item.description || t("noDescription")}</p>
      {item.media.map((media) => isVideoMedia(media)
        ? <video key={media.key} src={media.url} controls className="max-h-96 w-full rounded-md" aria-label={media.name} />
        : <img key={media.key} src={media.url} alt={media.name} className="max-h-96 w-full rounded-md object-contain" />)}
      {(item.annotations ?? []).filter(isActiveAnnotation).map((note) => <p key={note.id} className="whitespace-pre-wrap break-words text-sm"><span className="font-semibold">[{note.label}]</span> {note.text}</p>)}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={busy} onClick={async () => {setBusy(true);setError("");try {await onRestore();onClose();} catch (error) {setError(localizeError(error,t));} finally {setBusy(false);}}}>{busy ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}{t("restore")}</Button>
    </div>
  </Dialog>;
}
