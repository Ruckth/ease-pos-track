type Environment = Record<string, string | undefined>;

export const pilotEnvironmentKeys = [
  "TICKET_DEPLOYMENT_MODE",
  "TICKET_PILOT_EPOCH",
  "TICKET_PILOT_PREVIOUS_EPOCH",
  "TICKET_PILOT_MANIFEST_SHA256",
  "TICKET_PILOT_TRAFFIC",
  "TICKET_PILOT_INVITATIONS",
  "TICKET_PILOT_IDENTITY_SENDER",
  "TICKET_RETENTION_HOLD",
  "MEDIA_CLEANUP_ENABLED",
  "UPLOADTHING_TOKEN",
  "UPLOADTHING_SECRET",
  "UPLOADTHING_APP_ID",
  "UPLOAD_CALLBACK_SECRET",
  "APP_PASSWORD",
  "T3_DOCTOR_ENABLED",
  "T3_DOCTOR_ISSUANCE_ENABLED",
  "LOCAL_FIXTURES_ENABLED",
] as const;

export function legacyMode(env: Environment, allowDisposableDefault = false) {
  return (env.TICKET_DEPLOYMENT_MODE === "legacy"
    || (env.TICKET_DEPLOYMENT_MODE === undefined && allowDisposableDefault))
    && pilotEnvironmentKeys.every(key => !key.startsWith("TICKET_PILOT_") || env[key] === undefined);
}

export function isLoopbackOrigin(value: string | undefined) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value ?? "").hostname); }
  catch { return false; }
}

/** Operator hold for incident or legal preservation. Anything but absent or exactly "false" holds. */
export function retentionHeld(env: Environment) {
  return env.TICKET_RETENTION_HOLD !== undefined && env.TICKET_RETENTION_HOLD !== "false";
}

export const pilotDigestPattern = /^[a-f0-9]{64}$/;

export function readPilotSettings(env: Environment) {
  const epoch = env.TICKET_PILOT_EPOCH;
  const previousEpoch = env.TICKET_PILOT_PREVIOUS_EPOCH;
  const manifestDigest = env.TICKET_PILOT_MANIFEST_SHA256;
  const traffic = env.TICKET_PILOT_TRAFFIC;
  const invitations = env.TICKET_PILOT_INVITATIONS;
  const identitySender = env.TICKET_PILOT_IDENTITY_SENDER;
  if (env.TICKET_DEPLOYMENT_MODE !== "named-pilot"
    || !epoch || !pilotDigestPattern.test(epoch) || !manifestDigest || !pilotDigestPattern.test(manifestDigest)
    || (previousEpoch !== undefined && (!pilotDigestPattern.test(previousEpoch) || previousEpoch === epoch))
    || (traffic !== "closed" && traffic !== "open")
    || (invitations !== "false" && invitations !== "true")
    || (identitySender !== "false" && identitySender !== "true")
    || (traffic === "closed" && (invitations !== "false" || identitySender !== "false"))
    || (invitations === "true" && identitySender !== "true")
    || env.MEDIA_CLEANUP_ENABLED !== "false"
    || env.UPLOADTHING_TOKEN !== undefined || env.UPLOADTHING_SECRET !== undefined || env.UPLOADTHING_APP_ID !== undefined
    || env.UPLOAD_CALLBACK_SECRET !== undefined || env.APP_PASSWORD !== undefined
    || (env.LOCAL_FIXTURES_ENABLED !== undefined && env.LOCAL_FIXTURES_ENABLED !== "false")) return null;
  return { epoch, previousEpoch, manifestDigest, traffic, invitations: invitations === "true", identitySender: identitySender === "true" };
}
