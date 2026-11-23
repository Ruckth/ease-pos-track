import assert from "node:assert/strict";
import test from "node:test";
import { pilotManifestDigest, pilotReleaseManifest } from "../shared/pilot-manifest";
import { retentionHeld } from "../shared/pilot-settings";
import { createMediaEndpoints, legacyMediaTransport } from "../server/media-transport";
import { createUploadApp } from "../server/app";
import { verifyPilotEvidence } from "../scripts/pilot-verify";
import { firstEpoch, nextEpoch, pilotOrigin, pilotSettings, releaseEvidence, restorePlan } from "./fixtures/pilot";

function switchObservation(settings: ReturnType<typeof pilotSettings>) {
  return {
    deploymentOrigin: pilotOrigin, uploadBackendOrigin: pilotOrigin,
    webNotices: releaseEvidence("syntheticproject").privacyNotices,
    convex: { ...settings }, uploadRuntime: { ...settings },
    disabled: { legacyWriters: true, doctor: true, assistedRecovery: true, aiRouting: true, ticketEmail: true, line: true, mediaEgress: true },
    externalEgress: "closed",
  };
}

test("restore preflight requires a rotated independent epoch, closed traffic, fenced callers and the exact cleanup state", async () => {
  const raw = JSON.stringify(restorePlan);
  const digest = await pilotManifestDigest(raw);
  const settings = pilotSettings(nextEpoch, digest, firstEpoch);
  const observed = switchObservation(settings);
  assert.deepEqual(await verifyPilotEvidence("restore-preflight", raw, observed),
    { stage: "restore-preflight", deploymentOrigin: pilotOrigin, epoch: nextEpoch, manifestDigest: digest });
  for (const invalid of [
    { ...observed, deploymentOrigin: "https://another.invalid" },
    { ...observed, uploadBackendOrigin: "https://another.invalid" },
    { ...observed, convex: { ...settings, MEDIA_CLEANUP_ENABLED: "true" } },
    { ...observed, convex: { ...settings, MEDIA_CLEANUP_ENABLED: null } },
    { ...observed, convex: { ...settings, UPLOADTHING_TOKEN: "present" } },
    { ...observed, uploadRuntime: { ...settings, UPLOAD_CALLBACK_SECRET: "present" } },
    { ...observed, uploadRuntime: { ...settings, TICKET_PILOT_EPOCH: firstEpoch } },
    { ...observed, convex: { ...settings, TICKET_PILOT_PREVIOUS_EPOCH: null } },
    { ...observed, convex: { ...settings, TICKET_PILOT_TRAFFIC: "open" } },
    { ...observed, disabled: { ...observed.disabled, aiRouting: false } },
    { ...observed, externalEgress: "identity-only" },
  ]) await assert.rejects(verifyPilotEvidence("restore-preflight", raw, invalid));
  await assert.rejects(verifyPilotEvidence("restore-preflight", raw + "\n", observed));
  for (const invalidPlan of [
    { ...restorePlan, epoch: firstEpoch },
    { ...restorePlan, policyHighWaterOrDisjointNamespace: "" },
    { ...restorePlan, scheduledRetentionStopped: undefined },
  ]) await assert.rejects(verifyPilotEvidence("restore-preflight", JSON.stringify(invalidPlan), observed));
});

test("opening requires complete release evidence and independent invitation and identity-sender settings", async () => {
  const release = releaseEvidence("syntheticid");
  const raw = JSON.stringify(release);
  const settings = { ...pilotSettings(firstEpoch, await pilotManifestDigest(raw)), TICKET_PILOT_TRAFFIC: "open" };
  const observed = switchObservation(settings);
  assert.equal((await verifyPilotEvidence("open", raw, observed)).epoch, firstEpoch);
  for (const webNotices of [undefined, { ...observed.webNotices, th: "http://notice.invalid/th" },
    { ...observed.webNotices, en: "https://unexpected.example.test/en" }]) {
    await assert.rejects(verifyPilotEvidence("open", raw, { ...observed, webNotices }));
  }
  for (const key of ["T3_DOCTOR_ENABLED", "T3_DOCTOR_ISSUANCE_ENABLED"]) {
    await assert.rejects(verifyPilotEvidence("open", raw, { ...observed, convex: { ...observed.convex, [key]: "true" } }));
  }
  await assert.rejects(verifyPilotEvidence("install", raw, observed));
  observed.convex.TICKET_PILOT_INVITATIONS = "true";
  await assert.rejects(verifyPilotEvidence("open", raw, observed));
  observed.convex.TICKET_PILOT_IDENTITY_SENDER = "true";
  observed.externalEgress = "identity-only";
  assert.equal((await verifyPilotEvidence("open", raw, observed)).stage, "open");
  for (const ticketDisposal of [
    undefined, { ...release.ticketDisposal, syntheticRehearsal: undefined },
    { ...release.ticketDisposal, deadline: Date.now() - 1 },
  ]) {
    const reviewed = JSON.stringify({ ...release, ticketDisposal });
    const digest = await pilotManifestDigest(reviewed);
    await assert.rejects(verifyPilotEvidence("open", reviewed, {
      ...observed,
      convex: { ...observed.convex, TICKET_PILOT_MANIFEST_SHA256: digest },
      uploadRuntime: { ...observed.uploadRuntime, TICKET_PILOT_MANIFEST_SHA256: digest },
    }));
  }
  const incomplete = JSON.stringify({ ...release, gates: { ...release.gates, privacyAndRightsApproval: undefined } });
  await assert.rejects(verifyPilotEvidence("open", incomplete, observed));
});

test("upload routes are inert before SDK setup in named pilot, with missing mode or across backend drift", async () => {
  let upstream = 0;
  let checks = 0;
  let available = false;
  const handler = legacyMediaTransport({ TICKET_DEPLOYMENT_MODE: "legacy" }, async () => {
    checks++;
    return available;
  }, () => { upstream++; return new Response(); });
  for (const method of ["GET", "POST"]) {
    const request = new Request("https://synthetic.invalid/api/uploadthing", { method, headers: { "uploadthing-hook": "callback" } });
    for (const env of [{}, { TICKET_DEPLOYMENT_MODE: "named-pilot" }, { TICKET_DEPLOYMENT_MODE: "legacy", TICKET_PILOT_EPOCH: nextEpoch }]) {
      const endpoints = createMediaEndpoints(env);
      const app = createUploadApp(endpoints, endpoints.upload);
      assert.equal((await endpoints.upload(request)).status, 404);
      assert.equal((await app.request(request)).status, 404);
      assert.equal((await app.request("https://synthetic.invalid/api/uploads/cancel", { method: "POST" })).status, 404);
    }
    assert.equal((await handler(request)).status, 404);
  }
  assert.equal(checks, 2);
  assert.equal(upstream, 0);
  available = true;
  assert.equal((await handler(new Request("https://synthetic.invalid/api/uploadthing"))).status, 200);
  assert.equal(upstream, 1);
});

test("a release must approve the 30-day inbox period, and any operator hold value other than false holds expiry", () => {
  const release = releaseEvidence("syntheticproject");
  assert.equal(pilotReleaseManifest.safeParse(release).success, true);
  const { inboxRetention: _omitted, ...missing } = release;
  for (const invalid of [missing, { ...release, inboxRetention: { itemDays: 31 } }, { ...release, inboxRetention: { itemDays: 30, extra: 1 } }]) {
    assert.equal(pilotReleaseManifest.safeParse(invalid).success, false);
  }
  assert.equal(retentionHeld({}), false);
  assert.equal(retentionHeld({ TICKET_RETENTION_HOLD: "false" }), false);
  for (const value of ["true", "", "FALSE", "incident-7"]) assert.equal(retentionHeld({ TICKET_RETENTION_HOLD: value }), true);
});
