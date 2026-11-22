import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Ticket } from "@/lib/types";
import { errorCode } from "../../../shared/errors";
import { MAX_URGENCY_SCORE, MIN_URGENCY_SCORE } from "../../../shared/ticket-state";
import type { useTicketOperations } from "./use-ticket-operations";

export function DetailEdit({ item, mode, staff, operations, onClose }: {
  item: Ticket;
  mode: "content" | "urgency";
  staff: boolean;
  operations: ReturnType<typeof useTicketOperations>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const titleId = staff ? "edit-ticket-title" : "customer-edit-title";
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [urgency, setUrgency] = useState(item.urgencyScore?.toString() ?? "");
  const [version, setVersion] = useState(item.version);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (busy || conflict) return;
    setError("");
    const score = urgency.trim() === "" ? undefined : Number(urgency);
    if (mode === "urgency" && score !== undefined && (!Number.isInteger(score) || score < MIN_URGENCY_SCORE || score > MAX_URGENCY_SCORE)) {
      setError(t("invalidUrgencyScore"));
      return;
    }
    setBusy(true);
    try {
      const target = { _id: item._id, version };
      if (mode === "content") await operations.edit(target, title, description);
      else await operations.urgency(target, score);
      onClose();
    } catch (err) {
      setError(localizeError(err, t));
      setConflict(errorCode(err) === "VERSION_CONFLICT");
    } finally { setBusy(false); }
  }

  function review(useLatest: boolean) {
    if (useLatest) {
      setTitle(item.title);
      setDescription(item.description);
      setUrgency(item.urgencyScore?.toString() ?? "");
    }
    setVersion(item.version);
    setConflict(false);
    setError("");
  }

  return <form onKeyDown={event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
  }} className="space-y-3 rounded-lg border bg-muted/20 p-3" onSubmit={event => { event.preventDefault(); void save(); }}>
    {mode === "content" ? <>
      <label className="block space-y-1.5 text-sm font-medium" htmlFor={titleId}><span>{t("topic")}</span>
        <Input id={titleId} autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium" htmlFor={id}><span>{t("description")}</span>
        <Textarea id={id} rows={4} maxLength={10000} value={description} onChange={event => setDescription(event.target.value)} />
      </label>
    </> : <>
      <label htmlFor={id} className="block text-sm font-medium">{t("urgencyScore")}</label>
      <Input id={id} autoFocus type="number" min={MIN_URGENCY_SCORE} max={MAX_URGENCY_SCORE} step={1} value={urgency}
        aria-describedby={`${id}-hint`} onChange={event => setUrgency(event.target.value)} />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">{t("urgencyScoreHint")}</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {conflict && <div className="space-y-2 rounded-md border p-3 text-sm">
      <p>{t("detailRetryHint")}</p><h4 className="font-semibold">{t("detailCurrent")}</h4>
      {mode === "content" ? <><p className="break-words font-medium">{item.title}</p><p className="whitespace-pre-wrap break-words">{item.description || t("noDescription")}</p></>
        : <p>{item.urgencyScore ?? t("urgencyUnscored")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={version === item.version} onClick={() => review(true)}>{t("detailUseLatest")}</Button>
        <Button type="button" variant="outline" disabled={version === item.version} onClick={() => review(false)}>{t("detailKeepDraft")}</Button>
      </div>
    </div>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
      <Button disabled={busy || conflict || (mode === "content" && !title.trim())}>{t(mode === "content" ? "save" : "saveUrgency")}</Button>
    </div>
  </form>;
}
