// 69 T1 — THE HUD "Custom (code)" ELEMENT IN THE GUEST. Its render function `(el, runtime,
// container) -> void` runs inside the sandbox guest against a small DOM PROXY (document.createElement
// / createElementNS / createTextNode / createDocumentFragment, textContent, innerHTML, style,
// className / classList, attributes, dataset, append / insertBefore / remove / replaceChildren, and
// a <canvas> whose 2D context RECORDS its calls). After the call the proxy tree is serialised and
// rebuilt as real DOM through the allowlist in sanitize.js, so whatever the code writes it cannot
// add a script, a handler, a link or anything that loads a URL. Not covered (documented): event
// listeners (accepted and ignored), timers, images by URL, reading layout.

import { newGuest, loadSandbox } from './engine.js';
import { buildSanitized, sanitizeCss } from './sanitize.js';

/** @type {import('./engine.js').Guest | null} */
let guest = null;
/** @type {CanvasRenderingContext2D | null} */
let measureCtx = null;

const ops = {
	/** ctx.measureText, answered by a real (detached) canvas @param {string} font @param {string} text */
	measure: (font, text) => {
		if (typeof document === 'undefined') return String(text ?? '').length * 7;
		measureCtx ??= document.createElement('canvas').getContext('2d');
		if (!measureCtx) return 0;
		measureCtx.font = String(font ?? '10px sans-serif').slice(0, 200);
		return measureCtx.measureText(String(text ?? '').slice(0, 2000)).width;
	}
};

function hudGuest() {
	if (guest && !guest.disposed) return guest;
	guest = newGuest(ops, [HUD_PRELUDE]);
	return guest;
}

/** resolves once custom elements can render */
export function hudSandboxReady() {
	return loadSandbox().then(() => true);
}

/**
 * Run a custom element's code. `null` while the engine is loading (the caller waits on
 * hudSandboxReady and re-runs), else `{nodes, style}` (sanitise-ready) or `{error}`.
 * @param {string} code @param {any} element @param {any} runtime
 */
export function renderCustomInGuest(code, element, runtime) {
	const g = hudGuest();
	if (!g) return null;
	try {
		const out = g.callEntry('__render', String(code ?? ''), element ?? null, runtime ?? null);
		if (out?.error) return { error: String(out.error) };
		return { nodes: Array.isArray(out?.c) ? out.c : [], style: typeof out?.s === 'string' ? out.s : '' };
	} catch (error) {
		return { error: String(/** @type {any} */ (error)?.message ?? error) };
	}
}

/**
 * Render into the slot: sanitised children, sanitised container style.
 * @param {HTMLElement} slot @param {{nodes: any[], style: string}} result
 */
export function paintCustom(slot, result) {
	slot.replaceChildren(...buildSanitized(slot.ownerDocument, result.nodes));
	const css = sanitizeCss(result.style);
	if (css) slot.setAttribute('style', css);
	else slot.removeAttribute('style');
}

// ---- guest side ------------------------------------------------------------------------------
const HUD_PRELUDE = String.raw`
(function () {
	'use strict';
	const B = __bridge;
	const kebab = (p) => p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
	const camel = (p) => p.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
	function makeStyle() {
		const map = new Map();
		const api = {
			setProperty: (k, v) => { if (v === null || v === undefined || v === '') map.delete(String(k)); else map.set(String(k), String(v)); },
			removeProperty: (k) => { const v = map.get(String(k)) || ''; map.delete(String(k)); return v; },
			getPropertyValue: (k) => map.get(String(k)) || ''
		};
		return new Proxy(api, {
			get(t, prop) {
				if (prop === 'cssText') return [...map].map(([k, v]) => k + ': ' + v).join('; ');
				if (typeof prop !== 'string') return undefined;
				if (prop in t) return t[prop];
				return map.get(kebab(prop)) || '';
			},
			set(t, prop, value) {
				if (prop === 'cssText') {
					map.clear();
					for (const d of String(value).split(';')) {
						const i = d.indexOf(':');
						if (i > 0) map.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim());
					}
					return true;
				}
				if (typeof prop === 'string') t.setProperty(prop.startsWith('--') ? prop : kebab(prop), value);
				return true;
			}
		});
	}
	const METHODS = ['fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect',
		'roundRect', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'fillText', 'strokeText', 'save', 'restore',
		'translate', 'rotate', 'scale', 'setTransform', 'resetTransform', 'setLineDash', 'clip'];
	function context2d(el) {
		const props = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px sans-serif', globalAlpha: 1, textAlign: 'start', textBaseline: 'alphabetic' };
		const ctx = { canvas: el, measureText: (t) => ({ width: B.call('measure', props.font, String(t)) }), getLineDash: () => [] };
		for (const m of METHODS) ctx[m] = (...a) => { el.__cmd.push([m, a]); };
		return new Proxy(ctx, {
			get: (t, p) => (p in t ? t[p] : props[p]),
			set: (t, p, v) => { props[p] = v; el.__cmd.push(['=', p, v]); return true; }
		});
	}

	class Node {
		constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
		get parentElement() { return this.parentNode; }
		get firstChild() { return this.childNodes[0] || null; }
		get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
		get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
		get previousSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) - 1] || null : null; }
		remove() { if (this.parentNode) this.parentNode.removeChild(this); }
		addEventListener() {}
		removeEventListener() {}
	}
	class Text extends Node {
		constructor(t) { super(3); this.data = String(t); }
		get textContent() { return this.data; }
		set textContent(v) { this.data = String(v); }
		get nodeValue() { return this.data; }
		set nodeValue(v) { this.data = String(v); }
	}
	class Raw extends Node {
		constructor(h) { super(1001); this.html = h; }
		get textContent() { return this.html.replace(/<[^>]*>/g, ''); }
	}
	const toNode = (n) => (n instanceof Node ? n : new Text(n));
	class Element extends Node {
		constructor(tag, svg) {
			super(tag === '#fragment' ? 11 : 1);
			this.localName = String(tag).toLowerCase();
			this.tagName = svg ? this.localName : this.localName.toUpperCase();
			this.nodeName = this.tagName;
			this.attrs = new Map();
			this.style = makeStyle();
			this.__cmd = [];
			const self = this;
			this.classList = {
				add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(String(x))); self.className = [...s].join(' '); },
				remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
				toggle: (c, force) => { const has = self.classList.contains(c); const want = force === undefined ? !has : !!force; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
				contains: (c) => self.className.split(/\s+/).includes(String(c))
			};
			this.dataset = new Proxy({}, {
				get: (_t, k) => (typeof k === 'string' ? self.getAttribute('data-' + kebab(k)) ?? undefined : undefined),
				set: (_t, k, v) => { self.setAttribute('data-' + kebab(String(k)), v); return true; }
			});
		}
		get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
		get childElementCount() { return this.children.length; }
		get firstElementChild() { return this.children[0] || null; }
		get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
		get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
		set textContent(v) { this.childNodes.forEach((n) => (n.parentNode = null)); this.childNodes = v === '' || v === null || v === undefined ? [] : [new Text(v)]; this.childNodes.forEach((n) => (n.parentNode = this)); }
		get innerText() { return this.textContent; }
		set innerText(v) { this.textContent = v; }
		get innerHTML() { return this.childNodes.map((n) => (n.nodeType === 3 ? n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;') : n.nodeType === 1001 ? n.html : n.outerHTML)).join(''); }
		set innerHTML(v) { this.childNodes.forEach((n) => (n.parentNode = null)); const r = new Raw(String(v)); r.parentNode = this; this.childNodes = [r]; }
		get outerHTML() { const a = [...this.attrs].map(([k, v]) => ' ' + k + '="' + String(v).replace(/"/g, '&quot;') + '"').join(''); return '<' + this.localName + a + '>' + this.innerHTML + '</' + this.localName + '>'; }
		get className() { return this.attrs.get('class') || ''; }
		set className(v) { this.attrs.set('class', String(v)); }
		get id() { return this.attrs.get('id') || ''; }
		set id(v) { this.attrs.set('id', String(v)); }
		get title() { return this.attrs.get('title') || ''; }
		set title(v) { this.attrs.set('title', String(v)); }
		get width() { return Number(this.attrs.get('width') ?? 300); }
		set width(v) { this.attrs.set('width', String(v)); if (this.localName === 'canvas') this.__cmd = []; }
		get height() { return Number(this.attrs.get('height') ?? 150); }
		set height(v) { this.attrs.set('height', String(v)); if (this.localName === 'canvas') this.__cmd = []; }
		get src() { return this.attrs.get('src') || ''; }
		set src(v) { this.attrs.set('src', String(v)); }
		get value() { return this.attrs.get('value') || ''; }
		set value(v) { this.attrs.set('value', String(v)); }
		setAttribute(k, v) { const key = String(k).toLowerCase(); if (key === 'style') this.style.cssText = String(v); else this.attrs.set(key, String(v)); }
		getAttribute(k) { const key = String(k).toLowerCase(); return key === 'style' ? this.style.cssText : this.attrs.has(key) ? this.attrs.get(key) : null; }
		hasAttribute(k) { return this.getAttribute(k) !== null; }
		removeAttribute(k) { const key = String(k).toLowerCase(); if (key === 'style') this.style.cssText = ''; else this.attrs.delete(key); }
		appendChild(n) {
			if (n.nodeType === 11) { [...n.childNodes].forEach((c) => this.appendChild(c)); return n; }
			if (n.parentNode) n.parentNode.removeChild(n);
			n.parentNode = this;
			this.childNodes.push(n);
			return n;
		}
		append(...ns) { ns.forEach((n) => this.appendChild(toNode(n))); }
		prepend(...ns) { const first = this.firstChild; ns.forEach((n) => this.insertBefore(toNode(n), first)); }
		insertBefore(n, ref) {
			if (!ref) return this.appendChild(n);
			if (n.nodeType === 11) { [...n.childNodes].forEach((c) => this.insertBefore(c, ref)); return n; }
			if (n.parentNode) n.parentNode.removeChild(n);
			const i = this.childNodes.indexOf(ref);
			n.parentNode = this;
			this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
			return n;
		}
		removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
		replaceChild(n, old) { this.insertBefore(n, old); return this.removeChild(old); }
		replaceChildren(...ns) { this.childNodes.forEach((n) => (n.parentNode = null)); this.childNodes = []; this.append(...ns); }
		cloneNode(deep) {
			const c = new Element(this.localName, this.tagName === this.localName);
			this.attrs.forEach((v, k) => c.attrs.set(k, v));
			c.style.cssText = this.style.cssText;
			if (deep) this.childNodes.forEach((n) => c.appendChild(n.cloneNode ? n.cloneNode(true) : n.nodeType === 3 ? new Text(n.data) : new Raw(n.html)));
			return c;
		}
		querySelector() { return null; }
		querySelectorAll() { return []; }
		getContext(kind) { return this.localName === 'canvas' && kind === '2d' ? (this.__ctx ||= context2d(this)) : null; }
		getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
	}
	Text.prototype.cloneNode = function () { return new Text(this.data); };
	const document = Object.freeze({
		createElement: (tag) => new Element(String(tag), false),
		createElementNS: (_ns, tag) => new Element(String(tag), true),
		createTextNode: (t) => new Text(t),
		createDocumentFragment: () => new Element('#fragment', false)
	});
	Object.defineProperty(globalThis, 'document', { value: document });

	const ser = (n) => {
		if (n.nodeType === 3) return { x: n.data };
		if (n.nodeType === 1001) return { h: n.html };
		const a = {};
		n.attrs.forEach((v, k) => (a[k] = v));
		const css = n.style.cssText;
		if (css) a.style = css;
		const out = { t: n.localName, a, c: n.childNodes.map(ser) };
		if (n.localName === 'canvas') out.cmd = n.__cmd;
		return out;
	};

	const compiled = new Map();
	Object.defineProperty(globalThis, '__render', {
		value: (json) => {
			const [code, el, runtime] = B.decode(json);
			let fn = compiled.get(code);
			if (!fn) {
				if (compiled.size > 100) compiled.clear();
				try {
					fn = new Function('el', 'runtime', 'container', code);
				} catch (error) {
					return B.encode({ error: String(error && error.message || error) });
				}
				compiled.set(code, fn);
			}
			const container = new Element('div', false);
			try {
				fn(el, runtime, container);
			} catch (error) {
				return B.encode({ error: String(error && error.message || error) });
			}
			return B.encode({ c: container.childNodes.map(ser), s: container.style.cssText });
		}
	});
})();
`;
