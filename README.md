# Offline PDF Editor

Edit the text of a PDF directly in the browser, with no internet and no uploads.

## Run

```sh
python3 serve.py        # opens http://localhost:8765
```

(Browsers block WebAssembly on `file://`, so a local server is needed. The first run creates `.venv/` and
installs `fonttools` + `brotli`. The internet is only used to download fonts from Google Fonts.)

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

## Layout

```
index.html, src/       UI (app.js), editing engine (pdf-engine.js), OCR (ocr.js), font lookup (font-service.js)
serve.py               local server + /api/font
fontresolver.py        system / Google Fonts font matching
vendor/mupdf/          MuPDF.js 1.28.1 (WASM), AGPL-3.0
vendor/tesseract/      Tesseract.js 7.0.0 + core 7.0.0 + eng/ind language data, Apache-2.0
```

## Limits

- Edits are per line. Paragraphs don't re-flow, and justified spacing becomes normal spacing.
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
