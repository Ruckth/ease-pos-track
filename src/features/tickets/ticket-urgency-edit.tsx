import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { localizeError, useI18n } from "@/lib/i18n";
import { useStaffCopy } from "@/lib/staff-copy";
import type { Ticket } from "@/lib/types";
import { parseUrgencyDraft, urgencyBand } from "@/lib/urgency-score";
import { errorCode } from "../../../shared/errors";
import type { useTicketOperations } from "./use-ticket-operations";

/** Staff urgency: live band preview; Save only for a valid change, including clearing a stored score. */
export function TicketUrgencyEdit({ item, operations, onClose }: {
  item: Ticket;
  operations: ReturnType<typeof useTicketOperations>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const c = useExplorerCopy();
  const s = useStaffCopy();
  const id = useId();
  const [value, setValue] = useState(item.urgencyScore?.toString() ?? "");
  const [version, setVersion] = useState(item.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const draft = parseUrgencyDraft(value);
  const changed = draft.valid && draft.score !== item.urgencyScore;
  const describedBy = [`${id}-hint`, `${id}-band`, error || !draft.valid ? `${id}-error` : ""].filter(Boolean).join(" ");

  async function save() {
    if (busy || !changed || !draft.valid) return;
    setBusy(true);
    setError("");
    try {
      await operations.urgency({ _id: item._id, version, ticketNumber: item.ticketNumber, projectKey: item.projectKey }, draft.score);
      onClose();
    } catch (err) {
      setError(localizeError(err, t));
      setConflict(errorCode(err) === "VERSION_CONFLICT");
    } finally { setBusy(false); }
  }

  return <form className="space-y-3 rounded-lg border border-transparent bg-muted/40 p-3" onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }}>
    <label htmlFor={id} className="block text-sm font-medium">{t("urgencyScore")}</label>
    <Input id={id} autoFocus inputMode="numeric" type="number" min={1} max={100} step={1} value={value}
      aria-invalid={!draft.valid || undefined} aria-describedby={describedBy} onChange={event => { setValue(event.target.value); setError(""); }} />
    <p id={`${id}-band`} aria-live="polite" className="text-sm font-medium">
      {s.urgencyBand(draft.valid ? c.bands[urgencyBand(draft.score)] : "—")}
    </p>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("urgencyScoreHint")} {s.urgencyRule}</p>
    {!draft.valid && <p id={`${id}-error`} className="text-sm text-destructive">{s.urgencyInvalid}</p>}
    {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
    {conflict && <div className="space-y-2 text-sm">
      <p>{t("detailRetryHint")}</p>
      <p>{t("detailCurrent")}: {item.urgencyScore ?? t("urgencyUnscored")}</p>
      <Button type="button" variant="outline" disabled={version === item.version} onClick={() => {
        setValue(item.urgencyScore?.toString() ?? ""); setVersion(item.version); setConflict(false); setError("");
      }}>{t("detailUseLatest")}</Button>
    </div>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
      <Button disabled={busy || conflict || !changed}>{t("saveUrgency")}</Button>
    </div>
  </form>;
}
