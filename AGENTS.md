# Agent instructions

Project vocabulary: the unit of work is a **Ticket**. Do not introduce "feedback",
"report" or "card" in anything a user reads; `feedback*` names inside `convex/` and
`src/` are existing internals.

## Creating a Ticket

Only run this when the user explicitly asks for a Ticket to be created.

```bash
pnpm ticket create --title "<title>" --description "<description>"
```

- Draft or unsure? Add `--dry-run`. It validates and prints the Ticket it would
  create without writing anything.
- The development deployment is the default. Never pass `--prod` unless the user
  explicitly asks for production.
- The command prints one JSON object on stdout. Report the `ticket` value (for
  example `TKT-0007`) back to the user; `created: false` means an existing Ticket
  was returned for that `--request-id`, not a new one.
- Errors print one JSON object on stderr with a `code`. Exit codes: `2` usage,
  `3` invalid input, `4` Convex setup or auth, `5` `--request-id` reuse with
  different content, `6` the deployment call failed.
- If a run fails and you want to retry it, reuse the `requestId` from the output.
  Never retry with a different request id: that can create a duplicate Ticket.

`pnpm ticket --help` documents every flag. Details and setup: [docs/ticket-cli.md](docs/ticket-cli.md).

## Checks

This repository is pnpm-only. Use `pnpm` for every command; `npm`, `npx`, yarn and
bun are not supported, and `preinstall` refuses an install driven by any of them.
`npx <tool>` becomes `pnpm exec <tool>`.

Run `pnpm test` and `pnpm run typecheck` before reporting work as done.
