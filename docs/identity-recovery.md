# Phase 1 identity recovery

## Customer replacement during restore

Use this procedure after the snapshot is in place and before installing the final release manifest. The named-pilot settings must describe closed traffic, a fresh recovery epoch and the independently recorded previous epoch. Keep public ingress and external egress closed. The process binds the existing customer ID, Auth user ID, username mapping and credential generation. Record the decision in the restricted evidence store using an opaque reference. Independent verification can be in person or use evidence established before the incident.

Include suspended customers in credential reconciliation before installing the release. Replacement preserves suspension. The Owner can separately restore access after reopening. Then the customer signs in with the replacement password, confirms a new recovery code and can open their existing Tickets.

Provision three independently generated 32-byte keys as lowercase hex through the restricted deployment settings. The verifier and reviewer each hold only their own attestation key. Give the private-entry key only to the controlled terminal operator. Deployment administrators and their secret store are trusted. Use individual administrator access and a terminal without session recording. Generate a fresh epoch and rotate these keys before each database replacement, including another attempt to restore an older snapshot.

| Deployment setting | Custody |
| --- | --- |
| `IDENTITY_RESTORE_VERIFIER_ID` and `IDENTITY_RESTORE_VERIFIER_KEY` | Named person verifying the customer |
| `IDENTITY_RESTORE_REVIEWER_ID` and `IDENTITY_RESTORE_REVIEWER_KEY` | Different named person reviewing the evidence and binding |
| `IDENTITY_RESTORE_ENTRY_KEY` | Controlled terminal that the verified customer uses privately |

Use the exact deployment origin. The command accepts HTTPS origins and loopback HTTP for rehearsals.

1. The verifier runs `pnpm identity:restore verify ORIGIN EPOCH VERIFIER_ID CUSTOMER_ID USER_ID GENERATION EVIDENCE_REF`. The command creates a short-lived case and prints its ID.
2. The reviewer runs `pnpm identity:restore approve ORIGIN EPOCH REVIEWER_ID CASE_ID`. Check the displayed binding against the independently retained evidence, then approve it.
3. In the approved terminal run `pnpm identity:restore replace ORIGIN EPOCH CASE_ID`. Check the displayed customer. Give the customer private use of the terminal to type and confirm their new password. The prompt suppresses echo and history. The command sends an encrypted value bound to the approved case over the administrator connection. The case and audit rows record operator identities, account IDs, an opaque evidence reference and outcomes.
4. Record the completed case ID and credential generation in the independent evidence store. Finish reconciliation and install and open the reviewed pilot release. A fresh password sign-in opens the recovery-code enrollment screen. The customer generates a code and confirms that it was saved before opening Tickets. If confirmation was interrupted, sign in again and replace the outstanding code using the current password.

The administrator commands call `identity_restore:verifyCustomer`, `identity_restore:readCaseForReview`, `identity_restore:approveReplacement`, `identity_restore:readReplacement` and `identity_restore:replacePassword`. These are internal functions. The bind and attestation formats are in [identity-restore-crypto.ts](../shared/identity-restore-crypto.ts). Password replacement, the generation change, saved-code consumption, component throttle reset, session revocation and case completion share one transaction. An approved case can retry a rejected password or a rolled-back transaction before expiry. After a lost response, inspect the case with deployment administration before starting further work.

## Staff Google binding changes

The destination signs in with Google to establish a pending identity and sees its verified email and subject on the pending account screen. An independent Owner verifies the exact Google subject and mailbox against separate evidence, then records an opaque evidence reference. A verified Google sign-in within 15 minutes is required for replacement. The source and destination need fresh sign-in after a successful binding change.

In Team, open the member’s Google account settings. Choose Replace or Revoke and enter the evidence reference. For replacement, enter the exact pending email and subject. Review the action and confirm with the code sent to the Owner’s mailbox.

Use the Owner client to read `identity:listTeam` and take the target staff ID, generation and role. Build these arguments for `identity_staff_recovery:changeBinding`:

```ts
const change = {
  staffId,
  expectedGeneration: generation,
  expectedRole: role,
  evidenceRef,
  change: { kind: "replace", replacement: { googleSubject, verifiedEmail } },
} as const;
await sendChallengeCode({
  purpose: "staff-google-binding",
  target: staffGoogleChangeIntent(change),
});
await changeBinding({ ...change, proof: { code } });
```

For revocation use `change: { kind: "revoke" }` and request proof for that selection. Revocation disables the staff principal and retires the old Google binding. To return the person to service, replace the retired binding with a verified pending account, then enable the member through the existing proof-protected access change. Replacement preserves the durable staff ID, role and active or disabled status. The audit ties both Auth users to that staff ID. The previous subject stays revoked even if it presents a new invitation or completes a previously started Google flow.

For a sole active Owner who has lost access, the named deployment operator independently verifies the person and pending replacement account. Configure the exact `OWNER_REPLACEMENT_STAFF_ID` and `OWNER_REPLACEMENT_GOOGLE_SUBJECT`. Invoke internal `identity_staff_recovery:replaceSoleOwner` with `{ staffId, expectedGeneration, replacement: { googleSubject, verifiedEmail }, evidenceRef }`. Remove both settings afterward. The old Owner binding and the candidate’s pending sessions are revoked atomically. The durable Owner and role are preserved and restored to browser use by fresh Google sign-in. Direct revocation of the last active Owner is rejected.

## Reopening the named pilot

Complete customer replacements during quarantine, before the final release manifest is installed. Every restored customer needs a replacement before signing in. Replacement preserves the customer ID, records the new credential and pilot epochs, and requires confirmation of a fresh saved code. The ordinary principal reconciliation command rejects restored customers. Session refresh, Google completion, invitations, staff proofs, T3 keys and admission use the named-pilot release controls. [Pilot operations](named-pilot-operations.md)

After a saved code is used, require the customer to save and confirm a replacement before accessing Tickets or joining another Project.

The pinned Auth package applies one password verification bucket per normalized username. Verification within the bucket uses the same Argon2id operation for stored and dummy credentials. Unknown and disabled usernames also share a ceiling of 200 verification attempts per ten minutes. Enrolled accounts and saved-code recovery retain independent budgets. During unknown-account overload, the generic failure may return faster for an unrecognized username because hashing is skipped. Successful verification clears the username bucket. The reservation records selector activity before hashing. Successful admission clears both the selector bucket and its activity record. The approved inactivity job clears the component counter and its parent record together after 30 days. The package rejects previous-password reuse in recovery and clears the password throttle on a successful credential write. Revalidate these behaviors on every Auth package upgrade.
