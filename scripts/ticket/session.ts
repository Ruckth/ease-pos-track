import { EXIT, TicketCliError, type Deployment } from "./cli";
import type { CurrentSession, TicketRemote } from "./remote";
import {
  deploymentUrl,
  loadOrCreateConfig,
  type ConfigStore,
  type CredentialStore,
} from "./stores";

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

export function authHint(target: Deployment) {
  return `Run \`pnpm ticket login${target === "prod" ? " --prod" : ""}\`.`;
}

export function credentialError(code: string, message: string, target: Deployment) {
  return new TicketCliError(code, message, EXIT.auth, authHint(target));
}

/**
 * Persistent staff-session policy behind three operations. Callers do not need
 * to know config creation order, deployment binding, expiry cleanup, or role
 * validation rules.
 */
export class TicketSessions {
  constructor(private readonly deps: SessionAccessDeps) {}

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

  async requireStaff(target: Deployment): Promise<StaffAccess> {
    const config = await this.deps.config.load();
    const url = deploymentUrl(config, target, undefined, this.deps.env);
    const credential = await this.deps.credentials.get(target);
    if (!credential) throw credentialError("NOT_LOGGED_IN", "No saved Ticket session was found.", target);
    if (credential.url !== url) {
      throw credentialError("SESSION_DEPLOYMENT_MISMATCH", "The saved Ticket session belongs to a different deployment URL.", target);
    }
    if (credential.expiresAt <= this.deps.now()) {
      await this.deps.credentials.delete(target);
      throw credentialError("SESSION_EXPIRED", "The saved Ticket session has expired.", target);
    }

    const session = await this.deps.remote.currentSession(url, credential.token);
    if (!session) {
      await this.deps.credentials.delete(target);
      throw credentialError("SESSION_INVALID", "The saved Ticket session is no longer valid.", target);
    }
    if (session.role !== "staff") {
      await this.deps.remote.logout(url, credential.token);
      await this.deps.credentials.delete(target);
      throw new TicketCliError("NOT_AUTHORIZED", "The saved session is not a staff session.", EXIT.auth, authHint(target));
    }
    return { url, token: credential.token, session: session as CurrentSession & { role: "staff" } };
  }
}
