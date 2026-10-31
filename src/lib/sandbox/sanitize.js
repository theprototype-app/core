// 69 T1 — THE ALLOWLIST that guest-made markup passes through before it becomes app DOM. Used by
// the HUD custom element (a serialised tree from the guest's DOM proxy, sandbox/hud.js) and by
// any HTML string the app did not write itself (`sanitizeHtmlInto`, parsed by an inert DOMParser
// document — nothing in it loads or runs).
//
// What gets through: layout and text elements, inline SVG shapes, a <canvas> drawn from recorded
// calls, and `data:image` pictures. What never does: scripts, styles sheets, frames, forms and
// inputs, links, event handlers, element ids (they would collide with the app's), any URL except
// a `data:image` src, and any CSS that can fetch (`url(`, `image-set(`, `@import`, escapes) or
// escape its box (`position: fixed` becomes `absolute`; the host clips the slot). No network
// request can come out of a sanitised tree.

const HTML_TAGS = new Set([
	'div', 'span', 'p', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sub', 'sup', 'mark', 'code', 'pre', 'kbd',
	'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption',
	'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'section', 'article', 'header', 'footer',
	'progress', 'meter', 'img', 'canvas', 'label', 'abbr', 'time', 'center'
]);
const SVG_TAGS = new Set([
	'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text', 'tspan', 'title', 'defs',
	'lineargradient', 'radialgradient', 'stop'
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ATTRS = new Set([
	'class', 'style', 'title', 'role', 'width', 'height', 'colspan', 'rowspan', 'dir', 'lang', 'value', 'max', 'min',
	'low', 'high', 'optimum', 'alt', 'src', 'datetime',
	// svg presentation + geometry
	'viewbox', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'points', 'fill', 'stroke',
	'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
	'fill-opacity', 'fill-rule', 'opacity', 'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-family',
	'font-weight', 'preserveaspectratio', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
	'pathlength', 'vector-effect'
]);
/** camelCase SVG attribute names, as setAttribute needs them */
const SVG_CASE = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', pathlength: 'pathLength' };
const BAD_VALUE = /url\s*\(|image-set|expression\s*\(|javascript:|vbscript:|@import|\\|<|-moz-binding|behavior\s*:/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const CSS_PROP = /^-?[a-z][a-z-]*$/;
const BLOCKED_CSS = new Set(['behavior', '-moz-binding', 'content']);

/** the most nodes one tree may build (a runaway render is cut, not the tab) */
export const MAX_NODES = 4000;
const MAX_TEXT = 20000;
const MAX_CANVAS_CMDS = 50000;
const MAX_CANVAS_SIDE = 4096;

/** @param {string} css @returns {string} a declaration list that cannot fetch or escape its box */
export function sanitizeCss(css) {
	const out = [];
	for (const decl of String(css ?? '').split(';')) {
		const at = decl.indexOf(':');
		if (at < 0) continue;
		const prop = decl.slice(0, at).trim().toLowerCase();
		let value = decl.slice(at + 1).trim();
		if (!CSS_PROP.test(prop) || BLOCKED_CSS.has(prop) || !value || value.length > 500 || BAD_VALUE.test(value)) continue;
		if (prop === 'position' && /fixed|sticky/i.test(value)) value = 'absolute';
		out.push(prop + ': ' + value);
	}
	return out.join('; ');
}

/** @param {string} tag @param {string} name @param {string} value */
function attrAllowed(tag, name, value) {
	if (name.startsWith('on')) return false;
	if (name === 'src') return tag === 'img' && DATA_IMAGE.test(value);
	if (name.startsWith('aria-') || name.startsWith('data-')) return /^[a-z0-9-]+$/.test(name) && !BAD_VALUE.test(value);
	if (!ATTRS.has(name)) return false;
	return !BAD_VALUE.test(value);
}

/** @param {Element} el @param {string} name @param {string} value */
function setAttr(el, name, value) {
	const v = String(value).slice(0, MAX_TEXT);
	if (name === 'style') {
		const css = sanitizeCss(v);
		if (css) el.setAttribute('style', css);
		return;
	}
	el.setAttribute(el.namespaceURI === SVG_NS ? (/** @type {any} */ (SVG_CASE))[name] ?? name : name, v);
}

const CANVAS_METHODS = new Set([
	'fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect',
	'roundRect', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'fillText', 'strokeText', 'save', 'restore',
	'translate', 'rotate', 'scale', 'setTransform', 'resetTransform', 'setLineDash', 'clip'
]);
const CANVAS_PROPS = new Set([
	'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'font', 'textAlign', 'textBaseline',
	'globalAlpha', 'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
	'lineDashOffset', 'direction', 'imageSmoothingEnabled'
]);
/** a recorded call's argument: numbers, short strings, booleans, arrays of numbers @param {any} a */
const argOk = (a) =>
	(typeof a === 'number' && Number.isFinite(a)) ||
	typeof a === 'boolean' ||
	(typeof a === 'string' && a.length <= 2000) ||
	(Array.isArray(a) && a.length <= 64 && a.every((x) => typeof x === 'number' && Number.isFinite(x)));

/** replay recorded 2D calls onto a real canvas @param {HTMLCanvasElement} canvas @param {any[]} cmds */
function replayCanvas(canvas, cmds) {
	const ctx = canvas.getContext('2d');
	if (!ctx || !Array.isArray(cmds)) return;
	for (const cmd of cmds.slice(0, MAX_CANVAS_CMDS)) {
		if (!Array.isArray(cmd)) continue;
		try {
			if (cmd[0] === '=') {
				if (CANVAS_PROPS.has(cmd[1]) && argOk(cmd[2]) && !Array.isArray(cmd[2])) /** @type {any} */ (ctx)[cmd[1]] = cmd[2];
			} else if (CANVAS_METHODS.has(cmd[0]) && Array.isArray(cmd[1]) && cmd[1].length <= 8 && cmd[1].every(argOk)) {
				/** @type {any} */ (ctx)[cmd[0]](...cmd[1]);
			}
		} catch {
			// a bad argument to one call is that call's problem
		}
	}
}

/** `{links: true}` lets `<a href="https://…">` through (opened in a new tab, no opener) — for
 * attribution notices; never for guest content @typedef {{links?: boolean}} SanitizeOptions */
const HTTPS_URL = /^https?:\/\/[^\s"'<>\\]+$/i;

/**
 * Build a guest tree (`{t, a, c}` elements, `{x}` text, `{h}` raw HTML, `{t: 'canvas', cmd}`) as real
 * DOM through the allowlist.
 * @param {Document} doc @param {any[]} nodes @param {boolean} [svg] inside an <svg>
 * @param {{n: number}} [budget] @param {SanitizeOptions} [opts]
 * @returns {Node[]}
 */
export function buildSanitized(doc, nodes, svg = false, budget = { n: 0 }, opts = {}) {
	/** @type {Node[]} */
	const out = [];
	if (!Array.isArray(nodes)) return out;
	for (const node of nodes) {
		if (++budget.n > MAX_NODES) break;
		if (!node || typeof node !== 'object') continue;
		if (typeof node.x === 'string') {
			out.push(doc.createTextNode(node.x.slice(0, MAX_TEXT)));
			continue;
		}
		if (typeof node.h === 'string') {
			out.push(...sanitizeHtmlNodes(doc, node.h, svg, budget, opts));
			continue;
		}
		const tag = String(node.t ?? '').toLowerCase();
		const inSvg = svg || tag === 'svg';
		if (tag === 'a' && opts.links && !inSvg) {
			const href = String(node.a?.href ?? '');
			const a = doc.createElement('a');
			if (HTTPS_URL.test(href)) {
				a.setAttribute('href', href);
				a.setAttribute('target', '_blank');
				a.setAttribute('rel', 'noopener noreferrer');
			}
			a.append(...buildSanitized(doc, node.c, false, budget, opts));
			out.push(a);
			continue;
		}
		if (!(inSvg ? SVG_TAGS.has(tag) : HTML_TAGS.has(tag))) {
			// an unknown element keeps its CONTENT (text is the point of most markup) — never a
			// script's or a style sheet's
			if (tag !== 'script' && tag !== 'style') out.push(...buildSanitized(doc, node.c, svg, budget, opts));
			continue;
		}
		const el = inSvg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
		if (node.a && typeof node.a === 'object') {
			for (const [rawName, value] of Object.entries(node.a)) {
				const name = String(rawName).toLowerCase();
				if (typeof value !== 'string' && typeof value !== 'number') continue;
				if (attrAllowed(tag, name, String(value))) setAttr(el, name, String(value));
			}
		}
		if (tag === 'canvas') {
			const w = Math.min(MAX_CANVAS_SIDE, Math.max(0, Math.round(Number(node.a?.width ?? 300)) || 0));
			const h = Math.min(MAX_CANVAS_SIDE, Math.max(0, Math.round(Number(node.a?.height ?? 150)) || 0));
			/** @type {HTMLCanvasElement} */ (el).width = w;
			/** @type {HTMLCanvasElement} */ (el).height = h;
			replayCanvas(/** @type {HTMLCanvasElement} */ (el), node.cmd);
		} else el.append(...buildSanitized(doc, node.c, inSvg, budget, opts));
		out.push(el);
	}
	return out;
}

/** @param {Element | DocumentFragment} root @returns {any[]} an inert parsed tree as guest-shaped nodes */
function treeOf(root) {
	const out = [];
	for (const child of Array.from(root.childNodes)) {
		if (child.nodeType === 3) out.push({ x: child.textContent ?? '' });
		else if (child.nodeType === 1) {
			const el = /** @type {Element} */ (child);
			/** @type {Record<string, string>} */
			const a = {};
			for (const attr of Array.from(el.attributes)) a[attr.name] = attr.value;
			out.push({ t: el.localName, a, c: treeOf(el.localName === 'template' ? /** @type {any} */ (el).content : el) });
		}
	}
	return out;
}

/**
 * An HTML string as sanitised nodes of `doc`. The parse happens in an inert document (no script
 * runs, no image loads) and the result goes through the same allowlist as a guest tree.
 * @param {Document} doc @param {string} html @param {boolean} [svg] @param {{n: number}} [budget]
 * @param {SanitizeOptions} [opts]
 */
export function sanitizeHtmlNodes(doc, html, svg = false, budget = { n: 0 }, opts = {}) {
	if (typeof DOMParser === 'undefined') return [doc.createTextNode(String(html))];
	const parsed = new DOMParser().parseFromString('<!doctype html><body>' + String(html).slice(0, 200000), 'text/html');
	return buildSanitized(doc, treeOf(parsed.body), svg, budget, opts);
}

/** replace `target`'s children with a sanitised HTML string @param {Element} target @param {string} html
 * @param {SanitizeOptions} [opts] */
export function sanitizeHtmlInto(target, html, opts = {}) {
	target.replaceChildren(...sanitizeHtmlNodes(target.ownerDocument, html, false, { n: 0 }, opts));
}

/** a svelte action: `<div use:safeHtml={html}>` — sanitised, https links kept (attribution text)
 * @param {HTMLElement} node @param {string} html */
export function safeHtml(node, html) {
	sanitizeHtmlInto(node, html ?? '', { links: true });
	return {
		/** @param {string} next */
		update(next) {
			sanitizeHtmlInto(node, next ?? '', { links: true });
		}
	};
}
