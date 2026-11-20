import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { ConvexError, convexToJson, jsonToConvex, type JSONValue } from "convex/values";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { checkNewPassword } from "../convex/identity_rules";
import {
  approveRestoreValues, encryptRestorePassword, restoreHexKey, restoreReference, signRestoreAttestation, verifyRestoreValues,
} from "../shared/identity-restore-crypto";

const usage = `pnpm identity:restore verify ORIGIN EPOCH VERIFIER_ID CUSTOMER_ID USER_ID GENERATION EVIDENCE_REF
pnpm identity:restore approve ORIGIN EPOCH REVIEWER_ID CASE_ID
pnpm identity:restore replace ORIGIN EPOCH CASE_ID`;

function restoreOrigin(value: string) {
  const url = new URL(value);
  if (value !== url.origin || (url.protocol !== "https:"
    && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("INVALID_DEPLOYMENT_ORIGIN");
  }
  return value;
}

async function main() {
  const [command, rawOrigin, epoch, ...args] = process.argv.slice(2);
  if (command === "--help") { process.stdout.write(usage + "\n"); return; }
  if (!rawOrigin || !restoreHexKey.test(epoch ?? "") || !(
    (command === "verify" && args.length === 5)
    || (command === "approve" && args.length === 2)
    || (command === "replace" && args.length === 1)
  )) throw new Error("INVALID_ARGUMENTS");
  const origin = restoreOrigin(rawOrigin);
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("PRIVATE_TERMINAL_REQUIRED");

  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  const interrupted = new AbortController();
  input.on("SIGINT", () => interrupted.abort());
  async function privateInput(label: string) {
    process.stderr.write(label + " ");
    try { return await input.question("", { signal: interrupted.signal }); }
    finally { process.stderr.write("\n"); }
  }
  async function readKey(label: string) {
    const key = await privateInput(label);
    if (!restoreHexKey.test(key)) throw new Error("INVALID_OPERATOR_KEY");
    return key;
  }

  try {
    process.stderr.write(`Restore target ${origin}\n`);
    const adminKey = await privateInput("Deployment administrator credential");
    if (!adminKey) throw new Error("DEPLOYMENT_CREDENTIAL_REQUIRED");
    async function call<F extends FunctionReference<"mutation" | "query", "internal">>(ref: F, args: FunctionArgs<F>) {
      const response = await fetch(origin + "/api/function", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Convex ${adminKey}` },
        body: JSON.stringify({ path: getFunctionName(ref), format: "convex_encoded_json", args: convexToJson(args) }),
      });
      if (!response.ok && response.status !== 560) throw new Error("RESTORE_REQUEST_REJECTED");
      const result = await response.json() as { status: string; value?: JSONValue; errorData?: JSONValue };
      if (result.status !== "success" || result.value === undefined) {
        throw result.errorData === undefined ? new Error("RESTORE_COMMAND_FAILED") : new ConvexError(jsonToConvex(result.errorData));
      }
      return jsonToConvex(result.value) as FunctionReturnType<F>;
    }

    if (command === "verify") {
      const [verifierId, customerId, userId, rawGeneration, evidenceRef] = args;
      const generation = Number(rawGeneration);
      if (!restoreReference.test(verifierId) || !restoreReference.test(evidenceRef)
        || !Number.isSafeInteger(generation) || generation < 1) throw new Error("INVALID_ARGUMENTS");
      const requestId = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
      const claim = {
        epoch, requestId, customerId: customerId as Id<"customers">, userId: userId as Id<"users">,
        generation, evidenceRef, expiresAt: Date.now() + 45 * 60 * 1000,
      };
      const key = await readKey("Verifier key");
      const signature = await signRestoreAttestation(key, verifyRestoreValues(origin, verifierId, claim));
      const result = await call(internal.identity_restore.verifyCustomer, { ...claim, signature });
      process.stdout.write(`Verified restore case ${result.caseId}\n`);
    } else if (command === "approve") {
      const [reviewerId, rawCaseId] = args;
      if (!restoreReference.test(reviewerId)) throw new Error("INVALID_ARGUMENTS");
      const caseId = rawCaseId as Id<"customerRestoreCases">;
      const claim = await call(internal.identity_restore.readCaseForReview, { caseId, epoch });
      process.stderr.write(JSON.stringify(claim, null, 2) + "\n");
      if (await privateInput("Type APPROVE after reviewing the independently stored evidence") !== "APPROVE") throw new Error("APPROVAL_CANCELLED");
      const key = await readKey("Reviewer key");
      const signature = await signRestoreAttestation(key, approveRestoreValues(origin, reviewerId, claim));
      await call(internal.identity_restore.approveReplacement, { caseId, epoch, signature });
      process.stdout.write(`Approved restore case ${caseId}\n`);
    } else {
      const caseId = args[0] as Id<"customerRestoreCases">;
      const { binding, username } = await call(internal.identity_restore.readReplacement, { caseId, epoch });
      if (binding.deploymentOrigin !== origin || binding.caseId !== caseId || binding.epoch !== epoch) throw new Error("RESTORE_CASE_MISMATCH");
      const key = await readKey("Private entry key");
      process.stderr.write(`Approved customer ${username} (${binding.customerId})\nGive the verified customer private access to this terminal.\n`);
      const checked = checkNewPassword(await privateInput("New customer password"));
      if ("problem" in checked) throw new Error(checked.problem);
      if ((await privateInput("Confirm new password")).normalize("NFC") !== checked.password) throw new Error("PASSWORD_MISMATCH");
      const envelope = await encryptRestorePassword(key, binding, checked.password);
      const result = await call(internal.identity_restore.replacePassword, { caseId, epoch, envelope });
      if (!result.success) throw new Error(result.error);
      process.stdout.write(`Replaced credentials for customer ${result.customerId}\n`);
    }
  } finally {
    input.close();
    muted.end();
  }
}

main().catch(error => {
  const data = error instanceof ConvexError ? error.data : undefined;
  const code = data && typeof data === "object" && "code" in data ? data.code : error instanceof Error ? error.message : undefined;
  process.stderr.write(typeof code === "string" && /^[A-Z][A-Z_]+$/.test(code) ? `${code}\n` : "RESTORE_COMMAND_FAILED\n");
  process.exitCode = 1;
});
