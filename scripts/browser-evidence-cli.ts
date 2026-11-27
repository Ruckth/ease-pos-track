// Inspect or verify browser evidence before anything leaves the machine.
//   pnpm browser:evidence summary   failing tests, stages and file locations
//   pnpm browser:evidence verify    exit 1 unless public/ holds only allowlisted, sanitized files
//   pnpm browser:evidence clean     delete the evidence directory (traces included)
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR, readManifest, reset, verifyPublic } from "./browser-evidence";

const command = process.argv[2] ?? "summary";
if (command === "verify") {
  const { files, problems } = verifyPublic();
  for (const file of files) console.log(`public/${file}`);
  for (const problem of problems) console.error(`REFUSED ${problem}`);
  console.log(problems.length ? `${problems.length} problem(s); nothing may be uploaded.` : `${files.length} allowlisted file(s) ready to upload.`);
  process.exitCode = problems.length ? 1 : 0;
} else if (command === "clean") {
  reset();
  console.log(`Removed ${EVIDENCE_DIR}`);
} else if (command === "summary") {
  if (!existsSync(EVIDENCE_DIR)) { console.log(`No evidence at ${EVIDENCE_DIR}`); process.exit(0); }
  const manifest = readManifest();
  console.log(`commit ${manifest.commit} · ${manifest.platform} · node ${manifest.node} · chromium ${manifest.chromium ?? "not launched"}`);
  for (const stage of manifest.stages) console.log(`stage ${stage.exitCode ? "FAIL" : "ok  "} ${stage.name} (${Math.round(stage.durationMs / 1000)}s)`);
  if (manifest.failure) console.log(`runner failure: ${manifest.failure}`);
  const failed = manifest.tests.filter(test => test.status === "failed");
  console.log(`${manifest.tests.length} browser checks recorded, ${failed.length} failed.`);
  for (const test of failed) {
    console.log(`\nFAIL [${test.suite}] ${test.test}\n  ${test.error?.split("\n")[0]}`);
    for (const shot of test.screenshots) console.log(`  screenshot ${path.join(EVIDENCE_DIR, "public", shot)}`);
  }
  const traces = path.join(EVIDENCE_DIR, "local", "traces");
  if (existsSync(traces)) for (const trace of readdirSync(traces)) console.log(`trace (local only): pnpm exec playwright show-trace ${path.join(traces, trace)}`);
  if (manifest.blockedHosts.length) console.log(`blocked non-loopback hosts: ${manifest.blockedHosts.join(", ")}`);
} else {
  console.error("Usage: pnpm browser:evidence [summary|verify|clean]");
  process.exitCode = 2;
}
