# Development reset

Checkpoint 19 prepares this procedure. Checkpoint 20 runs it against shared development. No shared-development reset or provider verification is implied by a successful local rehearsal.

The recorded identities are `dev:outstanding-viper-292` and UploadThing app ID `2xv6n0a5t1`, in `scripts/dev-reset.config.json`. These are identifiers, not secrets. The tool reads the deployment from `.env.local`; missing, production-marked or different identities fail closed. Both the passed identity and file identity must match the record. Development calls refuse any `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT_TOKEN` or `CONVEX_SELF_HOSTED_*` entry in that file, even if empty. Use the deployment tooling to correct such configuration; never edit `.env.local` or `.env.convex-local` manually. Shell `CONVEX_*` overrides are scrubbed. If the recorded app is not exclusively the development app, stop and establish a dedicated development storage scope before cutover; do not substitute a production token.

## Pre-flight

- Finish P0–P7 and review the checkpoint 19 changes. Install with pnpm. The pinned Convex CLI is 1.49.0. Agent-mode CLIs list environment names only, so the tool always requests `env list --include-values` (captured, never printed).
- First remove `UPLOADTHING_TOKEN` from the target using `pnpm dev:reset env-remove UPLOADTHING_TOKEN` (add `--target local` for rehearsal). This makes the old `upload_cleanup.cleanupExpiredUploads` cron no-op; that implementation ignores the new cleanup flag. Then set `MEDIA_CLEANUP_ENABLED` to exactly `false` using the reset tool's env command. Stop browser/CLI writers, upload servers and callbacks. Pause old cron jobs/scheduled work in the Convex dashboard as well. Removing the token cannot stop an already-running deletion: wait for in-flight callbacks/deletions to settle. Keep writers stopped through inventory, clearing and verification. Execution checks token absence before exporting any rows; `configure()` restores the development token only after old rows are cleared.
- Confirm the dashboard deployment and storage application against the committed identities. The app ID was recorded from the token locally; no provider call was made during preparation. The reset checks the token's app ID and the API key's authenticated app identity before deletion. Review the scope in the provider dashboard during checkpoint 20.
- Have access to the recorded development deployment and its development UploadThing token. The token defaults to `.env.local`'s `UPLOADTHING_TOKEN`; `DEV_RESET_UPLOADTHING_TOKEN` may supply the same app's token. Neither value is printed.
- Prepare the post-clear Owner bootstrap **before** executing. Clearing erases every staff row, admission and Convex Auth session and refresh token, so no Owner session can survive a reset; the Owner is bootstrapped again afterwards (see [Owner bootstrap after clearing](#owner-bootstrap-after-clearing)). Execution refuses before inventory unless the target has `TICKET_DEPLOYMENT_MODE=legacy` exactly, no `TICKET_PILOT_*` setting (`RESET_LEGACY_MODE_REQUIRED`), `CLERK_OAUTH_CLIENT_ID` and `CLERK_OAUTH_CLIENT_SECRET` (`RESET_IDENTITY_SETTINGS_REQUIRED`), the out-of-band verified `OWNER_BOOTSTRAP_GOOGLE_SUBJECT`, and `http://127.0.0.1:4271` in `AUTH_REDIRECT_ORIGINS` (`RESET_OWNER_BOOTSTRAP_NOT_READY`). These are operator settings ([identity](identity.md#deployment-settings-live-setup-stays-gated)); the tool never sets them on development. The Owner must be at this terminal with a browser for two Google sign-ins, and port 4271 must be free (stop any worktree backend whose port block uses it). A database with an installed named pilot (`pilotRelease` row) is never reset (`RESET_PILOT_INSTALLED`): use the restore procedure in [named-pilot-operations.md](named-pilot-operations.md).
- Optionally supply `DEV_RESET_CUSTOMER_PASSWORD` through the environment. Use at least 24 characters, including a letter and digit (the server separately allows at most 100 code points). Otherwise the tool generates a random password with 192 bits of randomness and prints it once, after verification succeeds. Both example customers share it. Store the output privately. There is no staff password: the Owner signs in with Google.
- Optionally supply `DEV_RESET_CALLBACK_SECRET` through the environment. Otherwise a random callback credential is generated. Configure that exact value in the upload server after reset.
- `.reset/` is gitignored and private. Each invocation creates a separate directory. It contains a sensitive snapshot (including old sessions/customer hashes), manifests, and, after execution, `runtime.env`. Keep these files private; never attach snapshots/configuration to an issue. Preserve unresolved manifests across retries, even after rows have been cleared.

## What execution does

`pnpm dev:reset` defaults to read-only `inspect` on recorded development. Inspection exports a snapshot, records counts and row IDs for application and component tables, inventories nested media keys with table/row/field sources, and writes `manifest.json` plus `unresolved.json`. It does not push code, change target environment variables, seed, call the provider or delete anything. Local inspection may start/stop the disposable backend through a read-only system-query subscription in the guarded wrapper.

`execute --confirm <exact identity> --expect <reviewed inspect manifest>` requires `MEDIA_CLEANUP_ENABLED` to be present and exactly `false`, `UPLOADTHING_TOKEN` to be absent and the Owner bootstrap settings above before inventory. The entire CLI `env list` output is validated before dotenv parsing; unparseable text, malformed quotes and duplicate entries refuse execution. Before any remote write, the candidate deployment URL must answer `/instance_name` with the exact recorded deployment name; failures/redirects refuse. It then:

1. Saves the inventory while old rows still exist. Refuses before provider I/O if any row or media key was added since the reviewed inspection or if a named pilot is installed. Use a read-only inspect manifest for the same target that includes row IDs. No final-schema handler is needed.
2. Checks the configured token's app ID, then requires the authenticated `/v7/getAppInfo` response's app ID to match too. An authenticated, paginated `listFiles` proves keys belong to that app. Only keys present in both the old-data inventory and that app's uploaded-file listing are eligible. It never deletes the entire provider app. The endpoint and app-scoped listing are described in the [UploadThing REST specification](https://docs.uploadthing.com/api-reference/openapi-spec) and [UTApi reference](https://docs.uploadthing.com/api-reference/ut-api); identity/response failure refuses clearing. Provider requests were tested only with fakes in checkpoint 19.
3. Persists `unknown` before each deletion and then saves the typed result. Only `success=true` with `deletedCount=1` counts as `deleted`. Missing keys, mismatches, failures and ambiguous responses remain unresolved. Already-absent behavior is deliberately unverified. A process interruption leaves its latest uncertainty on disk. Unknown outcomes are never counted as deleted.
4. Rechecks the cleanup flag, token absence and deployment readiness, then exports immediately before clearing. Refuses if a pilot was installed or any row ID or media key was added since the execution inventory. Both exports and newly discovered unresolved keys are retained. Imports an empty snapshot ZIP using `import --replace-all --yes`, clearing old application rows, omitted tables and every Convex Auth component row (sessions, refresh tokens, passwords, usernames) **before** the schema push. The manifest stage becomes `rows-cleared`. Each subsequent step saves its stage (`configured`, `pushed`, `owner-ready`, `verified`). `data` defaults to 100 rows and is unsuitable for complete inventory. `deploy` can select production and is never used. Keep writers stopped through the final export and clear, which are separate CLI calls.
5. Sets cleanup and local fixtures to `false`; configures the callback credential (named identity settings — Google client, redirect origins, identity sender, bootstrap subject — are operator settings, see docs/identity.md) and matching development storage token **before** pushing final schema/backend with `dev --once --typecheck disable`. The local rehearsal instead enables its loopback fixture and sets the fixture Owner subject (below). The old cron now has no old rows to delete, and the new code starts with cleanup disabled. Prints configuration filenames, never their values. `runtime.env` retains matching HTTP secrets and `CONVEX_URL` privately; `web.env` contains only `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`. `backend.env` is the private Convex configuration input. Local configuration leaves the provider token absent. The tool never edits repository environment files.
6. Checks the post-clear export and bootstraps the Owner only on an empty installation. On resume from `pushed` or `owner-ready`, it can reuse the configured Owner if the linked user, bootstrap audit and any required Google sign-in rows verify the bootstrap and there are no other rows. It blocks on unexpected rows, including a partial seed. It adds any media found after clearing to `unresolved.json` and retains earlier outcomes.
7. With a fresh Owner session, seeds two Projects (`POS`, `APP`), two customers (`alice`, `bob`) enrolled through Owner-issued Project invitations, four memberships and six text Tickets through registered app commands. Each Project has Tickets 1–3, one each in New, Acknowledged and In Progress. Seed verification exercises explicit roles, owner isolation, reference search, edit/undo, archive/restore, totals and revoked sessions. IDs, hashes, credentials, timestamps and audit versions are intentionally fresh; example content, numbering and workflow distribution are deterministic.
8. Runs the real CLI adapter's login, whoami, list, get and logout against the seeded backend with that same Owner session (rotated like a saved login, then signed out), without Keychain or uploads. The Owner session lives only in the reset process: it is never printed, written to disk or passed through the environment. Writes `verification.json` only when the API and CLI checks pass. This is evidence for those checks, not evidence of browser/provider cutover acceptance. The post-cutover checklist below remains mandatory before enabling cleanup. The tool never enables cleanup itself.

### Owner bootstrap after clearing

Development: the tool signs the Owner in with Google through the Ticket CLI's loopback adapter (`http://127.0.0.1:4271/`). The first sign-in records the pending Google identity. The tool prints the signed-in email, signs that pending session out and runs the one-use internal `identity:bootstrapOwner` with the configured `OWNER_BOOTSTRAP_GOOGLE_SUBJECT`. The mutation refuses any other subject, an unverified email or an installation that already has staff. A second Google sign-in then gives the fresh Owner session used for seeding. If a wrong-account sign-in leaves pending identity rows, start with a fresh inspection.

Local rehearsal: the disposable backend has no Google. With `LOCAL_FIXTURES_ENABLED=true` on the loopback deployment, internal `seed:localPendingOwner` records the verified pending identity of the fixture Owner (`owner@local.test`, subject `local-fixture-owner`), the same real `identity:bootstrapOwner` promotes it, and the seed signs in through `auth:signInLocalFixture`. These loopback fixtures exist only for disposable rehearsals; the server refuses them elsewhere.

### Resuming after the clear

A resumable failure after `rows-cleared` prints the exact command. After fixing the cause, continue in the same run directory:

```bash
pnpm dev:reset resume --confirm <exact identity> --expect .reset/<run-directory>/manifest.json
```

Add `--target local` for rehearsal. Resume requires the exact identity, the run's manifest for that target in a post-clear stage, and `MEDIA_CLEANUP_ENABLED=false` plus the bootstrap settings. It exports current application and component rows before configure, push or seed. It skips completed stages, retains all snapshots and manifests, and never clears the database or calls the provider.

An installed pilot requires the restore procedure in [named-pilot-operations.md](named-pilot-operations.md). Unexpected rows (`RESET_POST_CLEAR_ROWS_FOUND`) or media (`RESET_POST_CLEAR_MEDIA_FOUND`) leave the current rows intact and mark the run `post-clear-blocked`. To reset a legacy backend in this state, start with a fresh read-only `inspect`, review its manifest, then separately authorize `execute` with `--confirm` and `--expect`. A blocked run refuses further resumes (`RESET_RESUME_REQUIRES_INSPECTION`).

For a run that stopped before clearing (`execution-inventoried`, `media-settled`, `inventory-grew-before-clear`), start with a fresh inspection. `resume` refuses those stages and inspect manifests (`RESET_RESUME_REQUIRES_CLEARED_RUN`), as well as verified runs (`RESET_ALREADY_VERIFIED`). `DEV_RESET_OWNER_REFRESH_TOKEN` is obsolete because clearing invalidates every pre-reset session.

Local Convex CLI calls go through `pnpm convex:local`, which has no remote capability and retains signal forwarding/environment restoration. A leftover `.env.local.shared-backup` means stop and recover the interrupted wrapper before proceeding. The reset tool has a separate development runner: each call uses a fresh private temporary env file containing only `CONVEX_DEPLOYMENT=<validated dev id>`, scrubs every `CONVEX_*` child variable, and deletes that file afterwards, including command failures. It never passes `.env.local` to the CLI. Each call saves and restores `.env.local` and `.gitignore`, including on failure or a forwarded SIGINT/SIGTERM/SIGHUP; restoration waits for the CLI to exit. Use only `pnpm dev:reset` commands for the future remote cutover; override flags and production targets are refused.

## Local rehearsal only

Local selects the fake automatically, never constructs UTApi, and refuses a real adapter. It bootstraps the loopback fixture Owner after clearing, as described above, and leaves `LOCAL_FIXTURES_ENABLED=true` and `OWNER_BOOTSTRAP_GOOGLE_SUBJECT=local-fixture-owner` on the disposable backend. The fake only recognizes `local-fake-` keys; other keys remain unresolved. It does not upload or delete provider files. Initialize a new checkout's local backend once with `pnpm convex:local` if it has never been created.

Before either rehearsal, remove the local token and require the explicit pause flag:

```bash
pnpm dev:reset env-remove UPLOADTHING_TOKEN --target local
pnpm dev:reset env-set MEDIA_CLEANUP_ENABLED false --target local
```

For a populated backend, review the inspect output and replace `<inspect-directory>`
with its directory and `<exact-target-from-inspect>` with the exact `target` from
its `manifest.json`. The identity comes from this checkout's local backend
configuration; new backends commonly use `anonymous:anonymous-agent`. Do not
reuse an identity or manifest from another checkout:

```bash
pnpm dev:reset inspect --target local
pnpm dev:reset execute --target local --confirm <exact-target-from-inspect> --expect .reset/<inspect-directory>/manifest.json
```

For an empty backend, create an empty ZIP locally and clear only local rows, then inspect and execute:

```bash
pnpm exec tsx -e 'import AdmZip from "adm-zip"; import {mkdirSync} from "node:fs"; mkdirSync(".reset", {recursive:true,mode:0o700}); new AdmZip().writeZip(".reset/empty-rehearsal.zip")'
pnpm convex:local import --replace-all --yes .reset/empty-rehearsal.zip
pnpm dev:reset inspect --target local
pnpm dev:reset execute --target local --confirm <exact-target-from-inspect> --expect .reset/<inspect-directory>/manifest.json
```

Then run the existing local smokes. These deliberately replace random cutover credentials with fixed **local-only** test credentials; never apply them to development. Provider tokens remain empty and cleanup stays disabled. The reset seeds `alice` and `bob` with the generated password, while the fixture suites (`local_smoke:run` and the browser suite's real password form) reuse those usernames with their fixed fixture password, so clear the rehearsal's rows first:

```bash
pnpm convex:local import --replace-all --yes .reset/empty-rehearsal.zip
pnpm convex:local env set LOCAL_FIXTURES_ENABLED true
pnpm convex:local env set IDENTITY_SENDER local
pnpm convex:local env set IDENTITY_CODE_KEY local-only-identity-code-key-0123456789abcdef
pnpm convex:local env set UPLOAD_CALLBACK_SECRET local-only-callback-fixture
pnpm convex:local run local_smoke:run '{}'
pnpm convex:local run local_smoke:reads '{}'
pnpm convex:local run local_smoke:media '{}'
pnpm convex:local dev --once --typecheck disable --start 'pnpm exec tsx scripts/smoke-local.ts'
pnpm test:browser
```

Do not run another local wrapper while the browser suite owns the backend. These checks prove only isolated behavior with fake media; they do not verify UploadThing's already-absent behavior or shared configuration.

## Checkpoint 19 round 2 verification

Verified locally on 15 November 2026; no shared deployment or UploadThing request was used:

- `pnpm test` and the final `pnpm check`: 238 Node tests and 109 registered-handler tests passed. Type checking and the production bundle passed. `pnpm run build` also passed, with the existing main-chunk size warning.
- `pnpm test:browser`: all 16 tests passed. Its guarded local push completed cleanly, as did both reset executions and the final CLI smoke push.
- `local_smoke:run`, `local_smoke:reads` and `local_smoke:media`: all returned `ok: true`. The CLI smoke via `dev --once --typecheck disable --start 'pnpm exec tsx scripts/smoke-local.ts'` returned `ok: true`.
- Populated inspect/execute began with 386 Tickets and 12 media keys, retained four unverified fake-browser keys, then seeded and verified six Tickets. Empty inspect/execute began with zero application rows/keys and completed with no unresolved keys. Both runs passed all API/CLI seed checks. Their private run directories are `.reset/1794688688894-4f86beab-0243-4aa7-8d0e-abb906fe41fc` and `.reset/1794688794407-3960e735-8fcb-4250-8026-c1ba5cb65675`.
- Artifact inspection confirmed both exports and configuration files have mode `0600`, `web.env` contains exactly the two `VITE_` variables, cleanup remains `false`, and local backend configuration omits `UPLOADTHING_TOKEN`.

Regression evidence (test names are exact):

| Finding/gate | Proof |
| --- | --- |
| Local-only wrapper and restore | `local wrapper refuses even the recorded development identity and credential overrides in its local file`; `local wrapper restores shared environment when it is terminated mid-run` in `tests/convex_local_wrapper.test.ts`. |
| Remote credential and identity isolation | `remote runner refuses file deploy keys, deployment tokens and self-hosted configuration before CLI invocation`; `remote runner requires both file identity and passed identity to equal the recorded development target`; `remote runner gives each CLI call a private target-only env file, scrubs every CONVEX variable and removes temp files on success or failure` in `tests/dev_reset_runner.test.ts`. |
| Complete ownership listing | `failed, partial or malformed provider listing aborts all deletion and clearing, even on an empty backend` in `tests/dev_reset.test.ts`. |
| Old cron credential absent before inventory | `old cron token must be removed, including an empty token, before inventory` in `tests/dev_reset.test.ts`. |
| Both inventory growth checks | `inventory growth since reviewed inspection aborts before provider I/O or clearing`; `new keys in the last export abort clearing and preserve old outcomes plus new unresolved sources` in `tests/dev_reset.test.ts`. |
| Exact cleanup pause and strict env parsing | `reset rejects enabled or malformed scheduler flags and stops on failed verification` in `tests/dev_reset.test.ts`; `environment list parsing refuses unparsed text, malformed quotes and duplicate values` in `tests/dev_reset_runner.test.ts`. |
| Configure before push | `only proven scoped media is deleted; re-export precedes clear and configuration precedes push` in `tests/dev_reset.test.ts`. |
| URL and supplied password validation | `deployment URL must be reachable and return the exact deployment name before destructive work`; `supplied reset passwords require 24 characters, a letter and a digit` in `tests/dev_reset_runner.test.ts`. |
| Deterministic seed through domain handlers | `cutover seed uses registered commands with exact numbering, totals, memberships, roles and revoked sessions` in `tests/convex/dev-seed.test.ts`, plus both real local reset rehearsals. |
| Browser environment separation | Both actual rehearsal artifacts passed the key/permission inspection above; checkpoint 20 launches Vite with only `VITE_` app variables and basic process environment. |

Checkpoint 20's shared-development installation and real provider behavior remain unverified because this checkpoint permits only local execution with fakes.

## Post-clear Owner bootstrap verification (named identity)

Verified locally on 20 November 2026 against `e719113` plus this change; no shared deployment, provider or Google request was used (development Google sign-in and `run identity:bootstrapOwner` through the runner were reviewed in source only):

- Before the rework, local `inspect` failed with `RESET_ENVIRONMENT_UNPARSEABLE` (agent-mode `env list` printed names only), and a local-fixture Owner refresh token captured before reset returned `noSession` after clearing: the export shows the empty import clears `auth` sessions/refresh tokens, `authPassword` passwords and `authUsername` usernames.
- Refusals through the real command: inexact `--confirm` (`RESET_CONFIRM_REQUIRED`), missing `--expect` (`RESET_INSPECT_MANIFEST_REQUIRED`), `resume` on an inspect manifest (`RESET_RESUME_REQUIRES_CLEARED_RUN`), `resume` on a verified run (`RESET_ALREADY_VERIFIED`), and `TICKET_DEPLOYMENT_MODE=named-pilot` (`RESET_LEGACY_MODE_REQUIRED` before any export).
- The earlier populated rehearsal with 339 Tickets and 5 fake media keys exposed two interruption cases. Password preflight now rejects the 110-character password that caused the seed to stop. The resume guard now refuses the partial seed that remained at `owner-ready`.
- Populated in one pass (311 Tickets, 3 keys) and empty (0 rows) inspect/execute both reached `verified` with no unresolved keys.
- After clearing the rehearsal rows: `local_smoke:run`, `local_smoke:reads`, `local_smoke:media` and the CLI smoke returned `ok: true`; `pnpm test:browser` passed 43 of 43. Run on the reset-seeded rows instead, `local_smoke:run` and the browser password-form test fail on the `alice` password, as documented above.
- `pnpm check`: type check, lint, 284 Node tests, 163 registered-handler tests and the production build passed.

`tests/dev_reset.test.ts` covers safe empty and bootstrapped Owner resumes, refusal before writes on partial seed, pilot and component rows, unresolved-media preservation, and row additions between inspection, execution and the final clear. `tests/convex/dev-seed.test.ts` exercises the one-use bootstrap and fresh Owner sign-in through the local fixture.

## Checkpoint 20: commands and actions, in order

Do not run this section during checkpoint 19. The development cutover must be explicitly in scope for the operator.

1. Verify source and the isolated target:

   ```bash
   pnpm test
   pnpm run typecheck
   pnpm run build
   pnpm convex:local
   ```

   Run the local rehearsal/smoke commands above, including `pnpm test:browser`. Complete the pre-flight checklist and stop shared writers/callbacks/old cron work.

2. Remove the old cron's provider credential first, pause new cleanup, inspect the recorded development target, review counts and unresolved sources, then execute with the exact identity. Replace `<inspect-directory>` with the reviewed inspect output directory:

   ```bash
   pnpm dev:reset env-remove UPLOADTHING_TOKEN
   pnpm dev:reset env-set MEDIA_CLEANUP_ENABLED false
   pnpm dev:reset inspect
   pnpm dev:reset execute --confirm dev:outstanding-viper-292 --expect .reset/<inspect-directory>/manifest.json
   ```

   After clearing and pushing, the execute step asks the Owner to sign in with Google twice (pending identity, then the bootstrapped Owner) before it seeds. If it stops after clearing, follow [Resuming after the clear](#resuming-after-the-clear). Review its `manifest.json`, `unresolved.json` and `verification.json`. Quarantine unresolved keys for investigation; do not infer deletion from cleared database rows. Earlier manifests remain authoritative references for keys no longer in the database.

3. Configure the matched HTTP process and browser in separate shells. Replace `<run-directory>` with the execute output directory. Load the HTTP configuration through dotenv directly into its child process (do not source a dotenv file as shell code):

   The standalone HTTP server enables UploadThing's dev callbacks automatically when `NODE_ENV` is not `production` and it is not running on Vercel. It uses `http://localhost:<api-port>/api/uploadthing`, where the port comes from `UPLOAD_API_PORT` or this checkout's assigned worktree port. No `UPLOADTHING_IS_DEV` or `UPLOADTHING_CALLBACK_URL` overrides are needed in `runtime.env`. Keep this local HTTP process running while uploading so it can forward completion callbacks and record media.

   ```bash
   pnpm exec tsx -e 'import {readFileSync} from "node:fs"; import {parse} from "dotenv"; import {spawnSync} from "node:child_process"; process.exit(spawnSync("pnpm", ["dev:api"], {stdio:"inherit", env:{...process.env,...parse(readFileSync(process.argv[1]))}}).status ?? 1)' .reset/<run-directory>/runtime.env
   ```

   In a fresh browser shell, give Vite only the reviewed `VITE_` app variables and basic process environment. This command does not inherit the shell's server secrets:

   ```bash
   pnpm exec tsx -e 'import {readFileSync} from "node:fs"; import {parse} from "dotenv"; import {spawnSync} from "node:child_process"; const web=parse(readFileSync(process.argv[1])); if(Object.keys(web).some(key=>!key.startsWith("VITE_"))) throw new Error("Unexpected browser variable"); process.exit(spawnSync("pnpm", ["dev:web"], {stdio:"inherit", env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,...web}}).status ?? 1)' .reset/<run-directory>/web.env
   ```

   For hosted processes, set these same separate values through that host's configuration and deploy the updated callers under the separately authorized checkpoint 20 procedure. Hosted `api/` handlers always disable dev callbacks, including on Vercel previews; production standalone servers also disable them. Their callback URL must be publicly reachable. Automatic URL detection, an explicit `UPLOADTHING_CALLBACK_URL`, and the protected-preview automation bypass remain supported. Do not use `pnpm dev`, which intentionally starts the local backend.

4. Verify the Owner's Google sign-in and the generated customer credential in the browser. Verify Project scopes, all six example Tickets, numbering/totals, text creation, search, edit, status/undo, annotations, archive/restore, draft cancellation and Project switching. Use the Ticket CLI against the explicit development URL:

   ```bash
   pnpm ticket login --url https://outstanding-viper-292.convex.cloud
   pnpm ticket whoami
   pnpm ticket list --project POS
   pnpm ticket get POS-0001
   pnpm ticket logout
   ```

   Sign in to the CLI with your named Owner Google account (`pnpm ticket login`). Create additional disposable Tickets through the browser/CLI only as part of authorized integration verification. Upload test-owned media as both roles through the matched provider/callback path. Test cancellation and expired intents: pending jobs/reservations must remain truthful while disabled. Check Operations health as staff and deny it to customers. Inspect safe configuration booleans and queue/failure counts. Verify a 30-day eligible test-owned archived Ticket remains restorable before claims; do not shorten retention in application code. Record evidence of these checks with the run's private artifacts. Do not run local fixtures against development.

5. Only after all previous checks pass, resume cleanup and observe recovery/purge with exclusively test-owned media:

   ```bash
   pnpm dev:reset env-set MEDIA_CLEANUP_ENABLED true
   ```

   Observe pending recovery, cancellation/expiry completion and purge-after-claim in Operations health. Verify deletion results and retained reservations on unknown/failure. If any check fails, pause again with the same command and value `false`, repair the cause and resume/requeue through the documented operations controls. Resume writers only when their updated targets and callback configuration are verified.

## Rollback and interruption

There is no data rollback: development data is disposable, and deleted provider objects cannot be restored by this tool. Stop writers and cleanup on failure and retain every run directory. Use [Resuming after the clear](#resuming-after-the-clear) to determine whether the run can continue. When starting a new run, `configure()` may already have restored the development token. Rerun `pnpm dev:reset env-remove UPLOADTHING_TOKEN` (add `--target local` for rehearsal), inspect again, and review the new manifest before authorizing execution. A new run never silently retries unresolved keys from an earlier run; use the saved source inventory for deliberate reconciliation. Do not erase uncertainty or bulk-delete an app to make the manifest look clean. Lost seeded customer credentials can be replaced by a new reset; the Owner keeps signing in with Google.

An empty ZIP resets application tables, not a running old client's network requests or provider callbacks. Quiescing them is a required operator action. The tool checks the cleanup flag, but cannot prove an old cron implementation honors it. Keep old schedulers paused until the final code is installed and verified.
