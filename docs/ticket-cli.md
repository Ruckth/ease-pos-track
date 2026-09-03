# Ticket CLI

The Ticket CLI is the machine-friendly integration boundary for agents and
terminal users. It calls the same Convex authentication and Ticket functions as
the app; it does not add a chat interface, a second authorization scheme, or a
second Ticket workflow.

For a short, copy-and-paste introduction, see the
[simple Ticket CLI manual](ticket-cli-manual.md).

Start by installing dependencies and discovering the command contract:

```bash
pnpm install
pnpm ticket commands
```

`commands` is unauthenticated and prints one compact JSON object. Its command,
argument, option, authentication, and interactivity fields come from the same
registry used by parsing and human help, so the three contracts stay aligned.

```json
{"ok":true,"schemaVersion":1,"program":"pnpm ticket","commands":[{"name":"commands","summary":"…","usage":"pnpm ticket commands","authentication":"none","interactive":false,"arguments":[],"options":[]}]}
```

Human-readable help is available with `pnpm ticket --help` or, for one command,
`pnpm ticket help create`.

## Sign in and session storage

Configure and sign in to the development deployment:

```bash
pnpm ticket login --url https://your-development-deployment.convex.cloud
```

The CLI asks for the existing staff password on the controlling terminal. Input
is not echoed, there is no password flag, and the password is never placed in
shell history. The app's existing staff login function performs the check and
applies its existing per-client and global rate limits.

Successful login stores:

- the secret session token, expiry, and bound deployment URL in macOS Keychain;
- only non-secret configuration—the stable machine client ID and deployment
  URLs—in `~/.config/track-ease-pos/ticket.json` (or under
  `$XDG_CONFIG_HOME`) with mode `0600`; its directory uses mode `0700`.

The session persists across terminal runs on the same macOS account. Inspect or
revoke it with:

```bash
pnpm ticket whoami
pnpm ticket logout
```

If `--url` is omitted during the first development login, the CLI checks
`TICKET_CONVEX_URL`, `CONVEX_URL`, then `VITE_CONVEX_URL`. It also loads
`.env.local` and `.env`. A saved URL wins on later runs; pass `--url` to login
again when the URL must change.

Production is never inferred from development configuration. It must be selected
and authenticated explicitly:

```bash
pnpm ticket login --prod --url https://your-production-deployment.convex.cloud
pnpm ticket whoami --prod
```

`TICKET_CONVEX_PROD_URL` may provide the production URL, but `--prod` is still
required on every production command. Development and production credentials are
separate Keychain items.

## Ticket operations

All live Ticket operations require a valid staff session. Development is the
default; append `--prod` only when production was explicitly requested. List and
lookup also run the existing authenticated Ticket-number backfill before reading,
so older Tickets receive stable references through the same allocator.

```bash
pnpm ticket list
pnpm ticket list --include-archived
pnpm ticket get TKT-0007
pnpm ticket get TKT-0007 --include-archived
```

Create starts in status `new` and records staff ownership plus
`createdVia: "codex"` in the existing Ticket and audit path. Repeat `--image` to
attach up to 10 original image files. Each source may be a local path or an HTTPS
URL:

```bash
pnpm ticket create --title "Printer jams" --description "Receipt printer jams on long receipts"
pnpm ticket create --title "Calendar overlap" --image ./first.png --image https://example.com/second.jpg
pnpm ticket create --json '{"title":"Printer jams","description":"Long receipts","requestId":"req-42"}'
pnpm ticket create --title "Printer jams" --dry-run
```

```json
{"ok":true,"id":"k17f…","ticket":"TKT-0007","ticketNumber":7,"status":"new","version":0,"created":true,"deployment":"dev","requestId":"6f1c…"}
```

`--request-id` is the idempotency key. If omitted, one is generated and returned:

- same request id, same title and description: the original Ticket is returned
  with `"created":false`;
- same request id, different content: `REQUEST_ID_CONFLICT`, exit 5, and no write.

If a caller is uncertain whether a create completed, it must retry with the
reported request id. A different request id can create a second Ticket.

Images can also be added to an existing Ticket. Read its latest version first,
then provide a retry key when the operation may need to be repeated:

```bash
pnpm ticket get TKT-0007
pnpm ticket attach TKT-0007 --image ./screen.png --image https://example.com/detail.webp --expected-version 0 --request-id attach-images-0007
```

Local files and downloaded HTTPS images are uploaded without resizing or
re-encoding. Images must be non-empty, no larger than 8 MB each, and the Ticket
may contain at most 10 images in total. The upload intent is bound to the staff
session and retry key; an interrupted retry reuses files already recorded by the
intent instead of uploading or attaching them twice. Image upload requires
`UPLOADTHING_TOKEN` in `.env.local`, `.env`, or the process environment.
`create --dry-run` reads or downloads each image and reports its original name,
size, and type, but does not upload it or contact the deployment.

Every state-changing command requires the latest `version` returned by create,
list, or get. This preserves the existing optimistic concurrency check:

```bash
pnpm ticket update TKT-0007 --title "Printer offline" --expected-version 0
pnpm ticket update TKT-0007 --description "Only the kitchen printer" --expected-version 1
pnpm ticket status TKT-0007 --status acknowledged --expected-version 2
pnpm ticket status TKT-0007 --status in_progress --expected-version 3
pnpm ticket status TKT-0007 --status waiting_for_customer --expected-version 4
pnpm ticket status TKT-0007 --status resolved --expected-version 5
```

Archiving is the recoverable delete operation. The CLI deliberately has no
permanent-delete command:

```bash
pnpm ticket archive TKT-0007 --expected-version 6
pnpm ticket restore TKT-0007 --expected-version 7
```

If another actor changed the Ticket first, the mutation returns
`VERSION_CONFLICT` with exit 5. Read the Ticket again and decide whether the new
state should still be changed; do not blindly increment the version.

## Output and error contract

Programmatic success is exactly one compact JSON object on stdout. Programmatic
failure is exactly one compact JSON object on stderr with a nonzero exit code.
The hidden password prompt is the only interactive behavior and writes directly
to the controlling terminal. The repository's pnpm workspace configuration uses
the silent reporter so pnpm does not add lifecycle lines around those streams.

```json
{"ok":false,"code":"NOT_LOGGED_IN","message":"No saved Ticket session was found.","deployment":"dev","hint":"Run `pnpm ticket login`."}
```

| Exit | Meaning |
| --- | --- |
| `0` | Success, discovery, help, or dry run. |
| `1` | Internal CLI failure. |
| `2` | Usage error: unknown command/flag, missing argument/value, invalid JSON. |
| `3` | Invalid Ticket input, status, version, reference, or missing Ticket. |
| `4` | Configuration, Keychain, authentication, expiry, rate-limit, or authorization failure. |
| `5` | Request-id or optimistic-version conflict. |
| `6` | Convex deployment/network call failure. |

Stable authentication errors include `DEPLOYMENT_NOT_CONFIGURED`,
`KEYCHAIN_UNAVAILABLE`, `NOT_LOGGED_IN`, `SESSION_EXPIRED`, `SESSION_INVALID`,
`SESSION_DEPLOYMENT_MISMATCH`, `INVALID_CREDENTIALS`, `AUTH_RATE_LIMITED`, and
`NOT_AUTHORIZED`. Their hints use `pnpm ticket …` syntax.

## Security and platform limits

- Persistent credentials currently require macOS and `/usr/bin/security`.
  Non-macOS runs fail closed with `KEYCHAIN_UNAVAILABLE`; they do not fall back
  to a plaintext token file.
- Session material is sent to the Keychain process over stdin, not command-line
  arguments. The non-secret config file never contains a token or password.
- A session is deployment-specific. If the configured URL no longer matches the
  Keychain record, the CLI refuses it with `SESSION_DEPLOYMENT_MISMATCH`.
- `whoami` and every live operation validate the saved session against the app's
  current-session query. Missing, locally expired, server-invalid, and non-staff
  sessions are distinguished with stable JSON codes.
- Logout asks the app to revoke the session, then removes the local Keychain
  record. Expired server sessions are also safe to clean up this way.

## Implementation map

| File | Role |
| --- | --- |
| `scripts/ticket/registry.ts` | Shared parser/help/discovery command contract. |
| `scripts/ticket/cli.ts` | Pure argument parsing and local Ticket validation. |
| `scripts/ticket/errors.ts` | Error codes, exit codes, and Convex validation-code mapping. |
| `scripts/ticket/status.ts` | Public Ticket statuses and their existing storage mappings. |
| `scripts/ticket/deployment.ts` | Development/production selection, URL rules, and `pnpm ticket` hints. |
| `scripts/ticket/config.ts` | Restrictive non-secret configuration file. |
| `scripts/ticket/keychain.ts` | Injectable macOS Keychain credential adapter. |
| `scripts/ticket/prompt.ts` | Controlling-terminal password input with echo disabled. |
| `scripts/ticket/output.ts` | Every stdout/stderr JSON shape the CLI prints. |
| `scripts/ticket/images.ts` | Original-byte local/HTTPS image loading and UploadThing storage. |
| `scripts/ticket/remote.ts` | Direct `ConvexHttpClient` calls to the app's public functions. |
| `scripts/ticket/session.ts` | Persistent staff-session lifecycle and access policy. |
| `scripts/ticket/run.ts` | Ticket command orchestration and remote-failure classification. |
| `convex/feedback.ts` | Existing Ticket domain functions plus authenticated create, image attachment, and Ticket-number lookup. |
| `convex/feedback_state.ts` | Ticket text limits and the optimistic-version check. |
| `convex/tickets.ts` | Shared Ticket allocation and audit-record helpers. |
| `convex/ticket_requests.ts` | Request-id normalization and idempotency rules. |

Verify changes with:

```bash
pnpm test
pnpm typecheck
```
