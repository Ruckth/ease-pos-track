import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectSummary } from "@/lib/types";
import {
  useLineAiReplies, useLineAiReviewActions, useLineAiReviews, useLineAiSettings, useLineAiSetupActions, type LineAiDraft,
} from "./adapters/convex";

const providerNames = {
  gemini: "Google Gemini", openrouter: "OpenRouter", claude: "Anthropic Claude", openai: "OpenAI",
} as const;
type Provider = keyof typeof providerNames;

const errors: Record<string, string> = {
  LINE_AI_KEY_INVALID: "The provider rejected the API key. Check its permissions.",
  LINE_AI_KEY_REJECTED: "The provider rejected the API key. Check its permissions.",
  LINE_AI_REQUEST_REJECTED: "The provider rejected the request. Check the model access for this key.",
  LINE_AI_QUOTA_EXCEEDED: "The provider reported a billing or quota limit.",
  LINE_AI_RATE_LIMITED: "The provider is rate-limiting requests. Try again shortly.",
  LINE_AI_PROVIDER_UNAVAILABLE: "The provider is unavailable. Try again shortly.",
  LINE_AI_RESPONSE_INVALID: "The provider did not pass the text, image and PDF check.",
  LINE_AI_DISABLED: "The LINE assistant is disabled on this deployment.",
  LINE_AI_NOT_CONFIGURED: "Test and save an API key before resuming.",
  LINE_AI_CONNECTION_CHANGED: "The connection changed while you were testing it. Check the current connection and try again.",
  LINE_AI_DRAFT_UNAVAILABLE: "This suggestion changed or expired. Open the current suggestion to continue.",
  LINE_AI_APPROVAL_CONFLICT: "This suggestion was already handled with a different decision. Check recent replies.",
  LINE_AI_TICKET_NOT_LINKED: "Choose a clarification reply when the Ticket is unavailable in this LINE chat.",
  LINE_AI_CREATE_DISABLED: "Ticket creation is disabled for this chat.",
  LINE_AI_REPLY_REQUIRED: "Enter a reply.",
  LINE_AI_REPLY_TOO_LONG: "Shorten the LINE reply.",
  LINE_AI_REPLY_UNAVAILABLE: "This reply can no longer be retried.",
  LINE_OWNER_NOT_PROJECT_MEMBER: "Update the chat’s Ticket owner to an active Project member.",
  VERSION_CONFLICT: "The Ticket changed. Review its latest version before closing it.",
  REQUIRED_TICKET: "Enter a Ticket title.",
  TITLE_TOO_LONG: "Shorten the Ticket title.",
  DESCRIPTION_TOO_LONG: "Shorten the Ticket description.",
};

const scanWarnings: Record<string, string> = {
  LINE_AI_ATTACHMENT_UNAVAILABLE: "A file could not be read. Check the chat before continuing.",
  LINE_AI_KEY_REJECTED: "The provider rejected the Project API key.",
  LINE_AI_KEY_UNREADABLE: "The saved Project API key could not be opened. Ask an Owner to reconnect it.",
  LINE_AI_QUOTA_EXCEEDED: "The provider reported a billing or quota limit.",
  LINE_AI_RATE_LIMITED: "The provider rate-limited this scan.",
  LINE_AI_DAILY_LIMIT: "This Project reached its daily scan limit.",
  LINE_AI_REQUEST_REJECTED: "The provider declined this scan.",
  LINE_AI_RESPONSE_INVALID: "The provider returned a response that could not be used.",
};

function useLineAiTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await task(); }
    catch (failure) {
      const code = failure instanceof ConvexError ? failure.data?.code : undefined;
      setError(errors[code] ?? "The action could not be completed.");
    } finally { setBusy(false); }
  }
  return { busy, error, run };
}

type Settings = NonNullable<ReturnType<typeof useLineAiSettings>>;

export function LineAiSetup({ projectId, settings, owner }: {
  projectId: ProjectSummary["_id"]; settings: Settings; owner: boolean;
}) {
  const { testAndSave, disable, setPaused } = useLineAiSetupActions();
  const connection = settings.connection;
  const [provider, setProvider] = useState<Provider>(settings.connection?.provider ?? "gemini");
  const { busy, error, run } = useLineAiTask();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = String(new FormData(form).get("key")).trim();
    void run(async () => {
      await testAndSave({ projectId, provider, apiKey });
      form.reset();
      toast.success("Provider verified and saved");
    });
  }

  return <section className="grid gap-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">Project AI connection</h3>
      <Badge variant="outline">{connection?.enabled ? "Active" : connection?.keyHint ? "Paused" : "Disconnected"}</Badge>
    </div>
    {connection?.keyHint && <p className="text-sm">
      {providerNames[connection.provider]} · {connection.model} · ••••{connection.keyHint}
    </p>}
    {owner && <form className="grid gap-3" onSubmit={submit}>
      <label className="grid gap-1 text-sm font-medium">
        Provider
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={provider}
          onChange={event => setProvider(event.target.value as Provider)} disabled={busy}>
          {Object.entries(providerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <p className="text-sm text-muted-foreground">Model · {settings.models[provider]}</p>
      <label className="grid gap-1 text-sm font-medium">
        API key
        <Input name="key" type="password" autoComplete="off" required disabled={busy} maxLength={512} />
      </label>
      {provider === "gemini" && <p className="text-sm text-muted-foreground">Gemini 4 Neon requires paid Gemini API access.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Test and save"}</Button>
        {connection?.keyHint && <Button type="button" variant="outline" disabled={busy} onClick={() => void run(async () => {
          await setPaused({ projectId, paused: connection.enabled, expectedRevision: connection.revision });
        })}>{connection.enabled ? "Pause assistant" : "Resume assistant"}</Button>}
        {connection?.keyHint && <Button type="button" variant="outline" disabled={busy}
          onClick={() => void run(async () => { await disable({ projectId }); })}>Disconnect provider</Button>}
      </div>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}

const replyStates = {
  pending: "Reply queued", accepted: "Reply accepted by LINE", unknown: "Reply status unknown",
  rejected: "Reply rejected by LINE", suppressed: "Reply paused",
  limited: "LINE reached a limit. Check the rate and message quota before retrying.",
};

function ReviewSuggestion({ draft, onClose }: { draft: LineAiDraft; onClose: () => void }) {
  const { approve, dismiss } = useLineAiReviewActions();
  const { busy, error, run } = useLineAiTask();
  const [mode, setMode] = useState<"create" | "close" | "clarify">(
    draft.target ? "close" : draft.canCreate && draft.suggestion.intent === "create" ? "create" : "clarify",
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reply = String(form.get("reply"));
    // This form belongs to a specific version the approver can see.
    const ticketVersion = draft.target?.version;
    if (mode === "close" && ticketVersion === undefined) return;
    void run(async () => {
      await approve({
        draftId: draft._id,
        decision: mode === "create"
          ? { type: "create", title: String(form.get("title")), description: String(form.get("description")), reply }
          : mode === "close" && ticketVersion !== undefined
            ? { type: "close", ticketVersion, reply }
            : { type: "clarify", reply },
      });
      onClose();
    });
  }
  return <form className="grid gap-3" onSubmit={submit}>
    <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{draft.text}</p>
    {draft.warning && <p className="text-sm text-muted-foreground">
      {scanWarnings[draft.warning] ?? "A model suggestion was unavailable."} Review the message and prepare a response.
    </p>}
    {!!draft.suggestion.evidence.length && <ul className="list-disc space-y-1 break-words pl-5 text-sm text-muted-foreground">
      {draft.suggestion.evidence.map((item, index) => <li key={index}>{item}</li>)}
    </ul>}
    <label className="grid gap-1 text-sm font-medium">
      Action
      <select className="h-9 rounded-md border bg-background px-2 text-sm" value={mode}
        onChange={event => setMode(event.target.value as typeof mode)} disabled={busy}>
        {draft.canCreate && <option value="create">Create Ticket</option>}
        {draft.target && <option value="close">Close {draft.target.number}</option>}
        <option value="clarify">Ask for clarification</option>
      </select>
    </label>
    {mode === "close" && draft.target && <p className="text-sm">{draft.target.title} · Move to Done</p>}
    {mode === "create" && <>
      <label className="grid gap-1 text-sm font-medium">
        Ticket title<Input name="title" defaultValue={draft.suggestion.title ?? ""} maxLength={100} required disabled={busy} />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Ticket description<Textarea name="description" defaultValue={draft.suggestion.description ?? draft.text} maxLength={10000}
          required disabled={busy} />
      </label>
    </>}
    <label className="grid gap-1 text-sm font-medium">
      Reply to {draft.chatName}
      <Textarea key={mode} name="reply" defaultValue={mode === "clarify" ? draft.suggestion.reply ?? draft.replies.clarify : draft.replies[mode]}
        maxLength={1800} required disabled={busy} />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy || (mode === "close" && !draft.target)}>
        {mode === "create" ? "Create and send" : mode === "close" ? "Close and send" : "Send reply"}
      </Button>
      <Button type="button" variant="outline" disabled={busy}
        onClick={() => void run(async () => { await dismiss({ draftId: draft._id }); onClose(); })}>Dismiss</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}

export function LineAiReviews({ projectId }: { projectId: ProjectSummary["_id"] }) {
  const { results, status, loadMore } = useLineAiReviews(projectId);
  const replies = useLineAiReplies(projectId);
  const drafts = results.filter(item => item.state === "review");
  const unavailableCount = results.length - drafts.length;
  const { retryReply } = useLineAiReviewActions();
  const { busy, error, run } = useLineAiTask();
  const [openId, setOpenId] = useState<LineAiDraft["_id"]>();
  return <section className="grid gap-3 rounded-lg border p-4">
    <h3 className="font-semibold">LINE Ticket suggestions</h3>
    {status === "LoadingFirstPage" && <p className="text-sm text-muted-foreground">Loading suggestions…</p>}
    {status === "Exhausted" && !results.length && <p className="text-sm text-muted-foreground">No suggestions to review.</p>}
    {drafts.map(draft => (
      <div key={draft._id} className="grid gap-3 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words text-sm">{draft.chatName} · {draft.suggestion.title ?? "Review message"}</span>
          <Button type="button" size="sm" variant="outline" aria-expanded={openId === draft._id}
            onClick={() => setOpenId(openId === draft._id ? undefined : draft._id)}>
            {openId === draft._id ? "Hide" : "Review"}
          </Button>
        </div>
        {openId === draft._id && <ReviewSuggestion key={draft.target?.version ?? "new"} draft={draft} onClose={() => setOpenId(undefined)} />}
      </div>
    ))}
    {unavailableCount > 0 && <p className="text-sm text-muted-foreground" role="status">
      {unavailableCount === 1 ? "One suggestion is" : `${unavailableCount} suggestions are`} unavailable because access changed or the request expired.
    </p>}
    {(status === "CanLoadMore" || status === "LoadingMore") &&
      <Button type="button" size="sm" variant="outline" className="justify-self-start"
        disabled={status === "LoadingMore"} onClick={() => loadMore(25)}>
        {status === "LoadingMore" ? "Loading…" : "Load more suggestions"}
      </Button>}
    {!!replies?.length && <details className="border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">Recent replies</summary>
      <ul className="mt-2 grid gap-2">{replies.map(reply => <li key={reply._id}
        className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{reply.number ? `${reply.number} · ` : ""}{replyStates[reply.state]}</span>
        {reply.canRetry && <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => void run(async () => { await retryReply({ replyId: reply._id }); })}>Retry reply</Button>}
      </li>)}</ul>
    </details>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
