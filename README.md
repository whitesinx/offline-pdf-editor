# Offline PDF Editor

Edit the text of a PDF directly in the browser, with no internet and no uploads.

## Run

```sh
python3 serve.py        # opens http://localhost:8765
```

(Browsers block WebAssembly on `file://`, so a local server is needed. The first run creates `.venv/` and
installs `fonttools` + `brotli`. The internet is only used to download fonts from Google Fonts.)

## Images in, images out

- **Open an image** (PNG, JPG, TIFF, BMP, GIF; WebP/AVIF/HEIC when the browser can decode them) and it is
  converted to a one-page PDF automatically. The image is embedded unchanged (a JPEG is not re-compressed) and
  the page takes the image's DPI, so it opens as a scanned page: run OCR to edit its text.
- **Download ▾** saves as PDF, PNG or JPEG. *Image size* can be the original pixel size (for documents opened
  from an image, so a 780×300 PNG comes back as 780×300), 96, 150 or 300 dpi. Images include edits and text
  boxes; comments are only kept in the PDF. Several pages download as a .zip of page images.
  ⌘S saves in the format you opened (PDF, PNG or JPG).

## How quality is preserved

- The PDF is **edited in place**, not converted. Pages are never rasterised or re-encoded.
- Editing a line removes only that line's glyphs (MuPDF redaction with images and vector art left untouched),
  then draws the new text as real vector text at the same baseline, size, color and angle.
- The **original embedded font** is reused when it has every glyph you typed. PDFs usually embed only the
  glyphs they use, so when a new character is missing, the server finds the full font, in this order:
  1. `fonts/cache/`: earlier finds (works offline)
  2. fonts **installed on this computer**, matched by exact PostScript name, then by family + weight + italic
  3. the same family on **Google Fonts** (Roboto, Open Sans, even Calibri)
  4. a **look-alike** on Google Fonts (Calibri→Carlito, Arial/Helvetica→Arimo, Times New Roman→Tinos,
     Cambria→Caladea, Courier New→Cousine, Georgia→Gelasio, …; see `SUBSTITUTES` in `fontresolver.py`)
  Found fonts are slimmed (no hinting, Latin/Greek/Cyrillic only) before embedding to keep files small.
  Only if all of that fails is a built-in Times/Helvetica/Courier used.
- **Scanned pages** are auto-detected. *Run OCR* (Tesseract, English + Indonesian) finds the text lines.
  Editing one covers the old words with the sampled paper color and writes real text in the sampled ink color.
- **Lines / Paragraphs** (toolbar, or `L` / `P`): edit one line at a time, or a whole paragraph.
  In *Paragraphs* mode lines are grouped into paragraphs and list items (`1.`, `2)`, `a.`, `(iv)`, `•`, `-`).
  Editing a paragraph re-wraps it inside its original width with the same font, line spacing, first-line
  indent and hanging indent of list items; justified paragraphs stay justified. Enter applies,
  Shift+Enter starts a new line. If the new text needs more lines than fit before the next text, the first
  Enter warns and the second applies anyway.

- **Look of new text** (toolbar, applies to the next edits):
  - *Match original* (scanned pages): finds the scan's own pixel grid and draws the new text on it, then
    measures how soft and faded the original line is and tunes blur and fade to match.
  - *Blur*: Gaussian blur up to 1.5 pt.
  - *Aged*: lower resolution, uneven ink and a slight fade.
  Only the new ink is changed (rendered with and without the new text, the difference is degraded and drawn
  as a soft-masked image). The real text stays underneath, invisible, so it is still searchable.

- **Text boxes**: choose *Add text* (or press `T`), click anywhere on a page and type (Enter for a new line,
  ⌘↵ or *Done* to finish). Pick font (Helvetica, Times, Courier), size, color and alignment. Click a box to
  select it, drag to move, double-click to edit, Delete to remove. Saved as standard PDF text-box (FreeText)
  annotations, so they print and stay editable in Acrobat and Preview.
- **Comments**: choose *Add comment* (or press `C`) and click anywhere on a page. Each comment is a standard
  PDF comment (speech-bubble note) with author, date and text, so it opens in Acrobat, Preview and browsers.
  The *Comments* panel lists them all; click one to jump to it, edit or delete it. Undo works as for edits.
- **Sign** (`S`): draw your signature or use a photo of it (the paper background is removed), then click a
  page to place it. Drag to move, drag the corner to resize. It's remembered in this browser for next time.
- **Whiteout** (`W`): drag over anything to cover it with its own background (gradients and scans included).
  Real text under it is removed, so it can't be selected or copied. On scanned pages the original pixels
  stay inside the scan image, only covered.
- **Undo / redo**: ⌘Z and ⌘⇧Z (or ⌘Y) for every change, including page moves, inserts and deletes.
  The browser warns before closing the tab with changes that haven't been downloaded.
- **Merge**: select several files in *Open* (PDFs and images, in any mix) and they become one document in the
  order selected. Dropping files on an open document adds them at the end. Merged pages keep their comments,
  text boxes and links.
- **Reorder / insert / delete pages**: each page has ↑ ↓ to move it, *Insert ▾* (pages from a file before or after it, or a blank page
  of the same size) and a delete button. Both can be undone.
- **Rotate** each page with the ⟲ / ⟳ buttons above it. Only the page's `/Rotate` value changes, so
  the content is never re-rendered. Rotation can be undone like any edit.

## Layout

```
index.html, src/       UI (app.js), editing engine (pdf-engine.js), OCR (ocr.js), font lookup (font-service.js)
serve.py               local server + /api/font
fontresolver.py        system / Google Fonts font matching
vendor/mupdf/          MuPDF.js 1.28.1 (WASM), AGPL-3.0
vendor/tesseract/      Tesseract.js 7.0.0 + core 7.0.0 + eng/ind language data, Apache-2.0
```

## Limits

- A paragraph that grows does not push down the text below it (you get a warning instead).
- A paragraph with mixed styles is rewritten in its first line's style.
- A line with mixed styles is rewritten in its dominant style.
- Vertical (CJK top-to-bottom) text is not editable.

## Credits & license

Created by **whitesinx**.

Licensed under the [GNU AGPL-3.0](LICENSE), as required by MuPDF.

Third-party components (in `vendor/`):

| Component | License |
|---|---|
| [MuPDF.js](https://mupdf.com) by Artifex Software | AGPL-3.0 ([LICENSE](vendor/mupdf/LICENSE)) |
| [Tesseract.js](https://github.com/naptha/tesseract.js) + tesseract.js-core | Apache-2.0 ([LICENSE](vendor/tesseract/LICENSE)) |
| Tesseract `eng` / `ind` trained data ([tessdata](https://github.com/tesseract-ocr/tessdata)) | Apache-2.0 |

Fonts are not included in this repository. They are looked up at runtime on your own computer or downloaded from Google Fonts, then cached locally in `fonts/cache/` (git-ignored).
