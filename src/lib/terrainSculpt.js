// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, lockedObjects, globalScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { commitMeshGeoSnapshot } from './faceEdit';
import { selectObject, deselectObject } from './objectActions';
import { nameOf } from './lockControl';

// Terrain sculpting (T-2): brush raise/lower/smooth/flatten on the Terrain
// primitive, replicated through the EXISTING meshgeo channel — live strokes
// stream throttled previews (~5/s, the live-face-grab pattern) and commit ONE
// full snapshot + ONE undo entry per stroke (commitMeshGeoSnapshot). The
// correctness trap: applyMeshGeo makes geometry NON-INDEXED, splitting each
// logical vertex across up to 6 triangles — but sculpting only ever moves Y
// and x/z never change, so welding by QUANTIZED (x,z) COLUMN groups the split
// copies permanently: the map stays valid across strokes, undo and remote
// swaps (it is rebuilt on any applyMeshGeo for the sculpted object). Entering
// sculpt SELECTS the terrain (selection = lock), so peers can't edit it too.

/** @type {import('svelte/store').Writable<string | null>} uuid being sculpted */
export const sculptObject = writable(null);
/** @type {import('svelte/store').Writable<'raise'|'lower'|'smooth'|'flatten'>} */
export const sculptOp = writable('raise');
export const sculptRadius = writable(3);
export const sculptStrength = writable(0.5);

/** @type {{uuid: string, columns: Map<string, number[]>, colPos: {x: number, z: number, key: string, indices: number[]}[],
 *   neighbors: Map<string, string[]>, cell: number} | null} */
let weld = null;
/** @type {Float32Array | null} stroke-start snapshot */
let strokeBefore = null;
let lastPreview = 0;
/** @type {any} scene-root brush cursor ring */
let cursor = null;

const KEY = (/** @type {number} */ x, /** @type {number} */ z) =>
	Math.round(x * 1e4) + '|' + Math.round(z * 1e4);

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/**
 * Build (or rebuild) the weld map: every position index grouped by its
 * quantized (x,z) column + each column's smooth-neighbors (within 1.5 cells).
 * Called on enter AND whenever applyMeshGeo swaps the sculpted geometry
 * (remote stroke / undo) — the stale-cache class golden rule 6 warns about.
 * @param {any} object
 */
export function rebuildWeldMap(object) {
	const position = object?.geometry?.attributes?.position;
	if (!position) return (weld = null);
	/** @type {Map<string, number[]>} */
	const columns = new Map();
	for (let i = 0; i < position.count; i++) {
		const key = KEY(position.getX(i), position.getZ(i));
		let list = columns.get(key);
		if (!list) columns.set(key, (list = []));
		list.push(i);
	}
	const colPos = [...columns.entries()].map(([key, indices]) => ({
		x: position.getX(indices[0]),
		z: position.getZ(indices[0]),
		key,
		indices
	}));
	// cell spacing: the median gap between neighboring distinct x values
	const xs = [...new Set(colPos.map((c) => Math.round(c.x * 1e4)))].sort((a, b) => a - b);
	let cell = 0.5;
	if (xs.length > 1) {
		const gaps = [];
		for (let i = 1; i < xs.length; i++) gaps.push((xs[i] - xs[i - 1]) / 1e4);
		gaps.sort((a, b) => a - b);
		cell = gaps[Math.floor(gaps.length / 2)] || 0.5;
	}
	// smooth-neighbors: columns within 1.5 cells (grid-adjacent incl. diagonals)
	/** @type {Map<string, string[]>} */
	const neighbors = new Map();
	const reach = cell * 1.55;
	for (const a of colPos) {
		const list = [];
		for (const b of colPos) {
			if (a === b) continue;
			if (Math.abs(a.x - b.x) <= reach && Math.abs(a.z - b.z) <= reach) list.push(b.key);
		}
		neighbors.set(a.key, list);
	}
	weld = { uuid: object.uuid, columns, colPos, neighbors, cell };
	return weld;
}

/** Enter sculpt mode on a terrain (selects = locks it). @param {string} uuid */
export function enterSculpt(uuid) {
	const object = objectOf(uuid);
	if (!object?.userData?.terrain) {
		showToast('Sculpting works on Terrain objects (Add ▸ Ground ▸ Terrain)');
		return false;
	}
	const lock = get(lockedObjects).find((entry) => entry[1] === uuid);
	if (lock) {
		showToast('Locked by ' + nameOf(lock[0]));
		return false;
	}
	selectObject(uuid);
	// first sculpt on a fresh terrain: go non-indexed LOCALLY + sync the
	// representation so peers' snapshots line up (no history entry — visually
	// identical geometry, nothing to undo)
	if (object.geometry.index) {
		const nonIndexed = object.geometry.toNonIndexed();
		object.geometry.dispose();
		object.geometry = nonIndexed;
		object.geometry.computeVertexNormals();
		/** @type {any} */
		const peer = get(peers);
		// raw Float32 bytes (the meshgeo wire format — a plain number array this
		// big blows binarypack's recursion, see faceEdit.broadcastMeshGeo)
		if (peer)
			peer.send({
				type: 'meshgeo',
				uuid,
				positions: new Float32Array(nonIndexed.getAttribute('position').array).buffer
			});
	}
	rebuildWeldMap(object);
	sculptObject.set(uuid);
	return true;
}

export function exitSculpt() {
	if (strokeBefore) endStroke(); // commit a stroke in flight
	sculptObject.set(null);
	weld = null;
	hideCursor();
	deselectObject();
}

/**
 * One brush application at a LOCAL-space point. Pure geometry math (exported
 * for headless tests). Op semantics: raise/lower move columns along Y with a
 * smoothstep falloff; flatten pulls toward the hit column's height; smooth
 * relaxes toward the neighbor average. @param {string} uuid
 * @param {number} x @param {number} z local-space brush center
 * @param {'raise'|'lower'|'smooth'|'flatten'} op
 * @param {number} radius @param {number} strength @param {number=} dt seconds
 */
export function applyBrushAt(uuid, x, z, op, radius, strength, dt = 0.016) {
	const object = objectOf(uuid);
	const position = object?.geometry?.attributes?.position;
	if (!object || !position) return false;
	if (!weld || weld.uuid !== uuid) rebuildWeldMap(object);
	if (!weld) return false;
	const map = weld; // narrowed non-null for the closures below

	// column height = its first index's Y (all copies share it by invariant)
	const heightOf = (/** @type {string} */ key) => {
		const list = map.columns.get(key);
		return list ? position.getY(list[0]) : 0;
	};
	// the hit column (nearest) for flatten's target height
	let hitKey = null;
	let hitDist = Infinity;
	for (const col of map.colPos) {
		const d = Math.hypot(col.x - x, col.z - z);
		if (d < hitDist) {
			hitDist = d;
			hitKey = col.key;
		}
	}
	const targetHeight = hitKey ? heightOf(hitKey) : 0;

	let touched = false;
	for (const col of map.colPos) {
		const d = Math.hypot(col.x - x, col.z - z);
		if (d > radius) continue;
		// smoothstep falloff 1 -> 0 across the radius
		const t = 1 - d / radius;
		const w = t * t * (3 - 2 * t);
		const y = position.getY(col.indices[0]);
		let next = y;
		if (op === 'raise') next = y + strength * w * dt * 8;
		else if (op === 'lower') next = y - strength * w * dt * 8;
		else if (op === 'flatten') next = y + (targetHeight - y) * Math.min(w * strength, 1);
		else if (op === 'smooth') {
			const around = map.neighbors.get(col.key) ?? [];
			if (around.length) {
				const avg = around.reduce((sum, key) => sum + heightOf(key), 0) / around.length;
				next = y + (avg - y) * Math.min(w * strength, 1);
			}
		}
		if (next !== y) {
			for (const index of col.indices) position.setY(index, next);
			touched = true;
		}
	}
	if (touched) {
		position.needsUpdate = true;
		object.geometry.computeVertexNormals();
		object.geometry.computeBoundingSphere();
	}
	return touched;
}

/** Stroke begin: snapshot for the ONE undo entry per stroke. @param {string} uuid */
export function beginStroke(uuid) {
	const object = objectOf(uuid);
	if (!object?.geometry?.attributes?.position) return;
	strokeBefore = object.geometry.attributes.position.array.slice();
}

/** Per-move during a stroke: brush + throttled preview (~5/s).
 * @param {string} uuid @param {number} x @param {number} z @param {number=} dt */
export function strokeMove(uuid, x, z, dt = 0.016) {
	if (!strokeBefore) return;
	const op = get(sculptOp);
	const changed = applyBrushAt(uuid, x, z, op, get(sculptRadius), get(sculptStrength), dt);
	if (!changed) return;
	const now = performance.now();
	if (now - lastPreview > 200) {
		lastPreview = now;
		const object = objectOf(uuid);
		/** @type {any} */
		const peer = get(peers);
		if (peer && object)
			peer.send({
				type: 'meshgeo',
				uuid,
				positions: new Float32Array(object.geometry.attributes.position.array).buffer
			});
	}
	objectsGroup.update((v) => v);
}

/** Stroke end: flush the pending preview + ONE snapshot commit + undo entry. */
export function endStroke() {
	const uuid = get(sculptObject);
	const object = uuid ? objectOf(uuid) : null;
	if (!strokeBefore || !object) {
		strokeBefore = null;
		return;
	}
	const before = Array.from(strokeBefore);
	const after = Array.from(object.geometry.attributes.position.array);
	strokeBefore = null;
	if (uuid && JSON.stringify(before) !== JSON.stringify(after))
		commitMeshGeoSnapshot(uuid, before, after);
}

// ---- brush cursor (scene-root ring: never in objectsGroup -> never syncs) ---

export function showCursorAt(/** @type {any} */ worldPoint) {
	const scene = get(globalScene);
	if (!scene) return;
	if (!cursor) {
		cursor = new THREE.Mesh(
			new THREE.RingGeometry(0.9, 1, 32),
			new THREE.MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide })
		);
		cursor.name = 'sculpt-cursor';
		cursor.rotation.x = -Math.PI / 2;
		cursor.renderOrder = 997;
		scene.add(cursor);
	}
	cursor.visible = true;
	cursor.position.set(worldPoint.x, worldPoint.y + 0.02, worldPoint.z);
	const r = get(sculptRadius);
	cursor.scale.set(r, r, r);
}

export function hideCursor() {
	if (cursor) cursor.visible = false;
}
