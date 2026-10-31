// In-place PDF text editing on top of MuPDF (WASM).
//
// Strategy for preserving quality: the document is never re-rendered or
// re-encoded. Only the glyphs of an edited line are removed (redaction with
// images and line art left untouched), and the replacement text is drawn as
// real vector text in a new content stream, using the line's original
// embedded font when it contains every needed glyph.

import * as mupdf from "../vendor/mupdf/mupdf.js";

const SPACE = 0x20;

export class PdfEngine {
	constructor(bytes) {
		this.doc = mupdf.Document.openDocument(bytes, "application/pdf");
		if (!this.doc.isPDF()) throw new Error("Not a PDF file");
		this.doc = this.doc.asPDF();
		this.fontCache = new Map(); // key -> { ref, font, name } | null (unusable)
		this.substitutes = new Map(); // substituteKey(line) -> { entry, info }
		this.fontSeq = 0;
	}

	get pageCount() {
		return this.doc.countPages();
	}

	snapshot() {
		return this.doc.saveToBuffer("").asUint8Array().slice();
	}

	save() {
		// garbage: drop the content removed by edits. Streams that were already
		// compressed (images, fonts) are copied as-is, never re-encoded.
		return this.doc.saveToBuffer("garbage,compress").asUint8Array().slice();
	}

	pageSize(index) {
		const [x0, y0, x1, y1] = this.doc.loadPage(index).getBounds();
		return { width: x1 - x0, height: y1 - y0 };
	}

	renderPNG(index, scale) {
		const page = this.doc.loadPage(index);
		const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
		const png = pix.asPNG().slice();
		pix.destroy();
		return png;
	}

	renderRGBA(index, scale) {
		const page = this.doc.loadPage(index);
		const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, false);
		const out = { width: pix.getWidth(), height: pix.getHeight(), data: pix.getPixels().slice() };
		pix.destroy();
		return out;
	}

	// Returns { lines, scanned } where each line carries what is needed to
	// rewrite it: bbox, baseline origin, direction, dominant font, size, color.
	extract(index) {
		const page = this.doc.loadPage(index);
		const stext = page.toStructuredText("preserve-images,preserve-whitespace");
		const { width, height } = this.pageSize(index);
		const lines = [];
		let imageArea = 0;
		let cur = null;

		stext.walk({
			onImageBlock(bbox) {
				imageArea += Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
			},
			beginLine(bbox, wmode, dir) {
				cur = { bbox, dir, wmode, chars: [] };
			},
			onChar(c, origin, font, size, quad, color) {
				cur.chars.push({ c, origin, font, size, quad, color });
			},
			endLine() {
				if (cur && cur.wmode === 0 && cur.chars.some((ch) => ch.c.trim())) lines.push(finishLine(cur, lines.length));
				cur = null;
			},
		});
		stext.destroy();

		const scanned = lines.length === 0 && imageArea > 0.5 * width * height;
		return { lines, scanned };
	}

	// Replace the text of a line extracted by extract().
	replaceLine(index, line, text) {
		const page = this.doc.loadPage(index);
		this.redact(page, line.bbox, line.dir);
		if (text.trim()) this.drawText(page, line, text);
	}

	// Replace a line found by OCR on a scanned page: the scan cannot be
	// edited, so the old words are covered with the sampled paper color.
	replaceOcrLine(index, line, text) {
		const page = this.doc.loadPage(index);
		const [x0, y0, x1, y1] = line.bbox;
		const pad = (y1 - y0) * 0.12;
		const ops = [`${pdfColor(line.background)} rg`, `${rectOps(page, [x0 - pad, y0 - pad, x1 + pad, y1 + pad])} f`];
		const run = text.trim() ? this.textOps(page, line, text) : "";
		this.appendContent(page, ops.join("\n") + "\n" + run);
	}

	redact(page, bbox, dir) {
		// Inset across the text direction so glyphs of neighbouring lines are not hit.
		const [x0, y0, x1, y1] = bbox;
		const annot = page.createAnnotation("Redact");
		if (Math.abs(dir[0]) >= Math.abs(dir[1])) {
			const inset = (y1 - y0) * 0.2;
			annot.setRect([x0 - 0.5, y0 + inset, x1 + 0.5, y1 - inset]);
		} else {
			const inset = (x1 - x0) * 0.2;
			annot.setRect([x0 + inset, y0 - 0.5, x1 - inset, y1 + 0.5]);
		}
		page.applyRedactions(
			false,
			mupdf.PDFPage.REDACT_IMAGE_NONE,
			mupdf.PDFPage.REDACT_LINE_ART_NONE,
			mupdf.PDFPage.REDACT_TEXT_REMOVE,
		);
	}

	drawText(page, line, text) {
		this.appendContent(page, this.textOps(page, line, text));
	}

	// True when the line's own embedded font has every glyph needed for text.
	originalCovers(line, text) {
		if (!line.font) return false;
		const original = this.fontEntry("orig:" + line.fontId, () => line.font);
		return !!original && covers(original.font, text);
	}

	// Attach a full font file (from the system or Google Fonts) to use when the
	// original embedded font is a subset that lacks some of the typed glyphs.
	setSubstitute(line, bytes, info) {
		const key = `sub:${info.match}:${info.weight}:${info.italic}`;
		const entry = this.fontEntry(key, () => new mupdf.Font(info.match || "Substitute", bytes));
		if (entry) this.substitutes.set(substituteKey(line), { entry, info });
	}

	textOps(page, line, text) {
		const { name, font, label } = this.pickFont(page, line, text);
		line.lastFontLabel = label;

		// Text matrix: map the line's device-space baseline frame into PDF user space.
		const inv = mupdf.Matrix.invert(page.getTransform());
		const [dx, dy] = line.dir;
		const along = applyLinear(inv, [dx, dy]);
		const up = applyLinear(inv, [dy, -dx]);
		const [ox, oy] = applyPoint(inv, line.origin);

		const parts = [];
		let hex = "";
		for (const ch of text) {
			const cp = ch.codePointAt(0);
			const gid = font.encodeCharacter(cp);
			if (cp === SPACE) {
				// Spaces become gaps, not glyphs: a space glyph shared with U+00A0
				// would otherwise copy out of the PDF as a non-breaking space.
				if (hex) parts.push(`<${hex}>`), (hex = "");
				parts.push(num(gid ? -font.advanceGlyph(gid) * 1000 : -250));
				continue;
			}
			hex += gid.toString(16).padStart(4, "0");
		}
		if (hex) parts.push(`<${hex}>`);

		return [
			"BT",
			`/${name} ${num(line.size)} Tf`,
			`${pdfColor(line.color)} rg`,
			`${[...along, ...up, ox, oy].map(num).join(" ")} Tm`,
			`[${parts.join(" ")}] TJ`,
			"ET",
		].join("\n");
	}

	pickFont(page, line, text) {
		if (this.originalCovers(line, text))
			return { ...this.bindFont(page, this.fontCache.get("orig:" + line.fontId)), label: "the original embedded font" };

		const sub = this.substitutes.get(substituteKey(line));
		if (sub && covers(sub.entry.font, text))
			return { ...this.bindFont(page, sub.entry), label: describeSource(sub.info) };

		const base = base14Name(line.style);
		return { ...this.bindFont(page, this.fontEntry("base:" + base, () => new mupdf.Font(base))), label: `built-in ${base} (no better match available)` };
	}

	fontEntry(key, make) {
		if (!this.fontCache.has(key)) {
			try {
				const font = make();
				this.fontCache.set(key, { font, ref: this.doc.addFont(font), name: "EdF" + ++this.fontSeq });
			} catch (err) {
				console.warn("Font not reusable:", key, err);
				this.fontCache.set(key, null);
			}
		}
		return this.fontCache.get(key);
	}

	bindFont(page, entry) {
		const pageObj = page.getObject();
		let res = pageObj.get("Resources");
		if (res.isNull()) {
			res = pageObj.getInheritable("Resources");
			res = res.isNull() ? this.doc.newDictionary() : res;
			pageObj.put("Resources", res);
		}
		let fonts = res.get("Font");
		if (fonts.isNull()) fonts = res.put("Font", this.doc.newDictionary());
		// The page may already use this name for another font (an edit made before
		// an undo, or in an earlier session). Overwriting it would redraw that
		// older text with the wrong glyphs, so pick a free name instead.
		const target = entry.ref.asIndirect();
		let name = entry.name;
		for (let n = 2; ; n++) {
			const existing = fonts.get(name);
			if (existing.isNull()) break;
			if (existing.isIndirect() && existing.asIndirect() === target) return { ...entry, name };
			name = `${entry.name}_${n}`;
		}
		fonts.put(name, entry.ref);
		return { ...entry, name };
	}

	appendContent(page, ops) {
		// Wrap existing content in q/Q so its graphics state cannot leak into ours.
		const pageObj = page.getObject();
		const old = pageObj.get("Contents");
		const contents = this.doc.newArray();
		contents.push(this.doc.addStream("q\n", {}));
		if (old.isArray()) for (let i = 0; i < old.length; i++) contents.push(old.get(i));
		else if (!old.isNull()) contents.push(old);
		contents.push(this.doc.addStream("\nQ\n" + ops + "\n", {}));
		pageObj.put("Contents", contents);
	}
}

function finishLine(raw, id) {
	const chars = raw.chars;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const { quad } of chars) {
		for (let i = 0; i < 8; i += 2) {
			x0 = Math.min(x0, quad[i]); x1 = Math.max(x1, quad[i]);
			y0 = Math.min(y0, quad[i + 1]); y1 = Math.max(y1, quad[i + 1]);
		}
	}

	// Dominant font/size/color by character count.
	const tally = new Map();
	for (const ch of chars) {
		if (!ch.c.trim()) continue;
		const key = ch.font.getName() + "|" + ch.size.toFixed(2) + "|" + ch.color.join(",");
		const t = tally.get(key) || { n: 0, ch };
		t.n++;
		tally.set(key, t);
	}
	const main = [...tally.values()].sort((a, b) => b.n - a.n)[0].ch;
	const first = chars.find((ch) => ch.c.trim()) || chars[0];

	return {
		id,
		kind: "text",
		text: chars.map((ch) => ch.c).join("").replace(/\s+$/, ""),
		bbox: [x0, y0, x1, y1],
		origin: first.origin,
		dir: raw.dir,
		font: main.font,
		fontKey: main.font.getName(),
		fontId: main.font.pointer,
		size: main.size,
		color: main.color,
		style: {
			serif: main.font.isSerif(),
			mono: main.font.isMono(),
			bold: main.font.isBold(),
			italic: main.font.isItalic(),
		},
	};
}

function substituteKey(line) {
	const s = line.style;
	return [line.fontKey, s.bold, s.italic, s.serif, s.mono].join("|");
}

function covers(font, text) {
	return [...new Set(text)].every((c) => c === " " || font.encodeCharacter(c.codePointAt(0)) !== 0);
}

function describeSource(info) {
	if (info.source === "system") return `${info.match} (installed on this computer)`;
	if (info.source === "google") return `${info.match} (Google Fonts)`;
	if (info.source === "substitute") return `${info.match}, a look-alike for ${info.family || "the original"} (Google Fonts)`;
	return info.match;
}

function base14Name(style) {
	const b = style.bold, i = style.italic;
	if (style.mono) return "Courier" + (b && i ? "-BoldOblique" : b ? "-Bold" : i ? "-Oblique" : "");
	if (style.serif) return b && i ? "Times-BoldItalic" : b ? "Times-Bold" : i ? "Times-Italic" : "Times-Roman";
	return "Helvetica" + (b && i ? "-BoldOblique" : b ? "-Bold" : i ? "-Oblique" : "");
}

function applyLinear(m, [x, y]) {
	return [x * m[0] + y * m[2], x * m[1] + y * m[3]];
}

function applyPoint(m, [x, y]) {
	return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function rectOps(page, [x0, y0, x1, y1]) {
	const inv = mupdf.Matrix.invert(page.getTransform());
	const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => applyPoint(inv, p).map(num).join(" "));
	return `${pts[0]} m ${pts[1]} l ${pts[2]} l ${pts[3]} l h`;
}

function pdfColor(rgb) {
	return rgb.map(num).join(" ");
}

function num(v) {
	return Number(v.toFixed(4)).toString();
}
