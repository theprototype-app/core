// 100 C2-1 — TEXT IN THE CINEMATIC VIEW, the pure half (no three, no DOM: unit-tested without a browser).
//
// troika text draws through a GLSL SDF shader the WebGPU renderer cannot run. While the view is on, every
// troika text draws as a canvas-texture quad instead (labelQuads.js). The LAYOUT is not redone: troika has
// already typeset the text (fonts, wrapping, alignment, anchors, letter spacing) and its `textRenderInfo`
// carries the result — a caret box per character and a quad per glyph. This file turns that into:
//   charRuns      the strings the 2D canvas paints, one per line piece of one colour, at troika's own x
//   glyphChars    which character each glyph belongs to (troika keeps no such map)
//   glyphCells    one quad per drawn character, for texts whose glyphs are moved one by one (text on a
//                 path: three instanced rows per glyph); cells abut, so no canvas pixel is drawn twice
//   coverBounds   the rectangle the canvas covers (the block, the glyphs' reach, the outline, a margin)
//   rasterPlan    the canvas size for a rectangle (a fixed density per em, capped)
//   orientBasis   troika's `orientation` ('+x+y' default) as the quad's own axes
//   bleed         transparent texels take the ink's colour, so filtering never fades towards black

/** canvas pixels per em of the text's font size (labels are read close up; a long sign is capped by MAX_PX) */
export const PX_PER_EM = 96;
/** the longest canvas side (a long flat text is drawn at a lower density rather than a larger texture) */
export const MAX_PX = 2048;
/** the margin around the ink, in ems (italic overhang, accents, the antialiased edge) */
export const MARGIN_EM = 0.25;

/**
 * troika's "number or percent of the font size" values (outlineWidth, outlineBlur, strokeWidth).
 * @param {unknown} v @param {number} fontSize @returns {number}
 */
export function parsePercent(v, fontSize) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
	if (typeof v === 'string') {
		const m = v.trim().match(/^(-?[\d.]+)%$/);
		if (m) return (parseFloat(m[1]) / 100) * fontSize;
		const n = parseFloat(v);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

/**
 * The text-local rectangle the canvas covers: the block (line boxes), the glyphs' own reach and the
 * outline, plus a margin. [x0, y0, x1, y1], y up.
 * @param {{ blockBounds?: ArrayLike<number>, visibleBounds?: ArrayLike<number>, glyphBounds?: ArrayLike<number> }} info
 * @param {number} fontSize @param {number} [extra] outline + stroke reach, in local units
 * @returns {[number, number, number, number]}
 */
export function coverBounds(info, fontSize, extra = 0) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	/** @param {ArrayLike<number> | undefined} b */
	const add = (b) => {
		if (!b || b.length < 4) return;
		for (let i = 0; i + 3 < b.length; i += 4) {
			if (![b[i], b[i + 1], b[i + 2], b[i + 3]].every(Number.isFinite)) continue;
			x0 = Math.min(x0, b[i]);
			y0 = Math.min(y0, b[i + 1]);
			x1 = Math.max(x1, b[i + 2]);
			y1 = Math.max(y1, b[i + 3]);
		}
	};
	add(info.blockBounds);
	add(info.visibleBounds);
	if (!(x1 > x0) || !(y1 > y0)) return [0, 0, 0, 0];
	const m = Math.max(0, extra) + MARGIN_EM * fontSize;
	return [x0 - m, y0 - m, x1 + m, y1 + m];
}

/**
 * The canvas for a rectangle: PX_PER_EM per em, the longer side capped at MAX_PX.
 * @param {[number, number, number, number]} b @param {number} fontSize
 * @returns {{ w: number, h: number, px: number }} px = canvas pixels per local unit
 */
export function rasterPlan(b, fontSize, maxPx = MAX_PX) {
	const width = b[2] - b[0];
	const height = b[3] - b[1];
	if (!(width > 0) || !(height > 0) || !(fontSize > 0)) return { w: 0, h: 0, px: 0 };
	let px = PX_PER_EM / fontSize;
	const longest = Math.max(width, height) * px;
	if (longest > maxPx) px *= maxPx / longest;
	return { w: Math.max(1, Math.ceil(width * px)), h: Math.max(1, Math.ceil(height * px)), px };
}

/**
 * Which character each glyph draws: the character whose caret box holds the glyph's centre (the same
 * line, the nearest box when none holds it — a ligature's second half, a glyph past its advance).
 * @param {ArrayLike<number>} glyphBounds 4 per glyph @param {ArrayLike<number>} caretPositions 4 per char
 * @returns {Int32Array} glyph -> char index (-1: no caret data)
 */
export function glyphChars(glyphBounds, caretPositions) {
	const n = Math.floor(glyphBounds.length / 4);
	const chars = Math.floor(caretPositions.length / 4);
	const out = new Int32Array(n).fill(-1);
	for (let g = 0; g < n; g++) {
		const cx = (glyphBounds[g * 4] + glyphBounds[g * 4 + 2]) / 2;
		const cy = (glyphBounds[g * 4 + 1] + glyphBounds[g * 4 + 3]) / 2;
		let best = -1;
		let bestD = Infinity;
		for (let c = 0; c < chars; c++) {
			const a = caretPositions[c * 4];
			const b = caretPositions[c * 4 + 1];
			const bottom = caretPositions[c * 4 + 2];
			const top = caretPositions[c * 4 + 3];
			const lo = Math.min(a, b);
			const hi = Math.max(a, b);
			if (!(hi > lo)) continue; // a newline / zero-width character draws no glyph
			const dx = cx < lo ? lo - cx : cx > hi ? cx - hi : 0;
			const dy = cy < bottom ? bottom - cy : cy > top ? cy - top : 0;
			const d = dx * dx + dy * dy * 4; // the line matters more than the column
			if (d < bestD) {
				bestD = d;
				best = c;
				if (d === 0) break;
			}
		}
		out[g] = best;
	}
	return out;
}

/**
 * The pieces the canvas paints: runs of consecutive characters on one line, touching each other, of one
 * colour. Whitespace-only runs are dropped. A run starts at troika's own x for its first character.
 * @param {string} text @param {ArrayLike<number>} caretPositions 4 per char (startX, endX, bottomY, topY)
 * @param {(i: number) => number} [colorOf] a character's colour (0xRRGGBB); absent = one colour
 * @param {number} [joinTol] the gap (local units) still counted as touching
 * @returns {{ s: string, x: number, bottom: number, top: number, color: number, from: number, to: number }[]}
 */
export function charRuns(text, caretPositions, colorOf, joinTol = 1e-4) {
	/** @type {{ s: string, x: number, bottom: number, top: number, color: number, from: number, to: number, end: number }[]} */
	const runs = [];
	// troika's caret positions are indexed by UTF-16 unit: a surrogate pair is one character at its first unit
	const chars = Array.from(text);
	let unit = 0;
	/** @type {any} */
	let cur = null;
	for (const ch of chars) {
		const i = unit;
		unit += ch.length;
		if (i * 4 + 3 >= caretPositions.length) break;
		const a = caretPositions[i * 4];
		const b = caretPositions[i * 4 + 1];
		const bottom = caretPositions[i * 4 + 2];
		const top = caretPositions[i * 4 + 3];
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);
		if (ch === '\n' || ch === '\r' || !(hi >= lo)) {
			cur = null;
			continue;
		}
		const color = colorOf ? colorOf(i) : 0;
		const same = cur && Math.abs(cur.bottom - bottom) < joinTol && Math.abs(cur.end - lo) <= Math.max(joinTol, (top - bottom) * 0.02) && cur.color === color;
		if (same) {
			cur.s += ch;
			cur.end = hi;
			cur.to = i;
		} else {
			cur = { s: ch, x: lo, bottom, top, color, from: i, to: i, end: hi };
			runs.push(cur);
		}
	}
	return runs.filter((r) => r.s.trim() !== '').map(({ end, ...r }) => r);
}

/**
 * One quad per drawn character, for texts whose glyphs are moved one by one: the character's caret
 * column (cells of neighbours abut, so the shared canvas is never drawn twice) and the line box widened
 * to the glyph's own reach; a run's first and last cells reach out by `pad` for the outline.
 * @param {ArrayLike<number>} glyphBounds @param {ArrayLike<number>} caretPositions @param {Int32Array} charOf glyphChars()
 * @param {number} pad local units
 * @returns {Float32Array} 4 per glyph (x0, y0, x1, y1); a glyph with no character gets an empty cell
 */
export function glyphCells(glyphBounds, caretPositions, charOf, pad = 0) {
	const n = charOf.length;
	const out = new Float32Array(n * 4);
	const chars = Math.floor(caretPositions.length / 4);
	/** @param {number} c */
	const col = (c) => {
		const a = caretPositions[c * 4];
		const b = caretPositions[c * 4 + 1];
		return [Math.min(a, b), Math.max(a, b), caretPositions[c * 4 + 2], caretPositions[c * 4 + 3]];
	};
	/** @param {number} c @param {number} dir */
	const touches = (c, dir) => {
		const d = c + dir;
		if (d < 0 || d >= chars) return false;
		const [lo, hi, bottom] = col(c);
		const [lo2, hi2, bottom2, top2] = col(d);
		if (!(hi2 > lo2) || Math.abs(bottom2 - bottom) > 1e-4) return false;
		const tol = Math.max(1e-4, (top2 - bottom2) * 0.02);
		return dir < 0 ? Math.abs(hi2 - lo) <= tol : Math.abs(lo2 - hi) <= tol;
	};
	for (let g = 0; g < n; g++) {
		const c = charOf[g];
		if (c < 0 || c >= chars) continue;
		let [lo, hi, bottom, top] = col(c);
		if (!touches(c, -1)) lo -= pad;
		if (!touches(c, 1)) hi += pad;
		const gy0 = glyphBounds[g * 4 + 1];
		const gy1 = glyphBounds[g * 4 + 3];
		out.set([lo, Math.min(bottom, gy0) - pad, hi, Math.max(top, gy1) + pad], g * 4);
	}
	return out;
}

/**
 * troika's `orientation` as the quad's axes (text +x, text +y, the facing normal), in the text's local
 * frame. '+x+y' (and anything unreadable) is the identity: null.
 * @param {string | undefined} orientation
 * @returns {number[] | null} a column-major 3x3 basis
 */
export function orientBasis(orientation) {
	const o = String(orientation ?? '+x+y').replace(/[^-+xyz]/g, '');
	const m = o !== '+x+y' && o.match(/^([-+])([xyz])([-+])([xyz])$/);
	if (!m || m[2] === m[4]) return null;
	/** @param {string} sign @param {string} axis */
	const vec = (sign, axis) => {
		const v = [0, 0, 0];
		v['xyz'.indexOf(axis)] = sign === '-' ? -1 : 1;
		return v;
	};
	const xAxis = vec(m[1], m[2]);
	const yAxis = vec(m[3], m[4]);
	const z = [xAxis[1] * yAxis[2] - xAxis[2] * yAxis[1], xAxis[2] * yAxis[0] - xAxis[0] * yAxis[2], xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0]];
	return [...xAxis, ...yAxis, ...z].map((v) => v + 0); // no -0
}

/**
 * Where a run's baseline sits, from troika's caret box and the canvas font's own ascent / descent:
 * troika centres the caret on (ascender + descender) / 2 above the baseline.
 * @param {number} bottom @param {number} top caret box (local units)
 * @param {number} ascent @param {number} descent the canvas font's box, pixels, both positive
 * @param {number} px canvas pixels per local unit
 */
export function baselineY(bottom, top, ascent, descent, px) {
	return (bottom + top) / 2 - (ascent - descent) / 2 / px;
}

/**
 * Transparent texels take the colour of the ink (`rgb`), so bilinear filtering and mipmaps blend the
 * edge towards the text's colour instead of black (the canvas stores colour premultiplied: a fully
 * transparent pixel reads back as 0,0,0,0).
 * @param {Uint8ClampedArray | Uint8Array} data RGBA @param {[number, number, number]} rgb 0-255
 */
export function bleed(data, rgb) {
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] !== 0) continue;
		data[i] = rgb[0];
		data[i + 1] = rgb[1];
		data[i + 2] = rgb[2];
	}
	return data;
}
