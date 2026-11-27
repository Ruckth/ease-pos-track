import { ChevronDown } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import type { TicketRoutingClassification } from "../../../shared/ticket-routing";
import { useRoutingVocabulary } from "./adapters/convex";
import { routingSelect, useRoutingCopy } from "./routing-copy";

type Vocabulary = { code: string; en: string; th: string }[];
export function RoutingClassificationFields({ products, symptoms, value, onChange, disabled, discloseCodes = false }: {
  products: Vocabulary; symptoms: Vocabulary; value?: TicketRoutingClassification;
  onChange: (value: TicketRoutingClassification) => void; disabled?: boolean; discloseCodes?: boolean;
}) {
  const { copy, language } = useRoutingCopy();
  const classification = value ?? { restricted: false };
  const availableFields = ([{ field: "product", values: products }, { field: "symptom", values: symptoms }] as const)
    .filter(({ field, values }) => values.length > 0 || classification[field]);
  const codeFields = availableFields.map(({ field, values }) =>
    <label key={field} className="grid gap-1 text-sm">{copy[field]}
      <select className={routingSelect} disabled={disabled} value={classification[field] ?? ""} onChange={event => {
        onChange({ ...classification, [field]: event.target.value || undefined });
      }}>
        <option value="">{copy.unknown}</option>
        {values.map(item => <option key={item.code} value={item.code}>{item[language]}</option>)}
        {classification[field] && !values.some(item => item.code === classification[field]) &&
          <option value={classification[field]} disabled>{copy.unknown} ({classification[field]})</option>}
      </select>
    </label>
  );
  const selectedLabels = availableFields.flatMap(({ field, values }) => {
    const code = classification[field];
    return code ? [values.find(item => item.code === code)?.[language] ?? `${copy.unknown} (${code})`] : [];
  });
  return <div className="grid gap-2 sm:grid-cols-2">
    {discloseCodes ? codeFields.length > 0 && <details className="group rounded-md border border-border/60 sm:col-span-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 break-words">
          {copy.classificationDetails}
          {selectedLabels.length > 0 && <span className="block font-normal text-muted-foreground">{selectedLabels.join(" · ")}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open:rotate-180" />
      </summary>
      <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">{codeFields}</div>
    </details> : codeFields}
    <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
      <input type="checkbox" className="size-4" disabled={disabled} checked={classification.restricted}
        onChange={event => onChange({ ...classification, restricted: event.target.checked })} />
      {copy.restricted}
    </label>
  </div>;
}

export function TicketRoutingFields({ projectId, value, onChange, disabled }: {
  projectId: Id<"projects">; value?: TicketRoutingClassification;
  onChange: (value?: TicketRoutingClassification) => void; disabled: boolean;
}) {
  const vocab = useRoutingVocabulary(projectId);
  return <RoutingClassificationFields products={vocab?.products ?? []} symptoms={vocab?.symptoms ?? []} value={value} discloseCodes onChange={next => {
    onChange(next.restricted || next.product || next.symptom ? next : undefined);
  }} disabled={disabled} />;
}
