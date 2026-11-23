# Agent instructions

Project vocabulary: the unit of work is a **Ticket**. Do not introduce "feedback",
"report" or "card" in anything a user reads. Tables, handlers and source modules
use canonical Ticket names.

## Local architecture implementation

Use only `pnpm convex:local <args>` for Convex CLI work. Its default pushes and
regenerates bindings against the disposable local backend, preserving shared
deployment settings. Do not edit `.env.local` or `.env.convex-local` manually.
Do not deploy or run fixtures against shared development or production.

Local seed and smoke instructions are in [docs/ticket-cli.md](docs/ticket-cli.md).
P8 reset preparation/rehearsal is documented in [docs/dev-reset.md](docs/dev-reset.md).
`pnpm dev:reset` defaults to read-only inspection of the recorded development
identity; use `--target local` during implementation. Execution needs the exact
`--confirm` identity and `--expect <reviewed inspect manifest>`. Clearing erases
every session, so the reset bootstraps the Owner afterwards (the local rehearsal
uses the loopback fixture Owner); a run stopped after clearing continues with
`resume --confirm <identity> --expect <run manifest>`. The local wrapper
has no remote mode and accepts only `dev`, `run`, `env`, `import`, `export`,
`data`, `codegen` and `--help` (no arguments defaults to a local push).
Only an explicitly authorized development cutover may use the reset tool's isolated development runner and env commands. Remove the target's
`UPLOADTHING_TOKEN` first and set `MEDIA_CLEANUP_ENABLED` to exactly `false`.
Keep every unresolved manifest, stop old writers/callbacks/schedulers first, and
enable cleanup last.
Every Convex registration uses a policy constructor from `convex/functions.ts`;
resource ownership and Project access belong in domain operations.
Identity (Convex Auth 2.0.0 sessions, admission, staff and customer IDs for
peers) is documented in [docs/identity.md](docs/identity.md).

The Convex environment flag `MEDIA_CLEANUP_ENABLED=true` gates media job execution
and purge claims. Leave it disabled until P8 cutover validation is complete;
enable it last. Cancellation, rejected callbacks and expiry always queue pending
jobs and reserve unattached assets. Disabled jobs are not scheduled; claims defer
without provider calls or spending attempts, and recovery does nothing. Expiry
still records reservations; archived Tickets remain restorable. Enabling the flag
lets recovery resume pending jobs without requeue. Missing
storage configuration retries without spending provider attempts. Failed jobs
retain reservations; ops can repair the cause then invoke the internal
`retention:requeue` mutation with `{ "jobId": "..." }`. Ownership-conflicted
archived Tickets remain visible/restorable and are excluded from later claims
until repaired and requeued. Staff can inspect counts, configuration booleans and
paginated job diagnostics in Operations health, and requeue failed jobs there
after repair. The staff action shares the internal requeue ownership and
archive-age checks.
Restoring a blocked archived Ticket supersedes its failed purge job and clears
the block; re-archiving starts a fresh 30-day window. Purge requeue requires
confirmation in Operations health.
Local smoke flag setup is in docs/ticket-cli.md.

## Ticket routing

The zero-user launch uses manual assignment, Project rosters and availability,
holds, staff-reviewed local rules, and in-app assignment and intake alerts.
Reuse the routing domain's Project and named-staff checks and its shared manual
assignment operation. Roster membership grants no Project access.

Keep external T3 routing paused. The deferred broker, promotion and evaluation design is documented
in [the routing plan](docs/architecture/t3code-phase1/04-responsibilities-and-delegation.html). Revisit it after an approved dataset meets the criteria
in [docs/ticket-routing.md](docs/ticket-routing.md). The active app has no routing
provider transport or promotion path.

## Creating a Ticket

Only run this when the user explicitly asks for a Ticket to be created.

```bash
pnpm ticket create --title "<title>" --description "<description>" --project <KEY>
```

- Every Ticket belongs to a Project. `--project` may be left out only while a single
  Project exists; with several, the command fails with `PROJECT_REQUIRED`. Ask the
  user which Project when they have not said.
- Draft or unsure? Add `--dry-run`. It validates and prints the Ticket it would
  create without writing anything.
- The development deployment is the default. Never pass `--prod` unless the user
  explicitly asks for production.
- The command prints one JSON object on stdout. Report the `ticket` value (for
  example `POS-0007`) back to the user; `created: false` means an existing Ticket
  was returned for that `--request-id`, not a new one.
- Unmapped safe server codes appear in the `REMOTE_CALL_FAILED` message (exit 6).
- Errors print one JSON object on stderr with a `code`. Exit codes: `2` usage,
  `3` invalid input, `4` Convex setup or auth, `5` `--request-id` reuse with
  different content, `6` the deployment call failed.
- If a run fails and you want to retry it, reuse the `requestId` from the output.
  Never retry with a different request id: that can create a duplicate Ticket.
- Create retries compare immutable normalized input, so later Ticket edits do
  not invalidate the retry. Replay requires the same durable actor and current
  access to an active Project; a purged Ticket returns `TICKET_UNAVAILABLE`.
- Upload retries reuse the durable actor's intent and recorded files after
  sign-in. Recording requires the server callback credential or the staff
  session that acquired the intent. Unknown writes retain ownership; definitive
  rejection queues guarded cleanup. If cancellation cannot be confirmed, error
  JSON includes `details.cleanup.outcome: "unknown"` while preserving the original
  error code and exit status. Cleanup jobs execute with fenced leases and bounded
  retries; queued cancellation does not claim deletion. Terminal cleanup failure
  retains reservations and is available through authorized job progress.
- Attachment reconciliation covers only the mutation. A failed subsequent Ticket
  read never authorizes cancellation or cleanup.

`pnpm ticket --help` documents every flag. Details and setup: [docs/ticket-cli.md](docs/ticket-cli.md).

## Publishing a Ticket page

When the user asks for an HTML result on a Ticket, publish it and send the
returned `url` in the conversation where the work was requested:

```bash
pnpm ticket page publish <TICKET> ./page.html
pnpm ticket page publish <TICKET> ./folder --entry reports/index.html
```

Retry an interrupted publish with the reported `requestId`. Bundle fonts and
scripts in the folder; pages cannot load external resources. Details:
[docs/ticket-cli.md#hosted-pages](docs/ticket-cli.md#hosted-pages).

## Checks

This repository is pnpm-only. Use `pnpm` for every command; `npm`, `npx`, yarn and
bun are not supported, and `preinstall` refuses an install driven by any of them.
`npx <tool>` becomes `pnpm exec <tool>`.

While iterating, run only what you touched:

- `pnpm test:one tests/<name>.test.ts` runs one unit test file.
- `pnpm test:convex tests/convex/<name>.test.ts` runs one Convex test file.
- `pnpm typecheck` uses the native TypeScript checker and is incremental.

Run `pnpm check` before reporting work as done. It runs the type check, both test suites and the production build in parallel
and fails if any of them fails. The unit suite includes dependency boundaries
and every Convex registration policy; `pnpm check:arch` runs just those tests.
Schema changes must also push cleanly with `pnpm convex:local`. CI runs the same
checks on every pull request.

## Parallel worktrees

Several agents work on this repository at once. Never edit files in the main
checkout. Work in your own worktree, so other agents' unfinished changes cannot
break your checks and your commits cannot sweep in their files:

- If you start in the main checkout, run `pnpm agent:new <task-name>` and work in
  the directory it prints, on branch `agent/<task-name>`.
- If your tool already created a worktree for you, run `pnpm agent:setup` there
  before anything else.

Setup copies `.env.local` from the main checkout, claims a free port block in
`.env.worktree`, installs dependencies and pushes the schema to that worktree's
own local Convex backend. `pnpm dev` then serves on the printed ports, so several
worktrees can run side by side. Do not edit `.env.worktree` by hand. Commit only
files you changed. Remove the worktree once its branch has merged.

## Browser workflow checks

`pnpm test:browser` pushes through `pnpm convex:local`, configures local-only
fixture credentials with media cleanup disabled, seeds the disposable backend,
and starts Vite plus the upload server on this checkout's ports. It runs headless
Chromium with fake camera devices using the installed Playwright package. Browser
tests block provider upload traffic and use fake files/recorded metadata for draft
lifecycle checks; they never upload or delete provider files. Install Chromium
with `pnpm exec playwright install chromium` if it is not already available.
`pnpm test` remains browser-independent. Failure evidence, accessibility
scans, the visual pilot, seeded draft exploration (`pnpm test:explore`) and the
advisory browser CI rollout are in [docs/browser-verification.md](docs/browser-verification.md). Do not run another local Convex wrapper
while the browser check owns its local backend.
