import * as THREE from 'three';
// @ts-ignore - three addons ship no declarations here (project-wide)
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { get } from 'svelte/store';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { loadGltf, gltfLoaderStats } from './gltfLoader';
import { normalizeModelOptions, resolveModelUrl, levelFileUrl, packRowKeyOf } from './modelLoaderCore';
import { lodObject } from './lod';
import { DEFAULT_LOD } from './lodCore';
import { groupFromPackLods, normalizeLodGroup } from './lodGroupCore';
import { addLodRoot, removeLodRoot, packLodGroupFor } from './lodGroup';
import { keepSet, disposeTree } from './disposeTree';
import { PACKS_BASE } from './packs';

// 34 R7 (E1) — api.loadModel: a module's glTF through the APP's loader.
//
// WHY IT EXISTS: the api handed a module THREE and no loader (DEVX #36), so Waves bundled a
// second copy of three's GLTFLoader against a shim of the runtime three (45 KB of module.js)
// and the Dungeon Kit baked its torch GLB into base64 at build time (188 KB of module.js). Both
// work, both skip what core's loader has (Draco, Meshopt, KTX2 on demand, one cache, LOD).
//
// THE SHAPE: one TEMPLATE per resolved URL, parsed once and shared by every module that asks;
// a module gets a HANDLE — its own `scene` (a clone of the template, so one module's tweaks
// never reach another's) plus `instance()` for more copies (SkeletonUtils for a skinned model,
// so each copy has its own bones; geometry and textures are always shared). Every instance gets
// the LOD the options ask for: 31-perf's generated levels (`lod.js`, registered EXPLICITLY with
// the module as owner, so it works wherever the module parks the object, not only under
// module-world-root), or a P1 group of level FILES drawn by lodGroup.js.
//
// A COPY THE MODULE DROPS without release() (a wrapper group removed, an enemy forgotten) must
// not stay alive through us: a sweep at lod.js's cadence PARKS a copy that has left the scene —
// its LOD registration dropped, held only WEAKLY — and picks it back up if it returns.
//
// LIFETIME (contract T2): a handle belongs to its module. `handle.dispose()` — or the module's
// teardown, which disposes every handle it still holds — takes its instances out of the scene
// (unless they live in objectsGroup: replicated content is the scene's, not the module's),
// drops their LOD registrations, frees their own material copies, and releases the template;
// the last release frees the template's GPU resources, keeping anything the scene still draws
// (keepSet — an instance a module put in objectsGroup keeps its textures).
//
// LOCAL: loading is a fact about this machine. Nothing here replicates.

/**
 * @typedef {{url: string, promise: Promise<any>, gltf: any, refs: number, skinned: boolean,
 *   stats: {meshes: number, triangles: number, materials: number, textures: number}}} Template
 * @typedef {{root: any, lod: {remove: () => void} | null, group: boolean, groupOn: boolean, ownMaterials: any[], fresh: boolean}} Instance
 */

/** resolved url -> template @type {Map<string, Template>} */
const templates = new Map();
/** module id -> its live handles @type {Map<string, Set<any>>} */
const byOwner = new Map();
const counters = { loads: 0, cacheHits: 0, instances: 0, disposed: 0, failures: 0 };
/** every live handle's sweep (see loadModel) @type {Set<(scene: any) => void>} */
const sweepers = new Set();
/** how often copies are checked for having left (or come back to) the scene — lod.js's cadence */
const SWEEP_MS = 2000;
/** @type {ReturnType<typeof setInterval> | null} */
let sweepTimer = null;

/** Check every handle's copies against the scene. Exported for the suite. */
export function sweepModels() {
	const scene = get(globalScene);
	for (const sweep of [...sweepers]) sweep(scene);
	if (!sweepers.size && sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
}

function startSweeping() {
	if (sweepTimer || typeof window === 'undefined') return;
	sweepTimer = setInterval(sweepModels, SWEEP_MS);
}

/** @param {any} object @param {any} scene */
function inScene(object, scene) {
	for (let o = object; o; o = o.parent) if (o === scene) return true;
	return false;
}

/** @param {any} g */
function trianglesOf(g) {
	if (!g) return 0;
	if (g.index) return Math.floor(g.index.count / 3);
	const p = g.attributes?.position;
	return p ? Math.floor(p.count / 3) : 0;
}

/** @param {any} scene */
function measure(scene) {
	const materials = new Set();
	const textures = new Set();
	let meshes = 0;
	let triangles = 0;
	let skinned = false;
	scene.traverse((/** @type {any} */ o) => {
		if (!o.isMesh) return;
		meshes++;
		triangles += trianglesOf(o.geometry);
		if (o.isSkinnedMesh) skinned = true;
		for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
			if (!m) continue;
			materials.add(m);
			for (const k of Object.keys(m)) if (m[k]?.isTexture) textures.add(m[k]);
		}
	});
	return { skinned, stats: { meshes, triangles, materials: materials.size, textures: textures.size } };
}

/** The shared template of `url` (parsed once; a failure is forgotten so a retry can win).
 * @param {string} url @returns {Promise<Template>} */
function template(url) {
	const cached = templates.get(url);
	if (cached) {
		counters.cacheHits++;
		return cached.promise.then(() => cached);
	}
	counters.loads++;
	/** @type {Template} */
	const t = { url, promise: /** @type {any} */ (null), gltf: null, refs: 0, skinned: false, stats: { meshes: 0, triangles: 0, materials: 0, textures: 0 } };
	t.promise = loadGltf(url).then(
		(gltf) => {
			gltf.scene.updateMatrixWorld(true);
			const m = measure(gltf.scene);
			t.gltf = gltf;
			t.skinned = m.skinned;
			t.stats = m.stats;
			return gltf;
		},
		(error) => {
			templates.delete(url);
			counters.failures++;
			throw error;
		}
	);
	templates.set(url, t);
	return t.promise.then(() => t);
}

/** @param {Template} t */
function releaseTemplate(t) {
	t.refs = Math.max(0, t.refs - 1);
	if (t.refs > 0 || templates.get(t.url) !== t) return;
	templates.delete(t.url);
	if (!t.gltf) return;
	// anything the scene still draws (an instance left in objectsGroup) keeps its resources
	disposeTree(t.gltf.scene, { keep: keepSet(get(globalScene), []) });
}

/** @param {any} object */
function inObjectsGroup(object) {
	const group = get(objectsGroup);
	for (let o = object?.parent; o; o = o.parent) if (o === group) return true;
	return false;
}

/**
 * The P1 group for a model, from the options' level files or (for a pack item asked with the
 * default) from its pack row. null = generated levels / none.
 * @param {any} lod normalized `lod` @param {string} asked @param {string} resolved
 * @param {Record<string, string> | null} assets
 */
async function fileGroupFor(lod, asked, resolved, assets) {
	if (Array.isArray(lod)) {
		const block = groupFromPackLods({ lods: lod });
		if (!block) return null;
		const levels = [];
		for (const level of block.levels) {
			if (level.source !== 'pack') {
				levels.push(level);
				continue;
			}
			const url = levelFileUrl(asked, resolved, /** @type {string} */ (level.ref), assets);
			if (url) levels.push({ ...level, ref: url });
		}
		return levels.length > 1 ? normalizeLodGroup({ ...block, levels }) : null;
	}
	if (lod === 'auto') return packLodGroupFor(resolved, packRowKeyOf(resolved, PACKS_BASE));
	return null;
}

/**
 * Load a model for `owner` (a module id). See the SDK doc (sdk/models.js) for the contract.
 * @param {string} url @param {any} [options] @param {string} [owner]
 * @param {Record<string, string> | null} [assets] the module's packaged files (path -> blob URL)
 */
export async function loadModel(url, options = {}, owner = '', assets = null) {
	const o = normalizeModelOptions(options);
	const resolved = resolveModelUrl(url, assets);
	if (!resolved) throw new Error(`loadModel: "${url}" is not a URL and not a file this module packaged`);
	const t = await template(resolved);
	t.refs++;
	let group = null;
	try {
		group = await fileGroupFor(o.lod, String(url).trim(), resolved, assets);
	} catch {
		group = null;
	}
	// A copy is LIVE while it is in the scene graph (its LOD registered) and PARKED once it has
	// left it: a module that discards copies by dropping a wrapper group never calls release(),
	// and a strong hold here (or lod.js's own entry) would keep every discarded copy alive for
	// the session. Parked copies are held WEAKLY and their LOD is dropped; one that comes back
	// into the scene is picked up again by the next sweep. A fresh copy gets one sweep of grace.
	/** @type {Map<any, Instance>} */
	const live = new Map();
	/** @type {Set<WeakRef<any>>} */
	const parked = new Set();
	/** @type {WeakMap<any, Instance>} */
	const records = new WeakMap();
	let disposed = false;
	/** @type {any} */
	let prototype = null;

	/** @param {Instance} inst */
	const attach = (inst) => {
		if (inst.group) {
			addLodRoot(inst.root);
			inst.groupOn = true;
		} else if (!inst.lod && o.lod !== false) {
			const opts = o.lod === 'auto' ? { minTriangles: DEFAULT_LOD.minTriangles } : /** @type {any} */ (o.lod);
			inst.lod = lodObject(inst.root, opts, owner || null);
		}
	};
	/** @param {Instance} inst */
	const detach = (inst) => {
		inst.lod?.remove();
		inst.lod = null;
		if (inst.groupOn) removeLodRoot(inst.root);
		inst.groupOn = false;
	};

	/** @param {any} source @param {{ownMaterials?: boolean}} [extra] */
	const make = (source, extra = {}) => {
		const root = t.skinned ? cloneSkinned(source) : source.clone(true);
		const own = extra.ownMaterials ?? o.ownMaterials;
		/** @type {any[]} */
		const ownMaterials = [];
		/** @type {Map<any, any>} */
		const copies = new Map();
		const copy = (/** @type {any} */ m) => {
			if (!m) return m;
			if (!copies.has(m)) {
				const c = m.clone();
				copies.set(m, c);
				ownMaterials.push(c);
			}
			return copies.get(m);
		};
		root.traverse((/** @type {any} */ n) => {
			if (!n.isMesh) return;
			if (o.castShadow !== null) n.castShadow = o.castShadow;
			if (o.receiveShadow !== null) n.receiveShadow = o.receiveShadow;
			if (o.lod === false) n.userData.lod = false;
			if (own) n.material = Array.isArray(n.material) ? n.material.map(copy) : copy(n.material);
		});
		if (o.collider) root.userData.colliderHint = o.collider;
		if (group) root.userData.lod = JSON.parse(JSON.stringify(group));
		/** @type {Instance} */
		const inst = { root, lod: null, group: !!group, groupOn: false, ownMaterials, fresh: true };
		attach(inst);
		live.set(root, inst);
		records.set(root, inst);
		counters.instances++;
		return root;
	};

	/** Forget a copy for good. @param {Instance} inst */
	const drop = (inst) => {
		detach(inst);
		if (!inObjectsGroup(inst.root)) {
			inst.root.removeFromParent();
			for (const m of inst.ownMaterials) m.dispose();
		}
		live.delete(inst.root);
		records.delete(inst.root);
	};

	/** @param {any} scene the live scene */
	const sweep = (scene) => {
		for (const [root, inst] of [...live]) {
			if (inst.fresh) {
				inst.fresh = false;
				continue;
			}
			if (inScene(root, scene)) continue;
			detach(inst);
			live.delete(root);
			parked.add(new WeakRef(root));
		}
		for (const ref of [...parked]) {
			const root = ref.deref();
			const inst = root ? records.get(root) : null;
			if (!root || !inst) {
				parked.delete(ref);
				continue;
			}
			if (!inScene(root, scene)) continue;
			parked.delete(ref);
			attach(inst);
			live.set(root, inst);
		}
	};

	const handle = {
		/** the url the bytes came from */
		url: resolved,
		/** this module's own copy — add it to the scene, or call instance() for more */
		scene: /** @type {any} */ (null),
		/** the file's clips (shared, read-only — bind a THREE.AnimationMixer per instance) */
		animations: t.gltf.animations ?? [],
		/** what the file holds: {meshes, triangles, materials, textures, skinned} */
		info: { ...t.stats, skinned: t.skinned },
		/**
		 * A fresh copy of `scene` as it is NOW (its transform and any tweak included), with its
		 * own bones when skinned and the handle's LOD. `{ownMaterials: true}` gives this copy
		 * its own materials even when the handle shares them.
		 * @param {{ownMaterials?: boolean}} [extra]
		 */
		instance(extra) {
			if (disposed) throw new Error('loadModel: instance() after dispose()');
			return make(prototype, extra);
		},
		/** Forget one copy for good: out of the scene (unless it is in objectsGroup), LOD
		 * released, its own materials freed. @param {any} object @returns {boolean} */
		release(object) {
			const inst = records.get(object);
			if (!inst) return false;
			for (const ref of parked) if (ref.deref() === object) parked.delete(ref);
			drop(inst);
			return true;
		},
		/** Every copy released and the template let go (the module's teardown calls this). */
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const inst of [...live.values()]) drop(inst);
			for (const ref of parked) {
				const inst = records.get(ref.deref());
				if (inst) drop(inst);
			}
			parked.clear();
			sweepers.delete(sweep);
			const mine = byOwner.get(owner);
			mine?.delete(handle);
			if (mine && !mine.size) byOwner.delete(owner);
			counters.disposed++;
			releaseTemplate(t);
		},
		/** copies in the scene (or just made) / copies that left it and are still alive */
		get instances() {
			return live.size;
		},
		get parked() {
			let n = 0;
			for (const ref of parked) if (ref.deref()) n++;
			return n;
		}
	};
	prototype = make(t.gltf.scene);
	handle.scene = prototype;
	let set = byOwner.get(owner);
	if (!set) byOwner.set(owner, (set = new Set()));
	set.add(handle);
	sweepers.add(sweep);
	startSweeping();
	return handle;
}

/** The module's teardown (T2): dispose every handle `owner` still holds. Returns how many.
 * @param {string} owner */
export function releaseModelsOf(owner) {
	const set = byOwner.get(owner);
	if (!set) return 0;
	const n = set.size;
	for (const h of [...set]) h.dispose();
	byOwner.delete(owner);
	return n;
}

/** For the suite, the perf probe and the lifecycle leak test. */
export function modelStats() {
	return {
		...counters,
		loader: gltfLoaderStats(),
		templates: [...templates.values()].map((t) => ({ url: t.url, refs: t.refs, ready: !!t.gltf, skinned: t.skinned, ...t.stats })),
		owners: Object.fromEntries([...byOwner].map(([id, set]) => [id, [...set].map((h) => ({ url: h.url, instances: h.instances, parked: h.parked }))]))
	};
}

/** TEST-ONLY. */
export const modelLoaderForTest = {
	templates: () => templates,
	THREE
};
