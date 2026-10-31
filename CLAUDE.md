# Offline PDF Editor

Browser-only PDF editor: plain ES modules, no build step, no npm dependencies.
Keep it simple: the user wants "as simple as possible but does the work".

## Run

`python3 serve.py` → http://localhost:8765 (port is the optional first arg).
`serve.py` also serves `/api/font` (local fonts first, then Google Fonts, cached in `fonts/cache/`;
uses `fontresolver.py` and a `.venv` with fonttools it creates itself).

## Layout

- `vendor/mupdf/` MuPDF.js 1.28 (WASM) and `vendor/tesseract/` (OCR, eng+ind). Don't edit vendor code.
- `src/pdf-engine.js` all PDF work: text edits, OCR-line edits, paragraphs, annotations
  (comments = Text, text boxes = FreeText, signatures = Stamp with `/EdSignature`), whiteout, pages, export.
- `src/app.js` UI state, undo/redo (`pushHistory` page snapshots, `pushDocHistory` whole-doc), toolbar, shortcuts.
- `src/ocr.js` Tesseract lines, icon filtering, ink/paper color sampling.
- `src/paragraphs.js` paragraph and list grouping; `src/aging.js` blur/aged look; `src/inpaint.js` background fill.
- `src/comments.js`, `src/textboxes.js`, `src/signature.js` UI for those tools; `src/zip.js` stored ZIP for image export.

## PDF gotchas (learned the hard way)

- Write image XObjects by hand (`rawImage`) with DeviceRGB/DeviceGray. MuPDF's `addImage` writes ICCBased,
  and an ICCBased SMask makes Apple Preview/Quartz drop or darken the image.
- mupdf.js `annot.setRect` takes page space already; don't convert again.
- Annotation appearance Forms need `/Resources` or Quartz renders them gray.
- `graftPage` drops `/Annots`; merging uses `copyAnnotations`.
- Sample backgrounds with `page.runPageContents` so annotations don't leak in.

## Testing

No test suite. Check changes by:
- Rendering output PDFs with macOS `sips -s format png in.pdf --out out.png` (Quartz is the strictest viewer).
- End-to-end in the browser with `playwright-cli` (`run-code --filename=script.js`). Close and reopen the
  browser after code changes (modules are cached). Upload files via `page.setInputFiles('#file', ...)`;
  accept the `beforeunload` dialog.
- Put scratch scripts and test files outside the repo.

## Git

Branch off `main` for changes; PRs go to github.com/whitesinx/offline-pdf-editor.
