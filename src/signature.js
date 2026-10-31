// Signatures: draw one (or use a photo/scan of one), then click a page to place
// it. Placed signatures can be dragged, resized from the corner, and deleted.
// The last signature is remembered in this browser for next time.

const STORE_KEY = "signature";
const INKS = [
	["#0b1f5c", "Blue-black"],
	["#111111", "Black"],
	["#1f3fbf", "Blue"],
];

export function createSignatures({ state, status, beforeChange, afterChange }) {
	let mode = false;
	let current = null; // { width, height, rgb, alpha, dataUrl }
	let selected = null; // { page, sig, el }

	try {
		const saved = localStorage.getItem(STORE_KEY);
		if (saved) loadDataUrl(saved).then((s) => (current = s));
	} catch {}

	// ---- Mode: pick a signature first, then place it -----------------------

	async function setMode(on) {
		if (on && !current) {
			const made = await openDialog();
			if (!made) return setMode(false);
		}
		mode = on;
		document.body.classList.toggle("sign-mode", on);
		if (on) status("Click on a page to place your signature. Press Esc to stop. (Sign ▾ → New signature to change it.)");
		document.dispatchEvent(new CustomEvent("tool-changed"));
	}

	function place(page, ev) {
		if (!mode || !current) return false;
		const rect = page.el.getBoundingClientRect();
		const z = state.zoom;
		const w = Math.min(160, page.width * 0.4);
		const h = (w * current.height) / current.width;
		const x = clamp((ev.clientX - rect.left) / z - w / 2, 0, page.width - w);
		const y = clamp((ev.clientY - rect.top) / z - h / 2, 0, page.height - h);
		change(page, () => state.engine.addSignature(page.index, [x, y, x + w, y + h], current), "Signature added. Drag to move, drag the corner to resize.", true);
		return true;
	}

	// ---- Overlays ------------------------------------------------------------

	function overlays(page) {
		const z = state.zoom;
		return (page.signatures || []).map((sig) => {
			const [x0, y0, x1, y1] = sig.bounds;
			const el = document.createElement("div");
			el.className = "signature";
			el.dataset.id = sig.id;
			Object.assign(el.style, { left: x0 * z + "px", top: y0 * z + "px", width: (x1 - x0) * z + "px", height: (y1 - y0) * z + "px" });
			el.title = "Drag to move · drag the corner to resize · Delete to remove";
			const handle = document.createElement("span");
			handle.className = "signature-handle";
			el.append(handle);
			el.addEventListener("click", (ev) => ev.stopPropagation());
			el.addEventListener("pointerdown", (ev) => drag(ev, page, sig, el, ev.target === handle));
			return el;
		});
	}

	function select(page, sig, el) {
		deselect();
		el.classList.add("selected");
		const bar = document.createElement("div");
		bar.className = "format-bar floating";
		bar.addEventListener("click", (ev) => ev.stopPropagation());
		bar.addEventListener("pointerdown", (ev) => ev.stopPropagation());
		const del = document.createElement("button");
		del.className = "btn small danger";
		del.textContent = "Delete";
		del.onclick = () => remove(page, sig);
		bar.append(del);
		const z = state.zoom;
		bar.style.left = sig.bounds[0] * z + "px";
		bar.style.top = (sig.bounds[1] * z > 44 ? sig.bounds[1] * z - 42 : sig.bounds[3] * z + 8) + "px";
		page.el.append(bar);
		selected = { page, sig, el, bar };
	}

	function deselect() {
		if (!selected) return;
		selected.el.classList.remove("selected");
		selected.bar.remove();
		selected = null;
	}

	function drag(ev, page, sig, el, resizing) {
		if (ev.button !== 0) return;
		ev.stopPropagation();
		ev.preventDefault();
		const z = state.zoom;
		const [x0, y0, x1, y1] = sig.bounds;
		const w0 = x1 - x0, h0 = y1 - y0;
		const sx = ev.clientX, sy = ev.clientY;
		let moved = false;
		let next = sig.bounds;
		el.setPointerCapture(ev.pointerId);
		const move = (e) => {
			const dx = (e.clientX - sx) / z, dy = (e.clientY - sy) / z;
			if (!moved && Math.hypot(dx * z, dy * z) < 3) return;
			moved = true;
			selected?.bar.remove();
			if (resizing) {
				// Keep the aspect ratio; width follows the pointer.
				const w = clamp(w0 + dx, 20, page.width - x0);
				const h = Math.min((w * h0) / w0, page.height - y0);
				const wf = (h * w0) / h0;
				next = [x0, y0, x0 + wf, y0 + h];
			} else {
				const nx = clamp(x0 + dx, 0, page.width - w0), ny = clamp(y0 + dy, 0, page.height - h0);
				next = [nx, ny, nx + w0, ny + h0];
			}
			Object.assign(el.style, { left: next[0] * z + "px", top: next[1] * z + "px", width: (next[2] - next[0]) * z + "px", height: (next[3] - next[1]) * z + "px" });
		};
		const up = () => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			if (!moved) return select(page, sig, el);
			change(page, () => state.engine.moveSignature(page.index, sig.id, next), resizing ? "Signature resized." : "Signature moved.", false, sig.id);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	}

	function remove(page, sig) {
		deselect();
		change(page, () => state.engine.deleteSignature(page.index, sig.id), "Signature deleted.");
	}

	function change(page, fn, message, isNew = false, reselect = null) {
		try {
			beforeChange(page);
			const result = fn();
			page.signatures = state.engine.listSignatures(page.index);
			deselect();
			afterChange(page);
			status(message);
			const id = reselect ?? (isNew ? result : null);
			const el = id != null && page.el.querySelector(`.signature[data-id="${id}"]`);
			const sig = el && page.signatures.find((s) => s.id === id);
			if (sig) select(page, sig, el);
		} catch (err) {
			console.error(err);
			state.history.pop();
			status(`Signature failed: ${err.message}`, true);
		}
	}

	// ---- Dialog: draw or upload ---------------------------------------------

	function openDialog() {
		return new Promise((resolve) => {
			const back = document.createElement("div");
			back.className = "modal-back";
			const box = document.createElement("div");
			box.className = "modal";
			box.setAttribute("role", "dialog");
			box.setAttribute("aria-label", "Create signature");
			box.innerHTML = `
				<h2>Your signature</h2>
				<div class="tabs" role="tablist">
					<button class="tab on" data-tab="draw">Draw</button>
					<button class="tab" data-tab="image">Use an image</button>
				</div>
				<div class="tab-body" data-body="draw">
					<canvas class="sign-pad" width="1000" height="360"></canvas>
					<div class="sign-row">
						<div class="inks"></div>
						<span class="sign-hint">Sign with your mouse, trackpad or finger</span>
						<button class="btn small" data-act="clear">Clear</button>
					</div>
				</div>
				<div class="tab-body" data-body="image" hidden>
					<label class="sign-drop">
						<input type="file" accept="image/*" hidden>
						<span>Choose a photo or scan of your signature</span>
						<small>The paper background is removed automatically.</small>
					</label>
					<img class="sign-preview" alt="" hidden>
				</div>
				<div class="modal-actions">
					<button class="btn" data-act="cancel">Cancel</button>
					<button class="btn primary" data-act="use" disabled>Use signature</button>
				</div>`;
			back.append(box);
			document.body.append(back);

			const pad = box.querySelector(".sign-pad");
			const ctx = pad.getContext("2d");
			const useBtn = box.querySelector('[data-act="use"]');
			let ink = INKS[0][0];
			let tab = "draw";
			let drawn = false;
			let uploaded = null; // canvas

			const inks = box.querySelector(".inks");
			for (const [hex, name] of INKS) {
				const b = document.createElement("button");
				b.className = "swatch" + (hex === ink ? " on" : "");
				b.style.background = hex;
				b.title = name;
				b.onclick = () => {
					ink = hex;
					inks.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === b));
					recolor(ctx, pad, hex);
				};
				inks.append(b);
			}

			// Smooth strokes: quadratic curves through midpoints, width varies a little with speed.
			let last = null;
			const pos = (e) => {
				const r = pad.getBoundingClientRect();
				return { x: ((e.clientX - r.left) * pad.width) / r.width, y: ((e.clientY - r.top) * pad.height) / r.height, t: e.timeStamp };
			};
			pad.addEventListener("pointerdown", (e) => {
				pad.setPointerCapture(e.pointerId);
				last = { ...pos(e), mid: null, w: 5 };
				ctx.fillStyle = ink;
				ctx.beginPath();
				ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
				ctx.fill();
				drawn = true;
				sync();
			});
			pad.addEventListener("pointermove", (e) => {
				if (!last) return;
				const p = pos(e);
				const speed = Math.hypot(p.x - last.x, p.y - last.y) / Math.max(1, p.t - last.t);
				const w = last.w * 0.7 + clamp(7 - speed * 1.6, 2.5, 7) * 0.3;
				const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
				ctx.strokeStyle = ink;
				ctx.lineCap = ctx.lineJoin = "round";
				ctx.lineWidth = w;
				ctx.beginPath();
				const from = last.mid || last;
				ctx.moveTo(from.x, from.y);
				ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
				ctx.stroke();
				last = { ...p, mid, w };
			});
			const end = () => (last = null);
			pad.addEventListener("pointerup", end);
			pad.addEventListener("pointercancel", end);

			box.querySelector('[data-act="clear"]').onclick = () => {
				ctx.clearRect(0, 0, pad.width, pad.height);
				drawn = false;
				sync();
			};

			box.querySelectorAll(".tab").forEach((t) => {
				t.onclick = () => {
					tab = t.dataset.tab;
					box.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
					box.querySelectorAll(".tab-body").forEach((b) => (b.hidden = b.dataset.body !== tab));
					sync();
				};
			});

			const fileInput = box.querySelector('input[type="file"]');
			fileInput.onchange = async () => {
				const file = fileInput.files[0];
				if (!file) return;
				try {
					uploaded = await removeBackground(file, ink);
					const prev = box.querySelector(".sign-preview");
					prev.src = uploaded.toDataURL("image/png");
					prev.hidden = false;
				} catch (err) {
					status(`Could not read that image: ${err.message}`, true);
				}
				sync();
			};

			function sync() {
				useBtn.disabled = tab === "draw" ? !drawn : !uploaded;
			}

			const close = (result) => {
				back.remove();
				document.removeEventListener("keydown", onKey, true);
				resolve(result);
			};
			const onKey = (e) => {
				if (e.key === "Escape") (e.stopPropagation(), close(null));
			};
			document.addEventListener("keydown", onKey, true);
			back.addEventListener("pointerdown", (e) => e.target === back && close(null));
			box.querySelector('[data-act="cancel"]').onclick = () => close(null);
			useBtn.onclick = async () => {
				const source = tab === "draw" ? pad : uploaded;
				const trimmed = trim(source);
				if (!trimmed) return;
				const url = trimmed.toDataURL("image/png");
				current = await loadDataUrl(url);
				try {
					localStorage.setItem(STORE_KEY, url);
				} catch {}
				close(current);
			};
		});
	}

	async function newSignature() {
		const made = await openDialog();
		if (made) {
			current = made;
			if (!mode) setMode(true);
			else status("New signature ready. Click on a page to place it.");
		}
	}

	return {
		overlays,
		place,
		deselect,
		newSignature,
		setMode,
		get mode() {
			return mode;
		},
		get selected() {
			return selected;
		},
		removeSelected() {
			if (selected) remove(selected.page, selected.sig);
		},
	};
}

// Signature pixels → { width, height, rgb, alpha } for the PDF image + soft mask.
async function loadDataUrl(url) {
	const img = new Image();
	img.src = url;
	await img.decode();
	const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
	const g = c.getContext("2d");
	g.drawImage(img, 0, 0);
	const { data } = g.getImageData(0, 0, c.width, c.height);
	const n = c.width * c.height;
	const rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		rgb[i * 3] = data[i * 4];
		rgb[i * 3 + 1] = data[i * 4 + 1];
		rgb[i * 3 + 2] = data[i * 4 + 2];
		alpha[i] = data[i * 4 + 3];
	}
	return { width: c.width, height: c.height, rgb, alpha, dataUrl: url };
}

// Crop to the ink with a small margin.
function trim(canvas) {
	const g = canvas.getContext("2d");
	const { width, height } = canvas;
	const { data } = g.getImageData(0, 0, width, height);
	let x0 = width, y0 = height, x1 = -1, y1 = -1;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			if (data[(y * width + x) * 4 + 3] > 8) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
	if (x1 < 0) return null;
	const m = 6;
	x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
	x1 = Math.min(width - 1, x1 + m); y1 = Math.min(height - 1, y1 + m);
	const out = document.createElement("canvas");
	out.width = x1 - x0 + 1;
	out.height = y1 - y0 + 1;
	out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
	return out;
}

// Change the color of what's drawn, keeping its shape.
function recolor(ctx, canvas, hex) {
	ctx.save();
	ctx.globalCompositeOperation = "source-in";
	ctx.fillStyle = hex;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.restore();
}

// Photo of a signature on paper → ink on transparent. Pixels are made transparent
// by how close they are to the paper (estimated from the brightest part of the
// image), so pen strokes keep soft edges and uneven lighting is tolerated.
async function removeBackground(file, inkHex) {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, 1200 / bitmap.width);
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const g = canvas.getContext("2d");
	g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	const img = g.getImageData(0, 0, canvas.width, canvas.height);
	const d = img.data;
	const lums = [];
	for (let i = 0; i < d.length; i += 4 * 7) lums.push(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
	lums.sort((a, b) => a - b);
	const paper = lums[Math.floor(lums.length * 0.9)];
	const inkLum = lums[Math.floor(lums.length * 0.01)];
	const span = Math.max(30, paper - inkLum);
	const hasAlpha = (() => {
		for (let i = 3; i < d.length; i += 4 * 13) if (d[i] < 250) return true;
		return false;
	})();
	for (let i = 0; i < d.length; i += 4) {
		const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
		const cover = clamp((paper - l) / span - 0.12, 0, 1) / 0.88;
		const a = hasAlpha ? d[i + 3] : Math.round(Math.pow(cover, 0.8) * 255);
		d[i + 3] = a < 20 ? 0 : a;
	}
	g.putImageData(img, 0, 0);
	return canvas;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
