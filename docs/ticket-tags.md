# Ticket tags

## Data contract

- `ticketTags`: reusable staff-created tags with `name`, `normalizedName`, `color`, `createdBy` (session ID), and `createdAt`. The catalogue holds at most 200 tags so it is always one bounded read; creating more throws `TAG_LIMIT_REACHED`.
- `tickets.tagIds?: Id<"ticketTags">[]`: absent means no tags. Stored IDs are deduplicated and sorted; at most 20 per Ticket.
- Names use NFKC normalization, trimmed/collapsed whitespace, and lowercase uniqueness. Display names retain case and Thai text. Names are 1–32 UTF-16 units and cannot contain control/format characters after normalization. Rules live in `shared/tag-rules.ts`.
- Colors: `slate`, `red`, `orange`, `green`, `blue`, `violet`.
- Tags are immutable in this release. There is no rename/delete API.

## Staff APIs (`api.tickets`, staff policy)

- `listTicketTags({ token })` → `{ _id, name, color }[]`, ordered by normalized name. Session attribution is not returned.
- `createTicketTag({ token, name, color })` → `Id<"ticketTags">`. Duplicate normalized names throw `TAG_ALREADY_EXISTS`; the indexed lookup and insert share a Convex transaction.
- `setTicketTags({ token, id, tagIds, expectedVersion })` → `{ eventId, version }`. Replaces the set; checks staff access, active Ticket, current version, size, and tag existence. Unchanged sets return `eventId: null` without a version bump.
- Ticket summaries (`pageTickets`, `searchTickets`) and details (`getTicket`) carry `tagIds` only. Staff resolve names against `listTicketTags`, so paginated reads stay bounded and customers never receive tag names.

Assignment writes use `applyTicketChange`: one version increment and a `tags_changed` event with before/after `tagIds`, timestamp, and staff session attribution. Snapshots without `tagIds` mean no tags. Stale writes return `VERSION_CONFLICT`.

## Reusable UI

- `TicketTag` from `src/lib/types.ts`: public `{ _id, name, color }` shape.
- `TicketTagsProvider` / `useTicketTags` from `src/components/ticket-tags.tsx`: the staff workspace provides the catalogue (via `useTicketTagCatalogue` in the Tickets adapter); `undefined` while loading or for customers.
- `TicketTagList({ ids })`: wrapping, named color badges resolved from the provider; renders nothing for an empty set.
- `TicketTagEditor({ item, onCreate, onAssign })`: staff-only detail section wired through `useTagAdapter`. Creating a reusable tag and assigning it are separate explicit actions. Selected tag buttons have `aria-pressed` and a check mark. Names/colors/errors have Thai and English copy.

## Validation

`tests/convex/ticket-tags.test.ts` covers staff/customer/session gates, duplicate names, legacy untagged Tickets, multi-tag assignment/removal, missing tags, archived Tickets, no-op assignments, stale versions, and audit snapshots. Browser interaction checks use an isolated local data adapter, with no real Ticket creation: create/color choice, duplicate error, add/remove, board badges, Thai, and mobile overflow. Deployment checks separately verify server schema compatibility.
