import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function commandProcess(args: string[], input?: string) {
  const command = [process.execPath, "--import", "tsx", "tests/fixtures/ticket-process.ts", ...args];
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = input === undefined
      ? spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] })
      : spawn("pnpm", ["exec", "python3", "tests/fixtures/terminal.py", ...command], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let sent = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (input !== undefined && !sent && output.includes("Staff password: ")) {
        sent = true;
        child.stdin.write(input);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

test("login with the real hidden prompt and fake HTTP exits naturally after success JSON", async () => {
  const result = await commandProcess(["login", "--url", "https://fixture.invalid"], "fixture-passworX\u007fd\r");
  assert.match(result.output, /"ok":true/);
  assert.doesNotMatch(result.output, /fixture-password/);
  assert.equal(result.code, 0, `Login printed success but retained an open handle: ${result.output}`);
});

test("cancelled login releases terminal handles and exits with the auth error", async () => {
  const result = await commandProcess(["login"], "\u0003");
  assert.match(result.output, /"code":"LOGIN_CANCELLED"/);
  assert.equal(result.code, 4, result.output);
});

test("rejected login releases terminal handles and exits with the auth error", async () => {
  const result = await commandProcess(["login"], "wrong-password\r");
  assert.match(result.output, /"code":"INVALID_CREDENTIALS"/);
  assert.equal(result.code, 4, result.output);
});

for (const command of ["whoami", "list", "logout"]) {
  test(`${command} with the real HTTP client and fake transport exits naturally`, async () => {
    const result = await commandProcess([command]);
    assert.match(result.output, /"ok":true/);
    assert.equal(result.code, 0, result.output);
  });
}
