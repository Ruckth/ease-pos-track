# Screenshot tools for Tickets

**The first release includes resizable circles, an adjustable crop frame, resizable privacy masks and an Eraser.** Keep the existing numbered notes for explaining what happened. Start with a cashier who collected ฿200 on a ฿180 sale and saw ฿0 change. Support needs the three amounts and the cashier’s expected result. The customer’s phone number can stay private.

[Watch the six-step example](./ticket-markup.html#walkthrough) · [Try it on the sample receipt](./ticket-markup.html#practice) · [Read the sources and export evidence](../research/ticket-image-export.md)

## What a user can do

| Tool | Example | Release |
| --- | --- | --- |
| Circle | Tap the wrong ฿0 amount and adjust the oval. The digits stay readable. | First |
| Resize | Select a circle or mask again. Widen it to fit one amount, or make it taller to cover a second line. Circle outline thickness is a separate Thin, Medium or Thick setting. | First |
| Eraser | Remove a misplaced circle even after adding another circle and a phone-number mask. Undo restores the erased circle in place. | First |
| Crop | Keep the total, cash received and change together. Trim the register sidebar. | First |
| Hide details | Cover a customer name or phone number with a solid rectangle. Review the resulting pixels. | First |
| Numbered note | Place “I expected ฿20 change” beside the circled field. Staff can open the same note. | Existing |
| Undo and redo | Recover from a tight crop or misplaced mask before applying edits. | First |
| Arrow | Point to a small control when the oval obscures nearby fields. | Consider after pilot |
| Highlight box | Enclose a complete row of related values. | Consider after pilot |
| Freehand pen | Trace a swipe path when its direction explains the issue. | Defer until observed in Tickets |

Microsoft documents shapes, crop, undo and dedicated text redaction. W3C gives an example of selecting a rectangle with two taps. For this editor, offer fast dragging, an equally complete taps-only path, and keyboard placement. [Microsoft Snipping Tool](https://support.microsoft.com/en-us/windows/apps/use-snipping-tool-to-capture-screenshots) [W3C dragging guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)

## Customer and staff flow

**Add images → Edit image → Mark → Adjust or erase → Review the attachment → Apply edits → Submit Ticket.** Both the thumbnail and the attachment viewer offer **Edit image** for still PNGs and JPEGs. The Ticket preview is optional. Video continues to use timestamp notes.

1. **Place and select.** Tap an amount to place an oval, or tap two opposite corners to set a crop or privacy mask. Keep the new mark selected. Tapping an earlier mark brings its controls back.
2. **Adjust the fit.** Drag a side handle to change width or height independently. Drag a corner to change both. For taps alone or keyboard use, provide labeled Width −/+, Height −/+ and directional move buttons. Use Fit width or zoom to inspect small digits on a long receipt, then pan to the relevant line. The fine adjustment moves a boundary by one source pixel. These controls also adjust the crop frame before Apply. Changing circle thickness preserves the oval’s bounds.
3. **Erase a particular mark.** Choose Eraser, tap the circle or mask, and see the result immediately. Also offer **Remove selected mark** on the selected object and Delete on the keyboard. For overlapping marks, provide a selectable list such as “Circle 1” and “Mask 2”. Removing a mask reveals those pixels in the local edit preview. **Reset crop** restores the session’s full frame. Numbered notes retain their existing edit and delete actions.
4. **Recover and review.** Undo restores an erased mark with its position, size, thickness and stacking order. Redo removes it again. Each completed resize drag is one undo step. Cancel discards the session. Apply flattens the reviewed marks into the draft image. Reopening starts from those pixels, so an applied privacy mask stays permanent. Submit Ticket sends the reviewed attachment.

Use visible text labels, 44 × 44 CSS-pixel toolbar buttons, a visible keyboard focus indicator and a single-pointer alternative for resizing. Check the Thai labels in both composers, including **วงกลม**, **ปรับขนาด**, **ยางลบ**, **ครอบตัด**, and **ปิดบังข้อมูล**. Verify that customers understand when the pixels have been removed from the attachment.

## Implementation sequence

| Order | Deliverable and integration point | Acceptance test before moving on |
| --- | --- | --- |
| 1 | Build a local image editor with source-image coordinates and stable IDs for each circle and mask. Record create, move, resize, outline change and erase operations by mark ID for undo/redo. Keep the crop frame as a separate editable selection. Start with static PNG and JPEG. Use the [shared viewer](../../src/components/media-viewer.tsx) when a draft composer supplies an edit action. Pause carousel swipes during editing. | Pass the resize and Eraser scenarios below with touch, mouse and keyboard. Check portrait photos, rotation, letterboxing and focus restoration. Preserve the existing attachment path for unsupported or animated files. |
| 2 | Render the crop and masks into a fresh image. Check the encoded file, show its actual pixels, and apply it through the [draft owner](../../src/features/tickets/draft.ts). Replace the File, preview URL and pins together by attachment ID and edit revision. Release discarded URLs. | Decode the outgoing image, inspect the crop, mask edges, source metadata and neutral filename. Failures leave the previous draft intact. Reject stale exports after cancellation, removal or a newer edit. Successful output fits the existing 8 MiB limit. |
| 3 | Reproject each [pending pin](../../src/lib/pending-annotations.ts) into the new crop. Subtract the crop origin in oriented source pixels, then divide by crop width and height. Keep the existing attachment ID through reorder. | If a crop excludes a pin, identify its number and let the user expand the crop to include it before Apply. The attachment viewer also supports moving a pin before opening the editor. Preserve the note, its number and existing description references. Test a note on another attachment referenced by “[3]”. |
| 4 | Freeze the whole [submission snapshot](../../src/lib/ticket-submit.ts) on send, including reviewed Files, note text, descriptions and media order. Reconcile an uncertain write using the same request key and snapshot. Give each edited file a neutral per-revision upload name. Disambiguate every colliding attachment slot before creating its first intent, including unchanged images. Keep those upload identities stable across retries. | Simulate a timeout, a partial receipt and two different images with the same original name, byte count and type. Compare the stored bytes for each edited attachment, including when only the second upload was recorded. Verify a single Ticket and correct cover order. |
| 5 | Enable the action for staff and customers in the [shared Ticket composer](../../src/features/tickets/ticket-composer.tsx). Reuse current point/time annotation storage. | Run the local browser workflow with intercepted uploads and inspect the outgoing payload for both composers. Reload a saved Ticket, open its numbered note, and open an older image and video Ticket. |

The draft owner keeps the reviewed bytes, attachment order and request key together while a submission is uncertain. This fixes a failure reproduced during planning. When two different files had the same name, type and size, a partial upload of the second one could cause both attachments to show the second file. A regression test now exercises the partial upload and verifies the content of both slots. [Draft tests](../../tests/ticket_draft.test.ts)

## Release checks for resize and Eraser

| Task | Expected result |
| --- | --- |
| Circle ฿0, return to it after adding another mark, widen it and make the outline thinner. | Width changes independently of height. The selected outline thickness appears in the exported PNG. The other mark stays in place. Repeat with taps alone and by keyboard. |
| Enlarge a mask to cover the last digit of a phone number, then tighten the crop. | The preview and the decoded export cover the last digit at the new mask edge. The crop retains the amounts the user chose. |
| Add circle A, circle B and a mask. Erase A where the two circles overlap, then undo and redo. | The user can target A explicitly. B and the mask survive every step. Undo restores A’s geometry and stacking order. The final export contains only B and the opaque mask. |
| Erase a mask, undo, apply, then reopen. | The number becomes visible during the edit, Undo covers it again, and the reopened attachment contains the covered pixels. A numbered note on the same image keeps its label and position. |

## Evidence and remaining gates

| Evidence | Status |
| --- | --- |
| Walkthrough and practice editor | Passed on Chromium 151, Firefox 153 and WebKit 26.5 at 360 and 820 CSS pixels. Covered reduced motion, pause, replay availability, drag resizing, independent width and height controls, outline changes, individual erasure of overlapping marks, undo/redo, free-text notes and exact restoration of reviewed PNG pixels. No HTTP requests during practice. |
| PNG metadata and crop math | Synthetic Chromium fixture passed all twelve pixel comparisons, stripped the injected text chunk and correctly classified the test pins. |
| Customer and staff composer | Browser workflows cover adding an existing numbered note, resizing a circle, erasing an earlier circle, undoing and redoing, masking details and expanding a crop to retain the note. They decode the review and compare its bytes with the applied attachment. [Browser workflows](../../tests/browser/workflows.test.ts) |
| Export and retries | Real browser encoders and the upload validator check edited images. Draft tests check uncertain submission, correction after definitive rejection, stable attachment order and exact bytes across retries. [Encoder tests](../../tests/browser/encoders.test.ts) · [Draft tests](../../tests/ticket_draft.test.ts) |
| Physical devices and supported formats | Pending. Run on a supported iPhone and Android phone with a long screenshot, a large camera photo, EXIF rotations, JPEG GPS/embedded thumbnails, transparency and an export over 8 MiB. Select output limits based on memory and text legibility. |
| Human comprehension | Pending. The sample supports resize, outline thickness, individual mark removal, undo and a free-text Ticket description. The walkthrough illustrates the numbered note. The pilot can now exercise the correction task. Comprehension of the Thai labels is part of the cashier pilot. |

From the worktree root, run the two standalone checks with the installed Playwright browsers.

```sh
pnpm exec node docs/ux/check-ticket-image-export.mjs
pnpm exec node docs/ux/check-ticket-markup.mjs chromium firefox webkit
```

## Pilot a human can run

Open the **Try it yourself** link on a phone before showing the walkthrough. Give each of five cashiers the same task, using a fresh page for each session.

> A customer paid ฿200 for this ฿180 sale. Prepare an image for support that explains what went wrong and keeps the customer number private.

Observe the first attempt without coaching. Record time to review, whether a preset or custom selection was used, any help requested, and whether the final receipt retains all three amounts and fully covers the number. Ask the cashier how much change they expected and what support can see under the mask. Have a support colleague read only the result and describe the discrepancy. In a separate round, ask participants to complete the task using taps alone and recover from a deliberately misplaced mask. Use the practice editor for a correction task. Ask the cashier to widen an earlier oval around the full amount and remove an extra circle while keeping a later privacy mask. Record whether they can discover and complete both actions without help.

**Proposed pilot gate.** At least four of five cashiers independently prepare a clear attachment within one minute, every shared sample hides the entire customer number, and support identifies ฿0 actual versus ฿20 expected on each successful attempt. For the correction task, at least four of five cashiers should resize and erase without coaching, and every final image must retain the intended privacy mask. Record the first point of confusion and repeat the affected task after revising the tool. This threshold is a product decision. The sample is for finding usability problems, and the recruited participants supply the evidence. [GOV.UK moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing)
