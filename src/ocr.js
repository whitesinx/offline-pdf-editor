// OCR for scanned pages with Tesseract.js, fully local (no CDN fetches).

const OCR_DPI = 300;
const LANGS = "eng+ind";

let workerPromise = null;

function getWorker(onProgress) {
	if (!workerPromise) {
		const base = new URL("../vendor/tesseract/", import.meta.url).href;
		workerPromise = globalThis.Tesseract.createWorker(LANGS, 1, {
			workerPath: base + "worker.min.js",
			corePath: base + "core/",
			langPath: base + "lang/",
			workerBlobURL: false,
			cacheMethod: "none",
			logger: (m) => onProgress?.(m),
		});
	}
	return workerPromise;
}

// Returns OCR lines in page coordinates, in the same shape PdfEngine uses.
export async function ocrPage(engine, index, onProgress) {
	const scale = OCR_DPI / 72;
	const img = engine.renderRGBA(index, scale);
	const canvas = new OffscreenCanvas(img.width, img.height);
	canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer), img.width, img.height), 0, 0);
	const blob = await canvas.convertToBlob({ type: "image/png" });

	const worker = await getWorker(onProgress);
	const { data } = await worker.recognize(blob, {}, { blocks: true, text: false });

	const lines = [];
	for (const block of data.blocks || [])
		for (const para of block.paragraphs)
			for (const ln of para.lines)
				for (const words of splitAtGaps(ln)) {
					const text = words.map((w) => w.text).join(" ").trim();
					if (!text || avg(words.map((w) => w.confidence)) < 30) continue;
					// A lone icon read as "(o]" or "©": too few letters/digits and OCR unsure.
					const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length;
					if (alnum === 0 || (alnum < 2 && avg(words.map((w) => w.confidence)) < 75)) continue;
					lines.push(toPageLine(ln, words, text, img, scale, lines.length));
				}
	return lines;
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// A wide gap inside an OCR "line" usually separates unrelated things (an icon
// and a label, two table cells), so each run of words becomes its own box.
function splitAtGaps(ln) {
	const words = (ln.words || []).filter((w) => w.text.trim());
	if (!words.length) return [];
	const height = median(words.map(wordHeight));
	const runs = [[words[0]]];
	for (let i = 1; i < words.length; i++) {
		const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
		if (gap > height * 0.9) runs.push([]);
		runs[runs.length - 1].push(words[i]);
	}
	return runs.map(dropIcons).filter((r) => r.length);
}

const wordHeight = (w) => w.bbox.y1 - w.bbox.y0;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// Icons next to text (pins, dots, chevrons) get OCR'd as junk like "Le)" or "©".
// Strip such words from the ends: unsure and taller than the text, or no letters/digits.
function dropIcons(words) {
	const isIcon = (w, others) => {
		if (!others.length) return false;
		const h = median(others.map(wordHeight));
		if (!/[\p{L}\p{N}]/u.test(w.text)) return true;
		if (w.confidence < 50) return true;
		return w.confidence < 85 && wordHeight(w) > h * 1.25;
	};
	words = [...words];
	while (words.length > 1 && isIcon(words[0], words.slice(1))) words.shift();
	while (words.length > 1 && isIcon(words[words.length - 1], words.slice(0, -1))) words.pop();
	return words;
}

function toPageLine(ln, words, text, img, scale, id) {
	const x0 = Math.min(...words.map((w) => w.bbox.x0));
	const x1 = Math.max(...words.map((w) => w.bbox.x1));
	const y0 = Math.min(...words.map((w) => w.bbox.y0));
	const y1 = Math.max(...words.map((w) => w.bbox.y1));
	const b = ln.baseline;
	const baseY = b && b.x1 !== b.x0 ? b.y0 + ((b.y1 - b.y0) * (x0 - b.x0)) / (b.x1 - b.x0) : y1;
	const angle = b && b.x1 !== b.x0 ? Math.atan2(b.y1 - b.y0, b.x1 - b.x0) : 0;
	const { background, ink } = sampleColors(img, x0, y0, x1, y1);
	// Ascender height is ~0.72 em for Helvetica-like faces. Refined later by font matching.
	const size = Math.max(4, (baseY - y0) / 0.72 / scale);

	return {
		id: "ocr" + id,
		kind: "ocr",
		text,
		bbox: [x0 / scale, y0 / scale, x1 / scale, y1 / scale],
		origin: [x0 / scale, baseY / scale],
		dir: [Math.cos(angle), Math.sin(angle)],
		font: null,
		fontKey: null,
		size,
		color: ink,
		background,
		style: { serif: false, mono: false, bold: false, italic: false },
		sample: inkMask(img, x0, y0, x1, y1, background, ink, scale),
		words: words.map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
	};
}

// Binary ink mask of the box (1 = ink), kept for font matching.
function inkMask(img, x0, y0, x1, y1, background, ink, scale) {
	const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
	const threshold = ((lum(background) + lum(ink)) / 2) * 255;
	const darkInk = lum(ink) < lum(background);
	const pad = Math.round((y1 - y0) * 0.15);
	const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
	const width = Math.min(img.width, x1 + pad) - left, height = Math.min(img.height, y1 + pad) - top;
	const data = new Uint8Array(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const i = ((top + y) * img.width + left + x) * 4;
			const l = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
			data[y * width + x] = darkInk ? l < threshold : l > threshold;
		}
	return { width, height, data, left, top, scale };
}

// Paper color = median of the pixels just outside the box; ink = mean of
// the darkest tenth of pixels inside it (anti-aliased edges excluded).
function sampleColors(img, x0, y0, x1, y1) {
	const { width, height, data } = img;
	const px = (x, y) => {
		x = Math.min(width - 1, Math.max(0, Math.round(x)));
		y = Math.min(height - 1, Math.max(0, Math.round(y)));
		const i = (y * width + x) * 4;
		return [data[i], data[i + 1], data[i + 2]];
	};
	const pad = Math.max(3, (y1 - y0) * 0.2);
	const ring = [];
	for (let x = x0 - pad; x <= x1 + pad; x += 2) ring.push(px(x, y0 - pad), px(x, y1 + pad));
	for (let y = y0 - pad; y <= y1 + pad; y += 2) ring.push(px(x0 - pad, y), px(x1 + pad, y));
	const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
	ring.sort((a, b) => lum(a) - lum(b));
	const bg = ring[ring.length >> 1] || [255, 255, 255];

	const inside = [];
	for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) inside.push(px(x, y));
	inside.sort((a, b) => lum(a) - lum(b));
	const dark = inside.slice(0, Math.max(1, inside.length / 10));
	const ink = [0, 1, 2].map((k) => dark.reduce((s, c) => s + c[k], 0) / dark.length);

	return { background: bg.map((v) => v / 255), ink: ink.map((v) => v / 255) };
}
