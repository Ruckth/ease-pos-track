import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function commandProcess(args: string[], env: NodeJS.ProcessEnv = {}) {
  const command = [process.execPath, "--import", "tsx", "tests/fixtures/ticket-process.ts", ...args];
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

test("named Google login through the real loopback listener exits naturally after success JSON", async () => {
  const result = await commandProcess(["login", "--url", "https://fixture.invalid"]);
  assert.match(result.output, /"ok":true/);
  assert.doesNotMatch(result.output, /fake-refresh|fake-access|fixture-code/);
  assert.equal(result.code, 0, `Login printed success but retained an open handle: ${result.output}`);
});

test("an unredeemable Google ticket releases the listener and exits with the auth error", async () => {
  const result = await commandProcess(["login"], { FIXTURE_GOOGLE_CODE: "stale-code" });
  assert.match(result.output, /"code":"SIGN_IN_FAILED"/);
  assert.equal(result.code, 4, result.output);
});

for (const command of ["whoami", "list", "logout"]) {
  test(`${command} with the real HTTP client and fake transport exits naturally`, async () => {
    const result = await commandProcess([command]);
    assert.match(result.output, /"ok":true/);
    assert.equal(result.code, 0, result.output);
  });
}
