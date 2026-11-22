import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Ticket } from "@/lib/types";
import type { TicketRoutingClassification } from "../../../shared/ticket-routing";
import { type RoutingSettings, useRoutingActions, useRoutingAssignment, useRoutingSettings } from "./adapters/convex";
import { routingSelect, useRoutingCopy } from "./routing-copy";
import { RoutingClassificationFields } from "./ticket-routing-fields";

type Assignment = NonNullable<ReturnType<typeof useRoutingAssignment>>;
type AssignmentDraft = {
  version: number; area: string; assignee: string; held: boolean;
  classification: TicketRoutingClassification;
};

export function TicketAssignment({ ticket }: { ticket: Ticket }) {
  const settings = useRoutingSettings(ticket.projectId);
  const assignment = useRoutingAssignment(ticket._id);
  if (!settings || !assignment) return null;
  return <AssignmentEditor ticket={ticket} assignment={assignment} settings={settings} />;
}

function AssignmentEditor({ ticket, assignment, settings }: {
  ticket: Ticket; assignment: Assignment; settings: RoutingSettings;
}) {
  const { t, formatDate } = useI18n();
  const { copy, language } = useRoutingCopy();
  const actions = useRoutingActions();
  const current: AssignmentDraft = {
    version: assignment.version, area: assignment.value?.area ?? "", assignee: assignment.value?.assignee ?? "",
    held: assignment.value?.held ?? false, classification: assignment.classification ?? { restricted: false },
  };
  const [draft, setDraft] = useState(current);
  const editor = draft.version === assignment.version ? draft : current;
  const { area, assignee, held, classification } = editor;
  const update = (values: Partial<typeof draft>) => setDraft({ ...editor, ...values });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const availableArea = settings.policy.areas.find(item => item.code === area && item.active);
  const roster = availableArea && [...availableArea.primary, ...availableArea.fallback];
  const currentArea = settings.policy.areas.find(item => item.code === assignment.value?.area);
  const eligible = settings.people.filter(person => person.available && (!area || roster?.includes(person.staffId)));
  const args = { ticketId: ticket._id, expectedVersion: assignment.version };

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setError("");
    setMessage("");
    try { setMessage(await work()); }
    catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await actions.assign({ ...args, area: area || undefined, assignee: assignee || undefined, held });
      return copy.saved;
    });
  }

  return <section aria-label={copy.assignment} className="space-y-3 border-t pt-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">{copy.assignment}</h3>
      <p className="text-sm text-muted-foreground">
        {assignment.assigneeName ?? (assignment.value?.assignee ? copy.assignee : copy.unassigned)}
        {currentArea && ` · ${currentArea[language]}`}{assignment.value?.held && ` · ${copy.held}`}
      </p>
    </div>
    {assignment.needsReview && <p role="status" className="text-sm font-medium text-destructive">{copy.needsReview}</p>}
    {ticket.lifecycle === "active" && <>
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={save}>
        <label className="grid gap-1 text-sm">{copy.area}
          <select className={routingSelect} value={area} disabled={busy} onChange={event => update({ area: event.target.value, assignee: "" })}>
            <option value="">{copy.noArea}</option>
            {settings.policy.areas.filter(item => item.active || item.code === area).map(item =>
              <option key={item.code} value={item.code} disabled={!item.active}>{item[language]}</option>)}
            {area && !settings.policy.areas.some(item => item.code === area) && <option value={area} disabled>{area}</option>}
          </select>
        </label>
        <label className="grid gap-1 text-sm">{copy.assignee}
          <select className={routingSelect} value={assignee} disabled={busy} onChange={event => update({ assignee: event.target.value })}>
            <option value="">{copy.unassigned}</option>
            {eligible.map(person => <option key={person.staffId} value={person.staffId}>{person.name}</option>)}
            {assignee && !eligible.some(person => person.staffId === assignee) &&
              <option value={assignee} disabled>{assignment.assigneeName ?? assignee}</option>}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={held} disabled={busy} onChange={event => update({ held: event.target.checked })} />{copy.hold}
        </label>
        <Button variant="outline" disabled={busy || (area === (assignment.value?.area ?? "") && assignee === (assignment.value?.assignee ?? "")
          && held === (assignment.value?.held ?? false))}>{copy.saveAssignment}</Button>
      </form>
      <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">{copy.reviewClassification}</summary>
          <form className="mt-3 space-y-2" onSubmit={event => {
            event.preventDefault();
            void run(async () => {
              const result = await actions.classify({ ...args, value: {
                product: classification.product, symptom: classification.symptom, restricted: classification.restricted,
              } });
              return result.status === "pending" ? copy.suggestionSaved : copy.saved;
            });
          }}>
            <RoutingClassificationFields products={settings.policy.products} symptoms={settings.policy.symptoms} value={classification}
              disabled={busy} onChange={value => update({ classification: value })} />
            {assignment.classification && !assignment.classification.reviewed && <p className="text-sm text-muted-foreground">{copy.pendingReview}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy}>{copy.saveClassification}</Button>
              {assignment.classification?.reviewed && <Button type="button" variant="ghost" disabled={busy} onClick={() => {
                void run(async () => {
                  const result = await actions.checkRule({ ...args, requestId: crypto.randomUUID() });
                  return result.status === "manual" ? copy.manual : result.status === "pending" ? copy.suggestionSaved : copy.stale;
                });
              }}>{copy.checkRule}</Button>}
            </div>
          </form>
      </details>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {assignment.events.length > 0 && <details className="text-sm">
      <summary className="cursor-pointer py-2 font-medium">{copy.history}</summary>
      <ul className="space-y-2 text-muted-foreground">
        {assignment.events.map(event => <li key={event.id} className="rounded-md border p-2">
          <span className="font-medium text-foreground">{event.assignee ?? copy.unassigned}</span>
          {event.area && ` · ${settings.policy.areas.find(item => item.code === event.area)?.[language] ?? event.area}`}
          {event.held && ` · ${copy.held}`}
          <div>{[event.reviewer, formatDate(event.date)].filter(Boolean).join(" · ")}</div>
        </li>)}
      </ul>
    </details>}
  </section>;
}
