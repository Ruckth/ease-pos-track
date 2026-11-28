import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { statusMeta } from "@/components/ticket-status";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Ticket } from "@/lib/types";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { archiveFailureDisposition, archiveReadDisposition } from "./customer-archive-recovery";
import { useCustomerArchiveAdapter } from "./adapter";
import { TicketDetailPanel, type DetailNavigation } from "./ticket-detail-panel";

export function CustomerTicketDialog(props: DetailNavigation & {
  ticket: Ticket | null | undefined;
  ticketId: string | null;
}) {
  const [target, setTarget] = useState<Ticket>();
  const navigation = useRef(props);
  navigation.current = props;
  const unresolved = useRef(new Map<Ticket["_id"], number>());
  useEffect(() => {
    setTarget(current => current?._id === props.ticketId ? current : undefined);
  }, [props.ticketId]);
  return <>
    <TicketDetailPanel {...props} role="customer" onArchiveRequest={setTarget} />
    {target && props.ticketId === target._id && <CustomerArchive key={target._id} ticket={target}
      unresolvedVersion={unresolved.current.get(target._id)} onUncertain={version => {
        if (version === undefined) unresolved.current.delete(target._id);
        else unresolved.current.set(target._id, version);
      }} onCancel={() => setTarget(undefined)} onArchived={() => {
      setTarget(undefined);
      if (navigation.current.ticketId === target._id) navigation.current.onClose();
    }} />}
  </>;
}

type ArchivePrompt =
  | { state: "ready"; version: number; title: string; status: Ticket["status"]; updatedAt: number; reviewed?: "retry" | "review"; error?: string }
  | { state: "unknown" | "conflict" | "unavailable" | "archived"; version: number };

function CustomerArchive({ ticket, unresolvedVersion, onUncertain, onCancel, onArchived }: {
  ticket: Ticket; unresolvedVersion?: number; onUncertain: (version: number | undefined) => void;
  onCancel: () => void; onArchived: () => void;
}) {
  const { language, t, formatDate } = useI18n();
  const { archive, read } = useCustomerArchiveAdapter();
  const [prompt, setPrompt] = useState<ArchivePrompt>(unresolvedVersion === undefined ? {
    state: "ready", version: ticket.version, title: ticket.title, status: ticket.status, updatedAt: ticket.updatedAt,
  } : { state: "unknown", version: unresolvedVersion });
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const translate = (en: string, th: string) => language === "th" ? th : en;
  const action = translate("Archive Ticket", "เก็บ Ticket เข้าคลัง");
  const number = formatTicketNumber(ticket.ticketNumber, ticket.projectKey);

  function done() {
    onUncertain(undefined);
    toast.success(translate(
      `${number} was archived and removed from your list. Staff can restore it until permanent deletion starts.`,
      `เก็บ ${number} เข้าคลังและนำออกจากรายการแล้ว ทีมงานกู้คืนได้จนกว่าจะเริ่มลบถาวร`,
    ));
    onArchived();
  }

  async function refresh(state: "unknown" | "conflict", version: number) {
    try {
      const latest = await read(ticket._id, ticket.projectId);
      const outcome = archiveReadDisposition(latest, version);
      if (outcome === "archived" && latest) {
        onUncertain(undefined);
        setPrompt({ state: "archived", version: latest.version });
      } else if ((outcome === "review" || outcome === "retry") && latest?.lifecycle === "active") {
        onUncertain(undefined);
        setPrompt({ state: "ready", version: latest.version, title: latest.title, status: latest.status, updatedAt: latest.updatedAt, reviewed: outcome });
      } else {
        setPrompt({ state, version });
      }
    } catch {
      setPrompt({ state, version });
    }
  }

  async function confirm() {
    if (working.current || prompt.state === "unavailable") return;
    if (prompt.state === "archived") {
      working.current = true;
      onArchived();
      return;
    }
    working.current = true;
    setBusy(true);
    try {
      if (prompt.state !== "ready") {
        await refresh(prompt.state, prompt.version);
        return;
      }
      await archive({ id: ticket._id, expectedVersion: prompt.version });
      done();
    } catch (error) {
      const disposition = archiveFailureDisposition(error);
      if (disposition === "conflict") await refresh("conflict", prompt.version);
      else if (disposition === "unavailable") {
        setPrompt({ state: "unavailable", version: prompt.version });
      } else if (disposition === "rejected" && prompt.state === "ready") {
        setPrompt({ ...prompt, error: localizeError(error, t) });
      } else {
        onUncertain(prompt.version);
        await refresh("unknown", prompt.version);
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const checkAgain = prompt.state === "unknown" || prompt.state === "conflict";
  return <AlertDialog open onOpenChange={open => { if (!open) onCancel(); }} title={action}
    description={translate(
      "This Ticket will leave your active list. Staff can restore it until permanent deletion starts. It becomes eligible for permanent deletion after 30 days.",
      "Ticket จะออกจากรายการที่ใช้งานอยู่ ทีมงานกู้คืนได้จนกว่าจะเริ่มลบถาวร โดยจะเริ่มมีสิทธิ์ถูกลบถาวรเมื่อครบ 30 วัน",
    )}
    confirmLabel={busy ? (checkAgain ? t("syncing") : translate("Archiving…", "กำลังเก็บเข้าคลัง…"))
      : prompt.state === "archived" ? t("detailBack") : checkAgain ? translate("Check again", "ตรวจสอบอีกครั้ง") : action}
    keepOpen busy={busy} confirmDisabled={prompt.state === "unavailable"} onConfirm={() => { void confirm(); }}>
    {prompt.state === "ready" && prompt.reviewed && <div className="mt-3 space-y-1 text-sm">
      <p>{prompt.reviewed === "retry" ? translate("This Ticket is still active. Confirm to try archiving it again.", "Ticket นี้ยังใช้งานอยู่ ยืนยันเพื่อลองเก็บเข้าคลังอีกครั้ง") : translate("This Ticket changed. Review the latest details before confirming.", "Ticket นี้มีการเปลี่ยนแปลง โปรดตรวจสอบรายละเอียดล่าสุดก่อนยืนยัน")}</p>
      <p className="break-words font-medium">{number} · {prompt.title}</p>
      <p>{t(statusMeta(prompt.status).labelKey)} · {t("updatedOn", { date: formatDate(prompt.updatedAt) })}</p>
    </div>}
    {prompt.state === "ready" && prompt.error && <p role="alert" className="mt-3 text-sm text-destructive">{prompt.error}</p>}
    {prompt.state === "archived" && <p role="status" className="mt-3 text-sm">{translate(
      "This Ticket is currently archived and has left your active list.",
      "ขณะนี้ Ticket อยู่ในคลังและไม่อยู่ในรายการที่ใช้งานแล้ว",
    )}</p>}
    {prompt.state === "unknown" && <p role="status" className="mt-3 text-sm">{translate(
      "The archive result is unconfirmed. Check the Ticket again before taking another action.",
      "ยังยืนยันผลการเก็บเข้าคลังไม่ได้ โปรดตรวจสอบ Ticket อีกครั้งก่อนดำเนินการต่อ",
    )}</p>}
    {prompt.state === "conflict" && <p role="status" className="mt-3 text-sm">{translate(
      "The Ticket changed. Check again to review its latest details.",
      "Ticket นี้มีการเปลี่ยนแปลง โปรดตรวจสอบอีกครั้งเพื่อดูรายละเอียดล่าสุด",
    )}</p>}
    {prompt.state === "unavailable" && <p role="alert" className="mt-3 text-sm">{t("ticketMissing")}</p>}
  </AlertDialog>;
}
