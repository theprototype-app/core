// 34 PF — THE DETAILED PROBE: where a frame's time and draw calls go. It COSTS frame time
// (that is why it is on demand and short: a detailed recording stops itself after
// DETAILED_MS), and it is everything the light ring cannot say:
//
//   1. CPU PHASES per frame — input, flow, modules, physics (perfMarks phase timers inside
//      flowRuntime.runTick), render (renderer.render wrapped here, every pass of the
//      frame), other (the span from the first phase to the end of the last render, minus
//      the five; it is threlte's own tasks, LOD, helpers — work between the two loops).
//   2. PER-OBJECT DRAW ATTRIBUTION (`capture`) — onBeforeRender/onAfterRender on every
//      drawable for a few frames: three calls them once per DRAW (a multi-material mesh
//      once per group), so the count IS the draw calls, the geometry/group handed in IS what
//      was drawn (after any LOD swap), and the gap to onAfterRender is that object's CPU
//      submission time. Shadow-map passes are counted through onBeforeShadow (three r16x+),
//      as their own rows (`shadow: true`). Hooks are installed for the capture only and put
//      back exactly (an own property restored, an inherited one deleted).
//   3. MEMORY per capture — JS heap where the browser says it, geometries, textures, programs.
//   4. GPU ms — ONLY with EXT_disjoint_timer_query_webgl2 (likely absent on the Quest's
//      browser; counts and CPU ms are always reliable — roadmap 34 decision 4). Results are
//      asynchronous: a frame's GPU time is written on the frame where it became available.
import { get } from 'svelte/store';
import { globalRenderer, globalScene, objectsGroup } from '../../stores/sceneStore';
import { perfPhases, PHASE_RENDER, PHASE_OTHER } from './perfMarks.js';
import { registerDetailedProbe } from './recorder.js';
import { CPU_PHASES } from './tpprof.js';

/** a detailed recording's default length; it stops itself there */
export const DETAILED_MS = 10000;
/** how often a detailed recording takes a capture */
export const CAPTURE_EVERY_MS = 1000;
/** frames per capture (the numbers are per-frame means over them) */
export const CAPTURE_FRAMES = 3;

const now = () => performance.now();

// ---------------------------------------------------------------- render wrap + GPU timer

/** @type {any} */
let wrapped = null;
/** @type {Function | null} */
let innerRender = null;
/** @type {any} */
let gl = null;
/** @type {any} */
let timerExt = null;
/** in-flight GPU queries, oldest first @type {any[]} */
let pending = [];
/** GPU ms that became available since the last drain */
let gpuReady = 0;
let gpuAny = false;
/** a query is open inside the current render() call */
let queryOpen = false;

function wrapRender() {
	const r = /** @type {any} */ (get(globalRenderer));
	if (!r || r.__perfDetailed) return;
	wrapped = r;
	innerRender = r.render;
	r.__perfDetailed = true;
	try {
		gl = r.getContext();
		timerExt = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
	} catch {
		timerExt = null;
	}
	const inner = innerRender;
	r.render = function (/** @type {any[]} */ ...args) {
		const t0 = now();
		if (!perfPhases.first) perfPhases.first = t0;
		/** @type {any} */
		let q = null;
		if (timerExt && !queryOpen) {
			try {
				q = gl.createQuery();
				gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
				queryOpen = true;
			} catch {
				q = null;
			}
		}
		try {
			return /** @type {Function} */ (inner).apply(this, args);
		} finally {
			if (q) {
				try {
					gl.endQuery(timerExt.TIME_ELAPSED_EXT);
					pending.push(q);
				} catch {
					/* a lost context: drop the query */
				}
				queryOpen = false;
			}
			const t1 = now();
			perfPhases.acc[PHASE_RENDER] += t1 - t0;
			perfPhases.last = t1;
		}
	};
}

function unwrapRender() {
	const r = wrapped;
	wrapped = null;
	if (!r) return;
	delete r.__perfDetailed;
	if (innerRender) r.render = innerRender;
	innerRender = null;
	for (const q of pending) {
		try {
			gl.deleteQuery(q);
		} catch {
			/* gone */
		}
	}
	pending = [];
}

/** collect finished GPU queries (they complete a few frames late) */
function pollGpu() {
	if (!timerExt || !pending.length) return;
	const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
	while (pending.length) {
		const q = pending[0];
		if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
		pending.shift();
		if (!disjoint) {
			gpuReady += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
			gpuAny = true;
		}
		gl.deleteQuery(q);
	}
	// a stuck query must not grow without bound
	if (pending.length > 64) pending.splice(0, pending.length - 64).forEach((q) => gl.deleteQuery(q));
}

// ---------------------------------------------------------------- per-frame drain

const cpuOut = new Float32Array(CPU_PHASES.length);

/** the frame's CPU phases (ms), then reset — the recorder calls it once per frame */
function frameCpu() {
	const acc = perfPhases.acc;
	let known = 0;
	for (let i = 0; i < PHASE_OTHER; i++) {
		cpuOut[i] = acc[i];
		known += acc[i];
	}
	const span = perfPhases.first && perfPhases.last > perfPhases.first ? perfPhases.last - perfPhases.first : 0;
	cpuOut[PHASE_OTHER] = Math.max(0, span - known);
	acc.fill(0);
	perfPhases.first = 0;
	perfPhases.last = 0;
	framesSeen++;
	return cpuOut;
}

function frameGpu() {
	pollGpu();
	if (!gpuAny) return null;
	const ms = gpuReady;
	gpuReady = 0;
	gpuAny = false;
	return ms;
}

// ---------------------------------------------------------------- per-object capture

let framesSeen = 0;

/** wait for `n` recorder frames (works in XR, where the window's rAF stops) @param {number} n */
function waitFrames(n) {
	const target = framesSeen + n;
	return new Promise((resolve) => {
		const started = now();
		const poll = () => {
			// the recorder drains frameCpu once per frame; a stalled stream gives up after 2 s
			if (framesSeen >= target || now() - started > 2000) resolve(framesSeen - (target - n));
			else setTimeout(poll, 8);
		};
		poll();
	});
}

/** @param {any} object @param {any} geometry @param {any} group */
function trianglesOf(object, geometry, group) {
	if (!geometry || !(object.isMesh || object.isSkinnedMesh || object.isInstancedMesh)) return 0;
	const index = geometry.index;
	const pos = geometry.attributes?.position;
	let count = index ? index.count : pos ? pos.count : 0;
	const range = geometry.drawRange;
	if (range) count = Math.min(count, Math.max(0, (range.count === Infinity ? count : range.count)));
	if (group) count = Math.min(count, group.count);
	const instances = object.isInstancedMesh ? object.count : geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1;
	return Math.floor(count / 3) * (Number.isFinite(instances) ? instances : 1);
}

/** @param {any} material */
function materialName(material) {
	if (!material) return '';
	const one = (/** @type {any} */ m) => m?.name || m?.type || '';
	return Array.isArray(material) ? material.map(one).join('+') : one(material);
}

/** scene path + owning module for an object @param {any} object @param {any} scene @param {any} objects */
function placeOf(object, scene, objects) {
	/** @type {string[]} */
	const names = [];
	/** @type {string | null} */
	let module = object.userData?.moduleId ?? null;
	let o = object;
	let inObjects = false;
	/** @type {any} */
	let top = null;
	while (o && o !== scene) {
		if (o === objects) {
			inObjects = true;
			break;
		}
		names.unshift(o.name || o.type);
		if (!module && o.userData?.moduleId) module = String(o.userData.moduleId);
		top = o;
		o = o.parent;
	}
	if (!inObjects && !module && top && top !== object) module = top.name || null;
	return { path: (inObjects ? 'Scene/' : '') + names.join('/'), module };
}

let capturing = false;

/**
 * Per-object draw attribution over `frames` frames.
 * @param {number} [frames]
 * @returns {Promise<import('./tpprof.js').TpCapture | null>}
 */
async function capture(frames = CAPTURE_FRAMES) {
	const scene = /** @type {any} */ (get(globalScene));
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!scene || capturing) return null;
	capturing = true;
	/** @type {Map<string, {object: any, shadow: boolean, calls: number, tris: number, ms: number, material: string, transparent: boolean}>} */
	const rows = new Map();
	/** @type {{object: any, key: string, had: boolean, prev: any}[]} */
	const installed = [];
	let start = 0;
	/** @param {any} object @param {boolean} shadow @param {any} geometry @param {any} material @param {any} group */
	const count = (object, shadow, geometry, material, group) => {
		const key = object.uuid + (shadow ? ':s' : '');
		let row = rows.get(key);
		if (!row) rows.set(key, (row = { object, shadow, calls: 0, tris: 0, ms: 0, material: materialName(material), transparent: !!material?.transparent }));
		row.calls++;
		row.tris += trianglesOf(object, geometry, group);
		return row;
	};
	/** @param {any} object @param {string} key @param {Function} fn */
	const hook = (object, key, fn) => {
		const had = Object.prototype.hasOwnProperty.call(object, key);
		const prev = object[key];
		installed.push({ object, key, had, prev });
		object[key] = fn;
	};
	scene.traverse((/** @type {any} */ o) => {
		if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
		const prevBefore = o.onBeforeRender;
		const prevAfter = o.onAfterRender;
		/** @type {any} */
		let current = null;
		hook(o, 'onBeforeRender', function (/** @type {any} */ r, /** @type {any} */ s, /** @type {any} */ c, /** @type {any} */ g, /** @type {any} */ m, /** @type {any} */ grp) {
			prevBefore.call(o, r, s, c, g, m, grp);
			current = count(o, false, g, m, grp);
			start = now();
		});
		hook(o, 'onAfterRender', function (/** @type {any} */ r, /** @type {any} */ s, /** @type {any} */ c, /** @type {any} */ g, /** @type {any} */ m, /** @type {any} */ grp) {
			if (current) current.ms += now() - start;
			current = null;
			prevAfter.call(o, r, s, c, g, m, grp);
		});
		if (typeof o.onBeforeShadow === 'function') {
			const prevShadow = o.onBeforeShadow;
			hook(o, 'onBeforeShadow', function (/** @type {any[]} */ ...args) {
				prevShadow.apply(o, args);
				// (renderer, object, camera, shadowCamera, geometry, depthMaterial, group)
				count(o, true, args[4], args[5], args[6]);
			});
		}
	});
	let measured = 0;
	try {
		measured = /** @type {number} */ (await waitFrames(frames));
	} finally {
		for (let i = installed.length - 1; i >= 0; i--) {
			const { object, key, had, prev } = installed[i];
			if (had) object[key] = prev;
			else delete object[key];
		}
		capturing = false;
	}
	const n = Math.max(1, measured);
	const objects = get(objectsGroup);
	const out = [...rows.values()]
		.map((row) => {
			const { path, module } = placeOf(row.object, scene, objects);
			return {
				uuid: row.object.uuid,
				name: row.object.name || row.object.type,
				path,
				module,
				calls: Math.round((row.calls / n) * 100) / 100,
				tris: Math.round(row.tris / n),
				material: row.material,
				shadow: row.shadow,
				...(row.transparent ? { transparent: true } : {}),
				...(row.shadow ? {} : { ms: Math.round((row.ms / n) * 1000) / 1000 })
			};
		})
		.sort((a, b) => b.calls - a.calls || b.tris - a.tris);
	/** @type {any} */
	const perf = typeof performance !== 'undefined' ? performance : null;
	return {
		t: 0,
		frames: n,
		objects: out,
		memory: {
			heap: perf?.memory?.usedJSHeapSize ?? null,
			geometries: renderer?.info?.memory?.geometries ?? null,
			textures: renderer?.info?.memory?.textures ?? null,
			programs: Array.isArray(renderer?.info?.programs) ? renderer.info.programs.length : null
		}
	};
}

// ---------------------------------------------------------------- the probe

function start() {
	perfPhases.acc.fill(0);
	perfPhases.first = 0;
	perfPhases.last = 0;
	perfPhases.on = true;
	wrapRender();
	gpuReady = 0;
	gpuAny = false;
	return { gpuTimer: !!timerExt };
}

function stop() {
	perfPhases.on = false;
	unwrapRender();
}

/** Install the probe (boot). */
export function startDetailedProbe() {
	registerDetailedProbe({ start, stop, frameCpu, frameGpu, capture });
}

/** For the suite. */
export function detailedDebug() {
	return { on: perfPhases.on, wrapped: !!wrapped, gpuTimer: !!timerExt, pending: pending.length, capturing };
}
