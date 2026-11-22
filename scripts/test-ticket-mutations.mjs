import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lifecycle = "tests/convex/ticket-lifecycle.test.ts";
const mediaJobs = "tests/convex/media-jobs.test.ts";
const create = { testFile: lifecycle, testName: "generated create histories" };
const upload = { testFile: lifecycle, testName: "generated upload histories" };
const mutants = {
  ownership: {
    ...create,
    file: "convex/domain/requests.ts",
    before: "receipt.actorRole !== input.actor.role || receipt.actorCustomerId !== input.actor.customerId",
    after: "false",
    assertion: /"code": "TICKET_UNAVAILABLE"|promise resolved.*instead of rejecting/,
  },
  immutable: {
    ...create,
    file: "convex/domain/requests.ts",
    before: "receipt.inputDigest !== input.inputDigest",
    after: "false",
    assertion: /promise resolved.*instead of rejecting/,
  },
  fence: {
    ...upload,
    file: "convex/domain/media_jobs.ts",
    before: " && job.leaseId === fence.leaseId",
    after: "",
    assertion: /expected true to be false/,
  },
  age: {
    testFile: mediaJobs,
    testName: "restore wins before the 30-day purge claim",
    file: "convex/retention.ts",
    before: '.lte("archivedAt", now - ARCHIVE_RETENTION_MS)',
    after: '.lt("archivedAt", now - ARCHIVE_RETENTION_MS)',
    assertion: /expected \+?0 to be 1/,
  },
};

const ids = process.argv.slice(2);
const selected = ids.length ? ids : Object.keys(mutants);
if (selected.some(id => !Object.hasOwn(mutants, id)) || new Set(selected).size !== selected.length) {
  console.error(`Usage: pnpm test:mutation [${Object.keys(mutants).join("|")} ...]`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "ticket-mutation-"));
const started = performance.now();

function run(label, targets, mutant) {
  const resultsFile = join(scratch, `${label}.json`);
  const marker = join(scratch, `${label}.transformed`);
  const testNames = [...new Set(targets.map(({ testName }) => testName))];
  const testFiles = [...new Set(targets.map(({ testFile }) => testFile))];
  const budget = Math.min(90_000, 600_000 - (performance.now() - started));
  if (budget < 1) throw new Error("Pilot exceeded its ten-minute budget");
  const args = [
    "exec", "vitest", "run", "--config", mutant ? "verification/vitest.mutation.config.mjs" : "vitest.convex.config.ts",
    "--testNamePattern", testNames.join("|"),
    "--reporter=default", "--reporter=json", `--outputFile.json=${resultsFile}`, ...testFiles,
  ];
  const result = spawnSync("pnpm", args, {
    encoding: "utf8", timeout: Math.floor(budget),
    env: { ...process.env, TICKET_MUTATION_INPUT: mutant ? JSON.stringify({ ...mutant, marker }) : "" },
  });
  if (result.error || result.signal) throw new Error(`${label}: runner did not finish`, { cause: result.error ?? result.signal });

  let tests;
  try {
    tests = JSON.parse(readFileSync(resultsFile, "utf8")).testResults.flatMap(suite => suite.assertionResults)
      .filter(test => testNames.some(name => test.title.startsWith(name)));
  } catch (error) {
    throw new Error(`${label}: missing Vitest assertion results\n${result.stdout}\n${result.stderr}`, { cause: error });
  }
  if (tests.length !== testNames.length) throw new Error(`${label}: selected tests did not all run`);
  if (!mutant && result.status === 0 && tests.every(test => test.status === "passed")) {
    console.log(`Baseline passed (${tests.length} selected tests).`);
    return;
  }
  if (mutant && readFileSync(marker, "utf8") === mutant.file) {
    const [test] = tests;
    const failure = result.stderr;
    if (result.status === 0 && test.status === "passed") throw new Error(`${label}: survived in ${test.title}`);
    if (result.status === 1 && test.status === "failed" && mutant.assertion.test(failure)) {
      console.log(`${label}: caught in ${test.title}\n${failure}`);
      return;
    }
  }
  throw new Error(`${label}: unexpected test outcome\n${result.stdout}\n${result.stderr}`);
}

try {
  run("baseline", selected.map(id => mutants[id]));
  for (const id of selected) run(id, [mutants[id]], mutants[id]);
  console.log(`Finished ${selected.length} mutation controls in ${((performance.now() - started) / 1_000).toFixed(1)}s.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
