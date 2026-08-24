import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  keepMounted?: boolean;
  mobileFullScreen?: boolean;
  children: React.ReactNode;
};

export function Dialog({ open, onOpenChange, title, description, keepMounted = false, mobileFullScreen = false, children }: DialogProps) {
  const { t } = useI18n();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal keepMounted={keepMounted}>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 min-h-dvh bg-black/45 backdrop-blur-[2px] transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <BaseDialog.Popup className={cn(
          "fixed z-50 overflow-auto bg-background shadow-2xl outline-none",
          mobileFullScreen
            ? "inset-0 max-h-dvh rounded-none border-0"
            : "bottom-0 left-0 right-0 max-h-[calc(100dvh-0.5rem)] rounded-t-2xl border-x-0 border-b-0",
          "sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border",
          "transition-[transform,opacity] data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
        )}>
          <div className="sticky top-0 z-20 flex items-start justify-between gap-3 border-b bg-background/95 px-4 py-3.5 backdrop-blur sm:px-5 sm:py-4">
            <div className="min-w-0">
              <BaseDialog.Title className="break-words text-base font-semibold leading-6">{title}</BaseDialog.Title>
              {description ? <BaseDialog.Description className="mt-1 text-sm text-muted-foreground">{description}</BaseDialog.Description> : null}
            </div>
            <BaseDialog.Close className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("closeDialog")}>
              <X className="size-4" />
            </BaseDialog.Close>
          </div>
          <div className="p-4 sm:p-5">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
