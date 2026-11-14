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
Every Convex registration uses a policy constructor from `convex/functions.ts`;
resource ownership and Project access belong in domain operations.

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
  error code and exit status. P4 will execute the pending media jobs.
- Attachment reconciliation covers only the mutation. A failed subsequent Ticket
  read never authorizes cancellation or cleanup.

`pnpm ticket --help` documents every flag. Details and setup: [docs/ticket-cli.md](docs/ticket-cli.md).

## Checks

This repository is pnpm-only. Use `pnpm` for every command; `npm`, `npx`, yarn and
bun are not supported, and `preinstall` refuses an install driven by any of them.
`npx <tool>` becomes `pnpm exec <tool>`.

Run `pnpm test`, `pnpm run typecheck` and `pnpm run build` before reporting work
as done. Schema changes must also push cleanly with `pnpm convex:local`.
