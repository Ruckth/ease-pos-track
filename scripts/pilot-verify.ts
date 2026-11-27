import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { pilotManifestDigest, pilotReleaseManifest, pilotRestorePlan, pilotPrivacyNotices } from "../shared/pilot-manifest";
import { pilotEnvironmentKeys, readPilotSettings } from "../shared/pilot-settings";

const secretKeys = new Set<string>(["UPLOADTHING_TOKEN", "UPLOADTHING_SECRET", "UPLOADTHING_APP_ID", "UPLOAD_CALLBACK_SECRET", "APP_PASSWORD"]);
const switchInventory = z.object(Object.fromEntries(pilotEnvironmentKeys.map(key => [
  key, secretKeys.has(key) ? z.literal("present").nullable() : z.string().nullable(),
]))).strict();
const observationSchema = z.object({
  deploymentOrigin: z.string(),
  uploadBackendOrigin: z.string(),
  webNotices: pilotPrivacyNotices.optional(),
  convex: switchInventory,
  uploadRuntime: switchInventory,
  // These are observed infrastructure states. Each listed surface stays off in this pilot.
  disabled: z.object({
    legacyWriters: z.literal(true),
    doctor: z.literal(true),
    assistedRecovery: z.literal(true),
    aiRouting: z.literal(true),
    ticketEmail: z.literal(true),
    line: z.literal(true),
    mediaEgress: z.literal(true),
  }).strict(),
  externalEgress: z.enum(["closed", "identity-only"]),
}).strict();

type Stage = "restore-preflight" | "install" | "open";

function parseSettings(observed: Record<string, string | null>) {
  return readPilotSettings(Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, value ?? undefined])));
}

export async function verifyPilotEvidence(stage: Stage, raw: string, observed: unknown) {
  const manifestDigest = await pilotManifestDigest(raw);
  const evidence: unknown = JSON.parse(raw);
  const target = stage === "restore-preflight" ? pilotRestorePlan.parse(evidence) : pilotReleaseManifest.parse(evidence);
  const previousEpoch = "previousEpoch" in target ? target.previousEpoch : target.recovery?.plan.previousEpoch;
  if ("ticketDisposal" in target && target.ticketDisposal.deadline <= Date.now()) {
    throw new Error("The approved Ticket disposal date has passed");
  }
  const observation = observationSchema.parse(observed);
  if (target.deploymentOrigin !== observation.deploymentOrigin || target.deploymentOrigin !== observation.uploadBackendOrigin) {
    throw new Error("Deployment origin mismatch");
  }
  if ("privacyNotices" in target && (observation.webNotices?.th !== target.privacyNotices.th
    || observation.webNotices?.en !== target.privacyNotices.en)) throw new Error("Deployed privacy notices do not match approval");
  for (const runtime of [observation.convex, observation.uploadRuntime]) {
    for (const key of ["T3_DOCTOR_ENABLED", "T3_DOCTOR_ISSUANCE_ENABLED"]) {
      if (runtime[key] !== null && runtime[key] !== "false") throw new Error("Doctor must be closed for the manual pilot");
    }
  }
  const traffic = stage === "open" ? "open" : "closed";
  const convex = parseSettings(observation.convex);
  const uploadRuntime = parseSettings(observation.uploadRuntime);
  const matches = (runtime: ReturnType<typeof readPilotSettings>) => runtime && runtime.epoch === target.epoch
    && runtime.previousEpoch === previousEpoch && runtime.manifestDigest === manifestDigest && runtime.traffic === traffic;
  if (!convex || !uploadRuntime || !matches(convex) || !matches(uploadRuntime)) {
    throw new Error("Effective runtime settings do not match the evidence and expected traffic state");
  }
  // The upload runtime has no invitation or identity sender capability.
  if (uploadRuntime.identitySender || observation.externalEgress !== (convex.identitySender ? "identity-only" : "closed")) {
    throw new Error("External egress does not match the identity sender switch");
  }
  return { stage, deploymentOrigin: target.deploymentOrigin, epoch: target.epoch, manifestDigest };
}

async function main() {
  const [stage, file, inventory, ...extra] = process.argv.slice(2);
  if (stage === "digest" && file && !inventory && !extra.length) {
    console.log(await pilotManifestDigest(readFileSync(file, "utf8")));
    return;
  }
  if (!(stage === "restore-preflight" || stage === "install" || stage === "open") || !file || !inventory || extra.length) {
    console.error("Usage: pnpm pilot:verify digest <file> or pnpm pilot:verify <restore-preflight|install|open> <evidence.json> <switch-inventory.json>");
    process.exitCode = 2;
    return;
  }
  const result = await verifyPilotEvidence(stage, readFileSync(file, "utf8"), JSON.parse(readFileSync(inventory, "utf8")));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    if (error instanceof z.ZodError) {
      // Field paths aid repair without printing inputs or credentials.
      console.error(`Invalid pilot evidence at ${error.issues.map(issue => issue.path.join(".") || "root").join(", ")}`);
    } else if (error instanceof SyntaxError) console.error("Pilot evidence must be valid JSON.");
    else if (error instanceof Error && "code" in error) console.error("Pilot evidence files could not be read.");
    else console.error(error instanceof Error ? error.message : "Invalid pilot evidence.");
    process.exitCode = 1;
  });
}
