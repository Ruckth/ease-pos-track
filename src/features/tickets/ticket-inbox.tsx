import { useState } from "react";
import { Inbox } from "lucide-react";
import { toast } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { statusMeta } from "@/components/ticket-status";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { useCustomerInbox, useStaffInbox } from "./adapters/inbox";

type Props = { projectId: Id<"projects">; projectKey: string; openTicket: (id: Id<"tickets">) => void };

export function TicketInbox(props: Props & { role: "customer" | "staff"; /** Icon-only below 640 px; the name stays in aria-label. */ compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return <>
    <Button variant="outline" className={props.compact ? "min-h-11 min-w-11 px-3 sm:px-4" : "min-h-11"} aria-haspopup="dialog" aria-label={props.compact ? t("ticketInbox") : undefined} onClick={() => setOpen(true)}>
      <Inbox aria-hidden /><span className={props.compact ? "hidden sm:inline" : undefined}>{t("ticketInbox")}</span>
    </Button>
    <Dialog open={open} onOpenChange={setOpen} title={t("ticketInbox")} description={props.projectKey}>
      {open && (props.role === "staff"
        ? <StaffInboxItems {...props} onClose={() => setOpen(false)} />
        : <CustomerInboxItems {...props} onClose={() => setOpen(false)} />)}
    </Dialog>
  </>;
}

function CustomerInboxItems({ projectId, projectKey, openTicket, onClose }: Props & { onClose: () => void }) {
  const { items, enabled, setPreference, markRead } = useCustomerInbox(projectId);
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  return <div className="grid gap-4">
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" checked={enabled === true} disabled={enabled == null || saving}
        onChange={async event => {
          setSaving(true);
          try { await setPreference({ projectId, enabled: event.target.checked }); }
          catch (error) { toast.error(localizeError(error, t)); }
          finally { setSaving(false); }
        }} />{t("statusInboxPreference")}
    </label>
    <InboxList projectKey={projectKey} items={items} openTicket={openTicket} onClose={onClose}
      markRead={id => markRead({ id })} label={item => (item.restored ? t("inboxRestored") + " · " : "") + t(statusMeta(item.status).labelKey)} />
  </div>;
}

function StaffInboxItems({ projectId, projectKey, openTicket, onClose }: Props & { onClose: () => void }) {
  const { items, settings, setPreference, markRead } = useStaffInbox(projectId);
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  return <div className="grid gap-3">
    {(["intake", "assignment"] as const).map(category => <label key={category} className="flex min-h-11 items-center gap-2">
      <input type="checkbox" disabled={!settings || saving} checked={settings?.[category] ?? false}
        onChange={async e => {
          setSaving(true);
          try { await setPreference({ projectId, category, enabled: e.target.checked }); }
          catch (error) { toast.error(localizeError(error, t)); }
          finally { setSaving(false); }
        }} />{t(category === "intake" ? "inboxIntake" : "inboxAssignments")}
    </label>)}
    <InboxList projectKey={projectKey} items={items} openTicket={openTicket} onClose={onClose}
      markRead={id => markRead({ id })} label={item => t(item.category === "intake" ? "inboxNew" : "inboxAssigned")} />
  </div>;
}

type InboxRow = { id: string; title: string; ticketId: Id<"tickets">; number: number; read: boolean; date: number };
function InboxList<Row extends InboxRow>({ projectKey, items, openTicket, onClose, label, markRead }: {
  projectKey: string; items: { results: Row[]; status: string; loadMore: (numItems: number) => void };
  openTicket: Props["openTicket"]; onClose: () => void; label: (row: Row) => string;
  markRead: (id: Row["id"]) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  return <>
    {items.status === "LoadingFirstPage" ? <p role="status">{t("syncing")}</p> :
      items.results.length === 0 && <p>{t("emptyInbox")}</p>}
    <ul className="divide-y">{items.results.map(item => <li key={item.id}>
      <button className="grid w-full gap-1 py-3 text-start" type="button" onClick={async () => {
        try {
          if (!await markRead(item.id)) { toast.info(t("inboxUnavailable")); return; }
          onClose();
          openTicket(item.ticketId);
        } catch (error) { toast.error(localizeError(error, t)); }
      }}>
        <span className="break-words font-medium">{formatTicketNumber(item.number, projectKey)} · {item.title}</span>
        <span>{label(item)}</span>
        <small className="text-muted-foreground">{!item.read && t("inboxUnread") + " · "}{new Date(item.date).toLocaleString(language)}</small>
      </button>
    </li>)}</ul>
    {items.status === "CanLoadMore" && <Button variant="outline" className="min-h-11" onClick={() => items.loadMore(20)}>{t("inboxMore")}</Button>}
  </>;
}
