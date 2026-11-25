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
 * The reader's caps on what came out (shapes and points in all). @param {{params: any, fitted?: {before: number}}[]} items
 * @returns {string | null} the refusal, or null
 */
export function svgItemsVerdict(items) {
	if (items.length > MAX_SVG_SHAPES) return `That SVG has ${items.length} shapes; the limit is ${MAX_SVG_SHAPES}`;
	let nodes = 0;
	for (const it of items) {
		// a path the importer simplified to fit counts the points the FILE had (64-int Q1)
		const before = /** @type {any} */ (it).fitted?.before;
		if (Number.isFinite(before)) nodes += before;
		else for (const sub of it.params?.paths ?? []) nodes += sub?.nodes?.length ?? 0;
	}
	if (nodes > MAX_SVG_NODES) return `That SVG has ${nodes} points; the limit is ${MAX_SVG_NODES}`;
	return null;
}

/**
 * 64-int (QUESTIONS-64-int Q1): a shape keeps at most `max` nodes — cleanVector's MAX_NODES cuts the rest
 * off, and a long closed path then ends in a straight chord across the drawing. A path over it is SIMPLIFIED
 * to fit before it is placed: the nodes whose removal changes the outline least go first (Visvalingam: the
 * triangle a node makes with its live neighbours), never an open path's two ends, never below 3 nodes on a
 * closed one. Pure and deterministic (ties go by index). The caps stay what they are: the record rides the wire.
 * @template {{params: any, name?: string}} T @param {T[]} items @param {number} max
 * @returns {{items: T[], simplified: {name: string, before: number, after: number}[]}}
 */
export function fitSvgItems(items, max) {
	/** @type {{name: string, before: number, after: number}[]} */
	const simplified = [];
	const out = items.map((it) => {
		const paths = it.params?.paths;
		if (!Array.isArray(paths)) return it;
		const sizes = paths.map((s) => (Array.isArray(s?.nodes) ? s.nodes.length : 0));
		const total = sizes.reduce((a, b) => a + b, 0);
		if (total <= max) return it;
		const budgets = paths.map((s, i) => Math.min(sizes[i], Math.max(s?.closed ? 3 : 2, Math.floor((sizes[i] * max) / total))));
		let sum = budgets.reduce((a, b) => a + b, 0);
		while (sum > max) {
			let k = 0;
			for (let i = 1; i < budgets.length; i++) if (budgets[i] > budgets[k]) k = i;
			if (budgets[k] <= 3) break;
			budgets[k]--;
			sum--;
		}
		const next = paths.map((s, i) => (sizes[i] > budgets[i] ? { ...s, nodes: thinNodes(s.nodes, budgets[i], !!s.closed) } : s));
		const after = next.reduce((n, s) => n + (Array.isArray(s?.nodes) ? s.nodes.length : 0), 0);
		simplified.push({ name: it.name ?? '', before: total, after });
		return { ...it, params: { ...it.params, paths: next } };
	});
	return { items: out, simplified };
}

/** keep `keep` of a subpath's nodes, dropping the least significant first @param {any[]} nodes @param {number} keep @param {boolean} closed */
function thinNodes(nodes, keep, closed) {
	const n = nodes.length;
	keep = Math.max(keep, closed ? 3 : 2);
	if (n <= keep) return nodes;
	const prev = new Int32Array(n);
	const next = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		prev[i] = i === 0 ? (closed ? n - 1 : -1) : i - 1;
		next[i] = i === n - 1 ? (closed ? 0 : -1) : i + 1;
	}
	const alive = new Uint8Array(n).fill(1);
	let live = n;
	const xy = (/** @type {number} */ i) => [Number(nodes[i]?.x) || 0, Number(nodes[i]?.y) || 0];
	while (live > keep) {
		/** @type {[number, number][]} */
		const scored = [];
		for (let i = 0; i < n; i++) {
			if (!alive[i] || prev[i] < 0 || next[i] < 0) continue;
			const [ax, ay] = xy(prev[i]);
			const [px, py] = xy(i);
			const [bx, by] = xy(next[i]);
			scored.push([Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)), i]);
		}
		if (!scored.length) break;
		scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		// a pass drops at most a third of what is live, never two neighbours (their areas changed)
		let quota = Math.min(live - keep, Math.max(1, Math.floor(live / 3)));
		const touched = new Uint8Array(n);
		for (const [, i] of scored) {
			if (quota <= 0) break;
			if (touched[i]) continue;
			alive[i] = 0;
			live--;
			quota--;
			const a = prev[i];
			const b = next[i];
			next[a] = b;
			prev[b] = a;
			touched[a] = touched[b] = 1;
		}
	}
	return nodes.filter((_, i) => alive[i]);
}
