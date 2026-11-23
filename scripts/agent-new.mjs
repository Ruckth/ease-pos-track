#!/usr/bin/env node
// `pnpm agent:new <name> [base]`: give an agent its own worktree and branch,
// ready to run. Creates ../<checkout>-worktrees/<name> on branch
// agent/<name> from [base] (default: the current HEAD), then runs agent:setup.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const [name, base = "HEAD"] = process.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
  console.error("Usage: pnpm agent:new <name> [base]   (name: letters, digits, '.', '_' or '-')");
  process.exit(2);
}

const main = path.dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
const dir = path.join(path.dirname(main), `${path.basename(main)}-worktrees`, name);
const step = (command, args, cwd) => {
  const result = spawnSync(command, args, { stdio: "inherit", cwd });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

step("git", ["worktree", "add", "-b", `agent/${name}`, dir, base], main);
step("node", [path.join(dir, "scripts/agent-setup.mjs")], dir);
console.log(`\nWork in: cd ${dir}\nWhen merged: git worktree remove ${dir} && git branch -d agent/${name}`);
