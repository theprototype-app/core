// 100 C1 — THE CINEMATIC VIEW SWITCH (a LAZY chunk: three/webgpu, three/tsl and the lighting arrive with
// the first press; phones, Quest and XR sessions never load it — cinematicState.js does not offer it there).
//
// One renderer in GPU memory at a time, the SAME live scene, nothing rebuilt:
//   on:  the sky / environment unrolled to CPU copies (envHandover) → the WebGL context RELEASED
//        (render/view.js: lost on purpose, Scene.svelte does not report it) → a fresh canvas over the
//        WebGL one (a canvas keeps one context type for life; pointer input still lands on the WebGL
//        canvas underneath, so picking, gizmos and orbit are untouched) → WebGPURenderer → stand-ins for
//        the GLSL materials it cannot run → the lighting pipeline → compiled off the frame (the seam's
//        compileAsync, which closes the scene bracket three's WebGPU compile leaves open: L1a) → threlte's
//        render task hands its frame to `draw` (render/view.js). Everything else keeps ticking: flows,
//        physics, gizmos, undo, peers, autosave, the recorder's stages.
//   off: the WebGPU renderer, its pipeline and canvas disposed → stand-ins back → the WebGL context
//        restored (three rebuilds from JS memory; Scene.svelte marks every material for recompile) → the
//        environment's render targets refilled in place from the copies (W19) → held geometry disposals run.
// A failure on the way in or while on (a pipeline that does not compile on this graphics path — D3D11 /
// FXC fails both GI passes — or a lost device) falls back to the standard view by itself, with one toast,
// and the switch is disabled for the rest of the session with the reason.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { setViewOwner, flushHeldDisposals, viewSelection } from '../render/view.js';
import { releaseMainContext, restoreMainContext } from './mainContext.js';
import { glGenerationEnding, glGenerationStarting, gpuGenerationStarting, gpuGenerationEnded, generationStats } from '../render/generations.js';
import { compileAsync } from '../render/compile.js';
import { captureEnvironment, useCopies, restoreEnvironment } from './envHandover.js';
import { buildPipeline } from './pipeline.js';
import { classifyMaterial, notShownText, effectiveQuality, createDropWatch, quantile } from './cinematicCore.js';
// the STORE leaf, never ./cinematicState.js (that one reaches the app's stores: this chunk's preload list)
import { cinematicState, cinematicPrefs, disableCinematic } from './cinematicStore.js';
import { deformersOf } from '../vertexDeform.js';

/** @typedef {{ gl: any, scene: any, camera: () => any, toast: (msg: string) => void }} ViewCtx */
/** @type {ViewCtx | null} what the app handed over (cinematicState.js) */
let app = null;

/** the stand-in colours by kind (a plain material in roughly the thing's colour) */
const STAND_IN_COLOR = { water: 0x2f6f8f, fluid: 0x3a7fa8, particles: 0xd8dde6, text: 0xe8e8e8, custom: 0x8a8f98 };

/** @type {any} */
let live = null;
/** @type {Promise<any> | null} */
let busy = null;
const log = { switches: /** @type {any[]} */ ([]), errors: /** @type {any[]} */ ([]), frames: /** @type {number[]} */ ([]) };

const now = () => performance.now();
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
/** @param {Record<string, any>} patch */
const patchState = (patch) => cinematicState.update((s) => ({ ...s, ...patch }));

/** @param {any} r the WebGPU renderer @param {HTMLCanvasElement} glCanvas */
function drawnPixels(r, glCanvas) {
	const b = glCanvas.getBoundingClientRect();
	return Math.round(b.width * r.getPixelRatio()) * Math.round(b.height * r.getPixelRatio());
}

/**
 * Stand-ins for what the WebGPU renderer cannot draw, and the editor grid's twin (W2: its ShaderMaterial's
 * fallback is OPAQUE and wrote depth over the whole view). `scan()` runs on the way in and then about once
 * a second, so objects added while the view is on (a load, a peer's edit, a new emitter) get theirs too.
 * @param {any} W @param {any} scene
 */
function createSwapper(W, scene) {
	/** @type {{ o: any, i: number, m: any, stand: any, kind?: any }[]} */
	const swapped = [];
	/** @type {{ g: any, twin: any }[]} */
	const grids = [];
	/** @type {Set<any>} */
	const stands = new Set();
	/** @type {Set<any>} */
	let kinds = new Set();
	const deformed = (/** @type {any} */ o) => !!o?.isMesh && deformersOf(o).length > 0;

	/** @param {any} g the editor grid (threlte's Grid: a plane with a ShaderMaterial) */
	function gridTwin(g) {
		const u = g.material?.uniforms ?? {};
		const cell = Math.max(0.01, Number(u.cellSize?.value) || 1);
		const section = Math.max(cell, Number(u.sectionSize?.value) || 10);
		const fade = Math.max(10, Number(u.fadeDistance?.value) || 100);
		const size = Math.min(2000, Math.ceil((fade * 2) / section) * section);
		const twin = new THREE.GridHelper(size, Math.min(400, Math.max(1, Math.round(size / cell))), u.sectionColor?.value?.isColor ? u.sectionColor.value.clone() : new THREE.Color('#666666'), u.cellColor?.value?.isColor ? u.cellColor.value.clone() : new THREE.Color('#444444'));
		twin.name = 'cinematic-grid';
		twin.userData.localOnly = true;
		twin.raycast = () => {};
		for (const mm of Array.isArray(twin.material) ? twin.material : [twin.material]) {
			mm.transparent = true;
			mm.opacity = 0.5;
			mm.depthWrite = false;
		}
		twin.position.copy(g.position);
		twin.renderOrder = g.renderOrder;
		g.parent?.add(twin);
		g.visible = false;
		grids.push({ g, twin });
	}

	function scan() {
		/** @type {Set<any>} */
		const now = new Set();
		scene.traverse((/** @type {any} */ o) => {
			if (o.name === 'editor-grid') {
				if (o.visible && !grids.some((x) => x.g === o)) gridTwin(o);
				return;
			}
			const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
			list.forEach((/** @type {any} */ m, /** @type {number} */ i) => {
				if (stands.has(m)) {
					const rec = swapped.find((x) => x.stand === m);
					if (rec?.kind && o.visible !== false) now.add(rec.kind);
					return;
				}
				const c = classifyMaterial(o, m, { deformed });
				if (c.kind && o.visible !== false && !o.userData?.localOnly) now.add(c.kind);
				if (!c.swap) return;
				const tint = m.uniforms?.color?.value ?? m.uniforms?.uColor?.value ?? m.uniforms?.diffuse?.value;
				const color = tint?.isColor ? tint : new THREE.Color(/** @type {any} */ (STAND_IN_COLOR)[c.kind ?? 'custom'] ?? STAND_IN_COLOR.custom);
				const water = c.kind === 'water' || c.kind === 'fluid';
				const stand = new W.MeshStandardNodeMaterial({ color, roughness: water ? 0.15 : 0.7, metalness: 0, transparent: water || !!m.transparent, opacity: water ? 0.7 : 1, side: m.side, depthWrite: m.depthWrite !== false && !water });
				stand.name = 'cinematic-stand-in';
				stands.add(stand);
				swapped.push({ o, i, m, stand, kind: c.kind });
				if (Array.isArray(o.material)) o.material[i] = stand;
				else o.material = stand;
			});
		});
		kinds = now;
		return kinds;
	}

	return {
		scan,
		get kinds() {
			return kinds;
		},
		get swapped() {
			return swapped.length;
		},
		undo() {
			for (const { o, i, m, stand } of swapped) {
				if (Array.isArray(o.material)) {
					if (o.material[i] === stand) o.material[i] = m;
				} else if (o.material === stand) o.material = m;
				stand.dispose();
			}
			swapped.length = 0;
			stands.clear();
			for (const { g, twin } of grids) {
				g.visible = true;
				twin.removeFromParent();
				twin.geometry.dispose();
				for (const mm of Array.isArray(twin.material) ? twin.material : [twin.material]) mm.dispose();
			}
			grids.length = 0;
		}
	};
}

/** a GPU error that means "this graphics path cannot draw the view" (compile / pipeline creation) @param {string} msg */
function fatalGpuError(msg) {
	return /compile|E_FAIL|createRenderPipeline|RenderPipeline|ShaderModule|WGSL|Invalid (Shader|RenderPipeline)/i.test(msg);
}

/** @param {string} reason a short plain sentence */
async function fail(reason) {
	if (live?.failing) return;
	if (live) live.failing = true;
	log.errors.push({ at: Math.round(now()), fatal: reason });
	disableCinematic(reason);
	app?.toast('Cinematic view is off: ' + reason + ' Back to the standard view.');
	// directly, not queued behind a switch in progress (that switch is what failed)
	await teardown('failed');
}

/**
 * turn the view on (resolves with the timing record, or null when it could not)
 * @param {ViewCtx} ctx @returns {Promise<any>}
 */
export function enterCinematic(ctx) {
	app = ctx;
	if (busy) return busy.then(() => (live ? true : enterCinematic(ctx)));
	if (live) return Promise.resolve(true);
	busy = enter().finally(() => (busy = null));
	return busy;
}

async function enter() {
	const gl = app?.gl;
	const scene = app?.scene;
	const cam = app?.camera();
	if (!gl || !scene || !cam) return null;
	if (gl.xr?.isPresenting) return null;
	const t = { start: now(), imported: 0, released: 0, init: 0, compiled: 0, firstFrame: 0 };
	patchState({ mode: 'entering', error: '', dropped: 0 });
	let W;
	let T;
	try {
		[W, T] = await Promise.all([import('three/webgpu'), import('three/tsl')]);
	} catch (e) {
		patchState({ mode: 'off', error: 'Could not load the Cinematic view.' });
		return null;
	}
	t.imported = now();
	// 1. what lives only on the WebGL context, copied out while it is alive
	const env = captureEnvironment(gl, scene);
	// 2. the WebGL renderer's GPU state goes (one renderer in memory at a time), and with it its generation's
	//    dispose listeners on every live object (render/generations.js: the ~3 MB-per-trip leak)
	const glDied = glGenerationEnding(gl, scene);
	await releaseMainContext(gl);
	glDied();
	t.released = now();
	// 3. a canvas of its own over the WebGL one
	const glCanvas = gl.domElement;
	const canvas = document.createElement('canvas');
	canvas.id = 'cinematic-canvas';
	canvas.setAttribute('aria-hidden', 'true');
	canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block';
	glCanvas.parentElement.appendChild(canvas);
	glCanvas.style.opacity = '0';
	const gpuEra = gpuGenerationStarting();
	/** @type {any} */
	const r = new W.WebGPURenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
	live = { W, T, r, gpuEra, gl, scene, canvas, glCanvas, env, built: null, swap: null, ro: null, errors: [], frames: 0, last: 0, drop: createDropWatch(), drops: 0, rebuilding: false, failing: false, camera: cam, t };
	r.onDeviceLost = (/** @type {any} */ info) => {
		log.errors.push({ at: Math.round(now()), lost: String(info?.message ?? info?.reason ?? '') });
		void fail('the graphics device was lost.');
	};
	try {
		await r.init();
	} catch (e) {
		await fail('WebGPU did not start on this graphics card.');
		return null;
	}
	t.init = now();
	if (!live) return null;
	r.backend?.device?.addEventListener?.('uncapturederror', (/** @type {any} */ ev) => {
		const msg = String(ev?.error?.message ?? ev).slice(0, 600);
		if (log.errors.length < 200) log.errors.push({ at: Math.round(now()), msg });
		if (fatalGpuError(msg)) void fail('its lighting does not compile on this graphics path.');
	});
	syncRenderer();
	const rect = glCanvas.getBoundingClientRect();
	r.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
	live.ro = new ResizeObserver(() => {
		const b = glCanvas.getBoundingClientRect();
		if (b.width > 0 && b.height > 0 && live) {
			live.r.setSize(b.width, b.height, false);
			// a window that grew past 1440p loses High (its GI costs 39 ms at 4K)
			const q = targetQuality();
			if (live.built && q !== live.built.quality) void rebuild();
		}
	});
	live.ro.observe(glCanvas);
	// W17: PCFSoftShadowMap is gone from the WebGPU renderer (r186): PCF, as the WebGL view asks for too
	r.shadowMap.enabled = gl.shadowMap.enabled;
	r.shadowMap.type = THREE.PCFShadowMap;
	useCopies(scene, env);
	live.swap = createSwapper(W, scene);
	live.swap.scan();
	patchState({ notShown: notShownText(live.swap.kinds) });
	try {
		live.built = await build(targetQuality());
		await compileAsync(r, scene, cam);
	} catch (e) {
		log.errors.push({ at: Math.round(now()), msg: String(/** @type {any} */ (e)?.message ?? e).slice(0, 300) });
		await fail('its lighting does not compile on this graphics path.');
		return null;
	}
	if (!live) return null;
	t.compiled = now();
	// 4. threlte's render task hands its frames to this renderer
	const first = new Promise((resolve) => (live.onFirst = resolve));
	setViewOwner({ draw, canvas });
	await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 15000))]);
	if (!live || live.failing) return null;
	await r.backend?.device?.queue?.onSubmittedWorkDone?.();
	t.firstFrame = now();
	patchState({ mode: 'on', quality: live.built.quality });
	const rec = {
		dir: 'on',
		ms: { import: t.imported - t.start, release: t.released - t.imported, init: t.init - t.released, compile: t.compiled - t.init, firstFrame: t.firstFrame - t.compiled, total: t.firstFrame - t.start },
		env: env.kind,
		standIns: live.swap.swapped,
		quality: live.built.quality
	};
	log.switches.push(rec);
	return rec;
}

/** the step this window runs: the asked one, capped by its size, lowered by the drop */
function targetQuality() {
	if (!live) return 'basic';
	return effectiveQuality(get(cinematicPrefs).quality, drawnPixels(live.r, live.glCanvas), live.drops);
}

/** @param {import('./cinematicCore.js').Quality} quality */
function build(quality) {
	return buildPipeline({ W: live.W, T: live.T, renderer: live.r, scene: live.scene, camera: live.camera, quality, outline: viewSelection });
}

/** a new pipeline beside the old one (the old keeps drawing until the new one is ready) */
async function rebuild() {
	if (!live || live.rebuilding) return;
	live.rebuilding = true;
	try {
		const q = targetQuality();
		const next = await build(q);
		if (!live) return next.dispose();
		const old = live.built;
		live.built = next;
		old?.dispose();
		live.drop.reset();
		patchState({ quality: q, dropped: live.drops });
	} catch (e) {
		void fail('its lighting does not compile on this graphics path.');
	} finally {
		if (live) live.rebuilding = false;
	}
}

/** the renderer follows the WebGL one's look settings and pixel ratio (they move while the view is on) */
function syncRenderer() {
	const { r, gl } = live;
	if (r.getPixelRatio() !== gl.getPixelRatio()) r.setPixelRatio(gl.getPixelRatio());
	r.toneMapping = gl.toneMapping;
	r.toneMappingExposure = gl.toneMappingExposure;
	r.outputColorSpace = gl.outputColorSpace;
}

/** one frame, from threlte's render task @param {number} _delta */
function draw(_delta) {
	const g = live;
	if (!g?.built || g.failing) return;
	const c = app?.camera() || g.camera;
	if (c !== g.camera) {
		g.camera = c;
		void rebuild();
	}
	syncRenderer();
	const a = now();
	try {
		g.built.render();
	} catch (e) {
		if (log.errors.length < 200) log.errors.push({ at: Math.round(a), render: String(/** @type {any} */ (e)?.message ?? e).slice(0, 300) });
	}
	if (g.last) {
		const ms = a - g.last;
		log.frames.push(ms);
		if (log.frames.length > 6000) log.frames.splice(0, 3000);
		if (g.drop.feed(ms, a) && g.built.quality !== 'basic' && !g.rebuilding) {
			g.drops++;
			void rebuild();
		}
	}
	g.last = a;
	if (!g.frames++) g.onFirst?.();
	// about once a second: stand-ins for what arrived since (BEFORE it draws as an opaque fallback next frame)
	if (g.frames % 60 === 0) rescan(g);
}

/** @param {any} g */
function rescan(g) {
	const before = notShownText(g.swap.kinds);
	g.swap.scan();
	const after = notShownText(g.swap.kinds);
	if (after !== before) patchState({ notShown: after });
}

/** turn the view off (the standard view draws again) @param {{ reason?: string }} [o] */
export function leaveCinematic(o = {}) {
	const p = (busy ?? Promise.resolve()).then(() => teardown(o.reason ?? null));
	busy = p.finally(() => (busy = null));
	return p;
}

/** @param {string | null} reason */
async function teardown(reason) {
	const g = live;
	if (!g) {
		patchState({ mode: 'off' });
		return null;
	}
	live = null;
	const t0 = now();
	patchState({ mode: 'leaving' });
	setViewOwner(null);
	g.onFirst?.();
	g.ro?.disconnect();
	g.built?.dispose();
	g.swap?.undo();
	try {
		g.r.dispose();
	} catch (e) {
		log.errors.push({ at: Math.round(now()), msg: 'dispose: ' + String(e).slice(0, 200) });
	}
	gpuGenerationEnded(g.gpuEra);
	g.canvas.remove();
	const t1 = now();
	glGenerationStarting();
	const restored = await restoreMainContext(g.gl);
	restoreEnvironment(g.gl, g.scene, g.env);
	g.glCanvas.style.opacity = '';
	const held = flushHeldDisposals();
	patchState({ mode: 'off', notShown: '', dropped: 0 });
	const rec = { dir: 'off', reason, restored, held, ms: { dispose: t1 - t0, restore: now() - t1, total: now() - t0 } };
	log.switches.push(rec);
	return rec;
}

/** the quality step changed in the menu */
export function requalify() {
	if (!live) return;
	live.drops = 0;
	void rebuild();
}

/**
 * The view's frame as pixels, for Photo mode: drawn at `width` x `height` through the same pipeline
 * (same resolution rules as the view: High is not drawn above 1440p-equivalent), then read back.
 * @param {{ width: number, height: number }} plan @returns {Promise<Blob | null>}
 */
export async function viewStill(plan) {
	const g = live;
	if (!g?.built) return null;
	const { r, glCanvas } = g;
	const pr = r.getPixelRatio();
	const b = glCanvas.getBoundingClientRect();
	// the view's resolution rules: no full-resolution GI above 1440p-equivalent
	const capped = effectiveQuality(g.built.quality, plan.width * plan.height, 0);
	const built = capped === g.built.quality ? g.built : await build(capped);
	try {
		// the still's size: the canvas resized for one frame (the next resize puts it back)
		r.setPixelRatio(1);
		r.setSize(plan.width, plan.height, false);
		g.camera.aspect !== undefined && ((g.camera.aspect = plan.width / plan.height), g.camera.updateProjectionMatrix());
		// TRAA accumulates: a few frames settle the image
		for (let i = 0; i < 8; i++) built.render();
		await r.backend?.device?.queue?.onSubmittedWorkDone?.();
		built.render();
		const blob = await new Promise((resolve) => g.canvas.toBlob(resolve, 'image/png'));
		return /** @type {Blob | null} */ (blob);
	} finally {
		if (built !== g.built) built.dispose();
		r.setPixelRatio(pr);
		r.setSize(b.width, b.height, false);
		if (g.camera.aspect !== undefined) {
			g.camera.aspect = b.width / Math.max(1, b.height);
			g.camera.updateProjectionMatrix();
		}
	}
}

/** is the view drawing right now */
export function cinematicOn() {
	return !!live?.built && !live.failing;
}

/** e2e / debug: what the view is doing and what it cost (the debug hook: `__stores.cinematicState.cinematicView()`) */
export function cinematicDebug(reset = false) {
	const f = log.frames.filter((x) => x < 1000);
	const out = {
		on: cinematicOn(),
		quality: live?.built?.quality ?? null,
		drops: live?.drops ?? 0,
		frames: { n: f.length, median: quantile(f, 0.5), p95: quantile(f, 0.95) },
		switches: log.switches.slice(-40),
		errors: log.errors.slice(-60),
		memory: live ? { ...live.r.info.memory } : null,
		generations: generationStats(),
		adapter: live?.r?.backend?.adapter?.info ? { vendor: live.r.backend.adapter.info.vendor, architecture: live.r.backend.adapter.info.architecture, description: live.r.backend.adapter.info.description } : null,
		state: get(cinematicState)
	};
	if (reset) log.frames = [];
	return out;
}

/** e2e: the view's canvas as a PNG data URL (the next frame) */
export async function grabCinematic() {
	if (!live?.built) return null;
	await nextFrame();
	// a WebGPU canvas reads blank once its frame was presented: draw and read in the same task
	live.built.render();
	return live.canvas.toDataURL('image/png');
}

/** e2e: a lost device, simulated (three r186 ignores a loss whose reason is 'destroyed', so the handler runs by hand) */
export async function loseDeviceForTest() {
	const g = live;
	if (!g) return { error: 'not on' };
	g.r.backend?.device?.destroy?.();
	g.r.onDeviceLost?.({ api: 'WebGPU', message: 'simulated', reason: 'unknown' });
	for (let i = 0; i < 600 && (live || busy); i++) await nextFrame();
	return { state: get(cinematicState) };
}

/** e2e: a compile failure, simulated (what D3D11 / FXC reports) */
export async function failCompileForTest() {
	if (!live) return { error: 'not on' };
	await fail('its lighting does not compile on this graphics path.');
	return { state: get(cinematicState) };
}

/** e2e / debug: the live view's parts (renderer, pipeline, scene, camera) for bisecting a wrong image */
export function cinematicLiveForTest() {
	return live;
}
