const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

function status(msg, isError = false) {
	statusEl.textContent = msg;
	statusEl.classList.toggle("error", isError);
}

let groupParagraphs, PdfEngine, imageToPdf, zip, ocrPage, resolveFont, matchFont, warmUpFonts, createComments, createTextBoxes, createSignatures;
try {
	({ PdfEngine, imageToPdf } = await import("./pdf-engine.js"));
	({ zip } = await import("./zip.js"));
	({ groupParagraphs } = await import("./paragraphs.js"));
	({ ocrPage } = await import("./ocr.js"));
	({ resolveFont } = await import("./font-service.js"));
	({ matchFont, warmUp: warmUpFonts } = await import("./font-match.js"));
	({ createComments } = await import("./comments.js"));
	({ createTextBoxes } = await import("./textboxes.js"));
	({ createSignatures } = await import("./signature.js"));
	status("Ready. Open a PDF or an image to start.");
} catch (err) {
	console.error(err);
	status("Failed to load the PDF engine. Serve this folder with `python3 serve.py` instead of opening the file directly.", true);
	throw err;
}

const state = {
	engine: null,
	fileName: "document.pdf",
	source: { kind: "pdf" }, // or { kind: "image", format: "png"|"jpg" } when a single image was opened
	pageMeta: [], // per page: null, or { scale (px per pt), width, height, format } for pages made from an image
	pages: [], // { index, width, height, lines, ocrLines, scanned, el, rendered }
	history: [], // undo stack: { kind: "page", bytes, pageIndex, ocrLines } | { kind: "doc", bytes, ocr, meta }
	future: [], // redo stack, same shape
	dirty: false, // changes since the last download
	zoom: 1,
	editing: null,
	unit: "line", // click to edit a "line" or a whole "para"graph
};

const pagesEl = $("#pages");
const viewer = $("#viewer");

// ---- Undo / redo ------------------------------------------------------------
// Every change first records a snapshot. "page" entries restore one page;
// "doc" entries (insert/delete/move pages) restore the whole page list.

const pushHistory = (page) => record({ kind: "page", bytes: state.engine.snapshot(), pageIndex: page.index, ocrLines: page.ocrLines });

function pushDocHistory() {
	record({ kind: "doc", bytes: state.engine.snapshot(), ocr: state.pages.map((p) => p.ocrLines), meta: [...state.pageMeta] });
}

function record(entry) {
	state.history.push(entry);
	state.future = [];
	state.dirty = true;
}

// The current state in the same scope as `entry`, for the opposite stack.
function capture(entry) {
	if (entry.kind === "doc") return { kind: "doc", bytes: state.engine.snapshot(), ocr: state.pages.map((p) => p.ocrLines), meta: [...state.pageMeta] };
	return { kind: "page", bytes: state.engine.snapshot(), pageIndex: entry.pageIndex, ocrLines: state.pages[entry.pageIndex].ocrLines };
}

function restore(entry) {
	finishEdit(false);
	state.engine = new PdfEngine(entry.bytes);
	if (entry.kind === "doc") {
		state.pageMeta = entry.meta;
		rebuild(entry.ocr);
		return;
	}
	const page = state.pages[entry.pageIndex];
	page.ocrLines = entry.ocrLines;
	closeOverlays();
	refreshPage(page);
	rerenderPage(page);
	comments.refresh();
	updateButtons();
}

function undo() {
	const entry = state.history.pop();
	if (!entry) return;
	state.future.push(capture(entry));
	restore(entry);
	state.dirty = true;
	updateButtons();
	status("Undone." + (state.future.length ? " Redo with ⌘⇧Z." : ""));
}

function redo() {
	const entry = state.future.pop();
	if (!entry) return;
	state.history.push(capture(entry));
	restore(entry);
	state.dirty = true;
	updateButtons();
	status("Redone.");
}

// Drop the last snapshot after a failed change, restoring it without touching redo.
function rollback() {
	const entry = state.history.pop();
	if (entry) restore(entry);
}

function closeOverlays() {
	comments.closeCard();
	textBoxes.closeEditor(false);
	textBoxes.deselect();
	signatures.deselect();
}

const afterChange = (page) => {
	rerenderPage(page);
	updateButtons();
};

const signatures = createSignatures({ state, status, beforeChange: pushHistory, afterChange });

const textBoxes = createTextBoxes({
	state,
	status,
	beforeChange: pushHistory,
	afterChange,
});

const comments = createComments({
	state,
	viewer,
	panel: $("#comments-panel"),
	status,
	beforeChange: pushHistory,
	afterChange,
});

// ---- Loading --------------------------------------------------------------

// A file as PDF bytes: PDFs as they are, images converted (keeping their pixel scale).
async function loadAsPdf(file) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (isPdf(bytes)) return { bytes, image: null };
	const conv = await convertImage(file, bytes);
	const format = /\.jpe?g$/i.test(file.name) || file.type === "image/jpeg" ? "jpg" : "png";
	return { bytes: conv.pdf, image: { scale: conv.scale, width: conv.pixelWidth, height: conv.pixelHeight, format } };
}

async function loadAll(files, verb) {
	const loaded = [];
	for (const [i, file] of files.entries()) {
		status(`${verb} ${file.name}${files.length > 1 ? ` (${i + 1}/${files.length})` : ""}…`);
		try {
			loaded.push({ ...(await loadAsPdf(file)), name: file.name });
		} catch (err) {
			throw new Error(`${file.name}: ${err.message}`);
		}
	}
	return loaded;
}

// Open one file, or several merged into one document in the order given.
async function openFiles(fileList) {
	const files = [...(fileList || [])];
	if (!files.length) return;
	try {
		const loaded = await loadAll(files, files.length > 1 ? "Merging" : "Opening");
		const engine = new PdfEngine(loaded[0].bytes);
		const meta = Array(engine.pageCount).fill(loaded[0].image);
		for (const l of loaded.slice(1)) meta.push(...Array(engine.insertDocument(l.bytes)).fill(l.image));

		state.engine = engine;
		state.pageMeta = meta;
		state.history = [];
		state.future = [];
		state.dirty = false;
		setTool(null);
		const first = files[0].name;
		state.fileName = files.length > 1 ? first.replace(/\.[a-z0-9]+$/i, "") + "-merged.pdf" : first;
		state.source = files.length === 1 && loaded[0].image ? { kind: "image", format: loaded[0].image.format } : { kind: "pdf" };
		rebuild([]);
		document.body.classList.add("has-doc");

		const scanned = state.pages.filter((p) => p.scanned).length;
		const what = files.length > 1 ? `Merged ${files.length} files into ${state.pages.length} page(s)` : `${first}: ${state.pages.length} page(s)`;
		const img = files.length === 1 && loaded[0].image ? ` Converted from a ${loaded[0].image.width}×${loaded[0].image.height} image.` : "";
		status(what + (scanned ? `, ${scanned} scanned. Run OCR to edit them.` : ".") + img);
	} catch (err) {
		console.error(err);
		status(`Could not open: ${err.message}`, true);
	}
}

// Insert the pages of files at position `at` (0 = before page 1).
async function insertFiles(fileList, at) {
	const files = [...(fileList || [])];
	if (!files.length) return;
	if (!state.engine) return openFiles(files);
	let pushed = false;
	try {
		const loaded = await loadAll(files, "Inserting");
		const ocr = state.pages.map((p) => p.ocrLines);
		pushDocHistory();
		pushed = true;
		let pos = at;
		for (const l of loaded) {
			const n = state.engine.insertDocument(l.bytes, pos);
			state.pageMeta.splice(pos, 0, ...Array(n).fill(l.image));
			ocr.splice(pos, 0, ...Array.from({ length: n }, () => []));
			pos += n;
		}
		rebuild(ocr);
		const added = pos - at;
		status(`Inserted ${added} page(s) from ${files.length > 1 ? `${files.length} files` : files[0].name} as page ${at + 1}${added > 1 ? `–${at + added}` : ""}.`);
		state.pages[at]?.el.scrollIntoView({ behavior: "smooth", block: "start" });
	} catch (err) {
		console.error(err);
		if (pushed) rollback();
		status(`Insert failed: ${err.message}`, true);
	}
}

function deletePageAt(page) {
	if (state.pages.length <= 1) return status("A document needs at least one page.", true);
	const ocr = state.pages.map((p) => p.ocrLines);
	pushDocHistory();
	try {
		state.engine.deletePage(page.index);
		state.pageMeta.splice(page.index, 1);
		ocr.splice(page.index, 1);
		rebuild(ocr);
		status(`Page ${page.index + 1} deleted. Undo (⌘Z) to restore it.`);
	} catch (err) {
		console.error(err);
		rollback();
		status(`Delete failed: ${err.message}`, true);
	}
}

function insertBlankAt(at, like) {
	const ocr = state.pages.map((p) => p.ocrLines);
	pushDocHistory();
	state.engine.insertBlankPage(at, like);
	state.pageMeta.splice(at, 0, null);
	ocr.splice(at, 0, []);
	rebuild(ocr);
	status(`Blank page inserted as page ${at + 1}.`);
	state.pages[at]?.el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Move a page up (-1) or down (+1).
function movePage(page, delta) {
	const to = page.index + delta;
	if (to < 0 || to >= state.pages.length) return;
	const ocr = state.pages.map((p) => p.ocrLines);
	pushDocHistory();
	state.engine.movePage(page.index, to);
	const [m] = state.pageMeta.splice(page.index, 1);
	state.pageMeta.splice(to, 0, m);
	const [o] = ocr.splice(page.index, 1);
	ocr.splice(to, 0, o);
	rebuild(ocr);
	status(`Page ${page.index + 1} moved to position ${to + 1}.`);
	state.pages[to]?.el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Rebuild every page after the page list changed; ocr[i] = OCR lines to keep for page i.
function rebuild(ocr) {
	finishEdit(false);
	closeOverlays();
	buildPages();
	state.pages.forEach((p, i) => (p.ocrLines = ocr[i] || []));
	comments.refresh();
	setExportOptions();
	updateButtons();
}

const isPdf = (bytes) => bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 1024)).includes("%PDF-");

// MuPDF reads PNG, JPEG, TIFF, BMP, GIF, PNM, JPEG 2000… Anything else the browser
// can show (WebP, AVIF, HEIC in Safari) is decoded by the browser into a PNG first.
async function convertImage(file, bytes) {
	try {
		return imageToPdf(bytes);
	} catch (err) {
		let bitmap;
		try {
			bitmap = await createImageBitmap(file);
		} catch {
			throw new Error("this file type isn't supported. Use PDF, PNG, JPG, TIFF, BMP, GIF or WebP");
		}
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
		return imageToPdf(png);
	}
}

function buildPages() {
	pagesEl.replaceChildren();
	observer.disconnect();
	state.pages = [];
	for (let i = 0; i < state.engine.pageCount; i++) {
		const { width, height } = state.engine.pageSize(i);
		const { lines, scanned } = state.engine.extract(i);
		const el = document.createElement("div");
		el.className = "page";
		el.dataset.index = i;
		const page = {
			index: i, width, height, lines, ocrLines: [], scanned, el, rendered: false,
			comments: state.engine.listComments(i),
			textBoxes: state.engine.listTextBoxes(i),
			signatures: state.engine.listSignatures(i),
		};
		el.addEventListener("click", (ev) => {
			if (comments.place(page, ev) || textBoxes.place(page, ev) || signatures.place(page, ev)) return;
			comments.closeCard();
			textBoxes.deselect();
			textBoxes.closeEditor(true);
			signatures.deselect();
		});
		el.addEventListener("pointerdown", (ev) => whiteoutStart(page, ev));
		state.pages.push(page);
		pagesEl.append(el);
		layoutPage(page);
		observer.observe(el);
	}
}

// ---- Rendering ------------------------------------------------------------

const observer = new IntersectionObserver(
	(entries) => {
		for (const e of entries) if (e.isIntersecting) renderPage(state.pages[+e.target.dataset.index]);
	},
	{ root: viewer, rootMargin: "800px 0px" },
);

function layoutPage(page) {
	page.el.style.width = page.width * state.zoom + "px";
	page.el.style.height = page.height * state.zoom + "px";
}

function renderPage(page) {
	if (page.rendered) return;
	page.rendered = true;
	const scale = state.zoom * Math.min(window.devicePixelRatio || 1, 3);
	const png = state.engine.renderPNG(page.index, scale);
	const img = new Image();
	img.src = URL.createObjectURL(new Blob([png], { type: "image/png" }));
	img.onload = () => URL.revokeObjectURL(img.src);
	img.alt = `Page ${page.index + 1}`;

	const label = document.createElement("div");
	label.className = "page-label";
	label.textContent = `Page ${page.index + 1}`;

	page.el.replaceChildren(img, label, pageTools(page), ...lineBoxes(page), ...signatures.overlays(page), ...textBoxes.overlays(page), ...comments.pins(page));
	if (page.scanned && !page.ocrLines.length) page.el.append(scanBadge(page));
}

function rerenderPage(page) {
	page.rendered = false;
	renderPage(page);
}

function lineBoxes(page) {
	if (state.unit === "para") return paraBoxes(page);
	const z = state.zoom;
	return [...page.lines, ...page.ocrLines].map((line) => {
		const [x0, y0, x1, y1] = line.bbox;
		const box = document.createElement("div");
		box.className = "line" + (line.kind === "ocr" ? " ocr" : "");
		box.style.left = x0 * z + "px";
		box.style.top = y0 * z + "px";
		box.style.width = (x1 - x0) * z + "px";
		box.style.height = (y1 - y0) * z + "px";
		box.title = line.text;
		box.addEventListener("click", (ev) => {
			if (tool) return; // a placing tool is active: let the page handle the click
			ev.stopPropagation();
			startEdit(page, line);
		});
		return box;
	});
}

// Paragraph mode: one box per paragraph / list item. One-line paragraphs keep the
// line editor (nothing to re-wrap).
function paraBoxes(page) {
	const z = state.zoom;
	const paras = [...groupParagraphs(page.lines, page.width), ...groupParagraphs(page.ocrLines, page.width)];
	return paras.map((para) => {
		const [x0, y0, x1, y1] = para.bbox;
		const box = document.createElement("div");
		box.className = "line para" + (para.kind === "ocr" ? " ocr" : "") + (para.marker ? " list" : "");
		Object.assign(box.style, { left: x0 * z + "px", top: y0 * z + "px", width: (x1 - x0) * z + "px", height: (y1 - y0) * z + "px" });
		const kind = para.marker ? `List item ${para.marker}` : para.lines.length > 1 ? `Paragraph, ${para.lines.length} lines` : "Line";
		box.title = `${kind}${para.justified ? ", justified" : ""}\n${para.text}`;
		box.addEventListener("click", (ev) => {
			if (tool) return;
			ev.stopPropagation();
			if (para.lines.length === 1 && !para.marker) startEdit(page, para.lines[0]);
			else startParaEdit(page, para);
		});
		return box;
	});
}

function pageTools(page) {
	const tools = document.createElement("div");
	tools.className = "page-tools";
	for (const [delta, icon, title] of [[-1, "↑", "Move up"], [1, "↓", "Move down"]]) {
		const btn = document.createElement("button");
		btn.className = "btn icon";
		btn.textContent = icon;
		btn.title = `${title} (page ${page.index + 1})`;
		btn.disabled = page.index + delta < 0 || page.index + delta >= state.pages.length;
		btn.onclick = (ev) => {
			ev.stopPropagation();
			movePage(page, delta);
		};
		tools.append(btn);
	}
	for (const [delta, icon, title] of [[-90, "⟲", "Rotate left"], [90, "⟳", "Rotate right"]]) {
		const btn = document.createElement("button");
		btn.className = "btn icon";
		btn.textContent = icon;
		btn.title = `${title} (page ${page.index + 1})`;
		btn.onclick = (ev) => {
			ev.stopPropagation();
			rotatePage(page, delta);
		};
		tools.append(btn);
	}

	const menu = document.createElement("details");
	menu.className = "menu page-menu";
	const summary = document.createElement("summary");
	summary.className = "btn icon";
	summary.textContent = "Insert ▾";
	summary.title = `Insert pages before or after page ${page.index + 1}`;
	const panel = document.createElement("div");
	panel.className = "menu-panel right";
	const item = (label, hint, fn) => {
		const b = document.createElement("button");
		b.className = "menu-item";
		b.innerHTML = "<strong></strong><small></small>";
		b.querySelector("strong").textContent = label;
		b.querySelector("small").textContent = hint;
		b.onclick = (ev) => {
			ev.stopPropagation();
			menu.open = false;
			fn();
		};
		return b;
	};
	const pick = (at) => {
		insertAt = at;
		insertInput.click();
	};
	panel.append(
		item("Pages from file before", `PDF or image, inserted before page ${page.index + 1}`, () => pick(page.index)),
		item("Pages from file after", `PDF or image, inserted after page ${page.index + 1}`, () => pick(page.index + 1)),
		item("Blank page after", "Same size as this page", () => insertBlankAt(page.index + 1, page.index)),
	);
	menu.append(summary, panel);
	menu.addEventListener("click", (ev) => ev.stopPropagation());

	const del = document.createElement("button");
	del.className = "btn icon danger";
	del.title = state.pages.length > 1 ? `Delete page ${page.index + 1}` : "A document needs at least one page";
	del.disabled = state.pages.length <= 1;
	del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>`;
	del.onclick = (ev) => {
		ev.stopPropagation();
		deletePageAt(page);
	};
	tools.append(menu, del);
	return tools;
}

function rotatePage(page, delta) {
	finishEdit(false);
	try {
		pushHistory(page);
		const angle = state.engine.rotatePage(page.index, delta);
		refreshPage(page);
		// OCR boxes are in the old orientation. Clear them; run OCR again if needed.
		const hadOcr = page.ocrLines.length > 0;
		page.ocrLines = [];
		rerenderPage(page);
		updateButtons();
		status(`Page ${page.index + 1} rotated to ${angle}°.` + (hadOcr ? " Run OCR again to edit its text." : ""));
	} catch (err) {
		console.error(err);
		rollback();
		status(`Rotate failed: ${err.message}`, true);
	}
}

// Re-read size and text after the page geometry changed (rotate, undo).
function refreshPage(page) {
	Object.assign(page, state.engine.pageSize(page.index));
	const { lines, scanned } = state.engine.extract(page.index);
	page.lines = lines;
	page.scanned = scanned;
	page.comments = state.engine.listComments(page.index);
	page.textBoxes = state.engine.listTextBoxes(page.index);
	page.signatures = state.engine.listSignatures(page.index);
	layoutPage(page);
}

function scanBadge(page) {
	const badge = document.createElement("div");
	badge.className = "scan-badge";
	badge.textContent = "Scanned page";
	const btn = document.createElement("button");
	btn.className = "btn primary";
	btn.textContent = "Run OCR";
	btn.onclick = () => runOcr([page]);
	badge.append(btn);
	return badge;
}

// ---- Editing --------------------------------------------------------------

function startEdit(page, line) {
	finishEdit(true);
	comments.closeCard();
	textBoxes.closeEditor(true);
	textBoxes.deselect();
	const z = state.zoom;
	const [x0, y0, x1, y1] = line.bbox;
	const input = document.createElement("input");
	input.className = "editor";
	input.value = line.text;
	input.spellcheck = false;
	Object.assign(input.style, {
		left: x0 * z - 2 + "px",
		top: y0 * z + "px",
		height: (y1 - y0) * z + "px",
		minWidth: (x1 - x0) * z + 8 + "px",
		fontSize: line.size * z + "px",
		fontFamily: line.style.mono ? "ui-monospace, Courier, monospace" : line.style.serif ? "Times New Roman, Times, serif" : "Helvetica, Arial, sans-serif",
		fontWeight: line.style.bold ? "700" : "400",
		fontStyle: line.style.italic ? "italic" : "normal",
		color: `rgb(${line.color.map((c) => Math.round(c * 255)).join(",")})`,
		// Light text (dark UI screenshots) would vanish on the default white box.
		background: line.background
			? `rgb(${line.background.map((c) => Math.round(c * 255)).join(",")})`
			: luminance(line.color) > 0.6 ? "#333" : "#fff",
	});
	// Preview with the real font as soon as it is known. The loaded face is
	// already the right weight, so the browser must not embolden it again.
	const preview = (cssFamily) => {
		if (!cssFamily || !input.isConnected) return;
		input.style.fontFamily = `"${cssFamily}", ${input.style.fontFamily}`;
		input.style.fontWeight = "normal";
		input.style.fontStyle = "normal";
		input.style.fontSize = line.size * z + "px";
		fit();
	};
	if (line.kind === "ocr") ensureMatched(line).then((m) => preview(m?.cssFamily));
	else resolveFont(line).then((found) => preview(found?.cssFamily));
	const fit = () => (input.style.width = Math.max(input.value.length, line.text.length) * line.size * z * 0.55 + 16 + "px");
	fit();
	input.addEventListener("input", fit);
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") finishEdit(true);
		else if (ev.key === "Escape") finishEdit(false);
	});
	input.addEventListener("blur", () => finishEdit(true));
	page.el.append(input);
	input.focus();
	input.select();
	state.editing = { page, line, input };
}

// Edit a paragraph as one block of text; it's re-wrapped on the page when done.
function startParaEdit(page, para) {
	finishEdit(true);
	closeOverlays();
	const z = state.zoom;
	const first = para.lines[0];
	const left = Math.min(para.firstX, para.restX ?? para.firstX, para.bbox[0]);
	const area = document.createElement("textarea");
	area.className = "editor para-editor";
	area.value = para.text;
	area.spellcheck = true;
	const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
	Object.assign(area.style, {
		left: left * z - 4 + "px",
		top: para.bbox[1] * z - 4 + "px",
		width: (para.right - left) * z + 8 + "px",
		fontSize: first.size * z + "px",
		lineHeight: para.lineGap * z + "px",
		fontFamily: first.style.mono ? "ui-monospace, Courier, monospace" : first.style.serif ? "Times New Roman, Times, serif" : "Helvetica, Arial, sans-serif",
		fontWeight: first.style.bold ? "700" : "400",
		fontStyle: first.style.italic ? "italic" : "normal",
		textAlign: para.justified ? "justify" : "left",
		textIndent: (para.marker ? 0 : (para.firstX - left) * z) + "px",
		color: css(first.color),
		background: first.background ? css(first.background) : luminance(first.color) > 0.6 ? "#333" : "#fff",
	});
	const grow = () => {
		area.style.height = "0px";
		area.style.height = area.scrollHeight + 2 + "px";
	};
	const preview = (cssFamily) => {
		if (!cssFamily || !area.isConnected) return;
		area.style.fontFamily = `"${cssFamily}", ${area.style.fontFamily}`;
		area.style.fontWeight = "normal";
		area.style.fontStyle = "normal";
		grow();
	};
	if (first.kind === "ocr") ensureMatched(first).then((m) => preview(m?.cssFamily));
	else resolveFont(first).then((found) => preview(found?.cssFamily));
	area.addEventListener("input", grow);
	let warned = false;
	area.addEventListener("input", () => {
		warned = false;
		hint.classList.remove("warn");
		hint.textContent = hintText;
	});
	area.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && !ev.shiftKey) {
			ev.preventDefault();
			// Growing into the text below: say so once, apply on the second Enter.
			const over = !warned && overlapBelow(page, para, area.value);
			if (over) {
				warned = true;
				hint.classList.add("warn");
				hint.textContent = `${over} line(s) longer — it would overlap the text below. Shorten it, or press Enter again to apply anyway.`;
				return;
			}
			finishEdit(true);
		} else if (ev.key === "Escape") finishEdit(false);
	});
	area.addEventListener("blur", () => finishEdit(true));
	const hint = document.createElement("div");
	hint.className = "para-hint";
	const hintText = `${para.marker ? "List item" : "Paragraph"} · Enter to apply · Shift+Enter for a line break · Esc to cancel · L for line-by-line`;
	hint.textContent = hintText;
	hint.style.left = left * z - 4 + "px";
	hint.style.top = para.bbox[1] * z - 26 + "px";
	page.el.append(hint, area);
	grow();
	area.focus();
	state.editing = { page, para, input: area, hint };
}

// Extra lines the new text needs, if they'd run into other text below; else 0.
function overlapBelow(page, para, text) {
	try {
		const rows = state.engine.paragraphRows(page.index, para, text);
		const extra = rows - para.lines.length;
		if (extra <= 0) return 0;
		const last = para.lines[para.lines.length - 1];
		const top = para.bbox[3];
		const bottom = last.origin[1] + extra * para.lineGap + para.size * 0.25;
		const left = Math.min(para.firstX, para.restX ?? para.firstX), right = para.right;
		const others = [...page.lines, ...page.ocrLines].filter((l) => !para.lines.includes(l));
		return others.some((l) => l.bbox[1] < bottom && l.bbox[3] > top && l.bbox[0] < right && l.bbox[2] > left) ? extra : 0;
	} catch {
		return 0;
	}
}

async function applyParaEdit(page, para, text) {
	const first = para.lines[0];
	try {
		if (first.kind === "ocr") await ensureMatched(first);
		const flat = text.replace(/\s+/g, " ");
		if (flat.trim() && !state.engine.originalCovers(first, flat)) {
			status("The original font lacks some of these characters. Looking for the full font…");
			const found = await resolveFont(first);
			if (found) state.engine.setSubstitute(first, found.bytes, found.info);
		}
		pushHistory(page);
		const r = state.engine.replaceParagraph(page.index, para, text, currentLook());
		if (first.kind === "ocr") page.ocrLines = page.ocrLines.filter((l) => !para.lines.includes(l));
		page.lines = state.engine.extract(page.index).lines;
		rerenderPage(page);
		updateButtons();
		if (!text.trim()) return status("Paragraph removed.");
		const look = first.lastLook ? `, ${first.lastLook}` : "";
		const grew = r.lines > r.before ? ` It is ${r.lines - r.before} line(s) longer than before, so check it doesn't overlap the text below.` : "";
		status(`Paragraph re-wrapped (${r.before} → ${r.lines} lines) using ${first.lastFontLabel}${look}.${grew}`);
	} catch (err) {
		console.error(err);
		rollback();
		status(`Edit failed: ${err.message}`, true);
	}
}

const luminance = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

function finishEdit(commit) {
	const ed = state.editing;
	if (!ed) return;
	state.editing = null;
	ed.input.remove();
	ed.hint?.remove();
	const text = ed.input.value;
	if (ed.para) {
		if (commit && text.trim() !== ed.para.text.trim()) applyParaEdit(ed.page, ed.para, text);
		return;
	}
	if (!commit || text === ed.line.text) return;
	applyEdit(ed.page, ed.line, text);
}

// Scanned text has no font name: identify it from the pixels once per line.
function ensureMatched(line) {
	line.matchPromise ??= matchFont(line, status)
		.then((m) => {
			if (!m) return null;
			Object.assign(line, { fontKey: m.name, style: m.style, size: m.size, origin: m.origin, matched: m });
			status(`Detected font: ${m.family} ${m.weight} (${m.size.toFixed(1)} pt).`);
			return m;
		})
		.catch((err) => {
			console.warn("Font matching failed", err);
			return null;
		});
	return line.matchPromise;
}

async function applyEdit(page, line, text) {
	try {
		if (line.kind === "ocr") await ensureMatched(line);
		if (text.trim() && !state.engine.originalCovers(line, text)) {
			status("The original font lacks some of these characters. Looking for the full font…");
			const found = await resolveFont(line);
			if (found) state.engine.setSubstitute(line, found.bytes, found.info);
		}
		pushHistory(page);
		if (line.kind === "ocr") {
			state.engine.replaceOcrLine(page.index, line, text, currentLook());
			page.ocrLines = page.ocrLines.filter((l) => l !== line);
		} else {
			state.engine.replaceLine(page.index, line, text, currentLook());
		}
		page.lines = state.engine.extract(page.index).lines;
		rerenderPage(page);
		updateButtons();
		const look = line.lastLook ? `, ${line.lastLook}` + (line.lastBlur ? ` (blur ${line.lastBlur.toFixed(2)} pt)` : "") : "";
		status(text.trim() ? `Line updated using ${line.lastFontLabel}${look}.` : "Line removed.");
	} catch (err) {
		console.error(err);
		rollback();
		status(`Edit failed: ${err.message}`, true);
	}
}

// ---- OCR ------------------------------------------------------------------

async function runOcr(pages) {
	const btn = $("#ocr-all");
	btn.disabled = true;
	try {
		for (const [n, page] of pages.entries()) {
			const prefix = `OCR page ${page.index + 1} (${n + 1}/${pages.length})`;
			status(`${prefix}: starting…`);
			page.ocrLines = await ocrPage(state.engine, page.index, (m) => {
				if (m.status) status(`${prefix}: ${m.status} ${m.progress ? Math.round(m.progress * 100) + "%" : ""}`);
			});
			rerenderPage(page);
		}
		status(`OCR finished. Orange boxes are recognised text. Click one to edit it.`);
		warmUpFonts();
	} catch (err) {
		console.error(err);
		status(`OCR failed: ${err.message}`, true);
	} finally {
		btn.disabled = false;
		updateButtons();
	}
}

// ---- Save -----------------------------------------------------------------

const exportRes = $("#export-res");

// "Original size" only makes sense for a document that came from an image.
function setExportOptions() {
	const images = state.pageMeta.filter(Boolean);
	const original = exportRes.querySelector('option[value="original"]');
	original.hidden = original.disabled = !images.length;
	original.textContent =
		state.pageMeta.length === 1 && images.length === 1 ? `Original size (${images[0].width}×${images[0].height})` : "Original size (image pages)";
	// Fresh document: original size if it has image pages. Later: keep the user's choice if still valid.
	if (state.history.length === 0) exportRes.value = images.length ? "original" : "150";
	else if (exportRes.value === "original" && !images.length) exportRes.value = "150";
}

const defaultFormat = () => (state.source.kind === "image" ? state.source.format : "pdf");

function download(format = defaultFormat()) {
	finishEdit(true);
	textBoxes.closeEditor(true);
	document.querySelectorAll("details.menu[open]").forEach((m) => (m.open = false));
	const base = state.fileName.replace(/\.[a-z0-9]+$/i, "");
	try {
		if (format === "pdf") {
			const bytes = state.engine.save();
			saveFile(bytes, `${base}-edited.pdf`, "application/pdf");
			state.dirty = false;
			return;
		}
		status(`Rendering ${format.toUpperCase()}…`);
		const res = exportRes.value;
		// "Original size": pages made from an image keep its pixel size, other pages use 150 dpi.
		const scaleFor = (i) => (res === "original" ? state.pageMeta[i]?.scale ?? 150 / 72 : +res / 72);
		const images = state.engine.exportImages(format, scaleFor);
		const mime = format === "jpg" ? "image/jpeg" : "image/png";
		if (images.length === 1) {
			saveFile(images[0], `${base}-edited.${format}`, mime);
		} else {
			const files = images.map((data, i) => ({ name: `${base}-page-${String(i + 1).padStart(2, "0")}.${format}`, data }));
			saveFile(zip(files), `${base}-edited-${format}.zip`, "application/zip", `${images.length} pages`);
		}
		state.dirty = false;
	} catch (err) {
		console.error(err);
		status(`Save failed: ${err.message}`, true);
	}
}

function saveFile(bytes, name, type, detail = "") {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([bytes], { type }));
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
	status(`Saved ${name} (${detail ? detail + ", " : ""}${(bytes.length / 1024).toFixed(0)} KB).`);
}

// ---- Zoom & UI wiring -----------------------------------------------------

function setZoom(z) {
	finishEdit(true);
	textBoxes.closeEditor(true);
	closeOverlays();
	state.zoom = Math.min(4, Math.max(0.25, z));
	$("#zoom-label").textContent = Math.round(state.zoom * 100) + "%";
	for (const page of state.pages) {
		layoutPage(page);
		page.rendered = false;
		page.el.replaceChildren();
		observer.unobserve(page.el);
		observer.observe(page.el);
	}
}

function updateButtons() {
	const n = comments.count();
	$("#comments-toggle").textContent = n ? `Comments (${n})` : "Comments";
	$("#undo").disabled = state.history.length === 0;
	$("#redo").disabled = state.future.length === 0;
	const pending = state.pages.filter((p) => p.scanned && !p.ocrLines.length);
	const ocrBtn = $("#ocr-all");
	ocrBtn.hidden = pending.length === 0;
	ocrBtn.textContent = `Run OCR (${pending.length})`;
	ocrBtn.title = `Recognise text on ${pending.length} scanned page(s) so it can be edited`;
	ocrBtn.onclick = () => runOcr(pending);
}

// ---- Look of new text (match / blur / aged) ------------------------------

const lookMatch = $("#look-match"), lookBlur = $("#look-blur"), lookAged = $("#look-aged");
const currentLook = () => ({ match: lookMatch.checked, blur: +lookBlur.value / 100, aged: +lookAged.value / 100 });
try {
	const saved = JSON.parse(localStorage.getItem("look") || "null");
	if (saved) (lookMatch.checked = !!saved.match), (lookBlur.value = saved.blur * 100), (lookAged.value = saved.aged * 100);
} catch {}
const saveLook = () => {
	try {
		localStorage.setItem("look", JSON.stringify(currentLook()));
	} catch {}
	const l = currentLook();
	const parts = [l.match && "match original (scanned lines)", l.blur && `blur ${lookBlur.value}%`, l.aged && `aged ${lookAged.value}%`].filter(Boolean);
	status(`New edits: ${parts.length ? parts.join(", ") : "crisp text"}. Undo and re-edit a line to change it.`);
};
for (const el of [lookMatch, lookBlur, lookAged]) el.addEventListener("input", saveLook);

$("#file").addEventListener("change", (e) => {
	openFiles(e.target.files);
	e.target.value = ""; // allow re-opening the same file
});
const insertInput = $("#insert-file");
let insertAt = 0;
insertInput.addEventListener("change", (e) => {
	insertFiles(e.target.files, insertAt);
	e.target.value = "";
});
// ---- Tools: one placing tool at a time --------------------------------------

let tool = null; // "text" | "comment" | "sign" | "whiteout" | null
const TOOL_BUTTONS = { text: "#text-mode", comment: "#comment-mode", sign: "#sign-menu > summary", whiteout: "#whiteout-mode" };

function setTool(name) {
	tool = name;
	if (textBoxes.mode !== (name === "text")) textBoxes.setMode(name === "text");
	if (comments.mode !== (name === "comment")) comments.setMode(name === "comment");
	if (signatures.mode !== (name === "sign")) signatures.setMode(name === "sign");
	document.body.classList.toggle("whiteout-mode", name === "whiteout");
	if (name === "whiteout") status("Drag over anything to cover it. Text under it is removed. Press Esc to stop.");
	for (const [k, sel] of Object.entries(TOOL_BUTTONS)) $(sel).classList.toggle("active", k === name);
}
const toggleTool = (name) => state.engine && setTool(tool === name ? null : name);
// The signature dialog can be cancelled: then the tool turns itself off.
document.addEventListener("tool-changed", () => tool === "sign" && !signatures.mode && setTool(null));

$("#text-mode").onclick = () => toggleTool("text");
$("#comment-mode").onclick = () => toggleTool("comment");
$("#whiteout-mode").onclick = () => toggleTool("whiteout");
$("#sign-place").onclick = () => ($("#sign-menu").open = false, setTool("sign"));
$("#sign-new").onclick = () => {
	$("#sign-menu").open = false;
	signatures.newSignature().then(() => signatures.mode && setTool("sign"));
};
$("#comments-toggle").onclick = () => comments.showPanel(!document.body.classList.contains("show-comments"));

// Whiteout: drag a box on the page.
function whiteoutStart(page, ev) {
	if (tool !== "whiteout" || ev.button !== 0) return;
	ev.preventDefault();
	const z = state.zoom;
	const r = page.el.getBoundingClientRect();
	const at = (e) => [clamp((e.clientX - r.left) / z, 0, page.width), clamp((e.clientY - r.top) / z, 0, page.height)];
	const start = at(ev);
	const box = document.createElement("div");
	box.className = "whiteout-rect";
	page.el.append(box);
	let rect = [...start, ...start];
	const move = (e) => {
		const p = at(e);
		rect = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])];
		Object.assign(box.style, { left: rect[0] * z + "px", top: rect[1] * z + "px", width: (rect[2] - rect[0]) * z + "px", height: (rect[3] - rect[1]) * z + "px" });
	};
	const up = () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		box.remove();
		if (rect[2] - rect[0] > 2 && rect[3] - rect[1] > 2) applyWhiteout(page, rect);
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
}

function applyWhiteout(page, rect) {
	try {
		pushHistory(page);
		state.engine.whiteout(page.index, rect);
		const hit = (b) => b[0] < rect[2] && b[2] > rect[0] && b[1] < rect[3] && b[3] > rect[1];
		page.ocrLines = page.ocrLines.filter((l) => !hit(l.bbox));
		page.lines = state.engine.extract(page.index).lines;
		rerenderPage(page);
		updateButtons();
		status("Area covered. Undo (⌘Z) if you need it back.");
	} catch (err) {
		console.error(err);
		rollback();
		status(`Whiteout failed: ${err.message}`, true);
	}
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Warn before closing the tab with unsaved changes.
window.addEventListener("beforeunload", (e) => {
	if (!state.dirty) return;
	e.preventDefault();
	e.returnValue = "";
});

document.addEventListener("comments-panel", (e) => $("#comments-toggle").classList.toggle("active", e.detail));
// Close the Text look menu when clicking elsewhere.
document.addEventListener("click", (e) => {
	for (const m of document.querySelectorAll("details.menu[open]")) if (!m.contains(e.target)) m.open = false;
});
document.addEventListener("keydown", (e) => {
	const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
	if (e.key === "Escape" && !typing) {
		setTool(null);
		comments.closeCard();
		textBoxes.deselect();
		signatures.deselect();
	}
	const plain = !typing && !e.metaKey && !e.ctrlKey && !e.altKey && state.engine && !document.querySelector(".modal-back");
	const key = e.key.toLowerCase();
	const shortcuts = { t: "text", c: "comment", s: "sign", w: "whiteout" };
	if (plain && shortcuts[key]) toggleTool(shortcuts[key]);
	if (plain && key === "l") setUnit("line");
	if (plain && key === "p") setUnit("para");
	if (plain && (e.key === "Delete" || e.key === "Backspace")) {
		if (textBoxes.selected) (e.preventDefault(), textBoxes.removeSelected());
		else if (signatures.selected) (e.preventDefault(), signatures.removeSelected());
	}
});
$("#zoom-in").onclick = () => setZoom(state.zoom * 1.25);
$("#zoom-out").onclick = () => setZoom(state.zoom / 1.25);
$("#undo").onclick = () => undo();
$("#redo").onclick = () => redo();
document.querySelectorAll(".download-menu [data-format]").forEach((b) => (b.onclick = () => download(b.dataset.format)));
$("#show-boxes").addEventListener("change", (e) => pagesEl.classList.toggle("show-boxes", e.target.checked));

// Edit unit: line by line, or whole paragraphs / list items.
function setUnit(unit) {
	finishEdit(true);
	state.unit = unit;
	document.querySelectorAll("#unit button").forEach((b) => b.classList.toggle("on", b.dataset.unit === unit));
	try {
		localStorage.setItem("editUnit", unit);
	} catch {}
	for (const page of state.pages) if (page.rendered) rerenderPage(page);
	if (state.engine) status(unit === "para" ? "Click a paragraph or list item to edit it as a whole. It re-wraps to fit." : "Click a line to edit just that line.");
}
document.querySelectorAll("#unit button").forEach((b) => (b.onclick = () => setUnit(b.dataset.unit)));
try {
	if (localStorage.getItem("editUnit") === "para") setUnit("para");
} catch {}
pagesEl.classList.add("show-boxes");

document.addEventListener("keydown", (e) => {
	if (!(e.metaKey || e.ctrlKey) || !state.engine) return;
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
	const k = e.key.toLowerCase();
	if (k === "z" && !state.editing && !typing) (e.preventDefault(), e.shiftKey ? redo() : undo());
	if (k === "y" && !state.editing && !typing) (e.preventDefault(), redo());
	if (e.key === "s") (e.preventDefault(), download());
	if (e.key === "o") (e.preventDefault(), $("#file").click());
});

viewer.addEventListener("dragover", (e) => {
	e.preventDefault();
	$("#drop").classList.add("over");
});
viewer.addEventListener("dragleave", () => $("#drop").classList.remove("over"));
viewer.addEventListener("drop", (e) => {
	e.preventDefault();
	$("#drop").classList.remove("over");
	// With a document open, dropped files are added at the end; otherwise they're opened (merged).
	if (state.engine) insertFiles(e.dataTransfer.files, state.pages.length);
	else openFiles(e.dataTransfer.files);
});
