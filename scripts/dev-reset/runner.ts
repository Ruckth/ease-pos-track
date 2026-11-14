import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parse } from "dotenv";
import { validateDevelopmentTarget } from "../dev-reset-target.mjs";

/** Cutover-only runner. The local wrapper has no remote mode. */
export async function runDevelopment(args: string[], target: string, recorded: string, env = process.env,
  invoke: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams = spawn): Promise<string> {
  const settings = parse(readFileSync(".env.local"));
  validateDevelopmentTarget(target, recorded);
  validateDevelopmentTarget(settings.CONVEX_DEPLOYMENT, recorded);
  if (Object.keys(settings).some(key => /^(CONVEX_DEPLOY_KEY|CONVEX_DEPLOYMENT_TOKEN)$|^CONVEX_SELF_HOSTED_/.test(key))) {
    throw new Error("RESET_OVERRIDE_REFUSED");
  }
  if (!["export", "import", "env", "dev", "run"].includes(args[0]) || args.some(arg => /^--(?:prod|deployment|env-file|url|admin-key|configure|preview|local|cloud|dev-deployment|team|project)/.test(arg))) {
    throw new Error("RESET_COMMAND_REFUSED");
  }
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("CONVEX_")) delete childEnv[key];
  const directory = mkdtempSync(join(tmpdir(), "ticket-dev-reset-"));
  const path = join(directory, "target.env");
  const saved = [".env.local", ".gitignore"].map(file => ({ file, content: existsSync(file) ? readFileSync(file) : undefined }));
  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    for (const { file, content } of saved) {
      if (content === undefined) rmSync(file, { force: true });
      else writeFileSync(file, content);
    }
    rmSync(directory, { recursive: true, force: true });
  }
  process.on("exit", restore);
  try {
    writeFileSync(path, `CONVEX_DEPLOYMENT=${target}\n`, { mode: 0o600 });
    const cli = join(dirname(createRequire(import.meta.url).resolve("convex/package.json")), "bin/main.js");
    const child = invoke(process.execPath, [cli, ...args, "--env-file", path], { env: childEnv });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let interrupted: NodeJS.Signals | undefined;
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
      const forward = () => { interrupted = signal; child.kill(signal); };
      process.on(signal, forward);
      return { signal, forward };
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        let stdout = "", stderr = "";
        let failure: Error | undefined;
        child.stdout.on("data", chunk => {
          stdout += chunk;
          if (stdout.length > 64 * 1024 * 1024) { failure = new Error("RESET_CLI_OUTPUT_LIMIT"); child.kill(); }
        });
        child.stderr.on("data", chunk => {
          stderr += chunk;
          if (stderr.length > 64 * 1024 * 1024) { failure = new Error("RESET_CLI_OUTPUT_LIMIT"); child.kill(); }
        });
        child.on("error", error => { failure = error; });
        // Wait for close, including after signals/errors, before restoring files.
        child.on("close", (code, signal) => {
          if (failure || interrupted || code !== 0) reject(Object.assign(failure ?? new Error(`CLI exited: ${interrupted ?? signal ?? code}`), { stdout, stderr }));
          else resolve(stdout);
        });
      });
    } finally {
      for (const { signal, forward } of handlers) process.off(signal, forward);
    }
  } finally {
    restore();
    process.off("exit", restore);
  }
}

/** Validate the entire CLI env-list output before parsing any values. */
export function parseEnvironment(output: string): Record<string, string> {
  try {
    const env: Record<string, string> = {};
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"(?:\\.|[^"\\])*"|[^'"\r\n#]*)\r?(?:\n|$)/gm;
    let end = 0;
    for (const match of Array.from(output.matchAll(assignment))) {
      if (output.slice(end, match.index).trim() || Object.prototype.hasOwnProperty.call(env, match[1])) throw new Error();
      // The CLI emits unquoted whitespace verbatim; dotenv would trim it and
      // accidentally accept a flag whose actual value is " false ".
      const value = /^["']/.test(match[2]) ? parse(match[0])[match[1]] : match[2];
      if (typeof value !== "string") throw new Error();
      env[match[1]] = value;
      end = match.index! + match[0].length;
    }
    if (output.slice(end).trim()) throw new Error();
    return env;
  } catch { throw new Error("RESET_ENVIRONMENT_UNPARSEABLE"); }
}

export function validatePasswords(passwords: string[]) {
  if (passwords.some(value => value.length < 24 || !/[a-z]/i.test(value) || !/[0-9]/.test(value))) {
    throw new Error("RESET_CREDENTIALS_REQUIRE_24_CHARACTERS_LETTER_AND_DIGIT");
  }
}

export async function verifyDeploymentUrl(url: string, target: string, request = fetch) {
  try {
    const response = await request(new URL("/instance_name", url), { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok || (await response.text()).trim() !== target.slice(4)) throw new Error();
  } catch { throw new Error("RESET_DEPLOYMENT_URL_UNVERIFIED"); }
}
