// 64 D2 — TEXT ON A PATH, the pure half. A LEAF that imports nothing (the runtime, the write
// path, the Inspector and vitest all use it).
//
// A text object is a carrier mesh in objectsGroup holding its authoring record on
// `userData.textPath` (the spline / measurement precedent: the record rides toJSON and the GLTF
// extras, only the record travels, every peer rebuilds the picture from it). This module owns:
//
//   · the record: `normalizeTextPath` is THE boundary (a peer's bytes, a GLTF round trip, an undo
//     replay, an Inspector edit all pass through it), with the font list and the letter styles;
//   · the path: the object's OWN curve (line / arc / circle / wave) as a polyline in its local
//     frame, or a polyline handed over by a path SOURCE (a spline, a flow path, 64-vector's
//     shapes) — `makeSampler` turns either into arc-length lookups;
//   · the layout: troika typesets the string on a straight baseline (kerning, ligatures,
//     fallback fonts), and `layoutOnPath` turns each glyph into an affine transform that sits it
//     on the curve — position from its advance along the path, rotation from the tangent, then
//     the per-letter size / offset / rotation. The runtime feeds the twelve numbers per glyph
//     to the vertex shader, so a whole text is ONE draw call however bent it is.
//
// Per-letter styles are keyed by CHARACTER index in the text (what a person edits), and troika
// reports glyphs, not characters — `indexColorRanges` / `decodeGlyphChars` recover the map by
// asking troika to colour each character with its own index (the colours are then replaced by
// the real ones, see textPathRuntime).
//
// 65 M3 (animated kinetic text) drives the SAME per-letter fields through a local override
// layer (`mergeLetterStyles`) — it never writes the record, so an animation neither replicates
// nor lands in undo; determinism comes from the synced clock it is driven by.

export const TEXT_PATH_VERSION = 2;
/** the longest text one object holds (the record rides every save and the wire); the per-device
 * caps below are lower (64-text TX6) */
export const MAX_TEXT = 2000;
/** the most styled letters one record keeps */
export const MAX_STYLED = 500;
/** where the bundled font files live, relative to the app's base (scripts/fetch-troika-fonts.cjs) */
export const TEXT_FONTS_PATH = 'fonts/text';
/** where an extruded text's font file is looked up (TEXT_FONTS[].solid is relative to it) */
export const SOLID_FONTS_PATH = 'fonts';

/**
 * The bundled fonts (64-text TX3: sans / serif / mono / rounded / display, all OFL, fetched only
 * when a text uses them — never in the first load). 'sans' is Noto Sans through troika's own
 * resolver (every script, bold and italic) for FLAT text; extruded text needs one concrete file
 * per face (`solid`, read by opentype.js), so it carries one. A glyph a file lacks falls back to
 * the resolver in flat text, so no text ever renders as boxes; extruded text skips it.
 * WOFF, not WOFF2: troika and opentype.js cannot read WOFF2. `file` is under TEXT_FONTS_PATH, `solid`
 * under SOLID_FONTS_PATH (the sans face reuses the resolver's own Latin Noto Sans: no new bytes).
 * @type {ReadonlyArray<{id: string, label: string, kind: string, file: string | null, solid: string}>}
 */
export const TEXT_FONTS = Object.freeze([
	Object.freeze({ id: 'sans', label: 'Noto Sans', kind: 'sans', file: null, solid: 'unicode-font-resolver/font-files/latin/sans-serif.normal.400.woff' }),
	Object.freeze({ id: 'serif', label: 'Noto Serif', kind: 'serif', file: 'noto-serif-latin-400-normal.woff', solid: 'text/noto-serif-latin-400-normal.woff' }),
	Object.freeze({ id: 'plex-mono', label: 'IBM Plex Mono', kind: 'mono', file: 'ibm-plex-mono-latin-500-normal.woff', solid: 'text/ibm-plex-mono-latin-500-normal.woff' }),
	Object.freeze({ id: 'rounded', label: 'Nunito', kind: 'rounded', file: 'nunito-latin-400-normal.woff', solid: 'text/nunito-latin-400-normal.woff' }),
	Object.freeze({ id: 'pixel', label: 'Press Start 2P', kind: 'display', file: 'press-start-2p-latin-400-normal.woff', solid: 'text/press-start-2p-latin-400-normal.woff' }),
	Object.freeze({ id: 'plex-sans', label: 'IBM Plex Sans', kind: 'sans', file: 'ibm-plex-sans-latin-400-normal.woff', solid: 'text/ibm-plex-sans-latin-400-normal.woff' })
]);

/** 64-text: how the text is drawn — flat letters (troika SDF) or solid extruded ones */
export const TEXT_MODES = Object.freeze(['flat', 'extruded']);
/** 64-text: where a block of text sits around the object's origin (the 9-grid) */
export const TEXT_ANCHORS = Object.freeze([
	'top-left', 'top-center', 'top-right',
	'middle-left', 'middle-center', 'middle-right',
	'bottom-left', 'bottom-center', 'bottom-right'
]);
export const TEXT_QUALITIES = Object.freeze(['low', 'medium', 'high']);
/** curve segments per glyph curve for each quality (extruded) */
export const QUALITY_SEGMENTS = Object.freeze({ low: 3, medium: 6, high: 12 });

/**
 * 64-text TX6: characters one text object may hold, per device profile and mode. Extruded text
 * is real geometry (hundreds of triangles a letter), so its caps are lower; a phone or a
 * headset ('low') is lower still. A writer is refused past ITS device's cap (`textCapCheck`);
 * a low device showing a longer text from a desktop peer draws only its cap.
 */
export const TEXT_CAPS = Object.freeze({
	desktop: Object.freeze({ flat: 2000, extruded: 300 }),
	low: Object.freeze({ flat: 500, extruded: 80 })
});

/** @param {string} mode @param {string} profile 'desktop' | 'low' */
export function textCharCap(mode, profile) {
	const p = TEXT_CAPS[profile === 'low' ? 'low' : 'desktop'];
	return mode === 'extruded' ? p.extruded : p.flat;
}

/**
 * Would this record be refused on this device? Characters, not UTF-16 units.
 * @param {any} rec a normalized record @param {string} profile
 * @returns {{ok: true} | {ok: false, cap: number, count: number, message: string}}
 */
export function textCapCheck(rec, profile) {
	const count = Array.from(rec?.text ?? '').length;
	const mode = rec?.mode === 'extruded' ? 'extruded' : 'flat';
	const cap = textCharCap(mode, profile);
	if (count <= cap) return { ok: true };
	const where = profile === 'low' ? ' on this device' : '';
	return {
		ok: false,
		cap,
		count,
		message: `That text is too long: ${mode === 'extruded' ? 'solid (extruded)' : 'flat'} text holds up to ${cap} characters${where} (this has ${count}). Split it into more than one text, or make it flat.`
	};
}

/** @type {ReadonlyArray<string>} */
export const PATH_KINDS = Object.freeze(['none', 'line', 'arc', 'circle', 'wave', 'object']);
export const ALIGNS = Object.freeze(['start', 'center', 'end', 'fit']);
export const ORIENTS = Object.freeze(['auto', 'flat', 'upright']);

/** @typedef {{color?: string, size?: number, dx?: number, dy?: number, rot?: number}} LetterStyle */
/** @typedef {{kind: string, length: number, radius: number, sweep: number, amplitude: number, wavelength: number, target: string | null}} TextPathCurve */
/** @typedef {{size: number, thickness: number, segments: number}} TextBevel */
/** @typedef {{v: number, text: string, font: string, fontAsset: string | null, fontName: string, bold: boolean, italic: boolean,
 *   size: number, color: string, spacing: number, lineHeight: number, outline: number, outlineColor: string,
 *   path: TextPathCurve, offset: number, align: string, side: string, orient: string, shift: number,
 *   letters: Record<string, LetterStyle>, mode: string, maxWidth: number, anchor: string, depth: number,
 *   bevel: TextBevel, quality: string, fontMeta: {licence: string, url: string, noEmbed: boolean} | null, sideColor: string | null, emissive: number, metalness: number,
 *   roughness: number}} TextPathRecord */

export const TEXT_PATH_DEFAULTS = Object.freeze({
	v: TEXT_PATH_VERSION,
	text: 'Text on a path',
	font: 'sans',
	bold: false,
	italic: false,
	size: 0.4, // m (the em)
	color: '#ffffff',
	spacing: 0, // em, extra space after every letter
	lineHeight: 1.2, // em
	outline: 0, // em
	outlineColor: '#000000',
	// 64-text: 'none' = a plain block of text (wraps at maxWidth, sits on its anchor); the curves
	// are text on a path (Add ▸ Text ▸ Text on a path sets 'arc')
	path: Object.freeze({ kind: 'none', length: 4, radius: 2, sweep: 180, amplitude: 0.3, wavelength: 2, target: null }),
	offset: 0, // fraction of the path length, -1..1, added to the alignment's start
	align: 'center',
	side: 'left', // SVG 2 `side`: 'right' runs the path backwards, putting the text on its other side
	orient: 'auto',
	shift: 0, // m, baseline distance from the path (positive = away from it, on the letters' up side)
	letters: Object.freeze({}),
	// ---- 64-text: the ONE text object ----
	mode: 'flat',
	fontAsset: null, // a Library font's content hash (user upload / Google Fonts); wins over `font`
	fontName: '', // its family name, for the missing-font notice and the Inspector
	fontMeta: null, // {licence, url, noEmbed} of a Library font (TX3b)
	maxWidth: 0, // m; 0 = no wrapping (block text only)
	anchor: 'middle-center',
	depth: 0.1, // m (extruded)
	bevel: Object.freeze({ size: 0.006, thickness: 0.01, segments: 2 }), // m; size 0 = no bevel
	quality: 'medium',
	sideColor: null, // extruded sides; null = the face colour, a shade darker
	emissive: 0, // glow, 0..4 (extruded: the face colour lights itself)
	metalness: 0,
	roughness: 0.5
});

/** @param {any} raw @returns {TextBevel} */
export function normalizeBevel(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = TEXT_PATH_DEFAULTS.bevel;
	return {
		size: clampNum(r.size, d.size, 0, 1),
		thickness: clampNum(r.thickness, d.thickness, 0, 1),
		segments: Math.round(clampNum(r.segments, d.segments, 1, 8))
	};
}

const HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * TX3b: what a Library font said about its licence when it was picked (its `name` table and
 * OS/2 fsType, read once at import) — rides the record so every peer's Inspector and the export
 * warning know it without parsing the font.
 * @param {any} raw @returns {{licence: string, url: string, noEmbed: boolean} | null}
 */
export function normalizeFontMeta(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const licence = typeof raw.licence === 'string' ? raw.licence.replace(/[\u0000-\u001f]/g, '').slice(0, 64) : '';
	const url = typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url.slice(0, 300) : '';
	return { licence, url, noEmbed: !!raw.noEmbed };
}

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const clampNum = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const HEX = /^#[0-9a-f]{6}$/i;
/** @param {any} v @param {string} d */
const colorOr = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
/** @param {any} v @param {ReadonlyArray<string>} list @param {string} d */
const oneOf = (v, list, d) => (typeof v === 'string' && list.includes(v) ? v : d);

/** @param {string} id */
export function fontById(id) {
	return TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0];
}

/**
 * One letter's style, keeping only fields that differ from "no change" (so an untouched letter is
 * absent from the record and an old scene serialises byte-identically).
 * @param {any} raw @returns {LetterStyle | null}
 */
export function normalizeLetterStyle(raw) {
	if (!raw || typeof raw !== 'object') return null;
	/** @type {LetterStyle} */
	const out = {};
	if (typeof raw.color === 'string' && HEX.test(raw.color)) out.color = raw.color.toLowerCase();
	const size = clampNum(raw.size, 1, 0.1, 10);
	if (size !== 1) out.size = size;
	const dx = clampNum(raw.dx, 0, -20, 20);
	if (dx !== 0) out.dx = dx;
	const dy = clampNum(raw.dy, 0, -20, 20);
	if (dy !== 0) out.dy = dy;
	const rot = clampNum(raw.rot, 0, -360, 360);
	if (rot !== 0) out.rot = rot;
	return Object.keys(out).length ? out : null;
}

/** @param {any} raw @param {number} length @returns {Record<string, LetterStyle>} */
function normalizeLetters(raw, length) {
	/** @type {Record<string, LetterStyle>} */
	const out = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	const keys = Object.keys(raw)
		.filter((k) => /^\d+$/.test(k) && Number(k) < length)
		.sort((a, b) => Number(a) - Number(b))
		.slice(0, MAX_STYLED);
	for (const k of keys) {
		const style = normalizeLetterStyle(raw[k]);
		if (style) out[String(Number(k))] = style;
	}
	return out;
}

/** @param {any} raw @returns {TextPathCurve} */
export function normalizeCurve(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = TEXT_PATH_DEFAULTS.path;
	return {
		kind: oneOf(r.kind, PATH_KINDS, d.kind),
		length: clampNum(r.length, d.length, 0.05, 200),
		radius: clampNum(r.radius, d.radius, 0.05, 100),
		sweep: clampNum(r.sweep, d.sweep, 5, 360),
		amplitude: clampNum(r.amplitude, d.amplitude, 0, 50),
		wavelength: clampNum(r.wavelength, d.wavelength, 0.05, 100),
		target: typeof r.target === 'string' && r.target.length <= 64 ? r.target : null
	};
}

/**
 * THE boundary for `userData.textPath`. Anything that claims to be a record comes out canonical.
 * @param {any} raw @returns {TextPathRecord}
 */
export function normalizeTextPath(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = TEXT_PATH_DEFAULTS;
	const text = typeof r.text === 'string' ? Array.from(r.text).slice(0, MAX_TEXT).join('') : d.text;
	const path = normalizeCurve(r.path);
	// a link with no target is no link
	if (path.kind === 'object' && !path.target) path.kind = 'line';
	// a v1 record (64 D2, never released) had no 'none' and always a curve: keep it on its curve
	let mode = oneOf(r.mode, TEXT_MODES, d.mode);
	// extruded text on a path is out of scope: such a record stays flat (setTextPathFor refuses
	// the switch with a message, this is the boundary's rule for anything else)
	if (path.kind !== 'none') mode = 'flat';
	const fontAsset = typeof r.fontAsset === 'string' && HASH_RE.test(r.fontAsset) ? r.fontAsset : null;
	return {
		v: TEXT_PATH_VERSION,
		text,
		font: fontById(r.font).id,
		bold: !!r.bold,
		italic: !!r.italic,
		size: clampNum(r.size, d.size, 0.01, 50),
		color: colorOr(r.color, d.color),
		spacing: clampNum(r.spacing, d.spacing, -0.5, 5),
		lineHeight: clampNum(r.lineHeight, d.lineHeight, 0.5, 5),
		outline: clampNum(r.outline, d.outline, 0, 0.3),
		outlineColor: colorOr(r.outlineColor, d.outlineColor),
		path,
		offset: clampNum(r.offset, d.offset, -1, 1),
		align: oneOf(r.align, ALIGNS, d.align),
		side: r.side === 'right' ? 'right' : 'left',
		orient: oneOf(r.orient, ORIENTS, d.orient),
		shift: clampNum(r.shift, d.shift, -50, 50),
		letters: normalizeLetters(r.letters, text.length),
		mode,
		fontAsset,
		fontName: fontAsset && typeof r.fontName === 'string' ? r.fontName.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '',
		fontMeta: fontAsset ? normalizeFontMeta(r.fontMeta) : null,
		maxWidth: clampNum(r.maxWidth, d.maxWidth, 0, 500),
		anchor: oneOf(r.anchor, TEXT_ANCHORS, d.anchor),
		depth: clampNum(r.depth, d.depth, 0.001, 50),
		bevel: normalizeBevel(r.bevel),
		quality: oneOf(r.quality, TEXT_QUALITIES, d.quality),
		sideColor: typeof r.sideColor === 'string' && HEX.test(r.sideColor) ? r.sideColor.toLowerCase() : null,
		emissive: clampNum(r.emissive, d.emissive, 0, 4),
		metalness: clampNum(r.metalness, d.metalness, 0, 1),
		roughness: clampNum(r.roughness, d.roughness, 0, 1)
	};
}

/** a block text (no path) rather than text on a path @param {any} rec */
export const isBlockText = (rec) => rec?.path?.kind === 'none';

/** @param {any} o */
export function isTextPathObject(o) {
	return !!o?.userData?.textPath && typeof o.userData.textPath === 'object';
}

/** A deep copy safe to keep in an undo entry. @param {any} record @returns {TextPathRecord} */
export function cloneTextPath(record) {
	return JSON.parse(JSON.stringify(normalizeTextPath(record)));
}

/**
 * Keep the letter styles on the same LETTERS when the text is edited: the common prefix keeps its
 * indices, the common suffix shifts with the length change, an edited middle loses its styles.
 * @param {string} before @param {string} after @param {Record<string, LetterStyle>} letters
 * @returns {Record<string, LetterStyle>}
 */
export function remapLetters(before, after, letters) {
	/** @type {Record<string, LetterStyle>} */
	const out = {};
	if (!letters || before === after) return { ...letters };
	const a = before.length;
	const b = after.length;
	let pre = 0;
	while (pre < a && pre < b && before[pre] === after[pre]) pre++;
	let suf = 0;
	while (suf < a - pre && suf < b - pre && before[a - 1 - suf] === after[b - 1 - suf]) suf++;
	for (const k of Object.keys(letters)) {
		const i = Number(k);
		if (i < pre) out[String(i)] = letters[k];
		else if (i >= a - suf) out[String(i - a + b)] = letters[k];
	}
	return out;
}

// ---- the curve -------------------------------------------------------------------------------

/** @typedef {{points: number[][], closed: boolean, normal: number[], orient?: string}} Polyline */

/**
 * The object's OWN curve, in its local frame (the XY plane, facing +Z like any label). Arcs and
 * circles are centred on the origin and read clockwise over the top, so a centred text sits on
 * the crown — the badge layout; a line and a wave are centred on the origin too.
 * @param {TextPathCurve} curve @returns {Polyline}
 */
export function builtinPolyline(curve) {
	const c = normalizeCurve(curve);
	const normal = [0, 0, 1];
	if (c.kind === 'line' || c.kind === 'object' || c.kind === 'none') {
		return { points: [[-c.length / 2, 0, 0], [c.length / 2, 0, 0]], closed: false, normal };
	}
	if (c.kind === 'wave') {
		const n = Math.min(2000, Math.max(16, Math.ceil((c.length / c.wavelength) * 24)));
		/** @type {number[][]} */
		const points = [];
		for (let i = 0; i <= n; i++) {
			const x = -c.length / 2 + (c.length * i) / n;
			points.push([x, c.amplitude * Math.sin((2 * Math.PI * (x + c.length / 2)) / c.wavelength), 0]);
		}
		return { points, closed: false, normal };
	}
	const full = c.kind === 'circle' || c.sweep >= 360;
	const sweep = full ? 360 : c.sweep;
	const start = 90 + sweep / 2; // degrees; decreasing = clockwise seen from +Z
	const n = Math.max(8, Math.ceil(sweep / 3));
	/** @type {number[][]} */
	const points = [];
	for (let i = 0; i < (full ? n : n + 1); i++) {
		const a = ((start - (sweep * i) / n) * Math.PI) / 180;
		points.push([c.radius * Math.cos(a), c.radius * Math.sin(a), 0]);
	}
	return { points, closed: full, normal };
}

/** @param {number[]} a @param {number[]} b */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a */
const len = (a) => Math.hypot(a[0], a[1], a[2]);
/** @param {number[]} a @param {number[]=} fallback */
const unit = (a, fallback = [1, 0, 0]) => {
	const l = len(a);
	return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : fallback.slice();
};
/** @param {number[]} a @param {number[]} b */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a @param {number[]} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Arc-length lookups over a polyline. Tangents are blended between the vertices' (each vertex
 * averages its two segments), so letters turn smoothly along a sampled curve instead of
 * snapping at every segment.
 * @param {Polyline} line @param {boolean=} reverse SVG 2 side="right": walk the path backwards
 */
export function makeSampler(line, reverse = false) {
	let pts = (line?.points ?? []).filter((p) => Array.isArray(p) && p.length >= 3 && p.every((v) => Number.isFinite(v)));
	// drop zero-length segments (a duplicate point has no tangent)
	pts = pts.filter((p, i) => i === 0 || len(sub(p, pts[i - 1])) > 1e-9);
	if (reverse) pts = pts.slice().reverse();
	const closed = !!line?.closed && pts.length > 2;
	if (pts.length < 2) pts = [[0, 0, 0], [1e-6, 0, 0]];
	const ring = closed ? [...pts, pts[0]] : pts;
	const cum = [0];
	for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + len(sub(ring[i], ring[i - 1])));
	const total = cum[cum.length - 1];
	const segDir = ring.slice(1).map((p, i) => unit(sub(p, ring[i])));
	const segs = segDir.length;
	const vertTan = ring.map((_, i) => {
		const prev = i > 0 ? segDir[i - 1] : closed ? segDir[segs - 1] : null;
		const next = i < segs ? segDir[i] : closed ? segDir[0] : null;
		if (prev && next) return unit([prev[0] + next[0], prev[1] + next[1], prev[2] + next[2]], next);
		return (next ?? prev ?? [1, 0, 0]).slice();
	});
	/** the segment holding arc length s and the fraction along it @param {number} s */
	const locate = (s) => {
		let lo = 0;
		let hi = segs - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (cum[mid] <= s) lo = mid;
			else hi = mid - 1;
		}
		const l = cum[lo + 1] - cum[lo];
		return { i: lo, f: l > 0 ? Math.min(1, Math.max(0, (s - cum[lo]) / l)) : 0 };
	};
	return {
		total,
		closed,
		/** @param {number} s */
		pointAt(s) {
			const { i, f } = locate(s);
			const a = ring[i];
			const b = ring[i + 1];
			return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
		},
		/** @param {number} s */
		tangentAt(s) {
			const { i, f } = locate(s);
			const a = vertTan[i];
			const b = vertTan[i + 1];
			return unit([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], segDir[i]);
		}
	};
}

/**
 * The letter frame at a point: x = along the path, y = the letters' up, z = their facing.
 * 'flat' lays the text in the curve's plane (normal N); 'upright' stands it along N.
 * @param {number[]} t unit tangent @param {number[]} n plane normal @param {string} orient 'flat'|'upright'
 * @returns {number[][]} [x, y, z]
 */
export function letterFrame(t, n, orient) {
	let y;
	if (orient === 'upright') y = unit(sub(n, [t[0] * dot(n, t), t[1] * dot(n, t), t[2] * dot(n, t)]), [0, 1, 0]);
	else y = unit(cross(n, t), [0, 1, 0]);
	// a tangent running along N has no defined up: borrow any perpendicular
	if (Math.abs(dot(y, t)) > 0.999) y = unit(cross(t, Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
	const z = unit(cross(t, y), n);
	return [t, y, z];
}

// ---- glyph <-> character ---------------------------------------------------------------------

/** troika colour ranges that paint every character with its own index @param {number} n */
export function indexColorRanges(n) {
	/** @type {Record<number, number>} */
	const ranges = {};
	for (let i = 0; i < n; i++) ranges[i] = i;
	return ranges;
}

/** glyph -> character index from the colours `indexColorRanges` produced @param {ArrayLike<number> | null | undefined} glyphColors */
export function decodeGlyphChars(glyphColors) {
	const n = glyphColors ? Math.floor(glyphColors.length / 3) : 0;
	const out = new Int32Array(n);
	for (let g = 0; g < n; g++) out[g] = ((glyphColors?.[g * 3] ?? 0) << 16) | ((glyphColors?.[g * 3 + 1] ?? 0) << 8) | (glyphColors?.[g * 3 + 2] ?? 0);
	return out;
}

// ---- per-letter styles -----------------------------------------------------------------------

/**
 * The effective style of every character: the record's letters, then a LOCAL override layer on
 * top (65 M3's animation): dx / dy / rot ADD, size MULTIPLIES, color replaces, opacity multiplies.
 * @param {number} count characters
 * @param {Record<string, LetterStyle>} letters the record's styles
 * @param {ArrayLike<any> | null=} overrides per character index, partial {dx, dy, rot, size, color, opacity}
 * @returns {{color: string | null, size: number, dx: number, dy: number, rot: number, opacity: number}[]}
 */
export function mergeLetterStyles(count, letters, overrides = null) {
	const out = [];
	for (let i = 0; i < count; i++) {
		const s = letters?.[String(i)] ?? {};
		const o = overrides?.[i] ?? null;
		out.push({
			color: (o && typeof o.color === 'string' && HEX.test(o.color) ? o.color : s.color) ?? null,
			size: (s.size ?? 1) * (o ? clampNum(o.size, 1, 0, 100) : 1),
			dx: (s.dx ?? 0) + (o ? clampNum(o.dx, 0, -1e3, 1e3) : 0),
			dy: (s.dy ?? 0) + (o ? clampNum(o.dy, 0, -1e3, 1e3) : 0),
			rot: (s.rot ?? 0) + (o ? clampNum(o.rot, 0, -1e5, 1e5) : 0),
			opacity: o ? clampNum(o.opacity, 1, 0, 1) : 1
		});
	}
	return out;
}

// ---- the layout ------------------------------------------------------------------------------

/** troika 0.52's caretPositions per character: startX, endX, bottomY, topY (its JSDoc says three) */
export const CARET_STRIDE = 4;

/**
 * Sit every glyph on the path.
 *
 * Inputs are troika's straight layout (caretPositions CARET_STRIDE per character; anchorX 0, anchorY 'top-baseline', textAlign 'left': the
 * first line's baseline is y = 0, line k's is -k·lineHeight, x runs from 0) and the per-character
 * styles. Each character is pivoted at its own advance's centre on its baseline, scaled, rotated
 * and nudged there, then the whole letter is carried to the path point its (scaled-advance)
 * position reaches and turned to the tangent. Later lines run parallel to the path, below it.
 *
 * @param {{glyphBounds: ArrayLike<number>, glyphChars: ArrayLike<number>, caretPositions: ArrayLike<number>,
 *   lineHeight: number, fontSize: number}} info troika's layout
 * @param {ReturnType<typeof mergeLetterStyles>} styles per character
 * @param {ReturnType<typeof makeSampler>} sampler the path, in the visual's frame
 * @param {{normal: number[], orient: string, align: string, offset: number, shift: number}} params
 * @returns {{rows: Float32Array, hidden: Uint8Array, colors: Uint8Array | null}} 12 floats per glyph (three
 *   affine rows: out_i = row_i · (x, y, z, 1)); `hidden` marks glyphs that ran off an open path
 */
export function layoutOnPath(info, styles, sampler, params) {
	const glyphCount = Math.floor((info.glyphBounds?.length ?? 0) / 4);
	const rows = new Float32Array(glyphCount * 12);
	const hidden = new Uint8Array(glyphCount);
	const caret = info.caretPositions ?? [];
	const charCount = Math.floor(caret.length / CARET_STRIDE);
	const lh = info.lineHeight || info.fontSize || 1;
	const em = info.fontSize || 1;
	const L = sampler.total;

	// per character: its line, its advance, its centre along the path (before alignment)
	const line = new Int32Array(charCount);
	const centre = new Float64Array(charCount);
	const advance = new Float64Array(charCount);
	const pivotX = new Float64Array(charCount);
	/** @type {{first: number, start: number, width: number, chars: number[]}[]} */
	const lines = [];
	const bottom0 = charCount ? caret[2] : 0;
	for (let c = 0; c < charCount; c++) {
		const k = Math.max(0, Math.round((bottom0 - caret[c * CARET_STRIDE + 2]) / lh));
		line[c] = k;
		while (lines.length <= k) lines.push({ first: -1, start: 0, width: 0, chars: [] });
		const entry = lines[k];
		const x0 = Math.min(caret[c * CARET_STRIDE], caret[c * CARET_STRIDE + 1]);
		const a = Math.abs(caret[c * CARET_STRIDE + 1] - caret[c * CARET_STRIDE]);
		advance[c] = a;
		pivotX[c] = x0 + a / 2;
		if (entry.first < 0) {
			entry.first = c;
			entry.start = x0;
		}
		entry.chars.push(c);
	}
	for (const entry of lines) {
		let extra = 0;
		let end = entry.start;
		for (const c of entry.chars) {
			const s = styles[c]?.size ?? 1;
			const x0 = pivotX[c] - advance[c] / 2;
			centre[c] = x0 - entry.start + extra + (s * advance[c]) / 2;
			extra += (s - 1) * advance[c];
			end = Math.max(end, x0 + advance[c]);
		}
		entry.width = end - entry.start + extra;
	}

	// where each line begins along the path
	const offset = params.offset * L;
	const base = lines.map((entry) => {
		if (params.align === 'center') return (L - entry.width) / 2 + offset;
		if (params.align === 'end') return L - entry.width + offset;
		return offset;
	});
	// 'fit' spreads the slack between the letters (a closed path also closes the last gap)
	const gap = lines.map((entry) => {
		if (params.align !== 'fit' || !entry.chars.length) return 0;
		const slots = sampler.closed ? entry.chars.length : entry.chars.length - 1;
		return slots > 0 ? (L - entry.width) / slots : 0;
	});
	const order = new Int32Array(charCount);
	for (const entry of lines) entry.chars.forEach((c, i) => (order[c] = i));

	const normal = unit(params.normal ?? [0, 0, 1], [0, 0, 1]);
	const orient = params.orient === 'upright' ? 'upright' : 'flat';
	const glyphChars = info.glyphChars;
	for (let g = 0; g < glyphCount; g++) {
		const c = Math.min(Math.max(0, glyphChars?.[g] ?? 0), Math.max(0, charCount - 1));
		const st = styles[c] ?? { size: 1, dx: 0, dy: 0, rot: 0 };
		const k = charCount ? line[c] : 0;
		let d = base[k] ?? 0;
		d += (charCount ? centre[c] : 0) + gap[k] * (charCount ? order[c] : 0);
		if (sampler.closed && L > 0) d = ((d % L) + L) % L;
		const o = g * 12;
		if (!sampler.closed && (d < -1e-6 || d > L + 1e-6)) {
			hidden[g] = 1; // off the end of an open path (SVG's rule): a zero transform collapses it
			continue;
		}
		const p = sampler.pointAt(d);
		const [X, Y, Z] = letterFrame(sampler.tangentAt(d), normal, orient);
		const s = st.size;
		const r = (st.rot * Math.PI) / 180;
		const cs = Math.cos(r) * s;
		const sn = Math.sin(r) * s;
		// local letter frame: v' = R·s·(v - pivot) + nudge, pivot = (advance centre, line k's baseline)
		const px = charCount ? pivotX[c] : 0;
		const py = -k * lh;
		const nx = st.dx * em;
		const ny = st.dy * em + py + params.shift;
		// columns of the local 2x2 (x', y') in terms of (x, y): x' = cs·x - sn·y, y' = sn·x + cs·y
		const tx = -(cs * px - sn * py) + nx;
		const ty = -(sn * px + cs * py) + ny;
		for (let i = 0; i < 3; i++) {
			rows[o + i * 4] = X[i] * cs + Y[i] * sn;
			rows[o + i * 4 + 1] = -X[i] * sn + Y[i] * cs;
			rows[o + i * 4 + 2] = Z[i] * s;
			rows[o + i * 4 + 3] = p[i] + X[i] * tx + Y[i] * ty;
		}
	}
	return { rows, hidden, colors: null };
}

/**
 * Per-glyph colours (r, g, b bytes) for troika's glyph-colour attribute.
 * @param {ArrayLike<number>} glyphChars @param {ReturnType<typeof mergeLetterStyles>} styles @param {string} base
 */
export function glyphColors(glyphChars, styles, base) {
	const n = glyphChars?.length ?? 0;
	const out = new Uint8Array(n * 3);
	const fallback = parseInt(colorOr(base, '#ffffff').slice(1), 16);
	for (let g = 0; g < n; g++) {
		const c = styles[glyphChars[g]]?.color;
		const v = c ? parseInt(c.slice(1), 16) : fallback;
		out[g * 3] = (v >> 16) & 255;
		out[g * 3 + 1] = (v >> 8) & 255;
		out[g * 3 + 2] = v & 255;
	}
	return out;
}

/**
 * The hit proxy: each visible glyph's quad, transformed onto the path (what a click and the
 * selection outline see). Indexed, two triangles per glyph.
 * @param {ArrayLike<number>} glyphBounds @param {Float32Array} rows @param {Uint8Array} hidden
 * @returns {{positions: Float32Array, index: Uint32Array}}
 */
export function glyphQuads(glyphBounds, rows, hidden) {
	const n = Math.floor((glyphBounds?.length ?? 0) / 4);
	let visible = 0;
	for (let g = 0; g < n; g++) if (!hidden[g]) visible++;
	const positions = new Float32Array(visible * 12);
	const index = new Uint32Array(visible * 6);
	let q = 0;
	for (let g = 0; g < n; g++) {
		if (hidden[g]) continue;
		const [x0, y0, x1, y1] = [glyphBounds[g * 4], glyphBounds[g * 4 + 1], glyphBounds[g * 4 + 2], glyphBounds[g * 4 + 3]];
		const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
		const o = g * 12;
		corners.forEach(([x, y], v) => {
			for (let i = 0; i < 3; i++)
				positions[q * 12 + v * 3 + i] = rows[o + i * 4] * x + rows[o + i * 4 + 1] * y + rows[o + i * 4 + 3];
		});
		index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
		q++;
	}
	return { positions, index };
}
