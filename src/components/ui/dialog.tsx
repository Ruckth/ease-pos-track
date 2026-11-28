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
  dismissible?: boolean;
  initialFocus?: () => HTMLElement | null;
  mobileFullScreen?: boolean;
  mobileWorkspace?: boolean;
  placement?: "center" | "side" | "fullscreen";
  children: React.ReactNode;
};

/**
 * Closing returns focus to the opener when it is still mounted and visible
 * (for example a menu trigger); otherwise to the page's stable fallback.
 */
function useReturnFocus(open: boolean) {
  const opener = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  // Read before Base UI moves focus into the popup on this open transition.
  if (open && !wasOpen.current && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
  wasOpen.current = open;
  return React.useCallback(() => {
    const element = opener.current;
    // A closing popup can finish after the user has entered another dialog.
    const activeDialog = document.activeElement?.closest('[role="dialog"][data-open], [role="alertdialog"][data-open]');
    if (activeDialog && !activeDialog.contains(element)) return false;
    if (element?.isConnected && element.getClientRects().length) return element;
    return document.querySelector<HTMLElement>("[data-dialog-return-focus]") ?? true;
  }, []);
}

export function Dialog({ open, onOpenChange, title, description, dismissible = true, keepMounted = false, mobileFullScreen = false, mobileWorkspace = false, placement = "center", initialFocus, children }: DialogProps) {
  const { t } = useI18n();
  const finalFocus = useReturnFocus(open);
  const side = placement === "side";
  const [popup, setPopup] = React.useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const element = popup;
    const viewport = window.visualViewport;
    if (!open || !mobileWorkspace || !element || !viewport) return;
    const fitViewport = () => {
      // Let browser magnification work normally. A keyboard changes height at the same scale.
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      element.style.setProperty("--dialog-height", `${viewport.height}px`);
      element.style.setProperty("--dialog-top", `${viewport.offsetTop}px`);
    };
    fitViewport();
    viewport.addEventListener("resize", fitViewport);
    viewport.addEventListener("scroll", fitViewport);
    return () => {
      viewport.removeEventListener("resize", fitViewport);
      viewport.removeEventListener("scroll", fitViewport);
    };
  }, [open, mobileWorkspace, popup]);
  return (
    <BaseDialog.Root open={open} onOpenChange={(next, event) => { if (next || dismissible) onOpenChange(next); else event.cancel(); }}>
      <BaseDialog.Portal keepMounted={keepMounted}>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 min-h-dvh aurora-scrim transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <BaseDialog.Popup ref={mobileWorkspace ? setPopup : undefined} initialFocus={initialFocus} finalFocus={finalFocus} className={cn(
          "aurora-dialog fixed z-50 overflow-auto outline-none",
          (side || placement === "fullscreen")
            ? "inset-0 max-h-dvh rounded-none"
            : mobileFullScreen
            ? "inset-x-2 bottom-[max(.5rem,env(safe-area-inset-bottom))] max-h-[calc(100dvh-max(.75rem,env(safe-area-inset-top))-max(.5rem,env(safe-area-inset-bottom)))] rounded-[1.25rem]"
            : "inset-x-2 bottom-[max(.5rem,env(safe-area-inset-bottom))] max-h-[calc(100dvh-max(.5rem,env(safe-area-inset-top))-max(.5rem,env(safe-area-inset-bottom)))] rounded-2xl",
          side
            ? "md:left-auto md:w-[min(42rem,75%)]"
            : placement === "center" && "sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-h-[calc(100dvh-2rem)] sm:rounded-[1.25rem]",
          mobileWorkspace && "max-sm:inset-x-0 max-sm:bottom-auto max-sm:top-[var(--dialog-top,0px)] max-sm:flex max-sm:h-[var(--dialog-height,100dvh)] max-sm:max-h-none max-sm:flex-col max-sm:overflow-hidden max-sm:rounded-none",
          "motion-safe:transition-[transform,opacity] data-ending-style:opacity-0 data-starting-style:opacity-0",
        )}>
          <div className={cn("aurora-dialog-edge sticky top-0 z-20 flex shrink-0 items-start justify-between gap-3 border-b border-border/50 px-4 py-3.5 sm:px-5 sm:py-4", mobileWorkspace && "max-sm:items-center max-sm:px-3 max-sm:pb-1 max-sm:pt-[calc(.25rem+env(safe-area-inset-top))]")}>
            <div className="min-w-0">
              <BaseDialog.Title className={cn("break-words text-xl font-semibold leading-6 tracking-tight", mobileWorkspace && "max-sm:truncate max-sm:text-lg")}>{title}</BaseDialog.Title>
              {description ? <BaseDialog.Description className={cn("mt-1 text-sm text-muted-foreground", mobileWorkspace && "max-sm:sr-only")}>{description}</BaseDialog.Description> : null}
            </div>
            <BaseDialog.Close disabled={!dismissible} className="aurora-control inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground disabled:opacity-50 hover:bg-field hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("closeDialog")}>
              <X className="size-4" />
            </BaseDialog.Close>
          </div>
          <div className={cn("aurora-dialog-body p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5", placement === "fullscreen" && "mx-auto max-w-4xl", mobileWorkspace && "w-full max-sm:flex max-sm:min-h-0 max-sm:flex-1 max-sm:flex-col max-sm:overflow-y-auto max-sm:px-3 max-sm:pt-2 max-sm:pb-[calc(.5rem+env(safe-area-inset-bottom))]")}>{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
