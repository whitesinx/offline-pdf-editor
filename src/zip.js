// Minimal ZIP writer (stored, no compression): PNG/JPEG are already compressed.
// Used to download several page images as one file.

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(data) {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array }] → Uint8Array
export function zip(files) {
	const enc = new TextEncoder();
	const now = new Date();
	const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
	const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
	const parts = [], central = [];
	let offset = 0;
	for (const f of files) {
		const name = enc.encode(f.name);
		const crc = crc32(f.data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, 0x0800, true); // UTF-8 names
		local.setUint16(10, time, true);
		local.setUint16(12, date, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, f.data.length, true);
		local.setUint32(22, f.data.length, true);
		local.setUint16(26, name.length, true);
		parts.push(new Uint8Array(local.buffer), name, f.data);

		const cen = new DataView(new ArrayBuffer(46));
		cen.setUint32(0, 0x02014b50, true);
		cen.setUint16(4, 20, true);
		cen.setUint16(6, 20, true);
		cen.setUint16(8, 0x0800, true);
		cen.setUint16(12, time, true);
		cen.setUint16(14, date, true);
		cen.setUint32(16, crc, true);
		cen.setUint32(20, f.data.length, true);
		cen.setUint32(24, f.data.length, true);
		cen.setUint16(28, name.length, true);
		cen.setUint32(42, offset, true);
		central.push(new Uint8Array(cen.buffer), name);
		offset += 30 + name.length + f.data.length;
	}
	const size = central.reduce((n, p) => n + p.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, files.length, true);
	end.setUint16(10, files.length, true);
	end.setUint32(12, size, true);
	end.setUint32(16, offset, true);
	const all = [...parts, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of all) out.set(p, pos), (pos += p.length);
	return out;
}
