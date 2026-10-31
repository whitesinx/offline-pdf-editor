// Identify the font of scanned text: render the OCR'd text in candidate fonts
// and compare the shapes with the ink in the scan. Width-to-height ratio and
// stroke thickness separate families and weights well, even at low resolution.

import { loadFont } from "./font-service.js";

const FAMILIES = [
	["Roboto", "sans"], ["Open Sans", "sans"], ["Noto Sans", "sans"], ["Inter", "sans"], ["Lato", "sans"],
	["Montserrat", "sans"], ["Poppins", "sans"], ["Nunito Sans", "sans"], ["DM Sans", "sans"], ["Work Sans", "sans"],
	["Arimo", "sans"], ["Tinos", "serif"], ["Noto Serif", "serif"], ["Merriweather", "serif"], ["Cousine", "mono"],
];
const WEIGHT_NAMES = { 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold" };
const GRID_H = 48;
const RENDER_PX = 100;
// Most scanned/screenshot text is sans; a serif must win clearly, not by a hair.
const KIND_PRIOR = { sans: 0, serif: -0.03, mono: -0.03 };

const fontName = (family, weight) => family.replace(/ /g, "") + "-" + WEIGHT_NAMES[weight];

function candidate(family, kind, weight) {
	return loadFont({ name: fontName(family, weight), bold: weight >= 600, serif: kind === "serif", mono: kind === "mono" })
		.then((font) => font && { family, kind, weight, font });
}

// Download the first-pass candidates ahead of time (cached on disk afterwards).
export function warmUp() {
	return Promise.all(FAMILIES.flatMap(([f, k]) => [400, 700].map((w) => candidate(f, k, w))));
}

// Returns { name, family, weight, style, size, origin, score } or null.
export async function matchFont(line, onProgress) {
	const targets = pickTargets(line);
	if (!targets.length) return null;

	// Average the shape score over the targets; the first (longest) also gives size.
	const rank = (cands, weightTerm) =>
		cands.filter(Boolean)
			.map((c) => {
				const rs = targets.map((t) => compare(t.grid, t.ink, render(t.text, c.font.cssFamily), weightTerm));
				const score = rs.reduce((a, r) => a + r.score, 0) / rs.length + KIND_PRIOR[c.kind];
				return { ...c, score, ink: rs[0].ink };
			})
			.sort((a, b) => b.score - a.score);

	// Pass 1: family by shape alone (weight ignored, since only 400/700 are tried).
	onProgress?.("Matching font: comparing families…");
	const first = rank(await Promise.all(FAMILIES.flatMap(([f, k]) => [400, 700].map((w) => candidate(f, k, w)))), 0);
	if (!first.length) return null;

	// Pass 2: every weight of the winning family, now scoring stroke weight too.
	// (Family is settled by shape in pass 1; the weight term would otherwise let
	// a heavier face of a similar family overtake it.)
	onProgress?.("Matching font: refining weight…");
	const kind = FAMILIES.find(([n]) => n === first[0].family)[1];
	const ranked = rank(await Promise.all([300, 400, 500, 600, 700, 800].map((w) => candidate(first[0].family, kind, w))), 0.5);
	const best = ranked[0];

	// Size and baseline from the matched font's real proportions.
	const { sample } = line;
	const target = targets[0].ink;
	const k = target.h / best.ink.h; // scan px per render px
	const size = (RENDER_PX * k) / sample.scale;
	const baseline = target.y + (best.ink.baseline - best.ink.y) * k; // target coords are absolute scan px
	// The OCR box starts at the first ink pixel; the pen starts one side-bearing earlier.
	const firstWord = line.words?.[0]?.text || line.text;
	const bearing = (render(firstWord, best.font.cssFamily)?.x || 0) * k;
	return {
		name: fontName(best.family, best.weight),
		family: best.family,
		weight: best.weight,
		score: best.score,
		style: { serif: best.kind === "serif", mono: best.kind === "mono", bold: best.weight >= 600, italic: false },
		size,
		origin: [line.origin[0] - bearing / sample.scale, baseline / sample.scale],
		cssFamily: best.font.cssFamily,
		ranking: { families: first.slice(0, 6).map((c) => `${fontName(c.family, c.weight)} ${c.score.toFixed(3)}`), weights: ranked.slice(0, 4).map((c) => `${fontName(c.family, c.weight)} ${c.score.toFixed(3)}`) },
	};
}

// Words OCR is confident about, longest first: a misread word or a stray
// icon would otherwise be compared against the wrong shapes.
function pickTargets(line) {
	const { sample } = line;
	const good = (line.words || [])
		.filter((w) => w.confidence >= 80 && (w.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2)
		.sort((a, b) => b.text.length - a.text.length)
		.slice(0, 3);
	const regions = good.length
		? good.map((w) => ({ text: w.text, ...w.bbox }))
		: [{ text: line.text, x0: sample.left, y0: sample.top, x1: sample.left + sample.width, y1: sample.top + sample.height }];
	return regions
		.map((r) => {
			const ink = trim(sample, r.x0 - sample.left, r.y0 - sample.top, r.x1 - sample.left, r.y1 - sample.top);
			if (!ink) return null;
			const grid = toGrid(ink);
			grid.density = density(ink);
			// Absolute scan coordinates for the size/baseline maths.
			return { text: r.text, grid, ink: { ...ink, y: ink.y + sample.top } };
		})
		.filter(Boolean);
}

function render(text, cssFamily) {
	const ctx = new OffscreenCanvas(1, 1).getContext("2d");
	ctx.font = `${RENDER_PX}px "${cssFamily}"`;
	const width = Math.ceil(ctx.measureText(text).width) + 40;
	const height = RENDER_PX * 2;
	const canvas = new OffscreenCanvas(width, height);
	const c = canvas.getContext("2d");
	c.font = ctx.font;
	c.fillStyle = "#000";
	c.fillText(text, 0, RENDER_PX * 1.4);
	const px = c.getImageData(0, 0, width, height).data;
	const data = new Uint8Array(width * height);
	for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] > 127;
	const ink = trim({ width, height, data });
	if (ink) ink.baseline = RENDER_PX * 1.4;
	return ink;
}

// Crop a mask (or a window of it) to its ink bounding box.
function trim(mask, wx0 = 0, wy0 = 0, wx1 = mask.width, wy1 = mask.height) {
	const { width, height, data } = mask;
	wx0 = Math.max(0, Math.floor(wx0)); wy0 = Math.max(0, Math.floor(wy0));
	wx1 = Math.min(width, Math.ceil(wx1)); wy1 = Math.min(height, Math.ceil(wy1));
	let x0 = width, y0 = height, x1 = -1, y1 = -1;
	for (let y = wy0; y < wy1; y++)
		for (let x = wx0; x < wx1; x++)
			if (data[y * width + x]) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
	if (x1 < 0) return null;
	return { src: mask, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Area-average the trimmed ink into a GRID_H-high grid, keeping aspect ratio.
function toGrid(ink, gridW = Math.max(4, Math.min(800, Math.round((GRID_H * ink.w) / ink.h)))) {
	const out = new Float32Array(gridW * GRID_H);
	const { width, data } = ink.src;
	for (let gy = 0; gy < GRID_H; gy++) {
		const sy0 = ink.y + Math.floor((gy * ink.h) / GRID_H), sy1 = ink.y + Math.max(Math.floor(((gy + 1) * ink.h) / GRID_H), Math.floor((gy * ink.h) / GRID_H) + 1);
		for (let gx = 0; gx < gridW; gx++) {
			const sx0 = ink.x + Math.floor((gx * ink.w) / gridW), sx1 = ink.x + Math.max(Math.floor(((gx + 1) * ink.w) / gridW), Math.floor((gx * ink.w) / gridW) + 1);
			let sum = 0;
			for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) sum += data[y * width + x];
			out[gy * gridW + gx] = sum / ((sy1 - sy0) * (sx1 - sx0));
		}
	}
	return { w: gridW, cells: out };
}

function compare(targetGrid, target, ink, weightTerm) {
	if (!ink) return { score: -Infinity, ink };
	const grid = toGrid(ink, targetGrid.w);
	let inter = 0, union = 0;
	for (let i = 0; i < grid.cells.length; i++) {
		inter += Math.min(grid.cells[i], targetGrid.cells[i]);
		union += Math.max(grid.cells[i], targetGrid.cells[i]);
	}
	// Aspect ratio separates families/widths; ink density tracks stroke weight.
	const aspect = Math.abs(Math.log(ink.w / ink.h / (target.w / target.h)));
	const weight = Math.abs(Math.log(density(ink) / targetGrid.density));
	return { score: inter / (union || 1) - 1.5 * aspect - weightTerm * weight, ink };
}

function density(ink) {
	if (ink.density !== undefined) return ink.density;
	const { width, data } = ink.src;
	let n = 0;
	for (let y = ink.y; y < ink.y + ink.h; y++) for (let x = ink.x; x < ink.x + ink.w; x++) n += data[y * width + x];
	return (ink.density = n / (ink.w * ink.h));
}
