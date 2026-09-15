# Ticket explorer

Staff can switch between Board and Table without losing search or filters. Both consume the same filtered set. Each filter is ANDed with search and other filters; within one tags/status filter, any selected value matches. Separate tag filters can express “has A AND has B”. Chip menus support removal, duplication and negation. Clear all clears search and filters.

Created/updated ranges include both entire dates in the browser's local timezone, using next-day calendar arithmetic (including daylight-saving changes). Incomplete editor drafts do not filter. Urgency is read-only: existing 1–100 scores can be filtered inclusively; Unset matches absent scores and sorts last in either direction. This change does not calculate or edit urgency.

Table columns sort before pagination, with deterministic ID tie-breaking. Rows per page are 10/25/50. Criteria changes reset the page; live data shrinkage clamps it. Table pagination never feeds the Board: all matching active Tickets remain available for status counts and drag operations. Board preserves its existing status/workflow order. Showing archives adds archived matches to the table and to the existing separate board archive section.

## Scale and authorization

This retains the existing staff-only `listFeedback` subscription and client filtering. `listTicketTags` is also staff-only. No customer queries or server authorization changed. Pagination reduces rendered table rows, **not** downloaded data: `listFeedback` still collects all Tickets and hydrates tags. This is appropriate for the existing internal board scale, but is not server pagination. If data volume becomes material, introduce indexed server filtering/search plus a separate board aggregation query; don't paginate the board subscription itself.

## Registry provenance

- `@reui/c-table-14`: semantic shadcn Table, Ticket ID/title/tag/status composition, adapted to required columns and sorting.
- `@reui/c-filters-6`: Filters/query primitives with custom date and numeric range editors; urgency edits a draft and applies explicitly, as in the example. Demo data and IconPlaceholder imports are removed.
- `@reui/c-pagination-15`: page summary, numbered pages with ellipsis and per-page select, adapted to Button controls with disabled boundaries and localized accessible names. Its `native-select` registry dependency is unavailable for `new-york`, so this uses a native select styled consistently with the app.

The CLI's generated filter source expects Base UI while new-york dependencies resolved to Radix. New popover/menu/tooltip primitives use the shadcn Base UI source (base-nova); existing customized primitives are retained. Tailwind 4 spellings are adapted to Tailwind 3, and the existing popover CSS variables are registered as theme colors. Unused demo dependencies are removed.

## Verification

`pnpm test` covers combined filters/search, inclusive dates, negation, sorting, pagination/clamping, and unset urgency. `pnpm run typecheck` and `pnpm run build` cover integration. The browser fixture uses only local sample Tickets and makes no backend writes:

1. `pnpm exec vite --host 127.0.0.1 --port 5193`
2. `pnpm exec node tests/browser/explorer-check.mjs`

The browser checks table/board switching, tags and status filters, dates and urgency, page sizes, live shrinking, sorting, archives, details callback, Thai, keyboard controls, and mobile overflow.
