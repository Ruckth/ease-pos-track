import { useState, type FormEvent } from "react";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { ROUTING_LIMITS } from "../../../shared/ticket-routing";
import { useRoutingActions, type RoutingSettings } from "./adapters/convex";
import { routingSelect, useRoutingCopy } from "./routing-copy";

type Person = RoutingSettings["people"][number];
type Policy = RoutingSettings["policy"];
type Vocabulary = Policy["products"][number];
type Area = Policy["areas"][number];

function localDate(value?: number) {
  if (!value || value <= Date.now()) return "";
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function StaffChoice({ label, people, value, onChange, exclude }: {
  label: string; people: Person[]; value: string; onChange: (id: string) => void; exclude?: string[];
}) {
  const { copy } = useRoutingCopy();
  return <label className="grid min-w-0 gap-1 text-sm">{label}
    <select className={routingSelect} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{copy.select}</option>
      {people.filter(person => (person.active && !exclude?.includes(person.staffId)) || person.staffId === value).map(person =>
        <option key={person.staffId} value={person.staffId} disabled={!person.active}>{person.name}</option>)}
      {value && !people.some(person => person.staffId === value) && <option value={value} disabled>{value}</option>}
    </select>
  </label>;
}

function Roster({ label, people, value, onChange, exclude = [] }: {
  label: string; people: Person[]; value: string[]; onChange: (ids: string[]) => void; exclude?: string[];
}) {
  const { copy } = useRoutingCopy();
  return <fieldset className="min-w-0 space-y-1">
    <legend className="text-sm font-medium">{label}</legend>
    <ol className="space-y-1">
      {value.map((id, index) => {
        const name = people.find(person => person.staffId === id)?.name ?? id;
        return <li key={id} className="flex flex-wrap items-center gap-1 text-sm">
          <span className="min-w-0 grow break-words">{name}</span>
          <Button type="button" variant="ghost" disabled={index === 0} aria-label={`${copy.moveUp} ${name}`} onClick={() => {
            const next = [...value];
            [next[index - 1], next[index]] = [next[index], next[index - 1]];
            onChange(next);
          }}>{copy.moveUp}</Button>
          <Button type="button" variant="ghost" aria-label={`${copy.remove} ${name}`}
            onClick={() => onChange(value.filter(item => item !== id))}>{copy.remove}</Button>
        </li>;
      })}
    </ol>
    <StaffChoice label={`${copy.addStaff} · ${label}`} people={people} value="" onChange={id => { if (id) onChange([...value, id]); }}
      exclude={[...value, ...exclude]} />
  </fieldset>;
}

export function RoutingAvailability({ projectId, settings }: {
  projectId: Id<"projects">; settings: RoutingSettings;
}) {
  const { t } = useI18n();
  const { copy } = useRoutingCopy();
  const actions = useRoutingActions();
  const [staffId, setStaffId] = useState("");
  const [available, setAvailable] = useState(settings.availability.available);
  const [awayUntil, setAwayUntil] = useState(localDate(settings.availability.awayUntil));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await actions.setAvailability({ projectId, staffId: staffId || undefined, available,
        awayUntil: awayUntil ? new Date(awayUntil).getTime() : undefined, reason: staffId ? reason : undefined });
      setMessage(copy.saved);
    } catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  return <form className="space-y-2 rounded-lg border border-transparent bg-muted/40 p-3" onSubmit={save}>
    <h3 className="font-medium">{copy.availability}</h3>
    {settings.owner && <StaffChoice label={copy.override} people={settings.people} value={staffId} exclude={[settings.staffId]}
      onChange={id => {
        setStaffId(id);
        setAvailable(id ? settings.people.find(person => person.staffId === id)?.acceptsAssignments ?? true : settings.availability.available);
        setAwayUntil(localDate(id ? settings.people.find(person => person.staffId === id)?.awayUntil : settings.availability.awayUntil));
        setReason("");
      }} />}
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" className="size-4" checked={available} onChange={event => setAvailable(event.target.checked)} />{copy.available}
    </label>
    <label className="grid gap-1 text-sm">{copy.awayUntil}<Input className="min-h-11" type="datetime-local"
      value={awayUntil} onChange={event => setAwayUntil(event.target.value)} /></label>
    {staffId && <label className="grid gap-1 text-sm">{copy.reason}<Input className="min-h-11" maxLength={240} required
      value={reason} onChange={event => setReason(event.target.value)} /></label>}
    <Button className="min-h-11" variant="outline" disabled={busy}>{copy.setAvailability}</Button>
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}

function CodeFields<T extends Pick<Vocabulary, "code" | "en" | "th">>({ value, onChange, extra }: {
  value: T; onChange: (next: T) => void; extra?: React.ReactNode;
}) {
  const { copy } = useRoutingCopy();
  const fields = [{ key: "code", label: copy.code, max: 32 }, { key: "en", label: copy.english, max: 80 },
    { key: "th", label: copy.thai, max: 80 }] as const;
  return <div className="grid gap-2 sm:grid-cols-2">
    {fields.map(({ key, label, max }) => <label className="grid gap-1 text-sm" key={key}>{label}
      <Input className="min-h-11" maxLength={max} required value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} />
    </label>)}
    {extra}
  </div>;
}

function VocabularyEditor({ title, value, onChange }: { title: string; value: Vocabulary[]; onChange: (next: Vocabulary[]) => void }) {
  const { copy } = useRoutingCopy();
  return <fieldset className="min-w-0 space-y-3 rounded-lg border border-transparent bg-muted/40 p-3">
    <legend className="px-1 text-sm font-medium">{title}</legend>
    {value.map((item, index) => {
      const change = (next: Vocabulary) => onChange(value.map((current, i) => i === index ? next : current));
      return <div className="space-y-2 pb-1" key={index}>
        <CodeFields value={item} onChange={change} extra={<label className="grid gap-1 text-sm">{copy.meaning}
          <Input className="min-h-11" required maxLength={140} value={item.meaning}
            onChange={event => change({ ...item, meaning: event.target.value })} />
        </label>} />
        <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, i) => i !== index))}>{copy.remove}</Button>
      </div>;
    })}
    <Button type="button" variant="outline" disabled={value.length >= ROUTING_LIMITS.vocabulary}
      onClick={() => onChange([...value, { code: "", en: "", th: "", meaning: "" }])}>{copy.addCode}</Button>
  </fieldset>;
}

function AreaEditor({ value, people, onChange }: { value: Area[]; people: Person[]; onChange: (next: Area[]) => void }) {
  const { copy } = useRoutingCopy();
  return <fieldset className="min-w-0 space-y-3 rounded-lg border border-transparent bg-muted/40 p-3">
    <legend className="px-1 text-sm font-medium">{copy.areas}</legend>
    {value.map((item, index) => {
      const change = (next: Area) => onChange(value.map((current, i) => i === index ? next : current));
      return <div className="space-y-2 pb-1" key={index}>
        <CodeFields value={item} onChange={change} extra={<><label className="grid gap-1 text-sm">{copy.meaning}
          <Input className="min-h-11" maxLength={140} value={item.meaning ?? ""}
            onChange={event => change({ ...item, meaning: event.target.value || undefined })} />
        </label><label className="flex min-h-11 items-end gap-2 pb-3 text-sm">
          <input type="checkbox" className="size-4" checked={item.active}
            onChange={event => change({ ...item, active: event.target.checked })} />{copy.active}
        </label></>} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Roster label={copy.primary} people={people} value={item.primary} exclude={item.fallback} onChange={primary => change({ ...item, primary })} />
          <Roster label={copy.fallback} people={people} value={item.fallback} exclude={item.primary} onChange={fallback => change({ ...item, fallback })} />
        </div>
        <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, i) => i !== index))}>{copy.remove}</Button>
      </div>;
    })}
    <Button type="button" variant="outline" disabled={value.length >= ROUTING_LIMITS.areas}
      onClick={() => onChange([...value, { code: "", en: "", th: "", active: true, primary: [], fallback: [] }])}>{copy.addArea}</Button>
  </fieldset>;
}

function RulesEditor({ policy, onChange }: { policy: Policy; onChange: (rules: Policy["rules"]) => void }) {
  const { copy, language } = useRoutingCopy();
  return <fieldset className="min-w-0 space-y-3 rounded-lg border border-transparent bg-muted/40 p-3">
    <legend className="px-1 text-sm font-medium">{copy.rules}</legend>
    {policy.rules.map((item, index) => <div className="space-y-1 pb-1" key={index}>
      <div className="grid gap-2 sm:grid-cols-3">
        {([
          { field: "product", choices: policy.products }, { field: "symptom", choices: policy.symptoms },
          { field: "area", choices: policy.areas },
        ] as const).map(({ field, choices }) => <label className="grid gap-1 text-sm" key={field}>{copy[field]}
          <select className={routingSelect} value={item[field]} required onChange={event => {
            onChange(policy.rules.map((rule, i) => i === index ? { ...rule, [field]: event.target.value } : rule));
          }}>
            <option value="">{copy.select}</option>
            {choices.filter(choice => choice.code).map((choice, i) => <option key={i} value={choice.code}>{choice[language] || choice.code}</option>)}
            {item[field] && !choices.some(choice => choice.code === item[field]) && <option value={item[field]} disabled>{item[field]}</option>}
          </select>
        </label>)}
      </div>
      <Button type="button" variant="ghost" onClick={() => onChange(policy.rules.filter((_, i) => i !== index))}>{copy.remove}</Button>
    </div>)}
    <Button type="button" variant="outline" disabled={policy.rules.length >= ROUTING_LIMITS.rules}
      onClick={() => onChange([...policy.rules, { product: "", symptom: "", area: "" }])}>{copy.addRule}</Button>
  </fieldset>;
}

export function RoutingSettingsForm({ projectId, settings }: {
  projectId: Id<"projects">; settings: RoutingSettings;
}) {
  const { t } = useI18n();
  const { copy } = useRoutingCopy();
  const actions = useRoutingActions();
  const [draft, setDraft] = useState(settings.policy);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try { await action(); setMessage(copy.saved); }
    catch (err) { setError(localizeError(err, t)); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const { policyGeneration, areas, products, symptoms, rules, intake, backup } = draft;
    await run(async () => {
      const result = await actions.saveConfiguration({ projectId, expectedGeneration: policyGeneration, expectedEpoch: draft.epoch,
        areas, products, symptoms, rules, intake, backup: backup ?? "" });
      setDraft(current => ({ ...current, ...result }));
    });
  }

  return <div className="space-y-3">
    <form className="space-y-3" onSubmit={save}>
      <fieldset className="grid gap-3 rounded-lg border border-transparent bg-muted/40 p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">{copy.intake}</legend>
        <Roster label={copy.intake} people={settings.people} value={draft.intake} exclude={draft.backup ? [draft.backup] : []}
          onChange={intake => setDraft({ ...draft, intake })} />
        <StaffChoice label={copy.backup} people={settings.people} value={draft.backup ?? ""} exclude={draft.intake}
          onChange={backup => setDraft({ ...draft, backup })} />
      </fieldset>
      {settings.directoryOverflow && <p className="text-sm text-muted-foreground">{copy.directoryOverflow}</p>}
      <AreaEditor value={draft.areas} people={settings.people} onChange={areas => setDraft({ ...draft, areas })} />
      <VocabularyEditor title={copy.products} value={draft.products} onChange={products => setDraft({ ...draft, products })} />
      <VocabularyEditor title={copy.symptoms} value={draft.symptoms} onChange={symptoms => setDraft({ ...draft, symptoms })} />
      <RulesEditor policy={draft} onChange={rules => setDraft({ ...draft, rules })} />
      <Button className="min-h-11" disabled={busy || !draft.intake.length || !draft.backup}>{copy.saveSettings}</Button>
    </form>
    {message && <p role="status" className="text-sm">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
