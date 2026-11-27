import { useId, type ReactNode, type Ref } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface TicketFilterPopoverProps {
  activeCount: number;
  children: ReactNode;
  triggerRef?: Ref<HTMLButtonElement>;
  onClear: () => void;
}

export function TicketFilterPopover({ activeCount, children, triggerRef, onClear }: TicketFilterPopoverProps) {
  const { t } = useI18n();
  const label = activeCount > 0 ? t("ticketFiltersApplied", { count: activeCount }) : t("ticketFilters");

  return (
    <Popover>
      <PopoverTrigger
        data-slot="ticket-filter-trigger"
        render={<Button ref={triggerRef} type="button" variant="outline" size="icon-touch" className="group relative shrink-0" />}
        aria-label={label}
      >
        <Filter aria-hidden="true" />
        {activeCount > 0 && (
          <span
            aria-hidden="true"
            data-slot="ticket-filter-indicator"
            className={cn(
              "pointer-events-none absolute rounded-full group-data-[popup-open]:hidden",
              activeCount === 1
                ? "end-1.5 top-1.5 size-2 bg-orange-700 dark:bg-orange-400"
                : "end-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center bg-orange-700 px-0.5 text-[10px] font-semibold leading-none text-white",
            )}
          >
            {activeCount > 1 && activeCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent data-slot="ticket-filter-panel" align="end" sideOffset={8} className="w-[28rem] gap-3 overflow-hidden p-3 sm:p-4">
        <PopoverTitle className="shrink-0 text-base font-semibold">{t("ticketFilters")}</PopoverTitle>
        <div className="min-h-0 min-w-0 space-y-3 overflow-y-auto overscroll-contain px-1 py-1">{children}</div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-3">
          <Button type="button" size="sm" variant="ghost" onClick={onClear}>{t("ticketFiltersClear")}</Button>
          <PopoverPrimitive.Close render={<Button type="button" size="sm" />}>
            {t("ticketFiltersDone")}
          </PopoverPrimitive.Close>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FilterChoices<Value extends string>({ label, options, value, onChange }: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: string; count?: number }>;
  value: Value;
  onChange: (value: Value) => void;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {options.map(option => (
        <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm hover:bg-field has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <input type="radio" name={name} value={option.value} checked={value === option.value}
            onChange={() => onChange(option.value)} className="size-4 shrink-0 accent-primary" />
          <span className="flex-1">{option.label}</span>
          {option.count !== undefined && <span className="tabular-nums text-muted-foreground">({option.count})</span>}
        </label>
      ))}
    </fieldset>
  );
}
