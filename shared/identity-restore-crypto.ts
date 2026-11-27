const encoder = new TextEncoder();
export const restoreHexKey = /^[a-f0-9]{64}$/;
export const restoreReference = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,159}$/;

function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

export async function signRestoreAttestation(key: string, values: readonly (string | number)[]) {
  const signer = await crypto.subtle.importKey("raw", fromHex(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", signer, encoder.encode(JSON.stringify(["identity-restore/v1", ...values])));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export type RestorePasswordBinding = {
  deploymentOrigin: string;
  epoch: string;
  caseId: string;
  customerId: string;
  userId: string;
  generation: number;
};
export type RestorePasswordEnvelope = { iv: ArrayBuffer; ciphertext: ArrayBuffer };

function passwordContext(binding: RestorePasswordBinding) {
  return encoder.encode(JSON.stringify([
    "identity-restore-password/v1", binding.deploymentOrigin, binding.epoch,
    binding.caseId, binding.customerId, binding.userId, binding.generation,
  ]));
}

export async function encryptRestorePassword(key: string, binding: RestorePasswordBinding, password: string): Promise<RestorePasswordEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.importKey("raw", fromHex(key), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: passwordContext(binding) }, cipher, encoder.encode(password));
  return { iv: iv.buffer, ciphertext };
}

export async function decryptRestorePassword(key: string, binding: RestorePasswordBinding, envelope: RestorePasswordEnvelope) {
  if (envelope.iv.byteLength !== 12 || envelope.ciphertext.byteLength > 1024 || envelope.ciphertext.byteLength < 16) {
    throw new Error("INVALID_RESTORE_CREDENTIAL");
  }
  try {
    const cipher = await crypto.subtle.importKey("raw", fromHex(key), "AES-GCM", false, ["decrypt"]);
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.iv, additionalData: passwordContext(binding) }, cipher, envelope.ciphertext);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("INVALID_RESTORE_CREDENTIAL");
  }
}

export function verifyRestoreValues(
  origin: string,
  verifierId: string,
  input: { epoch: string; requestId: string; customerId: string; userId: string; generation: number; evidenceRef: string; expiresAt: number },
) {
  return ["verify", origin, input.epoch, verifierId, input.requestId, input.customerId, input.userId,
    input.generation, input.evidenceRef, input.expiresAt] as const;
}

export function approveRestoreValues(
  origin: string,
  reviewerId: string,
  input: { epoch: string; caseId: string; customerId: string; userId: string; generation: number; verifierId: string; evidenceRef: string; expiresAt: number },
) {
  return ["approve", origin, input.epoch, reviewerId, input.caseId, input.customerId, input.userId,
    input.generation, input.verifierId, input.evidenceRef, input.expiresAt] as const;
}
