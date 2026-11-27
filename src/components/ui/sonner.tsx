import { Toaster } from "sonner";

/**
 * Notifications on a neutral surface: severity shows in the coloured icon, not
 * the background. Message text, roles, timeouts and actions stay with callers.
 */
export function AppToaster({ theme }: { theme: "light" | "dark" }) {
  return <Toaster theme={theme} position="bottom-right" toastOptions={{
    classNames: {
      toast: "app-toast",
      title: "app-toast-title",
      description: "app-toast-description",
      actionButton: "app-toast-action",
      cancelButton: "app-toast-cancel",
      success: "app-toast-success",
      error: "app-toast-error",
      warning: "app-toast-warning",
      info: "app-toast-info",
    },
  }} />;
}
