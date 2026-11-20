# Named identity (Phase 1)

Staff sign in with Google and are admitted only by invitation. Customers join a
Project with a single-use invitation, choose a username and password, and keep a
saved recovery code. The shared staff password, public email signup and raw
session tokens are gone. The [staff plan](architecture/t3code-phase1/01-staff-accounts.html), [customer plan](architecture/t3code-phase1/02-customer-accounts.html) and [design audit](architecture/t3code-phase1/audit.html) record the decisions.

## Pinned versions

| Package | Version |
| --- | --- |
| `convex` | 1.49.0 (Auth 2.0.0 requires ^1.48.0) |
| `@convex-dev/auth` | 2.0.0 (core, `password`, `username`, `google` components) |
| `convex-test` | 0.0.71 |
| Local backend | `precompiled-2026-11-16-80befbc` |

`bindMethod` is an internal Auth 2.0.0 API. Type checking uses the package's
`convex-auth-internal-types` export condition (see `customConditions` in the
tsconfigs). Re-check both on every Auth upgrade.

## How a session becomes access

1. A sign-in completion (Google ticket redemption, username/password, the local
   test provider) mints a Convex Auth session **and** inserts a
   `sessionAdmissions` row in the same mutation. The row binds the core session
   ID (the JWT `sub`), the auth user, the principal and its credential
   generation. `authMethodMutation` in `convex/functions.ts` refuses to return a
   completed sign-in unless that row exists for the minted session, so a failed
   admission rolls back the session too.
2. Every protected call (`actorQuery`, `staffMutation`, `ownerMutation`, …)
   resolves the verified JWT subject through the core (`getSession`) and checks
   the admission: same user, not revoked, principal active, generation equal.
   Any mismatch is `SESSION_EXPIRED`. Refresh rotates tokens but never creates or
   changes an admission.
3. Disable, re-enable and recovery advance the principal's `generation` and
   `validAfter`, revoke the user's live core sessions and mark their corresponding admissions revoked. Ended sessions have no authority; their admission IDs remain available for historical Ticket attribution.
   Re-enabling restores nothing: a fresh sign-in is required. A Google flow that
   started before the last transition is refused (`ACCESS_UNAVAILABLE`).
4. Google start records a one-use flow (state digest, start time); completion
   requires that unconsumed flow. A first Google sign-in creates a **pending**
   identity that can only read and accept a staff invitation.

## Interface for peers (assignment, inbox, routing, T3 doctor)

Use these; do not add token arguments or read identity tables directly for
authorization.

- **Protected handler context.** Every policy constructor in `convex/functions.ts`
  gives `ctx.actor` and `ctx.session`:
  - staff: `{ role: "staff", staffId: Id<"staff">, staffRole: "owner" | "staff" }`
  - customer: `{ role: "customer", customerId: Id<"customers"> }`
  - `ctx.session._id` is the `sessionAdmissions` ID, a non-secret credential
    reference for audit rows.
- **Policies.** `actorQuery/Mutation`, `staffQuery/Mutation`,
  `customerQuery/Mutation`, and `ownerQuery/Mutation` (team, Projects,
  membership, routing policy, Operations repair). Staff have global Project
  visibility in this pilot.
- **Named staff.** `identity:listStaffDirectory` (staff only) returns active
  staff `{ staffId, name, role }`, sorted by name. Use `staffId` as the durable
  assignee/recipient key.
- **Customers.** `tickets.ownerCustomerId`, `projectMembers.customerId` and
  `customers` (`username`, `displayName`, `status`). Disabling a customer revokes their sessions and suspends saved-code recovery. Re-enabling permits a fresh sign-in or use of the previously saved code. Reconciliation into the first pilot epoch clears the previous code and requires confirmation of its replacement before Ticket access or Project joining.
- **Attribution.** `actorFields(actor)` stamps `actorRole`, `actorCustomerId`
  and now `actorStaffId` on events, receipts and upload intents. Create and
  attach receipts and upload intents are scoped to the individual staff member,
  so one staff member cannot adopt another's request ID.
- **Viewer.** `identity:viewer` returns the browser principal or `null`.

## Endpoint inventory

`scripts/check-arch.ts` pins every public registration to its policy
(`PUBLIC_REGISTRATIONS`); the policy test fails on an extra, missing or
relabelled export. Purpose-labelled entry points:

| Export | Policy |
| --- | --- |
| `auth:refreshSession`, `auth:signOut`, `auth:isAuthenticated` | pinned core, by purpose |
| `auth:startSignInWithGoogle` | stock start + one-use flow record |
| `auth:completeSignInWithGoogle` | stock ticket redemption + flow check + admission |
| `auth:signInWithPassword` | action with one invalid-credentials response and transactional session admission |
| `auth:signUpWithInvitation` | invite, username, password, customer, membership and recovery-enrollment admission in one mutation |
| `auth:changePassword` | live customer session + current password; revokes other sessions |
| `auth:recoverWithCode` | saved code; resets password, consumes code, advances generation, revokes all sessions |
| `auth:signInLocalFixture` | disposable loopback backend with `LOCAL_FIXTURES_ENABLED` only |
| `identity:viewer`, `identity:previewCustomerInvitation` | public read (never consumes) |
| `identity:previewStaffInvitation`, `identity:acceptStaffInvitation` | pending Google identity only |
| `identity:sendChallengeCode` | identity sender; the internal mutation checks the live session and caps issuance across purposes and sessions for the principal and mailbox |
| `uploads:recordUploadedFile` | staff JWT **or** callback credential; mixed credentials refused |

The sign-in action reserves one verification attempt for the normalized username
in a private mutation. Unrecognized accounts also spend a shared attempt.
After the reservation commits, the password component performs the appropriate
Argon2 check in an action. For a successful match, a final mutation rechecks
the credential version, account binding, status, generation and pilot epoch
before creating the session and its admission together. Saved-code recovery
uses a separate proof and can proceed when password attempts are exhausted.

The staff invitation stays in the originating browser tab during the Google redirect. The server accepts only the clean staff login, invitation, and root return paths on approved origins.

The Google callback (`/oauth/google/callback`) and the deployment JWKS are
component- and platform-owned routes mounted from `convex/convex.config.ts`.
The legacy `auth:login`, `auth:currentSession`, `auth:logout`,
`customers:register`, `customers:login`, `projects:addProjectMember`, the
`sessions` and `loginAttempts` tables and the session-cleanup cron are removed.

## Deployment settings (live setup stays gated)

None of these are set on any shared deployment by this change.

| Setting | Purpose |
| --- | --- |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | Google OAuth client (required by `convex.config.ts`). Register `<site-url>/oauth/google/callback`. |
| `AUTH_REDIRECT_ORIGINS` | Comma-separated exact app origins (and `http://127.0.0.1:4271` for the CLI). Default `http://localhost:5173`. |
| `IDENTITY_SENDER=resend`, `RESEND_IDENTITY_API_KEY`, `IDENTITY_SENDER_FROM` | Restricted identity sender for invitation and action codes. Unset pauses staff invitations and sensitive staff changes (`IDENTITY_SENDER_UNAVAILABLE`). |
| `IDENTITY_CODE_KEY` | ≥32-character key for the keyed digest of 8-digit codes. |
| `OWNER_BOOTSTRAP_GOOGLE_SUBJECT` | Exact Google subject of the first Owner. |

The disposable local backend gets inert Google placeholders from
`pnpm agent:setup` (`scripts/local-identity-env.mjs`); Google sign-in cannot
work there, and the local test provider stands in.

## Runbooks

**First Owner.** The Owner signs in with Google (they land on "not on the team").
The operator lists pending identities with
`pnpm convex:local run identity:listPendingIdentities` (on a real deployment,
the equivalent internal call under the deployment operator), verifies the subject
and email out of band, sets `OWNER_BOOTSTRAP_GOOGLE_SUBJECT`, then runs
`identity:bootstrapOwner '{"googleSubject":"…"}'`. It refuses once any staff row
exists. The Owner signs in again to get staff authority. Enroll a second Owner
before general rollout. The last active Owner with a current-epoch Google binding cannot be demoted, disabled or revoked. Development reset bootstraps the Owner after clearing the store. The disposable rehearsal uses an internal loopback fixture for the first sign-in. [Reset procedure](dev-reset.md#owner-bootstrap-after-clearing)

**Staff.** In Team, the Owner enters the exact email and role, then confirms
creation with a fresh code from their own mailbox. Reissue needs its own code
for the selected invitation. These codes expire after five minutes. Five
requests within 15 minutes pause further requests for that principal and
mailbox for 15 minutes. The link
`/staff/invite#invite=…` is shown once; deliver it yourself. The invitee signs in
with Google using exactly the invited verified address, requests a code to that
mailbox, enters it, then signs in again. Owners reissue or revoke pending
invitations, and change role or access with an emailed code bound to that exact
change. Team also supports [Google account replacement and revocation](identity-recovery.md#staff-google-binding-changes).

**Customers.** Owner → Project members → Create invitation link
(`/customer/join#invite=…`, single use, 14 days, transferable until redeemed).
Opening it never consumes it. A new person chooses a username (3–32 ASCII, shown
lowercased before submit), a Thai or English display name and a 15–100 code point
password, then generates, saves and confirms a recovery code before opening
Tickets. Returning customers can sign in from the invitation and are sent back
to Join. The browser keeps the invitation in memory through sign-in and saved-code
recovery. A signed-in customer adds the Project to their account. A completed Join
can be retried by the same customer with current membership while the invitation
and Project remain in the active release. A staff or pending session can sign
out from Join to switch accounts.

**Recovery.** `/customer/recover`: username, saved code, new password. Every
session is revoked, the code is consumed and the customer signs in and saves a
new code. Rejected proofs have the same response for any username. Saved-code
proof stays available while failure budgets are exhausted. A successful reset
clears that username's recovery and password verification throttles. Losing both
password and code requires a new invitation and a separate account. Earlier
Tickets stay with the original account. Assisted recovery is deferred by the plan.

## Verification

```bash
pnpm agent:setup                                  # local backend + placeholders
pnpm convex:local env set LOCAL_FIXTURES_ENABLED true
pnpm convex:local env set IDENTITY_SENDER local
pnpm convex:local env set IDENTITY_CODE_KEY local-only-identity-code-key-0123456789abcdef
pnpm convex:local run local_smoke:run '{}'        # real argon2id, JWT signing, Google route
pnpm test:convex tests/convex/identity.test.ts
pnpm check
```

`local_smoke:run` on the disposable backend proves: seeded admission and roles,
real username/password sign-in with admission, wrong password issues no session,
the stock Google start serves the component callback route and records the flow,
an unknown Google ticket admits nothing, and a live disable denies the open
session on its next call. `tests/convex/identity.test.ts` covers enrollment
atomicity and rollback, the password policy (14/15/100/101 code points, Thai,
emoji, NFC), masked sign-in and per-account throttling, disable/re-enable and
refresh denial, forced admission failure rollback, recovery (single winner under
concurrency, failed reset leaves state intact, disabled customer), password
change, staff invitation mailbox proof, Google flow timing across
disable/re-enable, last-Owner protection, intent-bound proof replay and Owner
bootstrap.

convex-test cannot load the argon2id WASM (stubbed in
`tests/convex/fixtures/argon2-stub.ts`) or route component `httpPrefix`
callbacks; both run for real in `local_smoke:run`.

## Implementation evidence and release checks

The automated browser suite exercises invitation, sign-in and recovery. The pinned password component performs bounded dummy verification and clears its per-account throttle after recovery. The shared pilot boundary enforces text-only Tickets. Two-operator restore replacement and Google binding changes preserve the durable principal. [Account recovery](identity-recovery.md) · [Pilot controls](named-pilot-operations.md)

A real Google redirect, restricted staff identity email delivery, manual VoiceOver/NVDA and zoom checks, and unaided Thai-user sessions still require release evidence.

An authorized development reset bootstraps a new Owner after clearing the store and uses a fresh session for seeding. A reset interrupted after clearing can resume in its own run directory. [Bootstrap and resume](dev-reset.md#owner-bootstrap-after-clearing)

## Business customer invitations

Before inviting a real customer, the Owner verifies through the existing business relationship that the recipient represents the business and is at least 20, and shares the approved privacy notice. Each newly issued invitation records the confirmation, issuing Owner, Project and issue time. An unused invitation from before this check must be replaced. The app collects no birth date or identity document for this check.

Configure `VITE_PILOT_PRIVACY_NOTICE_TH` and `VITE_PILOT_PRIVACY_NOTICE_EN` with the controller-approved HTTPS pages before building the pilot frontend. Select Thai and English on the deployed sign-in and invitation pages, open each notice, and include the URLs and evidence in the privacy release approval. Links open without forwarding the invitation page as a referrer.
