import type { Id } from "@convex/_generated/dataModel";
import type { TicketRoutingClassification } from "../../../shared/ticket-routing";
import { useRoutingVocabulary } from "./adapters/convex";
import { routingSelect, useRoutingCopy } from "./routing-copy";

type Vocabulary = { code: string; en: string; th: string }[];
export function RoutingClassificationFields({ products, symptoms, value, onChange, disabled }: {
  products: Vocabulary; symptoms: Vocabulary; value?: TicketRoutingClassification;
  onChange: (value: TicketRoutingClassification) => void; disabled?: boolean;
}) {
  const { copy, language } = useRoutingCopy();
  const classification = value ?? { restricted: false };
  return <div className="grid gap-2 sm:grid-cols-2">
    {([{ field: "product", values: products }, { field: "symptom", values: symptoms }] as const).filter(({ field, values }) => values.length > 0 || classification[field]).map(({ field, values }) =>
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
    )}
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
  return <RoutingClassificationFields products={vocab?.products ?? []} symptoms={vocab?.symptoms ?? []} value={value} onChange={next => {
    onChange(next.restricted || next.product || next.symptom ? next : undefined);
  }} disabled={disabled} />;
}
