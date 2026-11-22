# Browser verification

How the Ticket browser checks run, what each one proves, where evidence goes,
and how the browser CI job is rolled out. Everything here runs against the
disposable local backend with synthetic fixtures, `MEDIA_CLEANUP_ENABLED=false`,
cleared provider credentials and blocked non-loopback traffic.

## Commands

| Command | What it runs | Typical time (macOS, warm) |
| --- | --- | --- |
| `pnpm test:browser` | Bootstrap stages, 40 workflow and accessibility checks, then the Ticket Explorer harness check | ~2.5 min |
| `pnpm test:browser --grep "<pattern>"` | Bootstrap, then only matching workflow/accessibility tests (Explorer skipped) | ~1 min + tests |
| `pnpm test:explore` | Bootstrap, then the seeded draft exploration (default seeds 1,2,3) | ~1 min |
| `pnpm test:visual --repeat 3` | Builds and serves the synthetic Explorer harness, then compares three states across three captures | ~30 s |
| `pnpm browser:evidence summary` | Stages, failing checks, screenshots and local trace commands from the last run | instant |
| `pnpm browser:evidence verify` | Exit 1 unless `public/` holds only allowlisted, sanitized files | instant |
| `pnpm browser:evidence clean` | Delete `test-results/browser` (traces included) | instant |
| `scripts/browser-linux-rehearsal.sh <docker context> [test:browser args]` | The CI job's steps in a fresh `ubuntu:24.04` container; evidence copied to `test-results/linux-rehearsal/` | ~4.5 min |

Run one browser command at a time per checkout: each owns the local backend and
resets `test-results/browser`. Do not run another `pnpm convex:local` command
meanwhile; the wrapper refuses to start over an interrupted run.

## Bootstrap stages (fail closed)

`scripts/test-browser.mjs` runs each wrapper command as a named stage and logs
it, sanitized, to `public/logs/runner.log`. A nonzero stage stops the run with
`Browser checks did not complete: stage <name> failed`, exit 1.

1. `cleanup-flag` sets `MEDIA_CLEANUP_ENABLED=false` before the schema push.
2. `schema-push` pushes functions and schema to the local backend.
3. `cleanup-flag-verify` reads the flag back and refuses anything but `false`.

Cold checkouts (no `.convex/local/default/config.json`, as on a fresh CI
runner) cannot run env commands yet: the wrapper fails with `Local backend
startup failed` and the run stops at `cleanup-flag` (found by the Ubuntu
rehearsal). The runner therefore runs `schema-push-cold` first there. A new
backend has no environment variables, and only the exact value `true` enables
cleanup, so it is off; `cleanup-flag` and `cleanup-flag-verify` follow before
any fixture or browser runs.
4. `fixture-env-*` sets local-only fixture credentials.
5. `seed` creates synthetic Projects, sessions and Tickets. Its output holds
   session tokens and is never logged.
6. `suite-<name>` starts Vite and the upload API (`servers-ready`), then runs
   `workflows` (workflow + accessibility tests) and `explorer`. Both run even
   if the first fails; the exit status is the first nonzero one.

Provider credentials are deleted from the environment before any child starts.
Every browser context aborts non-loopback requests and records the host in the
manifest's `blockedHosts` (for example `fixture.invalid`, the fake media URL).

## Evidence layout

`test-results/browser/` is ignored by git. Set `BROWSER_EVIDENCE_DIR` to a
different subdirectory of `test-results` to retain separate runs.

| Path | Content | Uploaded by CI |
| --- | --- | --- |
| `public/manifest.json` | commit, Node, platform, Chromium version, locale, timezone, stages with exit codes and durations, every check with status, duration, sanitized first error, screenshots, viewport and app language | on failure |
| `public/logs/runner.log` | sanitized bootstrap and suite output | on failure |
| `public/logs/<suite>-failures.log` | sanitized assertion and stack for each failed check | on failure |
| `public/screenshots/*.png` | viewport screenshot of every open page of a failed check, taken before its contexts close; Explorer harness screenshots | on failure |
| `public/explore/*.json` | seed, config, fixture description, resolved action sequence and first failure | on failure |
| `local/traces/*.zip` | Playwright trace (DOM snapshots, network, console) of each failed check | never |

Traces are on by default locally and off in CI (`BROWSER_TRACE=on|off`). Open
one with the command `pnpm browser:evidence summary` prints:
`pnpm exec playwright show-trace test-results/browser/local/traces/<name>.zip`.

Sanitizing redacts the local fixture passwords and secrets, any environment
value whose name contains TOKEN, SECRET, PASSWORD, PEPPER or ADMIN/DEPLOY_KEY,
session tokens registered by the test harness, hex strings of 44 or more characters, bearer
values, JWTs, URL query strings and `token=`/`secret:`-style pairs.
`verify` re-sanitizes every text file and refuses any change, any file outside
the allowlist, symlinks, and any `.png` without a PNG header.

Clean up with `pnpm browser:evidence clean`.

## Verification map

Each check's invariant, the durable state it confirms, and its evidence.
Workflow checks live in `tests/browser/workflows.test.ts`, accessibility checks
in `tests/browser/accessibility.test.ts`.

| Journey | Selectors | Invariant | Durable state checked | Scope |
| --- | --- | --- | --- | --- |
| Draft focus, pin, camera teardown (staff/customer × en/th) | `#title`, `openMedia`, `addPin`, camera dialog | focus moves to the title and back to the file; every preview URL and camera track is released on remove and session expiry | none (no write); `draftStats` | provider uploads aborted, asserted 0 |
| Text-only creation (×4) | composer submit | one submit creates one Ticket without review steps | `getTicket` title, empty description and media | |
| Project switch keeps captured draft (×2) | `Choose Project`, resume | a draft keeps its Project after switching | `searchTickets` in POS; edit undo and conflict preserve server title | |
| Cancel, retry, discard (×4) | `cancelUpload`, `discardDraft` | lost responses retry with identical intent; discard releases previews | exactly one Ticket per title | fake provider receipts recorded on the local backend only |
| Lost Project access | membership removal | draft stays discardable | membership restored in `finally` | |
| Operations health (en/th) | `healthTitle` dialog | only booleans and counts shown | no secret strings in dialog text | |
| Purge requeue confirmation (en/th) | browser `confirm` | dismiss sends nothing; accept sends one requeue | transport fixture, no deletion scheduled | |
| Staff sign-in rate-limit action | `#staff-password` | wrong then right password | session reaches the workspace | |
| Per-Project views, Focus, result-leave notices, deferred status | view group, Focus, status | view and focus restoration | `getTicket` versions | |
| **Staff archive and restore** | detail `Actions` → `Archive`, `alertdialog` Cancel / Escape / Archive, archive list `Restore` | Cancel and Escape write nothing and return focus to Archive; confirm archives; restore returns the same Ticket | `lifecycle`, `version` unchanged after dismissal; `archived` with `archivedAt` and the same `tagIds`; `active` with the same `tagIds` after restore | |
| Keyboard pin placement (en/th) | `markPoint` surface, arrow keys | keyboard-only placement and move | marker position | |
| Phone layouts (×4) | 320/390 px | no page or surface overflow; three Tickets in three activations | URL `ticket` param | |
| **Axe canary** | injected unnamed `<button>` | the configured scan reports `button-name` | — | proves scan sensitivity |
| **Keyboard-only creation** (staff en, customer th) | Escape, Enter, Tab ×25, Shift+Tab ×25, implicit submit | Escape returns focus to New Ticket; Tab stays in the modal; empty submit keeps focus on the title with `aria-invalid` and `aria-describedby` → required message; typing clears it; Enter creates | `getTicket` title | axe on composer and validation state |
| **Media dialog** (staff en, customer th) | `openMedia`, Escape | Tab stays in the nested modal; Escape returns focus to the file | — | axe on media dialog |
| **Archived details and Operations health** (staff en/th) | archive list, `restore`, `detailBack` | archived details have no Edit; Back returns focus to the row | backend-archived Ticket | axe on both |
| Ticket Explorer harness | `tests/browser/explorer.html` | table/board, filters, dates, urgency, pagination, archives, Thai, phone overflow | in-memory only | screenshots in `public/screenshots/explorer-*.png` |
| Draft exploration | see below | model properties after every action | none written | seeds, budget, replay |

### Accessibility scope and exclusions

Scans use axe-core 4.14.0 (pinned in `pnpm-workspace.yaml`) with tags
`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` over the whole document, so
content a modal fails to hide is reported too. Exclusions live in
`tests/browser/a11y.ts`; each names one rule, a node matcher, a reason, an owner
and a review date. Current entry:

- `label-content-name-mismatch` on Ticket row buttons (`data-ticket-id`): the
  visible status/Archive text is missing from `aria-label` (WCAG 2.5.3). Owner:
  frontend maintainer for `src/components/ticket-card.tsx`. Review 2026-12-19.

Manual screen reader passes are not automated. Before promoting the scans,
run VoiceOver (macOS) on keyboard-only creation with a validation error in
English and Thai and record the result here.

## Visual pilot (go/no-go)

`scripts/visual-pilot.ts` captures three Explorer harness states
(`explorer-table-desktop`, `explorer-board-desktop`, `explorer-table-phone`)
with Chromium from the lockfile, DPR 1, `en-US`, UTC, light scheme, reduced
motion, a frozen clock and fixed synthetic Tickets, and compares pixels with
pixelmatch (threshold 0.1, 0 differing pixels allowed).

- `pnpm test:visual --update` writes a baseline to
  `test-results/visual-baseline/<platform>-<arch>/` (local, not committed).
- `pnpm test:visual` compares with it; diffs go to `test-results/visual/diff/`.
  Missing baseline: exit 3. Any diff: exit 1.
- `pnpm test:visual --repeat 5` requires identical repeats (no baseline needed).
- `pnpm test:visual --probe` adds a 4 px left padding to `main` and must detect
  a diff in every state; it exits 1 if the comparison misses it.

Measured 2026-11-19: 12/12 macOS repeats and 6/6 Linux container repeats
matched at 0 px after waiting for the lazily loaded filter controls (the first
attempt caught a 544 px "Syncing" fallback, which the wait fixes); the probe
produced 29092, 26175 and 8801 differing pixels.

Decision: **go** for local before/after review and for the CI stability step
(advisory, captures uploaded for review); **no-go** for a blocking CI gate until
a Linux x64 baseline has matched across 10 hosted runs and a maintainer has
reviewed it. Fonts come from the OS, so macOS and Linux baselines differ.

## Draft exploration

`tests/browser/explore-draft.ts` is a scoped Playwright exploration of a
synthetic customer draft (`alice@local.test`, Projects POS and APP, generated
PNGs). A seeded PRNG chooses valid actions: name the draft (always first, which
captures POS), add a file, keyboard-reorder, remove (confirming when pinned),
add a pin, open media and press Escape, close, resume, switch Project. After
every action it checks:

- `no-page-errors` and `no-provider-uploads`;
- `preview-release`: live object URLs equal the model's file count;
- `file-order`: preview order equals the model;
- `captured-project`: the open draft still shows Point of Sale (POS) whichever
  Project is selected;
- `focus-return`: Escape from media returns focus to its file;
- at the end, `discard-releases-all`: every created preview URL is revoked.

Controls: `EXPLORE_SEEDS` (default `1,2,3`), `EXPLORE_ACTIONS` (20),
`EXPLORE_BUDGET_MS` (90000 per seed; no new actions after it), `EXPLORE_REPLAY`,
`EXPLORE_PROBE=leak` (a synthetic fault: `URL.revokeObjectURL` becomes a no-op).
A failing seed writes `public/explore/seed-<n>.json`; replay it exactly with
`EXPLORE_REPLAY=<file> pnpm test:explore` (add the same `EXPLORE_PROBE`).

Measured 2026-11-19: seeds 1, 2 and 3 hold every property (20 actions each,
4-9 s). The first seed 3 run failed at step 13 because a new pin click landed on
an existing marker; the retained call log and screenshot showed the harness
fault, fixed by placing pins on a grid. With `EXPLORE_PROBE=leak`, seed 3 fails
at step 5 (`preview-release: 2 live preview URLs for 1 files`) and
`EXPLORE_REPLAY` of its JSON reproduces the same step and message.

Before proposing a fix for a discovery, reproduce it as a deterministic test in
`workflows.test.ts` and have a person review it. Exploration is not part of
`pnpm test:browser` or CI and stays non-required.

Bombadil was not adopted for this pilot: it is a separate experimental binary
outside the pnpm lockfile, its replay is documented as experimental, and the
Playwright fixtures here already provide the instrumented draft, session setup
and provider blocking the properties depend on. Revisit it if the scoped
Playwright exploration finds that its fixed action set misses real defects.

## Browser CI rollout

`.github/workflows/browser.yml` (`browser / browser-workflows`) runs on every
pull request, pushes to `main` and manual dispatch, on `ubuntu-24.04`, Node 24
and the lockfile's pnpm and Playwright. It has read-only `contents` permission,
no secrets, and `persist-credentials: false`.

| Phase | Gate | Owner |
| --- | --- | --- |
| 1. Advisory (now) | The job runs and reports; it is not a required check. `pnpm check` stays browser-independent. | CI maintainer |
| 2. Rehearsal | Collect 10 representative first attempts on PRs: duration, pass/fail, cause. Record fixture/environment failures separately from product failures. Resolve every unexplained failure. Open one failing artifact and confirm it explains the failure. | CI maintainer |
| 3. Required | A GitHub maintainer adds `browser-workflows` as a required status check on `main` and confirms on a rehearsal PR that red blocks merge and green allows it. | Repository maintainer |
| 4. Review | One month after phase 3: runtime, flaky first attempts, artifact usefulness, confirmed regressions. Decide whether exploration or a visual gate is worth adding. | CI and frontend maintainers |

Temporary exemption: for a diagnosed harness fault, the repository maintainer
may remove the required rule with a named owner, a linked issue and an expiry
date (at most 14 days); the route back is the phase 2 gate on the fix.

Uploaded evidence is public (this repository is public). Only
`test-results/browser/public/` is uploaded, only on failure, only after
`pnpm browser:evidence verify` passes, with 7-day retention. Raw traces are never
uploaded; enable a trace upload only after inspecting a sample and agreeing
with the repository maintainer that it is safe.

### Rehearsal record

| Date | Where | Commit | Result | Duration | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | macOS arm64, warm | 55cc64d (main) | 33/33 workflows + Explorer pass | 148 s tests | baseline before this change |
| 2026-11-19 | macOS arm64, warm | this branch | 40/40 + Explorer pass, twice | 138 s, 139 s end to end | after fixing a confirm-dialog race in the new archive journey |
| 2026-11-19 | macOS arm64 | this branch | deliberate failures in the archive journey and Explorer: exit 1, both entry points failed and captured, 2 screenshots, 2 local traces (47 and 229 files), `verify` passed | 202 s | probe edits reverted |
| 2026-11-19 | macOS arm64 | this branch | port 4170 held by another process: exit 1 at `cleanup-flag`, `runner.log` and manifest name the stage, no checks run | 32 s | bootstrap probe |
| 2026-11-19 | Ubuntu 24.04 arm64 container (colima), cold | this branch | first attempt: exit 1 at `cleanup-flag` (cold backend); fixed with `schema-push-cold` | 82 s | real cold-path finding |
| 2026-11-19 | Ubuntu 24.04 arm64 container, cold, `CI=true` | this branch | 40/40 + Explorer pass; 4 allowlisted files; visual repeats 0 px | 256 s incl. install | traces off |
| 2026-11-19 | Ubuntu 24.04 arm64 container, `CI=true` | this branch | deliberate archive failure: exit 1, screenshot + logs + manifest, no trace, `verify` passed | — | hosted x64 runner still pending |
