const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

function status(msg, isError = false) {
	statusEl.textContent = msg;
	statusEl.classList.toggle("error", isError);
}

let PdfEngine, ocrPage, resolveFont, matchFont, warmUpFonts;
try {
	({ PdfEngine } = await import("./pdf-engine.js"));
	({ ocrPage } = await import("./ocr.js"));
	({ resolveFont } = await import("./font-service.js"));
	({ matchFont, warmUp: warmUpFonts } = await import("./font-match.js"));
	status("Ready. Open a PDF to start.");
} catch (err) {
	console.error(err);
	status("Failed to load the PDF engine. Serve this folder with `python3 serve.py` instead of opening the file directly.", true);
	throw err;
}

const state = {
	engine: null,
	fileName: "document.pdf",
	pages: [], // { index, width, height, lines, ocrLines, scanned, el, rendered }
	history: [], // { bytes, pageIndex, ocrLines }
	zoom: 1,
	editing: null,
};

const pagesEl = $("#pages");
const viewer = $("#viewer");

// ---- Loading --------------------------------------------------------------

async function openFile(file) {
	if (!file) return;
	try {
		status(`Opening ${file.name}…`);
		const bytes = new Uint8Array(await file.arrayBuffer());
		state.engine = new PdfEngine(bytes);
		state.fileName = file.name;
		state.history = [];
		buildPages();
		document.body.classList.add("has-doc");
		updateButtons();
		const scanned = state.pages.filter((p) => p.scanned).length;
		status(`${file.name}: ${state.pages.length} page(s)` + (scanned ? `, ${scanned} scanned. Run OCR to edit them.` : "."));
	} catch (err) {
		console.error(err);
		status(`Could not open ${file.name}: ${err.message}`, true);
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
		const page = { index: i, width, height, lines, ocrLines: [], scanned, el, rendered: false };
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

	page.el.replaceChildren(img, label, ...lineBoxes(page));
	if (page.scanned && !page.ocrLines.length) page.el.append(scanBadge(page));
}

function rerenderPage(page) {
	page.rendered = false;
	renderPage(page);
}

function lineBoxes(page) {
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
			ev.stopPropagation();
			startEdit(page, line);
		});
		return box;
	});
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

function finishEdit(commit) {
	const ed = state.editing;
	if (!ed) return;
	state.editing = null;
	ed.input.remove();
	const text = ed.input.value;
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
		state.history.push({ bytes: state.engine.snapshot(), pageIndex: page.index, ocrLines: page.ocrLines });
		if (line.kind === "ocr") {
			state.engine.replaceOcrLine(page.index, line, text);
			page.ocrLines = page.ocrLines.filter((l) => l !== line);
		} else {
			state.engine.replaceLine(page.index, line, text);
		}
		page.lines = state.engine.extract(page.index).lines;
		rerenderPage(page);
		updateButtons();
		status(text.trim() ? `Line updated using ${line.lastFontLabel}.` : "Line removed.");
	} catch (err) {
		console.error(err);
		state.history.pop();
		status(`Edit failed: ${err.message}`, true);
	}
}

function undo() {
	finishEdit(false);
	const entry = state.history.pop();
	if (!entry) return;
	state.engine = new PdfEngine(entry.bytes);
	const page = state.pages[entry.pageIndex];
	page.ocrLines = entry.ocrLines;
	page.lines = state.engine.extract(page.index).lines;
	rerenderPage(page);
	updateButtons();
	status("Undone.");
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

function download() {
	finishEdit(true);
	try {
		const bytes = state.engine.save();
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
		a.download = state.fileName.replace(/\.pdf$/i, "") + "-edited.pdf";
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
		status(`Saved ${a.download} (${(bytes.length / 1024).toFixed(0)} KB).`);
	} catch (err) {
		console.error(err);
		status(`Save failed: ${err.message}`, true);
	}
}

// ---- Zoom & UI wiring -----------------------------------------------------

function setZoom(z) {
	finishEdit(true);
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
	$("#undo").disabled = state.history.length === 0;
	const pending = state.pages.filter((p) => p.scanned && !p.ocrLines.length);
	const ocrBtn = $("#ocr-all");
	ocrBtn.hidden = pending.length === 0;
	ocrBtn.textContent = `OCR scanned pages (${pending.length})`;
	ocrBtn.onclick = () => runOcr(pending);
}

$("#file").addEventListener("change", (e) => openFile(e.target.files[0]));
$("#zoom-in").onclick = () => setZoom(state.zoom * 1.25);
$("#zoom-out").onclick = () => setZoom(state.zoom / 1.25);
$("#undo").onclick = undo;
$("#download").onclick = download;
$("#show-boxes").addEventListener("change", (e) => pagesEl.classList.toggle("show-boxes", e.target.checked));
pagesEl.classList.add("show-boxes");

document.addEventListener("keydown", (e) => {
	if (!(e.metaKey || e.ctrlKey) || !state.engine) return;
	if (e.key === "z" && !state.editing) (e.preventDefault(), undo());
	if (e.key === "s") (e.preventDefault(), download());
});

viewer.addEventListener("dragover", (e) => {
	e.preventDefault();
	$("#drop").classList.add("over");
});
viewer.addEventListener("dragleave", () => $("#drop").classList.remove("over"));
viewer.addEventListener("drop", (e) => {
	e.preventDefault();
	$("#drop").classList.remove("over");
	openFile(e.dataTransfer.files[0]);
});
