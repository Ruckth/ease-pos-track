# Ticket verification

See the [browser verification guide](browser-verification.md) for the browser
CI job, accessibility scans, visual comparisons, and draft exploration.

| Check | Command | Maintainer | Use |
| --- | --- | --- | --- |
| Architecture and Convex registration | `pnpm check:arch` | Backend | Included in `pnpm check` |
| React Hooks | `pnpm lint` | Frontend | Included in `pnpm check` |
| Generated Ticket lifecycle | `pnpm test:convex tests/convex/ticket-lifecycle.test.ts` | Backend | Included in `pnpm check` |
| Mutation controls | `pnpm test:mutation [ownership\|immutable\|fence\|age]` | Backend | Advisory, run on demand |
| Bounded retention model | `pnpm test:retention-model [safety\|progress\|broken-fence]` | Backend | Advisory, run on demand |

The owner labels identify maintainer roles. The repository maintainer assigns people and reviews first-attempt failures, runtime, and actionable findings one month after adoption. Run the pilots when their mapped operations or invariants change. Retain the first failure, identify fixture, tooling, or product causes, and turn confirmed gaps into deterministic regression coverage. Review pilot usefulness and cost before scheduling a recurring run.

Keep the existing stable TypeScript check, disposable Convex schema push and generated-binding check in CI. The browser lane has its own rehearsal and adoption. Before requiring that status, the CI maintainer needs ten representative clean-runner first attempts, usable deliberate-failure evidence and verified merge enforcement on a rehearsal PR. Record bootstrap and fixture failures separately from application failures. A diagnosed harness exemption needs a named owner, expiry and a rehearsal of the fix before restoring enforcement.

## Architecture and Convex policy

Use the existing [checker](../scripts/check-arch.ts) for browser, adapter, shared and server dependency rules. Put new browser transport in a named adapter entry point or the feature's `adapters/` directory. Extend the checker's designated adapter set only when the intended entry point needs a new path. Keep positive and negative fixtures for each boundary change. [Architecture fixtures](../tests/architecture.test.ts)

Register exported Convex operations through the applicable constructor in `convex/functions.ts`. Put resource ownership and Project access in the domain operation. The checker's public exception manifest lists the reviewed auth and trusted callbacks with their purposes. For a new public exception, add the exact export and purpose to the manifest and extend the policy fixture. If operation access changes, test the registered entry with an allowed actor and a denied actor, then check the durable Ticket and side effects. [Constructors](../convex/functions.ts) · [Registration fixtures](../tests/function_policies.test.ts)

The existing 12 guard checks passed, including forbidden imports through aliases and loader forms, and raw or untagged registrations in exports and HTTP routes. These fixtures exercise the same checker used for real repository files.

## React Hooks

The pins are ESLint 9.39.5, TypeScript ESLint parser 8.73.0 and React Hooks plugin 7.1.1. ESLint checks `rules-of-hooks` and `exhaustive-deps` as errors on application TypeScript. The scope skips declarations and imported component bases in `src/components/ui` and `src/components/reui`. [Config](../eslint.config.js) · [React rules](https://react.dev/reference/eslint-plugin-react-hooks)

The initial lint run identified camera preview teardown and the composer's StrictMode generation check. Camera cleanup releases the node that received the stream. Composer cleanup compares setup generations through a captured lifetime object and reads its current draft after the replay microtask. The browser suite checks both camera teardown and draft preservation. [Browser workflows](../tests/browser/workflows-composer.test.ts)

Repeat the deliberate lint failures from the repository root. Each input exits 1 and identifies its rule.

```sh
printf '%s\n' 'import {useState} from "react"; export function Broken({enabled}: {enabled: boolean}) { if (enabled) useState(0); return null; }' |
  pnpm exec eslint --stdin --stdin-filename src/hooks-sensitivity.tsx
printf '%s\n' 'import {useEffect} from "react"; export function Broken({title}: {title: string}) { useEffect(() => console.log(title), []); return null; }' |
  pnpm exec eslint --stdin --stdin-filename src/hooks-sensitivity.tsx
```

## Generated lifecycle and replay

Each property runs 50 histories with at most 20 commands against a fresh `convex-test` fixture under controlled time. The text fixture gives a customer and staff independent sessions, uses registered customer login and logout, and grants and revokes membership through registered staff operations. Its model remembers the immutable accepted title separately from the visible edit history. It checks identity, numbering, receipt, audit, totals, and denied-write snapshots. The upload fixture checks accepted and ambiguous recording, attachment, cancellation, expiry, disabled and resumed cleanup, and replacement of a lease. Storage calls are faked. A targeted provider race supplements the sampled histories. [Generated tests](../tests/convex/ticket-lifecycle.test.ts) · [Runtime races](../tests/convex/media-jobs.test.ts)

Use the test's commit and fast-check 4.10.2 as its fixture version. Preserve the printed seed, path, executed commands, and command replay path when present. In the examples below, replace the values with the ones printed for the failure.

```sh
TICKET_LIFECYCLE_SEED=1480752 TICKET_LIFECYCLE_PATH=7:3:1:2 TICKET_LIFECYCLE_COMMAND_PATH=BAH:F \
  pnpm test:convex tests/convex/ticket-lifecycle.test.ts -t 'generated create'
TICKET_MEDIA_SEED=1384987 TICKET_MEDIA_PATH=16:4:11:16:10 \
  pnpm test:convex tests/convex/ticket-lifecycle.test.ts -t 'generated upload'
```

For a different seed, set only the seed variable. Keep the fixed runs in `pnpm check`. The generated model covers sampled sequential histories and an explicit stale-lease transition in the Convex mock. The browser exercises selected workflows on a disposable backend. Move a minimized confirmed issue into a focused regression and exercise runtime-dependent interleavings on the disposable backend where feasible. [fast-check replay](https://fast-check.dev/docs/advanced/model-based-testing/#replay-model-based-tests)

## Mutation controls

The pilot reuses Vitest 3.2.7, its Edge runtime and the existing indirect Convex module registry. The scripted alternative injects a single source change through Vite before transformation, with the normal files left on disk. The runner requires a passing clean baseline, the exact source transformation marker, and failure at the selected domain assertion. It returns a distinct failure for a survivor, a runner or configuration error, or a timeout. Keep each selected run below 90 seconds and the whole pilot within ten minutes.

| Control | Changed predicate | Assertion that caught it |
| --- | --- | --- |
| `ownership` | Drop the durable actor match before comparing receipt content | A staff replay of the customer's request must return `TICKET_UNAVAILABLE`. The mutation returned `REQUEST_ID_CONFLICT` and exposed receipt existence. |
| `immutable` | Ignore the stored accepted-input digest | Reuse with a different title must return `REQUEST_ID_CONFLICT`. The mutation returned the existing Ticket. |
| `fence` | Ignore the lease ID while keeping the attempt and expiry checks | Current attempt with the old lease ID cannot checkpoint. The mutation accepted it. |
| `age` | Use an exclusive purge age boundary | An archived Ticket is eligible at exactly 30 days. The mutation delayed its claim. |

All four selected controls were caught. Complete runs finished in 100 and 64 seconds on macOS. The sample measures those four invariants. On a survivor, check the fixture and the selected invariant, and record whether behavior is equivalent, coverage is missing, or the runner failed. Re-run an individual control by name. The ownership replay below checks the same short history against both the baseline and the weakened actor predicate.

```sh
TICKET_LIFECYCLE_SEED=1480752 TICKET_LIFECYCLE_PATH=7:3:1:2 TICKET_LIFECYCLE_COMMAND_PATH=BAH:F \
  pnpm test:mutation ownership
```

## Retention model

TLA+ Tools v1.7.4 supplies TLC 2.19. Use a Java runtime such as Java 21 and an absolute jar path. The runner verifies SHA-256 and writes TLC scratch files outside the checkout. `TICKET_JAVA` can point to a standalone Java binary. [Pinned release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)

```sh
ticket_tlc_dir=$(mktemp -d)
curl -fL -o "$ticket_tlc_dir/tla2tools.jar" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
export TICKET_TLC_JAR="$ticket_tlc_dir/tla2tools.jar"
pnpm test:retention-model safety
pnpm test:retention-model progress
pnpm test:retention-model broken-fence
```

The model fixes one Ticket, one attached and one unattached asset, one key per job, two workers, up to two archive cycles, clock ticks 0 through 3, and at most two leases per job. An archive is eligible after one abstract age tick. A lease is valid for one abstract tick and a lost worker's lease can still expire after the archive clock saturates. The safety config checks type bounds, ownership, archive-cycle exclusivity, stale settlement, disabled admission and completion ordering.

| Model action | Convex correspondence |
| --- | --- |
| `Archive`, `Restore` | Registered Ticket mutations perform atomic lifecycle changes. Restore is available before the purge claim. [Ticket operations](../convex/domain/operations.ts) |
| `ClaimPurge`, `ReserveUnattached` | The age-and-flag-checked purge claim changes lifecycle and reserves owned assets. Intent expiry and cancellation reserve only unattached assets. [Retention](../convex/retention.ts) · [Ownership](../convex/domain/media.ts) · [Cancellation](../convex/uploads.ts) |
| `Start`, `ExpireAbandoned` | Start combines scheduled recovery, a flag-checked claim and provider admission. Recovery scans pending and expired work. Timing and backoff are abstracted. [Claim and recovery](../convex/retention.ts) |
| `FinishIO`, `Crash` | An admitted call runs outside the transaction and can finish while disabled. A crash can leave physical deletion ahead of a durable checkpoint, so a replacement may contact the provider again. [Provider action](../convex/media_job_actions.ts) |
| `Settle`, `DiscardStale`, `Finalize` | Checkpoint and advance use the current lease. Purge finalization requires deleted media. The model collapses fenced database-only finalization and audit batches into one step. [Retention](../convex/retention.ts) · [Lease fence](../convex/domain/media_jobs.ts) |

The progress config assumes weakly fair clock ticks, abandoned-lease expiry, job admission, worker steps and finalization. Its claim starts at queued work. It requires cleanup and storage/provider availability to stay on eventually, valid ownership, no further worker loss, and enough lease capacity to continue. A successful provider response can represent verified absence on retry. The model abstracts configuration refunds, provider failures and manual repair. The runtime checks the flag at job claim. A multi-key action can issue subsequent requests on an admitted lease, so the disabled invariant covers new job admission. The model uses a single lease generation. The runtime also tracks an attempt count independently. Compare model findings with the registered operation tests before changing production behavior.

The safety and conditional progress runs each checked 363,824 distinct states to depth 27 with an empty queue. They took 37 seconds and 8 minutes 5 seconds respectively while other local checks were running. With the fence weakened, TLC reaches this eight-state counterexample.

1. Start with cleanup disabled and one unattached asset.
2. Enable cleanup.
3. Reserve the unattached asset.
4. Worker 1 starts provider work under lease 1.
5. A clock tick expires lease 1.
6. Worker 2 starts replacement work under lease 2.
7. Worker 1's provider response arrives.
8. Worker 1 checkpoints under lease 1 and marks lease 2's job done. `NoStaleWrite` fails.

The TypeScript provider race and generated replacement test exercise delayed settlement and independent lease-ID rejection. The separate runtime disable test holds an admitted fake provider response, verifies a second job remains pending at attempt zero, then releases the first response. [Runtime regressions](../tests/convex/media-jobs.test.ts)
