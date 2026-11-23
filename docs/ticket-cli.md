# Ticket CLI

The Ticket CLI is the machine-friendly integration boundary for agents and
terminal users. It calls the same Convex authentication and Ticket functions as
the app; it does not add a chat interface, a second authorization scheme, or a
second Ticket workflow.

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

Login is a named staff sign-in with Google. The CLI starts the same guarded
Google flow as the browser, opens the provider page, and receives the result on
a loopback listener at `http://127.0.0.1:4271/` (override with
`TICKET_LOGIN_PORT`). The deployment must list that origin in
`AUTH_REDIRECT_ORIGINS`. Only an active staff member (an invited, bound Google
identity) is admitted; a pending or customer account is refused with
`NOT_AUTHORIZED` and nothing is stored. The shared staff password no longer
exists. Against a disposable loopback backend with local fixtures enabled,
`TICKET_LOCAL_FIXTURE_EMAIL=owner@local.test` uses the local test provider
instead of Google.

Successful login stores:

- the rotating Convex Auth refresh token, its expiry, and bound deployment URL in
  macOS Keychain. Each authenticated run rotates it once and uses the resulting
  one-minute access token; the access token is never stored;
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
default; append `--prod` only when production was explicitly requested.

Every Ticket belongs to a Project, and its reference starts with the Project key:
`POS-0012` is Ticket 12 in Project `POS`. Numbers count up per Project. Keys
are case-insensitive on input. Projects are created in the staff app; the CLI does not create them.

```bash
pnpm ticket list
pnpm ticket list --project POS
pnpm ticket list --include-archived
pnpm ticket get TKT-0007
pnpm ticket get TKT-0007 --include-archived
```

`list` reads active Projects and consumes staff-only `tickets:pageTicketDetails`
pages (up to 50 Tickets per server page), preserving full descriptions, media
counts, annotation counts and the existing JSON shape without a separate detail
query for every Ticket. `--include-archived` also consumes archived lifecycle
pages. The printed count is the number of Tickets returned; concurrent writes
between pages do not form a single database snapshot.

Create starts in status `new` and records staff ownership plus
`createdVia: "codex"` in the existing Ticket and audit path. Repeat `--image` to
attach up to 10 image files. Each source may be a local path or an HTTPS
URL:

```bash
pnpm ticket create --title "Printer jams" --description "Receipt printer jams on long receipts"
pnpm ticket create --project POS --title "Printer jams"
pnpm ticket create --title "Calendar overlap" --image ./first.png --image https://example.com/second.jpg
pnpm ticket create --json '{"title":"Printer jams","description":"Long receipts","requestId":"req-42","project":"POS"}'
pnpm ticket create --title "Printer jams" --dry-run
```

```json
{"ok":true,"id":"k17f…","ticket":"TKT-0007","ticketNumber":7,"project":"TKT","status":"new","version":0,"created":true,"deployment":"dev","requestId":"6f1c…"}
```

`--project` may be left out only while exactly one Project exists. With more than
one, create fails with `PROJECT_REQUIRED` (exit 3) and writes nothing; an unknown
key fails with `PROJECT_NOT_FOUND`.

`--request-id` is the idempotency key. If omitted, one is generated and returned:

- same request id, same normalized original title and description: the original
  Ticket is returned with `"created":false`, even after the Ticket is edited;
- same request id, different content or a different Project: `REQUEST_ID_CONFLICT`,
  exit 5, and no write.

If a caller is uncertain whether a create completed, it must retry with the
reported request id. A different request id can create a second Ticket.
Receipts keep a SHA-256 digest of the original normalized input, durable actor
and Project scope. Staff retries work across staff sessions; they cannot replay
a customer's request identity. Creation and replay require an active Project;
customers must still have membership. Missing, archived and inaccessible Projects
all return `PROJECT_NOT_FOUND` to customers before comparing receipt input.
After purge, a permanent receipt tombstone returns `TICKET_UNAVAILABLE` instead
of recreating the Ticket. Rejected attempts reserve no request id.

Images can also be added to an existing Ticket. Read its latest version first,
then provide a retry key when the operation may need to be repeated:

```bash
pnpm ticket get TKT-0007
pnpm ticket attach TKT-0007 --image ./screen.png --image https://example.com/detail.webp --expected-version 0 --request-id attach-images-0007
```

Local files and downloaded HTTPS images are prepared before upload (up to 20 MiB and 40 megapixels per source). Still images fit inside 1920 × 1080 without upscaling. The CLI chooses a compact faithful encoding and preserves alpha. Animated GIF and WebP keep every frame and delay (larger ones become lossless animated WebP); APNG must already fit 1920 × 1080 and animated AVIF is refused (`IMAGE_ANIMATION_UNSUPPORTED`). Sharp's prebuilt binaries cannot decode HEIC/HEIF, so on macOS the CLI first converts such a photo with the system `sips` tool; elsewhere it fails with `IMAGE_FORMAT_UNSUPPORTED`. Before upload, every prepared file passes the same byte validation as the browser's provider callback (staff uploads are recorded with the staff session, not the callback). The uploaded image must be at most 8 MiB, and the Ticket
may contain at most 10 images in total. The upload intent is bound to the durable
actor and retry key; an interrupted retry, including after sign-in, reuses files
already recorded by the intent instead of uploading or attaching them twice.
Recording requires the validated staff session that acquired the intent; this
direct provider adapter is a deliberate staff capability. Image upload requires
`UPLOADTHING_TOKEN` in `.env.local`, `.env`, or the process environment.
`create --dry-run` reads or downloads each image and prints its prepared name,
size, and type, but does not upload it or contact the deployment.
Attachment receipts use their own operation scope and compare the target Ticket
and ordered media keys. A replay returns the committed attachment's version and
audit reference, even if the Ticket has since changed; the CLI reads the current
Ticket for its JSON result.
If that read fails after attachment commits, it does not replay the mutation or
queue cancellation; retry with the same request id.

Recording and attachment reconcile a lost response by replaying the identical
write once. If its outcome is still unknown, keep the same request id on retry;
no deletion is authorized. A definitive rejection queues cleanup through an
atomic ownership reservation. Cancellation and late rejected callbacks retain
durable media jobs, scheduled atomically with their reservations when cleanup is enabled. Jobs use eight
provider attempts, capped exponential backoff (30 seconds–15 minutes), a 20-second action budget
and 60-second leases; a bounded minute sweep recovers lost work. A queued
acknowledgement does not mean the files have been deleted. Terminal cleanup
failures retain ownership; the CLI preserves the original failure and marks
cleanup unknown. Authorized `retention.progress` reads require the actor token,
intent ID, intent secret and job ID. Staff-sourced unattached keys require a
positive authenticated per-key provider lookup before deletion. Unverified ownership ends
without deleting; ambiguous deletion acknowledgements remain unknown. Callback
and provider credentials stay server-side.

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

## Hosted pages

A Ticket can carry hosted HTML pages: one HTML file, or a folder with an HTML
entry page and its CSS, JavaScript, images and fonts. Publishing returns one link;
staff and the Ticket's customer see the same link on the Ticket, where they can
open, copy or revoke it. Anyone with an active link can open the page.

```bash
pnpm ticket page publish POS-0007 ./report.html
pnpm ticket page publish POS-0007 ./site --entry reports/index.html --request-id page-0007
pnpm ticket page list POS-0007
pnpm ticket page revoke POS-0007 --page <pageId>
```

```json
{"ok":true,"deployment":"dev","ticket":"POS-0007","url":"https://<deployment>.convex.site/p/<key>/reports/index.html","pageId":"kh7…","entry":"reports/index.html","fileCount":7,"totalBytes":4521,"created":true,"requestId":"page-0007"}
```

- `--entry` is required when a folder has several HTML files and no root
  `index.html` (`PAGE_ENTRY_REQUIRED`, exit 3). Hidden files are skipped;
  symbolic links are refused.
- Limits: 50 files, 10 MiB of file content, 20 published pages per Ticket.
  Allowed types: `html htm css js mjs png jpg jpeg gif webp avif ico woff woff2 ttf otf`.
- `--request-id` is the retry key. The same key and files return the original
  link with `"created":false`; different files return `PAGE_REQUEST_CONFLICT`
  (exit 5). After an interrupted run, retry with the reported key: files already
  stored are not uploaded again and the link appears only once every file is in.
- Publishing requires current write access to an active Ticket, checked before
  the upload is read and again when the page is committed. Archive hides every
  page of the Ticket; restore brings the same links back. Revocation is permanent.

### HTTP API

The CLI and the Ticket UI share one route on the deployment's HTTP host
(`*.convex.site`; locally `http://127.0.0.1:<CONVEX_SITE_PORT>`):

```http
POST /v1/tickets/{ticket}/pages
Authorization: Bearer <Convex Auth access token (JWT) of a staff or customer session>
Idempotency-Key: <stable request id>
Content-Type: multipart/form-data

entry    = reports/index.html
manifest = [{"part":"f0","path":"reports/index.html"},{"part":"f1","path":"assets/site.css"}]
f0, f1   = file bytes (each field exactly once)
```

The route verifies the access token like any browser call and forwards that
identity to every internal step, so the live session and admission are checked
again at reserve and commit.

Image policy. Without `X-Ticket-Image-Policy`, the server converts each raster
file and each literal base64 `img src` once with Sharp (fit within 1920 × 1080,
then the smallest of a cleaned original, WebP, JPEG for opaque images and AVIF
that passes the pixel comparison). The browser panel sends originals this way
whenever they fit the 10 MiB page limit. A larger selection is prepared in the
browser first (native canvas encoders) and sent with `X-Ticket-Image-Policy: v1`;
if the server's converted output would exceed the limit, the first attempt
falls back the same way. The CLI prepares images with the same Sharp pipeline
and always sends `v1`. Prepared raster bytes are validated, not re-encoded. The
policy is part of the request identity: a retry under the same
`Idempotency-Key` must resend the same bytes with the same policy, and the
browser panel keeps both with the selection. Paths in the HTML stay stable; the response MIME reflects the stored encoding. Literal base64 raster `img src` values in UTF-8 HTML can also be optimized. Hosted images use a private ETag with mandatory revalidation after checking that the page is active.

`201` publishes, `200` replays. Errors are `{"ok":false,"code":…}`: `401`
session, `403 ORIGIN_NOT_ALLOWED`, `404 TICKET_UNAVAILABLE`, `400` invalid
bundle, `409` conflict/revoked/limit, `413 PAGE_TOO_LARGE`. Unknown outcomes are
`503 PAGE_PUBLISH_UNKNOWN` with `"retryable":true` and `Retry-After`; incomplete
or expired uploads are `409` with `"retryable":true`. Retry those with the same key.

Browser writes are accepted only from origins listed in the Convex environment
variable `TICKET_APP_ORIGINS` (comma-separated, exact). Clients without an
`Origin` header, such as the CLI, are unaffected. Locally, `pnpm dev` and
`pnpm test:browser` set it on this checkout's local backend to exactly this
checkout's Vite origins (`localhost` and `127.0.0.1` on its `VITE_PORT`); no
manual step is needed. Shared deployments are configured separately.

`GET /p/{key}/{path}` serves committed files only, rechecking publication,
revocation and Ticket lifecycle on every request. HTML and unavailable responses carry `no-store`. Served files carry
`nosniff`, `no-referrer`, `noindex` and a CSP sandbox (`sandbox allow-scripts`,
opaque origin, no network access beyond inline code, `data:`/`blob:` media and
files under the page's own `/p/{key}/` prefix). External fonts and scripts do not
load; bundle them. `/p/{key}` redirects to the entry page.

Staging and blobs: before any byte is stored, the reservation records one
claim per file with a private random marker; the stored blob carries it in its
storage content type (served responses always use the validated path's type).
Recording clears the claim. If a run stops between storing and recording, a
same-key retry, or the five-minute reconciliation sweep, scans storage by
creation time in bounded passes within the claim's 11-minute write window and
attributes only the blob with that exact marker, size and hash. It is adopted
while staging, otherwise recorded as discarded. Expiry (15 minutes) only marks
abandoned uploads; deleting page blobs is part of the gated reclaim sweep and
runs only with `MEDIA_CLEANUP_ENABLED=true`. Unrelated storage is never deleted.
`pnpm convex:local run local_smoke:pages '{}'` checks this on the local backend.

## Output and error contract

Programmatic success is exactly one compact JSON object on stdout. Programmatic
failure is exactly one compact JSON object on stderr with a nonzero exit code.
The browser sign-in during `login` is the only interactive behavior and writes directly
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

Unmapped safe server codes appear in the `REMOTE_CALL_FAILED` message, with exit 6
and the same JSON fields. If guarded upload cancellation cannot be confirmed,
the original error and exit status are retained with
`details: { "cleanup": { "outcome": "unknown" } }`; reuse the same request ID.

Stable authentication errors include `DEPLOYMENT_NOT_CONFIGURED`,
`KEYCHAIN_UNAVAILABLE`, `NOT_LOGGED_IN`, `SESSION_EXPIRED`, `SESSION_INVALID`,
`SESSION_DEPLOYMENT_MISMATCH`, `INVALID_CREDENTIALS`, `AUTH_RATE_LIMITED`,
`CREDENTIAL_LOCK_TIMEOUT`, `CREDENTIAL_LOCK_ERROR`, and `NOT_AUTHORIZED`. Their hints use `pnpm ticket …`
syntax.

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
- Concurrent runs on the same macOS account take turns with the saved session.
  Each run's read, rotation and write of the refresh token, logout, and the
  config and Keychain steps of login hold an exclusive lock on
  `~/.config/track-ease-pos/ticket.lock` in the OS account’s home directory,
  shared across all `XDG_CONFIG_HOME` profiles. Browser sign-in takes place
  outside the lock. Each Keychain subprocess inherits the lock. If the CLI
  is killed, the kernel releases the lock after the last holder exits.
  A run that waits more than 60 seconds fails with `CREDENTIAL_LOCK_TIMEOUT`
  (exit 4) before touching the session. Retry the same command with the
  same `--request-id` for writes.

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
| `scripts/ticket/lock.ts` | Crash-safe cross-process session lock (macOS `O_EXLOCK`). |
| `scripts/ticket/google-login.ts` | Loopback listener for the named Google sign-in. |
| `scripts/ticket/output.ts` | Every stdout/stderr JSON shape the CLI prints. |
| `scripts/ticket/images.ts` | Local/HTTPS image loading, preparation with byte verification, HEIC conversion on macOS, and UploadThing storage. |
| `scripts/ticket/remote.ts` | Direct `ConvexHttpClient` calls to the app's public functions. |
| `scripts/ticket/session.ts` | Persistent staff-session lifecycle and access policy. |
| `scripts/ticket/run.ts` | Ticket command orchestration and remote-failure classification. |
| `convex/tickets.ts` | Canonical policy-declared Ticket handlers for the browser and CLI. |
| `shared/ticket-state.ts` | Ticket text limits and the optimistic-version check. |
| `convex/domain/tickets.ts` | Shared Ticket planner, allocation, totals and audit writes. |
| `convex/ticket_requests.ts` | Request-id normalization and idempotency rules. |
| `convex/domain/requests.ts` | Immutable receipt scope, replay authorization and purge tombstones. |
| `scripts/ticket/pages.ts` | Reads a page file or folder from disk for `page publish`. |
| `shared/ticket-pages.ts` | Page limits, path rules, media types, form body and serving headers. |
| `convex/page_http.ts` | Publish and serve HTTP routes. |
| `convex/domain/pages.ts` | Page reservation, staging, commit, revoke, expiry and reclaim. |
| `src/features/tickets/ticket-pages.tsx` | Ticket dialog panel for staff and customers. |

Verify changes with:

```bash
pnpm check
```

The CLI process tests use `python3` and its standard-library `pty` module on
macOS/Linux to exercise the real hidden prompt. HTTP responses and credential
storage are fake; the tests assert natural process exit after success,
rejection and cancellation.

## Disposable local implementation target

For the P8 reset/seed tooling, local rehearsals and the ordered checkpoint 20
procedure, see [Development reset](dev-reset.md). `pnpm dev:reset` inspects the
recorded development target by default; implementation rehearsals must explicitly
use `--target local`. Reset execution also requires `--expect <reviewed inspect manifest>`;
remove the target's `UPLOADTHING_TOKEN` and set cleanup to exactly `false` first,
using the reset tool's env commands. After clearing, the reset bootstraps the
Owner again and verifies this CLI's login/whoami/list/get/logout with that fresh
Owner session; a run that stops after clearing continues with `pnpm dev:reset resume`.
This does not change the Ticket CLI's flags or JSON contract.

The implementation target is this checkout's disposable anonymous backend. Run
`pnpm agent:setup` in a new worktree to install dependencies and initialize its
local backend; use the URLs it prints. Ports are assigned per checkout in
`.env.worktree`, so do not assume the main checkout's default ports or edit that
file manually.
The wrapper preserves `.env.local`; its saved deployment can differ from the
local backend. `pnpm dev` sets local URLs for the web and API processes, and
`pnpm dev:convex` pushes only to the local backend. No shared deployment or
provider resources are changed by these fixtures. Do not run bare Convex commands or edit either environment
file manually. The local wrapper accepts only `dev`, `run`, `env`, `import`,
`export`, `data`, `codegen` and `--help`; no arguments defaults to a local push.

```bash
pnpm convex:local
pnpm convex:local env set LOCAL_FIXTURES_ENABLED true
pnpm convex:local env set IDENTITY_SENDER local
pnpm convex:local env set IDENTITY_CODE_KEY local-only-identity-code-key-0123456789abcdef
pnpm convex:local env set UPLOAD_CALLBACK_SECRET local-only-callback-fixture
pnpm convex:local env remove MEDIA_CLEANUP_ENABLED
pnpm convex:local env list
pnpm convex:local run seed:run '{}'
pnpm convex:local run seed:run '{"largeDataset":true}'
pnpm convex:local run local_smoke:reads '{}'
pnpm convex:local run local_smoke:run '{}'
pnpm convex:local run local_smoke:media '{}'
pnpm convex:local dev --once --typecheck disable --start 'pnpm exec tsx scripts/smoke-local.ts'
```

The CLI smoke also publishes `tests/fixtures/ticket-page` (nested entry, CSS,
script, images, font) and a single file, then checks replay, conflict, served
headers, nested assets and revocation against this checkout's backend.

The internal seed requires explicit fixture opt-in and a loopback deployment URL, and is repeatable. It creates Projects `POS` and `APP`,
the Owner `owner@local.test` and Staff `staff@local.test` (local test provider in
place of Google), customers `alice` and `bob` (password `local customer passphrase`,
real username and password components), POS memberships and three text-only
Tickets through the Ticket domain. Each run mints fresh admitted Convex Auth
sessions: `sessions` holds their session IDs and `accessTokens` their one-hour
local access tokens (staff, Alice, Bob order) for tests and smoke clients; Ticket
rows are reused. `pnpm agent:setup` gives the local backend inert Google
placeholders; Google sign-in itself is never available locally.

The opt-in `largeDataset` fixture adds 300 text-only Tickets across POS and APP
in bounded batches through Ticket domain commands. It grants both fixture customers
APP membership, distributes all five statuses, and uses immutable seed receipts
so reruns reuse rows and preserve later edits. The three `quartz` examples have
deliberately different text lengths for real relevance-order validation.
`local_smoke:reads` creates a fresh, isolated Project with 28 search examples, then
verifies search scope/order, prefix matching, complete page ordering, deduplication
and independent workflow totals, and prints actual summary page JSON byte sizes
from POS. Existing disposable fixtures remain in place; the smoke prints actual
active counts rather than assuming an empty backend.
It also checks reference-shaped printer text and two Thai examples against the
real tokenizer. Thai token boundaries do not always match words: `ชำระเงิน` does
not match inside the fixture's `เมื่อกดปุ่มชำระเงิน`, while the longer phrase does.
The backend smoke also creates a fresh Project without customer membership for
its access-denial check; APP membership may already exist after the large seed.
All three smokes can be repeated in any order on the same local data.
Unexpected errors include their original message in server logs only when
`LOCAL_FIXTURES_ENABLED=true` and the deployment URL is loopback. Deployed logs
and all error responses retain sanitized codes without the original message.

Browser lists use `tickets:pageTickets`; staff lane counts use `tickets:laneTotals`.
Customer filters/counts explicitly describe loaded summaries. Detail is selected
by Ticket ID independently of loaded pages. `tickets:searchTickets` returns at most
50 relevance-ordered matches plus `hasMore`. Exact formatted references use the
Ticket-number index. Text search ignores case and punctuation; the final token
matches prefixes and earlier tokens match whole words. It is not arbitrary
substring or typo matching. When more matches exist, the UI asks users to refine
the search and does not display an exact match total. Workflow totals stay separate.
Convex 1.45 ignores row/byte pagination caps for search end-cursor ranges, so search
uses a bounded `take(51)` rather than reactive search pagination. Ordinary pages
cap reads at 50 rows and 1 MiB (with Convex page splitting); those budgets exclude
session/Project/membership reads and may include a boundary document.

The backend smoke exercises real sign-in, both roles, creation, detail, edit,
workflow, urgency, archive/restore and annotations. Annotations require media;
the smoke uses fake metadata with no provider upload. The CLI smoke uses the
real orchestration and Convex adapter with in-memory credentials and a fixed
loopback URL, checking JSON, retries after edits, content/Project conflict exit 5
and text-only commands. The backend smoke starts eight concurrent identical
creates in separate mutations and asserts one Ticket row and one creation audit
event, then checks replay after editing and content/Project conflicts.
The media smoke uses fake receipts to exercise competing exclusive key claims,
duplicate recording, attachment, takeover denial and late-upload reservations
on the local backend, including customer callback preflight and media creation.
It requires cleanup disabled (unset by default) so fake-key jobs remain pending
and unscheduled. It does not call UploadThing; do not configure provider credentials
for these smokes. The guard rejects an enabled cleanup flag before creating fixtures.
`--start` keeps the local backend alive for the CLI process; standalone `run`
commands stop their local backend when they exit.

Public handlers now return structured error codes. CLI flags, JSON fields and
exit codes retain their documented meanings. Upload recording requires either
the originating staff session or the server-only `UPLOAD_CALLBACK_SECRET`
configured in both the HTTP process and Convex. Browser upload preflight verifies
that credential before accepting files and counts files already recorded for
the intent. Staff recording cannot reserve new keys against rejected intents;
only trusted provider callbacks can reserve rejected new uploads. Existing plaintext Keychain
credentials are rejected; sign in again to write the current encoded format.
Local media cleanup scheduling now uses durable jobs: abandoned intents are
claimed every five minutes, and Tickets archived for at least 30 days are
claimed hourly. Purging blocks restore, retains media reservations through
failure and removes the Ticket only after verified deletion. Legacy finalization
then removes the Ticket's events, messages, routing suggestions and customer and
staff inbox items, and strips routing request receipts in indexed batches of at
most 100 entries per table. Account and Project inbox preferences are retained.
The purge completes after all these batches drain. Named-pilot settings or an
installed pilot release block legacy finalization, including queued batches.

Routing requests that produced a suggestion and those that returned manual
routing both leave permanent tombstones with the request source, caller, request
ID, immutable input digest and `unavailable` outcome. They discard the Ticket,
Project and suggestion references and the Ticket and policy revisions. A replay
against the purged Ticket returns `TICKET_UNAVAILABLE`. The same caller reusing
the routing request ID with different input on an accessible Ticket receives
`REQUEST_ID_CONFLICT`. Ticket creation and attachment receipts keep their
existing tombstone policy.

Purges already completed before this change need separate, scoped reconciliation
if inbox rows or routing requests remain. Recovery resumes in-progress jobs.

The Convex environment flag `MEDIA_CLEANUP_ENABLED=true` gates job execution,
recovery and new purge claims; P8 enables it last, after configuration and smoke
checks. Cancellation, rejected callbacks and expiry always create pending jobs
and reserve unattached assets (`deleting`, with a job reference). Cancellation
returns queued progress without claiming deletion. Expiry still marks intents
expiring/cleaned while disabled, since it needs no provider I/O. Disabled creation
schedules nothing; a previously scheduled action defers the job by 30 seconds,
logs one bounded line and spends no provider attempt. Disabled recovery and purge
sweeps do nothing, leaving archived Tickets restorable. Enabling the flag lets
recovery pick up due pending jobs automatically; no requeue is needed. Missing storage configuration leaves
jobs pending without spending provider attempts. Database finalization renews
leases and does not spend provider attempts. Failed jobs keep their progress
and reservations; after repairing the cause, ops can run
`pnpm convex:local run retention:requeue '{"jobId":"..."}'` locally. Ownership
conflicts block only the affected job/Ticket; blocked archived Tickets remain
visible/restorable and are skipped by later purge sweeps.
Ticket annotations share the Ticket version and audit path. The embedded budget
is 100 entries and 50,000 text characters per Ticket, with 2,000 characters per
entry; soft-deleted entries still count. Initial creation, additions, edits and
undo all enforce the budget. Restore removes the archive timestamp explicitly.

Restoring a blocked archived Ticket supersedes the failed purge job and clears
its block. Re-archiving starts a fresh 30-day retention window. Both internal
and staff requeue enforce that window; Operations health asks for confirmation
before requeuing permanent Ticket deletion. Superseded jobs are counted
separately from completed deletions.
