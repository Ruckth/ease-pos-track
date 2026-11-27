import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import type { ProjectSummary } from "@/lib/types";
import { formatTicketNumber, parseTicketReference } from "../../../shared/ticket-numbers";
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "../../../shared/ticket-state";
import { useCaptureActions, useCaptureIntakes, useCaptureLinkTarget, useCaptureSettings, type CaptureIntake, type LineChat } from "./adapters/convex";
import { CaptureMedia } from "./capture-media";

type Mode = "create" | "link" | "dismiss";

function IntakeDecision({ intake, project, saved }: { intake: CaptureIntake; project: ProjectSummary; saved: (number?: string) => void }) {
  const { t } = useI18n();
  const { finish } = useCaptureActions();
  const [revision, setRevision] = useState(intake.revision);
  const [mode, setMode] = useState<Mode>(intake.canCreate ? "create" : "link");
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ref = parseTicketReference(reference);
  const target = useCaptureLinkTarget(project.key, mode === "link" && ref?.projectKey === project.key ? ref.ticketNumber : undefined);
  const changed = revision !== intake.revision;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || changed || (mode === "link" && !target) || (mode === "create" && !intake.canCreate)) return;
    setBusy(true);
    setError(false);
    try {
      const operation = mode === "create" ? { type: mode, title, description } as const
        : mode === "link" && target ? { type: mode, ticketId: target._id, expectedTicketVersion: target.version } as const
        : { type: "dismiss" } as const;
      const receipt = await finish({ intakeId: intake._id, expectedRevision: revision, operation });
      saved(receipt.number);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <form className="grid gap-3" onSubmit={submit}>
    <label className="grid gap-1 text-sm font-medium">{t("captureReview")}
      <select className="glass-field min-h-9 rounded-md px-2" value={mode} disabled={busy}
        onChange={e => { setMode(e.target.value as Mode); setError(false); }}>
        {intake.canCreate && <option value="create">{t("captureCreate")}</option>}
        <option value="link">{t("captureLink")}</option><option value="dismiss">{t("captureDismiss")}</option>
      </select>
    </label>
    {mode === "create" && <>
      <label className="grid gap-1 text-sm">{t("topic")}<Input required maxLength={MAX_TITLE_LENGTH}
        value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">{t("description")}<Textarea maxLength={MAX_DESCRIPTION_LENGTH}
        value={description} onChange={e => setDescription(e.target.value)} /></label>
    </>}
    {mode === "link" && <label className="grid gap-1 text-sm">{t("captureReference")}
      <Input placeholder={formatTicketNumber(1, project.key)} required autoComplete="off" value={reference} onChange={e => setReference(e.target.value)} />
      {target ? <span>{formatTicketNumber(target.ticketNumber, project.key)} · {target.title}</span> :
        reference && <span>{t("captureTargetMissing")}</span>}
    </label>}
    {changed && <div role="status"><p>{t("captureChanged")}</p>
      <Button type="button" variant="outline" onClick={() => setRevision(intake.revision)}>{t("captureReviewLatest")}</Button></div>}
    {error && <p role="alert" className="text-sm text-destructive">{t("captureFailed")}</p>}
    <Button className="justify-self-start" disabled={busy || changed || (mode === "link" && !target) || (mode === "create" && !title.trim())}>
      {t(mode === "create" ? "captureCreate" : mode === "link" ? "captureLink" : "captureDismissConfirm")}
    </Button>
  </form>;
}

function IntakeRow({ intake, project, saved }: { intake: CaptureIntake; project: ProjectSummary; saved: (number?: string) => void }) {
  const { t, formatDate } = useI18n();
  const { acknowledge } = useCaptureActions();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(() => Date.now() >= intake.expiresAt);
  useEffect(() => {
    const remaining = intake.expiresAt - Date.now();
    setExpired(remaining <= 0);
    // Source content expires after 24h. A redacted history row can live longer than a browser timer.
    if (remaining <= 0 || remaining > 0x7fffffff) return;
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [intake.expiresAt]);
  const sourceVisible = !expired && !intake.unsent;
  const actionable = ["captured", "review", "needs_details"].includes(intake.state) && sourceVisible;
  const label = { captured: "captureReceived", needs_details: "captureNeedsDetails", review: "captureReceived", linked: "captureLinked",
    dismissed: "captureDismissed", withdrawn: "captureWithdrawn", failed: "captureUnavailable" } as const;
  return <li className="grid min-w-0 gap-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{sourceVisible ? intake.chatName : ""}</strong>
      <span className="text-xs text-muted-foreground">{t(expired && !intake.receipts.length ? "captureExpired" : label[intake.state])} · {formatDate(intake.createdAt)}</span>
    </div>
    {sourceVisible && intake.text && <p className="whitespace-pre-wrap break-words text-sm">{intake.text}</p>}
    {intake.warning && <p className="text-sm" role="status">{t(intake.warning === "LINE_CAPTURE_CHAT_UNAVAILABLE" ? "captureUnavailable" : intake.warning === "LINE_CAPTURE_EXPIRED" ? "captureExpired" : "captureFileWarning")}</p>}
    {intake.conflict && <p className="text-sm">{t("captureConflict")}</p>}
    {open && sourceVisible && <CaptureMedia intakeId={intake._id} />}
    {intake.receipts.map(receipt => receipt.number && <p key={receipt.candidateKey} className="text-sm">{t("captureSavedTicket", { ticket: receipt.number })}</p>)}
    {sourceVisible && intake.correction && <div className="grid gap-2 rounded border p-2">
      <strong>{t("captureCorrection")}</strong><p className="whitespace-pre-wrap break-words">{intake.correction.text}</p>
      <Button variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError(false);
        try { await acknowledge({ intakeId: intake._id, expectedRevision: intake.revision }); }
        catch { setError(true); } finally { setBusy(false); }
      }}>{t("captureAcknowledged")}</Button>
      {error && <p role="alert">{t("captureFailed")}</p>}
    </div>}
    {(actionable || (sourceVisible && intake.state === "linked" && intake.chatName)) && <><Button className="justify-self-start" size="sm" variant="outline" aria-expanded={open}
      onClick={() => setOpen(!open)}>{t(open ? "cancel" : "captureReview")}</Button>
      {open && actionable && <IntakeDecision intake={intake} project={project} saved={saved} />}</>}
  </li>;
}

function CaptureQueue({ project }: { project: ProjectSummary }) {
  const { t } = useI18n();
  const [view, setView] = useState<"open" | "done">("open");
  const [receipt, setReceipt] = useState<string>();
  const rows = useCaptureIntakes(project._id, view);
  return <>
    <div className="flex flex-wrap gap-2">{(["open", "done"] as const).map(value =>
      <Button key={value} size="sm" variant={value === view ? "default" : "outline"} aria-pressed={value === view}
        onClick={() => setView(value)}>{t(value === "open" ? "capturePending" : "captureHistory")}</Button>)}</div>
    {receipt && <p role="status">{receipt}</p>}
    {!rows.results.length && rows.status !== "LoadingFirstPage" && <p className="text-sm">{t("captureEmpty")}</p>}
    <ul className="grid gap-2">{rows.results.map(item => <IntakeRow key={item._id} intake={item} project={project}
      saved={number => setReceipt(number ? t("captureSavedTicket", { ticket: number }) : t("captureRecorded"))} />)}</ul>
    {rows.status === "CanLoadMore" && <Button variant="outline" onClick={() => rows.loadMore(10)}>{t("captureMore")}</Button>}
  </>;
}

function CaptureSwitch({ enabled, change, label }: { enabled: boolean; change: () => Promise<unknown>; label: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <div>
    <label className="flex min-h-9 items-center gap-2 text-sm">
      <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={async () => {
        setBusy(true); setError(false);
        try { await change(); } catch { setError(true); } finally { setBusy(false); }
      }} />{label}
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{t("captureSwitchFailed")}</p>}
  </div>;
}

export function ChatCaptureSwitch({ chat, enabled }: { chat: LineChat; enabled: boolean }) {
  const { t } = useI18n();
  const { setChat } = useCaptureActions();
  return <CaptureSwitch enabled={enabled} label={t("captureGroupSwitch")}
    change={() => setChat({ chatId: chat._id, joinedAt: chat.joinedAt, enabled: !enabled })} />;
}

export function LineCapture({ project, owner }: { project: ProjectSummary; owner: boolean }) {
  const { t } = useI18n();
  const settings = useCaptureSettings(project._id);
  const { setProject } = useCaptureActions();
  if (!settings?.available || (!owner && !settings.projectEnabled)) return null;
  return <section className="grid gap-3 rounded-lg border p-4">
    <h3 className="font-semibold">{t("captureQueue")}</h3>
    {owner && <CaptureSwitch enabled={settings.projectEnabled} label={t("captureProjectSwitch")}
      change={() => setProject({ projectId: project._id, enabled: !settings.projectEnabled })} />}
    {settings.projectEnabled && <CaptureQueue project={project} />}
  </section>;
}
