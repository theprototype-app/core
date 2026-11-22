// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, lockedObjects, globalScene, TControls, gizmoSuppressed, pokeScene } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { commitMeshGeoSnapshot } from './faceEdit';
import { sendMeshGeo } from './meshCommit';
import { MAX_SNAPSHOT, previewReplicable } from './meshBudget';
import { selectObject, deselectObject } from './objectActions';
import { nameOf } from './lockControl';
import {
	beginPaintStroke,
	paintStrokeMove,
	endPaintStroke,
	beginScatterStroke,
	scatterStrokeMove,
	isMeshHost,
	endScatterStroke,
	terrainStrokeOpen
} from './terrainPaint';
// 51 E4: the Scatter brush's edit tools (erase / rotate / scale / relax brushes, select)
import {
	scatterBrushArmed,
	beginEditStroke,
	editStrokeMove,
	endEditStroke,
	editStrokeOpen,
	startScatterEditSession,
	endScatterEditSession,
	clearScatterSelection
} from './scatterEdit';

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
/** 47 T1/T2: 'paint' (splat layers) and 'scatter' (instances) are terrain-only ops whose
 * strokes terrainPaint.js runs; the session, lock, radius and strength are shared.
 * @type {import('svelte/store').Writable<'raise'|'lower'|'smooth'|'flatten'|'paint'|'scatter'>} */
export const sculptOp = writable('raise');
/** 51-surface: true while a SCATTER session runs on a plain mesh that was entered for scatter only —
 * its geometry was left exactly as it is (no soup conversion, no size cap), so the shaping brushes
 * are not offered (Sculpt from the object menu gives them). */
export const sculptScatterOnly = writable(false);
export const sculptRadius = writable(3);
export const sculptStrength = writable(0.5);

/** @type {{uuid: string, attr: any, columns: Map<string, number[]>, colPos: {x: number, z: number, key: string, indices: number[]}[],
 *   neighbors: Map<string, string[]>, cell: number, hash: BrushHash | null} | null} */
let weld = null;
/** @type {Float32Array | null} stroke-start snapshot */
let strokeBefore = null;
let lastPreview = 0;
/** @type {any} scene-root brush cursor ring */
let cursor = null;

const KEY = (/** @type {number} */ x, /** @type {number} */ z) =>
	Math.round(x * 1e4) + '|' + Math.round(z * 1e4);

// ---- 99 K6: the brush's "who is inside the radius" on the kernel's SpatialHash ----------------------------------
// Both brushes used to scan EVERY welded vertex twice per dab (once for the nearest, once for the radius). They ask a
// SpatialHash now (meshKernel/spatialHash.js, CSR-packed, a query visits only the cells its radius touches). The hash
// is a cache over the weld map and lives ON it, so it dies with it: every rebuild (enter, the applyMeshGeo hook after
// a remote stroke / undo, the position-ATTRIBUTE identity guard) drops it — the stale-cache guarantee is the weld
// map's own. TERRAIN indexes each column's (x, 0, z): a terrain stroke only moves Y, so that hash never goes stale.
// MESH indexes the group positions at build time and keeps `drift` = the furthest any group moved since, and every
// query is padded by it — so a group that moved INTO the radius is still found. MEASURED (zzBenchSculpt99, report
// ROW3): rebuilt once per stroke (beginStroke), and again when the drift passes half a cell or the radius leaves
// [cell / 4, cell * 2]; per-dab rebuilds cost more than the scans they replace. Every candidate list is visited in
// ASCENDING index order — the linear scan's order — because smooth reads its neighbours in place (Gauss-Seidel), so
// the order is part of the result. Parity with the pre-K6 brush: tests/unit/sculptHash99.test.js.
// The class is loaded LAZILY (enterSculpt / the first dab): this module is in the boot graph and the hash is not
// needed to draw a frame. Until it lands a dab scans every vertex as before (same result, slower), so no dab is lost.

/** @typedef {import('./sculptHash.js').BrushHash} BrushHash */

/** @type {any} the lazy helpers (sculptHash.js, with the kernel's SpatialHash) once loaded */
let H = null;
/** @type {Promise<boolean> | null} */
let hashLoading = null;
/** 'adaptive' (the measured default) | 'stroke' (never re-index for drift) | 'dab' (rebuild every dab) | 'scan' (no hash) */
let hashPolicy = 'adaptive';
const hashStats = { builds: 0, hashed: 0, scanned: 0 };

/** Load the SpatialHash (idempotent; resolves true once the brush can use it). */
export function sculptHashReady() {
	if (!hashLoading)
		hashLoading = import('./sculptHash.js').then(
			(m) => {
				m.setup(hashStats, () => hashPolicy);
				H = m;
				return true;
			},
			() => {
				hashLoading = null;
				return false;
			}
		);
	return hashLoading;
}

/** Suites / benches: the brush hash's state, optionally switching the rebuild policy.
 * @param {'adaptive'|'stroke'|'dab'|'scan'} [policy] */
export function sculptHashDebug(policy) {
	if (policy) hashPolicy = policy;
	return { ready: !!H, policy: hashPolicy, ...hashStats };
}

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
	if (H && hashPolicy !== 'scan' && colPos.length) {
		// 99 K6: the same box test over the hash's candidates (the box sits inside its circumcircle), in colPos order
		const xz = H.columnXZ(colPos);
		const h = H.buildBrushHash(xz, colPos.length, reach);
		for (let ai = 0; ai < colPos.length; ai++) {
			const a = colPos[ai];
			const count = H.ascendingWithin(h, colPos.length, a.x, 0, a.z, H.pad(reach * Math.SQRT2));
			const list = [];
			for (let k = 0; k < count; k++) {
				const b = colPos[H.cand[k]];
				if (a === b) continue;
				if (Math.abs(a.x - b.x) <= reach && Math.abs(a.z - b.z) <= reach) list.push(b.key);
			}
			neighbors.set(a.key, list);
		}
	} else
		for (const a of colPos) {
			const list = [];
			for (const b of colPos) {
				if (a === b) continue;
				if (Math.abs(a.x - b.x) <= reach && Math.abs(a.z - b.z) <= reach) list.push(b.key);
			}
			neighbors.set(a.key, list);
		}
	weld = { uuid: object.uuid, attr: position, columns, colPos, neighbors, cell, hash: null };
	return weld;
}

/** the terrain brush hash: columns never move in x/z, so only a radius change rebuilds it
 * @param {NonNullable<typeof weld>} map @param {number} radius */
function terrainHashFor(map, radius) {
	void sculptHashReady();
	if (!H || hashPolicy === 'scan' || !map.colPos.length || !(radius > 0 && radius < Infinity)) return null;
	if (!H.hashFits(map.hash, radius)) map.hash = H.buildBrushHash(H.columnXZ(map.colPos), map.colPos.length, radius);
	return map.hash;
}

// ---- MESH sculpt (CL-B follow-up): normal-direction brush on any mesh ------
// Weld by FULL (x,y,z) position (split copies of a logical vertex move
// together), neighbors from triangle adjacency (for smooth), displacement
// along each welded vertex's averaged normal.

/** @type {{uuid: string, attr: any, groups: {indices: number[], pos: any}[],
 *   neighbors: Map<number, Set<number>>, hash: BrushHash | null} | null} */
let meshWeld = null;

/** the mesh brush hash over the group positions (indexed at build; `drift` pads the queries since)
 * @param {NonNullable<typeof meshWeld>} map @param {number} radius */
function meshHashFor(map, radius) {
	void sculptHashReady();
	const n = map.groups.length;
	if (!H || hashPolicy === 'scan' || !n || !(radius > 0 && radius < Infinity)) return null;
	if (H.hashFits(map.hash, radius)) return map.hash;
	const pos = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		const p = map.groups[i].pos;
		pos[i * 3] = p.x;
		pos[i * 3 + 1] = p.y;
		pos[i * 3 + 2] = p.z;
	}
	return (map.hash = H.buildBrushHash(pos, n, radius));
}

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
	meshWeld = { uuid: object.uuid, attr: position, groups, neighbors, hash: null };
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
	// (a non-finite centre scans, as before: no window can hold it)
	const h = Number.isFinite(x + y + z) ? meshHashFor(map, radius) : null;
	const groups = map.groups;
	// the hit group (nearest) anchors flatten's tangent plane (only flatten reads it)
	let hit = null;
	if (op === 'flatten') {
		if (h) {
			const gi = H.nearestVia(h, x, y, z, radius, (/** @type {number} */ i) => groups[i].pos.distanceTo(center));
			hit = gi >= 0 ? groups[gi] : null;
		} else {
			let hitDist = Infinity;
			for (const g of groups) {
				const d = g.pos.distanceTo(center);
				if (d < hitDist) {
					hitDist = d;
					hit = g;
				}
			}
		}
	}
	const hitNormal = hit ? groupNormal(hit) : new THREE.Vector3(0, 1, 0);
	const hitPos = hit ? hit.pos.clone() : center;
	let touched = false;
	const next = new THREE.Vector3();
	const count = h ? H.ascendingWithin(h, groups.length, x, y, z, H.pad(radius) + h.drift) : groups.length;
	hashStats[h ? 'hashed' : 'scanned']++;
	for (let k = 0; k < count; k++) {
		const gi = h ? H.cand[k] : k;
		const g = groups[gi];
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
			if (h) {
				const moved = Math.hypot(next.x - h.pos[gi * 3], next.y - h.pos[gi * 3 + 1], next.z - h.pos[gi * 3 + 2]);
				if (moved > h.drift) h.drift = moved;
			}
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

/** hard cap on a sculptable mesh — the meshgeo COMMIT limit (floats). It used to
 * be the same 45000 as the preview, which refused to sculpt anything an artist
 * would actually import; the two are separate numbers now (meshBudget.js). */
const MESH_SCULPT_MAX_FLOATS = MAX_SNAPSHOT;

/** Enter sculpt mode: Terrain gets the column brush, any other mesh the
 * normal brush (selects = locks it either way). 51-surface: `{scatter: true}` on a plain mesh opens
 * a SCATTER-ONLY session — the scatter brush paints on its surface and the geometry is never touched
 * (so a 100k-triangle import is fine, and nothing is converted or sent).
 * @param {string} uuid @param {{scatter?: boolean}} [opts] */
export function enterSculpt(uuid, opts = {}) {
	const object = objectOf(uuid);
	if (!object) return false;
	const isTerrain = !!object.userData?.terrain;
	if (!isTerrain && opts.scatter) return enterMeshScatter(uuid, object);
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
		// 99 K2: meshCommit's one sender (raw Float32 bytes, positions only)
		sendMeshGeo(uuid, nonIndexed.getAttribute('position').array);
	}
	void sculptHashReady(); // 99 K6: the brush hash class (lazy; dabs scan until it lands)
	if (isTerrain) rebuildWeldMap(object);
	else rebuildMeshWeldMap(object);
	sculptMode.set(isTerrain ? 'terrain' : 'mesh');
	sculptScatterOnly.set(false);
	// paint has no meaning on a plain mesh (no splat map); scatter does since 51-surface
	if (!isTerrain && get(sculptOp) === 'paint') sculptOp.set('raise');
	sculptObject.set(uuid);
	if (isTerrain) startScatterEditSession(() => get(sculptObject), () => get(sculptOp) === 'scatter' && get(sculptMode) === 'terrain');
	return true;
}

/** 51-surface: the scatter-only session on a plain mesh (see enterSculpt). @param {string} uuid @param {any} object */
function enterMeshScatter(uuid, object) {
	if (!isMeshHost(object)) {
		showToast('Scatter works on a mesh object');
		return false;
	}
	const lock = get(lockedObjects).find((entry) => entry[1] === uuid);
	if (lock) {
		showToast('Locked by ' + nameOf(lock[0]));
		return false;
	}
	gizmoSuppressed.set(true);
	selectObject(uuid);
	weld = null;
	meshWeld = null;
	sculptMode.set('mesh');
	sculptScatterOnly.set(true);
	sculptOp.set('scatter');
	sculptObject.set(uuid);
	return true;
}

export function exitSculpt() {
	if (strokeBefore || terrainStrokeOpen() || editStrokeOpen()) endStroke(); // commit a stroke in flight
	sculptScatterOnly.set(false);
	endScatterEditSession();
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
	const h = Number.isFinite(x + z) ? terrainHashFor(map, radius) : null;
	const colPos = map.colPos;
	// the hit column (nearest) for flatten's target height (only flatten reads it)
	let hitKey = null;
	if (op === 'flatten') {
		if (h) {
			const ci = H.nearestVia(h, x, 0, z, radius, (/** @type {number} */ i) => Math.hypot(colPos[i].x - x, colPos[i].z - z));
			hitKey = ci >= 0 ? colPos[ci].key : null;
		} else {
			let hitDist = Infinity;
			for (const col of colPos) {
				const d = Math.hypot(col.x - x, col.z - z);
				if (d < hitDist) {
					hitDist = d;
					hitKey = col.key;
				}
			}
		}
	}
	const targetHeight = hitKey ? heightOf(hitKey) : 0;

	let touched = false;
	const count = h ? H.ascendingWithin(h, colPos.length, x, 0, z, H.pad(radius)) : colPos.length;
	hashStats[h ? 'hashed' : 'scanned']++;
	for (let k = 0; k < count; k++) {
		const col = colPos[h ? H.cand[k] : k];
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

/** 47: is the current op a terrainPaint stroke? Paint = a terrain only; scatter = any mesh (51-surface).
 * 51 E4: 'scatter-edit' = the Scatter brush with an edit tool armed (scatterEdit.js runs it) —
 * on a terrain only (a mesh host keeps Paint + the 47 erase). */
function paintOp() {
	const op = get(sculptOp);
	if (op === 'scatter') return get(sculptMode) === 'terrain' && scatterBrushArmed() ? 'scatter-edit' : op;
	return get(sculptMode) === 'terrain' && op === 'paint' ? op : null;
}

/** Stroke begin: snapshot for the ONE undo entry per stroke. @param {string} uuid */
export function beginStroke(uuid) {
	const op = paintOp();
	if (op === 'paint') return void beginPaintStroke(uuid);
	if (op === 'scatter') return void beginScatterStroke(uuid);
	if (op === 'scatter-edit') return void beginEditStroke(uuid);
	const object = objectOf(uuid);
	if (!object?.geometry?.attributes?.position) return;
	strokeBefore = object.geometry.attributes.position.array.slice();
	// 99 K6: one mesh-hash build per stroke (the first dab re-indexes; drift starts at 0 again)
	if (meshWeld) meshWeld.hash = null;
}

/** Per-move during a stroke: brush + throttled preview (~5/s). `y` feeds the
 * 3D mesh brush (the terrain brush works in the xz plane and ignores it).
 * @param {string} uuid @param {number} x @param {number} z @param {number=} dt @param {number=} y */
export function strokeMove(uuid, x, z, dt = 0.016, y = 0) {
	const paint = paintOp();
	if (paint === 'paint') return paintStrokeMove(uuid, x, z, dt, get(sculptRadius), get(sculptStrength));
	if (paint === 'scatter') return scatterStrokeMove(uuid, x, z, get(sculptRadius), y);
	if (paint === 'scatter-edit') return editStrokeMove(uuid, x, z, get(sculptRadius), get(sculptStrength), dt);
	if (!strokeBefore) return;
	const op = /** @type {'raise'|'lower'|'smooth'|'flatten'} */ (get(sculptOp));
	const changed =
		get(sculptMode) === 'mesh'
			? applyMeshBrushAt(uuid, x, y, z, op, get(sculptRadius), get(sculptStrength), dt)
			: applyBrushAt(uuid, x, z, op, get(sculptRadius), get(sculptStrength), dt);
	if (!changed) return;
	const now = performance.now();
	if (now - lastPreview > 200) {
		const object = objectOf(uuid);
		// The same preview trade the face tools make (see meshBudget.js): a stroke on
		// a dense mesh would stream megabytes 5×/s to every peer. Above the preview
		// ceiling the brush stays LOCAL and the stroke's ONE end-of-stroke commit
		// carries the result — peers see where you got to, not every pass.
		const floats = object?.geometry?.attributes?.position?.array?.length ?? 0;
		// 99 K2: meshCommit's one sender (positions only); false = offline, nothing sent
		if (object && previewReplicable(floats) && sendMeshGeo(uuid, object.geometry.attributes.position.array))
			lastPreview = now;
	}
	pokeScene();
}

/** Stroke end: flush the pending preview + ONE snapshot commit + undo entry. */
export function endStroke() {
	if (terrainStrokeOpen() || editStrokeOpen()) {
		endPaintStroke();
		endScatterStroke();
		endEditStroke();
		return;
	}
	const uuid = get(sculptObject);
	const object = uuid ? objectOf(uuid) : null;
	if (!strokeBefore || !object) {
		strokeBefore = null;
		return;
	}
	const before = strokeBefore;
	const after = object.geometry.attributes.position.array;
	strokeBefore = null;
	if (uuid && positionsDiffer(before, after)) commitMeshGeoSnapshot(uuid, Array.from(before), Array.from(after));
}

/** 99 K6: did the stroke move anything? The typed-array form of the JSON.stringify compare it replaces, with the
 * same answer: a length change differs, and two values are equal when === or both non-finite (JSON writes NaN and
 * ±Infinity alike as null; -0 and 0 alike as 0). @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function positionsDiffer(a, b) {
	if (a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x !== y && (Number.isFinite(x) || Number.isFinite(y))) return true;
	}
	return false;
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
	// 52 (V3): the radius is in the host's own metres — a scaled host (a miniature world, 52 V5) draws it at
	// its world size; an unscaled one is 1 and unchanged
	const host = objectOf(get(sculptObject) ?? '');
	const k = host ? host.getWorldScale(_cursorScale).x : 1;
	const r = get(sculptRadius) * (k > 0 ? k : 1);
	cursor.scale.set(r, r, r);
}
const _cursorScale = new THREE.Vector3();
/** 52 (V3): the brush ring's world radius + where it is, for the suites */
export function cursorDebug() {
	return cursor ? { visible: !!cursor.visible, radius: cursor.scale.x, pos: cursor.position.toArray() } : null;
}

export function hideCursor() {
	if (cursor) cursor.visible = false;
}

// 51 E4: the instance selection belongs to the Scatter brush's Select tool — another brush
// drops it (sits LAST: a module-level subscribe runs at once, the TDZ rule)
sculptOp.subscribe((op) => {
	if (op !== 'scatter') clearScatterSelection();
});
