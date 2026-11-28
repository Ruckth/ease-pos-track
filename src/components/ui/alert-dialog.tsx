import * as React from "react";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type AlertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  keepOpen?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
};

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  keepOpen, busy, confirmDisabled, children,
}: AlertDialogProps) {
  const { t } = useI18n();
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={(next, details) => { if (busy && !next) details.cancel(); else onOpenChange(next); }}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="fixed inset-0 z-[60] aurora-scrim transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <BaseAlertDialog.Popup className={cn(
          "fixed left-1/2 top-[calc((100dvh+env(safe-area-inset-top)-env(safe-area-inset-bottom))/2)] z-[60] max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1rem)] overflow-auto w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 aurora-dialog rounded-2xl p-6 text-card-foreground outline-none",
          "transition-[transform,opacity] data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
        )}>
          <BaseAlertDialog.Title className="text-base font-semibold">{title}</BaseAlertDialog.Title>
          <BaseAlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </BaseAlertDialog.Description>
          {children}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <BaseAlertDialog.Close disabled={busy} className={buttonVariants({ variant: "outline" })}>
              {t("cancel")}
            </BaseAlertDialog.Close>
            {keepOpen
              ? <button type="button" aria-disabled={busy || confirmDisabled || undefined} className={buttonVariants({ variant: "destructive" })}
                  onClick={() => { if (!busy && !confirmDisabled) onConfirm(); }}>{confirmLabel}</button>
              : <BaseAlertDialog.Close className={buttonVariants({ variant: "destructive" })} onClick={onConfirm}>
                  {confirmLabel}
                </BaseAlertDialog.Close>}
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
