import { z } from "zod";
import { t3HostPattern, t3ReleaseIdPattern } from "../shared/t3-doctor";

export function httpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("DOCTOR_RELEASE_INVALID");
  }
  return url;
}

const identifier = z.string().regex(t3ReleaseIdPattern);
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/);
const releaseSchema = z.object({
  id: identifier,
  publicationUrl: z.string().max(512),
  releaseOrigin: z.string().max(256),
  gatewayOrigin: z.string().max(256),
  deployment: identifier,
  combinations: z.array(z.object({
    id: identifier,
    provider: z.enum(["codex", "claude"]),
    macOS: z.string().regex(/^\d+\.\d+(\.\d+)?$/).max(16),
    architecture: z.enum(["arm64", "x86_64"]),
    t3: version,
    cli: version,
    skill: version,
    bootstrapSha256: z.string().regex(t3HostPattern),
    downloadUrl: z.string().max(512),
  }).strict()).min(1).max(12),
}).strict();

export function t3Runtime() {
  const epoch = process.env.T3_DOCTOR_EPOCH;
  if (process.env.T3_DOCTOR_ENABLED !== "true" || !epoch || !t3HostPattern.test(epoch)) return null;
  try {
    const release = releaseSchema.parse(JSON.parse(process.env.T3_DOCTOR_RELEASE ?? ""));
    if (httpsUrl(release.gatewayOrigin).origin !== release.gatewayOrigin
      || httpsUrl(release.releaseOrigin).origin !== release.releaseOrigin
      || httpsUrl(release.publicationUrl).origin !== release.releaseOrigin
      || release.combinations.some(combo => httpsUrl(combo.downloadUrl).origin !== release.releaseOrigin)
      || new Set(release.combinations.map(combo => combo.id)).size !== release.combinations.length) return null;
    return { epoch, release, issuing: process.env.T3_DOCTOR_ISSUANCE_ENABLED === "true" };
  } catch { return null; }
}

const encoder = new TextEncoder();

export function t3Hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function t3EpochTag(epoch: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`track-ease/t3/epoch/v1\0${epoch}`));
  return t3Hex(new Uint8Array(digest));
}

export async function t3Digest(epoch: string, audience: string, deployment: string, bearer: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(epoch), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${audience}\0${deployment}\0${bearer}`));
  return t3Hex(new Uint8Array(digest));
}
