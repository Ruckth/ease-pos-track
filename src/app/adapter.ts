import { useAction, useMutation, useQuery } from "convex/react";
import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useOauth } from "@convex-dev/auth/methods/oauth/react";
import { useSignInWithGoogle } from "@convex-dev/auth/methods/google/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

type TokenResult = { status: "complete"; tokens: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number; userId: string } }
  | { status: "error"; userError: { error: string; retryAfterMs?: number } };

/** The live session's principal, or null when signed out, stale or disabled. */
export function useViewer() { return useQuery(api.identity.viewer, {}); }

export function useSessionActions() {
  const { signOut } = useAuthActions();
  return { signOut };
}

/** The access token for the upload server's per-request Convex client. */
export function useAccessToken() { return useAuthToken(); }

/** Sign-in results are stored only after the server committed admission. */
function useSessionResult() {
  const { setSession } = useAuthActions();
  return async (result: TokenResult) => {
    if (result.status === "complete") await setSession(result.tokens);
    return result;
  };
}

export function usePasswordSignIn() {
  const signIn = useAction(api.auth.signInWithPassword);
  const store = useSessionResult();
  return async (username: string, password: string) => await store(await signIn({ username, password }));
}

export function useInvitationSignUp() {
  const signUp = useMutation(api.auth.signUpWithInvitation);
  const store = useSessionResult();
  return async (input: { invitation: string; username: string; displayName: string; password: string }) =>
    await store(await signUp(input) as TokenResult);
}

export function useGoogleSignIn() {
  const { signIn } = useSignInWithGoogle(api.auth);
  const { flowError } = useOauth();
  return { signIn, flowError };
}

/** Disposable local backend only: stands in for Google with a seeded staff member. */
export function useLocalFixtureSignIn() {
  const signIn = useMutation(api.auth.signInLocalFixture);
  const store = useSessionResult();
  return async (email: string) => await store(await signIn({ email }) as TokenResult);
}

export function useRecovery() { return useMutation(api.auth.recoverWithCode); }
export function useChangePassword() { return useMutation(api.auth.changePassword); }
export function useConfirmRecoveryEnrollment() { return useMutation(api.identity.confirmRecoveryEnrollment); }
export function useCreateRecoveryCode() { return useMutation(api.identity.createRecoveryCode); }

export function useCustomerInvitation(invitation: string) {
  return {
    preview: useQuery(api.identity.previewCustomerInvitation, invitation ? { invitation } : "skip"),
    join: useMutation(api.identity.joinWithInvitation),
  };
}

export function useStaffInvitation(invitation: string) {
  return {
    preview: useQuery(api.identity.previewStaffInvitation, invitation ? { invitation } : "skip"),
    sendCode: useAction(api.identity.sendChallengeCode),
    accept: useMutation(api.identity.acceptStaffInvitation),
  };
}

export function useTeamAdministration(open: boolean) {
  return {
    team: useQuery(api.identity.listTeam, open ? {} : "skip"),
    invite: useMutation(api.identity.inviteStaff),
    reissue: useMutation(api.identity.reissueStaffInvitation),
    revoke: useMutation(api.identity.revokeStaffInvitation),
    sendCode: useAction(api.identity.sendChallengeCode),
    setRole: useMutation(api.identity.setStaffRole),
    setAccess: useMutation(api.identity.setStaffAccess),
    changeGoogleBinding: useMutation(api.identity_staff_recovery.changeBinding),
  };
}

export function useProjects() { return useQuery(api.projects.listProjects, {}); }
export function useCreateProject() { return useMutation(api.projects.createProject); }
export function useProjectMembers(projectId: Id<"projects">, open: boolean, owner: boolean) {
  return {
    members: useQuery(api.projects.listProjectMembers, open ? { projectId } : "skip"),
    invitations: useQuery(api.identity.listCustomerInvitations, open && owner ? { projectId } : "skip"),
    createInvitation: useMutation(api.identity.createCustomerInvitation),
    revokeInvitation: useMutation(api.identity.revokeCustomerInvitation),
    removeMember: useMutation(api.projects.removeProjectMember),
    setAccess: useMutation(api.identity.setCustomerAccess),
  };
}
