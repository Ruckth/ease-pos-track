/**
 * Persistent staff-session policy behind three operations. Callers do not need
 * to know config creation order, deployment binding, expiry cleanup, or role
 * validation rules.
 */

import { loadOrCreateConfig, type ConfigStore } from "./config";
import { authHint, deploymentUrl, type Deployment } from "./deployment";
import { authError, type TicketCliError } from "./errors";
import type { CredentialStore } from "./keychain";
import type { CurrentSession, TicketRemote } from "./remote";

/** An auth failure a fresh login can fix, hinted for the deployment in play. */
export function credentialError(code: string, message: string, target: Deployment) {
  return authError(code, message, authHint(target));
}

export type SessionAccessDeps = {
  remote: Pick<TicketRemote, "login" | "currentSession" | "logout">;
  config: ConfigStore;
  credentials: CredentialStore;
  now: () => number;
  env: NodeJS.ProcessEnv;
};

export type StaffAccess = {
  url: string;
  token: string;
  session: CurrentSession & { role: "staff" };
};

export class TicketSessions {
  constructor(private readonly deps: SessionAccessDeps) {}

  /**
   * Binds the deployment URL and the machine client id before authenticating, so
   * a failed login still leaves the deployment configured for a retry.
   */
  async login(target: Deployment, urlOverride: string | undefined, password: string) {
    const config = await loadOrCreateConfig(this.deps.config);
    const url = deploymentUrl(config, target, urlOverride, this.deps.env);
    config.deployments[target] = { url };
    await this.deps.config.save(config);
    if (!password) throw credentialError("PASSWORD_REQUIRED", "A staff password is required.", target);

    const result = await this.deps.remote.login(url, password, config.clientId);
    await this.deps.credentials.set(target, { token: result.token, expiresAt: result.expiresAt, url });
    return { url, expiresAt: result.expiresAt };
  }

  /**
   * Revokes the session server-side, then drops the local record either way, so
   * an already-invalid session can still be cleaned up.
   */
  async logout(target: Deployment) {
    const credential = await this.deps.credentials.get(target);
    if (!credential) return false;
    try {
      await this.deps.remote.logout(credential.url, credential.token);
    } finally {
      await this.deps.credentials.delete(target);
    }
    return true;
  }

  /**
   * The gate every live Ticket operation passes through: a locally valid,
   * deployment-matched credential that the deployment still recognizes as staff.
   */
  async requireStaff(target: Deployment): Promise<StaffAccess> {
    const url = deploymentUrl(await this.deps.config.load(), target, undefined, this.deps.env);
    const credential = await this.deps.credentials.get(target);
    if (!credential) throw credentialError("NOT_LOGGED_IN", "No saved Ticket session was found.", target);
    if (credential.url !== url) {
      throw credentialError("SESSION_DEPLOYMENT_MISMATCH", "The saved Ticket session belongs to a different deployment URL.", target);
    }
    if (credential.expiresAt <= this.deps.now()) {
      throw await this.forget(target, credentialError("SESSION_EXPIRED", "The saved Ticket session has expired.", target));
    }

    const session = await this.deps.remote.currentSession(url, credential.token);
    if (!session) {
      throw await this.forget(target, credentialError("SESSION_INVALID", "The saved Ticket session is no longer valid.", target));
    }
    if (session.role !== "staff") {
      await this.deps.remote.logout(url, credential.token);
      throw await this.forget(target, credentialError("NOT_AUTHORIZED", "The saved session is not a staff session.", target));
    }
    return { url, token: credential.token, session: { ...session, role: "staff" } };
  }

  /** Drops a credential the deployment or the clock has already invalidated. */
  private async forget(target: Deployment, error: TicketCliError) {
    await this.deps.credentials.delete(target);
    return error;
  }
}
