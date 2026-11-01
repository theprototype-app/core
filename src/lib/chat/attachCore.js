// Roadmap 56 C8 — PICTURES IN THE CHAT, the pure half (imports nothing; the unit layer covers it).
//
// THE PRIVACY RULE: nothing leaves the sender's device with its metadata. A phone photo carries the
// GPS position it was taken at in its EXIF block, and a chat is read by everyone in the session and
// saved with the scene. So every picture is RE-ENCODED through a canvas on the sender (which writes
// no metadata at all) AND the encoded bytes then pass `stripMetadata` — belt and braces, because the
// second step is the one a unit test can prove with a GPS-tagged fixture, and because a browser that
// ever starts copying metadata through `toBlob` must not silently start leaking positions.
//
// What is stripped: JPEG APP1 (EXIF, XMP), APP3-APP15 and COM; PNG eXIf / tEXt / zTXt / iTXt / tIME;
// WebP EXIF / XMP chunks (and their VP8X flags). Kept: what the pixels need (JFIF APP0, an ICC
// profile in APP2 / iCCP, every image chunk).
//
// THE SIZE RULE (Claude's vision guidance): long edge ≤ 1568 px, about ≤ 1 MB, at most 4 per message.

export const MAX_EDGE = 1568;
export const MAX_ATTACH_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
/** quality ladder for the encoder; past its end the picture shrinks by SHRINK and the ladder restarts */
export const QUALITIES = [0.86, 0.78, 0.7, 0.62, 0.54];
export const SHRINK = 0.8;

/** @param {Uint8Array} b @param {number} i */
const be16 = (b, i) => (b[i] << 8) | b[i + 1];
/** @param {Uint8Array} b @param {number} i */
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
/** @param {Uint8Array} b @param {number} i */
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
/** @param {Uint8Array} b @param {number} i @param {string} s */
const ascii = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/**
 * The real type of the bytes, whatever the file name or the `File.type` claims.
 * @param {Uint8Array} b @returns {string} a MIME type or ''
 */
export function sniffType(b) {
	if (!b || b.length < 12) return '';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x89 && ascii(b, 1, 'PNG')) return 'image/png';
	if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
	if (ascii(b, 0, 'GIF8')) return 'image/gif';
	if (ascii(b, 4, 'ftyp') && (ascii(b, 8, 'heic') || ascii(b, 8, 'heix') || ascii(b, 8, 'mif1') || ascii(b, 8, 'heif'))) return 'image/heic';
	return '';
}

/** @param {Uint8Array} b @returns {Uint8Array} */
function stripJpeg(b) {
	/** @type {Uint8Array[]} */
	const parts = [b.subarray(0, 2)];
	let i = 2;
	while (i + 4 <= b.length) {
		if (b[i] !== 0xff) break; // not a marker: leave the rest as it is
		const marker = b[i + 1];
		if (marker === 0xff) {
			i++; // fill byte
			continue;
		}
		if (marker === 0xda || marker === 0xd9) {
			parts.push(b.subarray(i)); // start of scan (or end): the image data follows verbatim
			i = b.length;
			break;
		}
		if (marker >= 0xd0 && marker <= 0xd7) {
			parts.push(b.subarray(i, i + 2));
			i += 2;
			continue;
		}
		const len = be16(b, i + 2);
		if (len < 2 || i + 2 + len > b.length) break;
		const seg = b.subarray(i, i + 2 + len);
		const isApp = marker >= 0xe0 && marker <= 0xef;
		const keep = !isApp ? marker !== 0xfe : marker === 0xe0 || (marker === 0xe2 && ascii(b, i + 4, 'ICC_PROFILE'));
		if (keep) parts.push(seg);
		i += 2 + len;
	}
	if (i < b.length) parts.push(b.subarray(i));
	return concat(parts);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
/** @param {Uint8Array} b @returns {Uint8Array} */
function stripPng(b) {
	/** @type {Uint8Array[]} */
	const parts = [b.subarray(0, 8)];
	let i = 8;
	while (i + 12 <= b.length) {
		const len = be32(b, i);
		const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
		const end = i + 12 + len;
		if (end > b.length) break;
		if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
		i = end;
		if (type === 'IEND') break;
	}
	return concat(parts);
}

/** @param {Uint8Array} b @returns {Uint8Array} */
function stripWebp(b) {
	/** @type {Uint8Array[]} */
	const chunks = [];
	let i = 12;
	let vp8x = -1;
	while (i + 8 <= b.length) {
		const type = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
		const len = le32(b, i + 4);
		const end = i + 8 + len + (len & 1);
		if (end > b.length + 1) break;
		if (type !== 'EXIF' && type !== 'XMP ') {
			if (type === 'VP8X') vp8x = chunks.length;
			chunks.push(b.slice(i, Math.min(end, b.length)));
		}
		i = end;
	}
	if (vp8x >= 0) chunks[vp8x][8] &= ~(0x08 | 0x04); // the EXIF + XMP flags
	const body = concat(chunks);
	const out = new Uint8Array(12 + body.length);
	out.set(b.subarray(0, 12), 0);
	out.set(body, 12);
	const size = out.length - 8;
	out[4] = size & 255;
	out[5] = (size >> 8) & 255;
	out[6] = (size >> 16) & 255;
	out[7] = (size >>> 24) & 255;
	return out;
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/**
 * The bytes with every metadata block removed (see the header). An unknown type comes back as it is
 * — the caller only ever hands this canvas output, which is one of the three.
 * @param {Uint8Array} bytes @param {string} [type] the sniffed type when known
 * @returns {Uint8Array}
 */
export function stripMetadata(bytes, type = sniffType(bytes)) {
	try {
		if (type === 'image/jpeg') return stripJpeg(bytes);
		if (type === 'image/png') return stripPng(bytes);
		if (type === 'image/webp') return stripWebp(bytes);
	} catch {
		/* a malformed file: the caller re-encodes anyway */
	}
	return bytes;
}

/**
 * What metadata the bytes still carry — the proof side of the rule (unit + e2e assert on it).
 * @param {Uint8Array} b @returns {{exif: boolean, gps: boolean, xmp: boolean, text: boolean}}
 */
export function metadataOf(b) {
	const out = { exif: false, gps: false, xmp: false, text: false };
	const type = sniffType(b);
	if (type === 'image/jpeg') {
		let i = 2;
		while (i + 4 <= b.length && b[i] === 0xff) {
			const marker = b[i + 1];
			if (marker === 0xda || marker === 0xd9) break;
			const len = be16(b, i + 2);
			if (marker === 0xe1 && ascii(b, i + 4, 'Exif')) {
				out.exif = true;
				const seg = b.subarray(i + 4, i + 2 + len);
				// the GPSInfo pointer tag (0x8825) in either byte order
				for (let k = 0; k + 1 < seg.length; k++) if ((seg[k] === 0x25 && seg[k + 1] === 0x88) || (seg[k] === 0x88 && seg[k + 1] === 0x25)) out.gps = true;
			}
			if (marker === 0xe1 && ascii(b, i + 4, 'http://ns.adobe.com/xap')) out.xmp = true;
			if (marker === 0xfe) out.text = true;
			i += 2 + len;
		}
	} else if (type === 'image/png') {
		let i = 8;
		while (i + 12 <= b.length) {
			const len = be32(b, i);
			const t = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
			if (t === 'eXIf') out.exif = out.gps = true; // an eXIf chunk may hold GPS; count it as such
			if (t === 'tEXt' || t === 'zTXt' || t === 'iTXt') out.text = true;
			i += 12 + len;
			if (t === 'IEND') break;
		}
	} else if (type === 'image/webp') {
		let i = 12;
		while (i + 8 <= b.length) {
			const t = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
			const len = le32(b, i + 4);
			if (t === 'EXIF') out.exif = out.gps = true;
			if (t === 'XMP ') out.xmp = true;
			i += 8 + len + (len & 1);
		}
	}
	return out;
}

/**
 * The size a picture is drawn at: long edge ≤ `maxEdge`, never upscaled, aspect kept, ≥ 1 px.
 * @param {number} w @param {number} h @param {number} [maxEdge] @returns {{w: number, h: number}}
 */
export function fitSize(w, h, maxEdge = MAX_EDGE) {
	if (!(w > 0) || !(h > 0)) return { w: 1, h: 1 };
	const s = Math.min(1, maxEdge / Math.max(w, h));
	return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/**
 * The encode attempts in order: every quality at the fitted size, then every quality at 80 % of it,
 * and so on. The caller stops at the first result ≤ `maxBytes`.
 * @param {number} w @param {number} h @param {number} [maxEdge] @param {number} [rounds]
 * @returns {{w: number, h: number, quality: number}[]}
 */
export function encodePlan(w, h, maxEdge = MAX_EDGE, rounds = 4) {
	let size = fitSize(w, h, maxEdge);
	/** @type {{w: number, h: number, quality: number}[]} */
	const out = [];
	for (let r = 0; r < rounds; r++) {
		for (const quality of QUALITIES) out.push({ ...size, quality });
		size = { w: Math.max(1, Math.round(size.w * SHRINK)), h: Math.max(1, Math.round(size.h * SHRINK)) };
	}
	return out;
}

/** bytes → base64 (chunked, so a 1 MB picture does not blow the argument limit) @param {Uint8Array} b */
export function toBase64(b) {
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, /** @type {any} */ (b.subarray(i, i + 0x8000)));
	return btoa(s);
}

/** base64 → bytes @param {string} s */
export function fromBase64(s) {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** a safe display name for an attachment @param {string} name @param {string} type */
export function attachName(name, type) {
	const ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : type === 'image/gif' ? '.gif' : '.jpg';
	const base = String(name || 'picture').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 80) || 'picture';
	return base + ext;
}
