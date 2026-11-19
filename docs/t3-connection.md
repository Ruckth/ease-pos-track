# Connect T3 Code

Connections are limited to the read-only doctor for one active Project. A successful doctor response confirms the named staff account, Project, expiry and approved compatibility for the Mac running the command. The Settings list shows key availability. A signed or installed kit alone gives no connection status.

Phase 2 ships in the Phases 1–3 change as a separately activated capability. The first two customers use the manual workflow with both doctor switches off. A team can keep using that workflow indefinitely. Enable the kit only when staff need to verify their T3 connection and the installed host passes the checks below. CI runs the signing and Keychain fixtures on macOS.

## Named identity and Settings route

[convex/t3_identity.ts](../convex/t3_identity.ts) is wired to the named identity in [docs/identity.md](identity.md).

- `browser(ctx)` runs the live admission check (`requireActor`) and accepts only an active staff actor whose session generation matches `staff.generation`. It maps `staff._id`, `staff.email`, `staff.role`, `staff.generation` and the `sessionAdmissions` ID. Customer, pending, revoked, expired and stale sessions return null.
- `staff(ctx, staffId)` normalizes the stored ID against `staff` and returns only an active row. Inside a named pilot the row must also be reconciled into the current pilot epoch. Disable, re-enable and pilot reconciliation advance the generation, so earlier keys stop working.
- `project(ctx, staff, projectId)` follows the launch policy: active named staff use every active Project, limited to the pilot Project allowlist when a pilot is installed.
- `consume(ctx, admission, proof)` consumes the shared identity challenge for that exact admission. The challenge purpose is the T3 action (`t3-key-issue`, `t3-key-rotate`, `t3-key-revoke`). Its intent binds the deployment URL, staff ID, admission generation and the exact `intendedChange` from [t3ProofIntent](../shared/t3-doctor.ts). A wrong code commits a failed attempt. Requesting a new challenge replaces the session's outstanding one for the same action.

Staff reach `ConnectT3Code` from **More → Connect T3 Code**, which opens the route `/staff/settings/t3` (`APP_PATHS.staffT3Settings`). Set the signed kit's `settingsUrl` to `<app origin>/staff/settings/t3`. The page is keyed by the signed-in staff member, and sign-out reloads the app, so a revealed key is dropped. `requestProof` calls `identity:sendChallengeCode` with the action as `purpose` and `intendedChange` as `target`, and the code goes to the holder's own mailbox. `convex/http.ts` mounts only the doctor route. The Google callback and JWKS are component-owned routes (`httpRouteManifest` in [convex/functions.ts](../convex/functions.ts)).

## Sign and publish a release

The release operator and independent maintainer each hold an Ed25519 key in their own approved signing environment. A build machine needs only their two raw 32-byte public keys encoded as base64. It must never receive either private key. Record the organization-controlled HTTPS distribution origin, two named custodians, verified fingerprints, build SHA, native signing identity and rollback build outside the kit. The kit embeds both public roots and requires two detached signatures over identical manifest bytes.

Use a public JSON spec per verified combination. The following is a shape with illustrative values. Supply real public pins and released versions only after validation.

```json
{
  "releaseId": "2026-11-connection",
  "deployment": "approved-deployment-id",
  "gatewayOrigin": "https://deployment.example.test",
  "settingsUrl": "https://app.example.test/staff/settings/t3",
  "publisher": "Release operator name",
  "approvalSigner": "Independent maintainer name",
  "releaseKey": "<base64 raw public key>",
  "approvalKey": "<base64 raw public key>",
  "compatibility": {
    "id": "codex-arm64",
    "provider": "codex",
    "macOS": "26.5.2",
    "architecture": "arm64",
    "t3": "1.0.0",
    "cli": "0.1.0",
    "skill": "0.1.0"
  }
}
```

1. Build with `pnpm exec tsx scripts/t3-kit/release.ts build SPEC NEW_KIT_DIR` on the macOS toolchain. Apply the organization's native code signing and distribution requirements before hashing the final executable. Use a stable native signing requirement across releases for Keychain access.
2. Run `pnpm exec tsx scripts/t3-kit/release.ts manifest SPEC KIT_DIR`. Review the generated release identity, version tuple, hashes and install paths against the build source and release evidence.
3. Each custodian signs the exact reviewed `manifest.json` bytes in their signing environment. Return the raw 64-byte Ed25519 signatures as `manifest.release.sig` and `manifest.approval.sig`. The independent maintainer signs only after review.
4. Run `pnpm exec tsx scripts/t3-kit/release.ts seal SPEC KIT_DIR NEW_ZIP`. It checks both signatures, the complete inventory and file hashes. Publish its output with the archive and record the CLI and archive SHA-256 and both signer identities through an independently trusted channel. The CLI cannot establish its own trust before first execution.
5. Exercise the exact native macOS, architecture, T3 build, provider, CLI and skill combination on a clean execution host. Verify sandbox and secure file delivery, actual provider skill discovery in a fresh session, Keychain access across restarts, and successful and denied doctor calls. Use separate evidence for Codex and Claude. Publish only passing combinations.

## Deployment gates

- Leave `T3_DOCTOR_ENABLED` and `T3_DOCTOR_ISSUANCE_ENABLED` unset until the named identity and Settings hooks, release evidence and operator enablement are complete. Each gate requires exactly `true`. The first enables the doctor route. The second enables issue and rotate. Revocation still uses the live named browser session and shared proof when either gate is off.
- Set `T3_DOCTOR_EPOCH` to 32 random bytes encoded as 64 lowercase hex characters in the deployment secret store. Keep it outside database snapshots and restore inputs. Replace it before reopening the gateway after a restore or incident. Previously issued keys then fail even against a restored snapshot.
- Set `T3_DOCTOR_RELEASE` to JSON with `id`, `publicationUrl`, `releaseOrigin`, `gatewayOrigin`, `deployment` and `combinations`. The first four metadata values and `deployment` come from the approved release record and public spec. Each combination is the exact spec compatibility object plus `bootstrapSha256` from seal and HTTPS `downloadUrl` on `releaseOrigin`. Use unique combination IDs. Changing the release ID or removing a combination retires its old keys, so coordinate revocation and re-enrollment. Never reassign a release or combination ID to different bytes.
- The gateway accepts an empty HTTPS POST to `/integrations/t3/doctor` on the configured origin with one personal bearer. Browser credentials, query parameters, request bodies and other operations fail. Its only private read returns connection metadata. The manifest lives in [convex/functions.ts](../convex/functions.ts).

## Connect and disconnect

Verify both the archive SHA-256 and extracted executable SHA-256 with the trusted release record using macOS `/usr/bin/shasum -a 256` before running the signed executable. Keep the extracted package together at a trusted local path. From the intended T3 workspace, its `inspect` command shows the Mac's execution host ID, release versions and planned skill path. Confirm the current T3 build and provider in that session. Run `install --confirm` from that workspace. The command writes the manifest-owned provider skill. Keep the skill local to the intended workspace. [Codex project skill path](https://developers.openai.com/api/reference/cli) · [Claude project skill path](https://code.claude.com/docs/en/skills#choose-where-skills-load)

Select the exact setup and Project in Settings, enter the host ID and a machine label, and obtain the personal key after email proof. A maximum of three current keys per staff account and one key per enrolled host applies. Use `import PROJECT --file ABSOLUTE_PATH` for T3 secure file delivery, or `import PROJECT` from a trusted interactive terminal. The Mac consumes the owner-only file or reads hidden input. It uses local macOS Keychain after successful gateway verification and never sends a key through shell arguments, environment variables or clipboard. The host ID is a local match check against the key metadata, not remote hardware attestation. [T3 secure file implementation](https://github.com/pingdotgg/t3code/blob/2dc5ebd52f238893344609a56a6918f700650438/apps/server/src/secrets/SecretRequests.ts)

From the same workspace run `doctor PROJECT`. For rotation, the holder can retain or shorten the active expiry. Rotation immediately revokes the previous key. If the one-time replacement is lost before import, revoke its row and issue another. An Owner can revoke another holder's key. Revocation is independent of local uninstall.

Confirm remote revocation in Settings, then run `uninstall PROJECT --confirm` from the same workspace. It removes the selected Keychain entry and the byte-matching manifest-owned skill. The downloaded kit remains at its chosen location. Local offline uninstall displays the Settings link and leaves remote revocation pending until confirmed. Keep that link for reconnect.

## Local verification

Run `pnpm test:convex tests/convex/t3-doctor.test.ts` for admission, proof, scope, expiry, rotation, revocation, credential-class denials and unchanged Ticket and upload intent state. It uses the real named identity adapter, admitted Convex Auth sessions and the local identity sender. Only the HTTPS host is a test fixture. On macOS, `pnpm test:one tests/t3_kit.test.ts` builds both provider packages with independent in-memory signing keys and exercises signature and file tamper, secure entry, isolated Keychain and a fixture doctor response. Provider discovery, real T3 transport permissions and real deployment enablement are separate release evidence.
