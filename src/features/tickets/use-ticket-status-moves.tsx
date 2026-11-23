import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { Id } from "@convex/_generated/dataModel";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { Button } from "@/components/ui/button";
import { statusMeta } from "@/components/ticket-status";
import { localizeError, useI18n } from "@/lib/i18n";
import type { TicketStatus } from "@/lib/types";
import { useFreshTicketStatus } from "./adapters/fresh-ticket-status";
import { TicketStatusMoves, type MoveSource } from "./status-moves";
const phaseLabels = { moving: "statusWriting", checking: "statusChecking", retry: "statusNeedsConnection" } as const;

export function useTicketStatusMoves(
  projectId: Id<"projects"> | undefined,
  write: (item: MoveSource, status: TicketStatus) => Promise<{ version: number }>,
) {
  const [moves] = useState(() => new TicketStatusMoves());
  const entries = useSyncExternalStore(moves.subscribe, moves.snapshot);
  const read = useFreshTicketStatus();
  const { t } = useI18n();

  useEffect(() => {
    for (const outcome of moves.takeOutcomes(projectId)) {
      const { item } = outcome;
      const label = formatTicketNumber(item.ticketNumber, item.projectKey);
      const options = { id: `ticket-move-${item._id}` };
      if ("error" in outcome) toast.error(`${label} · ${localizeError(outcome.error, t)}`, options);
      else {
        const message = outcome.status ? `${t("detailCurrent")} · ${t(statusMeta(outcome.status).labelKey)}` : t("ticketMissing");
        toast.info(`${label} · ${message}`, options);
      }
    }
  }, [entries, moves, projectId, t]);

  const pending = useMemo(() => [...entries.values()].filter(entry => entry.item.projectId === projectId), [entries, projectId]);
  const busy = useMemo(() => new Set<string>(pending.map(({ item }) => item._id)), [pending]);
  useEffect(() => {
    const refresh = () => {
      for (const { item, phase } of moves.snapshot().values()) {
        if (phase === "retry") void moves.retry(item._id, { read });
      }
    };
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [moves, read]);

  const notice = (items: typeof pending) => items.length ? <div className="space-y-1" role="status">
    {items.map(({ item, phase }) => <div key={item._id} className="flex flex-wrap items-center gap-2 text-sm">
      <span>{formatTicketNumber(item.ticketNumber, item.projectKey)} · {t(phaseLabels[phase])}</span>
      {phase === "retry" && <Button variant="outline" className="min-h-11" onClick={() => void moves.retry(item._id, { read })}>
        {t("statusCheckAgain")}
      </Button>}
    </div>)}
  </div> : null;
  return {
    busy,
    moveItem: (item: MoveSource, status: TicketStatus) => moves.move(item, status, { write, read }),
    recovery: notice(pending),
    recoveryFor: (id: string) => notice(pending.filter(entry => entry.item._id === id)),
  };
}
