# Development reset

Checkpoint 19 prepares this procedure. Checkpoint 20 runs it against shared development. No shared-development reset or provider verification is implied by a successful local rehearsal.

The recorded identities are `dev:outstanding-viper-292` and UploadThing app ID `2xv6n0a5t1`, in `scripts/dev-reset.config.json`. These are identifiers, not secrets. The tool reads the deployment from `.env.local`; missing, production-marked or different identities fail closed. Both the passed identity and file identity must match the record. Development calls refuse any `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT_TOKEN` or `CONVEX_SELF_HOSTED_*` entry in that file, even if empty. Use the deployment tooling to correct such configuration; never edit `.env.local` or `.env.convex-local` manually. Shell `CONVEX_*` overrides are scrubbed. If the recorded app is not exclusively the development app, stop and establish a dedicated development storage scope before cutover; do not substitute a production token.

## Pre-flight

- Finish P0–P7 and review the checkpoint 19 changes. Install with pnpm. The installed Convex CLI is 1.45.0.
- First remove `UPLOADTHING_TOKEN` from the target using `pnpm dev:reset env-remove UPLOADTHING_TOKEN` (add `--target local` for rehearsal). This makes the old `upload_cleanup.cleanupExpiredUploads` cron no-op; that implementation ignores the new cleanup flag. Then set `MEDIA_CLEANUP_ENABLED` to exactly `false` using the reset tool's env command. Stop browser/CLI writers, upload servers and callbacks. Pause old cron jobs/scheduled work in the Convex dashboard as well. Removing the token cannot stop an already-running deletion: wait for in-flight callbacks/deletions to settle. Keep writers stopped through inventory, clearing and verification. Execution checks token absence before exporting any rows; `configure()` restores the development token only after old rows are cleared.
- Confirm the dashboard deployment and storage application against the committed identities. The app ID was recorded from the token locally; no provider call was made during preparation. The reset checks the token's app ID and the API key's authenticated app identity before deletion. Review the scope in the provider dashboard during checkpoint 20.
- Have access to the recorded development deployment and its development UploadThing token. The token defaults to `.env.local`'s `UPLOADTHING_TOKEN`; `DEV_RESET_UPLOADTHING_TOKEN` may supply the same app's token. Neither value is printed.
- Optionally supply `DEV_RESET_STAFF_PASSWORD` and `DEV_RESET_CUSTOMER_PASSWORD` through the environment. Use at least 24 characters, including a letter and digit. Otherwise the tool generates separate random passwords with 256 bits of randomness and prints each once. Both example customers share the generated customer password. Store the output privately.
- Optionally supply `DEV_RESET_CALLBACK_SECRET` through the environment. Otherwise a random callback credential is generated. Configure that exact value in the upload server after reset.
- `.reset/` is gitignored and private. Each invocation creates a separate directory. It contains a sensitive snapshot (including old sessions/customer hashes), manifests, and, after execution, `runtime.env`. Keep these files private; never attach snapshots/configuration to an issue. Preserve unresolved manifests across retries, even after rows have been cleared.

## What execution does

`pnpm dev:reset` defaults to read-only `inspect` on recorded development. Inspection exports a snapshot, counts every exported table, inventories nested media keys with table/row/field sources, and writes `manifest.json` plus `unresolved.json`. It does not push code, change target environment variables, seed, call the provider or delete anything. Local inspection may start/stop the disposable backend through a read-only system-query subscription in the guarded wrapper.

`execute --confirm <exact identity> --expect <reviewed inspect manifest>` requires `MEDIA_CLEANUP_ENABLED` to be present and exactly `false`, and requires `UPLOADTHING_TOKEN` to be absent before inventory. The entire CLI `env list` output is validated before dotenv parsing; unparseable text, malformed quotes and duplicate entries refuse execution. Before any remote write, the candidate deployment URL must answer `/instance_name` with the exact recorded deployment name; failures/redirects refuse. It then:

1. Saves the inventory while old rows still exist. Refuses before provider I/O if any key was added since the reviewed inspect manifest, which must have the same target and inspect stage. No final-schema handler is needed.
2. Checks the configured token's app ID, then requires the authenticated `/v7/getAppInfo` response's app ID to match too. An authenticated, paginated `listFiles` proves keys belong to that app. Only keys present in both the old-data inventory and that app's uploaded-file listing are eligible. It never deletes the entire provider app. The endpoint and app-scoped listing are described in the [UploadThing REST specification](https://docs.uploadthing.com/api-reference/openapi-spec) and [UTApi reference](https://docs.uploadthing.com/api-reference/ut-api); identity/response failure refuses clearing. Provider requests were tested only with fakes in checkpoint 19.
3. Persists `unknown` before each deletion and then saves the typed result. Only `success=true` with `deletedCount=1` counts as `deleted`. Missing keys, mismatches, failures and ambiguous responses remain unresolved. Already-absent behavior is deliberately unverified. A process interruption leaves its latest uncertainty on disk. Unknown outcomes are never counted as deleted.
4. Re-exports immediately before clearing and refuses if new keys appeared since the deletion inventory. Both exports and all newly discovered unresolved keys are retained. Imports an empty snapshot ZIP using `import --replace-all --yes`, clearing old application rows, omitted tables and sessions **before** the schema push. `data` defaults to 100 rows and is unsuitable for complete inventory. `deploy` can select production and is never used. Keep writers quiescent: the final export and clear are separate CLI calls.
5. Sets cleanup and local fixtures to `false`; configures staff password, customer pepper, callback credential and matching development storage token **before** pushing final schema/backend with `dev --once --typecheck disable`. The old cron now has no old rows to delete, and the new code starts with cleanup disabled. Prints configuration filenames, never their values. `runtime.env` retains matching HTTP secrets and `CONVEX_URL` privately; `web.env` contains only `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`. `backend.env` is the private Convex configuration input. Local configuration leaves the provider token absent. The tool never edits repository environment files.
6. Seeds two Projects (`POS`, `APP`), two customers (`alice@dev.example`, `bob@dev.example`), four memberships and six text Tickets through registered app commands. Each Project has Tickets 1–3, one each in New, Acknowledged and In Progress. Seed verification exercises explicit roles, owner isolation, reference search, edit/undo, archive/restore, totals and revoked sessions. IDs, hashes, credentials, timestamps and audit versions are intentionally fresh; example content, numbering and workflow distribution are deterministic.
7. Runs the real CLI adapter's login, whoami, list, get and logout against the seeded backend, without Keychain or uploads. Writes `verification.json` only when the API and CLI checks pass. This is evidence for those checks, not evidence of browser/provider cutover acceptance. The post-cutover checklist below remains mandatory before enabling cleanup. The tool never enables cleanup itself.

Local Convex CLI calls go through `pnpm convex:local`, which has no remote capability and retains signal forwarding/environment restoration. A leftover `.env.local.shared-backup` means stop and recover the interrupted wrapper before proceeding. The reset tool has a separate development runner: each call uses a fresh private temporary env file containing only `CONVEX_DEPLOYMENT=<validated dev id>`, scrubs every `CONVEX_*` child variable, and deletes that file afterwards, including command failures. It never passes `.env.local` to the CLI. Each call saves and restores `.env.local` and `.gitignore`, including on failure or a forwarded SIGINT/SIGTERM/SIGHUP; restoration waits for the CLI to exit. Use only `pnpm dev:reset` commands for the future remote cutover; override flags and production targets are refused.

## Local rehearsal only

Local selects the fake automatically, never constructs UTApi, and refuses a real adapter. The fake only recognizes `local-fake-` keys; other keys remain unresolved. It does not upload or delete provider files. Initialize a new checkout's local backend once with `pnpm convex:local` if it has never been created.

Before either rehearsal, remove the local token and require the explicit pause flag:

```bash
pnpm dev:reset env-remove UPLOADTHING_TOKEN --target local
pnpm dev:reset env-set MEDIA_CLEANUP_ENABLED false --target local
```

For a populated backend, review the inspect output and replace `<inspect-directory>`
with its directory and `<local-identity>` with the exact `target` from its
`manifest.json`. The identity comes from this checkout's local backend configuration;
new backends commonly use `anonymous:anonymous-agent`. Do not reuse an identity or
manifest from another checkout:

```bash
pnpm dev:reset inspect --target local
pnpm dev:reset execute --target local --confirm <local-identity> --expect .reset/<inspect-directory>/manifest.json
```

For an empty backend, create an empty ZIP locally and clear only local rows, then inspect and execute:

```bash
pnpm exec tsx -e 'import AdmZip from "adm-zip"; import {mkdirSync} from "node:fs"; mkdirSync(".reset", {recursive:true,mode:0o700}); new AdmZip().writeZip(".reset/empty-rehearsal.zip")'
pnpm convex:local import --replace-all --yes .reset/empty-rehearsal.zip
pnpm dev:reset inspect --target local
pnpm dev:reset execute --target local --confirm <local-identity> --expect .reset/<inspect-directory>/manifest.json
```

Then run the existing local smokes. These deliberately replace random cutover credentials with fixed **local-only** test credentials; never apply them to development. Provider tokens remain empty and cleanup stays disabled.

```bash
pnpm convex:local env set LOCAL_FIXTURES_ENABLED true
pnpm convex:local env set APP_PASSWORD 'LocalStaff123!'
pnpm convex:local env set CUSTOMER_PASSWORD_PEPPER local-only-fixture-pepper
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

   The execute step inventories again. Review its `manifest.json`, `unresolved.json` and `verification.json`. Quarantine unresolved keys for investigation; do not infer deletion from cleared database rows. Earlier manifests remain authoritative references for keys no longer in the database.

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

4. Verify both generated credentials in the browser. Verify Project scopes, all six example Tickets, numbering/totals, text creation, search, edit, status/undo, annotations, archive/restore, draft cancellation and Project switching. Use the Ticket CLI against the explicit development URL:

   ```bash
   pnpm ticket login --url https://outstanding-viper-292.convex.cloud
   pnpm ticket whoami
   pnpm ticket list --project POS
   pnpm ticket get POS-0001
   pnpm ticket logout
   ```

   The CLI prompts for the generated staff password; do not place it in shell history. Create additional disposable Tickets through the browser/CLI only as part of authorized integration verification. Upload test-owned media as both roles through the matched provider/callback path. Test cancellation and expired intents: pending jobs/reservations must remain truthful while disabled. Check Operations health as staff and deny it to customers. Inspect safe configuration booleans and queue/failure counts. Verify a 30-day eligible test-owned archived Ticket remains restorable before claims; do not shorten retention in application code. Record evidence of these checks with the run's private artifacts. Do not run local fixtures against development.

5. Only after all previous checks pass, resume cleanup and observe recovery/purge with exclusively test-owned media:

   ```bash
   pnpm dev:reset env-set MEDIA_CLEANUP_ENABLED true
   ```

   Observe pending recovery, cancellation/expiry completion and purge-after-claim in Operations health. Verify deletion results and retained reservations on unknown/failure. If any check fails, pause again with the same command and value `false`, repair the cause and resume/requeue through the documented operations controls. Resume writers only when their updated targets and callback configuration are verified.

## Rollback and interruption

There is no data rollback: development data is disposable, and deleted provider objects cannot be restored by this tool. Stop writers and cleanup on failure, retain every run directory, repair the code/configuration, then repeat inspection/reset/seed. If a run fails after `configure()`, rerun `pnpm dev:reset env-remove UPLOADTHING_TOKEN` (add `--target local` for rehearsal), then inspect again and review the new manifest before retrying execution. A new run never silently retries unresolved keys from an earlier run; use the saved source inventory for deliberate reconciliation. Do not erase uncertainty or bulk-delete an app to make the manifest look clean. Lost seeded credentials can be replaced by a new reset; customer hashes must be regenerated if the pepper changes.

An empty ZIP resets application tables, not a running old client's network requests or provider callbacks. Quiescing them is a required operator action. The tool checks the cleanup flag, but cannot prove an old cron implementation honors it. Keep old schedulers paused until the final code is installed and verified.
