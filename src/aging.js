// Make crisp new text look like the rest of the page. Pure pixel math, no MuPDF here.
//
// Input is the edited region rendered twice: `withText` and `withoutText`.
// Their difference is exactly the new ink, so the paper, the scan grain and
// any neighbouring content are never touched and no patch edge is visible.
//
// look = {
//   blur:  0..1   manual blur (0 = none, 1 ≈ 1.5 pt Gaussian)
//   aged:  0..1   lower resolution + uneven ink + slight fade
//   reference: { softness, peak } | null   measured from the original text
//                 (see measureInk). When given, blur and fade are tuned so the
//                 new text matches it, and the manual blur value is ignored.
// }

// Returns { alpha: Uint8Array, sigma } or null when there's no visible ink.
export function degradeInk(withText, withoutText, width, height, ink, look, scale) {
	const aged = clamp01(look.aged || 0);
	let a = coverage(withText, withoutText, width, height, ink);
	if (!a) return null;

	// 1. Aged: average down to "scan" resolution, add ink unevenness there, smooth back up.
	//    aged=0 skips it, aged=1 drops to ~60 dpi.
	if (aged > 0) {
		// Never "reduce" to more pixels than we have (a coarse scan is already there).
		const factor = Math.min(1, (150 - 90 * aged) / (scale * 72));
		const lw = Math.max(2, Math.round(width * factor));
		const lh = Math.max(2, Math.round(height * factor));
		const low = factor < 1 ? downsample(a, width, height, lw, lh) : Float32Array.from(a);
		const rand = mulberry32((width * 73856093) ^ (height * 19349663));
		for (let p = 0; p < low.length; p++) {
			if (!low[p]) continue;
			const edge = 1 - Math.abs(low[p] * 2 - 1);
			low[p] *= 1 - aged * (0.18 * rand() + 0.25 * edge * rand());
		}
		a = factor < 1 ? upsample(low, lw, lh, width, height) : low;
	}

	// 2. Blur: manual, or searched so the edge softness matches the original text.
	let sigma;
	const ref = look.reference;
	if (ref) {
		sigma = matchSigma(a, width, height, ref.softness, scale);
	} else {
		sigma = clamp01(look.blur || 0) * 1.5 * scale; // up to 1.5 pt
	}
	if (sigma > 0) a = blurred(a, width, height, sigma);

	// 3. Fade: match the original's ink strength, or a light fade for the aged look.
	let gain = 1 - 0.12 * aged;
	if (ref) {
		const mine = measureCoverage(a).peak;
		if (mine > 0) gain = Math.min(1, Math.max(0.5, ref.peak / mine));
	}
	const alpha = new Uint8Array(a.length);
	for (let p = 0; p < a.length; p++) alpha[p] = Math.round(Math.min(1, a[p] * gain) * 255);
	return { alpha, sigma: sigma / scale };
}

// Softness and ink strength of text in an RGB image whose paper and ink colors are known.
// Used on the original scanned line, before it's covered.
export function measureInk(rgb, width, height, background, ink) {
	const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
	const bg = lum(background) * 255, fg = lum(ink) * 255;
	if (Math.abs(bg - fg) < 20) return null;
	const a = new Float32Array(width * height);
	for (let p = 0, i = 0; p < a.length; p++, i += 3) {
		const l = rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114;
		a[p] = clamp01((bg - l) / (bg - fg));
	}
	const m = measureCoverage(a);
	return m.inked > 20 ? m : null;
}

// softness = share of inked pixels that are half-covered (soft edges): sharp
// text has thin edges (low), blurry text wide ones (high). peak = how solid
// the strongest ink is (95th percentile), which captures faded print.
function measureCoverage(a) {
	let inked = 0, partial = 0;
	const vals = [];
	for (let p = 0; p < a.length; p++) {
		const v = a[p];
		if (v <= 0.2) continue;
		inked++;
		if (v < 0.8) partial++;
		vals.push(v);
	}
	if (!inked) return { softness: 0, peak: 0, inked };
	vals.sort((x, y) => x - y);
	return { softness: partial / inked, peak: vals[Math.floor(vals.length * 0.95)], inked };
}

// Bisection on the blur radius until the new ink is as soft as the reference.
function matchSigma(a, w, h, target, scale) {
	const softnessAt = (s) => measureCoverage(s > 0 ? blurred(a, w, h, s) : a).softness;
	if (softnessAt(0) >= target) return 0;
	let lo = 0, hi = 3 * scale; // up to 3 pt
	if (softnessAt(hi) <= target) return hi;
	for (let i = 0; i < 10; i++) {
		const mid = (lo + hi) / 2;
		if (softnessAt(mid) < target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

// Ink coverage per pixel (0..1) from the with/without renders.
function coverage(withText, withoutText, width, height, ink) {
	const lum = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
	const inkLum = (ink[0] * 0.299 + ink[1] * 0.587 + ink[2] * 0.114) * 255;
	const a = new Float32Array(width * height);
	let any = false;
	for (let p = 0, i = 0; p < a.length; p++, i += 3) {
		const bg = lum(withoutText, i);
		const denom = bg - inkLum;
		let v;
		if (Math.abs(denom) > 20) v = (bg - lum(withText, i)) / denom;
		else v = Math.max(...[0, 1, 2].map((k) => Math.abs(withText[i + k] - withoutText[i + k]))) / 255;
		a[p] = v <= 0.02 ? 0 : Math.min(1, v);
		if (a[p]) any = true;
	}
	return any ? a : null;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function downsample(src, w, h, lw, lh) {
	const out = new Float32Array(lw * lh);
	const cnt = new Float32Array(lw * lh);
	for (let y = 0; y < h; y++) {
		const ly = Math.min(lh - 1, Math.floor((y * lh) / h));
		for (let x = 0; x < w; x++) {
			const q = ly * lw + Math.min(lw - 1, Math.floor((x * lw) / w));
			out[q] += src[y * w + x];
			cnt[q]++;
		}
	}
	for (let q = 0; q < out.length; q++) out[q] /= cnt[q] || 1;
	return out;
}

function upsample(src, lw, lh, w, h) {
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const fy = Math.min(lh - 1, Math.max(0, ((y + 0.5) * lh) / h - 0.5));
		const y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
		for (let x = 0; x < w; x++) {
			const fx = Math.min(lw - 1, Math.max(0, ((x + 0.5) * lw) / w - 0.5));
			const x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
			const top = src[y0 * lw + x0] * (1 - tx) + src[y0 * lw + x1] * tx;
			const bot = src[y1 * lw + x0] * (1 - tx) + src[y1 * lw + x1] * tx;
			out[y * w + x] = top * (1 - ty) + bot * ty;
		}
	}
	return out;
}

// Separable Gaussian blur into a new array.
function blurred(src, w, h, sigma) {
	if (sigma < 0.3) return src;
	const r = Math.ceil(sigma * 2.5);
	const k = [];
	let sum = 0;
	for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
	for (let i = 0; i < k.length; i++) k[i] /= sum;
	const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let v = 0;
			for (let i = -r; i <= r; i++) v += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
			tmp[y * w + x] = v;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let v = 0;
			for (let i = -r; i <= r; i++) v += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
			out[y * w + x] = v;
		}
	return out;
}

// Small seeded PRNG so the same edit always ages the same way.
function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
