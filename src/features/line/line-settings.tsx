import { useState, type FormEvent, type ReactNode } from "react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { useProjectMembers } from "@/app/adapter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProjectSummary } from "@/lib/types";
import { useLineActions, useLineAiSettings, useLineBots, useLineChats, type LineBot, type LineChat } from "./adapters/convex";
import { LineAiReviews, LineAiSetup } from "./line-assistant";

const selectClass = "h-9 w-full rounded-md glass-field px-2 text-sm";
const errors: Record<string, string> = {
  LINE_WEBHOOK_HTTPS_REQUIRED: "LINE requires an HTTPS webhook URL.",
  LINE_API_RATE_LIMITED: "LINE is rate-limiting requests. Try again later.",
  COULD_NOT_CONNECT: "LINE could not connect to the webhook.",
  REQUEST_TIMEOUT: "LINE timed out while testing the webhook.",
  ERROR_STATUS_CODE: "The webhook returned an unsuccessful HTTP status.",
  UNCLASSIFIED: "LINE could not verify the webhook.",
  LINE_WEBHOOK_TEST_FAILED: "LINE could not verify the webhook.",
  LINE_ENDPOINT_NOT_SET: "LINE could not confirm the webhook URL was saved. Try again.",
  LINE_WEBHOOK_REQUEST_FAILED: "LINE could not complete webhook setup.",
  LINE_SECRETS_KEY_INVALID: "Configure LINE_SECRETS_KEY on the backend before connecting a bot.",
  LINE_CHANNEL_ALREADY_CONNECTED: "This LINE channel is already connected.",
  LINE_TOKEN_BOT_MISMATCH: "The access token belongs to a different bot.",
  LINE_CHAT_ENROLLMENT_CHANGED: "This chat rejoined since you opened it. Check its latest state and try again.",
  LINE_CHAT_STATE_CHANGED: "The chat is no longer in the expected state. Check its status in LINE and try again.",
  LINE_OWNER_NOT_PROJECT_MEMBER: "The selected customer must belong to this Project.",
  LINE_API_REQUEST_FAILED: "LINE could not complete that request. Check the bot credentials and try again.",
  LINE_BOT_FIELDS_INVALID: "Check the bot name and credentials.",
  LINE_AI_CONNECTION_REQUIRED: "Test and save the Project AI connection before enabling this chat.",
};
function useTask(onError?: (code: string | undefined) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); }
    catch (error) {
      const code = error instanceof ConvexError ? error.data?.code : undefined;
      onError?.(code);
      toast.error(errors[code] ?? "The LINE operation could not be completed.");
    } finally { setBusy(false); }
  };
  return { busy, run };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1 text-sm font-medium">{label}{children}</label>;
}

type Result = Awaited<ReturnType<ReturnType<typeof useLineActions>["add"]>>;
function AddBot({ project, close, openBot }: {
  project: ProjectSummary; close: () => void; openBot: (id: LineBot["_id"]) => void;
}) {
  const { add } = useLineActions();
  const { busy, run } = useTask();
  const [result, setResult] = useState<Result>();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void run(async () => {
      const result = await add({
        projectId: project._id, name: String(values.get("name")),
        channelSecret: String(values.get("secret")), accessToken: String(values.get("token")),
        locale: values.get("locale") === "en" ? "en" : "th",
      });
      form.reset();
      if (result.success) openBot(result.botId);
      else setResult(result);
    });
  }
  return <Dialog open onOpenChange={close} title="Add LINE bot">
    {result ? <div className="space-y-3 text-sm">
      <ul className="list-disc space-y-1 pl-5">
        <li>Bot credentials saved</li>
        <li>{result.success ? "Webhook connected" : errors[result.reason ?? ""] ?? "Webhook setup failed."}</li>
        {result.statusCode !== undefined && <li>Webhook test returned HTTP {result.statusCode}</li>}
        <li>Turn on Use webhook and webhook redelivery.</li>
        <li>Turn on Allow bot to join group chats.</li>
        <li>Turn off auto-reply and greeting messages.</li>
      </ul>
      <Button onClick={() => openBot(result.botId)}>Open bot settings</Button>
    </div> : <form className="grid gap-3" onSubmit={submit}>
      <Field label="Bot name (optional)"><Input name="name" maxLength={120} placeholder="Use the LINE display name" /></Field>
      <Field label="Channel secret"><Input name="secret" type="password" autoComplete="off" required /></Field>
      <Field label="Channel access token"><Input name="token" type="password" autoComplete="off" required /></Field>
      <Field label="Bot language"><select name="locale" className={selectClass}><option value="th">ไทย</option><option value="en">English</option></select></Field>
      <Button type="submit" disabled={busy} className="justify-self-start">{busy ? "Connecting…" : "Verify and connect"}</Button>
    </form>}
  </Dialog>;
}

function ChatSettings({ chat, projectId, close }: { chat: LineChat; projectId: ProjectSummary["_id"]; close: () => void }) {
  const { members } = useProjectMembers(projectId, true, false);
  const { updateChat } = useLineActions();
  const { busy, run } = useTask(code => {
    if (code === "LINE_CHAT_ENROLLMENT_CHANGED") close();
  });
  const [owner, setOwner] = useState(chat.ownerCustomerId ?? "");
  const approve = chat.state === "pending";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run(async () => {
      await updateChat({
        chatId: chat._id, approve, joinedAt: chat.joinedAt, ownerCustomerId: members?.find(member => member.customerId === owner)?.customerId,
        displayNameOverride: String(fields.get("name")), notify: chat.notify, allowCreate: chat.allowCreate,
      });
      close();
    });
  }
  return <Dialog open onOpenChange={close} title={approve ? "Approve chat" : "Edit chat"} description={chat.displayNameOverride ?? chat.name}>
    <form onSubmit={submit} className="grid gap-3">
      <Field label="Display name override"><Input name="name" defaultValue={chat.displayNameOverride} maxLength={120} placeholder={chat.name} /></Field>
      <Field label="Ticket owner"><select value={owner} onChange={event => setOwner(event.target.value)} className={selectClass}>
        <option value="">Staff only</option>
        {members?.map(member => <option key={member.customerId} value={member.customerId}>{member.displayName ?? member.username}</option>)}
      </select></Field>
      <Button type="submit" disabled={busy || !members} className="justify-self-start">{approve ? "Approve" : "Save"}</Button>
    </form>
  </Dialog>;
}

function BotDetail({ bot, back, assistantReady }: { bot: LineBot; back: () => void; assistantReady: boolean }) {
  const chats = useLineChats(bot._id);
  const actions = useLineActions();
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [editing, setEditing] = useState<LineChat>();
  const [confirm, setConfirm] = useState<LineChat>();
  const { busy, run } = useTask(code => {
    if (code === "LINE_CHAT_ENROLLMENT_CHANGED") setConfirm(undefined);
  });
  const botId = bot._id;
  return <div className="space-y-5">
    <Button variant="ghost" onClick={back}>← LINE bots</Button>
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{bot.name}</h2><Badge variant="outline">{bot.state}</Badge><span className="text-sm text-muted-foreground">{bot.basicId}</span></div>
    <section className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span>Last webhook {bot.lastWebhookAt ? new Date(bot.lastWebhookAt).toLocaleString() : "Never"}</span>
        <span>{bot.signatureFailures} signature failures</span>
      </div>
      {bot.state === "setup" && <p className="text-sm">Use Add LINE bot with credentials for this bot to resume setup.</p>}
      {bot.lastError && <p className="text-sm text-destructive">{errors[bot.lastError] ?? bot.lastError}</p>}
      <div className="flex gap-2"><Input readOnly value={bot.webhookUrl} aria-label="Webhook URL" />
        <Button variant="outline" onClick={() => run(async () => { await navigator.clipboard.writeText(bot.webhookUrl); toast.success("Webhook URL copied"); })}>Copy</Button>
      </div>
      <p className="text-sm text-muted-foreground">Secret ••••{bot.secretHint} · Token ••••{bot.tokenHint}</p>
      <details>
        <summary className="cursor-pointer text-sm font-medium">LINE console checklist</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>{bot.webhookActive === undefined ? "Check that Use webhook is enabled."
            : bot.webhookActive ? "Use webhook was enabled when last verified." : "Enable Use webhook."}</li>
          <li>Enable webhook redelivery and allow the bot to join groups.</li>
          <li>Review auto-reply and greeting messages in LINE Official Account Manager.</li>
        </ul>
        <a href="https://developers.line.biz/en/docs/messaging-api/getting-started/" target="_blank" rel="noreferrer"
          className="mt-2 inline-block text-sm underline">LINE setup instructions</a>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || bot.state === "setup"} onClick={() => setEditingCredentials(true)}>Update credentials</Button>
        <Button variant="outline" disabled={busy || bot.state === "setup"} onClick={() => run(() => actions.updateBot({ botId, enabled: bot.state === "disabled" }))}>{bot.state === "disabled" ? "Enable" : "Disable"}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-h-9 items-center gap-2 text-sm"><input role="switch" type="checkbox" disabled={busy} checked={bot.allowDirectChats}
          onChange={event => { const allowDirectChats = event.target.checked; void run(() => actions.updateBot({ botId, allowDirectChats })); }} />Auto-approve new 1:1 chats</label>
        <Field label="Bot language"><select className={selectClass} value={bot.locale} disabled={busy}
          onChange={event => { const locale = event.target.value === "en" ? "en" : "th"; void run(() => actions.updateBot({ botId, locale })); }}>
          <option value="th">ไทย</option><option value="en">English</option>
        </select></Field>
      </div>
    </section>
    <section className="space-y-2">
      <h3 className="font-semibold">Chats</h3>
      {!chats?.length ? <p className="text-sm text-muted-foreground">{chats ? "No chats yet." : "Loading chats…"}</p> :
        <Table><TableHeader><TableRow><TableHead>Chat</TableHead><TableHead>State</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
          <TableBody>{chats.map(chat => <TableRow key={chat._id}>
            <TableCell><span className="font-medium">{chat.displayNameOverride ?? chat.name}</span>
              <div className="text-xs text-muted-foreground">{chat.kind}{chat.memberCount !== undefined && ` · ${chat.memberCount} members`}</div></TableCell>
            <TableCell><Badge variant="outline">{chat.state}</Badge></TableCell>
            <TableCell><div className="flex flex-wrap gap-1">
              {["pending", "active", "muted"].includes(chat.state) &&
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(chat)}>{chat.state === "pending" ? "Approve" : "Edit"}</Button>}
              {(["pending", "active", "muted"] as const).map(state => {
                if (chat.state !== state) return null;
                const next = { pending: "rejected", active: "muted", muted: "active" } as const;
                return <Button key={state} size="sm" variant="ghost" disabled={busy} onClick={() => run(() => actions.setChatState({ chatId: chat._id, joinedAt: chat.joinedAt, state: next[state] }))}>
                  {{ pending: "Reject", active: "Mute", muted: "Unmute" }[state]}
                </Button>;
              })}
              {chat.state === "active" && ((assistantReady && bot.state === "active") || chat.assistantEnabled) &&
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => actions.setAssistantEnabled({
                  chatId: chat._id, joinedAt: chat.joinedAt, enabled: !chat.assistantEnabled,
                }))}>{chat.assistantEnabled ? "Pause assistant" : "Enable assistant"}</Button>}
              {chat.state !== "left" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(chat)}>Remove</Button>}
            </div></TableCell>
          </TableRow>)}</TableBody></Table>}
    </section>
    {editingCredentials && <Dialog open onOpenChange={() => setEditingCredentials(false)} title="Update LINE credentials" description="Enter a new channel secret, a new access token, or both.">
      <form className="grid gap-3" onSubmit={event => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const accessToken = String(values.get("token")).trim() || undefined;
        const channelSecret = String(values.get("secret")).trim() || undefined;
        void run(async () => {
          await actions.updateCredentials({ botId, accessToken, channelSecret });
          setEditingCredentials(false);
          toast.success("Credentials updated");
        });
      }}>
        <Field label="New channel secret"><Input name="secret" type="password" autoComplete="off" /></Field>
        <Field label="New access token"><Input name="token" type="password" autoComplete="off" /></Field>
        <Button type="submit" disabled={busy} className="justify-self-start">Update credentials</Button>
      </form>
    </Dialog>}
    {editing && <ChatSettings chat={editing} projectId={bot.projectId} close={() => setEditing(undefined)} />}
    {confirm && <Dialog open onOpenChange={() => setConfirm(undefined)}
      title="Remove LINE chat?"
      description={confirm.displayNameOverride ?? confirm.name}>
      <div className="flex gap-2"><Button variant="outline" onClick={() => setConfirm(undefined)}>Cancel</Button>
        <Button disabled={busy} onClick={() => run(async () => {
          await actions.remove({ chatId: confirm._id, joinedAt: confirm.joinedAt });
          setConfirm(undefined);
        })}>Remove chat</Button></div>
    </Dialog>}
  </div>;
}

export function LineSettings({ project, selected, onSelect, owner }: {
  project: ProjectSummary; selected?: string; onSelect: (bot?: LineBot["_id"]) => void; owner: boolean;
}) {
  const bots = useLineBots(project._id);
  const ai = useLineAiSettings(project._id);
  const [adding, setAdding] = useState(false);
  const bot = bots?.find(item => item._id === selected);
  if (bot) return <BotDetail key={bot._id} bot={bot} back={() => onSelect()}
    assistantReady={!!ai?.releaseEnabled && !!ai.connection?.enabled} />;
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{project.name} · LINE bots</h2><Button onClick={() => setAdding(true)}>Add bot</Button></div>
    {!bots?.length && <p className="text-sm text-muted-foreground">{bots ? "No LINE bots connected." : "Loading LINE bots…"}</p>}
    <ul className="divide-y rounded-lg border empty:hidden">{bots?.map(bot => <li key={bot._id}>
      <button type="button" onClick={() => onSelect(bot._id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted">
        <span>{bot.name} <span className="text-sm text-muted-foreground">{bot.basicId}</span></span><Badge variant="outline">{bot.state}</Badge>
      </button>
    </li>)}</ul>
    {ai?.releaseEnabled && <>
      <LineAiSetup projectId={project._id} settings={ai} owner={owner && ai.canManage} />
      <LineAiReviews projectId={project._id} />
    </>}
    {adding && <AddBot project={project} close={() => setAdding(false)} openBot={id => { setAdding(false); onSelect(id); }} />}
  </div>;
}
