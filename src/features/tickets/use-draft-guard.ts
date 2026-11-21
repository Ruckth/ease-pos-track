import { useBlocker } from "@tanstack/react-router";
import { useRef } from "react";
import { useI18n } from "@/lib/i18n";

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
    shouldBlockFn: async ({ current, next }) => {
      if (signingOut.current) return false;
      const leaving = current.pathname !== next.pathname;
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
    } finally {
      signingOut.current = false;
    }
  };
}
