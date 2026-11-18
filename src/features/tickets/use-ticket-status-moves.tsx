import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  token: string,
  projectId: Id<"projects"> | undefined,
  write: (item: MoveSource, status: TicketStatus) => Promise<{ version: number }>,
) {
  const [moves] = useState(() => new TicketStatusMoves());
  const entries = useSyncExternalStore(moves.subscribe, moves.snapshot);
  const read = useFreshTicketStatus(token);
  const { t } = useI18n();
  const activeProject = useRef(projectId);
  useEffect(() => {
    activeProject.current = projectId;
    return () => { activeProject.current = undefined; };
  }, [projectId]);

  const recoveryDeps = useMemo(() => ({
    read,
    onRead(item: MoveSource, status: TicketStatus | null) {
      if (activeProject.current !== item.projectId) return;
      const label = formatTicketNumber(item.ticketNumber, item.projectKey);
      toast.info(`${label} · ${status ? t("detailCurrent") + " · " + t(statusMeta(status).labelKey) : t("ticketMissing")}`);
    },
    onRejected(item: MoveSource, error: unknown) {
      if (activeProject.current === item.projectId) toast.error(localizeError(error, t));
    },
  }), [read, t]);

  const pending = useMemo(() => [...entries.values()].filter(entry => entry.item.projectId === projectId), [entries, projectId]);
  const busy = useMemo(() => new Set<string>(pending.map(({ item }) => item._id)), [pending]);
  const retries = useMemo(() => pending.filter(entry => entry.phase === "retry"), [pending]);
  useEffect(() => {
    if (!retries.length) return;
    const refresh = () => { for (const { item } of retries) void moves.retry(item._id, recoveryDeps); };
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [moves, retries, recoveryDeps]);

  const notice = (items: typeof pending) => items.length ? <div className="space-y-1" role="status">
    {items.map(({ item, phase }) => <div key={item._id} className="flex flex-wrap items-center gap-2 text-sm">
      <span>{formatTicketNumber(item.ticketNumber, item.projectKey)} · {t(phaseLabels[phase])}</span>
      {phase === "retry" && <Button variant="outline" className="min-h-11" onClick={() => void moves.retry(item._id, recoveryDeps)}>
        {t("statusCheckAgain")}
      </Button>}
    </div>)}
  </div> : null;
  return {
    busy,
    moveItem: (item: MoveSource, status: TicketStatus) => moves.move(item, status, { write, ...recoveryDeps }),
    recovery: notice(pending),
    recoveryFor: (id: string) => notice(pending.filter(entry => entry.item._id === id)),
  };
}
