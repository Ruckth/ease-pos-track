import { useState, type ReactNode } from "react";
import { ChevronDown, Inbox, Settings2 } from "lucide-react";
import { toast } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { statusMeta } from "@/components/ticket-status";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { useCustomerInbox, useStaffInbox } from "./adapters/inbox";

type Props = { projectId: Id<"projects">; projectKey: string; openTicket: (id: Id<"tickets">) => void };

export function TicketInbox(props: Props & { role: "customer" | "staff"; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const labelClass = props.role === "staff" ? "hidden lg:inline" : "hidden sm:inline";
  return <>
    <Button variant="outline" className={props.compact ? "min-h-11 min-w-11 px-3 sm:px-4" : "min-h-11"} aria-haspopup="dialog" title={props.compact ? t("ticketInbox") : undefined} aria-label={props.compact ? t("ticketInbox") : undefined} onClick={() => setOpen(true)}>
      <Inbox aria-hidden /><span className={props.compact ? labelClass : undefined}>{t("ticketInbox")}</span>
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
    <InboxList projectKey={projectKey} items={items} openTicket={openTicket} onClose={onClose}
      markRead={id => markRead({ id })} label={item => (item.restored ? t("inboxRestored") + " · " : "") + t(statusMeta(item.status).labelKey)} />
    <InboxSettings>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={enabled === true} disabled={enabled == null || saving}
          onChange={async event => {
            setSaving(true);
            try { await setPreference({ projectId, enabled: event.target.checked }); }
            catch (error) { toast.error(localizeError(error, t)); }
            finally { setSaving(false); }
          }} />{t("statusInboxPreference")}
      </label>
    </InboxSettings>
  </div>;
}

function StaffInboxItems({ projectId, projectKey, openTicket, onClose }: Props & { onClose: () => void }) {
  const { items, settings, setPreference, markRead } = useStaffInbox(projectId);
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  return <div className="grid gap-4">
    <InboxList projectKey={projectKey} items={items} openTicket={openTicket} onClose={onClose}
      markRead={id => markRead({ id })} label={item => t(item.category === "intake" ? "inboxNew" : "inboxAssigned")} />
    <InboxSettings>
      {(["intake", "assignment"] as const).map(category => <label key={category} className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" className="size-4 shrink-0 accent-primary" disabled={!settings || saving} checked={settings?.[category] ?? false}
          onChange={async event => {
            setSaving(true);
            try { await setPreference({ projectId, category, enabled: event.target.checked }); }
            catch (error) { toast.error(localizeError(error, t)); }
            finally { setSaving(false); }
          }} />{t(category === "intake" ? "inboxIntake" : "inboxAssignments")}
      </label>)}
    </InboxSettings>
  </div>;
}

function InboxSettings({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <details className="group rounded-lg border border-border/60">
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <Settings2 className="size-4 text-muted-foreground" aria-hidden />
      <span className="flex-1">{t("inboxSettings")}</span>
      <ChevronDown className="size-4 text-muted-foreground group-open:rotate-180" aria-hidden />
    </summary>
    <div className="border-t border-border/60 px-3 py-1">{children}</div>
  </details>;
}

type InboxRow = { id: string; title: string; ticketId: Id<"tickets">; number: number; read: boolean; date: number };
function InboxList<Row extends InboxRow>({ projectKey, items, openTicket, onClose, label, markRead }: {
  projectKey: string; items: { results: Row[]; status: string; loadMore: (numItems: number) => void };
  openTicket: Props["openTicket"]; onClose: () => void; label: (row: Row) => string;
  markRead: (id: Row["id"]) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  const canLoadMore = items.status === "CanLoadMore";
  const loadingMore = items.status === "LoadingMore";
  const empty = <p className="py-3 text-sm text-muted-foreground">{t("emptyInbox")}</p>;
  if (items.status === "LoadingFirstPage") return <section aria-label={t("inboxUpdates")}><p role="status" className="py-3 text-sm text-muted-foreground">{t("syncing")}</p></section>;
  if (!items.results.length && !canLoadMore && !loadingMore) return <section aria-label={t("inboxUpdates")}>{empty}</section>;

  return <section aria-label={t("inboxUpdates")} tabIndex={0} className="max-h-[min(28rem,50dvh)] overflow-auto overscroll-contain rounded-lg border border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {items.results.length ? <ul role="list" className="divide-y divide-border/60">{items.results.map(item => <li key={item.id}>
      <button className="grid w-full gap-1 px-3 py-3 text-start hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" type="button" onClick={async () => {
        try {
          if (!await markRead(item.id)) { toast.info(t("inboxUnavailable")); return; }
          onClose();
          openTicket(item.ticketId);
        } catch (error) { toast.error(localizeError(error, t)); }
      }}>
        <span className={item.read ? "font-medium [overflow-wrap:anywhere]" : "font-semibold [overflow-wrap:anywhere]"}>{formatTicketNumber(item.number, projectKey)} · {item.title}</span>
        <span className="text-sm">{label(item)}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {!item.read && <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><span className="size-1.5 rounded-full bg-primary" aria-hidden />{t("inboxUnread")}</span>}
          <time dateTime={new Date(item.date).toISOString()}>{new Date(item.date).toLocaleString(language)}</time>
        </span>
      </button>
    </li>)}</ul> : <div className="px-3">{empty}</div>}
    {(canLoadMore || loadingMore) && <div className="border-t border-border/60 p-3">
      <Button variant="outline" className="min-h-11" aria-disabled={loadingMore} onClick={() => {
        if (canLoadMore) items.loadMore(20);
      }}>{loadingMore ? t("syncing") : t("inboxMore")}</Button>
    </div>}
  </section>;
}
