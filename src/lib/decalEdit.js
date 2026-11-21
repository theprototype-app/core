// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, recordTransform, recordObjectPresence, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { normalizeDecal, isDecalObject, targetRefusal, decalPoseMatrix, DECAL_DEFAULTS } from './decalCore.js';
import { makeDecalCarrier, applyDecalTo } from './decalObject.js';
import { loadDecalRuntime } from './decalTick.js';
import { hasAnimatedImport } from './animatedImports.js';

// 102 M3: the ONE write path for decals — placing one (a carrier CHILD of the object it was
// put on: the create message + one presence undo step) and changing its record (one `props`
// undo entry + one `objectParameters 'decal'` message, the setTextPathFor shape). The clipped
// surface never travels: every peer builds it from the record and the target (decalRuntime).

/** the size of a fresh decal (metres: width, height, depth) */
export const DECAL_SIZE_DEFAULT = Object.freeze([0.5, 0.5, 0.25]);
const SIZE_MIN = 0.01;
const SIZE_MAX = 50;

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid);

/** the last placement refused, and why (the agent tool reads it) @type {string | null} */
let lastRefusal = null;
export const lastDecalRefusal = () => lastRefusal;

/**
 * The top-level object a hit belongs to (a decal goes on it, as its child), or null.
 * @param {any} hit the intersected mesh
 */
export function decalHostOf(hit) {
	const group = get(objectsGroup);
	let current = hit;
	while (current?.parent && current.parent !== group) current = current.parent;
	return current?.parent === group ? current : null;
}

/**
 * What refuses a host: facts read off the hit and the host's tree (the runtime re-checks).
 * @param {any} hit @param {any} host @returns {string | null}
 */
export function decalRefusalFor(hit, host) {
	if (!hit || !host) return targetRefusal({ none: true });
	if (isDecalObject(hit)) return targetRefusal({ decal: true });
	const facts = { skinned: false, scattered: false, instanced: !!hit.isInstancedMesh, tris: 0, none: false, animatedFile: hasAnimatedImport(host.uuid) };
	if (hit.isSkinnedMesh) facts.skinned = true;
	let meshes = 0;
	host.traverse((/** @type {any} */ o) => {
		if (isDecalObject(o)) return;
		if (o.isSkinnedMesh) facts.skinned = true;
		if (o.userData?.scatterSet && o === hit) facts.scattered = true;
		if (o.isMesh && !o.isInstancedMesh && o.geometry?.attributes?.position) {
			meshes++;
			const g = o.geometry;
			facts.tris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
		}
	});
	if (!meshes && !facts.skinned && !facts.instanced) facts.none = true;
	return targetRefusal(facts);
}

/** @param {any} v @returns {number[]} */
export function clampDecalSize(v) {
	const src = Array.isArray(v) ? v : DECAL_SIZE_DEFAULT;
	return [0, 1, 2].map((i) => {
		const n = Number(src[i]);
		return Number.isFinite(n) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)) : DECAL_SIZE_DEFAULT[i];
	});
}

const m4 = new THREE.Matrix4();
const inv = new THREE.Matrix4();

/**
 * Place a decal where a ray hit a surface: centred on `point`, +Z along `normal` (both WORLD),
 * a child of the hit's top-level object. ONE undo step (a presence entry).
 * @param {any} hit the intersected mesh
 * @param {number[]} point world @param {number[]} normal world
 * @param {{ image?: string, imageName?: string, size?: number[], spin?: number, opacity?: number, tint?: string, roughness?: number, angle?: number, name?: string, quiet?: boolean }} [opts]
 * @returns {any | null} the carrier
 */
export function placeDecalOn(hit, point, normal, opts = {}) {
	const host = decalHostOf(hit);
	const refusal = decalRefusalFor(hit, host);
	lastRefusal = refusal;
	if (refusal) {
		if (!opts.quiet) showToast(refusal);
		return null;
	}
	if (!point?.every?.((/** @type {any} */ v) => Number.isFinite(v)) || !normal?.every?.((/** @type {any} */ v) => Number.isFinite(v))) {
		lastRefusal = 'A decal needs a point and a surface direction.';
		return null;
	}
	const size = clampDecalSize(opts.size);
	const rec = normalizeDecal({
		...DECAL_DEFAULTS,
		image: opts.image ?? '',
		imageName: opts.imageName ?? '',
		target: host.uuid,
		...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
		...(opts.tint !== undefined ? { tint: opts.tint } : {}),
		...(opts.roughness !== undefined ? { roughness: opts.roughness } : {}),
		...(opts.angle !== undefined ? { angle: opts.angle } : {})
	});
	const carrier = makeDecalCarrier(rec);
	if (opts.name) carrier.name = String(opts.name).slice(0, 120);
	// world pose -> the host's frame (the host may be scaled, rotated, inside a moved world rig)
	host.updateWorldMatrix(true, false);
	m4.fromArray(decalPoseMatrix(point, normal, size, Number(opts.spin) || 0));
	inv.copy(host.matrixWorld).invert();
	m4.premultiply(inv);
	m4.decompose(carrier.position, carrier.quaternion, carrier.scale);
	// toJSON writes `matrix` (the measurement rule: compose before the send)
	carrier.updateMatrix();
	host.add(carrier);
	void loadDecalRuntime();
	pokeScene();
	recordObjectPresence('create', carrier);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: carrier.toJSON(), groupuuid: host.uuid });
	return carrier;
}

/**
 * Change a decal's record (image, opacity, tint, roughness, wrap angle). A scrub is one undo
 * step through the history's gesture merge.
 * @param {string} uuid @param {any} patch @returns {import('./decalCore.js').DecalRecord | null}
 */
export function setDecalFor(uuid, patch) {
	const object = objectOf(uuid);
	if (!isDecalObject(object) || !patch || typeof patch !== 'object') return null;
	const before = normalizeDecal(object.userData.decal);
	const next = normalizeDecal({ ...before, ...patch, target: before.target });
	if (JSON.stringify(next) === JSON.stringify(before)) return before;
	applyDecalTo(object, next);
	recordEntry({ kind: 'props', uuid, before: { decal: before }, after: { decal: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'decal', uuid, decal: next });
	pokeScene();
	return next;
}

/**
 * Size a decal (width, height, depth = its scale): the move message at once, and ONE transform
 * undo step — at once, or (a scrub: `record: false` per step) through `endDecalSizeScrub`.
 * @param {string} uuid @param {number[]} size @param {{ record?: boolean }} [opts]
 */
export function setDecalSize(uuid, size, opts = {}) {
	const object = objectOf(uuid);
	if (!isDecalObject(object)) return false;
	const [w, h, d] = clampDecalSize(size);
	const before = { pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() };
	object.scale.set(w, h, d);
	object.updateMatrix();
	const after = { pos: before.pos, rot: before.rot, scale: object.scale.toArray() };
	if (JSON.stringify(before.scale) === JSON.stringify(after.scale)) return true;
	if (opts.record !== false) recordTransform({ uuid, before, after });
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'move', uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	return true;
}

/**
 * A size scrub ended: one undo step from the scale it started at.
 * @param {string} uuid @param {number[]} startScale
 */
export function endDecalSizeScrub(uuid, startScale) {
	const object = objectOf(uuid);
	if (!isDecalObject(object) || !Array.isArray(startScale)) return;
	const pos = object.position.toArray();
	const rot = object.rotation.toArray();
	const scale = object.scale.toArray();
	if (JSON.stringify(scale) === JSON.stringify(startScale)) return;
	recordTransform({ uuid, before: { pos, rot, scale: startScale }, after: { pos, rot, scale } });
}

/**
 * The agent's / a template's decal: placed on `target` at a point + normal, or (no point) on the
 * face of the target that looks toward `from` (default: straight down onto its top).
 * @param {string} targetUuid @param {{ point?: number[], normal?: number[] } & Record<string, any>} spec
 * @returns {{ object: any | null, error: string | null }}
 */
export function placeDecalForAgent(targetUuid, spec) {
	const target = objectOf(targetUuid);
	if (!target) return { object: null, error: 'No object with uuid ' + targetUuid + ' to put the decal on.' };
	/** @type {any} */
	let hit = null;
	let point = spec.point;
	let normal = spec.normal;
	if (!point || !normal) {
		// aim at the target's middle from along -normal (default from above)
		const box = new THREE.Box3().setFromObject(target);
		if (box.isEmpty()) return { object: null, error: 'That object has no surface to put a decal on.' };
		const centre = box.getCenter(new THREE.Vector3());
		const dir = new THREE.Vector3().fromArray(normal ?? [0, 1, 0]).normalize().negate();
		const span = box.getSize(new THREE.Vector3()).length() + 1;
		const ray = new THREE.Raycaster(centre.clone().addScaledVector(dir, -span), dir, 0, span * 2);
		const hits = ray.intersectObject(target, true).filter((h) => !isDecalObject(h.object) && h.face);
		if (!hits.length) return { object: null, error: 'The direction given does not reach a surface of that object.' };
		const h = hits[0];
		hit = h.object;
		point = h.point.toArray();
		normal = /** @type {any} */ (h.face).normal.clone().transformDirection(h.object.matrixWorld).toArray();
	} else {
		hit = target;
		// a hit mesh inside the target: the first mesh under it (refusals read the whole tree anyway)
		target.traverse((/** @type {any} */ o) => {
			if (hit === target && o.isMesh && !isDecalObject(o)) hit = o;
		});
	}
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		const object = placeDecalOn(hit, /** @type {number[]} */ (point), /** @type {number[]} */ (normal), { ...spec, quiet: true });
		return { object, error: object ? null : lastRefusal };
	} finally {
		if (own) endHistoryBatch('Add a decal');
	}
}
