// 64-vector: an imported SVG is UNTRUSTED. This leaf (imports NOTHING) decides, on the TEXT, before
// any parser sees it, whether it may be read — and hands the reader a copy with everything that could
// run or fetch taken out. The parse after it (DOMParser inside three's SVGLoader) is already inert
// (no browsing context: no script runs, no subresource loads); this gate is the second wall, and the
// one a unit test can hold to account:
//   - REFUSED (a plain sentence): larger than MAX_SVG_BYTES; an XML entity declaration (`<!ENTITY`,
//     the billion-laughs shape); more than MAX_SVG_ELEMENTS drawable elements; anything banned that
//     survives the strip below (a malformed or nested trick).
//   - STRIPPED: <script>, <foreignObject>, and every element that embeds or fetches (image, iframe,
//     object, embed, audio, video, animation that can retarget hrefs); `on*=` handlers; any href /
//     xlink:href that is not a same-document `#id`; `url(...)` that is not `url(#id)`; CSS @import;
//     xml-stylesheet processing instructions.
// The record cap is the reader's: cleanVector keeps MAX_NODES per shape, and placeSvg refuses more
// than MAX_SVG_SHAPES shapes or MAX_SVG_NODES points in all.

export const MAX_SVG_BYTES = 2 * 1024 * 1024;
export const MAX_SVG_ELEMENTS = 5000;
export const MAX_SVG_SHAPES = 500;
export const MAX_SVG_NODES = 40000;

/** elements removed with everything inside them (an optional namespace prefix, any case) */
const STRIP_ELEMENTS = ['script', 'foreignObject', 'image', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'set', 'animateMotion', 'animateTransform', 'handler', 'listener'];
/** after the strip, any of these left means the text is not what it looks like: refuse */
const BANNED = /<\s*(?:[\w.-]+:)?(?:script|foreignobject|iframe|object|embed|image|handler|listener)\b/i;
const DRAWABLE = /<\s*(?:[\w.-]+:)?(?:path|rect|circle|ellipse|line|polyline|polygon|use|text|g)\b/gi;

/** @param {string} name */
const tag = (name) => `(?:[\\w.-]+:)?${name}`;

/**
 * @param {unknown} text
 * @returns {{ok: true, text: string, stripped: string[]} | {ok: false, reason: string}}
 */
export function checkSvgText(text) {
	if (typeof text !== 'string') return { ok: false, reason: 'That file is not text, so it is not an SVG' };
	// bytes, not characters: a multi-byte file is measured as what it weighs
	const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
	if (bytes > MAX_SVG_BYTES) return { ok: false, reason: `That SVG is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_SVG_BYTES / 1048576} MB` };
	if (/<!ENTITY/i.test(text)) return { ok: false, reason: 'That SVG declares XML entities, which are not read' };
	if (!/<\s*(?:[\w.-]+:)?svg\b/i.test(text)) return { ok: false, reason: 'No <svg> element in that file' };
	/** @type {string[]} */
	const stripped = [];
	let out = text;
	/** @param {RegExp} re @param {string} what @param {string} [by] */
	const strip = (re, what, by = '') => {
		const next = out.replace(re, by);
		if (next !== out) stripped.push(what);
		out = next;
	};
	// a DOCTYPE without entities is harmless, but nothing here needs it
	strip(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, 'doctype');
	strip(/<\?xml-stylesheet[\s\S]*?\?>/gi, 'stylesheet');
	for (const name of STRIP_ELEMENTS) {
		strip(new RegExp(`<\\s*${tag(name)}\\b[^>]*\\/\\s*>`, 'gi'), name);
		strip(new RegExp(`<\\s*${tag(name)}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag(name)}\\s*>`, 'gi'), name);
	}
	// event handlers, quoted or not
	strip(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, 'handler');
	// an href that leaves the document (anything but #id) is dropped; #id stays (SVGLoader's <use>)
	strip(/\s+(?:[\w.-]+:)?href\s*=\s*(?:"(?!\s*#)[^"]*"|'(?!\s*#)[^']*'|(?![#"'])[^\s>]+)/gi, 'external link');
	// url(...) that is not url(#id): a fill / filter / mask pointing off the document
	strip(/url\(\s*(?!['"]?\s*#)[^)]*\)/gi, 'external url', 'none');
	strip(/@import[^;]*;?/gi, 'css import');
	if (BANNED.test(out)) return { ok: false, reason: 'That SVG has scripted or embedded content that could not be taken out, so it was not imported' };
	const elements = out.match(DRAWABLE)?.length ?? 0;
	if (elements > MAX_SVG_ELEMENTS) return { ok: false, reason: `That SVG has ${elements} elements; the limit is ${MAX_SVG_ELEMENTS}` };
	return { ok: true, text: out, stripped: [...new Set(stripped)] };
}

/**
 * The reader's caps on what came out (shapes and points in all). @param {{params: any}[]} items
 * @returns {string | null} the refusal, or null
 */
export function svgItemsVerdict(items) {
	if (items.length > MAX_SVG_SHAPES) return `That SVG has ${items.length} shapes; the limit is ${MAX_SVG_SHAPES}`;
	let nodes = 0;
	for (const it of items) for (const sub of it.params?.paths ?? []) nodes += sub?.nodes?.length ?? 0;
	if (nodes > MAX_SVG_NODES) return `That SVG has ${nodes} points; the limit is ${MAX_SVG_NODES}`;
	return null;
}
