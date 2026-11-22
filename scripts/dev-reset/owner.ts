import type { Snapshot } from "./snapshot";

/** Only the rows written by the local bootstrap or the first Google sign-in and bootstrap. */
export function hasBootstrappedOwner(snapshot: Snapshot, subject: string | undefined, local: boolean) {
  const tables = ["staff", "users", "identityAudit"];
  const accountTable = "_components/authGoogle/accounts";
  const createdUserTable = "_components/auth/createdUserIds";
  const refreshTokenTable = "_components/auth/refreshTokens";
  if (!local) tables.push(accountTable, createdUserTable, "googleFlows", "sessionAdmissions");
  const allowed = local ? tables : [...tables, refreshTokenTable];
  if (!subject || tables.some(table => snapshot[table]?.length !== 1)
    || Object.entries(snapshot).some(([table, rows]) => rows.length && !allowed.includes(table))) return false;

  const [staff] = snapshot.staff;
  const [user] = snapshot.users;
  const [audit] = snapshot.identityAudit;
  if (staff.role !== "owner" || staff.status !== "active" || staff.generation !== 1
    || staff.googleSubject !== subject || staff.pilotEpoch !== undefined || staff.userId !== user._id
    || user.kind !== "staff" || user.staffId !== staff._id || user.customerId !== undefined
    || user.googleSubject !== subject || user.googleEmailVerified !== true || !user.googleEmail || user.googleEmail !== staff.email
    || audit.action !== "owner.bootstrapped" || audit.staffId !== staff._id) return false;
  if (local) return true;

  const [account] = snapshot[accountTable];
  const [createdUser] = snapshot[createdUserTable];
  const [flow] = snapshot.googleFlows;
  const [admission] = snapshot.sessionAdmissions;
  // Sign-out deletes the session immediately and schedules removal of its single, unused token.
  const tokens = snapshot[refreshTokenTable] ?? [];
  return account.providerAccountId === subject && account.userId === user._id && createdUser.userId === user._id
    && typeof flow.consumedAt === "number" && flow.pilotEpoch === undefined
    && admission.userId === user._id && admission.principal === "pending" && admission.method === "google"
    && admission.generation === 0 && admission.staffId === undefined && admission.customerId === undefined
    && typeof admission.revokedAt === "number" && admission.pilotEpoch === undefined
    && typeof admission.authSessionId === "string" && admission.authSessionId.length > 0
    && tokens.length <= 1 && tokens.every(token => token.sessionId === admission.authSessionId && token.state === "issued");
}
