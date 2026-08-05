// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, lockedObjects, globalScene, TControls, gizmoSuppressed } from '../stores/sceneStore';
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
/** CL-B follow-up: 'terrain' = the classic Y-column brush; 'mesh' = the
 * normal-direction brush for ANY mesh (welded by full xyz position).
 * @type {import('svelte/store').Writable<'terrain'|'mesh'>} */
export const sculptMode = writable('terrain');
/** @type {import('svelte/store').Writable<'raise'|'lower'|'smooth'|'flatten'>} */
export const sculptOp = writable('raise');
export const sculptRadius = writable(3);
export const sculptStrength = writable(0.5);

/** @type {{uuid: string, attr: any, columns: Map<string, number[]>, colPos: {x: number, z: number, key: string, indices: number[]}[],
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
	weld = { uuid: object.uuid, attr: position, columns, colPos, neighbors, cell };
	return weld;
}

// ---- MESH sculpt (CL-B follow-up): normal-direction brush on any mesh ------
// Weld by FULL (x,y,z) position (split copies of a logical vertex move
// together), neighbors from triangle adjacency (for smooth), displacement
// along each welded vertex's averaged normal.

/** @type {{uuid: string, attr: any, groups: {indices: number[], pos: any}[],
 *   neighbors: Map<number, Set<number>>} | null} */
let meshWeld = null;

const KEY3 = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
	Math.round(x * 1e4) + '|' + Math.round(y * 1e4) + '|' + Math.round(z * 1e4);

/** Build (or rebuild) the mesh weld map: position indices grouped by their
 * quantized xyz + tri-adjacency neighbors. Called on enter AND whenever
 * applyMeshGeo swaps the sculpted geometry. @param {any} object */
export function rebuildMeshWeldMap(object) {
	const position = object?.geometry?.attributes?.position;
	if (!position) return (meshWeld = null);
	/** @type {Map<string, number>} key -> group index */
	const byKey = new Map();
	/** @type {{indices: number[], pos: any}[]} */
	const groups = [];
	/** @type {number[]} position index -> group index */
	const groupOf = new Array(position.count);
	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i);
		const y = position.getY(i);
		const z = position.getZ(i);
		const key = KEY3(x, y, z);
		let gi = byKey.get(key);
		if (gi === undefined) {
			gi = groups.length;
			byKey.set(key, gi);
			groups.push({ indices: [], pos: new THREE.Vector3(x, y, z) });
		}
		groups[gi].indices.push(i);
		groupOf[i] = gi;
	}
	// smooth-neighbors: groups sharing a triangle (non-indexed soup: 3i,3i+1,3i+2)
	/** @type {Map<number, Set<number>>} */
	const neighbors = new Map();
	const link = (/** @type {number} */ a, /** @type {number} */ b) => {
		if (a === b) return;
		let set = neighbors.get(a);
		if (!set) neighbors.set(a, (set = new Set()));
		set.add(b);
	};
	for (let t = 0; t + 2 < position.count; t += 3) {
		const a = groupOf[t];
		const b = groupOf[t + 1];
		const c = groupOf[t + 2];
		link(a, b);
		link(b, a);
		link(b, c);
		link(c, b);
		link(c, a);
		link(a, c);
	}
	meshWeld = { uuid: object.uuid, attr: position, groups, neighbors };
	return meshWeld;
}

/**
 * One mesh-brush application at a LOCAL-space point (pure geometry math,
 * exported for headless tests). Op semantics mirror the terrain brush but in
 * 3D: raise/lower displace welded vertices along their averaged NORMAL with
 * a smoothstep falloff; flatten pulls toward the tangent plane at the hit
 * point; smooth relaxes toward the neighbor average (Laplacian).
 * @param {string} uuid @param {number} x @param {number} y @param {number} z
 * @param {'raise'|'lower'|'smooth'|'flatten'} op
 * @param {number} radius @param {number} strength @param {number=} dt seconds
 */
export function applyMeshBrushAt(uuid, x, y, z, op, radius, strength, dt = 0.016) {
	const object = objectOf(uuid);
	const position = object?.geometry?.attributes?.position;
	const normal = object?.geometry?.attributes?.normal;
	if (!object || !position || !normal) return false;
	// attr identity: never brush against a stale cache (see applyBrushAt)
	if (!meshWeld || meshWeld.uuid !== uuid || meshWeld.attr !== position) rebuildMeshWeldMap(object);
	if (!meshWeld) return false;
	const map = meshWeld;
	const center = new THREE.Vector3(x, y, z);
	/** averaged (welded) normal of a group @param {any} g */
	const groupNormal = (g) => {
		const n = new THREE.Vector3();
		for (const i of g.indices) n.add(new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i)));
		return n.lengthSq() > 1e-12 ? n.normalize() : n.set(0, 1, 0);
	};
	// the hit group (nearest) anchors flatten's tangent plane
	let hit = null;
	let hitDist = Infinity;
	for (const g of map.groups) {
		const d = g.pos.distanceTo(center);
		if (d < hitDist) {
			hitDist = d;
			hit = g;
		}
	}
	const hitNormal = hit ? groupNormal(hit) : new THREE.Vector3(0, 1, 0);
	const hitPos = hit ? hit.pos.clone() : center;
	let touched = false;
	const next = new THREE.Vector3();
	for (let gi = 0; gi < map.groups.length; gi++) {
		const g = map.groups[gi];
		const d = g.pos.distanceTo(center);
		if (d > radius) continue;
		// smoothstep falloff 1 -> 0 across the radius
		const t = 1 - d / radius;
		const w = t * t * (3 - 2 * t);
		next.copy(g.pos);
		if (op === 'raise') next.addScaledVector(groupNormal(g), strength * w * dt * 8);
		else if (op === 'lower') next.addScaledVector(groupNormal(g), -strength * w * dt * 8);
		else if (op === 'flatten') {
			const off = next.clone().sub(hitPos).dot(hitNormal);
			next.addScaledVector(hitNormal, -off * Math.min(w * strength, 1));
		} else if (op === 'smooth') {
			const around = map.neighbors.get(gi);
			if (around && around.size) {
				const avg = new THREE.Vector3();
				around.forEach((ni) => avg.add(map.groups[ni].pos));
				avg.multiplyScalar(1 / around.size);
				next.lerp(avg, Math.min(w * strength, 1));
			}
		}
		if (!next.equals(g.pos)) {
			g.pos.copy(next);
			for (const i of g.indices) position.setXYZ(i, next.x, next.y, next.z);
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

/** applyMeshGeo hook: rebuild whichever weld cache the live session uses (a
 * remote stroke / undo swapped the geometry). @param {any} object */
export function rebuildSculptCaches(object) {
	if (get(sculptMode) === 'mesh') rebuildMeshWeldMap(object);
	else rebuildWeldMap(object);
}

/** hard cap on a sculptable mesh — the meshgeo snapshot limit (floats) */
const MESH_SCULPT_MAX_FLOATS = 45000;

/** Enter sculpt mode: Terrain gets the column brush, any other mesh the
 * normal brush (selects = locks it either way). @param {string} uuid */
export function enterSculpt(uuid) {
	const object = objectOf(uuid);
	if (!object) return false;
	const isTerrain = !!object.userData?.terrain;
	if (!isTerrain && (!object.isMesh || !object.geometry?.attributes?.position)) {
		showToast('Sculpting works on meshes (Terrain gets the height brush)');
		return false;
	}
	// non-indexed size is what replicates — check BEFORE converting
	const soupFloats =
		(object.geometry.index ? object.geometry.index.count : object.geometry.attributes.position.count) * 3;
	if (!isTerrain && soupFloats > MESH_SCULPT_MAX_FLOATS) {
		showToast('Mesh too detailed to sculpt-sync (' + soupFloats / 3 + ' verts)');
		return false;
	}
	const lock = get(lockedObjects).find((entry) => entry[1] === uuid);
	if (lock) {
		showToast('Locked by ' + nameOf(lock[0]));
		return false;
	}
	// no gizmo while sculpting (accidental moves) — set BEFORE the select
	// so applySelectionSet never attaches; resets to OFF on every sculpt entry,
	// the toolbar toggle opts back in per session
	gizmoSuppressed.set(true);
	selectObject(uuid);
	// first sculpt on a fresh object: go non-indexed LOCALLY + sync the
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
	if (isTerrain) rebuildWeldMap(object);
	else rebuildMeshWeldMap(object);
	sculptMode.set(isTerrain ? 'terrain' : 'mesh');
	sculptObject.set(uuid);
	return true;
}

export function exitSculpt() {
	if (strokeBefore) endStroke(); // commit a stroke in flight
	sculptObject.set(null);
	weld = null;
	meshWeld = null;
	sculptMode.set('terrain');
	hideCursor();
	gizmoSuppressed.set(false);
	deselectObject();
}

/** SculptToolbar gizmo toggle: opt back into the transform gizmo mid-sculpt. @param {boolean} enabled */
export function setSculptGizmo(enabled) {
	gizmoSuppressed.set(!enabled);
	const uuid = get(sculptObject);
	const object = uuid ? objectOf(uuid) : null;
	/** @type {any} */
	const controls = get(TControls);
	if (!object || !controls) return;
	if (enabled) controls.attach(object);
	else controls.detach();
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
	// attr identity: a meshgeo swap (remote stroke/undo) replaces the attribute
	// — never brush against a stale cache, even same-tick (the async rebuild
	// hook in applyMeshGeo may not have run yet)
	if (!weld || weld.uuid !== uuid || weld.attr !== position) rebuildWeldMap(object);
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

/** Per-move during a stroke: brush + throttled preview (~5/s). `y` feeds the
 * 3D mesh brush (the terrain brush works in the xz plane and ignores it).
 * @param {string} uuid @param {number} x @param {number} z @param {number=} dt @param {number=} y */
export function strokeMove(uuid, x, z, dt = 0.016, y = 0) {
	if (!strokeBefore) return;
	const op = get(sculptOp);
	const changed =
		get(sculptMode) === 'mesh'
			? applyMeshBrushAt(uuid, x, y, z, op, get(sculptRadius), get(sculptStrength), dt)
			: applyBrushAt(uuid, x, z, op, get(sculptRadius), get(sculptStrength), dt);
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

export function showCursorAt(/** @type {any} */ worldPoint, /** @type {any} */ worldNormal = null) {
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
	// mesh sculpt: the ring hugs the surface (oriented to the hit normal);
	// terrain keeps the flat overhead ring
	if (worldNormal && get(sculptMode) === 'mesh') {
		cursor.rotation.set(0, 0, 0);
		cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
		cursor.position
			.set(worldPoint.x, worldPoint.y, worldPoint.z)
			.addScaledVector(worldNormal, 0.02);
	} else {
		cursor.quaternion.set(0, 0, 0, 1);
		cursor.rotation.x = -Math.PI / 2;
		cursor.position.set(worldPoint.x, worldPoint.y + 0.02, worldPoint.z);
	}
	const r = get(sculptRadius);
	cursor.scale.set(r, r, r);
}

export function hideCursor() {
	if (cursor) cursor.visible = false;
}
