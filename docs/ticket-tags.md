# Ticket tags

## Data contract

- `ticketTags`: reusable staff-created tags with `name`, `normalizedName`, `color`, `createdBy` (session ID), and `createdAt`.
- `feedback.tagIds?: Id<"ticketTags">[]`: absent means no tags, including all existing Tickets. Stored IDs are deduplicated and sorted; at most 20 per Ticket.
- Names use NFKC normalization, trimmed/collapsed whitespace, and lowercase uniqueness. Display names retain case and Thai text. Names are 1–32 UTF-16 units and cannot contain control/format characters after normalization.
- Colors: `slate`, `red`, `orange`, `green`, `blue`, `violet`.
- Tags are immutable in this release. There is no rename/delete API.

## Staff APIs (`api.feedback`)

- `listTicketTags({ token })` → `{ _id, name, color }[]`, ordered by normalized name. Session attribution is not returned.
- `createTicketTag({ token, name, color })` → `Id<"ticketTags">`. Duplicate normalized names throw `TAG_ALREADY_EXISTS`; the indexed lookup and insert share a Convex transaction.
- `setTicketTags({ token, id, tagIds, expectedVersion })` → `{ eventId, version }`. Replaces the set; checks staff access, active Ticket, current version, size, and tag existence. Unchanged sets return `eventId: null` without a version bump.
- `listFeedback` retains its existing arguments and enriches each Ticket with `tags: { _id, name, color }[]`. `getFeedback` retains the document shape including optional `tagIds`; join against `listTicketTags` when labels are needed.

Assignment writes use `applyTicketChange`: one version increment and a `tags_changed` event with before/after `tagIds`, timestamp, and staff session attribution. Legacy snapshots omit `tagIds`, meaning no tags. Text/status undo preserves current tags and still requires a current version. Stale writes return `VERSION_CONFLICT`; the UI displays the existing localized conflict message and the user can retry against the updated Ticket.

## Reusable UI

- `TicketTag` from `src/lib/types.ts`: public `{ _id, name, color }` shape.
- `Feedback` extends the persisted document with optional hydrated `tags`.
- `TicketTagList({ tags: TicketTag[] })` from `src/components/ticket-tags.tsx`: wrapping, named color badges; renders nothing for an empty set.
- `tagTones` exports the shared accessible light-background color classes.
- `TicketTagEditor({ item: Feedback, token: string })`: staff-only detail section. Creating a reusable tag and assigning it are separate explicit actions. Selected tag buttons have `aria-pressed` and a check mark. Names/colors/errors have Thai and English copy.

## Validation

Actual mutation-handler tests cover staff/customer/session gates, duplicate names, legacy untagged Tickets, multi-tag assignment/removal, missing tags, archived Tickets, no-op assignments, stale versions, and audit snapshots. Browser interaction checks use an isolated local data adapter, with no real Ticket creation: create/color choice, duplicate error, add/remove, board badges, Thai, and mobile overflow. Deployment checks separately verify server schema compatibility.
