import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import {
	DEFAULT_LOD,
	EXPLICIT_MIN_TRIANGLES,
	normalizeLodOptions,
	levelsToBuild,
	pickLevel,
	geometrySignature
} from './lodCore';

// 31-perf P2 — AUTOMATIC LEVELS OF DETAIL, WITHOUT TOUCHING THE TREE.
//
// THE DESIGN DECISION, and why it is not a THREE.LOD: objectsGroup IS the replicated
// document (golden rule 5). Wrapping a loaded model in a LOD node would change what every
// serializer writes (sendObjects, GLTF save, autosave, sessions, undo), what the object
// list shows, what a flow's Object Selector resolves and what the mesh tools edit — five
// paths to keep consistent for a feature that is a fact about THIS screen. So the tree is
// left alone and the swap happens only while the renderer is drawing:
//   scene.onBeforeRender  -> for each registered mesh, pick a level by distance and put
//                            that level's geometry on the mesh
//   scene.onAfterRender   -> put the source geometry back
// three calls both inside `renderer.render()` (after updateMatrixWorld, before culling),
// so every render pass of a frame — the shadow map, the composer's scene pass, N8AO, an XR
// eye pair — draws the level, while EVERYTHING ELSE (picking, BVH, physics hulls, the mesh
// tools, every serializer, a peer message landing between frames) only ever sees the
// source geometry. The swap is two property writes per mesh per render call.
//
// LEVELS are meshoptimizer-simplified in the existing decimation Worker (decimateWorker.js
// — the same simplifier the import gate uses, already a dependency), built ONCE per asset:
// keyed by a content signature, so fifty placements of one pack piece or ten parses of one
// enemy GLB share one set. A mesh whose geometry is swapped (meshgeo, an undo) or edited
// in place (sculpt bumps the position version) stops swapping at once and is rebuilt only
// after it has been stable for a while — a stroke in progress never pays for a rebuild.
//
// WHAT IS LEFT ALONE: skinned meshes and morph targets (the simplifier cannot carry
// weights/deltas), instanced meshes in AUTO mode (one centre for instances spread across a
// dungeon means nothing), and anything under `minTriangles`. A module can still ask for
// any of its own meshes through `api.lod(object, opts)`.
//
// LOCAL, like every quality decision: nothing here replicates, saves or undoes. The
// `lodEnabled` pref (default ON) is the opt-out; the quality governor's `lodBias` pulls the
// switch distances in as it steps down (P3).

/** @typedef {import('./lodCore').LodOptions} LodOptions */
/**
 * @typedef {{mesh: any, source: any, version: number, sig: string, opts: LodOptions,
 *   edges: number[], levels: any[] | null, current: number, explicit: boolean,
 *   stableSince: number, owner: any}} LodEntry
 */

/** The opt-out. LOCAL, default ON. */
export const lodEnabled = writable(safeStorage.getItem('lodEnabled') !== 'false');
let lodEnabledSeen = false;
lodEnabled.subscribe((on) => {
	if (!lodEnabledSeen) {
		lodEnabledSeen = true;
		return;
	}
	safeStorage.setItem('lodEnabled', on ? 'true' : 'false');
});

/** The multiplier on every switch distance (< 1 = coarser sooner). Written by the quality
 * governor (P3); a plain number store so this module never imports it. */
export const lodBias = writable(1);

/** How long a mesh's geometry must stand still before its levels are (re)built. */
const STABLE_MS = 1500;
/** How often the auto scan walks the scene. Cheap (a traversal), and it catches module
 * content that has no store to poke. */
const SCAN_MS = 2000;

/** @type {Map<any, LodEntry>} */
const entries = new Map();
/** @type {Map<string, {levels: Promise<any[]|null>, value: any[]|null, refs: number, ratios: number[]}>} */
const cache = new Map();
/** meshes swapped in the render pass now in progress: [mesh, source] pairs */
/** @type {any[]} */
const swapped = [];
let renderDepth = 0;
/** @type {any} */
let hookedScene = null;
/** @type {any} */
let prevBefore = null;
/** @type {any} */
let prevAfter = null;
/** @type {ReturnType<typeof setInterval> | null} */
let scanTimer = null;
let enabled = true;
let bias = 1;
const stats = { entries: 0, drawnCoarse: 0, trianglesSaved: 0, builds: 0, lastBuildMs: 0 };

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** @param {any} g */
function trianglesOf(g) {
	if (!g) return 0;
	if (g.index) return Math.floor(g.index.count / 3);
	const p = g.attributes?.position;
	return p ? Math.floor(p.count / 3) : 0;
}

/** Why a mesh cannot take levels, '' when it can. @param {any} mesh @param {boolean} explicit */
function whyNot(mesh, explicit) {
	if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) return 'not a mesh';
	if (mesh.isSkinnedMesh) return 'skinned';
	if (mesh.isInstancedMesh && !explicit) return 'instanced';
	const morph = mesh.geometry.morphAttributes;
	if (morph && Object.keys(morph).some((k) => morph[k]?.length)) return 'morph targets';
	if (mesh.userData?.lod === false) return 'opted out';
	if (groupPass?.owns(mesh)) return 'lod group';
	return '';
}

// ---- 33: the LOD GROUP pass (lodGroup.js) + the overlay ----------------------------------
//
// A per-object LOD GROUP (userData.lod) runs inside the SAME render hooks, so both systems
// share one swap/restore bracket and one nesting rule. lodGroup registers itself here — a
// seam rather than an import, so this module keeps its two-store leaf shape.

/**
 * @typedef {{before: (camera: any, bias: number, enabled: boolean, overlay: boolean) => void,
 *   after: () => void, owns: (mesh: any) => boolean}} LodPass
 */
/** @type {LodPass | null} */
let groupPass = null;
/** @param {LodPass} pass */
export function registerLodPass(pass) {
	groupPass = pass;
	installHooks();
}

// 33-scenes: a pass that runs AFTER every level swap of a render call (kitInstancing.js
// batches pristine kit pieces into instanced draws, and it must see the geometry each mesh
// will actually draw with — its LOD level, not its source). Its `after` runs FIRST on the
// way out, so every bracket unwinds in reverse.
/** @typedef {{before: (camera: any) => void, after: () => void}} BatchPass */
/** @type {BatchPass | null} */
let batchPass = null;
/** @param {BatchPass} pass */
export function registerBatchPass(pass) {
	batchPass = pass;
	installHooks();
}

/** "Show LOD level": every LOD-managed mesh drawn in its level's colour. LOCAL, off. */
export const lodShowLevels = writable(false);
let overlay = false;
lodShowLevels.subscribe((on) => (overlay = !!on));
const OVERLAY_COLORS = [0x3fb950, 0xd4b106, 0xe07b1f, 0xd23f3f, 0xa052d9, 0x3b82f6];
/** @type {any[]} */
const overlayMats = [];
/** The flat material the overlay paints level `level` with (-1 = culled). @param {number} level */
export function overlayMaterial(level) {
	const i = level < 0 ? OVERLAY_COLORS.length : Math.min(level, OVERLAY_COLORS.length - 1);
	if (!overlayMats[i]) {
		overlayMats[i] = new THREE.MeshLambertMaterial({ color: i === OVERLAY_COLORS.length ? 0x6b7280 : OVERLAY_COLORS[i] });
		overlayMats[i].name = 'lod-overlay-' + i;
	}
	return overlayMats[i];
}
/** meshes whose MATERIAL the overlay swapped in this render pass: [mesh, material] pairs */
/** @type {any[]} */
const matSwapped = [];
/** Swap a mesh's material for this render pass (the overlay, a group's per-level
 * override). Restored with the geometry. @param {any} mesh @param {any} material */
export function swapMaterialForPass(mesh, material) {
	matSwapped.push(mesh, mesh.material);
	mesh.material = material;
}
/** Swap a mesh's geometry for this render pass. @param {any} mesh @param {any} geometry */
export function swapGeometryForPass(mesh, geometry) {
	swapped.push(mesh, mesh.geometry);
	mesh.geometry = geometry;
}

/** A LOCAL forced level per explicit mesh (`api.lod(...).force(n)`). @type {WeakMap<any, number>} */
const forcedMeshes = new WeakMap();

/**
 * Coarser geometry for ONE mesh at ONE ratio, built in the worker and shared by every
 * caller asking for the same content + ratio (the LOD group's 'generated' levels).
 * Resolves the geometry or null; `release()` drops the share.
 * @param {any} geometry @param {number} ratio
 * @returns {{geometry: Promise<any|null>, release: () => void}}
 */
export function simplifiedGeometry(geometry, ratio) {
	const sig = geometrySignature(geometry.attributes.position.array, geometry.index?.count ?? 0) + '|g' + ratio;
	/** @type {any} */
	let c = cache.get(sig);
	if (!c) {
		/** @type {any} */
		const fresh = { levels: null, value: null, refs: 0, ratios: [ratio] };
		fresh.levels = buildLevels(geometry, [ratio])
			.then((levels) => {
				fresh.value = levels;
				return levels;
			})
			.catch(() => null);
		cache.set(sig, fresh);
		c = fresh;
	}
	c.refs++;
	let released = false;
	return {
		geometry: c.levels.then((/** @type {any[]|null} */ levels) => levels?.[0] ?? null),
		release() {
			if (released) return;
			released = true;
			const cc = cache.get(sig);
			if (!cc) return;
			cc.refs--;
			if (cc.refs <= 0) {
				cache.delete(sig);
				for (const level of cc.value ?? []) level.dispose();
			}
		}
	};
}

// ---- the worker ------------------------------------------------------------------------

/** @type {Worker | null} */
let worker = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let workerIdle = null;
let nextJob = 1;
/** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */
const pending = new Map();
/** The seam a test (or a module-less build) can replace. @returns {Worker} */
let makeWorker = () => new Worker(new URL('./decimateWorker.js', import.meta.url), { type: 'module' });

function ensureWorker() {
	if (workerIdle) clearTimeout(workerIdle);
	workerIdle = null;
	if (worker) return worker;
	worker = makeWorker();
	worker.onmessage = (event) => {
		const job = pending.get(event.data?.id);
		if (!job) return;
		pending.delete(event.data.id);
		if (event.data.error) job.reject(new Error(event.data.error));
		else job.resolve(event.data.results ?? []);
		if (!pending.size) {
			// the simplifier's wasm heap grows to the biggest mesh it saw: let it go when idle
			workerIdle = setTimeout(() => {
				worker?.terminate();
				worker = null;
			}, 10000);
		}
	};
	worker.onerror = (event) => {
		for (const job of pending.values()) job.reject(new Error(event?.message || 'LOD worker failed'));
		pending.clear();
		worker?.terminate();
		worker = null;
	};
	return worker;
}

/** @param {any} attribute @param {number} size */
function floatsOf(attribute, size) {
	if (!attribute) return null;
	const count = attribute.count;
	const out = new Float32Array(count * size);
	if (!attribute.isInterleavedBufferAttribute && !attribute.normalized && attribute.array instanceof Float32Array && attribute.itemSize === size) {
		out.set(attribute.array.subarray(0, count * size));
		return out;
	}
	for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) out[i * size + c] = attribute.getComponent(i, c);
	return out;
}

/**
 * Simplify `geometry` once per kept ratio, in the worker. Resolves the level geometries
 * (coarse last), or null when nothing useful came back.
 * @param {any} geometry @param {number[]} ratios @returns {Promise<any[]|null>}
 */
function buildLevels(geometry, ratios) {
	const before = trianglesOf(geometry);
	const g = geometry;
	const color = g.attributes.color;
	/** @type {any[]} */
	const jobs = [];
	/** @type {ArrayBuffer[]} */
	const transfer = [];
	ratios.forEach((ratio, i) => {
		const job = {
			key: String(i),
			positions: floatsOf(g.attributes.position, 3),
			normals: floatsOf(g.attributes.normal, 3),
			uvs: floatsOf(g.attributes.uv, 2),
			colors: color ? floatsOf(color, color.itemSize) : null,
			colorSize: color?.itemSize ?? 3,
			index: g.index ? Uint32Array.from(g.index.array.subarray(0, g.index.count)) : null,
			groups: (g.groups ?? []).map((/** @type {any} */ gr) => ({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex })),
			target: Math.max(3, Math.floor(before * ratio)),
			// a far level is judged by its silhouette, not its surface: let the simplifier go
			// as far as the count asks (the import gate caps error at 5%; a LOD must not)
			errorCap: 1
		};
		for (const key of ['positions', 'normals', 'uvs', 'colors', 'index']) {
			const array = /** @type {any} */ (job)[key];
			if (array?.buffer && !transfer.includes(array.buffer)) transfer.push(array.buffer);
		}
		jobs.push(job);
	});
	const id = nextJob++;
	const started = now();
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		try {
			ensureWorker().postMessage({ id, meshes: jobs }, transfer);
		} catch (error) {
			pending.delete(id);
			reject(error);
		}
	}).then((/** @type {any} */ results) => {
		stats.builds++;
		stats.lastBuildMs = Math.round(now() - started);
		/** @type {any[]} */
		const levels = [];
		let previous = before;
		for (const r of results.sort((/** @type {any} */ a, /** @type {any} */ b) => Number(a.key) - Number(b.key))) {
			const tris = r.index.length / 3;
			// the simplifier could not get meaningfully coarser (locked group borders, a
			// mesh already minimal): a level that saves nothing is only a pop
			if (tris > previous * 0.9) continue;
			const level = new THREE.BufferGeometry();
			level.name = (geometry.name || 'geometry') + ' LOD' + (levels.length + 1);
			level.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
			if (r.normals) level.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
			if (r.uvs) level.setAttribute('uv', new THREE.BufferAttribute(r.uvs, 2));
			if (r.colors) level.setAttribute('color', new THREE.BufferAttribute(r.colors, r.colorSize));
			level.setIndex(new THREE.BufferAttribute(r.index, 1));
			for (const group of r.groups ?? []) level.addGroup(group.start, group.count, group.materialIndex ?? 0);
			if (r.recomputeNormals || !r.normals) level.computeVertexNormals();
			level.computeBoundingBox();
			level.computeBoundingSphere();
			level.userData = { lodLevel: levels.length + 1, lodOf: geometry.uuid };
			levels.push(level);
			previous = tris;
		}
		return levels.length ? levels : null;
	});
}

// ---- the registry -------------------------------------------------------------------------

/** @param {LodEntry} entry */
function release(entry) {
	const c = cache.get(entry.sig);
	if (!c) return;
	c.refs--;
	if (c.refs <= 0) {
		cache.delete(entry.sig);
		for (const level of c.value ?? []) level.dispose();
	}
}

/**
 * Start (or restart) an entry's levels for its current source geometry.
 * @param {LodEntry} entry
 */
function requestLevels(entry) {
	const geometry = entry.mesh.geometry;
	const tris = trianglesOf(geometry);
	const kept = levelsToBuild(tris, entry.opts);
	entry.source = geometry;
	entry.version = geometry.attributes.position.version;
	entry.levels = null;
	entry.current = 0;
	entry.edges = kept.map((i) => entry.opts.distances[i]);
	if (!kept.length) {
		entry.sig = '';
		return;
	}
	const ratios = kept.map((i) => entry.opts.ratios[i]);
	const sig = geometrySignature(geometry.attributes.position.array, geometry.index?.count ?? 0) + '|' + ratios.join(',');
	entry.sig = sig;
	/** @type {any} */
	let c = cache.get(sig);
	if (!c) {
		/** @type {any} */
		const fresh = { levels: null, value: null, refs: 0, ratios };
		fresh.levels = buildLevels(geometry, ratios)
			.then((levels) => {
				fresh.value = levels;
				return levels;
			})
			.catch(() => null);
		cache.set(sig, fresh);
		c = fresh;
	}
	c.refs++;
	const mine = sig;
	c.levels.then((/** @type {any[]|null} */ levels) => {
		// the mesh may have moved on (a new geometry, unregistered) while the worker ran
		if (entries.get(entry.mesh) !== entry || entry.sig !== mine || !levels) return;
		// a level the simplifier dropped leaves its distance unpaired: keep edges aligned
		entry.levels = levels;
		entry.edges = entry.edges.slice(0, levels.length);
	});
}

/**
 * Register one mesh. @param {any} mesh @param {Partial<LodOptions>} opts
 * @param {boolean} explicit @param {any} owner @returns {boolean}
 */
function registerMesh(mesh, opts, explicit, owner) {
	if (whyNot(mesh, explicit)) return false;
	const o = normalizeLodOptions({ ...(explicit ? { minTriangles: EXPLICIT_MIN_TRIANGLES } : {}), ...opts });
	if (trianglesOf(mesh.geometry) < o.minTriangles || !o.ratios.length) return false;
	const existing = entries.get(mesh);
	if (existing) {
		// explicit wins over auto; an auto rescan never downgrades an explicit entry
		if (existing.explicit && !explicit) return true;
		if (!explicit) return true;
		unregisterMesh(mesh);
	}
	/** @type {LodEntry} */
	const entry = {
		mesh,
		source: null,
		version: -1,
		sig: '',
		opts: o,
		edges: [],
		levels: null,
		current: 0,
		explicit,
		stableSince: now(),
		owner
	};
	entries.set(mesh, entry);
	requestLevels(entry);
	stats.entries = entries.size;
	return true;
}

/** @param {any} mesh */
function unregisterMesh(mesh) {
	const entry = entries.get(mesh);
	if (!entry) return;
	entries.delete(mesh);
	release(entry);
	stats.entries = entries.size;
}

/**
 * Levels for every eligible mesh under `object` — the `api.lod` seam. Options are
 * `{ratios?, distances?, minTriangles?}` (see lodCore.DEFAULT_LOD). Returns a handle whose
 * `remove()` gives the meshes their plain geometry back for good, and `ready` resolves once
 * every level has been built (or failed).
 * @param {any} object @param {Partial<LodOptions>} [opts] @param {any} [owner]
 */
export function lodObject(object, opts = {}, owner = null) {
	/** @type {any[]} */
	const meshes = [];
	object?.traverse?.((/** @type {any} */ o) => {
		if (registerMesh(o, opts, true, owner)) meshes.push(o);
	});
	installHooks();
	const ready = Promise.all(meshes.map((m) => cache.get(entries.get(m)?.sig ?? '')?.levels ?? null)).then(() => meshes.length);
	return {
		meshes: meshes.length,
		ready,
		/** 33: draw level `n` on THIS screen whatever the distance (null = automatic again).
		 * LOCAL, like every auto-LOD decision. @param {number | null} n */
		force(n) {
			for (const m of meshes) {
				if (n === null || n === undefined || !Number.isFinite(Number(n))) forcedMeshes.delete(m);
				else forcedMeshes.set(m, Math.max(0, Math.floor(Number(n))));
			}
		},
		/** The level each mesh drew last (0 = source). */
		levels() {
			return meshes.map((m) => entries.get(m)?.current ?? 0);
		},
		remove() {
			for (const m of meshes) if (entries.get(m)?.owner === owner) unregisterMesh(m);
		}
	};
}

/** Drop every entry a module owns (its teardown journal). @param {any} owner */
export function releaseOwner(owner) {
	for (const [mesh, entry] of [...entries]) if (entry.explicit && entry.owner === owner) unregisterMesh(mesh);
}

// ---- the swap -----------------------------------------------------------------------------

function restoreSwapped() {
	// REVERSE: a mesh swapped twice in one pass (a group level, then anything after it)
	// must end on the geometry it had before the FIRST swap
	for (let i = swapped.length - 2; i >= 0; i -= 2) swapped[i].geometry = swapped[i + 1];
	swapped.length = 0;
	// materials in REVERSE: a mesh swapped twice (an override, then the overlay) must end on
	// its own material, not on the override
	for (let i = matSwapped.length - 2; i >= 0; i -= 2) matSwapped[i].material = matSwapped[i + 1];
	matSwapped.length = 0;
}

/**
 * scene.onBeforeRender: put each registered mesh's level on it for this render call.
 * Allocation-free — it runs once per render pass, several times a frame.
 * @param {any} renderer @param {any} scene @param {any} camera
 */
function beforeRender(renderer, scene, camera) {
	prevBefore?.(renderer, scene, camera);
	if (renderDepth++ > 0) return; // a nested render (a probe inside a pass) keeps the outer swap
	batchPass?.after(); // a render that threw last time left members hidden: never keep that
	restoreSwapped(); // a render that threw last time left a swap behind: never keep it
	swapLevels(camera);
	if (batchPass && camera?.matrixWorld) batchPass.before(camera);
}

/** The level swaps of one render call (beforeRender's body). @param {any} camera */
function swapLevels(camera) {
	stats.drawnCoarse = 0;
	stats.trianglesSaved = 0;
	if (groupPass && camera?.matrixWorld) groupPass.before(camera, bias, enabled, overlay);
	if (!entries.size || !camera?.matrixWorld) return;
	if (!enabled) {
		if (overlay) for (const entry of entries.values()) if (entry.mesh.visible) swapMaterialForPass(entry.mesh, overlayMaterial(0));
		return;
	}
	const ce = camera.matrixWorld.elements;
	const cx = ce[12];
	const cy = ce[13];
	const cz = ce[14];
	const t = now();
	for (const entry of entries.values()) {
		const mesh = entry.mesh;
		// 33: a LOD group draws this mesh's levels (an auto entry is dropped on the next scan)
		if (!entry.explicit && groupPass?.owns(mesh)) continue;
		const geometry = mesh.geometry;
		if (geometry !== entry.source || geometry.attributes.position.version !== entry.version) {
			// swapped (meshgeo, undo) or edited in place (sculpt): stand down now, rebuild once
			// it has held still — a stroke in progress must not rebuild every frame
			if (entry.levels || entry.sig) {
				release(entry);
				entry.levels = null;
				entry.sig = '';
				entry.source = geometry;
				entry.version = geometry.attributes.position.version;
				entry.stableSince = t;
			} else if (geometry !== entry.source || geometry.attributes.position.version !== entry.version) {
				entry.source = geometry;
				entry.version = geometry.attributes.position.version;
				entry.stableSince = t;
			}
			continue;
		}
		if (!entry.levels) {
			if (!entry.sig && t - entry.stableSince > STABLE_MS && trianglesOf(geometry) >= entry.opts.minTriangles) requestLevels(entry);
			if (overlay && mesh.visible) swapMaterialForPass(mesh, overlayMaterial(0));
			continue;
		}
		if (!mesh.visible) continue;
		const sphere = geometry.boundingSphere ?? (geometry.computeBoundingSphere(), geometry.boundingSphere);
		if (!sphere) continue;
		const e = mesh.matrixWorld.elements;
		const sx = sphere.center.x;
		const sy = sphere.center.y;
		const sz = sphere.center.z;
		const wx = e[0] * sx + e[4] * sy + e[8] * sz + e[12];
		const wy = e[1] * sx + e[5] * sy + e[9] * sz + e[13];
		const wz = e[2] * sx + e[6] * sy + e[10] * sz + e[14];
		const scale = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
		const radius = sphere.radius * scale;
		const dx = wx - cx;
		const dy = wy - cy;
		const dz = wz - cz;
		const auto = pickLevel(Math.sqrt(dx * dx + dy * dy + dz * dz), radius, entry.edges, bias, entry.current, entry.opts.hysteresis);
		const forced = forcedMeshes.get(mesh);
		const level = forced === undefined ? auto : Math.min(forced, entry.levels.length);
		entry.current = level;
		if (overlay) swapMaterialForPass(mesh, overlayMaterial(level));
		if (level > 0) {
			const low = entry.levels[level - 1];
			swapped.push(mesh, geometry);
			mesh.geometry = low;
			stats.drawnCoarse++;
			stats.trianglesSaved += trianglesOf(geometry) - trianglesOf(low);
		}
	}
}

/** scene.onAfterRender: every mesh gets its source geometry back. @param {any[]} args */
function afterRender(...args) {
	if (--renderDepth > 0) return;
	renderDepth = 0;
	batchPass?.after();
	groupPass?.after();
	restoreSwapped();
	prevAfter?.(...args);
}

function installHooks() {
	const scene = get(globalScene);
	if (!scene || hookedScene === scene) return;
	if (hookedScene) uninstallHooks();
	prevBefore = scene.onBeforeRender && scene.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ? scene.onBeforeRender : null;
	prevAfter = scene.onAfterRender && scene.onAfterRender !== THREE.Object3D.prototype.onAfterRender ? scene.onAfterRender : null;
	scene.onBeforeRender = beforeRender;
	scene.onAfterRender = afterRender;
	hookedScene = scene;
}

function uninstallHooks() {
	batchPass?.after();
	restoreSwapped();
	if (!hookedScene) return;
	if (hookedScene.onBeforeRender === beforeRender) hookedScene.onBeforeRender = prevBefore ?? THREE.Object3D.prototype.onBeforeRender;
	if (hookedScene.onAfterRender === afterRender) hookedScene.onAfterRender = prevAfter ?? THREE.Object3D.prototype.onAfterRender;
	hookedScene = null;
	prevBefore = null;
	prevAfter = null;
	renderDepth = 0;
}

// ---- the auto scan ------------------------------------------------------------------------

/** Walk objectsGroup + the module world root: register dense meshes, forget departed ones.
 * Exported for the suite. */
export function scanForLod() {
	installHooks();
	const scene = get(globalScene);
	const group = get(objectsGroup);
	/** @type {Set<any>} */
	const seen = new Set();
	if (enabled) {
		const visit = (/** @type {any} */ root) =>
			root?.traverse?.((/** @type {any} */ o) => {
				if (!o.isMesh) return;
				seen.add(o);
				if (!entries.has(o)) registerMesh(o, {}, false, null);
			});
		visit(group);
		visit(scene?.getObjectByName?.('module-world-root'));
	}
	// 33: a mesh that joined a LOD GROUP leaves auto LOD (the group draws its levels)
	if (groupPass) for (const [mesh, entry] of [...entries]) if (!entry.explicit && groupPass.owns(mesh)) unregisterMesh(mesh);
	// an auto entry whose mesh left the scene is dropped; an explicit one stays until its
	// owner says so (a module may park content off-scene and put it back)
	for (const [mesh, entry] of [...entries]) {
		if (entry.explicit) continue;
		if (!seen.has(mesh)) unregisterMesh(mesh);
	}
}

/** Start the scan + hooks (App boot). Idempotent. */
export function startLod() {
	if (scanTimer || typeof window === 'undefined') return;
	scanTimer = setInterval(scanForLod, SCAN_MS);
	globalScene.subscribe(() => installHooks());
	scanForLod();
}

lodEnabled.subscribe((on) => {
	enabled = on;
	if (!on) restoreSwapped();
});
lodBias.subscribe((b) => {
	bias = Number.isFinite(b) && b > 0 ? b : 1;
});

/** For the probe, the suite and the stats plate. */
export function lodStats() {
	return {
		...stats,
		enabled,
		bias,
		cached: cache.size,
		meshes: [...entries.values()].map((e) => ({
			name: e.mesh.name,
			uuid: e.mesh.uuid,
			explicit: e.explicit,
			triangles: trianglesOf(e.source ?? e.mesh.geometry),
			levels: e.levels?.map((l) => trianglesOf(l)) ?? null,
			edges: e.edges,
			current: e.current
		}))
	};
}

/** TEST-ONLY seams. */
export const lodForTest = {
	/** @param {() => Worker} factory */
	setWorkerFactory(factory) {
		makeWorker = factory;
	},
	/** @param {any} mesh @param {Partial<LodOptions>} [opts] */
	register: (mesh, opts = {}) => registerMesh(mesh, opts, false, null),
	unregister: unregisterMesh,
	defaults: DEFAULT_LOD,
	reset() {
		for (const mesh of [...entries.keys()]) unregisterMesh(mesh);
		restoreSwapped();
	}
};
