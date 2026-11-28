import { useBlocker } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
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
  const { t, language } = useI18n();
  const id = useId();
  const titleId = staff ? "edit-ticket-title" : "customer-edit-title";
  const [base, setBase] = useState({ title: item.title, description: item.description });
  const [choices, setChoices] = useState<{ version: number; title?: "saved" | "draft"; description?: "saved" | "draft" }>();
  const working = useRef(false);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [urgency, setUrgency] = useState(item.urgencyScore?.toString() ?? "");
  const [version, setVersion] = useState(item.version);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = title !== base.title || description !== base.description;
  // Staff and customers share the dirty-edit guard on Close, Escape, backdrop, Cancel and navigation.
  const guarded = mode === "content";
  const discardPrompt = language === "th" ? "ละทิ้งการแก้ไข Ticket ที่ยังไม่ได้บันทึกหรือไม่?" : "Discard unsaved changes to this Ticket?";

  function canLeave() {
    return !working.current && (!dirty || window.confirm(discardPrompt));
  }

  useBlocker({
    disabled: !guarded,
    enableBeforeUnload: () => working.current || dirty,
    shouldBlockFn: ({ current, next }) => {
      const from = current.search as Record<string, unknown>;
      const to = next.search as Record<string, unknown>;
      return (current.pathname !== next.pathname || from.ticket !== to.ticket || from.project !== to.project) && !canLeave();
    },
  });

  function cancel() {
    if (guarded ? canLeave() : !working.current) onClose();
  }

  async function save() {
    if (working.current || conflict) return;
    setError("");
    const score = urgency.trim() === "" ? undefined : Number(urgency);
    if (mode === "urgency" && score !== undefined && (!Number.isInteger(score) || score < MIN_URGENCY_SCORE || score > MAX_URGENCY_SCORE)) {
      setError(t("invalidUrgencyScore"));
      return;
    }
    working.current = true;
    setBusy(true);
    try {
      const target = { _id: item._id, ticketNumber: item.ticketNumber, projectKey: item.projectKey, version };
      if (mode === "content") await operations.edit(target, title, description);
      else await operations.urgency(target, score);
      onClose();
    } catch (err) {
      setError(localizeError(err, t));
      setConflict(errorCode(err) === "VERSION_CONFLICT");
      setChoices(undefined);
    } finally { working.current = false; setBusy(false); }
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

  const fields = ([
    { name: "title", label: t("topic"), draft: title, saved: item.title },
    { name: "description", label: t("reviewDescription"), draft: description, saved: item.description },
  ] as const).filter(field => field.saved !== base[field.name] || field.draft !== base[field.name]);
  const selection = choices?.version === item.version ? choices : undefined;
  const copy = (en: string, th: string) => language === "th" ? th : en;
  const compareFields = !staff && mode === "content";

  function applyMerge() {
    if (item.version === version || !fields.every(field => selection?.[field.name])) return;
    if (selection?.title === "saved") setTitle(item.title);
    if (selection?.description === "saved") setDescription(item.description);
    setBase({ title: item.title, description: item.description });
    setVersion(item.version);
    setChoices(undefined);
    setConflict(false);
    setError("");
  }

  return <form onKeyDown={event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }} className="space-y-3 rounded-lg border border-transparent bg-muted/40 p-3" onSubmit={event => { event.preventDefault(); void save(); }}>
    {mode === "content" ? <>
      <label className="block space-y-1.5 text-sm font-medium" htmlFor={titleId}><span>{t("topic")}</span>
        <Input id={titleId} autoFocus required readOnly={busy || compareFields && conflict} maxLength={100} value={title} onChange={event => setTitle(event.target.value)}
          aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-error` : undefined} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium" htmlFor={id}><span>{t("description")}</span>
        <Textarea id={id} rows={4} readOnly={busy || compareFields && conflict} maxLength={10000} value={description} onChange={event => setDescription(event.target.value)}
          aria-describedby={error ? `${id}-error` : undefined} />
      </label>
    </> : <>
      <label htmlFor={id} className="block text-sm font-medium">{t("urgencyScore")}</label>
      <Input id={id} autoFocus readOnly={busy} type="number" min={MIN_URGENCY_SCORE} max={MAX_URGENCY_SCORE} step={1} value={urgency}
        aria-describedby={`${id}-hint`} onChange={event => setUrgency(event.target.value)} />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">{t("urgencyScoreHint")}</p>
    </>}
    {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
    {conflict && compareFields && <div className="space-y-3 rounded-md border border-transparent bg-muted/40 p-3 text-sm">
      <p>{copy("Compare the original, latest saved, and draft values. Choose what to keep for each field.", "เปรียบเทียบค่าเดิม ค่าที่บันทึกล่าสุด และฉบับร่าง แล้วเลือกค่าที่ต้องการเก็บในแต่ละช่อง")}</p>
      {item.version === version ? <p role="status">{t("syncing")}</p> : fields.map(field => <fieldset key={field.name} className="space-y-2">
        <legend className="font-semibold">{field.label}</legend>
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{copy("Original value", "ค่าเดิม")} · {base[field.name] || "—"}</p>
        <div className="grid grid-cols-2 gap-2">
          {([{ value: "saved", text: field.saved, label: copy("Latest saved", "ค่าที่บันทึกล่าสุด") },
            { value: "draft", text: field.draft, label: copy("My draft", "ฉบับร่างของฉัน") }] as const).map(option =>
            <label key={option.value} className="min-w-0 rounded-md border p-2">
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name={`${id}-${field.name}`} checked={selection?.[field.name] === option.value}
                  onChange={() => setChoices({ ...selection, version: item.version, [field.name]: option.value })} />{option.label}
              </span>
              <span className="mt-1 block whitespace-pre-wrap break-words">{option.text || "—"}</span>
            </label>)}
        </div>
      </fieldset>)}
      <Button type="button" variant="outline" disabled={item.version === version || !fields.every(field => selection?.[field.name])} onClick={applyMerge}>
        {copy("Apply choices", "ใช้ค่าที่เลือก")}
      </Button>
    </div>}
    {conflict && !compareFields && <div className="space-y-2 rounded-md border border-transparent bg-muted/40 p-3 text-sm">
      <p>{t("detailRetryHint")}</p><h4 className="font-semibold">{t("detailCurrent")}</h4>
      {mode === "content" ? <><p className="break-words font-medium">{item.title}</p><p className="whitespace-pre-wrap break-words">{item.description || t("noDescription")}</p></>
        : <p>{item.urgencyScore ?? t("urgencyUnscored")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={version === item.version} onClick={() => review(true)}>{t("detailUseLatest")}</Button>
        <Button type="button" variant="outline" disabled={version === item.version} onClick={() => review(false)}>{t("detailKeepDraft")}</Button>
      </div>
    </div>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>{t("cancel")}</Button>
      <Button disabled={busy || conflict || (mode === "content" && !title.trim())}>{t(mode === "content" ? "save" : "saveUrgency")}</Button>
    </div>
  </form>;
}
