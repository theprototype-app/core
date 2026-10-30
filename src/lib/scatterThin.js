import { writable, get } from 'svelte/store';
import { globalCamera } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { defaults, targets } from '../../perf/budgets.json';
import { resolveTargets } from './budgetMeterCore';
import { thinPlan, fadeAt, scatterBudget, thinProfileOf, NEAR_KEEP } from './scatterThinCore';

// 51 — DEVICE THINNING, the runtime: every scatter InstancedMesh registers its full instance
// list here (terrainSurface.layoutScatter), and once per frame — throttled to a few re-plans a
// second, and only when the viewer moved — the planner (scatterThinCore) picks the distance past
// which this device stops drawing, and each mesh writes the instances it keeps (fading the edge)
// to the front of its buffer and lowers its `count`.
//
// LOCAL, all of it: what this device draws is a fact about this device. Nothing here is saved or
// sent, the layout is untouched, and a collider never reads it — scatterPhysicsSets builds every
// instance from the set itself, so a ball hits the same rock on a phone as on a desktop.
// `userData.instanceIds` is rewritten in DRAW order, so a pick maps `instanceId` to the right
// instance whatever was thinned.

const KEY = 'scatterDetail';
// declared ABOVE the subscribe below: it runs synchronously at module eval (the TDZ rule)
let dirty = true;
/** 'auto' (read the device) | 'quest' | 'phone' | 'desktop' | 'off' (draw everything). LOCAL. */
export const scatterDetail = writable(readChoice());
scatterDetail.subscribe((v) => {
	try {
		safeStorage.setItem(KEY, v);
	} catch {
		/* private mode: the pick lasts the session */
	}
	dirty = true;
});

function readChoice() {
	try {
		const v = safeStorage.getItem(KEY);
		return v && ['auto', 'quest', 'phone', 'desktop', 'off'].includes(v) ? v : 'auto';
	} catch {
		return 'auto';
	}
}

const TARGETS = resolveTargets({ defaults, targets });

/** @typedef {{base: Float32Array, colors: Float32Array | null, ids: string[], pos: Float32Array, tris: number, thinned: boolean}} ThinData */

/** every scatter mesh that can be thinned @type {Set<any>} */
const meshes = new Set();
let lastFrame = -1;
let lastPlanAt = 0;
const lastCam = { x: NaN, y: NaN, z: NaN };
/** @type {{profile: string | null, budget: number, cutoff: number, fadeStart: number, total: number, drawnTris: number, drawn: number, instances: number}} */
let last = { profile: null, budget: Infinity, cutoff: Infinity, fadeStart: Infinity, total: 0, drawnTris: 0, drawn: 0, instances: 0 };

const REPLAN_MS = 150;
const MOVE_M = 0.75;

/**
 * Register a freshly laid-out mesh: its full matrices, colours and ids are kept beside it, and the
 * per-frame hook drives the plan. @param {any} mesh @param {number} tris triangles per instance
 */
export function registerThinMesh(mesh, tris) {
	const n = mesh.count;
	const base = new Float32Array(mesh.instanceMatrix.array.subarray(0, n * 16));
	const pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		pos[i * 3] = base[i * 16 + 12];
		pos[i * 3 + 1] = base[i * 16 + 13];
		pos[i * 3 + 2] = base[i * 16 + 14];
	}
	/** @type {ThinData} */
	const data = {
		base,
		colors: mesh.instanceColor ? new Float32Array(mesh.instanceColor.array.subarray(0, n * 3)) : null,
		ids: [...(mesh.userData.instanceIds ?? [])],
		pos,
		tris,
		thinned: false
	};
	mesh.userData.thin = data;
	// the meter's content estimate counts every instance, not what this device draws
	mesh.userData.instanceTotal = n;
	mesh.onBeforeRender = (/** @type {any} */ renderer) => thinFrame(renderer);
	meshes.add(mesh);
	dirty = true;
}

/** @param {any} mesh */
export function unregisterThinMesh(mesh) {
	meshes.delete(mesh);
	dirty = true;
}

/** this device: in a headset? a touch-first screen? @param {any} renderer */
function deviceOf(renderer) {
	let coarse = false;
	try {
		coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
	} catch {
		/* no media queries */
	}
	return { xr: !!renderer?.xr?.isPresenting, coarse };
}

const _cam = { x: 0, y: 0, z: 0 };

/** the viewer's world position: the XR camera in a headset, else the main camera
 * @param {any} renderer @returns {boolean} */
function viewer(renderer) {
	const cam = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : /** @type {any} */ (get(globalCamera));
	const e = cam?.matrixWorld?.elements;
	if (!e) return false;
	_cam.x = e[12];
	_cam.y = e[13];
	_cam.z = e[14];
	return true;
}

/** Once per frame (the first scatter mesh drawn calls it; the shadow pass and the other meshes
 * of the frame find it done). @param {any} renderer */
export function thinFrame(renderer) {
	const frame = renderer?.info?.render?.frame ?? -1;
	if (frame === lastFrame) return;
	lastFrame = frame;
	const now = performance.now();
	if (!dirty && now - lastPlanAt < REPLAN_MS) return;
	if (!viewer(renderer)) return;
	const moved = Math.hypot(_cam.x - lastCam.x, _cam.y - lastCam.y, _cam.z - lastCam.z);
	if (!dirty && !(moved > MOVE_M)) return;
	lastPlanAt = now;
	lastCam.x = _cam.x;
	lastCam.y = _cam.y;
	lastCam.z = _cam.z;
	dirty = false;
	replan(thinProfileOf(get(scatterDetail), deviceOf(renderer)));
}

/** @type {Float32Array} */ let dists = new Float32Array(0);
/** @type {Float32Array} */ let tris = new Float32Array(0);

/** @param {string | null} profile */
function replan(profile) {
	const list = [...meshes].filter((m) => m.parent && m.userData.thin);
	let n = 0;
	for (const m of list) n += m.userData.thin.ids.length;
	if (dists.length < n) {
		dists = new Float32Array(n);
		tris = new Float32Array(n);
	}
	let k = 0;
	for (const m of list) {
		const t = /** @type {ThinData} */ (m.userData.thin);
		const w = m.parent.matrixWorld.elements;
		for (let i = 0; i < t.ids.length; i++) {
			const x = t.pos[i * 3], y = t.pos[i * 3 + 1], z = t.pos[i * 3 + 2];
			const wx = w[0] * x + w[4] * y + w[8] * z + w[12];
			const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
			const wz = w[2] * x + w[6] * y + w[10] * z + w[14];
			dists[k] = Math.hypot(wx - _cam.x, wy - _cam.y, wz - _cam.z);
			tris[k] = t.tris;
			k++;
		}
	}
	const target = profile ? /** @type {any} */ (TARGETS)[profile] : null;
	const budget = target ? scatterBudget(target.triangles) : Infinity;
	const plan = thinPlan(dists.subarray(0, n), tris.subarray(0, n), budget, NEAR_KEEP);
	let drawn = 0;
	k = 0;
	for (const m of list) {
		const t = /** @type {ThinData} */ (m.userData.thin);
		drawn += apply(m, t, plan, k);
		k += t.ids.length;
	}
	last = { profile, budget, cutoff: plan.cutoff, fadeStart: plan.fadeStart, total: plan.total, drawnTris: plan.drawnTris, drawn, instances: n };
}

/** Write the kept instances of one mesh (dists from `offset`). @param {any} mesh @param {ThinData} t
 * @param {{cutoff: number, fadeStart: number}} plan @param {number} offset @returns {number} drawn */
function apply(mesh, t, plan, offset) {
	const n = t.ids.length;
	if (plan.cutoff === Infinity) {
		if (!t.thinned) return n;
		mesh.instanceMatrix.array.set(t.base);
		if (t.colors && mesh.instanceColor) mesh.instanceColor.array.set(t.colors);
		mesh.count = n;
		mesh.userData.instanceIds = [...t.ids];
		mesh.instanceMatrix.needsUpdate = true;
		if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
		t.thinned = false;
		return n;
	}
	const out = mesh.instanceMatrix.array;
	const cols = t.colors && mesh.instanceColor ? mesh.instanceColor.array : null;
	/** @type {string[]} */
	const ids = [];
	let j = 0;
	for (let i = 0; i < n; i++) {
		const f = fadeAt(dists[offset + i], plan);
		if (f <= 0) continue;
		const b = i * 16;
		const o = j * 16;
		// scale the 3x3 part (about the instance's own origin, which stands on the ground)
		for (let c = 0; c < 12; c++) out[o + c] = c % 4 === 3 ? t.base[b + c] : t.base[b + c] * f;
		out[o + 12] = t.base[b + 12];
		out[o + 13] = t.base[b + 13];
		out[o + 14] = t.base[b + 14];
		out[o + 15] = t.base[b + 15];
		if (cols && t.colors) {
			cols[j * 3] = t.colors[i * 3];
			cols[j * 3 + 1] = t.colors[i * 3 + 1];
			cols[j * 3 + 2] = t.colors[i * 3 + 2];
		}
		ids.push(t.ids[i]);
		j++;
	}
	mesh.count = j;
	mesh.userData.instanceIds = ids;
	mesh.instanceMatrix.needsUpdate = true;
	if (cols) mesh.instanceColor.needsUpdate = true;
	t.thinned = true;
	return j;
}

/** Debug / suite: the current plan and what is drawn. */
export function scatterThinStats() {
	return { ...last, meshes: meshes.size };
}

/** Suite: re-plan on the next frame whatever moved. */
export function thinNow() {
	dirty = true;
}
