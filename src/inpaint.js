// Fill a rectangle from its border: the outer `band` pixels are kept as they
// are, and every inside pixel blends the nearest border colors on all four
// sides (inverse-distance weights). Smooth gradients continue across the hole,
// and the patch edge matches its surroundings exactly.
export function inpaint(rgb, w, h, band) {
	const out = new Uint8Array(rgb);
	if (w <= band * 2 + 1 || h <= band * 2 + 1) return out;
	const at = (x, y, k) => rgb[(y * w + x) * 3 + k];

	// Border colors, averaged across the band (and ±1 px along it) to ignore single noisy pixels.
	const edge = (len, sample) => {
		const vals = [];
		for (let i = 0; i < len; i++) {
			const c = [0, 0, 0];
			let n = 0;
			for (let d = -1; d <= 1; d++) {
				const j = Math.min(len - 1, Math.max(0, i + d));
				for (let b = 0; b < band; b++) {
					const p = sample(j, b);
					for (let k = 0; k < 3; k++) c[k] += p[k];
					n++;
				}
			}
			vals.push(c.map((v) => v / n));
		}
		return vals;
	};
	const px = (x, y) => [at(x, y, 0), at(x, y, 1), at(x, y, 2)];
	const top = robust(edge(w, (x, b) => px(x, b)));
	const bottom = robust(edge(w, (x, b) => px(x, h - 1 - b)));
	const left = robust(edge(h, (y, b) => px(b, y)));
	const right = robust(edge(h, (y, b) => px(w - 1 - b, y)));

	for (let y = band; y < h - band; y++)
		for (let x = band; x < w - band; x++) {
			const dT = y - band + 1, dB = h - band - y, dL = x - band + 1, dR = w - band - x;
			const wT = 1 / (dT * dT), wB = 1 / (dB * dB), wL = 1 / (dL * dL), wR = 1 / (dR * dR);
			const sum = wT + wB + wL + wR;
			for (let k = 0; k < 3; k++)
				out[(y * w + x) * 3 + k] = Math.round((top[x][k] * wT + bottom[x][k] * wB + left[y][k] * wL + right[y][k] * wR) / sum);
		}
	return out;
}

// Sliding median along an edge: a letter or line that the box cuts through shows
// up as a short run of off-colour pixels on the border, which would otherwise be
// smeared across the whole patch. Gradients (longer than the window) survive.
function robust(vals) {
	const n = vals.length;
	const r = Math.max(2, Math.round(n / 8));
	const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
	const out = new Array(n);
	for (let i = 0; i < n; i++) {
		const win = vals.slice(Math.max(0, i - r), Math.min(n, i + r + 1));
		win.sort((a, b) => lum(a) - lum(b));
		out[i] = win[win.length >> 1];
	}
	return out;
}
