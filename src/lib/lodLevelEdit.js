import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { TControls, globalScene, objectsGroup, selectedObjects } from '../stores/sceneStore';
import { editableGroupOf, updateLodLevel } from './lodGroupActions';
import { lodPreview } from './lodGroup';

// 33 (K6) — THE GIZMO ON ONE LOD LEVEL. A level's placement relative to its object is the
// level's `offset` (root-local), so a level that came out of the simplifier a hair off, or a
// replacement model authored around another origin, can be lined up by eye — the way a DCC
// lets you select a LOD and move it. The gizmo sits on a scene-root PROXY
// (`userData.isLodLevelProxy`, the spline/vertex-proxy shape: Scene.svelte routes its
// objectChange and dragging-changed here and broadcasts no `move`): every frame of a drag
// writes the offset LOCALLY (previewLodGroup), the release commits ONE `lod` write with the
// pre-drag block as its undo state. The level is previewed on this screen while the gizmo
// is on it (lodPreview), so you see the level you are moving.

/** {uuid, level} while a level carries the gizmo. LOCAL. @type {import('svelte/store').Writable<{uuid: string, level: number} | null>} */
export const lodLevelGizmo = writable(null);

/** @type {any} */
let proxy = null;
/** @type {{uuid: string, level: number} | null} */
let target = null;
/** @type {any} */
let gestureBefore = null;

const _m = new THREE.Matrix4();
const _o = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/** @param {string} uuid */
function rootOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** The level's offset as a matrix. @param {any} level */
function offsetOf(level) {
	const o = level?.offset ?? {};
	const r = o.rot ?? [0, 0, 0];
	return _o.compose(_p.fromArray(o.pos ?? [0, 0, 0]), _q.setFromEuler(_e.set(r[0], r[1], r[2], 'XYZ')), _s.fromArray(o.scale ?? [1, 1, 1]));
}

/**
 * Put the gizmo on level `level` of object `uuid` (never LOD0 — that is the object, and
 * the object's own gizmo moves it). Returns false when there is nothing to move.
 * @param {string} uuid @param {number} level
 */
export function startLevelGizmo(uuid, level) {
	const root = rootOf(uuid);
	const block = editableGroupOf(uuid);
	/** @type {any} */
	const controls = get(TControls);
	const scene = get(globalScene);
	if (!root || !block?.levels[level] || level <= 0 || !controls || !scene) return false;
	stopLevelGizmo({ reattach: false });
	proxy = new THREE.Object3D();
	proxy.name = 'lod-level-proxy';
	proxy.userData = { isLodLevelProxy: true };
	root.updateWorldMatrix(true, false);
	_m.multiplyMatrices(root.matrixWorld, offsetOf(block.levels[level]));
	_m.decompose(proxy.position, proxy.quaternion, proxy.scale);
	scene.add(proxy);
	target = { uuid, level };
	controls.attach(proxy);
	controls.visible = true;
	lodLevelGizmo.set(target);
	lodPreview.set({ uuid, level });
	return true;
}

/** Take the gizmo off the level; by default it goes back on the object. @param {{reattach?: boolean}} [opts] */
export function stopLevelGizmo(opts = {}) {
	/** @type {any} */
	const controls = get(TControls);
	const was = target;
	if (proxy) {
		if (controls?.object === proxy) controls.detach();
		proxy.removeFromParent();
	}
	proxy = null;
	target = null;
	gestureBefore = null;
	if (was) {
		lodLevelGizmo.set(null);
		if (opts.reattach !== false) {
			const root = rootOf(was.uuid);
			if (root && controls && get(selectedObjects).includes(was.uuid)) {
				controls.attach(root);
				controls.visible = true;
			}
		}
	}
}

/** The proxy's pose as the level's root-local offset. */
function currentOffset() {
	if (!proxy || !target) return null;
	const root = rootOf(target.uuid);
	if (!root) return null;
	root.updateWorldMatrix(true, false);
	proxy.updateMatrixWorld(true);
	_m.copy(root.matrixWorld).invert().multiply(proxy.matrixWorld);
	_m.decompose(_p, _q, _s);
	_e.setFromQuaternion(_q, 'XYZ');
	const r6 = (/** @type {number} */ v) => Math.round(v * 1e6) / 1e6;
	return { pos: [r6(_p.x), r6(_p.y), r6(_p.z)], rot: [r6(_e.x), r6(_e.y), r6(_e.z)], scale: [r6(_s.x), r6(_s.y), r6(_s.z)] };
}

/** Scene.svelte's objectChange for the proxy: the level follows live, locally. */
export function onLodProxyMoved() {
	const offset = currentOffset();
	if (!offset || !target) return;
	updateLodLevel(target.uuid, target.level, { offset }, { preview: true });
}

/** Scene.svelte's dragging-changed for the proxy: release = ONE undoable, replicated write.
 * @param {boolean} dragging */
export function onLodProxyDragChanged(dragging) {
	if (!target) return;
	if (dragging) {
		gestureBefore = JSON.parse(JSON.stringify(editableGroupOf(target.uuid)));
		return;
	}
	const offset = currentOffset();
	if (offset) updateLodLevel(target.uuid, target.level, { offset }, { before: gestureBefore });
	gestureBefore = null;
}

/** Put level `level` back on its object (an undoable write). @param {string} uuid @param {number} level */
export function resetLevelOffset(uuid, level) {
	const ok = updateLodLevel(uuid, level, { offset: undefined });
	if (target && target.uuid === uuid && target.level === level) startLevelGizmo(uuid, level);
	return ok;
}

// a new selection takes the gizmo with it: drop the proxy without fighting for the gizmo
selectedObjects.subscribe((set) => {
	if (target && !set.includes(target.uuid)) stopLevelGizmo({ reattach: false });
});
