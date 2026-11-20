#!/usr/bin/env node
// File-backed stand-in for /usr/bin/security. The CLI spawns this process with
// its normal stdio and inherited descriptor, so it can outlive its parent.
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = process.env.FIXTURE_DIR;
let words = process.argv.slice(2);
if (words[0] === "-i") {
  let command = "";
  for await (const data of process.stdin) command += data;
  words = command.trim().split(" ");
}
const item = join(dir, `keychain-${words[words.indexOf("-a") + 1]}`);
try {
  switch (words[0]) {
    case "find-generic-password":
      process.stdout.write(await readFile(item));
      break;
    case "add-generic-password": {
      const temporary = `${item}.${process.pid}`;
      await writeFile(temporary, words[words.indexOf("-w") + 1]);
      if (existsSync(join(dir, "pause-write"))) {
        await writeFile(join(dir, "writer-ready"), "");
        const deadline = Date.now() + 15_000;
        while (existsSync(join(dir, "pause-write"))) {
          if (Date.now() >= deadline) throw new Error("fixture write timed out");
          await delay(10);
        }
      }
      await rename(temporary, item);
      break;
    }
    case "delete-generic-password":
      await rm(item);
      break;
    default:
      throw new Error("unexpected Keychain operation");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  process.exitCode = 44;
}
