import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { useStaffCopy } from "@/lib/staff-copy";

/** The reference with its Copy action. When clipboard writes fail, the full reference is shown selected for a manual copy. */
export function TicketReferenceCopy({ reference }: { reference: string }) {
  const { t } = useI18n();
  const s = useStaffCopy();
  const [manual, setManual] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!manual) return;
    field.current?.focus();
    field.current?.select();
  }, [manual]);
  const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C";
  return <span className="inline-flex min-w-0 flex-col gap-1">
    <button type="button" className="-ms-1 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 font-mono text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${t("copy")} ${reference}`} onClick={async () => {
      try { await navigator.clipboard.writeText(reference); setManual(false); toast.success(t("ticketCopied")); }
      catch {
        if (manual) { field.current?.focus(); field.current?.select(); }
        setManual(true);
      }
    }}>{reference}<Copy aria-hidden className="size-3.5" /></button>
    {manual && <span className="flex flex-col gap-1">
      <label className="sr-only" htmlFor="ticket-reference-manual">{s.reference}</label>
      <input id="ticket-reference-manual" ref={field} readOnly value={reference} aria-describedby="ticket-reference-manual-hint"
        className="aurora-control min-h-11 w-40 rounded-md px-2 font-mono text-sm" onFocus={event => event.currentTarget.select()} />
      <span id="ticket-reference-manual-hint" role="status" className="max-w-xs text-xs text-muted-foreground">{s.copyManual(shortcut)}</span>
    </span>}
  </span>;
}
