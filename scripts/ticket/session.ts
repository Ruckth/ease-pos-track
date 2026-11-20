/**
 * Persistent staff-session policy behind three operations. Callers do not need
 * to know config creation order, deployment binding, expiry cleanup, or role
 * validation rules.
 */

import { loadOrCreateConfig, type ConfigStore } from "./config";
import { authHint, deploymentUrl, type Deployment } from "./deployment";
import { authError, type TicketCliError } from "./errors";
import type { CredentialStore } from "./keychain";
import type { CurrentSession, SessionTokens, TicketRemote } from "./remote";

/** An auth failure a fresh login can fix, hinted for the deployment in play. */
export function credentialError(code: string, message: string, target: Deployment) {
  return authError(code, message, authHint(target));
}

type SessionAccessDeps = {
  remote: Pick<TicketRemote, "refresh" | "currentSession" | "logout">;
  /** Interactive named sign-in (Google, or the local test provider). */
  signIn: (url: string) => Promise<SessionTokens | null>;
  config: ConfigStore;
  credentials: CredentialStore;
  now: () => number;
  env: NodeJS.ProcessEnv;
};

export type StaffAccess = {
  url: string;
  /** The short-lived access JWT for this run. */
  token: string;
  session: CurrentSession & { role: "staff"; expiresAt: number };
};

export class TicketSessions {
  constructor(private readonly deps: SessionAccessDeps) {}

  /**
   * Binds the deployment URL and the machine client id before authenticating, so
   * a failed sign-in still leaves the deployment configured for a retry. Only the
   * rotating refresh token is stored; access tokens live for one run. The
   * interactive sign-in runs outside the session lock so other runs are not held
   * up for its duration.
   */
  async login(target: Deployment, urlOverride: string | undefined) {
    const { config, credentials } = this.deps;
    const url = await credentials.exclusive(async () => {
      const saved = await loadOrCreateConfig(config);
      const url = deploymentUrl(saved, target, urlOverride, this.deps.env);
      saved.deployments[target] = { url };
      await config.save(saved);
      return url;
    });
    const tokens = await this.deps.signIn(url);
    if (!tokens) throw credentialError("SIGN_IN_FAILED", "The named sign-in did not complete.", target);
    return await credentials.exclusive(async () => {
      await credentials.set(target, { token: tokens.refreshToken, expiresAt: tokens.refreshTokenExpiresAt, url });
      const session = await this.deps.remote.currentSession(url, tokens.accessToken);
      if (session?.role !== "staff") {
        await this.revoke(target);
        throw credentialError("NOT_AUTHORIZED", "The signed-in account is not an active staff member.", target);
      }
      return { url, expiresAt: tokens.refreshTokenExpiresAt };
    });
  }

  /**
   * Revokes the session server-side, then drops the local record either way, so
   * an already-invalid session can still be cleaned up.
   */
  async logout(target: Deployment) {
    return await this.deps.credentials.exclusive(() => this.revoke(target));
  }

  /**
   * The gate every live Ticket operation passes through: a locally valid,
   * deployment-matched refresh credential that rotates into a live session the
   * deployment still admits as staff. The whole read-rotate-write runs under the
   * session lock: a concurrent run would otherwise rotate the same single-use
   * token, fail, and delete the credential the winner just saved.
   */
  async requireStaff(target: Deployment): Promise<StaffAccess> {
    return await this.deps.credentials.exclusive(() => this.rotateStaff(target));
  }

  private async rotateStaff(target: Deployment): Promise<StaffAccess> {
    const url = deploymentUrl(await this.deps.config.load(), target, undefined, this.deps.env);
    const credential = await this.deps.credentials.get(target);
    if (!credential) throw credentialError("NOT_LOGGED_IN", "No saved Ticket session was found.", target);
    if (credential.url !== url) {
      throw credentialError("SESSION_DEPLOYMENT_MISMATCH", "The saved Ticket session belongs to a different deployment URL.", target);
    }
    if (credential.expiresAt <= this.deps.now()) {
      throw await this.forget(target, credentialError("SESSION_EXPIRED", "The saved Ticket session has expired.", target));
    }
    const rotated = await this.deps.remote.refresh(url, credential.token);
    if (!rotated) {
      throw await this.forget(target, credentialError("SESSION_INVALID", "The saved Ticket session is no longer valid.", target));
    }
    await this.deps.credentials.set(target, { token: rotated.refreshToken, expiresAt: rotated.refreshTokenExpiresAt, url });
    const session = await this.deps.remote.currentSession(url, rotated.accessToken);
    if (!session) {
      throw await this.forget(target, credentialError("SESSION_INVALID", "The saved Ticket session is no longer valid.", target));
    }
    if (session.role !== "staff") {
      await this.deps.remote.logout(url, rotated.refreshToken);
      throw await this.forget(target, credentialError("NOT_AUTHORIZED", "The saved session is not a staff session.", target));
    }
    return { url, token: rotated.accessToken, session: { ...session, role: "staff", expiresAt: rotated.refreshTokenExpiresAt } };
  }

  /** Caller holds the session lock. */
  private async revoke(target: Deployment) {
    const credential = await this.deps.credentials.get(target);
    if (!credential) return false;
    try {
      await this.deps.remote.logout(credential.url, credential.token);
    } finally {
      await this.deps.credentials.delete(target);
    }
    return true;
  }

  /** Drops a credential the deployment or the clock has already invalidated. Caller holds the session lock. */
  private async forget(target: Deployment, error: TicketCliError) {
    await this.deps.credentials.delete(target);
    return error;
  }
}
