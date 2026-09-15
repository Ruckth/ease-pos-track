import { useMemo } from "react";
import { CalendarDays, Tags, CircleDot, Gauge } from "lucide-react";
import { Filters } from "@/components/reui/filters/filters";
import type { FilterEditorProps, FilterField, FilterQuery } from "@/components/reui/filters/filters-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { statuses } from "@/components/feedback-status";
import { useI18n } from "@/lib/i18n";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { thaiFilterLabels } from "@/lib/explorer-filter-labels";
import { dateBoundary, type ExplorerTag } from "@/lib/ticket-explorer";

function DateRangeEditor({ value, onValueChange, commit, cancel, autoFocusProps, field }: FilterEditorProps) {
  const c = useExplorerCopy();
  const dates = Array.isArray(value) ? value : ["", ""];
  const from = typeof dates[0] === "string" ? dates[0] : "";
  const to = typeof dates[1] === "string" ? dates[1] : "";
  const start = dateBoundary(from); const end = dateBoundary(to);
  const valid = start !== null && end !== null && end >= start;
  return <form className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3" onSubmit={(event) => { event.preventDefault(); if (valid) commit([from, to]); }}>
    <label className="space-y-1 text-sm">{field.label} · {c.from}<Input {...autoFocusProps} type="date" value={from} max={to || undefined} onChange={(e) => onValueChange([e.target.value, to])} /></label>
    <label className="space-y-1 text-sm">{field.label} · {c.to}<Input type="date" value={to} min={from || undefined} onChange={(e) => onValueChange([from, e.target.value])} /></label>
    <p className="text-xs text-muted-foreground">{c.dateHint}</p>
    {from && to && !valid && <p role="alert" className="text-xs text-destructive">{c.invalidDate}</p>}
    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={cancel}>{c.cancel}</Button><Button size="sm" disabled={!valid}>{c.apply}</Button></div>
  </form>;
}

/** The custom range editor follows c-filters-6: draft on slide, commit on Apply. */
function UrgencyEditor({ value, onValueChange, commit, cancel, autoFocusProps }: FilterEditorProps) {
  const c = useExplorerCopy(); const current = Array.isArray(value) && value.length === 2 ? value.map(Number) : [1, 100];
  const valid = current.every((n) => Number.isInteger(n) && n >= 1 && n <= 100) && current[0] <= current[1];
  return <form className="flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-3 p-3" onSubmit={(event) => {event.preventDefault(); if(valid) commit(current);}}>
    {current.map((n,index) => <label key={index} className="flex flex-col gap-2 text-sm">{c.urgency} · {index === 0 ? c.from : c.to}: {n}
      <input {...(index === 0 ? autoFocusProps : {})} type="range" min={1} max={100} step={1} value={n} onChange={(event) => {const next=[...current]; next[index]=Number(event.target.value);onValueChange(next);}} />
    </label>)}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={cancel}>{c.cancel}</Button><Button size="sm" disabled={!valid}>{c.apply}</Button></div>
  </form>;
}

export function TicketExplorerFilters({ query, onChange, tags }: { query: FilterQuery; onChange: (query: FilterQuery) => void; tags: ExplorerTag[] }) {
  const { t, language, formatDate } = useI18n(); const c = useExplorerCopy();
  const fields = useMemo<FilterField[]>(() => [
    { id: "tags", label: c.tags, icon: <Tags />, type: "multiselect", options: tags.map((tag) => ({ value: tag._id, label: tag.name })), operators: [{ value: "in", label: c.anyOf, arity: "many" }], defaultOperator: "in" },
    { id: "status", label: c.status, icon: <CircleDot />, type: "multiselect", options: statuses.map((status) => ({ value: status.value, label: t(status.labelKey) })), operators: [{ value: "in", label: c.anyOf, arity: "many" }], defaultOperator: "in" },
    { id: "urgencyScore", label: c.urgency, icon: <Gauge />, type: "range", operators: [{ value: "between", label: c.between, arity: "range" }, { value: "unset", label: c.unset, arity: "none" }], defaultOperator: "between", editor: UrgencyEditor },
    ...(["createdAt", "updatedAt"] as const).map((id) => ({ id, label: id === "createdAt" ? c.createdDate : c.updatedDate, icon: <CalendarDays />, type: "range" as const, operators: [{ value: "between", label: c.between, arity: "range" as const }], defaultOperator: "between", editor: DateRangeEditor, valueText: ({ value }: { value: unknown }) => Array.isArray(value) ? value.map((date) => { const time = dateBoundary(date); return time === null ? "…" : formatDate(time); }).join(` ${c.to} `) : "…" })),
  ], [tags, c, t, formatDate]);
  return <Filters fields={fields} query={query} onQueryChange={onChange} labels={language === "th" ? thaiFilterLabels : undefined} />;
}
