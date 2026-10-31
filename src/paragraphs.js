// Group text lines into paragraphs and list items, so a whole paragraph can be
// edited and re-wrapped. Works on PdfEngine lines and on OCR lines alike: each
// needs bbox, origin (baseline start), dir, size and text.
//
// A line joins the paragraph above it when it has about the same size, sits one
// normal line-spacing below, starts at the paragraph's left edge (or the hanging
// indent of a list item), and the line above didn't end the paragraph (short
// line ending in . : ! ?). A line that starts with a list marker (1. 2) a. (iv) • –)
// always starts a new item.

export const MARKER = /^\s*((?:\d{1,3}(?:\.\d{1,3})*|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]|\(\s*(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})\s*\)|[•●▪■◦‣∙·*\-–—])(?=\s)/;

export function groupParagraphs(lines, pageWidth) {
	const flat = lines.filter((l) => Math.abs(l.dir[1]) < 0.05 && l.dir[0] > 0 && l.text.trim());
	const other = lines.filter((l) => !flat.includes(l));
	flat.sort((a, b) => a.origin[1] - b.origin[1] || a.bbox[0] - b.bbox[0]);
	const leftMargin = flat.length ? Math.min(...flat.map((l) => l.bbox[0])) : 0;

	const paras = [];
	const open = []; // paragraphs that can still take a line
	for (const line of flat) {
		const marker = line.text.match(MARKER);
		let target = null;
		if (!marker) {
			let best = Infinity;
			for (const p of open) {
				const s = joinScore(p, line);
				if (s < best) (best = s), (target = p);
			}
		}
		if (target) {
			target.lines.push(line);
		} else {
			const p = { lines: [line], marker: marker ? marker[1] : null };
			paras.push(p);
			open.push(p);
		}
		// A paragraph whose last line is far above this one can't continue.
		for (let i = open.length - 1; i >= 0; i--) {
			const last = open[i].lines[open[i].lines.length - 1];
			if (line.origin[1] - last.origin[1] > last.size * 2.2) open.splice(i, 1);
		}
	}
	for (const l of other) paras.push({ lines: [l], marker: null });
	return paras.map((p, i) => finish(p, i, pageWidth, leftMargin));
}

// Lower is better; Infinity = can't join.
function joinScore(p, line) {
	const lines = p.lines;
	const last = lines[lines.length - 1];
	const size = last.size;
	if (Math.abs(line.size - size) / size > 0.15) return Infinity;
	if (line.kind !== last.kind) return Infinity;
	const gap = line.origin[1] - last.origin[1];
	if (gap < size * 0.8 || gap > size * 2) return Infinity;
	if (lines.length >= 2) {
		const prevGap = last.origin[1] - lines[lines.length - 2].origin[1];
		if (Math.abs(gap - prevGap) > size * 0.3) return Infinity;
	}
	// Columns: must overlap horizontally with the paragraph.
	const pl = Math.min(...lines.map((l) => l.bbox[0])), pr = Math.max(...lines.map((l) => l.bbox[2]));
	if (line.bbox[2] < pl || line.bbox[0] > pr) return Infinity;

	// Left edge: same as the continuation lines, or (second line) the first line's
	// left minus an indent, or the hanging indent of a list item.
	const x = line.origin[0];
	let dx;
	if (lines.length >= 2) dx = Math.abs(x - lines[1].origin[0]);
	else if (p.marker) dx = x > last.origin[0] + size * 0.5 && x < last.origin[0] + size * 4 ? 0 : Math.abs(x - last.origin[0]);
	else dx = Math.min(Math.abs(x - last.origin[0]), x < last.origin[0] && last.origin[0] - x < size * 4 ? 0 : Infinity);
	if (dx > size * 0.6) return Infinity;

	// The line above ended the paragraph: clearly short (this line reaches further
	// right) and ends a sentence.
	const lastWidthShort = last.bbox[2] < Math.max(pr, line.bbox[2]) - size * 3;
	if (lastWidthShort && /[.:!?;]["')\]]?$/.test(last.text.trim())) return Infinity;
	if (lastWidthShort && lines.length >= 2) return Infinity;
	return dx + Math.abs(gap - size * 1.2);
}

function finish(p, i, pageWidth, leftMargin) {
	const lines = p.lines;
	const first = lines[0];
	const size = median(lines.map((l) => l.size));
	const bbox = [
		Math.min(...lines.map((l) => l.bbox[0])),
		Math.min(...lines.map((l) => l.bbox[1])),
		Math.max(...lines.map((l) => l.bbox[2])),
		Math.max(...lines.map((l) => l.bbox[3])),
	];
	const gaps = lines.slice(1).map((l, k) => l.origin[1] - lines[k].origin[1]);
	const lineGap = gaps.length ? median(gaps) : size * 1.2;
	const firstX = first.origin[0];
	const restX = lines.length > 1 ? median(lines.slice(1).map((l) => l.origin[0])) : null;
	// Wrap width: the paragraph's own right edge; a one-line paragraph may use the
	// text column (page width minus the same margin as on the left).
	const right = lines.length > 1 ? bbox[2] : Math.max(bbox[2], pageWidth - leftMargin);
	// Justified: every line but the last ends at the same right edge.
	const body = lines.slice(0, -1);
	const justified = body.length >= 2 && body.every((l) => Math.abs(l.bbox[2] - bbox[2]) < size * 0.4);

	return {
		id: `p${i}`,
		kind: first.kind,
		lines,
		text: joinLines(lines.map((l) => l.text)),
		bbox,
		size,
		lineGap,
		firstX,
		restX, // null = same as firstX, or the hanging indent of a list item
		right,
		justified,
		marker: p.marker,
		bodyX: p.marker ? markerBodyX(first, p.marker) : null, // where text after "1." starts
	};
}

// x of the first character after the list marker: from character positions
// (PDF text) or the second OCR word's box (scans). null if unknown.
function markerBodyX(line, marker) {
	const at = line.text.indexOf(marker) + marker.length;
	const rest = line.text.slice(at).search(/\S/);
	if (line.charX && rest >= 0) return line.charX[at + rest] ?? null;
	const w = line.words?.[1];
	if (w && line.sample?.scale) return w.bbox.x0 / line.sample.scale;
	return null;
}

// Join wrapped lines with spaces; a word hyphenated across lines is rejoined.
export function joinLines(texts) {
	let out = "";
	for (const raw of texts) {
		const t = raw.trim();
		if (!out) out = t;
		else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t;
		else out += " " + t;
	}
	return out;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
