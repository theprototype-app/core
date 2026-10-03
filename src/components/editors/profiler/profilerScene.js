// 34 PF — the Profiler's reach into the LIVE scene: resolve a recorded row's uuid to an object
// that is in the open scene, select it (which is the highlight — the selection outline) and
// open its settings, landing on the LOD section when it has a LOD group.
//
// A recording is a fact about a moment, so its uuids may not be in the scene any more (an
// imported file, a beacon report, a scene switched since): every function here answers
// "not here" rather than guessing. Module content and the editor's own helpers live outside
// objectsGroup and cannot be selected — the answer says whose they are.
import { get } from 'svelte/store';
import { globalScene, objectsGroup } from '../../../stores/sceneStore';
import { inspectorScrollTo } from '../../../stores/appStore';
import { selectObject } from '$lib/objectActions';
import { effectiveGroupOf } from '$lib/lodGroup';

/** uuid -> object, rebuilt at most once a second (the tree asks per visible mesh row) */
let index = /** @type {Map<string, any> | null} */ (null);
let indexedAt = 0;
let indexedScene = /** @type {any} */ (null);

/** @param {string | null} uuid */
function find(uuid) {
	if (!uuid) return null;
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return null;
	const now = performance.now();
	if (!index || indexedScene !== scene || now - indexedAt > 1000) {
		index = new Map();
		scene.traverse((/** @type {any} */ o) => index?.set(o.uuid, o));
		indexedAt = now;
		indexedScene = scene;
	}
	return index.get(uuid) ?? null;
}

/** @param {any} geometry */
function trianglesOf(geometry) {
	if (!geometry) return 0;
	const n = geometry.index ? geometry.index.count : (geometry.attributes?.position?.count ?? 0);
	return Math.floor(n / 3);
}

/**
 * The triangles a mesh HOLDS (its source geometry), for the tree to show beside what a
 * capture saw DRAWN — auto-LOD swaps a lighter level in at render time, so the two differ
 * on exactly the meshes worth knowing about. Null when the mesh is not in the scene.
 * @param {string | null} uuid
 */
export function liveSourceTris(uuid) {
	const o = find(uuid);
	if (!o?.isMesh) return null;
	const inst = o.isInstancedMesh ? o.count : 1;
	return trianglesOf(o.geometry) * inst;
}

/**
 * Select the object a row names. Climbs from the drawn mesh to the top-level object the user
 * can select, opens its properties and — when it runs a LOD group — scrolls to the LOD section.
 * @param {string | null} uuid
 * @returns {{ok: true, uuid: string, name: string, lod: boolean} | {ok: false, reason: 'missing' | 'not-selectable', owner?: string}}
 */
export function selectDrawn(uuid) {
	const o = find(uuid);
	if (!o) return { ok: false, reason: 'missing' };
	const group = /** @type {any} */ (get(objectsGroup));
	let top = o;
	while (top && top.parent && top.parent !== group) top = top.parent;
	if (!group || !top || top.parent !== group) {
		// outside the replicated objects: module content or an editor helper
		let owner = o;
		while (owner?.parent && owner.parent.type !== 'Scene') owner = owner.parent;
		return {
			ok: false,
			reason: 'not-selectable',
			owner: owner?.name || owner?.type || 'the editor'
		};
	}
	selectObject(top.uuid, true);
	let lod = false;
	try {
		lod = !!effectiveGroupOf(top);
	} catch {
		lod = !!top.userData?.lod;
	}
	if (lod) setTimeout(() => inspectorScrollTo.set('LOD'), 160);
	return { ok: true, uuid: top.uuid, name: top.name || top.type, lod };
}
