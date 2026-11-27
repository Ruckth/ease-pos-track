# Local Ticket preview

Open [the stable preview](http://127.0.0.1:4179/) through T3's local browser. The router uses the healthy app slot or falls back to the interactive prototype. [Preview status](http://127.0.0.1:4179/__preview) shows the serving slot, launch SHA, worktree snapshot digest, fixture integrations, and last check. The same status is available as JSON at `/__preview/status`. Open [the prototype](http://127.0.0.1:4179/__preview/prototype) at any time. The bundled `scripts/preview/workflow.html` also opens as a standalone offline file.

## Start and switch slots

Run these from the worktree containing the preview tools. Keep two dedicated linked worktrees for slots A and B. Use a third worktree for the full browser suite so its schema pushes and fixture writes stay independent of both preview slots. `pnpm agent:new` prepares each worktree and assigns its ports.

```bash
pnpm preview:local serve
pnpm preview:local launch a ../ticket-preview-a
pnpm preview:local launch b ../ticket-preview-b
pnpm preview:local status
pnpm preview:local verify
pnpm preview:local rollback
pnpm test:preview
```

Pass a standalone HTML path to `serve` to use an existing offline prototype. `TICKET_PREVIEW_PORT` and `TICKET_PREVIEW_STATE` can select a separate loopback router and state directory when rehearsing. Use the same settings for its controller.

Launch only into the inactive slot. The controller checks for overlapping ports and an active checkout, then configures and verifies the candidate's disposable Convex deployment before pushing the schema. It seeds two Projects, two customers and named staff, builds the Vite bundle against the candidate Cloud and Site URLs with Vite env-file loading disabled, and starts separate app and Convex processes. Playwright signs in from the stable origin and opens a seeded staff Ticket. The customer portal smoke opens a seeded Ticket and submits a synthetic Ticket, with Thai and keyboard actions at 390 px. The controller switches slots only after both browser widths pass and retains the previous app and backend for rollback. A failed launch keeps the serving slot and records the failed stage. `rollback` runs the previous slot's smoke checks at the stable origin before switching back. After an interrupted launch, `pnpm preview:local clear-candidate` drops the interrupted candidate.

To exercise signed LINE replay as part of a launch, pass the name of a local Convex fixture function and an optional browser smoke module.

```bash
pnpm preview:local launch b ../ticket-preview-b line_capture_fixture:seed ./scripts/preview/capture-smoke.mjs
```

The module's default export receives `{ page, context, width, stable, cloud, site, checkWrites }` after the named Owner signs in, once at each width. Pass `-` in place of the fixture function to run a smoke module without LINE capture setup.

## Fixture boundaries

The router, web slots, and both Convex ports listen on loopback. Convex action fetches pass through a loopback proxy that permits only the slot’s Cloud and Site endpoints. Browser smoke allows HTTP and WebSocket traffic only to the stable origin and candidate backend. The preview app sends a restrictive Content Security Policy for active resources and connections. Convex launch settings are restricted to the preview allowlist. LINE refuses non-fixture transport in preview, model calls are disabled, verification messages use the local delivery fixture, and storage uses local Convex. The provider upload paths return unavailable in preview, and media cleanup stays disabled.

Slot state and immutable builds are under the ignored `.preview/` directory. Each successful launch writes a private launch manifest containing the worktree SHA, snapshot digest and runtime ports. Fixture accounts are `owner@local.test` and `staff@local.test` on [staff sign-in](http://127.0.0.1:4179/staff/login), and `alice` and `bob` on [customer sign-in](http://127.0.0.1:4179/customer/login) with the password `local customer passphrase`. The preview is local to the host running the router.
