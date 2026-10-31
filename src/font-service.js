// Asks the local server (serve.py /api/font) for a full font: installed on
// this computer, or downloaded from Google Fonts.

const requests = new Map();

// Font for a line extracted from the PDF (or matched on a scan).
export function resolveFont(line) {
	return loadFont({ name: line.fontKey || "", ...line.style });
}

// Resolves to { bytes, info, cssFamily } or null when nothing was found.
// The font is also registered for CSS/canvas use under cssFamily.
export function loadFont({ name, bold = false, italic = false, serif = false, mono = false }) {
	const key = [name, bold, italic, serif, mono].join("|");
	if (!requests.has(key)) requests.set(key, fetchFont({ name, bold, italic, serif, mono }, key));
	return requests.get(key);
}

async function fetchFont(opts, key) {
	const params = new URLSearchParams({ name: opts.name });
	for (const k of ["bold", "italic", "serif", "mono"]) params.set(k, opts[k] ? 1 : 0);
	try {
		const res = await fetch("/api/font?" + params);
		if (!res.ok) return null;
		const bytes = new Uint8Array(await res.arrayBuffer());
		const info = JSON.parse(res.headers.get("X-Font-Info") || "{}");
		const cssFamily = "pdf-font-" + requests.size + "-" + key.replace(/[^a-z0-9]/gi, "");
		try {
			const face = new FontFace(cssFamily, bytes);
			document.fonts.add(await face.load());
		} catch {
			// Preview only; the PDF still gets the font.
		}
		return { bytes, info, cssFamily };
	} catch (err) {
		console.warn("Font lookup failed", err);
		return null;
	}
}
