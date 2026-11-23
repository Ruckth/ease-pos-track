# Image uploads for Tickets and hosted pages

Ease POS uses browser canvas, orientation-aware decoding and product-specific bounds. Its newer ingest implementation uses sharp to validate uploaded bytes and its browser implementation can load a WebP WASM fallback. Ticket uploads reuse contain-fit, byte limits and encoder capability checks. The Ticket screenshot keeps its aspect ratio and alpha. [Compared Ease checkout][old-client] · [Ease POS browser source][client] · [Ease POS ingest][ingest]

## Where to encode

| Option | Fit for Ticket publishing |
| --- | --- |
| Native canvas | First choice for an optional still-image transform before upload. Use `toBlob`, check its actual type and size, and fall back to the validated original when the encoder fails or grows the file. Browsers can return PNG for unsupported output types. A worker using `OffscreenCanvas.convertToBlob` moves drawing and encoding off the UI thread. Feature-detect both APIs. [HTML canvas standard][canvas] |
| Sharp/libvips | Best fit for Node CLI preprocessing or a bounded server ingest action when every caller needs the same decoding policy. Check dimensions and frame count, cap decoded pixels and concurrent jobs, and require a successful decode. Header metadata alone does not read the compressed pixel data. Budget for native dependencies and server CPU. Server-only encoding saves storage and delivery bytes after the original upload. [Sharp][sharp] · [Input metadata][metadata] · [Decoder limits][limits] · [Convex runtimes][runtimes] |
| WASM codec | Useful when a required output codec is missing from native canvas. Load only the needed codec on demand in a worker. This adds a module download, initialization and a pixel buffer. For optional compression, retaining a valid original avoids that cost. [Ease fallback][client] · [jSquash codec packages][wasm] |

## Selected implementation

- **Browser.** Prepare before uploading. For larger sources, run native encoders in a worker where supported. Keep processing sequential and cache the prepared File for selection retries. Local drafts use object URLs for immediate previews. The canvas encoder's returned MIME type determines whether the browser supports a candidate.
- **Node.** Use sharp/libvips for the CLI and the direct HTTP fallback. Normalize orientation before fitting within 1920 × 1080. Compare JPEG, WebP and AVIF with a lossless baseline at the resized resolution. Never send transparent pixels through JPEG. An already small clean PNG, WebP or JPEG can win. When JPEG metadata can be removed without changing the displayed pixels, compare that smaller JPEG as well. A candidate must both reduce bytes and pass a per-pixel comparison against the reference. This conservative test can favor lossless output on fine text or high-contrast edges.
- **Validation.** Check dimensions before allocating the raster, constrain input bytes and decoded pixels, and validate prepared image bytes on the server. UploadThing callbacks verify provider bytes before recording the receipt. Failed verification uses existing ownership-guarded cleanup; transient provider reads remain retryable. [Sharp input options][limits] · [OWASP][owasp]
- **HTML.** Keep authored filenames and relative paths. Store the detected media type separately. For UTF-8 HTML, use parser source offsets to replace literal base64 raster image sources. Scripts, URLs, CSS and other author content remain intact. Packaged assets also work from nested folders. The PNG fallback preserves exact UI pixels when no smaller supported browser encode meets the quality threshold.
- **Larger pages.** When a payload exceeds the inline budget for a Convex Node action, pass bounded private database chunks between runtimes. Reading consumes each chunk. An interrupted transfer expires after 15 minutes. The published bundle retains its existing 10 MiB limit. [Convex runtimes][runtimes]
- **Caching.** Store optimized bytes once, and honor revalidation using a private ETag on hosted images. Every conditional request rechecks the Ticket and publication state, including revoked links, before returning 304. HTML remains no-store. [HTTP caching][cache]
- **Boundaries.** Full HD means at most 1920 pixels wide and 1080 high, including portrait images. Animations are never intentionally flattened. Large APNG and animation formats without a supported multi-frame encoder can be rejected. ICO containers retain their variants; resizing icons as a single raster would discard them. Color information required for display can remain; still encoders drop camera EXIF, GPS and descriptive metadata. Perceptual checks at the target resolution cannot recover detail lost when downsizing an unusually large screenshot.

The nine-screenshot Thai sample went from 1,400,891 to 943,879 bytes through the CLI (32.6% smaller). Chromium produced 1,399,051 bytes for the same file. Its smaller lossy candidates failed the pixel comparison, so it retained the JPEG pixels and removed their metadata. Savings depend on the available codecs and source images.

[old-client]: https://github.com/atiz-official/ease-international/blob/5d312f2a695a2c9f36bc03361d3779c7be7f3fee/src/lib/image-upload.ts
[client]: https://github.com/atiz-official/ease-international/blob/3ae2853b1cefaf9327ba4727d4e29088f08ff884/src/lib/image-upload.ts
[ingest]: https://github.com/atiz-official/ease-international/blob/3ae2853b1cefaf9327ba4727d4e29088f08ff884/src/lib/drease/media-ingest.ts
[canvas]: https://html.spec.whatwg.org/multipage/canvas.html
[sharp]: https://sharp.pixelplumbing.com/
[metadata]: https://sharp.pixelplumbing.com/api-input/#metadata
[limits]: https://sharp.pixelplumbing.com/api-constructor/
[runtimes]: https://docs.convex.dev/functions/runtimes
[wasm]: https://github.com/jamsinclair/jSquash
[owasp]: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
[png]: https://www.w3.org/TR/png-3/#apng-frame-based-animation
[webp]: https://developers.google.com/speed/webp/docs/riff_container
[cache]: https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5
