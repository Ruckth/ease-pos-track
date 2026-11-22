import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const sources = join(root, "scripts/t3-kit");
const platform = process.platform;

test("native secure entry, scoped doctor, and isolated macOS Keychain", { skip: platform !== "darwin" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "track-ease-native-fixture-"));
  try {
    const exe = join(scratch, "native-check");
    execFileSync("/usr/bin/swiftc", [
      ...["Kit.swift", "Credentials.swift", "Doctor.swift"].map(file => join(sources, file)),
      join(root, "tests/fixtures/t3-native.swift"), "-suppress-warnings", "-o", exe,
    ]);
    const output = execFileSync(exe, [scratch], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(output, /isolated Keychain and doctor fixtures passed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("ephemeral signing and separate approval protect both provider kits", { skip: platform !== "darwin" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "track-ease-signed-fixture-"));
  try {
    const release = generateKeyPairSync("ed25519");
    const approval = generateKeyPairSync("ed25519");
    const raw = (key: typeof release.publicKey) => key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const macOS = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const configFile = join(scratch, "spec.json");
    const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(sources, "release.ts"), ...args], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });

    for (const [provider, parent] of [["codex", ".agents"], ["claude", ".claude"]]) {
      const dir = join(scratch, provider);
      const cwd = join(scratch, provider + "-workspace");
      mkdirSync(cwd);
      writeFileSync(configFile, JSON.stringify({
        releaseId: "fixture", deployment: "disposable-fixture", publisher: "Fixture release operator", approvalSigner: "Fixture maintainer",
        gatewayOrigin: "https://track-ease.example.test", settingsUrl: "https://track-ease.example.test/settings/t3",
        releaseKey: raw(release.publicKey), approvalKey: raw(approval.publicKey),
        compatibility: { id: `fixture-${provider}`, provider, macOS, architecture: arch, t3: "1.0", cli: "0.1", skill: "0.1" },
      }));
      for (const command of ["build", "manifest"]) {
        const result = cli([command, configFile, dir]);
        assert.equal(result.status, 0, result.stderr);
      }
      const manifest = readFileSync(join(dir, "manifest.json"));
      const binary = join(dir, "track-ease-t3");
      const skillPath = join(dir, "SKILL.md");
      const sigPath = join(dir, "manifest.approval.sig");
      const archive = join(scratch, provider + ".zip");
      const run = (args: string[]) => spawnSync(binary, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      writeFileSync(join(dir, "manifest.release.sig"), sign(null, manifest, release.privateKey));
      writeFileSync(sigPath, sign(null, manifest, release.privateKey));
      assert.notEqual(run(["inspect"]).status, 0);
      assert.notEqual(cli(["seal", configFile, dir, archive]).status, 0);
      writeFileSync(sigPath, sign(null, manifest, approval.privateKey));
      const sealed = cli(["seal", configFile, dir, archive]);
      assert.equal(sealed.status, 0, sealed.stderr);
      const record = JSON.parse(sealed.stdout);
      assert.equal(record.bootstrapSha256, createHash("sha256").update(readFileSync(binary)).digest("hex"));
      assert.equal(record.archiveSha256, createHash("sha256").update(readFileSync(archive)).digest("hex"));
      const inspect = run(["inspect"]);
      assert.equal(inspect.status, 0, inspect.stderr);
      assert.match(JSON.parse(inspect.stdout).hostId, /^[0-9a-f]{64}$/);
      assert.equal(JSON.parse(inspect.stdout).provider, provider);
      assert.equal(JSON.parse(inspect.stdout).approvedT3Version, "1.0");
      assert.notEqual(run(["install"]).status, 0);
      assert.equal(run(["install", "--confirm"]).status, 0);
      assert.equal(readFileSync(join(cwd, parent, "skills", "track-ease-t3", "SKILL.md"), "utf8"), readFileSync(skillPath, "utf8"));
      assert.notEqual(run(["install", "--confirm"]).status, 0);
      assert.match(run(["import", "POS"]).stderr, /Secure entry failed/);
      const originalSkill = readFileSync(skillPath);
      writeFileSync(skillPath, Buffer.concat([originalSkill, Buffer.from("tampered")]));
      assert.match(run(["inspect"]).stderr, /verification failed/);
      writeFileSync(skillPath, originalSkill);
      writeFileSync(join(dir, "manifest.json"), Buffer.concat([manifest, Buffer.from(" ")]));
      assert.match(run(["inspect"]).stderr, /verification failed/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
