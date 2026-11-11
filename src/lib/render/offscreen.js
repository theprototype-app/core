// 101 F3 — ONE SHARED OFF-SCREEN RENDERER for the five thumbnail / preview renderers (a leaf).
//
// Before this file each of them made its OWN WebGLRenderer (prefabs, sessions and explorer one per
// thumbnail, ModelPreview and PeerProfileCard one per open preview), and every one is a WebGL
// context: Chromium keeps ~16 per page and drops the OLDEST past that, which can be the main view.
// Now there is one, made on first use and disposed after IDLE_MS with nobody holding it.
//
// THE RULE THAT KEEPS PICTURES IDENTICAL: a borrower gets the renderer in a FRESH renderer's state
// (pixel ratio 1, sRGB output, no tone mapping, transparent black clear, auto clear, no target),
// exactly what `new THREE.WebGLRenderer({antialias: true, alpha: true})` gave it before, and draws
// and reads in ONE task (a canvas's drawing buffer is valid until the task ends, so `toDataURL` /
// `drawImage` straight after `render` see the frame without `preserveDrawingBuffer`).
// - one-shot thumbnails: `renderOffscreen(w, h, (renderer) => …)` — sizes it, runs, releases.
// - a live preview on its own canvas: `acquireOffscreen()` once, then per frame
//   `blitOffscreen(lease, canvas2d, w, h, pixelRatio, (renderer) => renderer.render(...))` which
//   draws into the shared canvas and copies the frame into the preview's 2D canvas; `release()`.
import * as THREE from 'three';

/** a thumbnail renderer that nobody holds is disposed after this long */
export const OFFSCREEN_IDLE_MS = 30_000;

/** the constructor options every thumbnail renderer used */
export const OFFSCREEN_OPTIONS = Object.freeze({ antialias: true, alpha: true });

/** @type {THREE.WebGLRenderer | null} */
let shared = null;
let holders = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let idle = null;
let made = 0;

/** a renderer's defaults, re-asserted before each borrow (a previous borrower may have changed
 * them). The pixel ratio is touched only when it differs: three's setPixelRatio re-sizes the
 * canvas, and setting a canvas's width — even to the same number — reallocates its buffer.
 * @param {THREE.WebGLRenderer} r */
function freshState(r) {
	r.setRenderTarget(null);
	if (r.getPixelRatio() !== 1) r.setPixelRatio(1);
	r.outputColorSpace = THREE.SRGBColorSpace;
	r.toneMapping = THREE.NoToneMapping;
	r.toneMappingExposure = 1;
	r.setClearColor(0x000000, 0);
	r.autoClear = true;
	r.shadowMap.enabled = false;
	r.localClippingEnabled = false;
}

function get() {
	if (idle) {
		clearTimeout(idle);
		idle = null;
	}
	if (!shared) {
		shared = new THREE.WebGLRenderer({ ...OFFSCREEN_OPTIONS });
		made++;
	}
	return shared;
}

function letGo() {
	holders = Math.max(0, holders - 1);
	if (holders > 0 || idle) return;
	idle = setTimeout(() => {
		idle = null;
		if (holders === 0) disposeOffscreen();
	}, OFFSCREEN_IDLE_MS);
}

/**
 * Free the GPU copies of a TEMPORARY subtree's geometries, materials and their textures (the JS
 * objects stay usable: three re-uploads on a later use). A thumbnail renderer of its own used to
 * free them by losing its whole context after each picture; the shared one keeps living, so a
 * one-shot job hands its throw-away scene here instead.
 * @param {any} root
 */
export function releaseGpu(root) {
	const seen = new Set();
	const free = (/** @type {any} */ x) => {
		if (!x || seen.has(x)) return;
		seen.add(x);
		x.dispose?.();
	};
	root?.traverse?.((/** @type {any} */ o) => {
		free(o.geometry);
		for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
			for (const v of Object.values(m)) if (/** @type {any} */ (v)?.isTexture) free(v);
			free(m);
		}
	});
	if (root?.background?.isTexture) free(root.background);
	if (root?.environment?.isTexture) free(root.environment);
}

/**
 * Borrow the shared renderer for one synchronous job at `width`×`height` (CSS px = device px,
 * pixel ratio 1). Throws what the renderer's construction throws (no context).
 * `opts.release`: a throw-away subtree whose GPU copies are freed after the job (releaseGpu).
 * @template T @param {number} width @param {number} height @param {(renderer: THREE.WebGLRenderer) => T} job
 * @param {{ release?: any }} [opts] @returns {T}
 */
export function renderOffscreen(width, height, job, opts = {}) {
	const r = get();
	holders++;
	try {
		freshState(r);
		r.setSize(width, height);
		return job(r);
	} finally {
		if (opts.release) releaseGpu(opts.release);
		letGo();
	}
}

/**
 * Hold the shared renderer for a live preview (ModelPreview, the profile card's turntable).
 * Throws when no context can be made. `release()` exactly once.
 * @returns {{ readonly renderer: THREE.WebGLRenderer, release: () => void }}
 */
export function acquireOffscreen() {
	get();
	holders++;
	let held = true;
	return {
		/** resolved on each read: after a disposeRenderer() the next frame gets a new one */
		get renderer() {
			return get();
		},
		release() {
			if (!held) return;
			held = false;
			letGo();
		}
	};
}

/**
 * One frame of a live preview: draw `width`×`height` CSS px at `pixelRatio` with the shared
 * renderer, then copy the frame into `target`'s 2D context. The same pixels a renderer of its
 * own made with `setPixelRatio(pixelRatio); setSize(width, height, false)`: the viewport is
 * round(size × ratio) and the picture is floor(size × ratio) — three's own two roundings. The
 * shared canvas only GROWS (a resize every frame would reallocate it every frame, and two open
 * previews would fight); the frame sits in its bottom-left corner, where GL's origin is.
 * @param {{ readonly renderer: THREE.WebGLRenderer }} lease @param {HTMLCanvasElement} target
 * @param {number} width @param {number} height @param {number} pixelRatio
 * @param {(renderer: THREE.WebGLRenderer) => void} draw
 */
export function blitOffscreen(lease, target, width, height, pixelRatio, draw) {
	const r = lease.renderer;
	freshState(r);
	const src = r.domElement;
	const outW = Math.max(1, Math.floor(width * pixelRatio));
	const outH = Math.max(1, Math.floor(height * pixelRatio));
	const vw = Math.round(width * pixelRatio);
	const vh = Math.round(height * pixelRatio);
	const needW = Math.max(vw, outW);
	const needH = Math.max(vh, outH);
	if (src.width < needW || src.height < needH) r.setSize(Math.max(src.width, needW), Math.max(src.height, needH), false);
	r.setViewport(0, 0, vw, vh);
	draw(r);
	if (target.width !== outW) target.width = outW;
	if (target.height !== outH) target.height = outH;
	const ctx = target.getContext('2d');
	if (!ctx) return;
	ctx.globalCompositeOperation = 'copy';
	ctx.drawImage(src, 0, src.height - outH, outW, outH, 0, 0, outW, outH);
	ctx.globalCompositeOperation = 'source-over';
}

/** dispose the shared renderer now (idle timer / disposeRenderer); the next borrow — a live
 * preview's next frame included — makes a new one */
export function disposeOffscreen() {
	if (idle) {
		clearTimeout(idle);
		idle = null;
	}
	if (!shared) return false;
	const r = shared;
	shared = null;
	try {
		r.dispose();
		r.forceContextLoss?.();
	} catch {
		/* releasing is a courtesy */
	}
	return true;
}

/** what the seam holds (unit + e2e probe) */
export function offscreenState() {
	return { alive: !!shared, holders, made };
}
