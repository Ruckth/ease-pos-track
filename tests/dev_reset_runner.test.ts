import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseEnvironment, runDevelopment, validatePasswords, verifyDeploymentUrl } from "../scripts/dev-reset/runner";

const recorded = "dev:disposable-123";
async function withSettings(settings: string, run: () => Promise<void>) {
  const cwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "ticket-reset-runner-test-"));
  try {
    process.chdir(directory);
    writeFileSync(".env.local", settings);
    await run();
    assert.equal(readFileSync(".env.local", "utf8"), settings);
  } finally { process.chdir(cwd); rmSync(directory, { recursive: true, force: true }); }
}

test("remote runner refuses file deploy keys, deployment tokens and self-hosted configuration before CLI invocation", async () => {
  for (const key of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"]) {
    await withSettings(`CONVEX_DEPLOYMENT=${recorded}\n${key}=stray-prod-secret\n`, async () => {
      await assert.rejects(() => runDevelopment(["import"], recorded, recorded, {}, () => { assert.fail("must not invoke"); }), /RESET_OVERRIDE_REFUSED/);
    });
  }
});

test("remote runner requires both file identity and passed identity to equal the recorded development target", async () => {
  for (const [file, passed] of [[recorded, "dev:other"], ["dev:other", recorded], ["prod:never", recorded], [recorded, "prod:never"]]) {
    await withSettings(`CONVEX_DEPLOYMENT=${file}\n`, async () => {
      await assert.rejects(() => runDevelopment(["import"], passed, recorded, {}, () => { assert.fail("must not invoke"); }), /RESET_TARGET_REFUSED/);
    });
  }
});

test("remote runner gives each CLI call a private target-only env file, scrubs every CONVEX variable and removes temp files on success or failure", async () => {
  await withSettings(`CONVEX_DEPLOYMENT=${recorded}\nUPLOADTHING_TOKEN=never-pass-this-file\n`, async () => {
    const paths: string[] = [];
    for (const fails of [false, true]) {
      const invoke = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        assert.equal(file, process.execPath);
        const path = args.at(-1)!;
        paths.push(path);
        assert.equal(args.at(-2), "--env-file");
        assert.equal(readFileSync(path, "utf8"), `CONVEX_DEPLOYMENT=${recorded}\n`);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
        assert.deepEqual(options.env, { NORMAL_SETTING: "preserve" });
        return spawn(process.execPath, ["-e", fails
          ? 'process.stderr.write("fake CLI failure"); process.exitCode = 1'
          : 'process.stdout.write("fake CLI result")']);
      };
      const call = () => runDevelopment(["env", "list"], recorded, recorded, {
        NORMAL_SETTING: "preserve", CONVEX_DEPLOYMENT: "prod:never", CONVEX_DEPLOYMENT_TOKEN: "stray",
        CONVEX_DEPLOY_KEY: "stray", CONVEX_SELF_HOSTED_URL: "never", CONVEX_AGENT_MODE: "anonymous", CONVEX_OTHER: "stray",
      }, invoke);
      if (fails) await assert.rejects(call, { stderr: "fake CLI failure" });
      else assert.equal(await call(), "fake CLI result");
      assert.equal(existsSync(paths.at(-1)!), false);
    }
    assert.notEqual(paths[0], paths[1]);
  });
});

test("environment list parsing refuses unparsed text, malformed quotes and duplicate values", () => {
  for (const output of ["garbage", "null", "{}", "MEDIA_CLEANUP_ENABLED='false", "noise\nMEDIA_CLEANUP_ENABLED=false", "MEDIA_CLEANUP_ENABLED=false\ntrailing garbage", "MEDIA_CLEANUP_ENABLED=false\nMEDIA_CLEANUP_ENABLED=true", "MEDIA_CLEANUP_ENABLED=false #comment"]) {
    assert.throws(() => parseEnvironment(output), /RESET_ENVIRONMENT_UNPARSEABLE/);
  }
  assert.deepEqual(parseEnvironment('MEDIA_CLEANUP_ENABLED=false\nMULTILINE=\'first\nsecond\'\nTOKEN="private"\n'), { MEDIA_CLEANUP_ENABLED: "false", MULTILINE: "first\nsecond", TOKEN: "private" });
  assert.deepEqual(parseEnvironment(""), {});
  assert.deepEqual(parseEnvironment("MEDIA_CLEANUP_ENABLED= false \n"), { MEDIA_CLEANUP_ENABLED: " false " });
});

test("supplied reset passwords require 24 characters, a letter and a digit", () => {
  assert.throws(() => validatePasswords(["a1" + "😀".repeat(11)]), /RESET_CREDENTIALS_REQUIRE_24/);
  assert.throws(() => validatePasswords(["a1".repeat(55)]), /RESET_PASSWORD_TOO_LONG/);
  assert.throws(() => validatePasswords(["a1".repeat(15) + " "]), /RESET_PASSWORD_HAS_SURROUNDING_WHITESPACE/);
  for (const password of ["", "Aa1short", "a".repeat(24), "1".repeat(24), "!".repeat(24)]) {
    assert.throws(() => validatePasswords([password]), /RESET_CREDENTIALS_REQUIRE/);
  }
  assert.doesNotThrow(() => validatePasswords(["Ab1" + "!".repeat(21)]));
});

test("deployment URL must be reachable and return the exact deployment name before destructive work", async () => {
  for (const request of [async () => { throw new Error("offline"); }, async () => new Response("disposable-123", { status: 500 }), async () => new Response("other")]) {
    await assert.rejects(verifyDeploymentUrl("https://disposable-123.convex.cloud", recorded, request), /RESET_DEPLOYMENT_URL_UNVERIFIED/);
  }
  await verifyDeploymentUrl("https://disposable-123.convex.cloud", recorded, async (url, options) => {
    assert.equal(String(url), "https://disposable-123.convex.cloud/instance_name");
    assert.equal(options?.redirect, "error");
    return new Response("disposable-123");
  });
});


test("development runner restores CLI rewrites of repository env and gitignore on success and failure, including absent gitignore", async () => {
  await withSettings(`CONVEX_DEPLOYMENT=${recorded}\n`, async () => {
    for (const original of [undefined, "# preserve existing ignores\n"]) {
      if (original === undefined) rmSync(".gitignore", { force: true });
      else writeFileSync(".gitignore", original);
      for (const fails of [false, true]) {
        const call = () => runDevelopment(["dev", "--once"], recorded, recorded, {}, () => spawn(process.execPath, ["-e", `
          const fs = require("node:fs");
          fs.writeFileSync(".env.local", "CLI_SELECTED_TARGET=true");
          fs.writeFileSync(".gitignore", "CLI_CHANGED_IGNORES");
          process.exitCode = ${fails ? 1 : 0};
        `]));
        if (fails) await assert.rejects(call);
        else await call();
        assert.equal(readFileSync(".env.local", "utf8"), `CONVEX_DEPLOYMENT=${recorded}\n`);
        assert.equal(existsSync(".gitignore"), original !== undefined);
        if (original !== undefined) assert.equal(readFileSync(".gitignore", "utf8"), original);
      }
    }
  });
});

test("development runner forwards interruption and restores files after the fake CLI exits", async () => {
  await withSettings(`CONVEX_DEPLOYMENT=${recorded}\n`, async () => {
    writeFileSync(".gitignore", "original ignores\n");
    // Signal this test process only after the runner has installed its handlers.
    const call = runDevelopment(["dev", "--once"], recorded, recorded, {}, () => {
      const child = spawn(process.execPath, ["-e", `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {
          fs.writeFileSync(".env.local", "last child write");
          fs.writeFileSync(".gitignore", "last child write");
          process.exit(0);
        });
        fs.writeFileSync(".env.local", "rewritten");
        fs.writeFileSync(".gitignore", "rewritten");
        console.log("ready");
        setInterval(() => {}, 1000);
      `]);
      child.stdout.once("data", () => process.kill(process.pid, "SIGTERM"));
      return child;
    });
    await assert.rejects(call, /SIGTERM/);
    assert.equal(readFileSync(".gitignore", "utf8"), "original ignores\n");
  });
});
