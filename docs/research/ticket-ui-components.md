# Ticket workspace component research

Verified **15 November 2026** against maintainer documentation, source repositories, public registry JSON, and this worktree. Research only: no package installation, application edits, preview edits, or commit. Integration effort and UX recommendations below are engineering judgments, not measurements or vendor guarantees. Public demos were read as documentation; their interactions were not browser-tested.

## Recommendation and shortlist

Keep the existing ReUI Kanban and its Ticket move adapter. Compose the workspace around official shadcn Base UI primitives. Start the triage table with the official Data Table recipe; consider ReUI Data Grid or tablecn only when their additional behaviors are needed. Use community blocks to compare compositions, with their individual licenses checked before copying.

| Candidate family | Best use here | Effort judgment | Decision |
| --- | --- | --- | --- |
| [ReUI](https://reui.io/docs/components/base/kanban): Kanban, Data Grid, Filters | Existing board; advanced table and query controls | Low for board styling; medium–high for new grid/filters | Retain board; stage the other two |
| [Official shadcn](https://ui.shadcn.com/docs/components/base/sidebar): Sidebar, Sheet/Drawer, Data Table | Navigation, Ticket detail, triage | Medium: styles, local wrapper APIs, and data adapters | Preferred composition foundation |
| [Dice UI](https://diceui.com/docs/components/base/kanban) | Alternative board interactions and responsive detail patterns | Medium–high if replacing board; medium for selected patterns | Reference selectively |
| [Kibo UI](https://www.kibo-ui.com/components/kanban) | Project-oriented board and grouped list presentation | Medium–high: different state shape and shared primitives | Visual/composition reference |
| [tablecn, formerly shadcn-table](https://github.com/sadmann7/tablecn) | Advanced filters, URL state, denser triage tables | High relative to the current simple workspace | Strong later-stage table option |
| [Shadcnblocks](https://www.shadcnblocks.com/block/application-shell1) | Complete sidebar shell; board/detail composition | Medium for shell; paid board source unverified | Optional shell reference |
| [Shadcn Studio](https://shadcnstudio.com/blocks/dashboard-and-application/kanban-app) | Overview, inbox/detail, and board layouts | Medium–high; selected source/dependencies must be inspected | Inspiration before adoption |

## Local compatibility baseline

The worktree is `agent/ticket-ux-preview`. Its [package manifest](../../package.json) declares React/React DOM `^19.0.0`, Vite `^6.0.5`, Tailwind `^3.4.17`, Base UI `^1.6.0`, dnd-kit core `^6.3.1`, sortable `^10.0.0`, and utilities `^3.2.2`. It has Zod 3 and `tailwind-merge` 2. Neither TanStack Table/Virtual nor `nuqs`, `cn`, or `tunnel-rat` is declared. The installed Base UI package actually resolves to **1.7.0**, and exposes `@base-ui/react/drawer`; the declared range and installed version should not be conflated.

[components.json](../../components.json) uses `new-york`, `rsc: false`, local aliases, and `https://reui.io/r/{style}/{name}.json`. It does not explicitly select a modern Base UI style. Existing components are copied source, not evidence that any newer registry response can safely overwrite them.

The inspected [Kanban](../../src/components/reui/kanban.tsx), [Sortable](../../src/components/reui/sortable.tsx), and [Stepper](../../src/components/reui/stepper.tsx) use Base UI `mergeProps`/`useRender` and the local `cn` helper. Kanban/Sortable use dnd-kit; Stepper does not require another motion library. Preserve Stepper for sequential flows, rather than making Ticket status appear to be a mandatory linear wizard.

The [current board](../../src/components/staff-board.tsx) uses `onMove`, fixed workflow columns, optimistic move reconciliation, expected versions, and separate lane pagination. Below 1024px it mounts only the selected status lane, disables dragging, and offers explicit status actions. Do not mount two boards with duplicate dnd-kit IDs. The [detail view](../../src/features/tickets/staff-ticket-dialog.tsx) currently uses a custom `Dialog` API with a `title` prop; imported shadcn compound examples will require an adapter or deliberate wrapper migration.

## 1. ReUI: strongest continuity, but inspect the live source

**Kanban.** [Docs/demo](https://reui.io/docs/components/base/kanban) and [the configured new-york registry item](https://reui.io/r/new-york/kanban.json) expose a controlled column map, `getItemValue`, `onValueChange`, and `onMove`. The registry declares Base UI, dnd-kit core/sortable/utilities, and **`cn`**. The local implementation instead imports `@/lib/utils`. Preserve the current application’s move ownership and cancellation behavior; do not replace the source merely to match a screenshot.

**Data Grid.** [Current docs/demo](https://reui.io/docs/components/base/data-grid) use **TanStack Table v9**, `useTable`, `tableFeatures`, and ReUI’s `dataGridFeatures`; feature-aware column types take a leading feature-set generic. [Legacy v1 docs](https://v1.reui.io/docs/data-grid) explicitly describe v8. Both [new-york JSON](https://reui.io/r/new-york/data-grid.json) and [base-nova JSON](https://reui.io/r/base-nova/data-grid.json) currently deliver v9-style source. Thus `new-york` does **not** freeze the legacy API. Their dependency names are unversioned: Base UI, dnd-kit including modifiers, TanStack Table/Virtual, and `cn`. Pin compatible versions during any later adoption. The [published TanStack package metadata](https://registry.npmjs.org/@tanstack/react-table/latest) returned 9.3.1 with React `>=18` peer support during this research.

The grid is appropriate if B needs column controls, selection, resizing, or virtualization. It is more integration work than a simple queue. Its registry also pulls several shared shadcn primitives; raw source includes icon placeholders intended for registry processing. A raw file copy requires import resolution. Convex cursor pagination and server filters need explicit adaptation; a grid does not automatically make loaded rows represent the whole Project.

**Filters.** [Docs/demo](https://reui.io/docs/components/base/filters) and [registry source](https://reui.io/r/new-york/filters.json) now provide a multi-file query builder. The actual root API uses `fields`, `query`/`defaultQuery`, `onQueryChange`, and `variant: "basic" | "advanced"`, with inline/popover advanced modes. It is not simply a standalone filter button. Direct dependencies include `class-variance-authority`, `cn`, and `date-fns`; registry dependencies include Cascader and shared popover/menu controls. Start with search, status, and urgency; add advanced expressions only when the Ticket query adapter supports their meaning. On phones, use a dedicated filter surface with a visible active-filter count and reset action.

**Version/style caveat.** ReUI’s [installation guide](https://reui.io/docs/get-started) targets React 19 and **Tailwind 4**. The fetched Kanban already contains trailing-important classes such as `cursor-grabbing!`, which need translation for this Tailwind 3 project. Latest items also use `cn` rather than the local helper, as documented in the [changelog](https://reui.io/docs/changelog). Choose between a bounded source adaptation and a separately scoped Tailwind migration; do not let a component install implicitly choose for us.

**License.** Free public primitives/examples are MIT; Pro blocks, templates, and icons have separate commercial terms. ReUI explicitly distinguishes those scopes in its [license](https://reui.io/legal/license), supported by the public [MIT file](https://github.com/keenthemes/reui/blob/main/LICENSE.md). A free primitive does not grant rights to an entire paid block.

## 2. Official shadcn/ui: preferred shell and detail primitives

Use [Sidebar docs/demo](https://ui.shadcn.com/docs/components/base/sidebar) for A’s persistent navigation and C’s icon rail. `SidebarProvider`, controlled open state, header/footer regions, and collapsible modes provide the composition. The [Base UI registry](https://ui.shadcn.com/r/styles/base-nova/sidebar.json) pulls Sheet, Tooltip, Separator, Skeleton, Input, Button, and the mobile hook, and uses `cn`. Add the required sidebar theme tokens and translate Tailwind 4 syntax. The [official sidebar blocks](https://ui.shadcn.com/blocks/sidebar) are useful complete examples; adapt their layout to Vite rather than copying a Next.js directory structure.

Use [Sheet](https://ui.shadcn.com/docs/components/base/sheet) for a desktop Ticket detail panel. Its [source](https://ui.shadcn.com/r/styles/base-nova/sheet.json) is based on Base UI Dialog. For touch gestures, evaluate [Drawer docs/demo](https://ui.shadcn.com/docs/components/base/drawer): the current Base UI version **uses Base UI Drawer, not Vaul**, confirmed by its [registry source](https://ui.shadcn.com/r/styles/base-nova/drawer.json). The docs call out iOS overlay positioning and scroll-container sizing. A long Ticket with media and activity should get a full-height phone detail surface, visible close action, and preserved edit state. Verify focus restoration, nested media overlays, and keyboard scrolling before replacing the existing dialog.

The [Data Table guide/demo](https://ui.shadcn.com/docs/components/base/data-table) is a recipe built from Table and TanStack, not a turnkey data-table package. **Current official examples also use v9**; older `useReactTable` recipes are not interchangeable. This is the smallest starting point for B because we choose only the table features we need. Replace its sample fetching/pagination with the Ticket adapter. On mobile, render compact Ticket rows with the same query state rather than squeezing every desktop column into view.

The official repository is [MIT licensed](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md). Base UI compatibility still requires checking actual component APIs against the installed package and local wrappers; a matching primitive family alone is insufficient.

## 3. Dice UI: useful interaction references, not a board drop-in

[Dice Kanban docs/demo](https://diceui.com/docs/components/base/kanban) document object-array support, drag handles, configurable sensors, and keyboard movement/cancellation. The [current Base UI source](https://github.com/sadmann7/diceui/blob/main/docs/registry/bases/base/ui/kanban.tsx) uses the same dnd-kit family, but adds `@base-ui/utils/useMergedRefs` and `cn`. Its `onMove` receives a drag event plus indexes; our ReUI contract supplies named source/destination containers. Similar names do not establish compatible semantics.

The [Responsive Dialog](https://diceui.com/docs/components/base/responsive-dialog) automatically chooses a centered desktop dialog and a bottom mobile drawer. It is a useful responsive-state reference, though A/B require a desktop side panel instead. Its [implementation](https://github.com/sadmann7/diceui/blob/main/docs/registry/bases/base/ui/responsive-dialog.tsx) imports several Base UI utility hooks and shared Dialog/Drawer wrappers. The [docs package](https://github.com/sadmann7/diceui/blob/main/docs/package.json) currently develops against Base UI `^1.9.0`; that is evidence of its development environment, not proof every component requires that minimum.

Dice is [MIT licensed](https://github.com/sadmann7/diceui/blob/main/LICENSE). Prefer borrowing an isolated interaction after source review over adding a second Kanban implementation. Keep explicit mobile status changes even if touch dragging is available.

## 4. Kibo UI: good board/list composition, different data ownership

Explore the maintainer’s [Kanban](https://www.kibo-ui.com/components/kanban), [grouped List](https://www.kibo-ui.com/components/list), and [Table](https://www.kibo-ui.com/components/table) demos. The repository now lives at [shadcnblocks/kibo](https://github.com/shadcnblocks/kibo), with an [MIT-form license](https://github.com/shadcnblocks/kibo/blob/main/license.md), separate from the commercial Shadcnblocks catalog.

The [Kanban source](https://github.com/shadcnblocks/kibo/blob/main/packages/kanban/index.tsx) uses a flat data array containing a `column` field and `onDataChange`, rather than our column-map/move adapter. The [registry JSON](https://www.kibo-ui.com/r/kanban.json) adds `tunnel-rat` alongside dnd-kit and shared presentation/scroll primitives. Adopting it requires mapping state, preventing premature server writes during drag, and preserving our rollback logic. Its presence of touch/keyboard sensors does not prove the existing mobile status-tab workflow is reproduced.

Crucially, Kibo’s [Table source](https://github.com/shadcnblocks/kibo/blob/main/packages/table/index.tsx) still uses `useReactTable`; its [package manifest](https://github.com/shadcnblocks/kibo/blob/main/packages/table/package.json) declares **TanStack v8.21.3 and Jotai 2**. Do not combine that source unchanged with a v9 ReUI/shadcn/tablecn table. Use Kibo primarily as a grouped-list and board composition reference for A/B.

## 5. tablecn / shadcn-table: strongest advanced triage reference

The old [sadmann7/shadcn-table URL](https://github.com/sadmann7/shadcn-table) redirects to [tablecn](https://github.com/sadmann7/tablecn). This is a distinct application/registry repository by the Dice maintainer, not a separate extra candidate under its old name. The [live demo](https://www.tablecn.com/) offers client/server modes and plain, advanced, and command filtering. Its documentation links to [Dice Data Table](https://diceui.com/docs/components/base/data-table).

The [registry manifest](https://github.com/sadmann7/tablecn/blob/main/registry.json) declares TanStack Table, `nuqs`, and Zod for the data-table entry. That manifest’s default entry lists Radix paths; explicitly select/review the Base variant rather than assuming the default matches this project. The [Base hook](https://github.com/sadmann7/tablecn/blob/main/src/registry/bases/base/hooks/use-data-table.ts) uses `useTable` and `useQueryStates`. The [application manifest](https://github.com/sadmann7/tablecn/blob/main/package.json) uses TanStack `^9.2.4`, Zod 4, and Base UI `^1.8.0`, plus Next/Drizzle and additional demo infrastructure. Those application dependencies are not all requirements for extracting the table.

For Vite, `nuqs` has an official [React SPA adapter](https://nuqs.dev/docs/adapters), so URL state is feasible without adopting Next.js. Still review Zod 3 compatibility, parser behavior, Convex queries, pagination, and query resets when switching Projects. Choose this for B if saved/shareable filter state and advanced controls justify the integration. Keep phone filters in a larger surface and turn dense table rows into compact Ticket summaries. License: [MIT](https://github.com/sadmann7/tablecn/blob/main/LICENSE.md).

## 6–7. Community blocks: useful compositions with distinct terms

**Shadcnblocks.** [Application Shell 1](https://www.shadcnblocks.com/block/application-shell1) is explicitly free and includes a collapsible sidebar, grouped navigation, breadcrumbs, and account footer: a useful A/C reference. [Kanban 1](https://www.shadcnblocks.com/block/kanban1) is explicitly **Pro**, with status filtering, drag behavior, and a creation Sheet. Its documented narrow-screen behavior is sideways column scrolling, which differs from our single-status phone layout. The site lists Base UI support, but paid source dependencies were not inspected. Shell adoption is medium effort; board adoption would still need Ticket state and mobile adaptation.

Free does **not** mean MIT here: [free-block terms](https://www.shadcnblocks.com/terms) allow use in end products, including commercial ones, while restricting standalone redistribution. Paid assets follow a separate [license](https://www.shadcnblocks.com/license), including restrictions on publishing component source. Prefer the official MIT Sidebar unless the additional shell composition clearly saves work.

**Shadcn Studio.** Relevant demos are [Kanban App](https://shadcnstudio.com/blocks/dashboard-and-application/kanban-app), [Inbox App](https://shadcnstudio.com/blocks/dashboard-and-application/inbox-app), and [Datatable Advanced](https://shadcnstudio.com/blocks/datatable/datatable-advanced). They offer useful board, list/detail, and overview compositions for A/B/C. The inspected Kanban examples are labeled **Pro**. The [application-block documentation](https://shadcnstudio.com/blocks/dashboard-and-application/application-block) explicitly describes static application compositions requiring application behavior and backend integration. Do not infer Convex support or tested phone interactions from a preview.

The [license page](https://shadcnstudio.com/license) and [repository license](https://github.com/themeselection/shadcn-studio/blob/main/LICENSE.md) include MIT wording **plus Commons Clause restrictions**. Describe the free material as source-available with restrictions, not unqualified permissive MIT. Paid blocks/templates have separate terms. Exact paid dependency versions remain unverified; inspect the chosen item before estimating implementation. No purchase or paid source access was attempted.

## Applying this to the existing A/B/C preview

These labels and behaviors come from the original A/B/C HTML prototype reviewed on 15 November. The [delivered workspace preview](../ux/tackle-issue-preview.html) uses the selected Workspace direction.

| Direction | Concrete recommendation | Mobile implication |
| --- | --- | --- |
| **A · Workspace** | Preferred everyday default. Keep ReUI Kanban; add official Sidebar, compact filter controls, and a right-hand Ticket Sheet. Keep board/table switching within one query state. | Preserve status tabs and explicit moves; hide/collapse navigation; open detail at full width. |
| **B · Triage** | Table-first, no persistent sidebar, as previewed. Start with official Table/TanStack v9; use tablecn when URL-driven advanced filters become a requirement, or ReUI Data Grid when richer grid behaviors are required. | Replace wide columns with compact Ticket rows. Keep search and sort accessible, with filters in a larger surface. |
| **C · Overview** | Reuse A’s board/detail/query components, with official Sidebar in icon mode and a small set of meaningful counts. Studio/block catalogs can inform spacing and composition. | Keep only actionable counts; avoid letting summary panels push Tickets below the first screen. Icon navigation needs accessible labels. |

All three should use the same authorized Ticket query/mutation adapters. Count labels must distinguish total results from loaded rows. A filter must not merely hide loaded rows while claiming to search an entire Project. Preserve Thai/English wording, real status values, urgency semantics, keyboard access, and pending/conflict states. These are integration requirements inferred from the current application, not capabilities supplied by the component libraries.

## Staged adoption

1. **Composition first:** adopt A’s shell/detail direction while retaining existing Kanban, mobile status behavior, and backend operations. Use existing primitives for the first search/status/urgency toolbar. No grid library is needed to validate layout preferences.
2. **A focused table:** implement B with one chosen TanStack major and the minimum required features. Add an explicit Convex data adapter and a compact mobile presentation. Avoid mixing Kibo v8 source with current v9 recipes.
3. **Advanced controls only when justified:** choose ReUI Data Grid for grid capabilities, or tablecn for its table/filter/URL-state composition. Evaluate ReUI Filters as a query UI only after defining supported server operators. Do not install both table stacks by default.
4. **Compatibility review before copying:** record the exact source revision/registry response; resolve Base UI versus Radix; inspect shared primitive overwrites; translate Tailwind 4 classes or approve a separate migration; review `cn`, Zod, and URL-state dependencies. Recheck touch scrolling, focus, keyboard moves, detail edits, and concurrent updates after actual implementation.

Broader primary-source discovery: [official shadcn registry directory](https://ui.shadcn.com/docs/directory), [official blocks](https://ui.shadcn.com/blocks/sidebar), [ReUI catalog/docs](https://reui.io/docs), [Dice repository](https://github.com/sadmann7/diceui), [Kibo repository](https://github.com/shadcnblocks/kibo), [Shadcnblocks application shells](https://www.shadcnblocks.com/blocks/application-shell), and [Shadcn Studio block catalog](https://shadcnstudio.com/blocks). Use these to find candidates, then verify the individual source and license; catalog membership is not a compatibility guarantee.

## Validation

`pnpm check` passed in this worktree on 15 November 2026: typecheck, **250 unit tests**, **109 Convex tests across 11 files**, and the production Vite build, all exit 0. The build emitted a non-failing warning about chunks above 500 kB. No browser tests were run, and no new library integration was exercised. This validates the repository baseline during research, not compatibility of components that have not been installed.
