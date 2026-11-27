export const T3_DOCTOR_PATH = "/integrations/t3/doctor";
export const T3_DOCTOR_SCOPE = "doctor:read";
export const T3_DOCTOR_AUDIENCE = "track-ease/t3/doctor/v1";
export const T3_MAX_KEY_DAYS = 90;
export const T3_KEY_LIMIT = 3;
export const T3_DAY_MS = 86_400_000;

export const t3BearerPattern = /^ted1_([a-f0-9]{32})\.([a-f0-9]{64})$/;
export const t3HostPattern = /^[a-f0-9]{64}$/;
export const t3ReleaseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const t3ProviderNames = { codex: "Codex", claude: "Claude" } as const;

export type T3Provider = keyof typeof t3ProviderNames;

export type T3Compatibility = {
  id: string;
  provider: T3Provider;
  macOS: string;
  architecture: "arm64" | "x86_64";
  t3: string;
  cli: string;
  skill: string;
  bootstrapSha256: string;
  downloadUrl: string;
};

export type T3Release = {
  id: string;
  publicationUrl: string;
  releaseOrigin: string;
  gatewayOrigin: string;
  deployment: string;
  combinations: T3Compatibility[];
};

export type T3Change =
  | { kind: "issue"; projectId: string; hostId: string; machineLabel: string; days: number; releaseId: string; combinationId: string }
  | { kind: "rotate"; keyId: string; days?: number }
  | { kind: "revoke"; keyId: string };

// A fixed order and version are shared by proof issuance and consumption.
export function t3ProofIntent(change: T3Change) {
  const action = `t3-key-${change.kind}` as const;
  switch (change.kind) {
    case "issue": return { action, intendedChange: JSON.stringify([1, change.projectId, change.hostId, change.machineLabel.trim(), change.days, change.releaseId, change.combinationId]) };
    case "rotate": return { action, intendedChange: JSON.stringify([1, change.keyId, change.days ?? null]) };
    case "revoke": return { action, intendedChange: JSON.stringify([1, change.keyId]) };
  }
}
