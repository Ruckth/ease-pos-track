import { Search, X } from "lucide-react";
import { useId, useRef } from "react";
import { MAX_WORKSPACE_QUERY_LENGTH } from "@/app/workspace-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";

export function TicketSearchInput({ value, onChange, onClear, className, label }: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  className?: string;
  /** A scope-aware accessible name, such as the open Project. */
  label?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return <div className={className}>
    <label htmlFor={id} className="sr-only">{label ?? t("search")}</label>
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input id={id} ref={input} className="min-h-11 rounded-lg pl-9 pr-12 font-normal" placeholder={t("search")} enterKeyHint="search" autoComplete="off"
        maxLength={MAX_WORKSPACE_QUERY_LENGTH} value={value} onChange={event => onChange(event.target.value)} />
      {value && <Button type="button" variant="ghost" size="icon-touch" aria-label={t("clearSearch")}
        className="absolute right-0 top-1/2 -translate-y-1/2 rounded-lg text-muted-foreground"
        onClick={() => { input.current?.focus({ preventScroll: true }); onClear(); }}>
        <X aria-hidden="true" />
      </Button>}
    </div>
  </div>;
}
