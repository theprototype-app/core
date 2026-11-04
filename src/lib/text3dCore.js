// 64-text — the ONE text object, the pure half of its EXTRUDED mode and of the block layout both
// modes share. A LEAF that imports nothing (the runtime, the font import path, the Inspector, the
// agent tool and vitest all use it).
//
// Flat text is troika's (SDF, outline, text on a path, per-letter styles — textPathRuntime).
// Extruded text is real geometry built LOCALLY on every peer from the record (the record is all
// that travels or saves, golden rule 8): opentype.js reads the font, `layoutBlock` places every
// character (wrap at maxWidth, align, line height, letter spacing, kerning, the 9-grid anchor),
// `pathToContours` flattens each glyph's outline at the record's quality, `contoursToShapes`
// sorts the loops into outlines and holes ("O", "B", "%") by NESTING — TrueType and CFF fonts
// wind their outlines opposite ways, so winding alone cannot tell a hole from an island — and
// the runtime extrudes the lot as ONE geometry (caps = material 0, sides = material 1).
//
// Fonts the user adds are Library assets; `sniffFont` tells the four formats apart by their
// magic bytes, `fontLicence` reads the `name` table's licence + URL and the OS/2 `fsType`
// embedding bits (TX3b), and `googleCssUrl` / `pickGoogleFontUrl` turn a Google Fonts family
// name into ONE file fetched once at import (never at run time).

/** @typedef {number[][]} Loop  closed polygon, [x, y] per vertex, no repeated end point */
/** @typedef {{outer: Loop, holes: Loop[]}} ShapeLoops */

// ---- glyph outlines --------------------------------------------------------------------------

/**
 * Flatten an opentype.js path (its `commands`: M / L / Q / C / Z, font units, y UP as the font
 * draws it when read through `glyph.path`) into closed loops.
 * @param {ArrayLike<any>} commands @param {number} segments per curve (>= 1)
 * @param {{scale?: number, dx?: number, dy?: number}=} map  x' = x·scale + dx, y' = y·scale + dy
 * @returns {Loop[]}
 */
export function pathToContours(commands, segments, map = {}) {
	const k = map.scale ?? 1;
	const ox = map.dx ?? 0;
	const oy = map.dy ?? 0;
	const n = Math.max(1, Math.floor(segments || 1));
	/** @type {Loop[]} */
	const loops = [];
	/** @type {Loop} */
	let cur = [];
	let x = 0;
	let y = 0;
	const push = (/** @type {number} */ px, /** @type {number} */ py) => cur.push([px * k + ox, py * k + oy]);
	const close = () => {
		if (cur.length > 1) {
			const a = cur[0];
			const b = cur[cur.length - 1];
			if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) cur.pop();
		}
		// drop consecutive duplicates (a zero-length segment has no direction)
		const clean = cur.filter((p, i) => i === 0 || Math.abs(p[0] - cur[i - 1][0]) > 1e-9 || Math.abs(p[1] - cur[i - 1][1]) > 1e-9);
		if (clean.length >= 3 && Math.abs(signedArea(clean)) > 1e-12) loops.push(clean);
		cur = [];
	};
	for (const c of Array.from(commands ?? [])) {
		if (!c || typeof c.type !== 'string') continue;
		if (c.type === 'M') {
			if (cur.length) close();
			x = c.x;
			y = c.y;
			push(x, y);
		} else if (c.type === 'L') {
			x = c.x;
			y = c.y;
			push(x, y);
		} else if (c.type === 'Q') {
			for (let i = 1; i <= n; i++) {
				const t = i / n;
				const u = 1 - t;
				push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
			}
			x = c.x;
			y = c.y;
		} else if (c.type === 'C') {
			for (let i = 1; i <= n; i++) {
				const t = i / n;
				const u = 1 - t;
				push(
					u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
					u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y
				);
			}
			x = c.x;
			y = c.y;
		} else if (c.type === 'Z') {
			close();
		}
	}
	if (cur.length) close();
	return loops;
}

/** shoelace: positive = counter-clockwise @param {Loop} loop */
export function signedArea(loop) {
	let a = 0;
	for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += (loop[j][0] - loop[i][0]) * (loop[j][1] + loop[i][1]);
	return a / 2;
}

/** even-odd point in polygon @param {number[]} p @param {Loop} loop */
export function pointInLoop(p, loop) {
	let inside = false;
	for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
		const [xi, yi] = loop[i];
		const [xj, yj] = loop[j];
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-30) + xi) inside = !inside;
	}
	return inside;
}

/** a point safely inside a loop's area, for containment tests (a vertex can sit ON another loop) @param {Loop} loop */
function probePoint(loop) {
	// the midpoint of the first edge, nudged a hair to its inside
	const a = loop[0];
	const b = loop[1];
	const ccw = signedArea(loop) > 0;
	const ex = b[0] - a[0];
	const ey = b[1] - a[1];
	const l = Math.hypot(ex, ey) || 1;
	const s = 1e-6 * l;
	// left normal is inside for a CCW loop
	const nx = ccw ? -ey / l : ey / l;
	const ny = ccw ? ex / l : -ex / l;
	return [(a[0] + b[0]) / 2 + nx * s, (a[1] + b[1]) / 2 + ny * s];
}

/**
 * Sort loops into filled outlines with their holes by NESTING DEPTH (even = outline, odd = hole),
 * whatever direction the font wound them. Outlines come out counter-clockwise and holes clockwise
 * (what THREE.Shape / ExtrudeGeometry expect); an island inside a hole (the dot of a "◉") is an
 * outline again.
 * @param {Loop[]} loops @returns {ShapeLoops[]}
 */
export function contoursToShapes(loops) {
	const list = (loops ?? []).filter((l) => Array.isArray(l) && l.length >= 3);
	const areas = list.map((l) => Math.abs(signedArea(l)));
	const probes = list.map(probePoint);
	// parent = the smallest loop that contains this one
	const parent = list.map((_, i) => {
		let best = -1;
		for (let j = 0; j < list.length; j++) {
			if (j === i || areas[j] <= areas[i]) continue;
			if (!pointInLoop(probes[i], list[j])) continue;
			if (best < 0 || areas[j] < areas[best]) best = j;
		}
		return best;
	});
	const depth = list.map((_, i) => {
		let d = 0;
		for (let p = parent[i]; p >= 0 && d < 64; p = parent[p]) d++;
		return d;
	});
	/** @type {Map<number, ShapeLoops>} */
	const shapes = new Map();
	const oriented = (/** @type {Loop} */ l, /** @type {boolean} */ ccw) => (signedArea(l) > 0 === ccw ? l.slice() : l.slice().reverse());
	list.forEach((l, i) => {
		if (depth[i] % 2 === 0) shapes.set(i, { outer: oriented(l, true), holes: [] });
	});
	list.forEach((l, i) => {
		if (depth[i] % 2 === 1) shapes.get(parent[i])?.holes.push(oriented(l, false));
	});
	return [...shapes.values()];
}

/**
 * Carry 2D loops through a letter's style: scale + turn about its pivot, then nudge.
 * @param {ShapeLoops[]} shapes @param {{size: number, rot: number, dx: number, dy: number}} st
 * @param {number[]} pivot [x, y] @param {number} em metres per em (dx / dy are in ems)
 * @returns {ShapeLoops[]}
 */
export function styleShapes(shapes, st, pivot, em) {
	const s = st?.size ?? 1;
	const r = ((st?.rot ?? 0) * Math.PI) / 180;
	const nx = (st?.dx ?? 0) * em;
	const ny = (st?.dy ?? 0) * em;
	if (s === 1 && r === 0 && nx === 0 && ny === 0) return shapes;
	const cs = Math.cos(r) * s;
	const sn = Math.sin(r) * s;
	const map = (/** @type {Loop} */ l) =>
		l.map(([x, y]) => {
			const u = x - pivot[0];
			const v = y - pivot[1];
			return [pivot[0] + cs * u - sn * v + nx, pivot[1] + sn * u + cs * v + ny];
		});
	// a negative scale would flip winding; sizes are clamped > 0 by the record
	return shapes.map((sh) => ({ outer: map(sh.outer), holes: sh.holes.map(map) }));
}

// ---- the block layout (extruded text; troika does flat text's) -------------------------------

/** the 9-grid anchor's two halves @param {string} anchor */
export function anchorParts(anchor) {
	const [v, h] = String(anchor ?? 'middle-center').split('-');
	return {
		x: h === 'left' || h === 'right' ? h : 'center',
		y: v === 'top' || v === 'bottom' ? v : 'middle'
	};
}

/** the record's align → CSS text-align (block text) @param {string} align */
export function blockAlign(align) {
	return align === 'start' ? 'left' : align === 'end' ? 'right' : align === 'fit' ? 'justify' : 'center';
}

/**
 * Place every character of a block of text. Units: metres; the font is described in EMS so a
 * fake font tests it. Lines break at '\n' and, with maxWidth > 0, at spaces (a word longer than
 * the line stays whole, as in CSS `overflow-wrap: normal`). The block is then moved onto its
 * anchor: x by its widest line, y by its first line's ascender and last line's descender.
 *
 * @param {string[]} chars one entry per character (code point)
 * @param {{advance: (ch: string) => number, kern?: (a: string, b: string) => number, ascender: number, descender: number}} metrics ems
 * @param {{size: number, spacing: number, lineHeight: number, maxWidth: number, align: string, anchor: string}} p
 * @returns {{x: Float64Array, y: Float64Array, line: Int32Array, advance: Float64Array, width: number, height: number, lines: number}}
 *   per character its pen position (left edge on its baseline) and advance; `width`/`height` of the block
 */
export function layoutBlock(chars, metrics, p) {
	const n = chars.length;
	const em = p.size;
	const adv = new Float64Array(n);
	const kernBefore = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const ch = chars[i];
		adv[i] = ch === '\n' ? 0 : (metrics.advance(ch) + (p.spacing || 0)) * em;
		if (i > 0 && metrics.kern && chars[i - 1] !== '\n' && ch !== '\n') kernBefore[i] = metrics.kern(chars[i - 1], ch) * em;
	}
	// break into lines: arrays of character indices
	/** @type {number[][]} */
	const lines = [[]];
	const maxW = p.maxWidth > 0 ? p.maxWidth : Infinity;
	let lineW = 0;
	let lastSpace = -1; // index in the current line's array
	for (let i = 0; i < n; i++) {
		const ch = chars[i];
		let line = lines[lines.length - 1];
		if (ch === '\n') {
			line.push(i);
			lines.push([]);
			lineW = 0;
			lastSpace = -1;
			continue;
		}
		const w = adv[i] + (line.length ? kernBefore[i] : 0);
		if (ch !== ' ' && lineW + w > maxW + 1e-9 && line.length && lastSpace >= 0) {
			// wrap at the last space: the space stays at the end of the old line (and is not counted)
			const moved = line.splice(lastSpace + 1);
			lines.push(moved);
			line = moved;
			lineW = moved.reduce((s, c, j) => s + adv[c] + (j ? kernBefore[c] : 0), 0);
			lastSpace = -1;
		}
		line.push(i);
		lineW += line.length > 1 ? w : adv[i];
		if (ch === ' ') lastSpace = line.length - 1;
	}
	const x = new Float64Array(n);
	const y = new Float64Array(n);
	const lineOf = new Int32Array(n);
	const lh = (p.lineHeight || 1.2) * em;
	/** visible width of a line: trailing spaces and the newline do not count @param {number[]} line */
	const widthOf = (line) => {
		let end = line.length;
		while (end > 0 && (chars[line[end - 1]] === ' ' || chars[line[end - 1]] === '\n')) end--;
		let w = 0;
		for (let j = 0; j < end; j++) w += adv[line[j]] + (j ? kernBefore[line[j]] : 0);
		return w;
	};
	const widths = lines.map(widthOf);
	const blockW = Math.max(0, ...widths);
	const align = blockAlign(p.align);
	lines.forEach((line, k) => {
		const w = widths[k];
		let pen = align === 'center' ? (blockW - w) / 2 : align === 'right' ? blockW - w : 0;
		// justify: spread the slack over the gaps of every line but the last (and a forced break's)
		let gap = 0;
		const forced = line.length && chars[line[line.length - 1]] === '\n';
		if (align === 'justify' && k < lines.length - 1 && !forced) {
			const spaces = line.filter((c, j) => chars[c] === ' ' && j < line.length - 1).length;
			if (spaces > 0) gap = (blockW - w) / spaces;
		}
		line.forEach((c, j) => {
			if (j) pen += kernBefore[c];
			x[c] = pen;
			y[c] = -k * lh;
			lineOf[c] = k;
			pen += adv[c] + (chars[c] === ' ' ? gap : 0);
		});
	});
	// the block: first baseline at 0, top = ascender above it, bottom = descender below the last
	const top = metrics.ascender * em;
	const bottom = -(lines.length - 1) * lh + metrics.descender * em;
	const a = anchorParts(p.anchor);
	const dx = a.x === 'left' ? 0 : a.x === 'right' ? -blockW : -blockW / 2;
	const dy = a.y === 'top' ? -top : a.y === 'bottom' ? -bottom : -(top + bottom) / 2;
	for (let i = 0; i < n; i++) {
		x[i] += dx;
		y[i] += dy;
	}
	return { x, y, line: lineOf, advance: adv, width: blockW, height: top - bottom, lines: lines.length };
}

/**
 * Per-letter style rows for troika's BLOCK layout (flat text with no path): each glyph keeps its
 * place and is scaled / turned about its own advance centre on its caret bottom, then nudged —
 * the same 12 floats per glyph `layoutOnPath` writes, so one shader serves both.
 * @param {{glyphBounds: ArrayLike<number>, glyphChars: ArrayLike<number>, caretPositions: ArrayLike<number>, fontSize: number}} info
 * @param {{size: number, dx: number, dy: number, rot: number}[]} styles per character
 * @param {number} stride troika's caret stride
 * @returns {{rows: Float32Array, hidden: Uint8Array}}
 */
export function layoutInPlace(info, styles, stride) {
	const glyphCount = Math.floor((info.glyphBounds?.length ?? 0) / 4);
	const rows = new Float32Array(glyphCount * 12);
	const hidden = new Uint8Array(glyphCount);
	const caret = info.caretPositions ?? [];
	const charCount = Math.floor(caret.length / stride);
	const em = info.fontSize || 1;
	for (let g = 0; g < glyphCount; g++) {
		const c = Math.min(Math.max(0, info.glyphChars?.[g] ?? 0), Math.max(0, charCount - 1));
		const st = styles[c] ?? { size: 1, dx: 0, dy: 0, rot: 0 };
		const px = charCount ? (caret[c * stride] + caret[c * stride + 1]) / 2 : 0;
		const py = charCount ? caret[c * stride + 2] : 0;
		const s = st.size ?? 1;
		const r = ((st.rot ?? 0) * Math.PI) / 180;
		const cs = Math.cos(r) * s;
		const sn = Math.sin(r) * s;
		const o = g * 12;
		rows[o] = cs;
		rows[o + 1] = -sn;
		rows[o + 2] = 0;
		rows[o + 3] = px - (cs * px - sn * py) + (st.dx ?? 0) * em;
		rows[o + 4] = sn;
		rows[o + 5] = cs;
		rows[o + 6] = 0;
		rows[o + 7] = py - (sn * px + cs * py) + (st.dy ?? 0) * em;
		rows[o + 8] = 0;
		rows[o + 9] = 0;
		rows[o + 10] = s;
		rows[o + 11] = 0;
	}
	return { rows, hidden };
}

// ---- fonts the user adds ---------------------------------------------------------------------

/** @param {ArrayLike<number>} b @returns {'ttf' | 'otf' | 'woff' | 'woff2' | null} */
export function sniffFont(b) {
	if (!b || b.length < 4) return null;
	const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
	if (tag === 'wOFF') return 'woff';
	if (tag === 'wOF2') return 'woff2';
	if (tag === 'OTTO') return 'otf';
	if (tag === 'true' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return 'ttf';
	return null;
}

/** font file extensions the Library takes */
export const FONT_EXTENSIONS = Object.freeze(['ttf', 'otf', 'woff', 'woff2']);

/**
 * OS/2 `fsType` (OpenType spec): bits 0-3 are the usage permission — 0x2 = "restricted licence
 * embedding" (must not be embedded at all); bit 9 (0x200) = bitmap embedding only (no outlines).
 * Either forbids carrying the font inside an exported game.
 * @param {number | null | undefined} fsType
 */
export function embeddingForbidden(fsType) {
	if (typeof fsType !== 'number' || !Number.isFinite(fsType)) return false;
	return (fsType & 0x000f) === 0x0002 || (fsType & 0x0200) === 0x0200;
}

/** first value of an opentype.js localised name record @param {any} rec */
const nameText = (rec) => {
	if (!rec || typeof rec !== 'object') return '';
	const v = rec.en ?? rec['en-US'] ?? Object.values(rec)[0];
	return typeof v === 'string' ? v : '';
};

/**
 * What a font says about itself (TX3b), from an opentype.js Font (or anything shaped like one):
 * family, licence description (name ID 13) + URL (ID 14), fsType and whether that forbids
 * embedding. Strings are trimmed to sane lengths — a font file is user input.
 * @param {any} font
 * @returns {{family: string, licence: string, url: string, fsType: number | null, noEmbed: boolean}}
 */
export function fontLicence(font) {
	const names = font?.names ?? {};
	const clean = (/** @type {string} */ s, /** @type {number} */ n) => s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
	const family = clean(nameText(names.preferredFamily) || nameText(names.fontFamily), 80);
	const licence = clean(nameText(names.license), 400);
	let url = clean(nameText(names.licenseURL), 300);
	if (url && !/^https?:\/\//i.test(url)) url = '';
	const fsType = typeof font?.tables?.os2?.fsType === 'number' ? font.tables.os2.fsType : null;
	return { family, licence, url, fsType, noEmbed: embeddingForbidden(fsType) };
}

/** a short licence label for the Inspector line @param {string} licence @param {string} url */
export function licenceLabel(licence, url) {
	const t = `${licence} ${url}`;
	if (/SIL Open Font License|OFL|scripts\.sil\.org\/OFL|openfontlicense/i.test(t)) return 'SIL Open Font License';
	if (/Apache License|apache\.org\/licenses/i.test(t)) return 'Apache License 2.0';
	if (/Ubuntu Font Licen[cs]e/i.test(t)) return 'Ubuntu Font Licence';
	if (/creativecommons\.org\/publicdomain|CC0|public domain/i.test(t)) return 'Public domain (CC0)';
	if (!licence && !url) return '';
	return licence ? licence.slice(0, 60) + (licence.length > 60 ? '…' : '') : 'See the licence link';
}

/** a Google Fonts family name the importer accepts (letters, digits, spaces) @param {any} name */
export function cleanFamilyName(name) {
	if (typeof name !== 'string') return null;
	const n = name.replace(/\s+/g, ' ').trim();
	return /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(n) ? n : null;
}

/**
 * The CSS2 API URL for ONE face of a family (regular, or bold / italic).
 * @param {string} family @param {{bold?: boolean, italic?: boolean}=} o
 */
export function googleCssUrl(family, o = {}) {
	const fam = encodeURIComponent(family).replace(/%20/g, '+');
	const w = o.bold ? 700 : 400;
	const axis = o.italic ? `ital,wght@1,${w}` : `wght@${w}`;
	return `https://fonts.googleapis.com/css2?family=${fam}:${axis}&display=swap`;
}

/**
 * From the CSS the API returns, the file of the LATIN subset (the API splits a family into
 * unicode-range subsets, each preceded by a `/* latin *\/` comment); without subset comments
 * (an old user agent's single-file answer) the first `src: url(...)`.
 * @param {string} css @returns {string | null} an https URL on fonts.gstatic.com
 */
export function pickGoogleFontUrl(css) {
	if (typeof css !== 'string') return null;
	const blocks = css.split('@font-face');
	let chosen = null;
	for (const b of blocks) {
		const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/.exec(b);
		if (!m) continue;
		// the comment precedes '@font-face', so it ends the PREVIOUS block
		chosen ??= m[1];
	}
	const latin = /\/\*\s*latin\s*\*\/\s*@font-face\s*{[^}]*?url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/.exec(css);
	return latin ? latin[1] : chosen;
}

/** a file name for a font asset @param {string} family @param {string} ext */
export function fontFileName(family, ext) {
	const base = (family || 'Font').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'Font';
	return `${base}.${ext}`;
}
