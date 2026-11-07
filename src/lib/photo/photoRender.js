// Roadmap 98 P2 (lane 98-photo) — PHOTO MODE, the GPU half: a path-traced still of a view, progressive,
// into an OFFSCREEN target, while the editor keeps drawing. A LAZY CHUNK: three-gpu-pathtracer (~MIT,
// gkjohnson) is imported only here and only on the first photo, so it is never in the editor's first load
// or /play (boot-size gate in tests/e2e/photo-mode.test.cjs).
//
// The promises, and how each is kept:
//   · NO PERSON'S VIEW MOVES: the tracer gets a CLONE of the camera (or a camera built from a peer's pose)
//     and renders to its own float target (`renderToCanvas = false`); the renderer's target, viewport,
//     scissor and autoClear are put back after every sample.
//   · A CLEAN FRAME: the agent screenshot's helper hiding (gizmo, grid, edit wireframes, people) runs while
//     the tracer READS the scene (setScene is synchronous here, so the hide/restore brackets it exactly);
//     what the tracer cannot draw (photoCore.meshKind) is hidden for that read too and counted for the
//     parity note; non-standard materials get a standard twin for the read, then the originals go back.
//   · THE SKY LIGHTS IT: today's presets light with a hemisphere light the tracer ignores, so a scene with no
//     environment map gets a gradient environment from the hemi's sky / ground colours (and a colour
//     background when the sky is the clear colour) — for the read only.
//   · STOP ANY TIME: `signal` (AbortSignal) ends the loop at the next frame and the still so far is kept.
//
// TSL-portable (roadmap 2.0 S1): no GLSL of ours. The WebGL tracer is the package's; its WebGPU twin is
// `three-gpu-pathtracer/webgpu` (WebGPUPathTracer, same setScene / renderSample / samples API) — S2 swaps the
// import in `loadTracer` and keeps everything else in this file.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalScene, globalCamera, backgroundColor } from '../../stores/sceneStore';
import { isEditorHelper } from '$lib/water/waterRuntime.js';
import { linearFrameToSrgb } from '$lib/agent/screenshotCore.js';
import { hideHelpers } from '$lib/agent/screenshot.js';
import { photoDone, meshKind, materialKind, translateParams, parityNotes, INSTANCE_PROXY_CAP } from './photoCore.js';

/** @type {Promise<any> | null} */
let tracerModule = null;
/** the path tracer chunk, once @returns {Promise<any>} */
export function loadTracer() {
	tracerModule ??= import('three-gpu-pathtracer').catch((e) => {
		tracerModule = null;
		throw e;
	});
	return tracerModule;
}

/** WebGL2 with float colour buffers — what the tracer's accumulation target needs @param {any} renderer */
export function canTraceHere(renderer) {
	try {
		const gl = renderer?.getContext?.();
		if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return false;
		return !!(renderer.extensions?.has?.('EXT_color_buffer_float') ?? gl.getExtension('EXT_color_buffer_float'));
	} catch {
		return false;
	}
}

/** @param {any} renderer */
function toneMappingName(renderer) {
	const tm = renderer?.toneMapping;
	if (tm === THREE.NoToneMapping || tm == null) return 'none';
	if (tm === THREE.LinearToneMapping) return 'linear';
	return 'aces';
}

/** @param {any} renderer */
function saveState(renderer) {
	return {
		target: renderer.getRenderTarget(),
		viewport: renderer.getViewport(new THREE.Vector4()),
		scissor: renderer.getScissor(new THREE.Vector4()),
		scissorTest: renderer.getScissorTest(),
		autoClear: renderer.autoClear,
		clear: renderer.getClearColor(new THREE.Color()),
		clearAlpha: renderer.getClearAlpha()
	};
}
/** @param {any} renderer @param {any} s */
function restoreState(renderer, s) {
	renderer.setRenderTarget(s.target);
	renderer.setViewport(s.viewport);
	renderer.setScissor(s.scissor);
	renderer.setScissorTest(s.scissorTest);
	renderer.autoClear = s.autoClear;
	renderer.setClearColor(s.clear, s.clearAlpha);
}

/**
 * The camera the photo sees: a clone of the person's (never the live one), or a peer's pose.
 * @param {any} live @param {{width: number, height: number}} plan
 * @param {{pos: number[], quat: number[], fov: number, near?: number, far?: number} | null} [pose]
 */
export function photoCamera(live, plan, pose) {
	const aspect = plan.width / plan.height;
	/** @type {any} */
	let cam;
	if (pose) {
		cam = new THREE.PerspectiveCamera(pose.fov, aspect, pose.near ?? 0.05, pose.far ?? 2000);
		cam.position.fromArray(pose.pos);
		cam.quaternion.fromArray(pose.quat);
	} else if (live?.isOrthographicCamera) {
		cam = live.clone();
	} else {
		cam = new THREE.PerspectiveCamera(live?.fov ?? 50, aspect, live?.near ?? 0.05, live?.far ?? 2000);
		live?.updateMatrixWorld?.();
		live?.matrixWorld?.decompose(cam.position, cam.quaternion, new THREE.Vector3());
		cam.zoom = live?.zoom ?? 1;
	}
	if (cam.isPerspectiveCamera) cam.aspect = aspect;
	cam.updateProjectionMatrix();
	cam.updateMatrixWorld(true);
	return cam;
}

/** the pose a peer needs to render this view @param {any} live */
export function poseOf(live) {
	live.updateMatrixWorld();
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	live.matrixWorld.decompose(pos, quat, new THREE.Vector3());
	return { pos: pos.toArray(), quat: quat.toArray(), fov: live.isPerspectiveCamera ? live.fov : 50, near: live.near, far: live.far };
}

/**
 * Prepare the scene for the tracer's one synchronous read; returns the undo.
 * @param {any} scene @param {any} renderer @param {any} pkg the tracer module
 */
function prepareScene(scene, renderer, pkg) {
	/** @type {Record<string, number>} */
	const met = {};
	const bump = (/** @type {string} */ k, n = 1) => (met[k] = (met[k] ?? 0) + n);
	const unhide = hideHelpers(scene, renderer, false, { people: true });
	/** @type {any[]} */
	const hidden = [];
	/** @type {{mesh: any, material: any}[]} */
	const swapped = [];
	/** @type {any[]} */
	const twins = [];
	const proxies = new THREE.Group();
	proxies.name = 'photo-instance-proxies';
	scene.traverseVisible((/** @type {any} */ o) => {
		const kind = meshKind(o, { helper: isEditorHelper });
		if (kind.startsWith('skip')) {
			if (kind !== 'skip-helper') bump(kind);
			hidden.push(o);
			return;
		}
		if (kind === 'instances') {
			const n = Math.min(o.count ?? 0, INSTANCE_PROXY_CAP);
			if ((o.count ?? 0) > n) bump('instances-cut', o.count - n);
			o.updateMatrixWorld(true);
			const m = new THREE.Matrix4();
			for (let i = 0; i < n; i++) {
				o.getMatrixAt(i, m);
				const p = new THREE.Mesh(o.geometry, o.material);
				p.matrixAutoUpdate = false;
				p.matrix.multiplyMatrices(o.matrixWorld, m);
				proxies.add(p);
			}
			hidden.push(o);
			return;
		}
		if (kind !== 'trace') return;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		let changed = false;
		const next = mats.map((/** @type {any} */ m) => {
			const k = materialKind(m);
			if (k === 'graph-base') bump('graph-base');
			if (k !== 'translate') return m;
			bump('translate');
			changed = true;
			const twin = new THREE.MeshStandardMaterial(translateParams(m));
			twins.push(twin);
			return twin;
		});
		if (changed) {
			swapped.push({ mesh: o, material: o.material });
			o.material = Array.isArray(o.material) ? next : next[0];
		}
	});
	// the traverse is over: hide what the tracer must not read (hiding inside traverseVisible would prune it)
	for (const o of hidden) o.visible = false;
	if (proxies.children.length) scene.add(proxies);

	// the sky: an environment from the hemisphere light when the scene has none, a colour background when the
	// sky is the renderer's clear colour (scene.background null reads as transparent to the tracer)
	const was = { environment: scene.environment, background: scene.background, envIntensity: scene.environmentIntensity };
	/** @type {any} */
	let gradient = null;
	if (!scene.environment) {
		/** @type {any} */
		let hemi = null;
		scene.traverseVisible((/** @type {any} */ o) => {
			if (!hemi && o.isHemisphereLight) hemi = o;
		});
		if (hemi && pkg.GradientEquirectTexture) {
			gradient = new pkg.GradientEquirectTexture();
			gradient.topColor.copy(hemi.color);
			gradient.bottomColor.copy(hemi.groundColor);
			gradient.update();
			scene.environment = gradient;
			scene.environmentIntensity = hemi.intensity ?? 1;
			bump('hemi');
		}
	}
	if (!scene.background) scene.background = new THREE.Color(get(backgroundColor) || '#363b43');

	return {
		met,
		undo() {
			for (const o of hidden) o.visible = true;
			if (proxies.parent) proxies.parent.remove(proxies);
			for (const s of swapped) s.mesh.material = s.material;
			for (const t of twins) t.dispose();
			scene.environment = was.environment;
			scene.background = was.background;
			if (was.envIntensity !== undefined) scene.environmentIntensity = was.envIntensity;
			unhide();
		},
		dispose() {
			gradient?.dispose?.();
		}
	};
}

/** next animation frame (or a short timeout where rAF does not run, e.g. a hidden tab) */
function nextFrame() {
	return new Promise((res) => {
		let done = false;
		const go = () => {
			if (done) return;
			done = true;
			res(undefined);
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
		setTimeout(go, 100);
	});
}

/**
 * Render a path-traced still.
 * @param {{samples: number, seconds: number, width: number, height: number, denoise: boolean}} plan
 * @param {{
 *   pose?: {pos: number[], quat: number[], fov: number, near?: number, far?: number} | null,
 *   signal?: AbortSignal,
 *   onProgress?: (p: {samples: number, elapsedMs: number, fraction: number, compiling: boolean}) => void,
 *   preview?: HTMLCanvasElement | null   // drawn with the still so far every few samples
 * }} [opts]
 * @returns {Promise<{blob: Blob, samples: number, ms: number, reason: string, notes: {kind: string, count: number, note: string}[], width: number, height: number}>}
 */
export async function renderPhoto(plan, opts = {}) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	/** @type {any} */
	const scene = get(globalScene);
	const live = get(globalCamera);
	if (!renderer || !scene) throw new Error('No 3D view yet.');
	if (renderer.xr?.isPresenting) throw new Error('Not in a headset session.');
	if (!canTraceHere(renderer)) throw new Error("This device's graphics cannot path-trace.");
	const pkg = await loadTracer();
	const camera = photoCamera(live, plan, opts.pose ?? null);
	const started = performance.now();
	const tracer = new pkg.WebGLPathTracer(renderer);
	tracer.renderToCanvas = false;
	tracer.rasterizeScene = false;
	tracer.synchronizeRenderSize = false;
	tracer.dynamicLowRes = false;
	tracer.renderDelay = 0;
	tracer.minSamples = 0;
	tracer.fadeDuration = 0;
	tracer.multipleImportanceSampling = true;
	tracer.bounces = 6;
	tracer.transmissiveBounces = 10;
	// the private sizes: synchronizeRenderSize off means nobody else sets them (pinned at 0.0.27)
	tracer._pathTracer.setSize(plan.width, plan.height);
	tracer._lowResPathTracer?.setSize?.(Math.max(1, Math.floor(plan.width / 4)), Math.max(1, Math.floor(plan.height / 4)));
	// a big still: more tiles keep each frame's share of the GPU small, so the editor stays responsive
	const big = plan.width * plan.height > 1.5e6;
	tracer.tiles.set(big ? 4 : 2, big ? 4 : 2);

	const saved = saveState(renderer);
	const prep = prepareScene(scene, renderer, pkg);
	try {
		tracer.setScene(scene, camera);
	} finally {
		prep.undo();
		restoreState(renderer, saved);
	}

	/** @type {''|'samples'|'time'|'stopped'} */
	let reason = '';
	let lastPreview = 0;
	try {
		for (;;) {
			const elapsedMs = performance.now() - started;
			reason = photoDone({ samples: Math.floor(tracer.samples), elapsedMs, stopped: !!opts.signal?.aborted }, plan);
			if (reason) break;
			const s = saveState(renderer);
			try {
				tracer.renderSample();
			} finally {
				restoreState(renderer, s);
			}
			opts.onProgress?.({ samples: Math.floor(tracer.samples), elapsedMs, fraction: Math.min(1, Math.max(tracer.samples / plan.samples, elapsedMs / (plan.seconds * 1000))), compiling: !!tracer.isCompiling });
			if (opts.preview && tracer.samples >= 1 && tracer.samples - lastPreview >= Math.max(1, Math.floor(plan.samples / 16))) {
				lastPreview = tracer.samples;
				await drawTo(opts.preview, renderer, tracer.target, plan, false, pkg).catch(() => {});
			}
			await nextFrame();
		}
		if (tracer.samples < 1) throw new Error(reason === 'stopped' ? 'Stopped before the first sample.' : 'The renderer did not start in time.');
		const pixels = await readFinal(renderer, tracer.target, plan, plan.denoise, pkg);
		const blob = await toPng(pixels, plan.width, plan.height);
		return { blob, samples: Math.floor(tracer.samples), ms: Math.round(performance.now() - started), reason, notes: parityNotes(prep.met), width: plan.width, height: plan.height };
	} finally {
		tracer.dispose();
		prep.dispose();
		restoreState(renderer, saved);
	}
}

/**
 * The accumulated (optionally denoised) frame as top-down sRGB bytes, tone-mapped like the canvas.
 * @param {any} renderer @param {any} source the tracer's float target @param {{width: number, height: number}} plan
 * @param {boolean} denoise @param {any} pkg
 */
async function readFinal(renderer, source, plan, denoise, pkg) {
	const { FullScreenQuad } = await import('three/examples/jsm/postprocessing/Pass.js');
	const w = plan.width;
	const h = plan.height;
	const out = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: false });
	const material = denoise && pkg.DenoiseMaterial
		? new pkg.DenoiseMaterial({ map: source.texture, blending: THREE.NoBlending, premultipliedAlpha: false })
		: new THREE.MeshBasicMaterial({ map: source.texture, blending: THREE.NoBlending, toneMapped: false });
	if (material.isMeshBasicMaterial) material.map.colorSpace = THREE.LinearSRGBColorSpace;
	const quad = new FullScreenQuad(material);
	const s = saveState(renderer);
	const toneMapping = renderer.toneMapping;
	try {
		renderer.toneMapping = THREE.NoToneMapping;
		renderer.setRenderTarget(out);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		quad.render(renderer);
	} finally {
		renderer.toneMapping = toneMapping;
		restoreState(renderer, s);
	}
	const buf = new Float32Array(w * h * 4);
	if (renderer.readRenderTargetPixelsAsync) await renderer.readRenderTargetPixelsAsync(out, 0, 0, w, h, buf);
	else renderer.readRenderTargetPixels(out, 0, 0, w, h, buf);
	quad.dispose();
	material.dispose();
	out.dispose();
	return linearFrameToSrgb(buf, w, h, { toneMapping: toneMappingName(renderer), exposure: renderer.toneMappingExposure ?? 1 });
}

/** the progress preview: a small copy of the frame so far into a 2D canvas */
async function drawTo(/** @type {HTMLCanvasElement} */ canvas, /** @type {any} */ renderer, /** @type {any} */ source, /** @type {any} */ plan, /** @type {boolean} */ denoise, /** @type {any} */ pkg) {
	const scale = Math.min(1, 480 / Math.max(plan.width, plan.height));
	const small = { width: Math.max(1, Math.round(plan.width * scale)), height: Math.max(1, Math.round(plan.height * scale)) };
	// read at full size is wasteful for a preview: render the copy at the small size instead
	const px = await readFinal(renderer, source, small, denoise, pkg);
	canvas.width = small.width;
	canvas.height = small.height;
	canvas.getContext('2d')?.putImageData(new ImageData(/** @type {any} */ (px), small.width, small.height), 0, 0);
}

/** @param {Uint8ClampedArray} px @param {number} w @param {number} h @returns {Promise<Blob>} */
async function toPng(px, w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('No 2D canvas.');
	ctx.putImageData(new ImageData(/** @type {any} */ (px), w, h), 0, 0);
	const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
	if (!blob) throw new Error('Could not encode the PNG.');
	return /** @type {Blob} */ (blob);
}

/**
 * The best RASTER still of this view (the fallback where path tracing is not possible): the agent
 * screenshot's clean frame through the post stack, at up to 2048 px.
 * @param {{width: number, height: number}} plan @returns {Promise<Blob|null>}
 */
export async function rasterPhoto(plan) {
	const { takeScreenshot } = await import('$lib/agent/screenshot.js');
	const url = await takeScreenshot(/** @type {any} */ ({ view: 'current', aspect: plan.width / plan.height, size: Math.min(2048, Math.max(plan.width, plan.height)), postEffects: true, avatars: false, quiet: true }));
	if (!url) return null;
	return await (await fetch(url)).blob();
}
