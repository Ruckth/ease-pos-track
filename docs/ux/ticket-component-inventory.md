# Ticket component inventory

Maps each of the 57 examples in the revised component gallery to its production
owner, whether it is **live** (rendered by a routed screen) or **gallery-only**
(a presentation sample with no production caller), and the check that covers it.
The gallery is a visual reference: routed forms keep their own labels, choices,
validation and server contracts, and nothing here adds counts, capabilities or
provider integrations that the product does not have.

Design base: flat, low-border surfaces in the customer light and staff dark
themes (`src/index.css`). Surfaces group content with fills and soft elevation;
their borders are transparent so forced-colors mode still draws them. Table and
list dividers, focus rings, errors and media/drop-zone boundaries keep visible
lines. The glass recipe survives only as the unused `.surface-glass` class and
the annotation marker/popover, for a later explicit appearance choice.

Check keys: **C** `tests/browser/components.test.ts` (mounted harness,
`tests/browser/components.html`), **W** `tests/browser/workflows.test.ts` or
`tests/browser/workflows-composer.test.ts`,
**A** `tests/browser/accessibility.test.ts`, **R** `tests/browser/routing.test.ts`,
**X** `tests/browser/explorer-check.mjs`, **E** `pnpm test:explore`,
**V** `pnpm test:visual`, **S** before/after screenshots
(`EVIDENCE_LABEL=after pnpm test:browser --grep evidence`).

## Controls & navigation

| Example | Owner | Disposition | Check |
| --- | --- | --- | --- |
| Buttons | `ui/button` | Live. Compact 32 px (`sm`), standard 36 px, `touch`/`icon-touch` 44 px; fills replace outlines | W staff/customer compose submit, A keyboard creation |
| Icon buttons & tooltip | `ui/button` + `ui/tooltip` | Live (detail copy/edit, media controls) | A media dialog, W detail actions |
| Button group | `ui/button-group`, ReUI filter chips, `StaffViewSwitcher` | Live | W view restore, X filter chips |
| Wordmark & header | `product-wordmark`, `staff-workspace-navigation`, customer header | Live | W phone surfaces 320/390, S queue |
| Project switcher | `project-controls` `ProjectSwitcher` | Live. Single-choice Base UI menu (radio items, Create Project separate); plain label for one Project | C three→two, keyboard, 8 px bounds at 320–1280 from both edges; W real two→one revocation and draft retention |
| Account & language | customer account menu, staff overflow, `language-menu` | Live. Base UI menus; language is a labelled radio group | W sign-out with draft, account dialog; S menu |
| Action dropdown | `ui/dropdown-menu`, `ticket-row-action` | Live | X table row action, status menu |
| Popover | `ui/popover` | Live (explorer filters); 8 px collision inset | X filter builder, W explorer filters |
| Badges, tags & status dots | `ui/badge`, `ticket-tags`, `ticket-status-dot` | Live | C five shaped marks, forced colors, grayscale |
| Surface, separator & scroll area | `ui/card`, `ui/separator`, `ui/scroll-area` | Live | W phone surfaces, A axe scans |

## Inputs, filters & forms

| Example | Owner | Disposition | Check |
| --- | --- | --- | --- |
| Text input & search | `ui/input`, customer search | Live. Filled field, full row on phones | W customer search and detail return |
| Textarea & validation | `ui/textarea`, `composer-validation` | Live; `aria-invalid` draws the error boundary. The gallery's required-description message is illustrative | A keyboard validation recovery |
| Password & visibility | `auth-screens` | Live | W customer sign-in, account password change |
| Select & checkbox | `ticket-routing-fields` | Live (native selects kept for real choices) | R classification |
| Numeric & range inputs | explorer `UrgencyEditor`, `ticket-detail-edit` | Live; generic unmounted number/range variants are gallery-only | X urgency range, W detail edit |
| Filter chips & status picker | `customer-portal` status filter, explorer chips | Live | W customer filters, X chips |
| Cascading picker | `reui/cascader`, filter builder | Live | X filter builder |
| Advanced filter builder | `reui/filters` | Live | X advanced rules |
| Tag editor | `ticket-tag-editor` | Live | W tag assignment |
| Ticket wizard & stepper | `reui/stepper` | **Gallery-only** three-step illustration. Live entry stays the single-form `customer-ticket-wizard` + `TicketComposer` | W create/resume/discard |

## Ticket views & workflow

| Example | Owner | Disposition | Check |
| --- | --- | --- | --- |
| Mobile Ticket row | `customer-ticket-row` | Live. Below 640 px one shaped status mark, title, number and facts; from 640 px written status and excerpt | C 320/390/639/640 light+dark, accessible name, focus; S queue |
| Staff board & sortable lane | `staff-board`, `reui/kanban`, `reui/sortable` | Live | W board moves, V board |
| Ticket table & row action | `ticket-table`, `ticket-row-action` | Live | X table, V table |
| Ticket explorer | `ticket-explorer` | Live | X explorer |
| Ticket detail & metadata | `ticket-detail-panel`, `ticket-created-date` | Live | W detail, S detail |
| Composer & draft recovery | `use-composer`, staff composer | Live | W Project switch keeps draft, E draft exploration |
| Conversation & reply | `ticket-conversation` | Live | W customer reply / staff question |
| Status history & activity | `ticket-history`, `ticket-activity` | Live | W history |
| Inbox & unread item | `ticket-inbox` | Live | W inbox |
| Archived Ticket & restore | `archived-ticket-dialog` | Live | A archived details, X archives |

## Media & annotations

| Example | Owner | Disposition | Check |
| --- | --- | --- | --- |
| Upload field & file picker | `media-upload` | Live | W draft media, E |
| Upload progress & completion | `ui/progress`, `media-upload` | Live | W upload cancel/sign-out |
| Camera capture | `camera-capture-dialog` | Live | W camera teardown and focus |
| Image viewer & carousel | `media-viewer`, `media-slides`, `ui/carousel` | Live | A media dialog |
| Video viewer | `media-slides` `VideoSlide` | Live | W video pin |
| Annotation marker & popover | `annotation-overlays` | Live (keeps the glass recipe as an elevated surface) | W pointer pin removal |
| Annotation editor & activity | `annotation-notes`, `annotation-activity` | Live | W annotation edit |
| Attachment list & removal | `media-upload` | Live | E remove with pins |

## Dialogs, notifications & states

| Example | Owner | Disposition | Check |
| --- | --- | --- | --- |
| Edit dialog | `ticket-detail-edit`, `ui/dialog` | Live; dialogs return focus to a mounted opener or `[data-dialog-return-focus]` | W edit undo, A focus |
| Destructive confirmation | `discard-ticket-draft`, `ui/alert-dialog` | Live | W discard after revocation |
| Success notification & Undo | `ui/sonner` `AppToaster`, `operationNotices` | Live. Neutral surface, coloured icon; each Undo bound to its own change; `useCurrentProject` dismisses on Project change | C two independent Undo actions (light, dark); S toast |
| Information, warning & error | `AppToaster` + localized callers | Live | W status announcements |
| Spinner & loading | `ui/spinner`, loading states | Live | W pending states |
| Empty results & search reset | `customer-portal`, `ticket-explorer` | Live | W unmatched search / show all |
| Unavailable Project & error recovery | `error-boundary`, `ProjectUnavailable` | Live | W revoked Project |
| Retained draft & retry | `use-composer` | Live | W sign-out waits for cancel |

## Accounts, Projects & operations

| Example | Owner | Disposition | Check |
| --- | --- | --- | --- |
| Staff & customer sign-in | `auth-screens` | Live (simplified gallery sign-in is gallery-only) | W sign-in flows |
| Join, invite & recovery | `auth-screens`, `privacy-notice-link` | Live | W join, recovery |
| Pending access & recovery codes | `PendingIdentityPage`, `RecoveryCodePanel` | Live; codes stay masked by the existing flow and are redacted from evidence | W recovery code |
| Account settings | `account-dialogs` | Live | W account dialog |
| Create Project | `NewProjectDialog` | Live; reachable only for an Owner with legacy tools | C Create Project distinct action |
| Members, team & invitations | `project-controls`, `account-dialogs` | Live; Owner edits, Staff view | W team dialog |
| Assignment & availability | `ticket-assignment`, `routing-workspace` | Live | R routing |
| Routing fields & local rules | `ticket-routing-fields`, `routing-settings` | Live | R rules |
| Routing suggestions & review | `routing-suggestions` | Live | R review |
| Operations health & retry | `staff-health` | Live; requeue confirmation kept | W, A operations health |
| T3 Code connection | `connect-t3-code` | Live; secrets masked | W T3 settings |

Gallery-only overall: the three-step wizard illustration, generic unmounted
number/range editors, sample data, synthetic action menus, simplified sign-in,
sample media, demo language text and the preview Flat/Glass and Light/Dark
controls.

## Access gates kept in the staff menu

New Project: Owner and `legacyToolsEnabled`. Team: Owner. Members: a current
Project (editing Owner-only inside the dialog). Health: `legacyToolsEnabled`.
Routing trigger: `current && routingAvailable`; its dialog `project && routing`.
T3: `t3Available`. The customer menu holds only account, language and sign-out.
