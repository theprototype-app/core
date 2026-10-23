// 65 M4 — ANIMATED WEBP, written by hand. PURE (bytes in, bytes out).
//
// Browsers encode a WebP STILL (`canvas.toBlob('image/webp')`, Chromium and Firefox) but nothing
// writes an animated one, and the container is small enough not to need a library: RIFF/WEBP with a
// VP8X header (animation + alpha flags, canvas size), one ANIM chunk (background, loop count) and
// one ANMF chunk per frame wrapping the still's own image chunks (ALPH + VP8, or VP8L) verbatim.
// Nothing is re-encoded. Every frame is a full canvas drawn with NO blending, so a transparent pixel
// shows the background rather than the previous frame.
// Spec: https://developers.google.com/speed/webp/docs/riff_container

const td = new TextDecoder();

/** @param {Uint8Array} b @param {number} o */
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
/** @param {Uint8Array} b @param {number} o */
const u24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
/** @param {Uint8Array} b @param {number} o */
const fourcc = (b, o) => td.decode(b.subarray(o, o + 4));

/**
 * The chunks of a RIFF/WEBP file, in order. Throws on anything that is not one.
 * @param {Uint8Array} bytes @returns {{id: string, data: Uint8Array}[]}
 */
export function webpChunks(bytes) {
	if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') throw new Error('not a WebP file');
	const end = Math.min(bytes.length, 8 + u32(bytes, 4));
	/** @type {{id: string, data: Uint8Array}[]} */
	const out = [];
	let o = 12;
	while (o + 8 <= end) {
		const id = fourcc(bytes, o);
		const size = u32(bytes, o + 4);
		if (o + 8 + size > end) throw new Error('truncated WebP chunk ' + id);
		out.push({ id, data: bytes.subarray(o + 8, o + 8 + size) });
		o += 8 + size + (size & 1);
	}
	return out;
}

/**
 * The image half of a WebP still: its ALPH (optional) and VP8/VP8L chunks, its size and whether it
 * carries alpha.
 * @param {Uint8Array} bytes
 * @returns {{chunks: {id: string, data: Uint8Array}[], width: number, height: number, alpha: boolean}}
 */
export function parseWebpStill(bytes) {
	const all = webpChunks(bytes);
	if (all.some((c) => c.id === 'ANIM' || c.id === 'ANMF')) throw new Error('already animated');
	const chunks = all.filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
	const image = chunks.find((c) => c.id !== 'ALPH');
	if (!image) throw new Error('no image data in WebP');
	let width = 0;
	let height = 0;
	let alpha = chunks.some((c) => c.id === 'ALPH');
	const vp8x = all.find((c) => c.id === 'VP8X');
	if (vp8x && vp8x.data.length >= 10) {
		width = u24(vp8x.data, 4) + 1;
		height = u24(vp8x.data, 7) + 1;
	}
	const d = image.data;
	if (image.id === 'VP8L') {
		// signature 0x2f, then 14 bits width-1, 14 bits height-1, 1 bit alpha_is_used
		if (d[0] !== 0x2f) throw new Error('bad VP8L signature');
		const bits = u32(d, 1);
		if (!width) width = (bits & 0x3fff) + 1;
		if (!height) height = ((bits >>> 14) & 0x3fff) + 1;
		alpha = alpha || ((bits >>> 28) & 1) === 1;
	} else if (!width) {
		// frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height
		if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error('bad VP8 start code');
		width = (d[6] | (d[7] << 8)) & 0x3fff;
		height = (d[8] | (d[9] << 8)) & 0x3fff;
	}
	return { chunks, width, height, alpha };
}

/** @param {number[]} out @param {number} v */
const put24 = (out, v) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255);
/** @param {number[]} out @param {number} v */
const put32 = (out, v) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
/** @param {string} s */
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** a chunk's header + data + pad byte @param {string} id @param {ArrayLike<number>} data @returns {Uint8Array} */
function chunk(id, data) {
	const out = new Uint8Array(8 + data.length + (data.length & 1));
	out.set(ascii(id), 0);
	const n = data.length;
	out[4] = n & 255;
	out[5] = (n >>> 8) & 255;
	out[6] = (n >>> 16) & 255;
	out[7] = (n >>> 24) & 255;
	out.set(data, 8);
	return out;
}

/**
 * Animated WebP from WebP stills of one size.
 * @param {Uint8Array[]} stills each a complete WebP file (what toBlob gives)
 * @param {{width: number, height: number, durationsMs: number[], loop?: number, background?: [number, number, number, number]}} o
 *   `loop` 0 = forever; `background` RGBA 0..255 (a hint players may ignore)
 * @returns {Uint8Array}
 */
export function muxAnimatedWebp(stills, o) {
	if (!stills.length) throw new Error('no frames');
	const { width, height } = o;
	if (!(width >= 1 && height >= 1 && width <= 16384 && height <= 16384)) throw new Error('bad canvas size');
	const frames = stills.map((s) => parseWebpStill(s));
	const alpha = frames.some((f) => f.alpha);
	/** @type {Uint8Array[]} */
	const parts = [];
	const vp8x = [alpha ? 0x12 : 0x02, 0, 0, 0];
	put24(vp8x, width - 1);
	put24(vp8x, height - 1);
	parts.push(chunk('VP8X', vp8x));
	const [r, g, b, a] = o.background ?? [0, 0, 0, 0];
	const anim = [b & 255, g & 255, r & 255, a & 255];
	anim.push((o.loop ?? 0) & 255, ((o.loop ?? 0) >>> 8) & 255);
	parts.push(chunk('ANIM', anim));
	frames.forEach((f, i) => {
		if (f.width !== width || f.height !== height) throw new Error(`frame ${i} is ${f.width}×${f.height}, not ${width}×${height}`);
		/** @type {number[]} */
		const head = [];
		put24(head, 0); // x / 2
		put24(head, 0); // y / 2
		put24(head, width - 1);
		put24(head, height - 1);
		put24(head, Math.max(0, Math.min(0xffffff, Math.round(o.durationsMs[i] ?? 100))));
		head.push(0x02); // blending: do NOT blend; disposal: none
		const body = f.chunks.map((c) => chunk(c.id, c.data));
		const len = head.length + body.reduce((s, c) => s + c.length, 0);
		const data = new Uint8Array(len);
		data.set(head, 0);
		let at = head.length;
		for (const c of body) {
			data.set(c, at);
			at += c.length;
		}
		parts.push(chunk('ANMF', data));
	});
	const total = 4 + parts.reduce((s, p) => s + p.length, 0);
	const header = [...ascii('RIFF')];
	put32(header, total);
	header.push(...ascii('WEBP'));
	const out = new Uint8Array(8 + total);
	out.set(header, 0);
	let at = 12;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/**
 * Read an animated WebP's frame table back (tests, and the result card's frame count).
 * @param {Uint8Array} bytes @returns {{width: number, height: number, loop: number, alpha: boolean, frames: {durationMs: number, width: number, height: number}[]}}
 */
export function readAnimatedWebp(bytes) {
	const all = webpChunks(bytes);
	const vp8x = all.find((c) => c.id === 'VP8X');
	const anim = all.find((c) => c.id === 'ANIM');
	if (!vp8x || !anim) throw new Error('not an animated WebP');
	return {
		width: u24(vp8x.data, 4) + 1,
		height: u24(vp8x.data, 7) + 1,
		loop: anim.data[4] | (anim.data[5] << 8),
		alpha: (vp8x.data[0] & 0x10) !== 0,
		frames: all
			.filter((c) => c.id === 'ANMF')
			.map((c) => ({ width: u24(c.data, 6) + 1, height: u24(c.data, 9) + 1, durationMs: u24(c.data, 12) }))
	};
}
