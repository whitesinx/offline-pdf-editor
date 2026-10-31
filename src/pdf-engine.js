// In-place PDF text editing on top of MuPDF (WASM).
//
// Strategy for preserving quality: the document is never re-rendered or
// re-encoded. Only the glyphs of an edited line are removed (redaction with
// images and line art left untouched), and the replacement text is drawn as
// real vector text in a new content stream, using the line's original
// embedded font when it contains every needed glyph.

import * as mupdf from "../vendor/mupdf/mupdf.js";
import { degradeInk, measureInk } from "./aging.js";
import { inpaint } from "./inpaint.js";

const SPACE = 0x20;
const COMMENT_ICON = 20; // pt
const COMMENT_COLOR = [0.16, 0.29, 0.52]; // formal navy
const TEXTBOX_FONTS = { Helv: "Helvetica", TiRo: "Times-Roman", Cour: "Courier" };

// Wrap an image file (PNG, JPEG, TIFF, BMP, GIF, …) in a one-page PDF.
// The image is embedded as-is (a JPEG stays the same JPEG), and the page gets
// the image's physical size from its DPI, so exporting at "original size"
// gives back exactly the same pixel dimensions.
export function imageToPdf(bytes, fallbackDpi = 96) {
	const img = new mupdf.Image(bytes);
	const w = img.getWidth(), h = img.getHeight();
	const okDpi = (v) => (v >= 36 && v <= 2400 ? v : fallbackDpi);
	const xres = okDpi(img.getXResolution()), yres = okDpi(img.getYResolution());
	const pageW = (w * 72) / xres, pageH = (h * 72) / yres;
	const doc = new mupdf.PDFDocument();
	const res = doc.addObject(doc.newDictionary());
	const xobj = doc.newDictionary();
	xobj.put("Im0", doc.addImage(img));
	res.put("XObject", xobj);
	const n = (v) => Number(v.toFixed(4));
	doc.insertPage(-1, doc.addPage([0, 0, pageW, pageH], 0, res, `q ${n(pageW)} 0 0 ${n(pageH)} 0 0 cm /Im0 Do Q`));
	return { pdf: doc.saveToBuffer("compress").asUint8Array().slice(), pixelWidth: w, pixelHeight: h, scale: w / pageW };
}

export class PdfEngine {
	constructor(bytes) {
		this.doc = mupdf.Document.openDocument(bytes, "application/pdf");
		if (!this.doc.isPDF()) throw new Error("Not a PDF file");
		this.doc = this.doc.asPDF();
		this.fontCache = new Map(); // key -> { ref, font, name } | null (unusable)
		this.substitutes = new Map(); // substituteKey(line) -> { entry, info }
		this.fontSeq = 0;
		this.imageSeq = 0;
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

	// ---- Pages: merge / insert / delete ----------------------------------

	// Copy every page of another PDF in at position `at` (0 = before the first page).
	// A graft map copies shared fonts/images once instead of once per page.
	insertDocument(bytes, at = this.pageCount) {
		const src = mupdf.Document.openDocument(bytes, "application/pdf");
		if (!src.isPDF()) throw new Error("Not a PDF file");
		const pdf = src.asPDF();
		const map = this.doc.newGraftMap();
		const n = pdf.countPages();
		for (let i = 0; i < n; i++) {
			map.graftPage(at + i, pdf, i);
			this.copyAnnotations(map, pdf.loadPage(i).getObject(), this.doc.loadPage(at + i).getObject());
		}
		return n;
	}

	// MuPDF's page graft leaves out /Annots, which would drop comments, text boxes
	// and links of merged files. Copy them, pointing each one at its new page.
	copyAnnotations(map, srcPage, dstPage) {
		const src = srcPage.get("Annots");
		if (!src.isArray() || !src.length) return;
		const out = this.doc.newArray();
		for (let k = 0; k < src.length; k++) {
			const annot = map.graftObject(src.get(k));
			if (annot.isDictionary()) annot.put("P", dstPage);
			out.push(annot);
		}
		dstPage.put("Annots", out);
	}

	deletePage(index) {
		if (this.pageCount <= 1) throw new Error("A document needs at least one page");
		this.doc.deletePage(index);
	}

	// Move a page to a new position (0-based, position in the final order).
	movePage(from, to) {
		if (from === to) return;
		const obj = this.doc.loadPage(from).getObject();
		this.doc.deletePage(from);
		this.doc.insertPage(to, obj);
	}

	// Blank page with the same size as `like` (or A4).
	insertBlankPage(at, like = null) {
		const { width, height } = like != null ? this.pageSize(like) : { width: 595.28, height: 841.89 };
		const page = this.doc.addPage([0, 0, width, height], 0, this.doc.addObject(this.doc.newDictionary()), "");
		this.doc.insertPage(at, page);
	}

	// Rotate a page by a multiple of 90° (positive = clockwise). Only /Rotate changes:
	// the content is untouched, so nothing is re-rendered or re-encoded.
	rotatePage(index, delta) {
		const obj = this.doc.loadPage(index).getObject();
		const cur = obj.getInheritable("Rotate");
		const now = cur.isNull() ? 0 : Math.round(cur.asNumber());
		const next = (((now + delta) % 360) + 360) % 360;
		obj.put("Rotate", next);
		return next;
	}

	// ---- Signatures: Stamp annotations whose appearance is the signature image
	// (ink color + soft mask), marked /EdSignature so we only manage our own.

	listSignatures(index) {
		return this.doc
			.loadPage(index)
			.getAnnotations()
			.filter((a) => a.getType() === "Stamp" && a.getObject().get("EdSignature").isBoolean())
			.map((a) => ({ id: a.getObject().asIndirect(), pageIndex: index, bounds: a.getBounds() }));
	}

	// rect: page-space box; image: { width, height, rgb, alpha } (alpha = soft mask, 0..255).
	addSignature(index, rect, image) {
		const page = this.doc.loadPage(index);
		const annot = page.createAnnotation("Stamp");
		annot.setRect(rect);
		annot.setContents("Signature");
		annot.setCreationDate(new Date());
		annot.update();
		const obj = annot.getObject();
		obj.put("EdSignature", true);
		const mask = this.rawImage(image.width, image.height, image.alpha, "DeviceGray");
		const img = this.rawImage(image.width, image.height, image.rgb, "DeviceRGB", mask);
		this.setImageAppearance(page, obj, rect, img);
		return obj.asIndirect();
	}

	// Move/resize. Rect is written directly (not via setRect) so MuPDF keeps our
	// appearance instead of re-synthesising a generic stamp.
	moveSignature(index, id, rect) {
		const page = this.doc.loadPage(index);
		const obj = this.findAnnot(index, id).getObject();
		const img = obj.get("AP").get("N").get("Resources").get("XObject").get("Sig");
		this.setImageAppearance(page, obj, rect, img);
	}

	deleteSignature(index, id) {
		this.deleteTextBox(index, id);
	}

	// Appearance = the image filling the box, kept upright on rotated pages.
	setImageAppearance(page, obj, rect, imgRef) {
		const d = this.doc;
		const user = this.toUser(page, rect);
		obj.put("Rect", user.array);
		const rot = page.getObject().getInheritable("Rotate");
		const deg = ((((rot.isNull() ? 0 : rot.asNumber()) % 360) + 360) % 360);
		// Form space is the image box as seen on screen (w × h); its matrix turns it
		// against the page rotation so it fits the (possibly swapped) user rect upright.
		const w = rect[2] - rect[0], h = rect[3] - rect[1];
		const rad = (deg * Math.PI) / 180;
		const c = Math.round(Math.cos(rad)), sn = Math.round(Math.sin(rad));
		const dict = d.newDictionary();
		dict.put("Type", d.newName("XObject"));
		dict.put("Subtype", d.newName("Form"));
		const bbox = d.newArray();
		for (const v of [0, 0, w, h]) bbox.push(v);
		dict.put("BBox", bbox);
		const matrix = d.newArray();
		for (const v of [c, sn, -sn, c, 0, 0]) matrix.push(v);
		dict.put("Matrix", matrix);
		const res = d.newDictionary();
		const xo = d.newDictionary();
		xo.put("Sig", imgRef);
		res.put("XObject", xo);
		dict.put("Resources", res);
		const ap = d.newDictionary();
		ap.put("N", d.addStream(`q ${num(w)} 0 0 ${num(h)} 0 0 cm /Sig Do Q`, dict));
		obj.put("AP", ap);
	}

	// Page-space rect → PDF user-space rect (as a PDF array and numbers).
	toUser(page, [x0, y0, x1, y1]) {
		const inv = mupdf.Matrix.invert(page.getTransform());
		const a = applyPoint(inv, [x0, y0]), b = applyPoint(inv, [x1, y1]);
		const r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
		const array = this.doc.newArray();
		for (const v of r) array.push(Number(v.toFixed(3)));
		return { rect: r, array };
	}

	// ---- Whiteout: cover an area with its own background (rebuilt from the
	// pixels around it, on the scan's grid for scanned pages) and remove any
	// real text inside it, so covered text can't be selected or copied.
	whiteout(index, rect) {
		// Remove the text first (whole glyphs, even ones the box only clips), then
		// sample the background, so no piece of a removed letter ends up in the patch.
		const page = this.doc.loadPage(index);
		const annot = page.createAnnotation("Redact");
		annot.setRect(rect);
		page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);

		const grid = this.scanGrid(index, rect);
		const pad = grid ? grid.sx * 2 : 0.75;
		const area = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
		const region = this.sampleArea(index, area, grid);
		const band = Math.max(1, Math.round(pad * region.scale));
		const rgb = inpaint(region.rgb, region.width, region.height, band);

		const p2 = this.doc.loadPage(index);
		const name = this.bindImage(p2, this.rgbImage(region.width, region.height, rgb));
		this.appendContent(p2, this.imageOps(p2, region.rect, name));
	}

	// ---- Comments: standard PDF "Text" annotations (speech-bubble notes), so they
	// show with author and date in Acrobat, Preview, browsers and other viewers.

	listComments(index) {
		const page = this.doc.loadPage(index);
		return page
			.getAnnotations()
			.filter((a) => a.getType() === "Text")
			.map((a) => {
				const created = a.getCreationDate(), modified = a.getModificationDate();
				return {
					id: a.getObject().asIndirect(),
					pageIndex: index,
					bounds: a.getBounds(), // page (screen) space
					text: a.getContents() || "",
					author: a.getAuthor() || "",
					created: created.getTime() > 0 ? created : null,
					modified: modified.getTime() > 0 ? modified : null,
				};
			});
	}

	// point: page-space [x, y] of the bubble's top-left corner.
	addComment(index, [x, y], text, author) {
		const page = this.doc.loadPage(index);
		const annot = page.createAnnotation("Text");
		// MuPDF.js takes annotation rects in page (screen) space and converts them itself.
		annot.setRect([x, y, x + COMMENT_ICON, y + COMMENT_ICON]);
		annot.setIcon("Comment");
		annot.setColor(COMMENT_COLOR);
		annot.setSubject("Comment");
		annot.setAuthor(author);
		annot.setContents(text);
		const now = new Date();
		annot.setCreationDate(now);
		annot.setModificationDate(now);
		// Pop-up note position for viewers that open it (Acrobat), beside the bubble.
		annot.setPopup([x + COMMENT_ICON + 6, y, x + COMMENT_ICON + 226, y + 120]);
		annot.update();
		// On rotated pages the icon is kept upright (NoRotate) and pivots on a corner:
		// shift it so the bubble lands exactly where the user clicked.
		const [bx, by] = annot.getBounds();
		if (Math.abs(bx - x) > 0.5 || Math.abs(by - y) > 0.5) {
			const dx = x - bx, dy = y - by;
			annot.setRect([x + dx, y + dy, x + dx + COMMENT_ICON, y + dy + COMMENT_ICON]);
			annot.update();
		}
		this.commentAppearance(annot);
		return annot.getObject().asIndirect();
	}

	updateComment(index, id, text, author) {
		const annot = this.findComment(index, id);
		annot.setContents(text);
		if (author) annot.setAuthor(author);
		annot.setModificationDate(new Date());
		annot.update();
		this.commentAppearance(annot);
	}

	// Our own icon (navy speech bubble with text lines) instead of MuPDF's generic
	// one, so the comment looks the same in every viewer.
	commentAppearance(annot) {
		const d = this.doc;
		const obj = annot.getObject();
		const r = obj.get("Rect");
		const w = Math.abs(r.get(2).asNumber() - r.get(0).asNumber());
		const h = Math.abs(r.get(3).asNumber() - r.get(1).asNumber());
		const k = Math.min(w, h) / 20;
		const [cr, cg, cb] = COMMENT_COLOR.map(num);
		const ops = [
			`q ${num(k)} 0 0 ${num(k)} 0 0 cm`,
			`${cr} ${cg} ${cb} rg 1 1 1 RG 1 w 1 j`,
			// rounded body, tail at bottom-left
			"4 19 m 16 19 l 17.7 19 19 17.7 19 16 c 19 9 l 19 7.3 17.7 6 16 6 c 9.5 6 l 5 1.5 l 5.5 6 l 4 6 l",
			"2.3 6 1 7.3 1 9 c 1 16 l 1 17.7 2.3 19 4 19 c h B",
			"1 1 1 rg 5 14.6 10 1.3 re f 5 11.6 10 1.3 re f 5 8.6 6.5 1.3 re f",
			"Q",
		].join("\n");
		const dict = d.newDictionary();
		dict.put("Type", d.newName("XObject"));
		dict.put("Subtype", d.newName("Form"));
		const bbox = d.newArray();
		for (const v of [0, 0, w, h]) bbox.push(v);
		dict.put("BBox", bbox);
		dict.put("Resources", d.newDictionary());
		const ap = d.newDictionary();
		ap.put("N", d.addStream(ops, dict));
		obj.put("AP", ap);
	}

	deleteComment(index, id) {
		const page = this.doc.loadPage(index);
		const annot = page.getAnnotations().find((a) => a.getObject().asIndirect() === id);
		if (annot) page.deleteAnnotation(annot);
	}

	findComment(index, id) {
		const annot = this.doc.loadPage(index).getAnnotations().find((a) => a.getObject().asIndirect() === id);
		if (!annot) throw new Error("Comment not found");
		return annot;
	}

	// ---- Text boxes: standard PDF "FreeText" annotations. They're drawn on top of
	// the page, stay editable in Acrobat/Preview, and print.

	listTextBoxes(index) {
		return this.doc
			.loadPage(index)
			.getAnnotations()
			.filter((a) => a.getType() === "FreeText")
			.map((a) => {
				const da = a.getDefaultAppearance();
				return {
					id: a.getObject().asIndirect(),
					pageIndex: index,
					bounds: a.getBounds(),
					text: a.getContents() || "",
					style: { font: TEXTBOX_FONTS[da.font] ? da.font : "Helv", size: da.size || 12, color: da.color?.length === 3 ? da.color : [0, 0, 0], align: a.getQuadding() },
				};
			});
	}

	// at: page-space top-left corner. style: { font: Helv|TiRo|Cour, size, color, align: 0|1|2 }.
	addTextBox(index, at, text, style) {
		const page = this.doc.loadPage(index);
		const annot = page.createAnnotation("FreeText");
		annot.setCreationDate(new Date());
		this.styleTextBox(annot, at, text, style);
		return annot.getObject().asIndirect();
	}

	updateTextBox(index, id, { text, style, at }) {
		const annot = this.findAnnot(index, id);
		const b = annot.getBounds();
		const da = annot.getDefaultAppearance();
		this.styleTextBox(
			annot,
			at || [b[0], b[1]],
			text ?? annot.getContents(),
			style || { font: da.font, size: da.size, color: da.color, align: annot.getQuadding() },
		);
	}

	deleteTextBox(index, id) {
		const page = this.doc.loadPage(index);
		const annot = page.getAnnotations().find((a) => a.getObject().asIndirect() === id);
		if (annot) page.deleteAnnotation(annot);
	}

	findAnnot(index, id) {
		const annot = this.doc.loadPage(index).getAnnotations().find((a) => a.getObject().asIndirect() === id);
		if (!annot) throw new Error("Annotation not found");
		return annot;
	}

	styleTextBox(annot, [x, y], text, style) {
		const { w, h } = this.measureTextBox(text, style);
		annot.setRect([x, y, x + w, y + h]);
		annot.setContents(text);
		annot.setDefaultAppearance(style.font, style.size, style.color);
		annot.setQuadding(style.align || 0);
		annot.setBorderWidth(0);
		annot.setModificationDate(new Date());
		annot.update();
	}

	// Box size for the text with MuPDF's own metrics, so its layout never wraps a line.
	measureTextBox(text, { font, size }) {
		const f = (this.textBoxFonts ??= {})[font] ??= new mupdf.Font(TEXTBOX_FONTS[font] || "Helvetica");
		const lines = text.split("\n");
		let widest = 0;
		for (const line of lines) {
			let w = 0;
			for (const ch of line) {
				const gid = f.encodeCharacter(ch.codePointAt(0));
				w += gid ? f.advanceGlyph(gid) : 0.5;
			}
			widest = Math.max(widest, w);
		}
		return { w: Math.max(size * 2, widest * size + size * 0.6 + 4), h: lines.length * size * 1.2 + size * 0.15 + 4 };
	}

	// Render every page as an image file. Text boxes and edits are included;
	// comment bubbles are review notes, not page content, so they're left out.
	// scaleFor(index) = pixels per point. format: "png" | "jpg".
	exportImages(format, scaleFor, quality = 92) {
		const copy = new PdfEngine(this.snapshot());
		const out = [];
		for (let i = 0; i < copy.pageCount; i++) {
			const page = copy.doc.loadPage(i);
			for (const a of [...page.getAnnotations()]) if (a.getType() === "Text" || a.getType() === "Popup") page.deleteAnnotation(a);
			const s = scaleFor(i);
			const pix = copy.doc.loadPage(i).toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
			out.push(format === "jpg" ? pix.asJPEG(quality) : pix.asPNG());
			pix.destroy();
		}
		return out;
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
	// look: { blur, aged, match } (see aging.js), or null for crisp vector text.
	replaceLine(index, line, text, look = null) {
		const page = this.doc.loadPage(index);
		this.redact(page, line.bbox, line.dir);
		if (!text.trim()) return;
		const stream = this.appendContent(page, this.textOps(page, line, text));
		if (hasLook(look)) this.ageEdit(index, line, text, stream, "", look, null);
		line.lastLook = hasLook(look) ? "softened" : "";
	}

	// Replace a line found by OCR on a scanned page: the scan cannot be
	// edited, so the old words are covered with the sampled paper color.
	replaceOcrLine(index, line, text, look = null) {
		const page = this.doc.loadPage(index);
		// The scan's own pixel grid: new pixels are drawn on it so they get the same
		// resolution (and pixelation) as the original text around them.
		line.grid = this.scanGrid(index, line.bbox);
		// Measure the original scanned text before it's covered, to match its look.
		const reference = look?.match ? this.measureLine(index, line) : null;
		const cover = this.coverOps(index, page, line);
		const run = text.trim() ? this.textOps(page, line, text) : "";
		const stream = this.appendContent(page, cover + run);
		if (run && (hasLook(look) || reference)) this.ageEdit(index, line, text, stream, cover, look, reference);
		line.lastLook = reference ? "matched to the original" : hasLook(look) ? "softened" : "";
	}

	// Replace a whole paragraph (from paragraphs.js) and re-wrap the new text to
	// the same width, line spacing, indent / hanging indent and justification.
	// Returns { lines: new line count, before: old line count }.
	replaceParagraph(index, para, text, look = null) {
		const first = para.lines[0];
		const ocr = first.kind === "ocr";
		// OCR font matching may have nudged the first line's origin; shift the layout with it.
		const shiftX = first.origin[0] - para.firstX;
		const baseline0 = first.origin[1];

		let reference = null;
		if (ocr) {
			const grid = this.scanGrid(index, para.bbox);
			first.grid = grid;
			reference = look?.match ? this.measureLine(index, first) : null;
			const page = this.doc.loadPage(index);
			const cover = para.lines.map((l) => ((l.grid = grid), this.coverOps(index, page, l))).join("");
			this.appendContent(page, cover);
		} else {
			for (const l of para.lines) this.redact(this.doc.loadPage(index), l.bbox, l.dir);
		}
		if (!text.trim()) return { lines: 0, before: para.lines.length };

		const page = this.doc.loadPage(index);
		const flat = text.replace(/\s+/g, " ");
		const pick = this.pickFont(page, first, flat);
		const rows = layoutParagraph(text, para, pick.entry.font, first.size, shiftX);
		rows.forEach((row, i) => {
			for (const seg of row) {
				const line = { ...first, origin: [seg.x, baseline0 + i * para.lineGap], dir: [1, 0], forcedFont: pick, wordExtra: seg.extra };
				const stream = this.appendContent(this.doc.loadPage(index), this.textOps(this.doc.loadPage(index), line, seg.text));
				if (hasLook(look) || reference) this.ageEdit(index, line, seg.text, stream, "", look, reference);
			}
		});
		first.lastFontLabel = pick.label;
		first.lastLook = reference ? "matched to the original" : hasLook(look) ? "softened" : "";
		return { lines: rows.length, before: para.lines.length };
	}

	// How many lines `text` needs when wrapped like `para` (for overlap checks).
	paragraphRows(index, para, text) {
		const first = para.lines[0];
		const pick = this.pickFont(this.doc.loadPage(index), first, text.replace(/\s+/g, " "));
		return layoutParagraph(text, para, pick.entry.font, first.size).length;
	}

	measureLine(index, line) {
		if (!line.background || !line.color) return null;
		const region = this.sampleArea(index, line.bbox, line.grid);
		return measureInk(region.rgb, region.width, region.height, line.background, line.color);
	}

	// The scanned image under `bbox` (largest one, so our own patches never win):
	// its pixel size and origin in page units. null when there's none or it's rotated/skewed.
	scanGrid(index, bbox) {
		const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
		const stext = this.doc.loadPage(index).toStructuredText("preserve-images");
		let best = null;
		stext.walk({
			onImageBlock(b, m, image) {
				if (cx < b[0] || cx > b[2] || cy < b[1] || cy > b[3]) return;
				const area = (b[2] - b[0]) * (b[3] - b[1]);
				if (best && area <= best.area) return;
				const [a, bb, c, d, e, f] = m;
				if (Math.abs(bb) > 1e-3 * Math.abs(a) || Math.abs(c) > 1e-3 * Math.abs(d)) return;
				const w = image.getWidth(), h = image.getHeight();
				best = { area, x0: Math.min(e, e + a), y0: Math.min(f, f + d), sx: Math.abs(a) / w, sy: Math.abs(d) / h };
			},
		});
		stext.destroy();
		// Only worth it when the scan is coarser than our fine rendering (< ~400 dpi).
		return best && best.sx > 72 / 400 ? best : null;
	}

	// Pixels of a page area: on the scan's grid when there is one (one sample per
	// scan pixel), otherwise rendered at 288 dpi. scale = pixels per page unit.
	sampleArea(index, rect, grid) {
		if (!grid) {
			const R = 4;
			const r = this.renderRegion(index, rect, R);
			return { ...r, rect: r.bbox.map((v) => v / R), scale: R };
		}
		const { sx, sy } = grid;
		const i0 = Math.floor((rect[0] - grid.x0) / sx), i1 = Math.ceil((rect[2] - grid.x0) / sx);
		const j0 = Math.floor((rect[1] - grid.y0) / sy), j1 = Math.ceil((rect[3] - grid.y0) / sy);
		const snapped = [grid.x0 + i0 * sx, grid.y0 + j0 * sy, grid.x0 + i1 * sx, grid.y0 + j1 * sy];
		const width = i1 - i0, height = j1 - j0;
		const R = Math.min(16, Math.max(4, Math.ceil(4 / Math.min(sx, sy))));
		const hi = this.renderRegion(index, snapped, R);
		// Average the fine render back into scan pixels (pixel centres inside each cell).
		const sum = new Float32Array(width * height * 3), cnt = new Float32Array(width * height);
		for (let y = 0; y < hi.height; y++) {
			const j = Math.floor(((hi.bbox[1] + y + 0.5) / R - snapped[1]) / sy);
			if (j < 0 || j >= height) continue;
			for (let x = 0; x < hi.width; x++) {
				const i = Math.floor(((hi.bbox[0] + x + 0.5) / R - snapped[0]) / sx);
				if (i < 0 || i >= width) continue;
				const q = j * width + i, p = (y * hi.width + x) * 3;
				sum[q * 3] += hi.rgb[p]; sum[q * 3 + 1] += hi.rgb[p + 1]; sum[q * 3 + 2] += hi.rgb[p + 2];
				cnt[q]++;
			}
		}
		const rgb = new Uint8Array(width * height * 3);
		for (let q = 0; q < cnt.length; q++) for (let k = 0; k < 3; k++) rgb[q * 3 + k] = Math.round(sum[q * 3 + k] / (cnt[q] || 1));
		return { width, height, rgb, rect: snapped, scale: 1 / sx };
	}

	rgbImage(width, height, rgb) {
		return this.rawImage(width, height, rgb, "DeviceRGB");
	}

	// Image XObjects are written by hand rather than with doc.addImage(): MuPDF
	// tags them ICCBased, and an ICCBased soft mask breaks the spec (an SMask must
	// be DeviceGray), so Preview/Quartz and others dropped or darkened the ink.
	// Plain Device color spaces render the same everywhere. "compress" on save
	// Flate-encodes the streams.
	rawImage(width, height, samples, colorSpace, smask = null) {
		const d = this.doc;
		const dict = d.newDictionary();
		dict.put("Type", d.newName("XObject"));
		dict.put("Subtype", d.newName("Image"));
		dict.put("Width", d.newInteger(width));
		dict.put("Height", d.newInteger(height));
		dict.put("ColorSpace", d.newName(colorSpace));
		dict.put("BitsPerComponent", d.newInteger(8));
		if (smask) dict.put("SMask", smask);
		return d.addStream(samples, dict);
	}

	// Make freshly drawn text look printed/scanned: render the edited area with and
	// without the new text, degrade the difference (the new ink only), and draw it
	// as a soft-masked image. The vector text stays underneath, invisible (Tr 3),
	// so the line can still be selected, searched and copied.
	ageEdit(index, line, text, stream, prefix, look, reference) {
		const rect = this.textBounds(line);
		const hidden = prefix + this.textOps(this.doc.loadPage(index), line, text, { invisible: true });

		const withText = this.sampleArea(index, rect, line.grid);
		stream.writeStream(hidden);
		const withoutText = this.sampleArea(index, rect, line.grid);

		const { width, height, scale } = withText;
		const result = degradeInk(withText.rgb, withoutText.rgb, width, height, line.color, { ...look, reference }, scale);
		if (!result) return;
		const { alpha } = result;
		line.lastBlur = result.sigma;

		const page = this.doc.loadPage(index);
		const name = this.bindImage(page, this.inkImage(width, height, alpha, line.color));
		stream.writeStream(`${hidden}\n${this.imageOps(page, withText.rect, name)}\n`);
	}

	// Hide the old scanned words. The patch is rebuilt from the pixels around the
	// box, so gradients, tinted UI panels and paper shading carry through it
	// instead of showing a flat rectangle. Flat sampled color is the fallback.
	coverOps(index, page, line) {
		const [x0, y0, x1, y1] = line.bbox;
		const pad = (y1 - y0) * 0.15;
		const rect = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
		try {
			const region = this.sampleArea(index, rect, line.grid);
			const band = Math.max(1, Math.round(region.scale * 0.6));
			const rgb = inpaint(region.rgb, region.width, region.height, band);
			const name = this.bindImage(page, this.rgbImage(region.width, region.height, rgb));
			return this.imageOps(page, region.rect, name) + "\n";
		} catch (err) {
			console.warn("Inpainting failed, using a flat cover", err);
			return `${pdfColor(line.background)} rg\n${rectOps(page, rect)} f\n`;
		}
	}

	// Draw image XObject `name` so it fills the device-space rect.
	imageOps(page, [px0, py0, px1, py1], name) {
		const inv = mupdf.Matrix.invert(page.getTransform());
		const p00 = applyPoint(inv, [px0, py1]), p10 = applyPoint(inv, [px1, py1]), p01 = applyPoint(inv, [px0, py0]);
		const cm = [p10[0] - p00[0], p10[1] - p00[1], p01[0] - p00[0], p01[1] - p00[1], p00[0], p00[1]];
		return `q ${cm.map(num).join(" ")} cm /${name} Do Q`;
	}

	// Device-space box around the text as it will be drawn (it may be wider than the old line).
	textBounds(line) {
		const [dx, dy] = line.dir;
		const up = [dy, -dx];
		const w = Math.max(line.lastWidth || 0, 0);
		const [ox, oy] = line.origin;
		const pts = [];
		for (const t of [0, w]) for (const u of [-0.35 * line.size, 1.05 * line.size]) pts.push([ox + dx * t + up[0] * u, oy + dy * t + up[1] * u]);
		const pad = line.size * 0.25;
		const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
		return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
	}

	renderRegion(index, [x0, y0, x1, y1], scale) {
		const page = this.doc.loadPage(index);
		const bbox = [Math.floor(x0 * scale), Math.floor(y0 * scale), Math.ceil(x1 * scale), Math.ceil(y1 * scale)];
		const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
		pix.clear(255);
		const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
		// Page content only: comment bubbles, text boxes and signatures sit on top as
		// annotations and must not leak into covers, whiteouts or the aged-ink diff.
		page.runPageContents(dev, mupdf.Matrix.scale(scale, scale));
		dev.close();
		const width = pix.getWidth(), height = pix.getHeight(), stride = pix.getStride();
		const src = pix.getPixels();
		const rgb = new Uint8Array(width * height * 3);
		for (let y = 0; y < height; y++) rgb.set(src.subarray(y * stride, y * stride + width * 3), y * width * 3);
		pix.destroy();
		dev.destroy?.();
		return { width, height, rgb, bbox };
	}

	// Solid ink-colored image with the degraded coverage as its soft mask.
	inkImage(width, height, alpha, color) {
		const c = color.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
		const rgb = new Uint8Array(width * height * 3);
		for (let p = 0; p < width * height; p++) rgb.set(c, p * 3);
		const mask = this.rawImage(width, height, alpha, "DeviceGray");
		return this.rawImage(width, height, rgb, "DeviceRGB", mask);
	}

	bindImage(page, ref) {
		const res = this.pageResources(page);
		let xobjs = res.get("XObject");
		if (xobjs.isNull()) xobjs = res.put("XObject", this.doc.newDictionary());
		let name;
		do name = "EdImg" + ++this.imageSeq;
		while (!xobjs.get(name).isNull());
		xobjs.put(name, ref);
		return name;
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

	textOps(page, line, text, { invisible = false } = {}) {
		// A paragraph picks one font for all its lines (line.forcedFont); its justified
		// lines add line.wordExtra (1/1000 em) to every space.
		const { name, font, label } = line.forcedFont
			? { ...this.bindFont(page, line.forcedFont.entry), label: line.forcedFont.label }
			: this.pickFont(page, line, text);
		line.lastFontLabel = label;
		const extra = line.wordExtra || 0;
		let advance = 0;

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
			advance += gid ? font.advanceGlyph(gid) : cp === SPACE ? 0.25 : 0;
			if (cp === SPACE) {
				// Spaces become gaps, not glyphs: a space glyph shared with U+00A0
				// would otherwise copy out of the PDF as a non-breaking space.
				if (hex) parts.push(`<${hex}>`), (hex = "");
				parts.push(num((gid ? -font.advanceGlyph(gid) * 1000 : -250) - extra));
				advance += extra / 1000;
				continue;
			}
			hex += gid.toString(16).padStart(4, "0");
		}
		if (hex) parts.push(`<${hex}>`);
		line.lastWidth = advance * line.size;

		return [
			"BT",
			...(invisible ? ["3 Tr"] : []),
			`/${name} ${num(line.size)} Tf`,
			`${pdfColor(line.color)} rg`,
			`${[...along, ...up, ox, oy].map(num).join(" ")} Tm`,
			`[${parts.join(" ")}] TJ`,
			"ET",
		].join("\n");
	}

	pickFont(page, line, text) {
		if (this.originalCovers(line, text)) {
			const entry = this.fontCache.get("orig:" + line.fontId);
			return { ...this.bindFont(page, entry), entry, label: "the original embedded font" };
		}

		const sub = this.substitutes.get(substituteKey(line));
		if (sub && covers(sub.entry.font, text)) return { ...this.bindFont(page, sub.entry), entry: sub.entry, label: describeSource(sub.info) };

		const base = base14Name(line.style);
		const entry = this.fontEntry("base:" + base, () => new mupdf.Font(base));
		return { ...this.bindFont(page, entry), entry, label: `built-in ${base} (no better match available)` };
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

	pageResources(page) {
		const pageObj = page.getObject();
		let res = pageObj.get("Resources");
		if (res.isNull()) {
			res = pageObj.getInheritable("Resources");
			res = res.isNull() ? this.doc.newDictionary() : res;
			pageObj.put("Resources", res);
		}
		return res;
	}

	bindFont(page, entry) {
		const res = this.pageResources(page);
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
		// Our ops get their own stream so ageEdit() can rewrite them later.
		contents.push(this.doc.addStream("\nQ\n", {}));
		const stream = this.doc.addStream(ops + "\n", {});
		contents.push(stream);
		pageObj.put("Contents", contents);
		return stream;
	}
}

// Greedy word wrap with real glyph widths. Returns rows of segments
// [{ x, text, extra }]: usually one segment per row; the first row of a list item
// has two (the marker, then the text at the hanging indent). `extra` is the
// justification space added to each space, in 1/1000 em.
function layoutParagraph(text, para, font, size, shiftX = 0) {
	const width = (s) => {
		let w = 0;
		for (const ch of s) {
			const g = font.encodeCharacter(ch.codePointAt(0));
			w += g ? font.advanceGlyph(g) : ch === " " ? 0.25 : 0.5;
		}
		return w * size;
	};
	const space = width(" ");
	const right = para.right + shiftX;
	const firstX = para.firstX + shiftX;
	let restX = (para.restX ?? para.firstX) + shiftX;

	let body = text;
	let marker = null;
	let bodyX = firstX;
	const m = para.marker && text.match(/^\s*(\S+)\s+/);
	if (m && m[1] === para.marker.trim()) {
		marker = m[1];
		body = text.slice(m[0].length);
		// First-line text starts where it did in the original ("1. The" or "1.<tab>The");
		// wrapped lines use the item's hanging indent, or line up with that text.
		bodyX = para.bodyX != null ? para.bodyX + shiftX : firstX + width(marker + " ");
		if (para.restX == null) restX = bodyX;
	}

	const rows = [];
	const blocks = body.split("\n");
	blocks.forEach((block, bi) => {
		const words = block.trim().split(/\s+/).filter(Boolean);
		if (!words.length) return rows.push([]);
		let cur = [];
		const startX = () => (rows.length === 0 ? (marker ? bodyX : firstX) : restX);
		const flush = (last) => {
			const x = startX();
			const t = cur.join(" ");
			let extra = 0;
			const spaces = cur.length - 1;
			if (para.justified && !last && spaces > 0) {
				const slack = right - x - width(t);
				if (slack > 0 && slack < size * 4 * spaces) extra = (slack / spaces / size) * 1000;
			}
			const row = [{ x, text: t, extra }];
			if (rows.length === 0 && marker) row.unshift({ x: firstX, text: marker, extra: 0 });
			rows.push(row);
			cur = [];
		};
		for (const w of words) {
			const maxW = right - startX();
			if (cur.length && width([...cur, w].join(" ")) > maxW) flush(false);
			cur.push(w);
		}
		flush(true);
	});
	return rows;
}

const hasLook = (look) => !!look && (look.blur > 0 || look.aged > 0);

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
		charX: chars.map((ch) => ch.origin[0]), // pen x of each character (same order as text)
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
