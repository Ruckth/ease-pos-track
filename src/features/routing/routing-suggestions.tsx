import { useEffect, useState } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { type RoutingSettings, useRoutingActions, useRoutingSuggestionQueue } from "./adapters/convex";
import { useRoutingCopy } from "./routing-copy";

export function RoutingSuggestions({ projectId, settings, openTicket }: {
  projectId: Id<"projects">; settings: RoutingSettings; openTicket: (id: Id<"tickets">) => void;
}) {
  const { t, formatDate } = useI18n();
  const { copy, language } = useRoutingCopy();
  const queue = useRoutingSuggestionQueue(projectId, settings.policy.policyGeneration);
  const actions = useRoutingActions();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now);
  const suggestions = queue.results.filter(item => item.expiresAt > now);
  const nextExpiry = Math.min(...suggestions.map(item => item.expiresAt));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  async function review(suggestionId: Id<"ticketRoutingSuggestions">, decision: "accept" | "dismiss") {
    setBusy(suggestionId);
    setMessage("");
    setError("");
    try {
      const result = await actions.review({ suggestionId, decision });
      setMessage(result.status === "accepted" ? copy.accepted : result.status === "dismissed" ? copy.dismissed : copy.stale);
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(undefined); }
  }
  return <div className="space-y-3">
    {queue.status === "LoadingFirstPage" ? <p role="status">{t("syncing")}</p>
      : suggestions.length === 0 && <p className="text-sm text-muted-foreground">{copy.noSuggestions}</p>}
    <ul className="space-y-2">
      {suggestions.map(suggestion => <li key={suggestion.id} className="space-y-1 rounded-lg border border-transparent bg-muted/40 p-3">
        <Button type="button" variant="ghost" className="h-auto min-h-11 max-w-full whitespace-normal px-2 text-left text-primary underline-offset-4 hover:underline"
          onClick={() => openTicket(suggestion.ticketId)}>
          {formatTicketNumber(suggestion.ticketNumber, suggestion.projectKey)} · {suggestion.title}
        </Button>
        <p className="text-sm">{settings.policy.areas.find(item => item.code === suggestion.area)?.[language] ?? suggestion.area}</p>
        <p className="text-xs text-muted-foreground">{copy[suggestion.source]} · {formatDate(suggestion.expiresAt)}</p>
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" disabled={busy !== undefined} onClick={() => void review(suggestion.id, "accept")}>{copy.accept}</Button>
          <Button className="min-h-11" variant="outline" disabled={busy !== undefined} onClick={() => void review(suggestion.id, "dismiss")}>{copy.dismiss}</Button>
        </div>
      </li>)}
    </ul>
    {queue.status === "CanLoadMore" && <Button variant="outline" onClick={() => queue.loadMore(12)}>{t("loadOlder")}</Button>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
