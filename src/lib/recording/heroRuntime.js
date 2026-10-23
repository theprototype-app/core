// 65 M7 — THE WEBSITE SECTION RUNTIME: the code inside an exported section's one <script>.
//
// NOT part of the app bundle. vite.config.ts' `tpHeroRuntime` plugin bundles THIS file (with the
// anime.js v4 animation module it imports, tree-shaken, and heroMath.js) into a minified IIFE string
// served as `virtual:tp-hero-runtime`; heroExport.js wraps that string around the frames. So it must
// run on any page in any modern browser with nothing else loaded: no app imports, no globals.
//
// What it does: finds its canvas (`canvas[data-tp-hero="<id>"]`, else the canvas just before the
// script, else makes one there), decodes the frames, sizes the drawing buffer to the canvas' CSS box
// × devicePixelRatio (ResizeObserver — responsive by construction), and draws the frame for the
// timeline position. The position follows scroll / hover / click and GLIDES there with anime.js;
// under prefers-reduced-motion it jumps (scroll still scrubs — the reader drives it — but nothing
// eases or plays by itself).
import { animate } from 'animejs/animation';
import { scrollProgress, frameIndexAt, fitRect, nextTarget, glideMs } from './heroMath.js';

/**
 * @typedef {{v: number, id: string, label: string, w: number, h: number, fps: number, duration: number,
 *   trigger: 'scroll'|'hover'|'click', ease: string, smooth: number, fit: 'cover'|'contain', mime: string,
 *   frames: string[]}} HeroData
 */

/**
 * @param {HeroData} data @param {HTMLScriptElement | null} script the <script> that carried it
 * @returns {{destroy: () => void, seek: (t: number) => void, state: () => {t: number, frame: number, ready: boolean}} | null}
 */
export function mount(data, script) {
	if (typeof document === 'undefined' || !data || !data.frames || !data.frames.length) return null;
	/** @type {HTMLCanvasElement | null} */
	let canvas = document.querySelector('canvas[data-tp-hero="' + data.id + '"]');
	if (!canvas && script && script.previousElementSibling instanceof HTMLCanvasElement) canvas = script.previousElementSibling;
	if (!canvas) {
		canvas = document.createElement('canvas');
		if (script && script.parentNode) script.parentNode.insertBefore(canvas, script);
		else document.body.appendChild(canvas);
	}
	const el = canvas;
	el.setAttribute('data-tp-hero', data.id);
	if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
	if (!el.hasAttribute('aria-label') && data.label) el.setAttribute('aria-label', data.label);
	// an unsized canvas takes the frames' shape at the page's width
	if (!el.style.width && !el.getAttribute('width')) el.style.width = '100%';
	if (!el.style.aspectRatio && !el.style.height && !el.getAttribute('height')) el.style.aspectRatio = data.w + ' / ' + data.h;
	el.style.display = el.style.display || 'block';
	const ctx = el.getContext('2d');
	if (!ctx) return null;

	const n = data.frames.length;
	/** @type {(HTMLImageElement | null)[]} */
	const images = new Array(n).fill(null);
	let loaded = 0;
	const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const state = { t: 0 };
	let target = 0;
	let drawn = -1;
	/** @type {any} */
	let glide = null;
	let alive = true;

	function draw() {
		if (!alive) return;
		let i = frameIndexAt(state.t, n);
		// a frame still decoding: show the nearest one that is ready
		if (!images[i]) {
			let best = -1;
			for (let d = 1; d < n && best < 0; d++) {
				if (images[i - d]) best = i - d;
				else if (images[i + d]) best = i + d;
			}
			if (best < 0) return;
			i = best;
		}
		if (i === drawn && el.width === lastW && el.height === lastH) return;
		const img = /** @type {HTMLImageElement} */ (images[i]);
		ctx.clearRect(0, 0, el.width, el.height);
		const r = fitRect(data.w, data.h, el.width, el.height, data.fit);
		ctx.drawImage(img, r.x, r.y, r.w, r.h);
		drawn = i;
		lastW = el.width;
		lastH = el.height;
		el.setAttribute('data-frame', String(i));
	}
	let lastW = 0;
	let lastH = 0;

	function resize() {
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		const w = Math.max(1, Math.round(el.clientWidth * dpr));
		const h = Math.max(1, Math.round(el.clientHeight * dpr));
		if (w !== el.width || h !== el.height) {
			el.width = w;
			el.height = h;
			draw();
		}
	}

	/** @param {number} to @param {boolean} [instant] */
	function go(to, instant) {
		target = to;
		if (data.trigger === 'click') el.setAttribute('aria-pressed', String(to >= 0.5));
		if (glide) glide.pause();
		glide = null;
		const ms = glideMs(data.trigger, state.t, to, { smooth: data.smooth, duration: data.duration });
		if (instant || reduce || ms < 1) {
			state.t = to;
			draw();
			return;
		}
		glide = animate(state, { t: to, duration: ms, ease: data.ease, onUpdate: draw });
	}

	// the frames: decode in order, the first one (the poster) first
	data.frames.forEach((b64, i) => {
		const img = new Image();
		img.onload = () => {
			images[i] = img;
			loaded++;
			if (loaded === n) el.setAttribute('data-ready', '1');
			draw();
		};
		img.src = 'data:' + data.mime + ';base64,' + b64;
	});

	/** @type {(() => void)[]} */
	const off = [];
	/** @param {EventTarget} t @param {string} type @param {any} fn @param {any} [opts] */
	const on = (t, type, fn, opts) => {
		t.addEventListener(type, fn, opts);
		off.push(() => t.removeEventListener(type, fn, opts));
	};
	if (data.trigger === 'scroll') {
		const track = /** @type {HTMLElement} */ (el.closest('[data-tp-hero-track]') || el);
		const mode = track === el ? 'pass' : 'track';
		let queued = false;
		const onScroll = () => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(() => {
				queued = false;
				const p = scrollProgress(track.getBoundingClientRect(), window.innerHeight, mode);
				if (Math.abs(p - target) > 1e-4) go(p);
			});
		};
		on(window, 'scroll', onScroll, { passive: true });
		on(window, 'resize', onScroll);
		state.t = target = scrollProgress(track.getBoundingClientRect(), window.innerHeight, mode);
	} else {
		/** @param {string} kind */
		const handler = (kind) => () => go(nextTarget(/** @type {any} */ (data.trigger), kind, target));
		if (data.trigger === 'hover') {
			on(el, 'pointerenter', handler('enter'));
			on(el, 'pointerleave', handler('leave'));
			on(el, 'focus', handler('enter'));
			on(el, 'blur', handler('leave'));
		} else {
			on(el, 'click', handler('click'));
			on(el, 'keydown', (/** @type {KeyboardEvent} */ e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					handler('click')();
				}
			});
			el.style.cursor = el.style.cursor || 'pointer';
			if (!el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'false');
			off.push(() => el.removeAttribute('aria-pressed'));
		}
		// reachable from the keyboard: hover follows focus, click follows Enter/Space
		if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
	}
	const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
	if (ro) ro.observe(el);
	else on(window, 'resize', resize);
	resize();

	return {
		destroy() {
			alive = false;
			if (glide) glide.pause();
			ro?.disconnect();
			off.forEach((f) => f());
		},
		/** @param {number} t */
		seek(t) {
			go(Math.min(1, Math.max(0, t)), true);
		},
		state: () => ({ t: state.t, frame: drawn, ready: loaded === n })
	};
}
