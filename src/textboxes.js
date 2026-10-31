// Text boxes: write anywhere on top of the page. Stored as standard PDF FreeText
// annotations by PdfEngine (editable later in Acrobat/Preview, and printed).
//
// Add text (T) → click on a page → type. Click a box to select it (format bar,
// drag to move, Delete to remove), double-click to edit its text.

const STYLE_KEY = "textBoxStyle";
const FONTS = [
	["Helv", "Helvetica", "Helvetica, Arial, sans-serif"],
	["TiRo", "Times", '"Times New Roman", Times, serif'],
	["Cour", "Courier", '"Courier New", Courier, monospace'],
];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];
const COLORS = [
	["#1a1a1f", "Black"],
	["#294a85", "Navy"],
	["#1f6f43", "Green"],
	["#a31f1f", "Red"],
	["#6b7280", "Gray"],
];
const DEFAULT_STYLE = { font: "Helv", size: 12, color: [0.1, 0.1, 0.12], align: 0 };

export function createTextBoxes({ state, status, beforeChange, afterChange }) {
	let mode = false;
	let selected = null; // { page, box, el }
	let editor = null; // { page, box|null, at, el, textarea, bar }

	function setMode(on) {
		mode = on;
		document.body.classList.toggle("text-mode", on);
		if (on) status("Click anywhere on a page to add text. Press Esc to stop.");
		document.dispatchEvent(new CustomEvent("text-mode", { detail: on }));
	}

	// ---- Overlays for existing boxes -------------------------------------

	function overlays(page) {
		const z = state.zoom;
		return (page.textBoxes || []).map((box) => {
			const [x0, y0, x1, y1] = box.bounds;
			const el = document.createElement("div");
			el.className = "textbox";
			el.dataset.id = box.id;
			Object.assign(el.style, { left: x0 * z + "px", top: y0 * z + "px", width: (x1 - x0) * z + "px", height: (y1 - y0) * z + "px" });
			el.title = "Click to select · double-click to edit · drag to move";
			el.addEventListener("click", (ev) => ev.stopPropagation());
			el.addEventListener("dblclick", (ev) => {
				ev.stopPropagation();
				openEditor(page, box);
			});
			el.addEventListener("pointerdown", (ev) => startDrag(ev, page, box, el));
			return el;
		});
	}

	function refresh(page) {
		page.el.querySelectorAll(".textbox").forEach((el) => el.remove());
		page.el.append(...overlays(page));
	}

	// ---- Selection and dragging ------------------------------------------

	function markSelected(page, box, el) {
		el.classList.add("selected");
		selected = { page, box, el };
		const bar = formatBar(page, box.style, (style) => {
			const at = fitInPage(page, [box.bounds[0], box.bounds[1]], box.text, style);
			change(page, () => state.engine.updateTextBox(page.index, box.id, { style, at }), "Text box updated.", box.id);
		}, {
			edit: () => openEditor(page, box),
			remove: () => removeBox(page, box),
		});
		bar.classList.add("floating");
		placeBar(bar, page, box.bounds);
		page.el.append(bar);
		selected.bar = bar;
	}

	function select(page, box, el) {
		deselect();
		markSelected(page, box, el);
	}

	function deselect() {
		if (!selected) return;
		selected.el?.classList.remove("selected");
		selected.bar?.remove();
		selected = null;
	}

	function startDrag(ev, page, box, el) {
		if (ev.button !== 0 || editor) return;
		ev.stopPropagation();
		ev.preventDefault();
		const z = state.zoom;
		const sx = ev.clientX, sy = ev.clientY;
		let moved = false;
		el.setPointerCapture(ev.pointerId);
		const move = (e) => {
			const dx = e.clientX - sx, dy = e.clientY - sy;
			if (!moved && Math.hypot(dx, dy) < 3) return;
			if (!moved) {
				moved = true;
				select(page, box, el);
				selected.bar.hidden = true;
				el.classList.add("dragging");
			}
			el.style.transform = `translate(${dx}px, ${dy}px)`;
		};
		const up = (e) => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.classList.remove("dragging");
			if (!moved) return select(page, box, el);
			const [x0, y0, x1, y1] = box.bounds;
			const nx = clamp(x0 + (e.clientX - sx) / z, 0, Math.max(0, page.width - (x1 - x0)));
			const ny = clamp(y0 + (e.clientY - sy) / z, 0, Math.max(0, page.height - (y1 - y0)));
			change(page, () => state.engine.updateTextBox(page.index, box.id, { at: [nx, ny] }), "Text box moved.", box.id);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	}

	// ---- Editor ----------------------------------------------------------

	function place(page, ev) {
		if (!mode) return false;
		const rect = page.el.getBoundingClientRect();
		const z = state.zoom;
		const style = savedStyle();
		const x = clamp((ev.clientX - rect.left) / z, 0, page.width - 20);
		const y = clamp((ev.clientY - rect.top) / z - style.size * 0.6, 0, page.height - style.size);
		openEditor(page, null, [x, y]);
		return true;
	}

	function openEditor(page, box, at = null) {
		closeEditor(true);
		deselect();
		const z = state.zoom;
		let style = { ...(box ? box.style : savedStyle()) };
		const pos = box ? [box.bounds[0], box.bounds[1]] : at;

		const wrap = document.createElement("div");
		wrap.className = "textbox-editor";
		wrap.style.left = pos[0] * z + "px";
		wrap.style.top = pos[1] * z + "px";
		wrap.addEventListener("click", (ev) => ev.stopPropagation());
		wrap.addEventListener("pointerdown", (ev) => ev.stopPropagation());

		const textarea = document.createElement("textarea");
		textarea.value = box ? box.text : "";
		textarea.placeholder = "Type here";
		textarea.spellcheck = true;
		textarea.rows = 1;
		wrap.append(textarea);

		const actions = {
			done: () => closeEditor(true),
			remove: box ? () => (closeEditor(false), removeBox(page, box)) : () => closeEditor(false),
		};
		// Rebuilt on every style change so the selected swatch/size/alignment stay in sync,
		// and focus goes back to the text so typing and ⌘↵ keep working.
		const makeBar = () => {
			const b = formatBar(page, style, (s) => {
				style = s;
				saveStyle(s);
				apply();
				const next = makeBar();
				editor.bar.replaceWith(next);
				editor.bar = next;
				textarea.focus();
			}, actions);
			placeBar(b, page, [pos[0], pos[1], pos[0] + 200, pos[1] + style.size * 1.3]);
			return b;
		};
		const bar = makeBar();
		page.el.append(wrap, bar);

		const apply = () => {
			const font = FONTS.find((f) => f[0] === style.font) || FONTS[0];
			Object.assign(textarea.style, {
				fontFamily: font[2],
				fontSize: style.size * z + "px",
				lineHeight: "1.2",
				color: toHex(style.color),
				textAlign: ["left", "center", "right"][style.align || 0],
			});
			// Grow with the content: no scrollbars, no wrapping (the PDF box won't wrap either).
			textarea.style.width = "0px";
			textarea.style.height = "0px";
			textarea.style.width = Math.max(40, textarea.scrollWidth + 4) + "px";
			textarea.style.height = textarea.scrollHeight + "px";
		};
		apply();
		textarea.addEventListener("input", apply);
		textarea.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") (ev.preventDefault(), ev.stopPropagation(), closeEditor(false));
			if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.preventDefault(), closeEditor(true));
		});
		textarea.focus();
		if (box) textarea.select();

		editor = { page, box, at: pos, el: wrap, textarea, bar, style: () => style };
		wrap.classList.toggle("existing", !!box);
		if (box) page.el.querySelector(`.textbox[data-id="${box.id}"]`)?.classList.add("editing");
	}

	// commit=false discards (Esc / Cancel).
	function closeEditor(commit) {
		if (!editor) return;
		const { page, box, at, el, textarea, bar } = editor;
		const style = editor.style();
		editor = null;
		el.remove();
		bar.remove();
		page.el.querySelectorAll(".textbox.editing").forEach((x) => x.classList.remove("editing"));
		if (!commit) return;
		const text = textarea.value.replace(/\s+$/, "");
		if (!box) {
			if (!text.trim()) return;
			const [x, y] = fitInPage(page, at, text, style);
			change(page, () => state.engine.addTextBox(page.index, [x, y], text, style), "Text added.");
		} else if (!text.trim()) {
			removeBox(page, box);
		} else if (text !== box.text || JSON.stringify(style) !== JSON.stringify(box.style)) {
			const at = fitInPage(page, [box.bounds[0], box.bounds[1]], text, style);
			change(page, () => state.engine.updateTextBox(page.index, box.id, { text, style, at }), "Text box updated.", box.id);
		}
	}

	// Keep a new box inside the page when it's typed near the right/bottom edge.
	function fitInPage(page, [x, y], text, style) {
		const { w, h } = state.engine.measureTextBox(text, style);
		return [clamp(x, 0, Math.max(0, page.width - w)), clamp(y, 0, Math.max(0, page.height - h))];
	}

	function removeBox(page, box) {
		deselect();
		change(page, () => state.engine.deleteTextBox(page.index, box.id), "Text box deleted.");
	}

	function change(page, fn, message, reselectId = null) {
		try {
			beforeChange(page);
			const result = fn();
			page.textBoxes = state.engine.listTextBoxes(page.index);
			deselect();
			afterChange(page);
			status(message);
			const id = reselectId ?? (typeof result === "number" ? result : null);
			const box = reselectId != null && page.textBoxes.find((b) => b.id === id);
			const el = box && page.el.querySelector(`.textbox[data-id="${box.id}"]`);
			if (el) select(page, box, el);
			return result;
		} catch (err) {
			console.error(err);
			state.history.pop();
			status(`Text box failed: ${err.message}`, true);
		}
	}

	// ---- Format bar ------------------------------------------------------

	function formatBar(page, style, onStyle, actions) {
		const bar = document.createElement("div");
		bar.className = "format-bar";
		bar.addEventListener("click", (ev) => ev.stopPropagation());
		bar.addEventListener("pointerdown", (ev) => ev.stopPropagation());
		const set = (patch) => onStyle({ ...style, ...patch });

		const font = document.createElement("select");
		font.title = "Font";
		for (const [v, label] of FONTS) font.append(new Option(label, v, false, v === style.font));
		font.onchange = () => set({ font: font.value });

		const size = document.createElement("select");
		size.title = "Size";
		const sizes = SIZES.includes(Math.round(style.size)) ? SIZES : [...SIZES, Math.round(style.size)].sort((a, b) => a - b);
		for (const v of sizes) size.append(new Option(`${v} pt`, v, false, v === Math.round(style.size)));
		size.onchange = () => set({ size: +size.value });

		const swatches = document.createElement("div");
		swatches.className = "swatches";
		const current = toHex(style.color);
		for (const [hex, name] of COLORS) {
			const b = document.createElement("button");
			b.className = "swatch" + (hex === current ? " on" : "");
			b.style.background = hex;
			b.title = name;
			b.onclick = () => set({ color: fromHex(hex) });
			swatches.append(b);
		}
		const custom = document.createElement("input");
		custom.type = "color";
		custom.value = current;
		custom.title = "Custom color";
		custom.onchange = () => set({ color: fromHex(custom.value) }); // on close of the picker, not every drag
		swatches.append(custom);

		const align = document.createElement("div");
		align.className = "seg";
		["Left", "Center", "Right"].forEach((label, i) => {
			const b = document.createElement("button");
			b.className = (style.align || 0) === i ? "on" : "";
			b.title = `Align ${label.toLowerCase()}`;
			b.innerHTML = alignIcon(i);
			b.onclick = () => set({ align: i });
			align.append(b);
		});

		bar.append(font, size, swatches, align);
		const sep = document.createElement("span");
		sep.className = "sep";
		bar.append(sep);
		if (actions.edit) bar.append(textButton("Edit", actions.edit));
		if (actions.done) bar.append(textButton("Done", actions.done, "primary"));
		if (actions.remove) bar.append(textButton("Delete", actions.remove, "danger"));
		return bar;
	}

	function placeBar(bar, page, bounds) {
		const z = state.zoom;
		bar.style.left = Math.max(0, bounds[0] * z) + "px";
		// Above the box when there's room, otherwise below it.
		if (bounds[1] * z > 48) (bar.style.top = bounds[1] * z - 44 + "px");
		else bar.style.top = bounds[3] * z + 8 + "px";
	}

	return {
		overlays,
		refresh,
		place,
		deselect,
		closeEditor,
		get mode() {
			return mode;
		},
		setMode,
		get selected() {
			return selected;
		},
		get editing() {
			return !!editor;
		},
		removeSelected() {
			if (selected) removeBox(selected.page, selected.box);
		},
	};
}

function textButton(label, onClick, cls = "") {
	const b = document.createElement("button");
	b.className = `btn small ${cls}`.trim();
	b.textContent = label;
	b.onclick = (ev) => {
		ev.stopPropagation();
		onClick();
	};
	return b;
}

// Three bars, the middle one shorter, aligned left / center / right.
function alignIcon(i) {
	const lines = [18, 12, 18].map((len, k) => {
		const start = i === 0 ? 3 : i === 1 ? 12 - len / 2 : 21 - len;
		return `<rect x="${start}" y="${6 + k * 5}" width="${len}" height="2" rx="1"/>`;
	});
	return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${lines.join("")}</svg>`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toHex = (c) => "#" + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
const fromHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function savedStyle() {
	try {
		return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(STYLE_KEY) || "{}") };
	} catch {
		return { ...DEFAULT_STYLE };
	}
}

function saveStyle(style) {
	try {
		localStorage.setItem(STYLE_KEY, JSON.stringify(style));
	} catch {}
}
