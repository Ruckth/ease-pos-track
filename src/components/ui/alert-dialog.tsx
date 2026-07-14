import * as React from "react";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AlertDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: AlertDialogProps) {
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[1px] transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <BaseAlertDialog.Popup className={cn(
          "fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 shadow-xl outline-none",
          "transition-[transform,opacity] data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
        )}>
          <BaseAlertDialog.Title className="text-base font-semibold">{title}</BaseAlertDialog.Title>
          <BaseAlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </BaseAlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <BaseAlertDialog.Close className={buttonVariants({ variant: "outline" })}>
              Cancel
            </BaseAlertDialog.Close>
            <BaseAlertDialog.Close
              className={buttonVariants({ variant: "destructive" })}
              onClick={onConfirm}
            >
              {confirmLabel}
            </BaseAlertDialog.Close>
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
