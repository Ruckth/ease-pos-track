/**
 * Which deployment a command talks to, and how that choice is phrased back to
 * the caller.
 *
 * Development is the default everywhere; production is only ever reached when
 * `--prod` was passed, so every URL source, hint and Keychain item is keyed by
 * this target rather than inferred from the other one.
 */

import { authError, EXIT, TicketCliError } from "./errors";
import type { TicketConfig } from "./config";

export type Deployment = "dev" | "prod";

/**
 * A malformed or unsafe URL is a usage error with no hint: the caller has to
 * supply a different value, not run a different command.
 */
function invalidUrlError(message: string) {
  return new TicketCliError("INVALID_DEPLOYMENT_URL", message, EXIT.usage);
}

/** The `--prod` suffix a caller must repeat to stay on the same deployment. */
function deploymentFlag(target: Deployment) {
  return target === "prod" ? " --prod" : "";
}

export function deploymentLabel(target: Deployment) {
  return target === "prod" ? "production" : "development";
}

/** A copy-and-paste `pnpm ticket …` command for the deployment in play. */
export function ticketCommand(command: string, target: Deployment) {
  return `pnpm ticket ${command}${deploymentFlag(target)}`;
}

export function authHint(target: Deployment) {
  return `Run \`${ticketCommand("login", target)}\`.`;
}

export function normalizeDeploymentUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidUrlError("The deployment URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalidUrlError("The deployment URL must be an http(s) origin without credentials, a query, or a fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

/** Environment variables consulted for a deployment URL, in precedence order. */
const URL_ENVIRONMENT_KEYS: Record<Deployment, readonly string[]> = {
  dev: ["TICKET_CONVEX_URL", "CONVEX_URL", "VITE_CONVEX_URL"],
  prod: ["TICKET_CONVEX_PROD_URL"],
};

/**
 * Resolves the deployment URL from the explicit override, then saved
 * configuration, then the environment. Production never falls back to a
 * development variable.
 */
export function deploymentUrl(
  config: TicketConfig | null,
  target: Deployment,
  override: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  const fromEnv = URL_ENVIRONMENT_KEYS[target].map((key) => env[key]).find((value) => value !== undefined);
  const value = override ?? config?.deployments[target]?.url ?? fromEnv;
  if (!value) {
    throw authError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `No ${deploymentLabel(target)} deployment URL is configured.`,
      `Run \`${ticketCommand("login", target)} --url <deployment-url>\`.`,
    );
  }
  return normalizeDeploymentUrl(value);
}
