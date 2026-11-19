import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { t3ReleaseIdPattern, t3ProviderNames } from "../../shared/t3-doctor";

const source = dirname(fileURLToPath(import.meta.url));
const executable = "track-ease-t3";
const skillFile = "SKILL.md";
const manifestFile = "manifest.json";
const releaseSig = "manifest.release.sig";
const approvalSig = "manifest.approval.sig";
const identifier = z.string().regex(t3ReleaseIdPattern);
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/);
const osVersion = z.string().regex(/^\d+\.\d+(\.\d+)?$/).max(16);
const signer = z.string().trim().min(1).max(100).regex(new RegExp("^[^\\p{C}]+$", "u"));
const pin = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

const specSchema = z.object({
  releaseId: identifier,
  deployment: identifier,
  gatewayOrigin: z.string(),
  settingsUrl: z.string(),
  publisher: signer,
  approvalSigner: signer,
  releaseKey: pin,
  approvalKey: pin,
  compatibility: z.object({
    id: identifier,
    provider: z.enum(["codex", "claude"]),
    macOS: osVersion,
    architecture: z.enum(["arm64", "x86_64"]),
    t3: version,
    cli: version,
    skill: version,
  }).strict(),
}).strict();

type Spec = z.infer<typeof specSchema>;
function https(value: string, originOnly: boolean) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (originOnly && url.origin !== value)) throw new Error("Provide a canonical HTTPS URL.");
}
function readSpec(path: string): Spec {
  const spec = specSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  https(spec.gatewayOrigin, true);
  https(spec.settingsUrl, false);
  if (Buffer.from(spec.releaseKey, "base64").equals(Buffer.from(spec.approvalKey, "base64"))) {
    throw new Error("Use independent publisher and approval roots.");
  }
  return spec;
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function skillPath(spec: Spec) {
  const parent = spec.compatibility.provider === "codex" ? ".agents" : ".claude";
  return `${parent}/skills/track-ease-t3/${skillFile}`;
}

function skill(spec: Spec) {
  const provider = t3ProviderNames[spec.compatibility.provider];
  const invocation = spec.compatibility.provider === "claude" ? "disable-model-invocation: true\n" : "";
  return `---
name: track-ease-t3
description: Verify the read-only Track Ease connection for a selected Project in T3 Code with ${provider}.
${invocation}---

# Track Ease connection

Use release ${spec.releaseId} and setup ${spec.compatibility.id} with ${provider} on the selected Mac.
Ask for the approved Project key and the local path to the verified ${executable} executable.
Verify the executable SHA-256 against the independently trusted release record before running it.
Run inspect from the selected T3 workspace. Show the execution host ID, skill destination, and versions before installation.
Confirm that the current provider and T3 build match the approved release. Stop if you cannot confirm them.
On approval, run install --confirm from the same workspace, then start a fresh provider session to discover this skill.

When the user is ready, request the personal key with T3 secure file delivery on this execution host.
Pass only the absolute file path to import PROJECT --file ABSOLUTE_PATH. The CLI consumes the file.
A human can alternatively run import PROJECT in a trusted interactive terminal with hidden entry.
If secure entry is unavailable, stop. Keep personal keys out of chat, clipboard, commands, logs, and environment variables.

Run doctor PROJECT from the workspace and show its deployment, account, Project, expiry, and compatibility.
Require a successful doctor response before calling the connection verified. This key authorizes doctor only.

For disconnect, have the user revoke the selected key in Track Ease Settings and confirm local removal with
uninstall PROJECT --confirm. If remote revocation cannot be confirmed, surface the Settings URL on reconnect.
`;
}

function build(spec: Spec, dir: string) {
  const scratch = mkdtempSync(join(tmpdir(), "track-ease-build-"));
  try {
    const trust = join(scratch, "KitTrust.swift");
    const values = {
      releaseId: spec.releaseId, combinationId: spec.compatibility.id, deployment: spec.deployment,
      gatewayOrigin: spec.gatewayOrigin, settingsUrl: spec.settingsUrl, releaseKey: spec.releaseKey, approvalKey: spec.approvalKey,
    };
    writeFileSync(trust, "enum KitTrust {\n" + Object.entries(values).map(([key, value]) =>
      `    static let ${key} = ${JSON.stringify(value)}\n`).join("") + "}\n");
    mkdirSync(dir, { mode: 0o700 });
    execFileSync("/usr/bin/swiftc", [
      "-O", "-target", `${spec.compatibility.architecture}-apple-macosx${spec.compatibility.macOS}`,
      ...["Kit.swift", "Credentials.swift", "Doctor.swift", "TrackEaseT3.swift"].map(file => join(source, file)),
      trust, "-o", join(dir, executable),
    ], { stdio: "inherit" });
    writeFileSync(join(dir, skillFile), skill(spec), { flag: "wx" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function manifest(spec: Spec, dir: string) {
  return Buffer.from(JSON.stringify({
    format: 1,
    releaseId: spec.releaseId, deployment: spec.deployment, gatewayOrigin: spec.gatewayOrigin, settingsUrl: spec.settingsUrl,
    publisher: spec.publisher, approvalSigner: spec.approvalSigner, compatibility: spec.compatibility,
    sha256: { [executable]: hash(readFileSync(join(dir, executable))), [skillFile]: hash(readFileSync(join(dir, skillFile))) },
    installFiles: [skillPath(spec)],
  }, null, 2) + "\n");
}

function verifySignature(publicKey: string, payload: Buffer, signature: Buffer) {
  // RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]),
    format: "der", type: "spki",
  });
  return signature.length === 64 && verify(null, payload, key, signature);
}

function seal(spec: Spec, dir: string, archive: string) {
  const expected = [executable, skillFile, manifestFile, releaseSig, approvalSig].sort();
  const actual = readdirSync(dir, { withFileTypes: true });
  if (actual.some(file => !file.isFile()) || actual.map(file => file.name).sort().join("\n") !== expected.join("\n")) {
    throw new Error("The kit contains unexpected files.");
  }
  const payload = readFileSync(join(dir, manifestFile));
  if (!manifest(spec, dir).equals(payload)
    || !verifySignature(spec.releaseKey, payload, readFileSync(join(dir, releaseSig)))
    || !verifySignature(spec.approvalKey, payload, readFileSync(join(dir, approvalSig)))) {
    throw new Error("Kit bytes or approval signatures are invalid.");
  }
  const archivePath = resolve(archive);
  writeFileSync(archivePath, "", { flag: "wx" });
  try {
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", dir, archivePath], { stdio: "inherit" });
  } catch (error) {
    rmSync(archivePath);
    throw error;
  }
  process.stdout.write(JSON.stringify({
    releaseId: spec.releaseId, combination: spec.compatibility, publisher: spec.publisher, approvalSigner: spec.approvalSigner,
    releaseRootSha256: hash(Buffer.from(spec.releaseKey, "base64")),
    approvalRootSha256: hash(Buffer.from(spec.approvalKey, "base64")),
    bootstrapSha256: hash(readFileSync(join(dir, executable))),
    manifestSha256: hash(payload),
    archiveSha256: hash(readFileSync(archivePath)),
    installFiles: [skillPath(spec)],
  }, null, 2) + "\n");
}

function main([command, config, directory, output, ...extras]: string[]) {
  if (!config || !directory || extras.length || !["build", "manifest", "seal"].includes(command)
    || (command === "seal") !== Boolean(output)) {
    throw new Error("Use build SPEC NEW_DIR, manifest SPEC KIT_DIR, or seal SPEC KIT_DIR NEW_ZIP.");
  }
  if (process.platform !== "darwin") throw new Error("Build the kit with the macOS Swift toolchain.");
  const spec = readSpec(config);
  const dir = resolve(directory);
  if (command === "build") build(spec, dir);
  else if (command === "manifest") writeFileSync(join(dir, manifestFile), manifest(spec, dir), { flag: "wx" });
  else seal(spec, dir, output);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Kit build failed.") + "\n");
  process.exitCode = 1;
}
