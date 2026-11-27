# Screenshot tools for Tickets

**Ship Circle, Crop and Hide details in the draft image editor.** Keep the existing numbered notes for explaining what happened. Start with a cashier who collected ฿200 on a ฿180 sale and saw ฿0 change. Support needs the three amounts and the cashier’s expected result. The customer’s phone number can stay private.

[Watch the four-step example](./ticket-markup.html) · [Try it on the sample receipt](./ticket-markup.html#practice) · [Read the sources and export evidence](../research/ticket-image-export.md)

## What a user can do

| Tool | Example | Release |
| --- | --- | --- |
| Circle | Tap the wrong ฿0 amount and adjust the oval. The digits stay readable. | First |
| Crop | Keep the total, cash received and change together. Trim the register sidebar. | First |
| Hide details | Cover a customer name or phone number with a solid rectangle. Review the resulting pixels. | First |
| Numbered note | Place “I expected ฿20 change” beside the circled field. Staff can open the same note. | Existing |
| Undo and redo | Recover from a tight crop or misplaced mask before applying edits. | First |
| Arrow | Point to a small control when the oval obscures nearby fields. | Consider after pilot |
| Highlight box | Enclose a complete row of related values. | Consider after pilot |
| Freehand pen | Trace a swipe path when its direction explains the issue. | Defer until observed in Tickets |

Microsoft documents shapes, crop, undo and dedicated text redaction. W3C gives an example of selecting a rectangle with two taps. For this editor, offer fast dragging, an equally complete taps-only path, and keyboard placement. [Microsoft Snipping Tool](https://support.microsoft.com/en-us/windows/apps/use-snipping-tool-to-capture-screenshots) [W3C dragging guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)

## Customer and staff flow

**Add images → Edit image → Apply → Review Ticket → Submit Ticket.** Editing is optional for pasted, uploaded and camera images. Inside the editor, tap to place a circle and use move/resize controls to adjust it. Crop and Hide details accept two opposite corner taps. Undo, redo and cancel stay available until Apply. After Apply, reopening starts from the edited image. Only Submit Ticket uploads it. Video continues to use timestamp notes.

Use visible text labels, 44 × 44 CSS-pixel toolbar buttons, a visible keyboard focus indicator and a single-pointer alternative for resizing. Check the Thai labels in both composers, including **วงกลม**, **ครอบตัด**, and **ปิดบังข้อมูล**. Verify that customers understand when the pixels have been removed from the attachment.

## Implementation sequence

| Order | Deliverable and integration point | Acceptance test before moving on |
| --- | --- | --- |
| 1 | Build a local image editor with source-image coordinates, edit history, tool selection, undo/redo and cancel. Start with static PNG and JPEG. Use the [shared viewer](../../src/components/media-viewer.tsx) when a draft composer supplies an edit action. Pause carousel swipes during editing. | Repeat the same selection using touch, mouse and keyboard. Check portrait photos, rotation, letterboxing and focus restoration. Preserve the existing attachment path for unsupported or animated files. |
| 2 | Render the crop and masks into a fresh image. Check the encoded file, show its actual pixels, and apply it through the [draft owner](../../src/features/tickets/draft.ts). Replace the File, preview URL and pins together by attachment ID and edit revision. Release discarded URLs. | Decode the outgoing image, inspect the crop, mask edges, source metadata and neutral filename. Failures leave the previous draft intact. Reject stale exports after cancellation, removal or a newer edit. Successful output fits the existing 8 MiB limit. |
| 3 | Reproject each [pending pin](../../src/lib/pending-annotations.ts) into the new crop. Subtract the crop origin in oriented source pixels, then divide by crop width and height. Keep the existing attachment ID through reorder. | If a crop excludes a pin, offer to expand the crop or reposition the pin before Apply. Preserve the note, its number and existing description references. Test a note on another attachment referenced by “[3]”. |
| 4 | Freeze the whole [submission snapshot](../../src/lib/ticket-submit.ts) on send, including reviewed Files, note text, descriptions and media order. Reconcile an uncertain write using the same request key and snapshot. Give each edited file a neutral per-revision upload name. Disambiguate every colliding attachment slot before creating its first intent, including unchanged images. Keep those upload identities stable across retries. | Simulate a timeout, a partial receipt and two different images with the same original name, byte count and type. Compare the stored bytes for each edited attachment, including when only the second upload was recorded. Verify a single Ticket and correct cover order. |
| 5 | Enable the action in the [customer wizard](../../src/features/tickets/customer-ticket-wizard.tsx) and [staff composer](../../src/features/tickets/staff-composer.tsx). Reuse current point/time annotation storage. | Run the local browser workflow with intercepted uploads and inspect the outgoing payload for both composers. Reload a saved Ticket, open its numbered note, and open an older image and video Ticket. |

The current draft owner releases its submit lock in a finally block, and the upload path matches files using name, size and type. A timeout can therefore leave an uncertain write at the same time that another edit becomes possible. The fourth step is a prerequisite for enabling markup in the live Ticket flow. In a local experiment using the real submission function and an in-memory upload service, two distinct files A/B with the same name, type and length produced B/B when only B had previously uploaded. With distinct upload names the same scenario produced A/B. Carry this case into the regression suite. Existing attached receipts still require same-key reconciliation.

## Evidence and remaining gates

| Evidence | Status |
| --- | --- |
| Walkthrough and practice editor | Passed on Chromium 151, Firefox 153 and WebKit 26.5 at 360 and 820 CSS pixels. Covered reduced motion, pause, replay availability, click and keyboard selection, undo/redo, free-text notes, reviewed PNG dimensions, the circle and every pixel in the mask. No HTTP requests during practice. |
| PNG metadata and crop math | Synthetic Chromium fixture passed all twelve pixel comparisons, stripped the injected text chunk and correctly classified the test pins. |
| Existing Ticket submit tests | All ten existing tests passed. The separate partial-upload experiment reproduced the B/B substitution. End-to-end coverage for the corrected editor flow belongs to implementation. |
| Physical devices and supported formats | Pending. Run on a supported iPhone and Android phone with a long screenshot, a large camera photo, EXIF rotations, JPEG GPS/embedded thumbnails, transparency and an export over 8 MiB. Select output limits based on memory and text legibility. |
| Human comprehension | Pending. The practice editor uses one synthetic receipt, fixed-size ovals, and a free-text Ticket description. The walkthrough illustrates the numbered note. The live editor still needs adjustable shapes, integration with existing pins, and Thai usability testing. |

From the worktree root, run the two standalone checks with the installed Playwright browsers.

```sh
pnpm exec node docs/ux/check-ticket-image-export.mjs
pnpm exec node docs/ux/check-ticket-markup.mjs chromium firefox webkit
```

## Pilot a human can run

Open the **Try it yourself** link on a phone before showing the walkthrough. Give each of five cashiers the same task, using a fresh page for each session.

> A customer paid ฿200 for this ฿180 sale. Prepare an image for support that explains what went wrong and keeps the customer number private.

Observe the first attempt without coaching. Record time to review, whether a preset or custom selection was used, any help requested, and whether the final receipt retains all three amounts and fully covers the number. Ask the cashier how much change they expected and what support can see under the mask. Have a support colleague read only the result and describe the discrepancy. In a separate round, ask participants to complete the task using taps alone and recover from a deliberately misplaced mask. Observe resizing on the integrated editor.

**Proposed pilot gate.** At least four of five cashiers independently prepare a clear attachment within one minute, every shared sample hides the entire customer number, and support identifies ฿0 actual versus ฿20 expected on each successful attempt. Record the first point of confusion and repeat the affected task after revising the tool. This threshold is a product decision. The sample is for finding usability problems, and the recruited participants supply the evidence. [GOV.UK moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing)
