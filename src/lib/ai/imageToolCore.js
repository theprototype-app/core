// Roadmap 85 — `add_image`, the PURE half (imports only the two pure sniffers; the unit layer runs it).
//
// THE URL RULES (_rules-85): https only, CORS-checked by the fetch itself, a size cap, image types only,
// re-encoded like an upload, nothing executed. The fetch runs in a person's tab with an address an agent
// chose, so a name that plainly means this machine or its network is refused before it is asked.
//
// THE CANVAS is DATA, never code: a list of drawing ops, each validated here, so a procedural texture can
// be asked for over a voice connector with nothing evaluated. `noiseField` is seeded and tileable.

import { sniffType } from '../chat/attachCore.js';
import { imageSize } from './importFileCore.js';

/** the largest file taken in, from any source */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
/** decoded size refused before decoding (a small file can claim a huge image) */
export const MAX_INPUT_PIXELS = 40_000_000;
/** the longest side kept; a larger image is scaled down with a warning */
export const MAX_OUTPUT_EDGE = 4096;
export const MAX_CANVAS_EDGE = 2048;
export const MAX_CANVAS_OPS = 500;
const MAX_POINTS = 2000;
const MAX_TEXT = 200;
const MAX_NOISE_OPS = 4;
export const FETCH_TIMEOUT_MS = 20000;

export const IMAGE_LIMITS_TEXT =
	'Limits: ' + MAX_INPUT_BYTES / 1048576 + ' MB in, ' + MAX_OUTPUT_EDGE + ' px on the long side (larger is scaled down), a canvas ' + MAX_CANVAS_EDGE + ' px and ' + MAX_CANVAS_OPS + ' ops.';

/** @param {Uint8Array} b @param {number} at @param {string} s */
const ascii = (b, at, s) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * A URL the tool may fetch. `{url}` or `{error}`.
 * @param {unknown} raw @returns {{url: string} | {error: string}}
 */
export function checkImageUrl(raw) {
	/** @type {URL} */
	let u;
	try {
		u = new URL(String(raw ?? ''));
	} catch {
		return { error: 'url: not an address: ' + String(raw).slice(0, 80) };
	}
	if (u.protocol !== 'https:') return { error: 'url: only https addresses are fetched (got ' + u.protocol.replace(':', '') + ')' };
	if (u.username || u.password) return { error: 'url: an address with a login in it is refused' };
	if (isPrivateHost(u.hostname)) return { error: 'url: that address is on this machine or its local network; pass the image as data (base64) instead' };
	return { url: u.href };
}

/** this machine or its network, by name: what a public image never is @param {string} host */
export function isPrivateHost(host) {
	const h = host.toLowerCase().replace(/\.$/, '');
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
	if (h.startsWith('[')) return true; // an IPv6 literal: no public image is addressed so
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * What the bytes ARE, and whether this tool takes them. The name and any declared type play no part.
 * @param {Uint8Array} b @returns {{mime: string} | {error: string}}
 */
export function sniffImage(b) {
	if (!b?.length) return { error: 'the image is empty' };
	if (b.length > MAX_INPUT_BYTES) return { error: 'the image is ' + (b.length / 1048576).toFixed(1) + ' MB; the limit is ' + MAX_INPUT_BYTES / 1048576 + ' MB' };
	const type = sniffType(b);
	if (type === 'image/heic') return { error: 'HEIC images cannot be read here; convert it to PNG or JPEG' };
	if (type) return { mime: type };
	if (b.length >= 12 && ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis'))) return { mime: 'image/avif' };
	const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase();
	if (head.startsWith('<svg') || head.startsWith('<?xml')) return { error: 'SVG is refused (it can carry scripts); use a PNG, or draw it with canvas' };
	if (head.startsWith('<')) return { error: 'that is a web page, not an image (a login page or a preview page?)' };
	return { error: 'that is not a PNG, JPEG, WebP, GIF or AVIF (read from its bytes)' };
}

/** @param {Uint8Array} b */
function jpegSize(b) {
	let i = 2;
	while (i + 9 < b.length && b[i] === 0xff) {
		const marker = b[i + 1];
		const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (sof) return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
		i += 2 + ((b[i + 2] << 8) | b[i + 3]);
	}
	return null;
}

/**
 * A size refusal from the HEADER, before anything is decoded. Unknown size = decoded and checked after.
 * @param {Uint8Array} b @param {string} mime @returns {string | null}
 */
export function pixelRefusal(b, mime) {
	const size =
		mime === 'image/jpeg' ? jpegSize(b)
		: mime === 'image/gif' ? { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) }
		: mime === 'image/avif' ? null
		: imageSize(b);
	return size ? tooManyPixels(size.w, size.h) : null;
}

/** @param {number} w @param {number} h @returns {string | null} */
export function tooManyPixels(w, h) {
	return w * h > MAX_INPUT_PIXELS ? 'the image is ' + w + ' x ' + h + ' pixels; the limit is ' + MAX_INPUT_PIXELS / 1e6 + ' megapixels' : null;
}

/** the size to encode at, long side capped @param {number} w @param {number} h */
export function outputSize(w, h) {
	const k = Math.min(1, MAX_OUTPUT_EDGE / Math.max(w, h));
	return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
}

/** an address as the provenance keeps it: no query, no fragment (they can hold tokens) @param {string} url */
export function sourceOfUrl(url) {
	const u = new URL(url);
	return (u.origin + u.pathname).slice(0, 300);
}

// ---------------------------------------------------------------- the canvas

/** a colour the canvas takes: hex or a plain CSS name, never a function or a url(). @param {any} v */
export function canvasColor(v) {
	if (typeof v !== 'string') return null;
	const c = v.trim();
	return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c) || /^[a-z]{3,24}$/i.test(c) ? c : null;
}

const FONTS = /** @type {Record<string, string>} */ ({ sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'ui-monospace, monospace' });

/** @param {any} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const num = (v, d, lo, hi) => (finite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * Validate a canvas spec. `{width, height, background, ops}` cleaned, or `{error}` naming the op at fault.
 * @param {any} spec @returns {any}
 */
export function parseCanvas(spec) {
	if (!spec || typeof spec !== 'object') return { error: 'canvas: takes {width, height, ops: [...]}' };
	const width = Math.floor(spec.width);
	const height = Math.floor(spec.height);
	if (!(width >= 1 && width <= MAX_CANVAS_EDGE && height >= 1 && height <= MAX_CANVAS_EDGE)) return { error: 'canvas: width and height take 1 to ' + MAX_CANVAS_EDGE + ' pixels' };
	const rawOps = Array.isArray(spec.ops) ? spec.ops : [];
	if (rawOps.length > MAX_CANVAS_OPS) return { error: 'canvas: at most ' + MAX_CANVAS_OPS + ' ops' };
	if (!rawOps.length && spec.background === undefined) return { error: 'canvas: nothing to draw: give ops, or a background' };
	let background = null;
	if (spec.background !== undefined) {
		background = canvasColor(spec.background);
		if (!background) return { error: 'canvas.background: a colour, e.g. #336699 or white' };
	}
	/** @type {any[]} */
	const ops = [];
	let points = 0;
	let noises = 0;
	for (let i = 0; i < rawOps.length; i++) {
		const made = parseOp(rawOps[i]);
		if (made.error) return { error: 'canvas.ops[' + i + ']: ' + made.error };
		points += made.points?.length ?? 0;
		if (points > MAX_POINTS) return { error: 'canvas: at most ' + MAX_POINTS + ' line points in all' };
		if (made.op === 'noise' && ++noises > MAX_NOISE_OPS) return { error: 'canvas: at most ' + MAX_NOISE_OPS + ' noise ops' };
		ops.push(made);
	}
	return { width, height, background, ops };
}

/** @param {any} o @returns {any} fill / stroke of a shape */
function paint(o) {
	const out = /** @type {any} */ ({});
	if (o.fill !== undefined && !(out.fill = canvasColor(o.fill))) return { error: 'fill: a colour' };
	if (o.stroke !== undefined && !(out.stroke = canvasColor(o.stroke))) return { error: 'stroke: a colour' };
	if (!out.fill && !out.stroke) return { error: 'give fill or stroke' };
	out.lineWidth = num(o.lineWidth, 1, 0.1, 500);
	return out;
}

/** @param {any} v @param {number} n how many colours @returns {string[] | null} */
function colours(v, n) {
	const list = Array.isArray(v) ? v.map(canvasColor) : [];
	return list.length === n && list.every(Boolean) ? /** @type {string[]} */ (list) : null;
}

/** @param {any} o @returns {any} */
function parseOp(o) {
	if (!o || typeof o !== 'object') return { error: 'not an op' };
	const box = { x: num(o.x, 0, -1e5, 1e5), y: num(o.y, 0, -1e5, 1e5) };
	switch (o.op) {
		case 'rect': {
			if (!finite(o.w) || !finite(o.h)) return { error: 'rect: takes x, y, w, h' };
			const p = paint(o);
			return p.error ? p : { op: 'rect', ...box, w: o.w, h: o.h, radius: num(o.radius, 0, 0, 1e5), ...p };
		}
		case 'circle': {
			if (!finite(o.r) || o.r <= 0) return { error: 'circle: takes x, y, r' };
			const p = paint(o);
			return p.error ? p : { op: 'circle', ...box, r: o.r, ...p };
		}
		case 'line': {
			const pts = Array.isArray(o.points) ? o.points : [];
			if (pts.length < 2 || !pts.every((/** @type {any} */ q) => Array.isArray(q) && q.length === 2 && finite(q[0]) && finite(q[1]))) return { error: 'line: points: [[x, y], ...], at least two' };
			const p = paint(o.fill === undefined && o.stroke === undefined ? { ...o, stroke: '#000000' } : o);
			return p.error ? p : { op: 'line', points: pts, closed: o.closed === true, ...p };
		}
		case 'text': {
			if (typeof o.text !== 'string' || !o.text) return { error: 'text: takes text, x, y' };
			const fill = canvasColor(o.fill ?? '#000000');
			if (!fill) return { error: 'fill: a colour' };
			return {
				op: 'text',
				...box,
				text: o.text.slice(0, MAX_TEXT),
				size: num(o.size, 32, 4, 1024),
				font: FONTS[o.font] ?? FONTS.sans,
				bold: o.bold === true,
				align: ['left', 'center', 'right'].includes(o.align) ? o.align : 'left',
				fill
			};
		}
		case 'gradient': {
			const stops = Array.isArray(o.stops) ? o.stops : [];
			if (stops.length < 2 || stops.length > 16) return { error: 'gradient: stops: 2 to 16 of [offset, colour]' };
			/** @type {[number, string][]} */
			const clean = [];
			for (const s of stops) {
				const c = canvasColor(s?.[1]);
				if (!c || !finite(s?.[0])) return { error: 'gradient: stops: [offset 0..1, colour]' };
				clean.push([num(s[0], 0, 0, 1), c]);
			}
			return { op: 'gradient', kind: o.kind === 'radial' ? 'radial' : 'linear', angle: num(o.angle, 90, -3600, 3600), stops: clean };
		}
		case 'checker': {
			const c = colours(o.colors, 2);
			if (!c) return { error: 'checker: colors: [a, b]' };
			return { op: 'checker', cols: Math.floor(num(o.cols, 8, 1, 512)), rows: Math.floor(num(o.rows ?? o.cols, 8, 1, 512)), colors: c };
		}
		case 'stripes': {
			const c = colours(o.colors, 2);
			if (!c) return { error: 'stripes: colors: [a, b]' };
			return { op: 'stripes', count: Math.floor(num(o.count, 8, 1, 512)), vertical: o.vertical === true, colors: c };
		}
		case 'noise': {
			const c = colours(o.colors ?? ['#000000', '#ffffff'], 2);
			if (!c) return { error: 'noise: colors: [dark, light]' };
			return { op: 'noise', scale: Math.floor(num(o.scale, 8, 1, 256)), octaves: Math.floor(num(o.octaves, 4, 1, 6)), seed: Math.floor(num(o.seed, 1, 0, 2 ** 31)), opacity: num(o.opacity, 1, 0, 1), colors: c };
		}
		default:
			return { error: 'unknown op "' + String(o.op).slice(0, 24) + '"; one of rect, circle, line, text, gradient, checker, stripes, noise' };
	}
}

/**
 * Seeded value noise in 0..1 that tiles at the canvas edges (a texture repeats without a seam).
 * @param {number} w @param {number} h @param {{scale: number, octaves: number, seed: number}} o @returns {Float32Array}
 */
export function noiseField(w, h, o) {
	const out = new Float32Array(w * h);
	/** the lattice value at a wrapped cell: a small integer hash, the same on every machine @param {number} x @param {number} y @param {number} s */
	const lattice = (x, y, s) => {
		let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) | 0;
		n = Math.imul(n ^ (n >>> 13), 1274126177);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
	};
	/** @param {number} t */
	const smooth = (t) => t * t * (3 - 2 * t);
	let norm = 0;
	for (let oct = 0, amp = 1; oct < o.octaves; oct++, amp /= 2) norm += amp;
	for (let oct = 0, amp = 1; oct < o.octaves; oct++, amp /= 2) {
		const cells = o.scale << oct;
		const s = o.seed + oct * 101;
		for (let py = 0; py < h; py++) {
			const fy = (py / h) * cells;
			const y0 = Math.floor(fy);
			const ty = smooth(fy - y0);
			for (let px = 0; px < w; px++) {
				const fx = (px / w) * cells;
				const x0 = Math.floor(fx);
				const tx = smooth(fx - x0);
				const a = lattice(x0 % cells, y0 % cells, s);
				const b = lattice((x0 + 1) % cells, y0 % cells, s);
				const c = lattice(x0 % cells, (y0 + 1) % cells, s);
				const d = lattice((x0 + 1) % cells, (y0 + 1) % cells, s);
				out[py * w + px] += (amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty)) / norm;
			}
		}
	}
	return out;
}

/** '#rgb[a]' / '#rrggbb[aa]' to [r, g, b]; a named colour is resolved by the caller @param {string} c */
function hexRgb(c) {
	const h = c.slice(1);
	const long = h.length <= 4 ? [...h].map((x) => x + x).join('') : h;
	return [parseInt(long.slice(0, 2), 16), parseInt(long.slice(2, 4), 16), parseInt(long.slice(4, 6), 16)];
}

/**
 * Draw a parsed spec on a 2D context (a real one, or a recording fake in the unit layer).
 * @param {any} ctx @param {any} spec parseCanvas' result
 */
export function drawCanvas(ctx, spec) {
	const { width: W, height: H } = spec;
	if (spec.background) {
		ctx.fillStyle = spec.background;
		ctx.fillRect(0, 0, W, H);
	}
	/** what a colour string reads as, through the context's own parser @param {string} c */
	const rgb = (c) => {
		ctx.fillStyle = c;
		const s = String(ctx.fillStyle);
		return s.startsWith('#') ? hexRgb(s) : (s.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
	};
	const finish = (/** @type {any} */ o) => {
		if (o.fill) {
			ctx.fillStyle = o.fill;
			ctx.fill();
		}
		if (o.stroke) {
			ctx.strokeStyle = o.stroke;
			ctx.lineWidth = o.lineWidth;
			ctx.stroke();
		}
	};
	for (const o of spec.ops) {
		switch (o.op) {
			case 'rect':
				ctx.beginPath();
				if (o.radius && ctx.roundRect) ctx.roundRect(o.x, o.y, o.w, o.h, o.radius);
				else ctx.rect(o.x, o.y, o.w, o.h);
				finish(o);
				break;
			case 'circle':
				ctx.beginPath();
				ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
				finish(o);
				break;
			case 'line':
				ctx.beginPath();
				ctx.moveTo(o.points[0][0], o.points[0][1]);
				for (const p of o.points.slice(1)) ctx.lineTo(p[0], p[1]);
				if (o.closed) ctx.closePath();
				finish(o);
				break;
			case 'text':
				ctx.font = (o.bold ? 'bold ' : '') + o.size + 'px ' + o.font;
				ctx.textAlign = o.align;
				ctx.textBaseline = 'top';
				ctx.fillStyle = o.fill;
				ctx.fillText(o.text, o.x, o.y);
				break;
			case 'gradient': {
				const rad = (o.angle * Math.PI) / 180;
				const [dx, dy] = [Math.sin(rad) * W * 0.5, -Math.cos(rad) * H * 0.5];
				const g =
					o.kind === 'radial'
						? ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2)
						: ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
				for (const [at, c] of o.stops) g.addColorStop(at, c);
				ctx.fillStyle = g;
				ctx.fillRect(0, 0, W, H);
				break;
			}
			case 'checker':
				for (let r = 0; r < o.rows; r++) {
					for (let c = 0; c < o.cols; c++) {
						ctx.fillStyle = o.colors[(r + c) % 2];
						const [x0, y0] = [Math.round((c * W) / o.cols), Math.round((r * H) / o.rows)];
						ctx.fillRect(x0, y0, Math.round(((c + 1) * W) / o.cols) - x0, Math.round(((r + 1) * H) / o.rows) - y0);
					}
				}
				break;
			case 'stripes':
				for (let i = 0; i < o.count; i++) {
					ctx.fillStyle = o.colors[i % 2];
					if (o.vertical) ctx.fillRect(Math.round((i * W) / o.count), 0, Math.ceil(W / o.count), H);
					else ctx.fillRect(0, Math.round((i * H) / o.count), W, Math.ceil(H / o.count));
				}
				break;
			case 'noise': {
				const [a, b] = [rgb(o.colors[0]), rgb(o.colors[1])];
				const field = noiseField(W, H, o);
				const img = ctx.getImageData(0, 0, W, H);
				for (let i = 0; i < field.length; i++) {
					const j = i * 4;
					const k = o.opacity;
					const under = img.data[j + 3] / 255;
					for (let c = 0; c < 3; c++) img.data[j + c] = (a[c] + (b[c] - a[c]) * field[i]) * k + img.data[j + c] * under * (1 - k);
					img.data[j + 3] = 255 * (k + under * (1 - k));
				}
				ctx.putImageData(img, 0, 0);
				break;
			}
		}
	}
}

/** the `canvas` argument's schema */
export const IMAGE_CANVAS_SCHEMA = {
	type: 'object',
	description:
		'Draw an image from data. Coordinates in pixels from the top left. Ops in order: rect {x,y,w,h,radius?,fill?,stroke?,lineWidth?}, circle {x,y,r,fill?,stroke?}, line {points,closed?,stroke?,fill?,lineWidth?}, ' +
		'text {text,x,y,size?,font: sans|serif|mono,bold?,align?,fill?}, gradient {kind: linear|radial,angle?,stops: [[0,"#111"],[1,"#eee"]]}, checker {cols,rows,colors: [a,b]}, stripes {count,vertical?,colors: [a,b]}, ' +
		'noise {scale,octaves?,seed?,opacity?,colors: [dark,light]} (tiles at the edges). Colours: hex or a CSS name.',
	properties: {
		width: { type: 'integer', minimum: 1, maximum: MAX_CANVAS_EDGE },
		height: { type: 'integer', minimum: 1, maximum: MAX_CANVAS_EDGE },
		background: { type: 'string', description: 'a colour; omit for transparent' },
		ops: { type: 'array', maxItems: MAX_CANVAS_OPS, items: { type: 'object', properties: { op: { type: 'string', enum: ['rect', 'circle', 'line', 'text', 'gradient', 'checker', 'stripes', 'noise'] } }, required: ['op'] } }
	},
	required: ['width', 'height']
};
