import { useBlocker } from "@tanstack/react-router";
import { useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { APP_PATHS, normalizePathname } from "@/lib/app-routes";

function workspacePath(path: string) {
  const normalized = normalizePathname(path);
  return normalized === APP_PATHS.staffT3Settings ? APP_PATHS.staffHome : normalized;
}

/** The composer survives search and Project changes. Only leaving the workspace
 * discards its contents. An active upload must settle before changing Projects. */
export function useDraftGuard(
  hasDraft: boolean,
  busy: boolean,
  cancelAndSettle: () => Promise<void>,
  logout: () => Promise<void>,
) {
  const { t } = useI18n();
  const signingOut = useRef(false);
  useBlocker({
    disabled: !hasDraft && !busy,
    enableBeforeUnload: () => !signingOut.current,
    shouldBlockFn: async ({ current, next }) => {
      if (signingOut.current) return false;
      const leaving = workspacePath(current.pathname) !== workspacePath(next.pathname);
      const project = "project" in current.search ? current.search.project : undefined;
      const nextProject = "project" in next.search ? next.search.project : undefined;
      if (!leaving && (!busy || project === nextProject)) return false;
      if (!window.confirm(t(leaving ? "leaveTicketDraft" : "switchDuringUpload"))) return true;
      await cancelAndSettle();
      return false;
    },
  });

  return async () => {
    if (signingOut.current || ((hasDraft || busy) && !window.confirm(t("leaveTicketDraft")))) return;
    signingOut.current = true;
    try {
      await cancelAndSettle();
      await logout();
    } catch (error) {
      signingOut.current = false;
      throw error;
    }
    // A successful sign-out reloads the document. Keep beforeunload disarmed
    // until it leaves, including the interval after the request resolves.
  };
}
