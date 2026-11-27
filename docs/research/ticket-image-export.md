# Evidence for Ticket image editing

## Interaction choices

| Evidence | Decision for the first release |
| --- | --- |
| Windows Snipping Tool exposes shapes, crop, undo and redo in its screenshot editor. Its text actions can redact phone numbers and emails. [Microsoft Support](https://support.microsoft.com/en-us/windows/apps/use-snipping-tool-to-capture-screenshots) | Give Circle, Crop and Hide details visible names. Start with a manual opaque mask that can cover any identifier. |
| Apple Markup supports inserting a shape from a menu and adjusting its size. [Apple iPhone User Guide](https://support.apple.com/guide/iphone/add-text-shapes-stickers-and-more-iphcdb1d0bc7/ios) | Tap once for a starter oval. Keep move and size adjustments available until Apply. |
| W3C describes selecting an image rectangle by tapping opposite corners as an alternative to dragging. Keyboard access addresses a separate user need. [W3C on dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) | Support two corner taps as well as keyboard placement. Our proposed 44-pixel toolbar targets give touch users room on a phone. |
| Moderated usability testing calls for realistic tasks, likely users, and prompts that avoid revealing the solution. [GOV.UK Service Manual](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing) | Start first-time participants in practice mode. Observe the attachment a cashier produces and ask a second person in support to interpret it. |

These precedents support the proposed interactions. The cashier pilot measures whether those interactions work for this particular Ticket flow.

## How to produce the attachment

1. **Use one orientation for display and export.** Decode a supported still image with EXIF orientation applied. Store edit coordinates against that decoded bitmap. Test orientation 3, 6 and 8 with an asymmetric corner mark and a pin. [HTML image bitmap options](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#imagebitmapoptions)
2. **Export a fresh crop bitmap.** Round the mask outwards at the final output resolution and fill it with an opaque color. For scaled exports, cover sensitive source pixels before resampling too, so interpolation cannot carry them across the mask boundary. The HTML canvas serializer encodes the resulting bitmap, can fall back to PNG, and can fail. Check the actual blob MIME type, dimensions and size, then preview those exact bytes. [HTML canvas serialization](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)
3. **Check which information survives.** Use fixtures containing a synthetic phone number in the filename, GPS/EXIF and XMP in a JPEG, or timestamp and text chunks in a PNG. Inspect the actual outgoing file including embedded thumbnails. Allow encoder-added color or resolution data. PNG explicitly defines text, time, color and EXIF chunks. [W3C PNG specification](https://www.w3.org/TR/png-3/) [HTML canvas serialization](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)
4. **Handle large inputs deliberately.** The 8 MiB attachment limit is a compressed-file limit. A 3000 × 20000 RGBA buffer alone takes about 229 MiB. Read dimensions before allocating full-resolution buffers, keep edit history as geometry, and release bitmaps and object URLs on cancel or replacement. Benchmark supported phone models before setting long-edge and total-pixel budgets. Preserve a valid single-color screenshot. [Canvas size limits](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/canvas#maximum_canvas_size) [Bitmap disposal](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close)
5. **Make the output recognizable and reproducible.** Use PNG for screenshots. For larger camera photos, evaluate JPEG with an explicit white background where transparency needs flattening. Name the edited result with a neutral, stable attachment revision and the extension for its actual format. Test null exports, type fallback, a long screenshot and a failed decode.

## What the experiment measured

The [standalone raster test](../ux/check-ticket-image-export.mjs) adds a known text chunk to a synthetic 8 × 6 PNG, crops it to 4 × 3, covers two pixels, serializes it and decodes it again. Chromium 151 reproduced all twelve expected output pixels. The two covered pixels were fully opaque, and the output contained no text chunk or source marker. One test pin landed at (0.5, ⅔) in the crop. Two pins outside its half-open bounds were excluded for resolution by the editor.

The [interactive preview test](../ux/check-ticket-markup.mjs) exercises the HTML sample itself. It decodes the reviewed PNG, checks the circle and every pixel in the 97 × 20 mask, verifies the note and crop dimensions, and checks that the preview makes zero HTTP requests. See the [implementation plan](../ux/ticket-markup-plan.md) for device, real-upload and human pilot gates.
