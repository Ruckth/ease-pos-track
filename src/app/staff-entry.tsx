import { getRouteApi, useMatch } from "@tanstack/react-router";
import { StaffWorkspace } from "@/features/tickets/staff-workspace";
import { APP_PATHS, loginPathForRole } from "@/lib/app-routes";
import { useLeave, useSessionExpiry } from "./auth-store";
import { SessionBoundary } from "./session-boundary";

const route = getRouteApi("/staff");

/** Lazy staff chunk: the board and drag-and-drop never load for customers. */
export function StaffEntry() {
  const { viewer } = route.useRouteContext();
  const navigate = route.useNavigate();
  const t3Settings = useMatch({ from: "/staff/settings/t3", shouldThrow: false }) !== undefined;
  const lineSettings = useMatch({ from: "/staff/settings/line", shouldThrow: false });
  const leave = useLeave();
  const onExpired = useSessionExpiry(loginPathForRole("staff"));
  if (viewer?.kind !== "staff") return null;
  const onLogout = () => leave(loginPathForRole("staff"));
  return (
    <SessionBoundary key={viewer.staffId} onExpired={onExpired}>
      <StaffWorkspace viewer={viewer} onLogout={onLogout} t3Settings={t3Settings}
        lineSettings={lineSettings?.search}
        onLineSettings={(open, bot) => {
          if (open) void navigate({ to: APP_PATHS.staffLineSettings, search: previous => ({ ...previous, bot }), resetScroll: false });
          else void navigate({ to: APP_PATHS.staffHome, search: true, resetScroll: false });
        }}
        onT3Settings={open => void navigate({ to: open ? APP_PATHS.staffT3Settings : APP_PATHS.staffHome, search: true, state: true, resetScroll: false })} />
    </SessionBoundary>
  );
}
