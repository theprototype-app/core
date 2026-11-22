// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, globalCamera, objectsGroup, TControls, lockedObjects, isVRMode, pokeScene } from '../stores/sceneStore';
// 15-F: session-scoped undo — editSession imports ONLY history (an edge we
// already have), so this closes no cycle
import { noteEditEnter, noteEditExit, noteSelectionIds, sealEditHistorySession, captureEntry, geometryChanged, loadKernelOps } from './editSession';
import { session as editSession } from './editSessionState';
import { peers, showToast, settingsOpen, settingsSection } from '../stores/appStore';
import {
	registerHistoryKind,
	recordEntry,
	retractEntry,
	recordObjectPresence,
	beginHistoryBatch,
	endHistoryBatch,
	undoStack
} from './history';
// STORED topology (phase 1). meshTopology imports nothing — no cycle to worry about.
import {
	readStoredFaces,
	storeFaces,
	clearStoredFaces,
	facesWireFields,
	applyFacesWire,
	carryFaces,
	packFaces,
	composeFaces,
	appendOrigin,
	appendedQuads
} from './meshTopology';
// 18-A: LOCAL viewport line colours (store-only module, imports nothing — no cycle)
import { viewPrefs, editWireOverride } from './viewPrefs';
// W9: where the viewport is. A leaf (svelte/store + sceneStore), so it adds no edge
// out of the history-cycle family this module belongs to.
import { canvasRect } from './canvasRect';
// The size ceilings, and the measurement behind them. Another import-nothing leaf.
import { MAX_SNAPSHOT, previewReplicable, tooLargeMessage } from './meshBudget';
// 99 K2: the one commit shape + the one meshgeo sender (pure half of commitMesh)
import { compactMeshState, sendMeshGeo, shareIds, stateFaceFields } from './meshCommit';
import { editOverlaysParked } from './editOverlays';
// 19-A P3: the desktop pane's extrude/inset extras, read at BEGIN so a click-
// extrude matches the toolbox's Apply. meshToolParams is a svelte/store-only
// leaf, so this cannot close a cycle into history.
import { extrudeIndividual, insetDepth, insetIndividual, liveSymmetry, symAxis, symKeep } from './meshToolParams';
// 19-A P4: proportional editing shared with the vertex path. Both are LEAVES
// (proportional = svelte/store only; proportionalRing = three + sceneStore +
// proportional) — this module must NEVER import meshEdit (meshEdit imports us),
// which is exactly why the stores moved out of it.
import {
	proportionalEdit,
	proportionalRadius,
	falloffWeight,
	registerProportionalAnchor,
	beginProportionalWheel,
	endProportionalWheel
} from './proportional';
import { showProportionalRingAt, hideProportionalRing } from './proportionalRing';
import { safeStorage } from './safeStorage';
// the custom transform PIVOT (a LOCAL per-object pref). Another leaf — meshPivot
// imports THREE, the two stores and `proportional`, and nothing from here.
import {
	meshPivotLocal,
	registerMeshPivotListener,
	refreshMeshPivotMarker,
	disposeMeshPivotMarker,
	cancelMeshPivotPick,
	escapeConsumedByPivotPick,
	meshPivotMoving,
	cancelMeshPivotMove,
	escapeConsumedByPivotMove,
	commitMeshPivotDrag,
	setMeshPivotPreview
} from './meshPivot';
import { viewportHasKeys } from './keyScope'; // 36 U11
/** 99 K3: the face part of the one edit session */
const FS = editSession.face;

// Face editing core (118, pulled forward from pending/25 and scoped to VR
// blockout). Desktop-agnostic geometry math: read a BufferGeometry into a flat
// list of triangles, group coplanar+adjacent triangles into logical faces (a
// cube face is ONE face, not two tris), and rebuild the geometry for the four
// ops that cover ~90% of prototyping — extrude, inset, move-along-normal,
// delete. Topology changes can't ride the per-vertex `verts` channel, so every
// commit ships a full `meshgeo` snapshot (positions array + uuid, size-capped);
// receivers swap the geometry wholesale. History kind 'meshgeo' is undoable.

/**
 * Default face-edit cap — the number of triangles a session will OPEN on.
 *
 * D7 (roadmap 13) raised it from 300 to 1000 so the default sphere (960 tris)
 * edits out of the box. R3 (2026-08-17) is the first time it was MEASURED, on a
 * headless page, against the cost that actually decides how it feels — the LIVE
 * GRAB, which runs every frame:
 *
 *   tris     enterFaceEdit   grab step (per frame)
 *   528      8.7 ms          6.2 ms
 *   2 208    22 ms           12.3 ms
 *   9 800    87 ms           49 ms
 *   25 280   245 ms          151 ms
 *   67 080   822 ms          363 ms
 *
 * Roughly 5.4 microseconds per triangle per frame, so 16 ms (60fps) buys about
 * 3000 and 9800 already drags at 20fps. 2500 is the honest default: it opens
 * every primitive and most props, and it is the largest round number the
 * measurement supports. A headless page under load is the pessimistic end, so a
 * real desktop has headroom — which is why raising this in Settings ▸ VR (up to a
 * dense import) stays a supported thing to do rather than a warning.
 *
 * The SYNC ceilings are separate and much higher (meshBudget.js): this one is
 * about interaction cost, not about what can be replicated.
 */
export const VR_FACE_CAP = 2500;
/** D7: user-editable face-edit triangle limit (Settings ▸ VR, local pref)
 * @type {import('svelte/store').Writable<number>} */
export const vrFaceCap = writable(
	typeof localStorage !== 'undefined'
		? parseInt(safeStorage.getItem('vrFaceCap') ?? '') || VR_FACE_CAP
		: VR_FACE_CAP
);
if (typeof localStorage !== 'undefined')
	vrFaceCap.subscribe((value) => safeStorage.setItem('vrFaceCap', String(value)));

/** D7: over-limit / blocked-edit warning with a deep link into the Settings
 * VR section (works in noVR immediately; VR users see it on exit — on-device
 * surfacing stays a manual check). @param {string} message */
export function editCapToast(message) {
	showToast(message, [
		{
			label: 'Open Settings',
			action: () => {
				settingsSection.set('vr');
				settingsOpen.set(true);
			}
		}
	]);
}
// MAX_SNAPSHOT now lives in meshBudget.js (imported above) — one number for every
// module that used to keep its own copy of 45000.

// Coplanarity thresholds. Two names for one number, because they answer
// different questions: FACE_COPLANAR judges what a human calls ONE FLAT FACE
// (grouping, and the dissolve silhouette guard), QUAD_COPLANAR whether two
// triangles may be READ as a quad.
//
// They are equal on purpose, and loosening QUAD_COPLANAR does NOT fix the
// known gap: rotating an extruded band by 4 degrees twists each wall quad so
// its two triangles diverge by ~9 (measured), which is indistinguishable from
// a genuine 9-degree crease in a triangle SOUP - a threshold loose enough to
// keep the twisted quad would also pair across the segments of a smooth
// sphere. Only stored face topology can tell those apart, which is why the
// quad graph loses a rotated band today and why that is the topology
// workstream's job, not a constant's.
/** ~2.6 degrees */
const FACE_COPLANAR = 0.999;
/** ~2.6 degrees - see above before changing it */
const QUAD_COPLANAR = 0.999;
/** rounded position key @param {number} x @param {number} y @param {number} z */
function keyOf(x, y, z) {
	return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

/**
 * Union-find over welded vertex keys: the connected components ("shells") of
 * a triangle soup — a merged-in primitive is one shell, a plane floating off
 * a box is another. Shared by Shell granularity (CL-B) and custom-collider
 * piece splitting (CL-A A8). @param {any[]} tris @returns {number[][]} tri-index groups
 */
export function shellsOfTris(tris) {
	const n = tris.length;
	const parent = [...Array(n).keys()];
	const find = (/** @type {number} */ a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const union = (/** @type {number} */ a, /** @type {number} */ b) => {
		parent[find(a)] = find(b);
	};
	/** @type {Map<string, number>} first tri seen per welded vertex key */
	const byKey = new Map();
	tris.forEach((t, ti) => {
		for (const v of t) {
			const k = keyOf(v.x, v.y, v.z);
			const first = byKey.get(k);
			if (first === undefined) byKey.set(k, ti);
			else union(first, ti);
		}
	});
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let ti = 0; ti < n; ti++) {
		const root = find(ti);
		let list = groups.get(root);
		if (!list) groups.set(root, (list = []));
		list.push(ti);
	}
	return [...groups.values()];
}

// ---- CL-A A8: scene-root edit proxy ----------------------------------------
// The custom-collider session edits a PROXY mesh at the scene root (never in
// objectsGroup, so it can't leak into GLTF sync). objectsGroup lookups in the
// edit tools fall back to it; peers never learn its uuid, so replicated edit
// messages (verts/meshgeo/lock) NO-OP on their side.
/** @type {any} */ let editProxy = null;
/** @param {any} object the live proxy mesh, or null to clear */
export function registerEditProxy(object) {
	editProxy = object;
}
/** D1: meshEdit's live-session refresh hook — registered at ITS module eval
 * (meshEdit imports us; see the applyMeshGeo call site for why not import()).
 * @type {((uuid: string) => void) | null} */
let vertexSessionRefresher = null;
/** @param {(uuid: string) => void} fn */
export function registerVertexSessionRefresher(fn) {
	vertexSessionRefresher = fn;
}

/** objectsGroup lookup that also finds the registered edit proxy @param {string} uuid */
export function lookupEditable(uuid) {
	const found = get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
	if (found) return found;
	return editProxy && editProxy.uuid === uuid ? editProxy : null;
}

/** Carry a MATERIAL SLOT (and M1: the per-corner UVs) onto a triangle. Stored as
 * properties on the triangle array so every op that clones/filters/maps tris
 * keeps them without changing the [v0,v1,v2] shape every caller expects.
 * @param {any} tri @param {number=} mi @param {any=} uv */
function withSlot(tri, mi, uv) {
	tri.mi = mi || 0;
	if (uv) tri.uv = uv; // M1: per-corner [[u,v],[u,v],[u,v]], absent when untextured
	return tri;
}

/** element index -> material slot, read off a geometry's groups (0 when the
 * geometry is ungrouped) @param {any[]} groups @param {number} count */
function slotLookup(groups, count) {
	if (!groups?.length) return () => 0;
	const slots = new Int32Array(count);
	for (const group of groups) {
		const start = Math.max(group.start | 0, 0);
		const end = Math.min(start + (group.count | 0), count);
		for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
	}
	return (/** @type {number} */ i) => slots[i] || 0;
}

/**
 * Read a geometry into triangles [[Vector3,Vector3,Vector3], ...] (index
 * expanded). Each triangle also carries `mi` — the MATERIAL SLOT it came from
 * (15-G): a merged or imported mesh can wear a material ARRAY, and three draws
 * an array material by walking `geometry.groups`, so a swapped-in geometry with
 * no groups renders NOTHING AT ALL. @param {any} geometry
 */
export function readTriangles(geometry) {
	const pos = geometry.attributes.position;
	const uvAttr = geometry.attributes.uv;
	const index = geometry.index;
	const count = index ? index.count : pos.count;
	const slotAt = slotLookup(geometry.groups, count);
	const tris = [];
	for (let i = 0; i < count; i += 3) {
		const idx = (/** @type {number} */ o) => (index ? index.getX(i + o) : i + o);
		const vert = (/** @type {number} */ o) => {
			const j = idx(o);
			return new THREE.Vector3(pos.getX(j), pos.getY(j), pos.getZ(j));
		};
		const tri = withSlot([vert(0), vert(1), vert(2)], slotAt(i));
		// M1: carry TEXTURE COORDINATES through the edit. Every op used to rebuild
		// the geometry from positions alone, so editing a textured mesh silently
		// destroyed its mapping. `uv` is [[u,v],[u,v],[u,v]] per corner, or absent
		// when the source has no uv attribute (the overwhelmingly common case —
		// nothing extra is computed, stored or sent for those).
		if (uvAttr) tri.uv = [0, 1, 2].map((o) => [uvAttr.getX(idx(o)), uvAttr.getY(idx(o))]);
		tris.push(tri);
	}
	return tris;
}

/** M1: uv of a triangle corner, or [0,0] when the mesh is untextured.
 * @param {any} tri @param {number} corner */
function uvAt(tri, corner) {
	return tri?.uv ? tri.uv[corner] : [0, 0];
}

/** M1: linear blend of two uv pairs @param {number[]} a @param {number[]} b @param {number} t */
function uvLerp(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** @param {any[]} t triangle */
function triNormal(t) {
	return new THREE.Vector3()
		.subVectors(t[1], t[0])
		.cross(new THREE.Vector3().subVectors(t[2], t[0]))
		.normalize();
}

/**
 * Group triangles into logical faces: union triangles that share an edge AND
 * are coplanar (near-parallel normals). Returns [{triIndices, normal,
 * centroid}]. @param {any[]} tris
 */
export function groupFaces(tris) {
	const n = tris.length;
	const parent = [...Array(n).keys()];
	const find = (/** @type {number} */ a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const union = (/** @type {number} */ a, /** @type {number} */ b) => {
		parent[find(a)] = find(b);
	};
	const normals = tris.map(triNormal);
	/** @type {Map<string, number[]>} */
	const edgeMap = new Map();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k1 = keyOf(t[e].x, t[e].y, t[e].z);
			const k2 = keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z);
			const ek = [k1, k2].sort().join('|');
			if (!edgeMap.has(ek)) edgeMap.set(ek, []);
			/** @type {number[]} */ (edgeMap.get(ek)).push(ti);
		}
	});
	for (const list of edgeMap.values()) {
		for (let i = 1; i < list.length; i++)
			if (Math.abs(normals[list[0]].dot(normals[list[i]])) > FACE_COPLANAR) union(list[0], list[i]);
	}
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, []);
		/** @type {number[]} */ (groups.get(r)).push(i);
	}
	return [...groups.values()].map((triIndices) => {
		const normal = normals[triIndices[0]].clone();
		const centroid = new THREE.Vector3();
		let count = 0;
		triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
		centroid.divideScalar(count || 1);
		return { triIndices, normal, centroid };
	});
}

/**
 * 15-G: pair coplanar neighbour triangles into QUADS — the unit a modeler
 * actually thinks in. The geometry here is a triangle SOUP with no stored face
 * topology, so quads are re-derived from the mesh whenever it changes.
 *
 * Two triangles pair when they share an edge, face the same way, and the quad
 * they would form is CONVEX (the shared edge has to be a real diagonal —
 * pairing across a concave joint gives a bow-tie). Every candidate is scored by
 * how rectangular the result is and matched GREEDILY best-first, so a coplanar
 * fan pairs the obvious way rather than the first way. A triangle left without
 * a partner is its own unit (the answer to "a genuine 3-sided face").
 *
 * Returns `partner`, where partner[i] is i's quad-mate or -1. Deterministic for
 * a given geometry: score ties break on triangle index.
 * @param {any[]} tris @returns {Int32Array}
 */
export function pairQuads(tris) {
	const partner = new Int32Array(tris.length).fill(-1);
	const normals = tris.map(triNormal);
	/** @type {Map<string, number[]>} edge key -> the triangles touching it */
	const edgeMap = new Map();
	tris.forEach((t, ti) => {
		for (let e = 0; e < 3; e++) {
			const k1 = keyOf(t[e].x, t[e].y, t[e].z);
			const k2 = keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z);
			const ek = [k1, k2].sort().join('|');
			let list = edgeMap.get(ek);
			if (!list) edgeMap.set(ek, (list = []));
			list.push(ti);
		}
	});

	/** the corner of `t` that is NOT on the shared edge @param {any[]} t @param {string[]} shared */
	const cornerOff = (t, shared) =>
		t.find((/** @type {any} */ v) => !shared.includes(keyOf(v.x, v.y, v.z)));
	/** the corner of `t` at a given key @param {any[]} t @param {string} key */
	const cornerAt = (t, key) => t.find((/** @type {any} */ v) => keyOf(v.x, v.y, v.z) === key);

	/** @type {{ a: number, b: number, score: number }[]} */
	const candidates = [];
	for (const [ek, list] of edgeMap) {
		if (list.length !== 2) continue; // an open or non-manifold edge is no diagonal
		const [a, b] = list;
		if (a === b) continue;
		if (normals[a].dot(normals[b]) < QUAD_COPLANAR) continue; // coplanar AND co-facing
		const shared = ek.split('|');
		const ra = cornerOff(tris[a], shared);
		const rb = cornerOff(tris[b], shared);
		const p = cornerAt(tris[a], shared[0]);
		const q = cornerAt(tris[a], shared[1]);
		if (!ra || !rb || !p || !q) continue;
		// ring order around the quad: the shared edge p-q is the diagonal, so the
		// two off-corners sit between its ends
		const score = quadScore([p, ra, q, rb], normals[a]);
		if (score === null) continue; // concave or degenerate — not a quad
		candidates.push({ a: Math.min(a, b), b: Math.max(a, b), score });
	}

	// best-first greedy matching; ties break on index so the result is stable
	candidates.sort((x, y) => x.score - y.score || x.a - y.a || x.b - y.b);
	for (const { a, b } of candidates) {
		if (partner[a] !== -1 || partner[b] !== -1) continue;
		partner[a] = b;
		partner[b] = a;
	}
	return partner;
}

/**
 * How rectangular a candidate quad is (lower is better), or null when the ring
 * is concave or degenerate — which means those two triangles do NOT form a quad.
 * @param {any[]} ring 4 corners in order @param {any} normal
 */
function quadScore(ring, normal) {
	let score = 0;
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const cur = ring[i];
		const u = new THREE.Vector3().subVectors(ring[(i + 3) % 4], cur);
		const v = new THREE.Vector3().subVectors(ring[(i + 1) % 4], cur);
		if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) return null;
		u.normalize();
		v.normalize();
		// every corner must turn the same way around the face normal, or the ring
		// folds over itself (the bow-tie case)
		const turn = new THREE.Vector3().crossVectors(v, u).dot(normal);
		if (Math.abs(turn) < 1e-9) return null; // collinear corner
		if (sign === 0) sign = Math.sign(turn);
		else if (Math.sign(turn) !== sign) return null; // concave
		// squareness: 0 at a right angle, approaching 1 as the corner collapses
		score += Math.abs(u.dot(v));
	}
	return score;
}

function cloneTris(/** @type {any[]} */ tris) {
	return tris.map((t) =>
		withSlot(
			[t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			t.uv && t.uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
		)
	);
}

/** average vertex position of a triangle set @param {any[]} tris @param {number[]} triIndices */
function centroidOfTris(tris, triIndices) {
	const centroid = new THREE.Vector3();
	let count = 0;
	triIndices.forEach((ti) => tris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), count++)));
	return centroid.divideScalar(count || 1);
}

/**
 * Split a target triangle set into CONNECTED COMPONENTS, welded by vertex
 * position. `opTargetFace` synthesizes ONE face for a multi-selection, so a
 * selection spanning two separate shells arrives as a single "face" whose
 * centroid sits in the empty space between them — any op that reasons about a
 * face's CENTRE has to work per component or it drags one shell toward the
 * other (15-G: two merged cubes, both top faces inset, slid together).
 * @param {any[]} tris @param {number[]} triIndices @returns {number[][]}
 */
export function componentsOfTris(tris, triIndices) {
	/** @type {Map<string, string>} */
	const parent = new Map();
	const find = (/** @type {string} */ key) => {
		let root = key;
		while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
		while (parent.get(key) !== root) {
			const next = /** @type {string} */ (parent.get(key));
			parent.set(key, root);
			key = next;
		}
		return root;
	};
	const keysOf = (/** @type {number} */ ti) =>
		tris[ti].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	for (const ti of triIndices) {
		const keys = keysOf(ti);
		for (const key of keys) if (!parent.has(key)) parent.set(key, key);
		for (let i = 1; i < keys.length; i++) parent.set(find(keys[0]), find(keys[i]));
	}
	/** @type {Map<string, number[]>} */
	const byRoot = new Map();
	for (const ti of triIndices) {
		const root = find(keysOf(ti)[0]);
		let list = byRoot.get(root);
		if (!list) byRoot.set(root, (list = []));
		list.push(ti);
	}
	return [...byRoot.values()];
}

/** boundary edges of a face group: directed edges appearing once (unordered)
 * within the group @param {any[]} tris @param {any} face */
function boundaryEdges(tris, face) {
	/** @type {any[]} */
	const dir = [];
	/** @type {Map<string, number>} */
	const count = new Map();
	face.triIndices.forEach((/** @type {number} */ ti) => {
		const t = tris[ti];
		for (let e = 0; e < 3; e++) {
			const p0 = t[e];
			const p1 = t[(e + 1) % 3];
			const ek = [keyOf(p0.x, p0.y, p0.z), keyOf(p1.x, p1.y, p1.z)].sort().join('|');
			count.set(ek, (count.get(ek) || 0) + 1);
			// `ti` = the triangle this directed edge belongs to, so a wall stitched
			// onto it can take that triangle's OWN normal + material slot (15-G);
			// `c0`/`c1` are the CORNER indices within that triangle, which is how a
			// stitched wall reads the edge's UVs (M1)
			dir.push({ ek, p0, p1, ti, c0: e, c1: (e + 1) % 3 });
		}
	});
	return dir.filter((d) => count.get(d.ek) === 1);
}

/**
 * Add a quad (a,b,c,d) as two triangles, winding it so its normal aligns with
 * wantDir — otherwise the wall/ring backface-culls to invisible (121 fix).
 * @param {any[]} out @param {any} a @param {any} b @param {any} c @param {any} d @param {any} wantDir
 * @param {number=} mi material slot the new geometry belongs to (15-G)
 * @param {any[]=} uvs M1: the four corners' [u,v] in a,b,c,d order — the uv
 *   permutation follows the winding flip, or the texture would shear
 */
function pushQuad(out, a, b, c, d, wantDir, mi, uvs) {
	let t1 = [a, b, c];
	let t2 = [a, c, d];
	let uv1 = uvs && [uvs[0], uvs[1], uvs[2]];
	let uv2 = uvs && [uvs[0], uvs[2], uvs[3]];
	if (triNormal(t1).dot(wantDir) < 0) {
		t1 = [a, c, b];
		t2 = [a, d, c];
		uv1 = uvs && [uvs[0], uvs[2], uvs[1]];
		uv2 = uvs && [uvs[0], uvs[3], uvs[2]];
	}
	out.push(withSlot(t1, mi, uv1), withSlot(t2, mi, uv2));
}

/**
 * Outward direction of the wall stitched onto a boundary edge — the side that
 * must face the viewer, or the wall backface-culls to invisible.
 *
 * Derived LOCALLY from the edge itself: boundary edges inherit their direction
 * from the triangles' winding, and a face is wound counter-clockwise seen from
 * +normal, so `edge x normal` points away from the face interior. It used to be
 * measured from the face CENTROID instead, which is only right for a single
 * convex face: with two shells multi-selected the synthetic centroid lands in
 * the gap between them, so the two walls FACING EACH OTHER were wound inward
 * and vanished (15-G — extruding both top faces of two merged cubes). Concave
 * faces and faces with holes were wrong for the same reason.
 * @param {any} p0 @param {any} p1 @param {any} normal
 */
function edgeOutward(p0, p1, normal) {
	const out = new THREE.Vector3().subVectors(p1, p0).cross(normal);
	// an edge always lies in its own face plane, so this is only ever degenerate
	// for a zero-area triangle
	if (out.lengthSq() < 1e-12) return normal.clone();
	return out.normalize();
}

// ---- 99 K4 family 1: extrude / inset / move run on the kernel (meshOps/extrude.js) -------------------------
// The triangle-soup exports below keep their arguments and return shape (VR, the bevel core and the e2e
// suites call them): each converts the soup to an op mesh, runs the ONE kernel operator and converts back.
// The session, adjust and agent paths skip the soup altogether (sessionOpMesh / objectOpMesh).

/** the kernel operators, or a refusal while their lazy chunk is still loading @returns {any} */
function kernelOps() {
	const ops = editSession.ops;
	if (!ops) throw new Error(KERNEL_LOADING);
	return ops;
}
const KERNEL_LOADING = 'Mesh tools are still loading — try again in a moment';
/** the refusal while the kernel chunk loads (a toast, false) */
function kernelLoadingRefusal() {
	showToast(KERNEL_LOADING);
	return false;
}
export { loadKernelOps };

/** a triangle soup as an op mesh, begun @param {any[]} tris */
const soupOpMesh = (tris) => kernelOps().fromSoup(tris);
/** an op mesh back to a triangle soup (mi + uv tags) @param {any} om @returns {any[]} */
const opMeshTris = (om) => kernelOps().toSoup(om);

/** @param {any} n a Vector3 @returns {number[]} */
const vec = (n) => [n.x, n.y, n.z];

/** Extrude a face by dist along its normal, stitching visible side walls (kernel: extrudeRegion)
 * @param {any[]} tris @param {any} face @param {number} dist */
export function extrudeFace(tris, face, dist) {
	const om = soupOpMesh(tris);
	kernelOps().extrudeRegion(om, face.triIndices, vec(face.normal), dist);
	return opMeshTris(om);
}

/**
 * Push/pull a face along its normal, WELDED (138): every vertex sharing the face's corner positions
 * moves too, so adjacent faces stretch with it instead of tearing a hole (kernel: moveRegion).
 * @param {any[]} tris @param {any} face @param {number} dist
 */
export function moveFaceAlongNormal(tris, face, dist) {
	const om = soupOpMesh(tris);
	kernelOps().moveRegion(om, face.triIndices, vec(face.normal), dist);
	return opMeshTris(om);
}

/** Inset: each connected piece shrinks toward its own centroid (15-G) and a visible frame ring is stitched
 * so the gap does not read as a hole (121) — kernel: insetRegion. @param {any[]} tris @param {any} face
 * @param {number} amount */
export function insetFace(tris, face, amount) {
	const om = soupOpMesh(tris);
	kernelOps().insetRegion(om, face.triIndices, amount);
	return opMeshTris(om);
}

/** position keys of a face's vertices (138: weld set for a move) @param {any[]} tris @param {any} face */
function faceVertexKeys(tris, face) {
	const keys = new Set();
	face.triIndices.forEach((/** @type {number} */ ti) =>
		tris[ti].forEach((/** @type {any} */ v) => keys.add(keyOf(v.x, v.y, v.z)))
	);
	return keys;
}

/** Remove a face's triangles (kernel: deleteTriangles) @param {any[]} tris @param {any} face */
export function deleteFaceTris(tris, face) {
	const om = soupOpMesh(tris);
	kernelOps().deleteTriangles(om, face.triIndices);
	return opMeshTris(om);
}

/**
 * 19-A P3: convert a WORLD inset distance to the FRACTION `insetFace` lerps by,
 * for ONE connected component. The face bevel takes its width in world units
 * now, like the edge and vertex bevels always did — the same number used to
 * mean two different sizes depending on which bevel you were in.
 *
 * A boundary vertex lerped by `t` travels `t * dist(v, centroid)`, so dividing
 * the wanted world distance by the MEAN boundary radius makes the border travel
 * ≈ `width` world units (exact on a symmetric face, approximate on an
 * irregular one — the vertices farther out travel proportionally farther,
 * which is also what keeps the inset similar in shape). Clamped to 0.95 like
 * every inset, so an oversized width collapses toward the centre instead of
 * overshooting past it.
 * @param {any[]} tris @param {number[]} componentTriIndices ONE welded component
 * @param {number} width world distance @returns {number} lerp fraction 0..0.95
 */
export function insetDistanceToFraction(tris, componentTriIndices, width) {
	const centroid = centroidOfTris(tris, componentTriIndices);
	/** @type {Set<string>} */
	const seen = new Set();
	let sum = 0;
	let count = 0;
	for (const edge of boundaryEdges(tris, { triIndices: componentTriIndices })) {
		for (const p of [edge.p0, edge.p1]) {
			const key = keyOf(p.x, p.y, p.z);
			if (seen.has(key)) continue;
			seen.add(key);
			sum += p.distanceTo(centroid);
			count++;
		}
	}
	const mean = count ? sum / count : 0;
	if (mean < 1e-9) return 0.95; // a degenerate/closed component: fully collapsed
	return Math.min(Math.max(width / mean, 0), 0.95);
}

/**
 * 19-A P3: EXTRUDE INDIVIDUAL — each connected piece along its OWN averaged normal (kernel:
 * extrudeIndividual). @param {any[]} tris @param {any} face the op target ({triIndices})
 * @param {number} dist @returns {any[]}
 */
export function extrudeFacesIndividual(tris, face, dist) {
	const om = soupOpMesh(tris);
	kernelOps().extrudeIndividual(om, face.triIndices, dist);
	return opMeshTris(om);
}

/**
 * 19-A P3: INSET, extended — `individual` insets each face UNIT separately (`face.units`, the
 * granularity units the engine captured; components when absent), then `depth` pushes each piece of
 * the cap along its own normal, welded (kernel: insetExtended).
 * @param {any[]} tris @param {any} face the op target ({triIndices, units?})
 * @param {{amount?: number, depth?: number, individual?: boolean}} [options]
 * @returns {any[]}
 */
export function insetFaceEx(tris, face, options = {}) {
	const om = soupOpMesh(tris);
	kernelOps().insetExtended(om, face.triIndices, { ...options, units: face.units ?? null });
	return opMeshTris(om);
}

// B4 / P1 / P10 SUBDIVIDE (quad-aware: a paired quad becomes a 2x2 grid of authored sub-quads, an unpaired triangle
// a 4-way split; unselected neighbours keep their full edge, a T-junction) and its `levels` iteration live on the
// kernel since 99 K4 family 6: meshOps/subdivide.js `subdivideUnits` / `subdivideLevels`.

/** B4: reverse the winding (swap b/c) of the target tris — flips their
 * normals. @param {any[]} tris @param {number[]} targetTris */
export function flipFaceNormals(tris, targetTris) {
	const targets = new Set(targetTris);
	return tris.map((t, ti) =>
		withSlot(
			targets.has(ti)
				? [t[0].clone(), t[2].clone(), t[1].clone()]
				: [t[0].clone(), t[1].clone(), t[2].clone()],
			t.mi,
			// M1: the uvs follow the same corner swap, or the texture mirrors
			t.uv && (targets.has(ti) ? [t.uv[0], t.uv[2], t.uv[1]] : t.uv)
		)
	);
}

/** Ordered boundary LOOP of a tri set: its directed boundary edges walked
 * p1 -> next p0. Null unless the boundary is ONE closed loop. (E10: exported
 * for faceSelectionInfo's live edge counts.)
 * @param {any[]} tris @param {number[]} triIndices @returns {any[] | null} */
export function boundaryLoop(tris, triIndices) {
	const dir = boundaryEdges(tris, { triIndices });
	if (dir.length < 3) return null;
	/** @type {Map<string, any>} */
	const byStart = new Map();
	for (const e of dir) byStart.set(keyOf(e.p0.x, e.p0.y, e.p0.z), e);
	const startKey = keyOf(dir[0].p0.x, dir[0].p0.y, dir[0].p0.z);
	/** @type {any[]} */
	const loop = [];
	let edge = dir[0];
	do {
		loop.push(edge.p0.clone());
		edge = byStart.get(keyOf(edge.p1.x, edge.p1.y, edge.p1.z));
		if (!edge) return null;
	} while (keyOf(edge.p0.x, edge.p0.y, edge.p0.z) !== startKey && loop.length <= dir.length);
	return loop.length === dir.length ? loop : null;
}

/**
 * P1 (19-A): the PURE core of the bridge — triangles + the two pieces in, triangles out, no session reads;
 * `{error}` carries the wrapper's exact toast text when the loops cannot bridge. P3 `twist` rotates the loop
 * pairing by N steps, P7a `invert` flips every wall after the shell test's guess. 99 K4 family 4: an adapter
 * over the kernel operator (meshOps/bridgeFill.js `bridgeRegions`, where the recipe lives now).
 * @param {any[]} tris @param {number[]} setA @param {number[]} setB the two connected components
 * @param {{cuts?: number, twist?: number, invert?: boolean}} [options]
 * @returns {{tris: any[], origin: number[], authored: number[][]} | {error: string}}
 */
export function bridgeFacesCore(tris, setA, setB, options = {}) {
	const om = soupOpMesh(tris);
	const r = kernelOps().bridgeRegions(om, setA, setB, options);
	if ('error' in r) return { error: r.error };
	const next = opMeshTris(om);
	// both caps go, the survivors reindex, and every tunnel wall is a quad the op built
	const origin = survivorOrigin(tris.length, new Set([...setA, ...setB]));
	const survivorCount = origin.length;
	while (origin.length < next.length) origin.push(-1);
	return { tris: next, origin, authored: appendedQuads(survivorCount, next.length) };
}

/**
 * B4: bridge exactly TWO multi-selected pieces into a tunnel — delete both
 * caps, stitch quads between their boundary loops (equal edge counts
 * required), walking both loops from the closest-vertex-pair anchor and
 * winding each quad OUTWARD from the tunnel axis. Commits + replicates +
 * records ONE undoable meshgeo. @returns {boolean}
 */
/**
 * Bridge two selected pieces with a tunnel.
 * @param {number} [cuts] 18-C5: intermediate loops along the tunnel, the "Number
 *   of Cuts" every DCC bridge offers. 0 = one band (the original behaviour, so
 *   every existing caller and replayed message is unchanged); each cut adds a
 *   ring, which is what makes a bridged tunnel deformable afterwards instead of
 *   a rigid sleeve with nothing to grab in the middle.
 * @param {number} [twist] P3: rotate the loop pairing by N steps (0 = the
 *   angle-ordered pairing, unchanged).
 * @param {boolean} [invert] P7a: flip every wall, correcting the shell test's
 *   guess about which side of the tunnel you see (false = the guess).
 */
export function bridgeFaces(cuts = 0, twist = 0, invert = false) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const sel = get(faceEditSelectedTris).filter((/** @type {number} */ ti) => FS.workingTris[ti]);
	if (!sel.length) {
		showToast('Multi-select two faces first (Multi on, click both)');
		return false;
	}
	// The op target is the SELECTION, split into its two connected pieces — NOT
	// the coplanar groups the selection happens to touch (the opTargetFace rule).
	// Expanding to whole logical faces silently ignored Face/Triangle/Shell
	// granularity: extruding a face leaves a wall that is COPLANAR with the flat
	// side beneath it, so groupFaces merges the two, and picking just the wall
	// band bridged the entire side of the shell instead (15-G).
	const parts = componentsOfTris(FS.workingTris, sel);
	if (parts.length !== 2) {
		showToast(
			parts.length < 2
				? 'Bridge needs TWO separate pieces — the selected faces touch each other'
				: 'Bridge needs exactly TWO pieces (' + parts.length + ' separate pieces selected)'
		);
		return false;
	}
	const [setA, setB] = parts;
	// 99 K4 family 4: on the session's op mesh, committed with its element IDs
	const r = sessionKernelCommit((ops, om) => ops.bridgeRegions(om, setA, setB, { cuts, twist, invert }));
	if (!r) return false;
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	return true;
}

/** Triangles → a fresh non-indexed BufferGeometry with recomputed normals @param {any[]} tris */
export function trisToGeometry(tris) {
	const positions = new Float32Array(tris.length * 9);
	tris.forEach((t, i) => {
		for (let k = 0; k < 3; k++) {
			positions[i * 9 + k * 3] = t[k].x;
			positions[i * 9 + k * 3 + 1] = t[k].y;
			positions[i * 9 + k * 3 + 2] = t[k].z;
		}
	});
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	return geometry;
}

/**
 * 15-G: the triangles' MATERIAL SLOTS run-length encoded into geometry groups
 * (vertex units, the shape three wants). Returns null when everything is slot 0
 * — a single-material mesh needs no groups at all, so the overwhelmingly common
 * case puts nothing extra on the wire and behaves exactly as before.
 * @param {any[]} tris @returns {any[] | null}
 */
export function trisToGroups(tris) {
	if (!tris.length || !tris.some((t) => (t.mi || 0) > 0)) return null;
	/** @type {any[]} */
	const groups = [];
	let start = 0;
	let slot = tris[0].mi || 0;
	for (let i = 1; i <= tris.length; i++) {
		const next = i < tris.length ? tris[i].mi || 0 : -1;
		if (next === slot) continue;
		groups.push({ start: start * 3, count: (i - start) * 3, materialIndex: slot });
		start = i;
		slot = next;
	}
	return groups;
}

/**
 * Keep a MULTI-MATERIAL mesh renderable across a geometry swap (15-G). three
 * draws an array material by iterating `geometry.groups`, so a fresh geometry
 * with none draws NOTHING — a merged mesh vanished the moment any face op ran.
 * Prefer the groups the edit computed; else carry the previous geometry's over
 * (exact whenever the vertex count is unchanged — the sculpt / vertex-drag
 * paths); and always cover the tail so no triangle is left unrendered.
 * @param {any} geometry @param {any} previous the geometry being replaced
 * @param {any} object @param {any[] | null} [groups]
 */
function preserveMaterialGroups(geometry, previous, object, groups) {
	if (!Array.isArray(object?.material) || object.material.length < 2) return;
	const count = geometry.attributes.position.count;
	const source = groups?.length ? groups : previous?.groups;
	let covered = 0;
	let last = 0;
	if (source?.length)
		for (const group of source) {
			const start = Math.max(group.start | 0, 0);
			const size = Math.min(group.count | 0, count - start);
			if (start >= count || size <= 0) continue;
			last = group.materialIndex || 0;
			geometry.addGroup(start, size, last);
			covered = Math.max(covered, start + size);
		}
	// a shorter list than the geometry (an older peer's ungrouped snapshot, or a
	// path that does not track slots) would leave the tail invisible
	if (covered < count) geometry.addGroup(covered, count - covered, last);
}

/**
 * M1: the triangles' UVs as a flat array (2 per vertex), or null when the mesh
 * is untextured — the common case then puts nothing extra on the wire, in
 * history, or in the geometry, exactly like `trisToGroups`. A triangle that
 * somehow lost its uv (new geometry an op forgot to tag) contributes zeros
 * rather than a short array: a uv attribute must cover EVERY vertex.
 * @param {any[]} tris @returns {number[] | null}
 */
export function trisToUVs(tris) {
	if (!tris.some((t) => !!t.uv)) return null;
	/** @type {number[]} */
	const uvs = [];
	for (const t of tris)
		for (let c = 0; c < 3; c++) {
			const pair = t.uv ? t.uv[c] : null;
			uvs.push(pair ? pair[0] : 0, pair ? pair[1] : 0);
		}
	return uvs;
}

/**
 * mcp-shapes: a mesh with vertex colours (create_mesh `colors`) keeps them across a geometry swap. Given colours win;
 * else the previous attribute is carried when the vertex count is unchanged (a move, a smooth, a sculpt stroke) and
 * reset to WHITE when it is not — corners an op invented have no colour, and carrying by index would scramble them.
 * A mesh that never had colours gets none (the common case stays byte-identical).
 * @param {any} geometry @param {any} previous @param {Float32Array | null} colors
 */
function preserveColors(geometry, previous, colors) {
	const count = geometry.attributes.position.count;
	if (colors?.length) {
		const array = new Float32Array(count * 3).fill(1);
		array.set(colors.length > array.length ? colors.subarray(0, array.length) : colors);
		geometry.setAttribute('color', new THREE.BufferAttribute(array, 3));
		return;
	}
	const old = previous?.attributes?.color;
	if (!old) return;
	const array = new Float32Array(count * 3).fill(1);
	if (old.count === count) for (let i = 0; i < count; i++) array.set([old.getX(i), old.getY(i), old.getZ(i)], i * 3);
	geometry.setAttribute('color', new THREE.BufferAttribute(array, 3));
}

/**
 * M1: keep a TEXTURED mesh mapped across a geometry swap. Prefer the uvs the
 * edit computed; else carry the previous geometry's attribute over — exact
 * whenever the vertex count is unchanged (sculpt strokes, vertex drags, VR
 * grabs, stretch), clipped or zero-padded when an op grew/shrank the mesh
 * without tracking uvs (createFaceFromVerts). Never leaves a partial attribute:
 * three requires uv.count === position.count.
 * @param {any} geometry @param {any} previous @param {number[] | null} [uvs]
 */
function preserveUVs(geometry, previous, uvs) {
	const count = geometry.attributes.position.count;
	if (uvs?.length) {
		const array = new Float32Array(count * 2);
		array.set(uvs.length > array.length ? uvs.slice(0, array.length) : uvs);
		geometry.setAttribute('uv', new THREE.BufferAttribute(array, 2));
		return;
	}
	const old = previous?.attributes?.uv;
	if (!old) return;
	// Read through the previous geometry's INDEX when it had one: several paths
	// snapshot INDEX-EXPANDED positions (weld, entering sculpt, create-face), so
	// the new vertex count is previous.index.count while the old uv attribute is
	// still in unique-vertex space. Without this a weld on an indexed mesh
	// zero-padded 12 of a box's 36 uvs.
	const index = previous.index;
	const expanded = index && count === index.count;
	const array = new Float32Array(count * 2);
	for (let i = 0; i < count; i++) {
		const j = expanded ? index.getX(i) : i;
		if (j >= old.count) continue; // grew past what we know — leave 0,0
		array[i * 2] = old.getX(j);
		array[i * 2 + 1] = old.getY(j);
	}
	geometry.setAttribute('uv', new THREE.BufferAttribute(array, 2));
}

/** flat positions array for a snapshot message @param {any[]} tris */
export function trisToPositions(tris) {
	/** @type {number[]} */
	const positions = [];
	tris.forEach((t) => t.forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z)));
	return positions;
}

/**
 * Scale one axis of a flat xyz positions array about its centroid on that axis
 * (161 stretch). Pure. @param {number[]} positions @param {number} axis 0|1|2
 * @param {number} factor @returns {number[]}
 */
export function stretchPositions(positions, axis, factor) {
	const out = positions.slice();
	const count = out.length / 3;
	if (!count) return out;
	let sum = 0;
	for (let i = axis; i < out.length; i += 3) sum += out[i];
	const center = sum / count;
	for (let i = axis; i < out.length; i += 3) out[i] = center + (out[i] - center) * factor;
	return out;
}

/**
 * Numbers off the wire: a plain array (history replays), an ArrayBuffer (the
 * wire format) or a typed-array VIEW — binarypack may deliver a view into a
 * LARGER buffer, so slice the exact bytes (the assetShare gotcha).
 * @param {any} data
 */
function toFloats(data) {
	if (data instanceof ArrayBuffer) return new Float32Array(data);
	if (ArrayBuffer.isView(data))
		return new Float32Array(
			/** @type {any} */ (data).buffer.slice(
				/** @type {any} */ (data).byteOffset,
				/** @type {any} */ (data).byteOffset + /** @type {any} */ (data).byteLength
			)
		);
	// a list of numbers, never a bare number: `new Float32Array(n)` would allocate n floats
	if (!Array.isArray(data)) return new Float32Array(0);
	return new Float32Array(data);
}

/**
 * Swap an object's geometry to a positions snapshot (remote msg / undo replay).
 * @param {string} uuid @param {number[]} positions
 * @param {any[] | null} [groups] material groups for a multi-material mesh (15-G);
 *   omitted by the sculpt/vertex paths, which never change the vertex count
 * @param {any} [uvs] M1: texture coordinates, same three wire shapes as
 *   positions; omitted means "carry the previous attribute over"
 * @param {any} [faceCounts] P9 stored topology, CSR half one — one Int32 per face.
 *   Absent means "the sender did not author faces": the previous partition is CARRIED
 *   when it still fits the new mesh exactly and dropped otherwise (A7), which is what
 *   an older peer's positions-only message does too.
 * @param {any} [faceTris] P9 stored topology, CSR half two — the flat triangle run
 * @param {any} [colors] mcp-shapes: per-vertex colours (3 per vertex), same wire shapes as positions;
 *   omitted = carry the previous colours when the vertex count is unchanged (else white)
 */
export function applyMeshGeo(uuid, positions, groups, uvs, faceCounts, faceTris, colors) {
	const object = lookupEditable(uuid); // A8: also finds the collider-edit proxy
	if (!object) return;
	const floats = toFloats(positions);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(floats, 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	// T-2: terrain reads smooth, not faceted — average normals across
	// position-welded vertices (deterministic: every peer derives the same
	// shading from the same positions; nothing extra on the wire). M6 makes the
	// same treatment a per-object CHOICE, so it has to survive every swap.
	if (object.userData.terrain || object.userData.shading === 'smooth')
		smoothWeldedNormals(geometry);
	const previous = object.geometry;
	preserveMaterialGroups(geometry, previous, object, groups);
	preserveUVs(geometry, previous, uvs == null ? null : Array.from(toFloats(uvs)));
	preserveColors(geometry, previous, colors == null ? null : toFloats(colors));
	if (faceCounts != null && faceTris != null) applyFacesWire(geometry, faceCounts, faceTris);
	else if (!carryFaces(geometry, previous)) clearStoredFaces(geometry);
	previous?.dispose?.();
	object.geometry = geometry;
	object.userData.faceEdited = true; // parametric Geometry rows disable (like vertexEdited)
	// if we're editing this object, re-derive working tris + faces (a remote
	// change or undo swapped the geometry out from under the session, 122)
	if (FS.object === object) {
		rebuildFaces();
		refreshFaceOverlay();
		refreshFaceWireframe(); // B2: remote/undo swap replaced the geometry
	}
	// a live sculpt session's weld map is a cache over THIS geometry — rebuild
	// it after a remote stroke / undo swap (dynamic: terrainSculpt imports us);
	// rebuildSculptCaches picks the terrain OR mesh map by the active mode
	import('./terrainSculpt').then((m) => {
		if (get(m.sculptObject) === uuid) m.rebuildSculptCaches(object);
	});
	// D1: a live VERTEX session's handles are a cache over THIS geometry too —
	// rebuild them after an undo / remote commit. meshEdit registers the hook at
	// module eval (it imports us — a dynamic import back would be a SECOND module
	// instance under vite's ?t= HMR stamps, whose editingObject is always null).
	vertexSessionRefresher?.(uuid);
	pokeScene();
}

/** Average normals across position-welded vertices of a NON-INDEXED geometry
 * (computeVertexNormals on split tris gives flat shading). @param {any} geometry */
export function smoothWeldedNormals(geometry) {
	const position = geometry.attributes.position;
	const normal = geometry.attributes.normal;
	if (!position || !normal) return;
	/** @type {Map<string, number[]>} */
	const groups = new Map();
	for (let i = 0; i < position.count; i++) {
		const key =
			Math.round(position.getX(i) * 1e4) +
			'|' +
			Math.round(position.getY(i) * 1e4) +
			'|' +
			Math.round(position.getZ(i) * 1e4);
		let list = groups.get(key);
		if (!list) groups.set(key, (list = []));
		list.push(i);
	}
	const sum = new THREE.Vector3();
	for (const indices of groups.values()) {
		if (indices.length < 2) continue;
		sum.set(0, 0, 0);
		for (const i of indices) sum.add(new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i)));
		sum.normalize();
		for (const i of indices) normal.setXYZ(i, sum.x, sum.y, sum.z);
	}
	normal.needsUpdate = true;
}

/** Triangle count of an object's geometry (0 when not a mesh) @param {any} object */
export function triangleCount(object) {
	const pos = object?.geometry?.attributes?.position;
	if (!pos) return 0;
	return (object.geometry.index ? object.geometry.index.count : pos.count) / 3;
}

/** Is this object simple enough to face-edit in VR? D7: capped by the
 * user-editable vrFaceCap setting. @param {any} object */
export function vrFaceEditable(object) {
	const tris = triangleCount(object);
	return tris > 0 && tris <= get(vrFaceCap);
}

// ---- B2: edit-session wireframe (shared by vertex + face modes) ------------

/** @type {any} face-mode wireframe overlay (child of faceEdited) — declared
 * BEFORE the store: its subscriber runs at module eval (TDZ) */
let wire = null;
/** @type {any} the geometry `wire` was built from — the identity half of
 * `tickEditWireframe`'s guard. Declared HERE for the same TDZ reason as `wire`:
 * refreshFaceWireframe writes it and a module-eval subscriber can reach that. */
let wireSource = null;

/** wireframe overlay display toggle — honored by BOTH edit modes, local pref */
export const meshEditWireframe = writable(
	typeof localStorage === 'undefined' || safeStorage.getItem('meshEditWireframe') !== 'false'
);
meshEditWireframe.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('meshEditWireframe', String(value));
	if (wire) wire.visible = value; // live toggle mid-session (face mode)
});

/** D3: mesh-edit hotkeys (E/I/G/S/B/F/X · W) enabled — local pref, default ON.
 * Read by MeshEditPopup (the local keydown), shortcuts.js (bare mesh-edit keys
 * never match the registry while a session owns them — F also focuses) and
 * editorNavigation (W/A/S/D/Q/E fly is suppressed while it's on; toggling the
 * pref OFF is the escape hatch that returns the camera keys, quiz 15-D3). */
export const meshEditHotkeys = writable(
	typeof localStorage === 'undefined' || safeStorage.getItem('meshEditHotkeys') !== 'false'
);
meshEditHotkeys.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('meshEditHotkeys', String(value));
});

/** Show the object SELECTION OUTLINE while mesh-editing — local pref, default
 * OFF. The outline is a postprocessing pass composited after the whole scene,
 * so it paints OVER the vertex handles and the edge/face highlights no matter
 * what they do with depthTest/renderOrder: while you are editing elements, the
 * object-level outline is pure glare. Read by Outline.svelte. */
export const meshEditOutline = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('meshEditOutline') === 'true'
);
meshEditOutline.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('meshEditOutline', String(value));
});

/** Show the raw TRIANGULATION in the edit wireframe — local pref, default OFF.
 * The default draws the QUAD structure instead: a quad's internal diagonal is
 * a triangulation artifact, deliberately not pickable (pickEdgeAt skips it) and
 * not dissolvable, so drawing it advertised an edge the tools refuse to touch.
 * Every modeller shows quads in edit mode for the same reason. */
export const meshEditTriWire = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('meshEditTriWire') === 'true'
);

/** meshEdit owns the vertex-mode overlay; it imports THIS module, so it hands
 * us a rebuild callback rather than the other way round (the TDZ cycle rule).
 * Declared ABOVE the subscriber below, which runs at module eval — the classic
 * store-subscriber TDZ that has bitten this file twice.
 * @type {(() => void) | null} */
let vertexWireRebuild = null;
/** @param {() => void} fn */
export function registerVertexWireRebuild(fn) {
	vertexWireRebuild = fn;
}

meshEditTriWire.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('meshEditTriWire', String(value));
	// the edge set differs, so this rebuilds rather than toggling visibility.
	// `wire` is the only session state read here: faceEdited lives further down
	// the file and would TDZ-crash the SSR eval, so refreshFaceWireframe (which
	// checks it itself) is the gate.
	if (wire) refreshFaceWireframe();
	vertexWireRebuild?.();
});

/** 18-A: the overlay colour is baked into its material at BUILD time (and 'auto'
 * re-reads the object's luminance), so a colour change rebuilds — the same shape
 * as the triangulation toggle above, and subject to the same TDZ rule: everything
 * read here is declared above. */
let lastEditWireColor = get(viewPrefs).editWireColor;
viewPrefs.subscribe((prefs) => {
	if (prefs.editWireColor === lastEditWireColor) return;
	lastEditWireColor = prefs.editWireColor;
	if (wire) refreshFaceWireframe();
	vertexWireRebuild?.();
});

/** the welded edge keys that are quad DIAGONALS — everything the quad view leaves out.
 *
 * The shared edge is read from the two TRIANGLES, not through `quadRingKeys`: that helper
 * indexes the live session's `workingTris`, so this returned an EMPTY set for any geometry
 * without an open edit session — which is exactly how `internalEdgeSet` is called (the
 * vertex slide then happily offered a face diagonal as a slide direction).
 * @param {any[]} tris @param {Int32Array} partner */
function diagonalEdgeKeys(tris, partner) {
	const out = new Set();
	for (let i = 0; i < tris.length; i++) {
		const mate = partner[i];
		if (mate == null || mate < 0 || mate < i || !tris[i] || !tris[mate]) continue;
		const ka = tris[i].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
		const kb = tris[mate].map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
		const shared = ka.filter((/** @type {string} */ k) => kb.includes(k));
		if (shared.length === 2) out.add(edgeKey(shared[0], shared[1]));
	}
	return out;
}

/**
 * The edges the structure view leaves out: everything INTERNAL to a face.
 *
 * P11: with a stored partition this generalises past quads for free — an edge that
 * appears twice inside one face is internal to it, which is as true of a dissolved
 * n-gon's fan spokes as of a quad's diagonal. Without one it falls back to the derived
 * quad diagonals, so an unedited mesh draws exactly as it always did.
 * @param {any[]} tris @param {number[][]|null} faces @param {Int32Array} [partner]
 */
function internalEdgeKeys(tris, faces, partner) {
	if (!faces) return diagonalEdgeKeys(tris, partner ?? pairQuads(tris));
	const out = new Set();
	for (const face of faces) {
		if (face.length < 2) continue;
		/** @type {Map<string, number>} */
		const count = new Map();
		for (const ti of face) {
			const t = tris[ti];
			if (!t) continue;
			const keys = t.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
			for (let e = 0; e < 3; e++) {
				const key = edgeKey(keys[e], keys[(e + 1) % 3]);
				count.set(key, (count.get(key) ?? 0) + 1);
			}
		}
		for (const [key, seen] of count) if (seen >= 2) out.add(key);
	}
	return out;
}

/**
 * The face-INTERNAL edge keys of a geometry, with NO live edit session required — the
 * "which edges are real" answer for callers outside this module. meshEdit's vertex slide
 * needs it: a quad's diagonal is a triangulation artifact (pickEdgeAt already skips them,
 * dissolve refuses them), so offering one as a slide direction is meaningless — and the
 * first pass did exactly that, picking the +Z face diagonal over the model edge.
 * Uses stored topology when the mesh has any, else the derived quad pairing.
 * @param {any} geometry @returns {Set<string>}
 */
export function internalEdgeSet(geometry) {
	if (!geometry?.attributes?.position) return new Set();
	const tris = readTriangles(geometry);
	return internalEdgeKeys(tris, readStoredFaces(geometry));
}

/** the canonical welded key of the edge between two points, for internalEdgeSet lookups
 * @param {any} a @param {any} b @returns {string} */
export function edgeKeyOf(a, b) {
	return edgeKey(keyOf(a.x, a.y, a.z), keyOf(b.x, b.y, b.z));
}

/** Quad-structure line geometry: every welded edge of the mesh EXCEPT the ones
 * internal to a face. Unpaired triangles keep all three edges, so a genuine
 * tri-only mesh looks exactly as it did. @param {any} geometry */
function quadWireGeometry(geometry) {
	const tris = readTriangles(geometry);
	const skip = internalEdgeKeys(tris, readStoredFaces(geometry));
	const seen = new Set();
	/** @type {number[]} */
	const points = [];
	for (const t of tris) {
		const keys = t.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(keys[e], keys[(e + 1) % 3]);
			if (skip.has(key) || seen.has(key)) continue;
			seen.add(key);
			const a = t[e];
			const b = t[(e + 1) % 3];
			points.push(a.x, a.y, a.z, b.x, b.y, b.z);
		}
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
	return out;
}

/** The geometry the edit wireframe should draw right now — quad structure by
 * default, the raw triangulation when the Display toggle asks for it. Exported
 * because meshEdit swaps `overlay.geometry` in place on every vertex move.
 * @param {any} geometry */
export function editWireGeometry(geometry) {
	return get(meshEditTriWire)
		? new THREE.WireframeGeometry(geometry)
		: quadWireGeometry(geometry);
}

/**
 * The edit wire's colour for an object: an explicit preference wins (18-A); 'auto' (the
 * default) picks from the material's luminance (D4 — a fixed blue disappeared on
 * similar-hued / light materials). @param {any} object @returns {number | string}
 */
export function editWireColorFor(object) {
	const material = Array.isArray(object.material) ? object.material[0] : object.material;
	const c = material?.color;
	// relative luminance over three's LINEAR color components
	const lum = c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 0;
	return editWireOverride(get(viewPrefs)) ?? (lum > 0.5 ? 0x1f2937 : 0x2f81f7);
}

/** per-frame scratch for retintEditWire (no allocation on the hot path) */
const retintScratch = new THREE.Color();

/**
 * 37 R18: LIVE contrast re-tint. The colour used to be picked at BUILD time only, so a
 * material edit mid-session (the Inspector, a peer's colour message, undo, the VR palette,
 * a flow node) left a wire that vanished into the new colour until the next geometry swap.
 * There is no single material-changed signal to hook (several paths write `.color`
 * directly), so the per-frame ticks ask instead: one luminance read + one hex compare,
 * and a write only when the answer changed. @param {any} overlay @param {any} object
 */
export function retintEditWire(overlay, object) {
	const mat = overlay?.material;
	if (!mat?.color || !object) return false;
	const want = retintScratch.set(editWireColorFor(object)).getHex();
	if (mat.color.getHex() === want) return false;
	mat.color.setHex(want);
	return true;
}

/**
 * The edit-session wireframe overlay: an object-CHILD LineSegments (follows
 * the transform for free) whose raycast is stubbed out (D8: three raycasts
 * lines with a 1-world-unit threshold — a live overlay would eat beams/picks
 * a metre off the surface). Shared with meshEdit's vertex mode. @param {any} object
 */
export function buildEditWireframe(object) {
	const overlay = new THREE.LineSegments(
		editWireGeometry(object.geometry),
		new THREE.LineBasicMaterial({
			color: editWireColorFor(object),
			transparent: true,
			opacity: 0.5
		})
	);
	overlay.name = 'edit-overlay';
	overlay.raycast = () => {};
	overlay.visible = get(meshEditWireframe);
	return overlay;
}

/** e2e (and a sanity probe): what the face-mode wire actually draws.
 * `diagonals` must be 0 in quad view — that is the whole point of it. P11: the skip
 * set comes from the same place the wire's does, so an n-gon's internal spokes count
 * as hidden structure too. */
export function wireframeDebug() {
	if (!wire || !FS.object) return { segments: 0, diagonals: -1 };
	const position = wire.geometry.attributes.position;
	const skip = internalEdgeKeys(FS.workingTris, currentPartition(), FS.quadPartner);
	let diagonals = 0;
	for (let i = 0; i < position.count; i += 2) {
		const a = keyOf(position.getX(i), position.getY(i), position.getZ(i));
		const b = keyOf(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1));
		if (skip.has(edgeKey(a, b))) diagonals++;
	}
	return { segments: position.count / 2, diagonals };
}

/** (Re)build the face-mode wireframe from the CURRENT geometry — called on
 * enter + after every geometry swap (commit, live gesture, remote, undo). */
function refreshFaceWireframe() {
	if (wire) {
		wire.parent?.remove(wire);
		wire.geometry?.dispose?.();
		wire.material?.dispose?.();
		wire = null;
	}
	wireSource = null;
	if (!FS.object) return;
	wire = buildEditWireframe(FS.object);
	FS.object.add(wire);
	wireSource = FS.object.geometry;
}

/**
 * Per-frame invariant check for the edit wireframe. It is a CHILD of the edited
 * object, so it follows every transform for free — until something takes that
 * parenting away: an object swapped out by a remote sync / a restore / an undo
 * that rebuilds the node, or a re-parent (pivot, grouping) that moves the mesh
 * but not the overlay. The wire is then left behind in the scene at whatever
 * pose it last had, which is the reported "the wireframe detaches from the
 * object". The same call heals a wire built from a geometry that has since been
 * REPLACED, so a swap site that forgets its `refreshFaceWireframe` degrades to
 * one stale frame instead of a wrong overlay for the rest of the session.
 *
 * Two reference comparisons per frame when nothing is wrong, and it rebuilds
 * ONLY on a real mismatch — never on a healthy frame.
 */
export function tickEditWireframe() {
	if (!wire || !FS.object) return;
	// a serializer has the overlays parked (async for the GLTF paths, so frames
	// pass) — healing now would put one back INTO the snapshot being written
	if (editOverlaysParked()) return;
	if (wire.parent === FS.object && wireSource === FS.object.geometry) {
		retintEditWire(wire, FS.object); // 37 R18
		return;
	}
	refreshFaceWireframe();
}

// ---- face edit MODE (VR + desktop-parity hook) ----

/** @type {import('svelte/store').Writable<string|null>} uuid in face-edit mode */
export const faceEditObject = writable(null);
/** highlighted face index (ray/selection), or -1 @type {import('svelte/store').Writable<number>} */
export const faceEditHighlight = writable(-1);
/** armed op for the next commit (B4 adds the one-shots)
 * @type {import('svelte/store').Writable<'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'|'loopcut'|'knife'>} */
// MOVE is the default tool, not extrude: with auto-apply on, a plain click
// COMMITS the armed op, so an extrude-by-default session turned every click on a
// face into an extrusion — the reported "clicking twice on a quad breaks the
// texture". Move only selects and seats the gizmo, which is what a click should
// do; extrude is one key (E) or one button away.
export const faceEditOp = writable('move');
/** live op amount, stick-driven @type {import('svelte/store').Writable<number>} */
export const faceEditAmount = writable(0.3);
/** 176: desktop auto-apply the active extrude/inset op on face click */
export const faceAutoApply = writable(true);

/** 19-A P2: UI/e2e mirror of the LIVE op adjust — `{op, params}` or null.
 * The engine's own state (`opAdjust`) lives with the gesture code far below;
 * the STORE is declared here in the store block because module-eval subscribers
 * must never read declarations that come later in the file (the documented
 * store-subscriber TDZ trap).
 * @type {import('svelte/store').Writable<any>} */
export const opAdjustState = writable(null);

/** 176: on a desktop face click, apply the active extrude/inset op if auto-apply
 * is on and a face is highlighted. Returns TRUE if it committed.
 * 19-A P2: routes through the adjust engine, so a click-extrude opens the
 * adjust panel exactly like the toolbox's Apply does. */
export function autoApplyFaceOp() {
	if (!get(faceAutoApply)) return false;
	const op = get(faceEditOp);
	if (op !== 'extrude' && op !== 'inset') return false;
	if (get(faceEditHighlight) < 0) return false;
	// P3: a click-apply reads the SAME pane params the toolbox's Apply would —
	// two entry points with different parameters is a support ticket
	return beginOpAdjust(
		op,
		op === 'inset'
			? { distance: get(faceEditAmount), depth: get(insetDepth), individual: get(insetIndividual) }
			: { distance: get(faceEditAmount), individual: get(extrudeIndividual) }
	);
}

/** Arm an op (from the Faces sub-ring / desktop toolbar)
 * @param {'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'|'loopcut'|'knife'} op */
export function setFaceOp(op) {
	faceEditOp.set(op);
	// inset lives in 0..0.9; the others are signed distances
	faceEditAmount.set(op === 'inset' ? 0.2 : 0.3);
	// B1 (inset fix): a seated MOVE gizmo intercepts the next face click (the
	// $TControls.dragging||axis guard skips face dispatch), so the click DRAGGED
	// the face instead of applying the armed op. Only Move keeps the gizmo.
	if (typeof window !== 'undefined') {
		if (op === 'move') attachFaceGizmo();
		else detachFaceGizmo();
	}
}

/** Nudge the live amount (grab-hand stick) @param {number} delta */
export function adjustFaceAmount(delta) {
	faceEditAmount.update((a) => {
		const op = get(faceEditOp);
		if (op === 'inset') return Math.min(Math.max(a + delta, 0.02), 0.9);
		return Math.min(Math.max(a + delta, -5), 5);
	});
}

/** Commit the armed op at the live amount on the highlighted face (VR trigger) */
export function commitArmedFaceOp() {
	const op = get(faceEditOp);
	return commitFaceOp(op, get(faceEditAmount));
}

// ---- 212: granularity + multiselect (CL-B B3, 15-G Quad) -----
/** face-select granularity: 'quad' = the two triangles forming a quad (DEFAULT
 * since 15-G — what a modeler expects to click, and unlike 'face' an extrusion
 * wall stays its own unit instead of merging into the coplanar side beneath it;
 * on a plain box a quad IS the side); 'face' = the whole coplanar group;
 * 'triangle' = the single tri under the ray (was MISLABELED 'polygon' — that
 * RETIRED alias still reads as 'triangle', and must not be confused with
 * 'quad'); 'shell' = the connected island of welded triangles; 'object' = all.
 * @type {import('svelte/store').Writable<'quad'|'face'|'triangle'|'shell'|'object'|'polygon'>} */
export const faceEditGranularity = writable('quad');

/** the granularity with the legacy 'polygon' value migrated at read time */
function granularity() {
	const g = get(faceEditGranularity);
	return g === 'polygon' ? 'triangle' : g;
}
/** Multi mode: triggers ACCUMULATE picks; ops apply to the whole set */
export const faceEditMulti = writable(false);
/** accumulated selected tri indices (into workingTris) in Multi mode @type {import('svelte/store').Writable<number[]>} */
export const faceEditSelectedTris = writable(/** @type {number[]} */ ([]));
/** the raw triangle under the ray/cursor (for polygon picking), or -1 */
export const faceEditHoverTri = writable(-1);

/** The tri indices a single pick selects, per granularity. @param {number} tri */
function pickFaceUnitTris(tri) {
	if (tri < 0 || !FS.workingTris[tri]) return [];
	const g = granularity();
	if (g === 'triangle') return [tri];
	// 15-G: the quad the triangle belongs to — what a modeler means by a face.
	// Sits BETWEEN triangle and face: a box side is one quad either way, but an
	// extrusion wall stays its own quad instead of merging into the coplanar
	// side beneath it (which is what `face` does, by design).
	if (g === 'quad') return quadOfTriangle(tri);
	// the WHOLE mesh. Differs from `shell` only when the mesh has SEVERAL
	// disconnected islands (a merged group, a multi-part import) — on a plain box
	// or sphere every triangle is one island, so Shell already is the object.
	if (g === 'object') return FS.workingTris.map((_, i) => i);
	// B3: shell = the connected component of welded triangles under the ray
	if (g === 'shell') return shellsOfTris(FS.workingTris).find((group) => group.includes(tri)) ?? [tri];
	const fi = faceIndexForTriangle(tri);
	return fi >= 0 ? [...FS.faces[fi].triIndices] : [];
}

/** Multi mode: toggle the picked unit into the accumulated selection. @param {number} tri */
function toggleFaceSelectionInner(tri) {
	const unit = pickFaceUnitTris(tri);
	if (!unit.length) return false;
	faceEditSelectedTris.update((sel) => {
		const set = new Set(sel);
		const allIn = unit.every((t) => set.has(t));
		unit.forEach((t) => (allIn ? set.delete(t) : set.add(t)));
		return [...set];
	});
	refreshFaceOverlay();
	return true;
}

/** Clear the accumulated multi-selection */
function clearFaceSelectionInner() {
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]);
	refreshFaceOverlay();
}

/** B3: set the pick granularity (units differ, so drop the selection).
 * Legacy 'polygon' maps to 'triangle' — it is a RETIRED alias for the old
 * triangle mode and must NOT be confused with 15-G's 'quad'.
 * @param {'face'|'quad'|'triangle'|'shell'|'object'|'polygon'} mode */
export function setFaceGranularity(mode) {
	const next = mode === 'polygon' ? 'triangle' : mode;
	if (!['face', 'quad', 'triangle', 'shell', 'object'].includes(next)) return;
	faceEditGranularity.set(/** @type {any} */ (next));
	clearFaceSelection();
}

/** Cycle QUAD -> FACE -> TRIANGLE -> SHELL -> OBJECT (VR keeps one toggle button) */
export function toggleFaceGranularity() {
	const order = ['quad', 'face', 'triangle', 'shell', 'object'];
	setFaceGranularity(
		/** @type {any} */ (order[(order.indexOf(granularity()) + 1) % order.length])
	);
}

/** Toggle Multi mode on/off (drop the accumulated selection either way) */
export function toggleFaceMulti() {
	faceEditMulti.update((v) => !v);
	clearFaceSelection();
}

/** The tri indices the next op targets: the SELECTION whenever non-empty
 * (E10 — the unifying rule, Multi no longer gates it), else the hovered unit
 * (polygon = the tri; face = the coplanar group under the ray/highlight).
 * @returns {number[]} */
function opTargetTris() {
	if (get(faceEditSelectedTris).length)
		return get(faceEditSelectedTris).filter((/** @type {number} */ ti) => FS.workingTris[ti]);
	if (granularity() !== 'face') return pickFaceUnitTris(get(faceEditHoverTri));
	const fi = get(faceEditHighlight);
	return fi >= 0 && FS.faces[fi] ? FS.faces[fi].triIndices.filter((/** @type {number} */ ti) => FS.workingTris[ti]) : [];
}

/** E10: a plain (non-additive) pick REPLACES the selection with the
 * granularity-aware unit under the cursor. @param {number} tri */
function pickFaceUnitInner(tri) {
	faceEditSelectedTris.set(pickFaceUnitTris(tri));
	refreshFaceOverlay();
}

// ---- M2: loop select + grow/shrink -----------------------------------------
// A face LOOP is the classic quad-strip walk: enter a quad through one edge,
// leave through the OPPOSITE one, repeat until you come back or run out of
// quads. It only exists because 15-G derives quads (`pairQuads`) from the
// triangle soup — which is exactly why quad granularity landed first.

/** the quad's 4 ring keys in order (p, ra, q, rb — the shared edge p-q is the
 * diagonal), or null when the two tris do not actually share an edge.
 * P1 (19-A): parameterized on `tris` so the pure op cores (and subdivideLevels'
 * later passes) can run outside the live session — a helper that indexes
 * SESSION state cannot be reused outside it (the diagonalEdgeKeys precedent).
 * @param {any[]} tris @param {number} a @param {number} b
 * @returns {string[] | null} */
function quadRingKeysIn(tris, a, b) {
	const ka = tris[a]?.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	const kb = tris[b]?.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
	if (!ka || !kb) return null;
	const shared = ka.filter((/** @type {string} */ k) => kb.includes(k));
	if (shared.length !== 2) return null;
	const ra = ka.find((/** @type {string} */ k) => !shared.includes(k));
	const rb = kb.find((/** @type {string} */ k) => !shared.includes(k));
	if (!ra || !rb) return null;
	return [shared[0], ra, shared[1], rb];
}

/** the session variant every in-session caller uses (reads `workingTris`).
 * @param {number} a @param {number} b @returns {string[] | null} */
function quadRingKeys(a, b) {
	return quadRingKeysIn(FS.workingTris, a, b);
}

/** @param {string} a @param {string} b */
const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/** quad adjacency, rebuilt with the faces. `edges` maps a quad id (the LOWER of
 * its two triangle indices) to its 4 boundary edge keys in ring order; `byEdge`
 * maps an edge key to the quads touching it.
 * @type {{ edges: Map<number, string[]>, byEdge: Map<string, number[]> } | null} */
let quadTopology = null;

function buildQuadTopology() {
	/** @type {Map<number, string[]>} */
	const edges = new Map();
	/** @type {Map<string, number[]>} */
	const byEdge = new Map();
	for (let ti = 0; ti < FS.workingTris.length; ti++) {
		const mate = FS.quadPartner[ti] ?? -1;
		if (mate < 0 || mate < ti) continue; // one entry per quad, keyed by the lower index
		const ring = quadRingKeys(ti, mate);
		if (!ring) continue;
		const quadEdges = [0, 1, 2, 3].map((i) => edgeKey(ring[i], ring[(i + 1) % 4]));
		edges.set(ti, quadEdges);
		for (const ek of quadEdges) {
			let list = byEdge.get(ek);
			if (!list) byEdge.set(ek, (list = []));
			list.push(ti);
		}
	}
	quadTopology = { edges, byEdge };
	return quadTopology;
}

/** the quad id a triangle belongs to (the lower of the pair), or -1 when it has
 * no mate — a lone triangle breaks a loop rather than guessing across it.
 * @param {number} tri */
function quadIdOf(tri) {
	const mate = FS.quadPartner[tri] ?? -1;
	return mate < 0 ? -1 : Math.min(tri, mate);
}

/**
 * The face loop through a triangle's quad, as the walk ITSELF: each entry is a
 * quad plus the pair of opposite edges the loop crosses it by — M3's loop cut
 * needs that direction, M2's loop select only needs the quads.
 * `axis` picks WHICH of the two loops crossing the start quad to walk (0 or 1):
 * a quad sits on two perpendicular loops, so the toolbar cycles it on a repeat.
 * @param {number} tri @param {number} [axis]
 * @returns {{ quad: number, cross: string[] }[]}
 */
export function faceLoopRing(tri, axis = 0) {
	const start = quadIdOf(tri);
	if (start < 0) return [];
	const topo = quadTopology ?? buildQuadTopology();
	const startEdges = topo.edges.get(start);
	if (!startEdges) return [];
	const a = axis % 2;
	/** @type {{ quad: number, cross: string[] }[]} */
	const ring = [{ quad: start, cross: [startEdges[a], startEdges[a + 2]] }];
	const seen = new Set([start]);
	// walk BOTH ways from the chosen axis's pair of opposite edges
	for (const first of [startEdges[a], startEdges[a + 2]]) {
		let quad = start;
		let edge = first;
		for (let guard = 0; guard < FS.workingTris.length; guard++) {
			// exactly ONE quad on the other side, or the walk stops. `.find` used to
			// take the first of several at a non-manifold edge (two shells welded
			// along a wall, a coplanar T-seam), which sent the loop off into an
			// arbitrary strip — a stop is the honest answer, and it is what every
			// modeller does there.
			const others = (topo.byEdge.get(edge) ?? []).filter((q) => q !== quad);
			const next = others.length === 1 ? others[0] : undefined;
			if (next === undefined || seen.has(next)) break; // boundary, non-quad, or closed
			const edges = topo.edges.get(next);
			const at = edges ? edges.indexOf(edge) : -1;
			if (!edges || at < 0) break;
			seen.add(next);
			const out = edges[(at + 2) % 4]; // straight across
			ring.push({ quad: next, cross: [edge, out] });
			edge = out;
			quad = next;
		}
	}
	return ring;
}

/** The face loop through a triangle's quad, as tri indices. @param {number} tri
 * @param {number} [axis] @returns {number[]} */
export function faceLoopTris(tri, axis = 0) {
	const ring = faceLoopRing(tri, axis);
	if (!ring.length) return tri >= 0 && FS.workingTris[tri] ? [tri] : [];
	/** @type {number[]} */
	const out = [];
	for (const { quad } of ring) {
		out.push(quad);
		const mate = FS.quadPartner[quad] ?? -1;
		if (mate >= 0) out.push(mate);
	}
	return out;
}

/** the axis the last loop select used, so a repeat press walks the OTHER loop.
 * PRIVATE to the select-cycling UX: loop CUT derives its own axis from the
 * selection (loopCutRing), because this used to leak across objects. */
let loopAxis = 0;
/** @type {string} */
let loopSignature = '';

/** forget the cycling state (a new session must not inherit a direction) */
function resetLoopAxis() {
	loopAxis = 0;
	loopSignature = '';
}

/**
 * M2: select the face loop through the current pick. Repeating it on the same
 * loop switches to the perpendicular one (a quad lies on two) — the standard
 * "press again to cycle" affordance, since a single click cannot say which.
 * @returns {boolean}
 */
function selectFaceLoopInner() {
	if (!FS.object) return false;
	const sel = get(faceEditSelectedTris);
	const anchor = /** @type {number} */ (sel.length ? sel[0] : get(faceEditHoverTri));
	if (anchor < 0 || !FS.workingTris[anchor]) {
		showToast('Pick a quad first, then Loop');
		return false;
	}
	if (quadIdOf(anchor) < 0) {
		showToast('Loop select needs a QUAD — this triangle has no pair');
		return false;
	}
	const signature = quadIdOf(anchor) + ':' + sel.length;
	if (signature === loopSignature) loopAxis = (loopAxis + 1) % 2;
	const loop = faceLoopTris(anchor, loopAxis);
	faceEditSelectedTris.set(loop);
	loopSignature = quadIdOf(anchor) + ':' + loop.length;
	refreshFaceOverlay();
	return true;
}

/** every welded position key a triangle set touches @param {number[]} triIndices */
function keysOfTris(triIndices) {
	const keys = new Set();
	for (const ti of triIndices)
		FS.workingTris[ti]?.forEach((/** @type {any} */ v) => keys.add(keyOf(v.x, v.y, v.z)));
	return keys;
}

/**
 * M2: grow the selection by one ring — every triangle touching a selected
 * vertex joins, then each newcomer expands to its full pick UNIT so quads stay
 * whole. @returns {boolean}
 */
function growSelectionInner() {
	if (!FS.object) return false;
	const sel = get(faceEditSelectedTris);
	if (!sel.length) {
		showToast('Select something first, then Grow');
		return false;
	}
	const keys = keysOfTris(sel);
	const next = new Set(sel);
	FS.workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (next.has(ti)) return;
		if (t.some((/** @type {any} */ v) => keys.has(keyOf(v.x, v.y, v.z))))
			pickFaceUnitTris(ti).forEach((u) => next.add(u));
	});
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return true;
}

/**
 * M2: shrink by one ring — drop every triangle that touches the selection's
 * BORDER, i.e. keep only those whose every vertex is interior (i.e. every
 * triangle sharing that vertex is also selected). @returns {boolean}
 */
function shrinkSelectionInner() {
	if (!FS.object) return false;
	const sel = get(faceEditSelectedTris);
	if (!sel.length) return false;
	const selSet = new Set(sel);
	/** @type {Map<string, boolean>} key -> every toucher selected? */
	const interior = new Map();
	FS.workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		const mine = selSet.has(ti);
		t.forEach((/** @type {any} */ v) => {
			const k = keyOf(v.x, v.y, v.z);
			interior.set(k, (interior.get(k) ?? true) && mine);
		});
	});
	const next = sel.filter((/** @type {number} */ ti) =>
		FS.workingTris[ti].every((/** @type {any} */ v) => interior.get(keyOf(v.x, v.y, v.z)))
	);
	faceEditSelectedTris.set(next);
	refreshFaceOverlay();
	return true;
}

// ---- M3: loop cut (insert edge loop) ---------------------------------------


/**
 * M3: insert `cuts` edge loops across the ring the current pick lies on — the
 * single most-used modelling operation. Each quad in the ring is split
 * PERPENDICULAR to the walk direction into cuts+1 sub-quads, interpolating
 * positions and UVs, keeping the material slot, as ONE undoable meshgeo.
 *
 * Like subdivide (meshOps/subdivide.js), the quads FLANKING the ring keep their full edge —
 * a T-junction, and visually seamless because the new vertices sit exactly on
 * that edge. (Blender turns those into n-gons; a triangle soup has no n-gons.)
 * @param {number} cuts @returns {boolean}
 */
/**
 * The ring loop cut will run through, chosen from the SELECTION rather than
 * from `loopAxis`. That module global belongs to the select-cycling UX, and
 * reading it here meant the cut could run perpendicular to the loop the user
 * was looking at — or, on a fresh object, along an axis inherited from the
 * previous session.
 *
 * The rule is one comparison: of the two loops through the anchor, take the
 * one that OVERLAPS the current selection more. After a Loop select (once or
 * pressed again for the perpendicular one) the selection IS one of those two
 * rings, so this reproduces exactly what is highlighted; on a bare hover pick
 * there is nothing to prefer and axis 0 is the deterministic answer.
 * @returns {{quad: number, cross: string[]}[]}
 */
/** @param {boolean} [quiet] 19-A P2: the popup's readiness map probes this
 * reactively — it must never toast on a mere selection change
 * @returns {{pick: {quad: number, cross: string[]}[], alt: {quad: number, cross: string[]}[]}}
 * 19-A P7b: BOTH rings through the anchor — `pick` is the selection-overlap
 * choice (the pre-P7b return value), `alt` the PERPENDICULAR one. The adjust
 * engine captures both at begin so an axis toggle can re-run the cut across
 * the other ring; `alt` may be empty (a pole), which disables the toggle. */
function loopCutRingPair(quiet = false) {
	const sel = get(faceEditSelectedTris).filter((/** @type {number} */ ti) => FS.workingTris[ti]);
	// the lowest-indexed PAIRED triangle: a face/shell selection can hold plenty
	// of unpaired ones, and sel[0] used to be whichever happened to be first
	const anchor = sel.length
		? [...sel].sort((a, b) => a - b).find((ti) => quadIdOf(ti) >= 0)
		: get(faceEditHoverTri);
	if (anchor === undefined || anchor < 0 || !FS.workingTris[anchor]) {
		if (!quiet)
			showToast(sel.length ? 'Loop cut needs a QUAD in the selection' : 'Pick a quad first, then Loop cut');
		return { pick: [], alt: [] };
	}
	if (quadIdOf(anchor) < 0) {
		if (!quiet) showToast('Loop cut needs a QUAD — this triangle has no pair');
		return { pick: [], alt: [] };
	}
	const rings = [faceLoopRing(anchor, 0), faceLoopRing(anchor, 1)];
	let axis = 0;
	if (sel.length) {
		const selQuads = new Set(sel.map((/** @type {number} */ ti) => quadIdOf(ti)).filter((q) => q >= 0));
		const overlap = (/** @type {any[]} */ r) => r.filter((e) => selQuads.has(e.quad)).length;
		if (overlap(rings[1]) > overlap(rings[0])) axis = 1;
	}
	const pick = rings[axis];
	if (!pick.length && !quiet) showToast('No loop runs through that face');
	return { pick, alt: rings[1 - axis] };
}

/** the ring a loop cut runs across (the selection-overlap pick) @param {boolean} [quiet] */
function loopCutRing(quiet = false) {
	return loopCutRingPair(quiet).pick;
}

/** 19-A P2: cheap precondition probe — does a loop cut have a ring to work on?
 * Quiet by design: the popup's readiness map calls it on every pick. */
export function loopCutReady() {
	if (!FS.object) return false;
	return loopCutRing(true).length > 0;
}

/** 19-A P2: cheap precondition probe — Bevel (faces) and Extrude both need a
 * target WITH a border (a closed selection has nothing to fold/stitch from). */
export function faceBevelReady() {
	if (!FS.object) return false;
	const face = opTargetFace();
	if (!face?.triIndices?.length) return false;
	return boundaryEdges(FS.workingTris, face).length > 0;
}

/**
 * P1 (19-A): the PURE core of the loop cut — triangles in, triangles out, no
 * session reads, so the adjust engine can re-run it from a snapshot. The
 * wrapper (and later the engine) owns validation, clamps, stores, commit and
 * selection housekeeping.
 * @param {any[]} tris @param {{quad: number, cross: string[]}[]} ring the walk
 *   from `loopCutRing`/`faceLoopRing`, indices into `tris`
 * @param {Int32Array | number[]} quadPartnerArr quad pairing for `tris`
 * @param {{cuts?: number, position?: number}} [options] cuts = loops to insert
 *   (already clamped). P3: `position` places a SINGLE cut along the ring
 *   segment (0..1, default 0.5 = the previous hardwired midpoint); with
 *   cuts > 1 the schedule stays evenly spaced — the Blender rule.
 * @returns {{tris: any[], origin: number[], authored: number[][], firstNew: number}}
 */
export function loopCutCore(tris, ring, quadPartnerArr, options = {}) {
	// 99 K4 family 3: the kernel loop cut (meshOps/cut.js) on an op mesh of these triangles
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	const { firstNew, consumed } = ops.loopCutRegion(om, ring, quadPartnerArr, options);
	const next = opMeshTris(om);
	const gone = new Set(consumed);
	/** P10: new index -> the input triangle it is, for the survivors (the cut REINDEXES them) */
	const origin = [];
	tris.forEach((/** @type {any} */ _, /** @type {number} */ ti) => {
		if (!gone.has(ti)) origin.push(ti);
	});
	while (origin.length < next.length) origin.push(-1); // the appended band
	return { tris: next, origin, authored: appendedQuads(firstNew, next.length), firstNew };
}

/** @param {number} [cuts] @param {number} [position] P3: single-cut placement
 * along the ring (0..1, default 0.5 = the previous behaviour; ignored at
 * cuts > 1, where the schedule stays even) */
export function commitLoopCut(cuts = 1, position = 0.5) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const n = Math.max(1, Math.min(Math.round(cuts) || 1, 20));
	const ring = loopCutRing();
	if (!ring.length) return false;
	// 99 K4 family 3: on the session's op mesh, IDs carried
	const om = sessionOpMesh();
	if (!om) {
		showToast(KERNEL_LOADING);
		return false;
	}
	const ops = editSession.ops;
	const pick = captureSelection(FS.object.uuid);
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: readStoredFaces(FS.object?.geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let out;
	let firstNew = 0;
	try {
		({ firstNew } = ops.loopCutRegion(om, ring, FS.quadPartner, { cuts: n, position }));
		out = ops.opOutput(om, { order: 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place: re-kept only by the commit
	}
	if (out.positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(out.positions.length, 'edit'));
		return false;
	}
	// clear BEFORE the swap — applyGeometrySnapshot rebuilds the overlay, and the
	// ring's indices now address the reindexed survivor array (the reported
	// "loop cut selects random triangles"); the hover is never cleared otherwise
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	commitMesh({
		apply: 'session',
		before,
		after: { positions: out.positions, groups: out.groups, uvs: out.uvs, ids: out.ids },
		faces: out.faces,
		stampFaces: true,
		record: 'op',
		cap: false,
		selectionBefore: pick
	});
	keepOpMesh(FS.object.uuid, om, out, FS.quadPartner);
	// leave the NEW band selected: it is what you reach for next (scale it, move
	// it, cut it again), and an empty selection after an op that just rebuilt the
	// area under the cursor reads as "nothing happened"
	const band = [];
	for (let ti = firstNew; ti < out.positions.length / 9; ti++) band.push(ti);
	faceEditSelectedTris.set(band);
	refreshFaceOverlay();
	showToast(
		'Loop cut: ' + n + ' loop' + (n === 1 ? '' : 's') + ' across ' + ring.length + ' quads'
	);
	return true;
}

// ---- M4: edge selection ----------------------------------------------------
// Edges are a SUB-MODE of the face session, not a third session kind: the
// session lifecycle, undo barrier, wireframe, gizmo plumbing and VR entry all
// already exist for faces, and an edge selection is just a different thing to
// point at. An edge is its canonical welded key pair, so the two triangles
// sharing it always name it identically.

/** 'faces' picks coplanar units, 'edges' picks single edges (M4)
 * @type {import('svelte/store').Writable<'faces'|'edges'>} */
export const faceEditSubmode = writable('faces');

// Per-MODE selection memory: switching Vertices <-> Edges <-> Faces to look at
// something and coming back should not throw the pick away. Keyed by the object
// and by a geometry SIGNATURE (its vertex count) — an edit that changes the
// topology invalidates the stash, because the stored indices/keys would then
// point at different geometry.
/** @type {{uuid: string, sig: number, faces: number[], edges: string[]}} */
let selectionStash = { uuid: '', sig: -1, faces: [], edges: [] };
/** 24-B1: the element selection the active mode key HID (with its gizmo), waiting for
 * the next mode key or the toolbox's gizmo button. The pick itself sits in
 * `selectionStash` (the exitFaceEdit slot); this only says which submode to put back.
 * Declared up here, before the `meshGizmoEnabled` subscriber that reads it at module
 * eval (the store-subscriber TDZ gotcha).
 * @type {{ uuid: string, submode: 'faces'|'edges' } | null} */
let hiddenElements = null;

/** the current geometry's identity for the stash */
function selectionSignature() {
	return FS.object?.geometry?.attributes?.position?.count ?? -1;
}

/**
 * Remember the pick of the mode being LEFT — one slot, never both.
 *
 * Writing both slots from the live stores looks harmless and is not: the store
 * of the mode you are NOT in is empty whenever the session was just entered
 * (`enterFaceEdit` clears the set and restores only the submode it enters), so
 * a stash that copies both slots writes that emptiness over the other mode's
 * remembered pick. That is what lost a face selection on the way back from
 * Vertices whenever the session had last been in EDGES: enter (restores edges,
 * faces empty) -> setFaceSubmode('faces') -> stash both -> faces := [] ->
 * restore faces -> nothing (reported). The invalidation rules are unchanged —
 * a different object or a different vertex count resets the whole record.
 * @param {'faces'|'edges'} [mode] which slot to write; defaults to the live submode
 */
export function stashSelections(mode) {
	if (!FS.object) return;
	const which = mode ?? (get(faceEditSubmode) === 'edges' ? 'edges' : 'faces');
	const uuid = FS.object.uuid;
	const sig = selectionSignature();
	if (selectionStash.uuid !== uuid || selectionStash.sig !== sig)
		selectionStash = { uuid, sig, faces: [], edges: [] };
	if (which === 'edges') selectionStash.edges = [...get(edgeEditSelected)];
	else selectionStash.faces = [...get(faceEditSelectedTris)];
	// 99 K3: the same pick as element IDs on the session (faces / vertex-ID pairs)
	noteSelectionIds(which === 'edges' ? { edgeKeys: selectionStash.edges } : { tris: selectionStash.faces }, keyOf);
}

/**
 * 24-B1: hide the element selection AND the gizmo — pressing the active mode key on
 * the face/edge proxy, the object-selection "done" gesture applied to elements. The
 * pick is stashed where exitFaceEdit keeps it, the overlay is cleared so the viewport
 * reads as hidden, and the gizmo goes through `meshGizmoEnabled` (the toolbox button's
 * own switch) so the button state agrees with what the key did.
 * @returns {boolean} whether there was anything to hide
 */
export function hideElementSelection() {
	if (!FS.object) return false;
	const submode = get(faceEditSubmode) === 'edges' ? 'edges' : 'faces';
	const count = submode === 'edges' ? get(edgeEditSelected).length : get(faceEditSelectedTris).length;
	if (!count) return false;
	stashSelections(submode);
	hiddenElements = { uuid: FS.object.uuid, submode };
	if (submode === 'edges') clearEdgeSelection();
	else clearFaceSelection();
	if (get(meshGizmoEnabled)) meshGizmoEnabled.set(false);
	else detachFaceGizmo();
	return true;
}

/** the selection half of the restore — also run by the `meshGizmoEnabled` subscriber,
 * so the toolbox button brings the hidden pick back exactly like the key */
function restoreHiddenElements() {
	if (!FS.object || !hiddenElements || hiddenElements.uuid !== FS.object.uuid) return false;
	const { submode } = hiddenElements;
	hiddenElements = null;
	const live = get(faceEditSubmode) === 'edges' ? 'edges' : 'faces';
	if (live !== submode) setFaceSubmode(submode);
	restoreSelection(submode);
	return true;
}

/** 24-B1: the next mode key — put the hidden pick back and seat the gizmo on it.
 * @returns {boolean} whether something was hidden */
export function restoreElementSelection() {
	if (!restoreHiddenElements()) return false;
	if (!get(meshGizmoEnabled)) meshGizmoEnabled.set(true); // its subscriber seats the gizmo
	else attachFaceGizmo();
	return true;
}

/** Put back what this mode had, unless the geometry changed underneath.
 * @param {'faces'|'edges'} mode */
export function restoreSelection(mode) {
	if (!FS.object) return false;
	if (selectionStash.uuid !== FS.object.uuid || selectionStash.sig !== selectionSignature())
		return false;
	if (mode === 'edges') {
		// drop keys whose vertices no longer exist (a defensive second gate)
		const live = selectionStash.edges.filter((k) => !!edgeEndpoints(k));
		edgeEditSelected.set(live);
		refreshEdgeOverlay();
	} else {
		faceEditSelectedTris.set(selectionStash.faces.filter((ti) => !!FS.workingTris[ti]));
		refreshFaceOverlay();
	}
	return true;
}

/**
 * Switch the face session between its FACES and EDGES submodes. The submode
 * flip alone was never enough: the face tint and the seated face gizmo both
 * survived into edge mode, so the quads picked beforehand stayed lit AND the
 * gizmo went on dragging them while the user thought they were editing edges.
 * Stash/restore keeps the per-mode selection memory; the two overlay refreshes
 * are what actually clears the leaving mode's highlight.
 * @param {'faces'|'edges'} next
 */
export function setFaceSubmode(next) {
	if (get(faceEditSubmode) === next) return;
	interruptOpAdjust(); // 19-A P2: a mode switch ends a live adjust (the edit stays)
	stashSelections(get(faceEditSubmode) === 'edges' ? 'edges' : 'faces'); // the mode being LEFT
	faceEditSubmode.set(next);
	restoreSelection(next);
	// order matters only in that both must run: the face overlay tears itself
	// down and returns early in 'edges' (see refreshFaceOverlay), the edge
	// overlay does the same in 'faces'
	refreshFaceOverlay();
	refreshEdgeOverlay();
	if (typeof window === 'undefined') return;
	// Move is the only op that keeps a gizmo seated (setFaceOp's B1 rule) — in edge mode
	// too, where attachFaceGizmo seats the EDGE gizmo and detaches itself when nothing
	// is picked
	if (get(faceEditOp) === 'move') attachFaceGizmo();
	else detachFaceGizmo();
}

// ---- selection history -----------------------------------------------------
// Picks are undoable INSIDE an edit session (the user's ask): Ctrl+Z walks back
// a loop select, a grow, an invert. The entries are SESSION-LOCAL — the 15-F
// seal drops them on Done (history.js), because the sealed entry describes the
// geometry change, not which faces happened to be lit at the time.
//
// This is the ONE history kind that does not broadcast: a selection is per
// viewer, and the peers never knew about it in the first place.

/** vertices live in meshEdit, which imports THIS module — the reverse edge
 * would close a TDZ cycle, so meshEdit REGISTERS its accessors here instead.
 * 37 R11 adds the POSITION pair: a live-symmetry mirror rebuilds the handles in triangle
 * order, so the picks cross it as positions and are re-found after.
 * @type {{snapshot: () => {uuid: string, sel: number[]} | null, apply: (sel: number[]) => boolean,
 *   positions?: () => any, reselect?: (picks: any) => void} | null} */
let vertexSelectionHistory = null;

/** @param {{snapshot: () => any, apply: (sel: number[]) => boolean, positions?: () => any,
 *   reselect?: (picks: any) => void}} hooks */
export function registerVertexSelectionHistory(hooks) {
	vertexSelectionHistory = hooks;
}

/** guards against a wrapped command calling another wrapped command (granularity
 * changes clear the selection, loop select replaces it) — the OUTER pair wins */
let recordingSelection = false;

/** @param {'faces'|'edges'|'vertices'} mode */
function selectionSnapshot(mode) {
	if (mode === 'vertices') {
		const state = vertexSelectionHistory?.snapshot();
		return state ? { uuid: state.uuid, sel: [...state.sel] } : null;
	}
	if (!FS.object) return null;
	return {
		uuid: FS.object.uuid,
		sel: mode === 'edges' ? [...get(edgeEditSelected)] : [...get(faceEditSelectedTris)]
	};
}

/** selections are sets — order is an implementation detail of how they were built
 * @param {any[]} a @param {any[]} b */
function sameSelection(a, b) {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((v) => set.has(v));
}

/**
 * Run a selection command and record what it changed. A no-op records nothing,
 * so clicking the same face twice does not fill the stack.
 * @template T @param {'faces'|'edges'|'vertices'} mode @param {() => T} run @returns {T}
 */
export function withSelectionHistory(mode, run) {
	if (recordingSelection) return run();
	// 19-A P2: a PICK ends a live op adjust (a recorded desktop adjust keeps its
	// geometry — the entry was written at apply; a deferred VR one reverts its
	// preview). This is the one choke point every selection command routes
	// through, in all three element modes.
	interruptOpAdjust();
	const before = selectionSnapshot(mode);
	recordingSelection = true;
	let result;
	try {
		result = run();
	} finally {
		recordingSelection = false;
	}
	const after = selectionSnapshot(mode);
	// M4: every edge-selection change goes through here (pick/loop/ring/all/invert/
	// clear), so this is the ONE place the edge gizmo has to be re-seated — it lands on
	// the new selection's centroid, or detaches itself when nothing is picked.
	// The LIVE submode has to be checked as well as the argument: `exitFaceEdit`
	// detaches and THEN clears the edge selection, and while in FACE mode that clear
	// would otherwise re-attach the gizmo to the still-selected faces on the way out.
	if (
		mode === 'edges' &&
		typeof window !== 'undefined' &&
		get(faceEditSubmode) === 'edges' &&
		get(faceEditOp) === 'move'
	)
		attachFaceGizmo();
	if (before && after && before.uuid === after.uuid && !sameSelection(before.sel, after.sel))
		recordEntry({
			kind: 'selection',
			uuid: after.uuid,
			mode,
			// the geometry the indices/keys describe: a topology change invalidates
			// them, and the applier refuses rather than lighting up nonsense
			sig: mode === 'vertices' ? -1 : selectionSignature(),
			before: before.sel,
			after: after.sel
		});
	return result;
}

// replay: set the stores back and rebuild the overlay. LOCAL ONLY — no peer send.
registerHistoryKind('selection', (entry, state) => {
	const sel = Array.isArray(state) ? state : [];
	if (entry.mode === 'vertices') return vertexSelectionHistory?.apply(sel) ?? false;
	if (!FS.object || FS.object.uuid !== entry.uuid || selectionSignature() !== entry.sig) {
		showToast('That selection belongs to different geometry');
		return false;
	}
	// undoing a face pick made before an edge detour must be VISIBLE
	if (get(faceEditSubmode) !== (entry.mode === 'edges' ? 'edges' : 'faces'))
		faceEditSubmode.set(entry.mode === 'edges' ? 'edges' : 'faces');
	if (entry.mode === 'edges') edgeEditSelected.set(sel.filter((k) => !!edgeEndpoints(k)));
	else faceEditSelectedTris.set(sel.filter((ti) => !!FS.workingTris[ti]));
	// The click that RECORDED this entry also set the hover + highlight, and the
	// desktop has no pointermove path to move them off again. Leaving them alone
	// brings the quad this undo just deselected straight back as the hover wash
	// ("the last quad keeps its highlight"), and leaves the gizmo seated on a
	// target the selection no longer contains — the P1 stale-gizmo bug by another
	// route. VR re-sets the hover from the beam on the next frame.
	faceEditHoverTri.set(-1);
	faceEditHighlight.set(-1);
	refreshFaceOverlay();
	refreshEdgeOverlay();
	if (typeof window !== 'undefined') {
		// attachFaceGizmo detaches itself when the restored selection has no target,
		// in either submode (M4: the edge gizmo goes through the same call)
		if (get(faceEditOp) === 'move') attachFaceGizmo();
		else detachFaceGizmo();
	}
	return true;
});

// The selection COMMANDS, each wrapped so one press is one undo step. The
// bodies above are the *Inner functions; only these are exported, so every
// caller (toolbar, shortcuts, VR, Scene dispatch) records without knowing it.

/** Multi mode: toggle the picked unit into the accumulated selection. @param {number} tri */
export function toggleFaceSelection(tri) {
	return withSelectionHistory('faces', () => toggleFaceSelectionInner(tri));
}
/** Clear the accumulated multi-selection */
export function clearFaceSelection() {
	withSelectionHistory('faces', () => clearFaceSelectionInner());
}
/** E10: a plain pick REPLACES the selection with the unit under the cursor. @param {number} tri */
export function pickFaceUnit(tri) {
	withSelectionHistory('faces', () => pickFaceUnitInner(tri));
}
/** M2: select the face loop through the current pick. @returns {boolean} */
export function selectFaceLoop() {
	return withSelectionHistory('faces', () => selectFaceLoopInner());
}
/** M2: grow the selection by one ring. @returns {boolean} */
export function growSelection() {
	return withSelectionHistory('faces', () => growSelectionInner());
}
/** M2: shrink the selection by one ring. @returns {boolean} */
export function shrinkSelection() {
	return withSelectionHistory('faces', () => shrinkSelectionInner());
}
/** M6: select every triangle of the mesh. @returns {boolean} */
export function selectAllFaces() {
	return withSelectionHistory('faces', () => selectAllFacesInner());
}
/** M6: invert the selection (by pick UNIT, so quads stay whole). @returns {boolean} */
export function invertFaceSelection() {
	return withSelectionHistory('faces', () => invertFaceSelectionInner());
}
/** M6: grow the selection to every CONNECTED triangle. @returns {boolean} */
export function selectLinkedFaces() {
	return withSelectionHistory('faces', () => selectLinkedFacesInner());
}
/** M4: pick an edge — additive toggles it into the set, else it replaces it.
 * @param {string} key @param {boolean} [additive] */
export function pickEdge(key, additive = false) {
	return withSelectionHistory('edges', () => pickEdgeInner(key, additive));
}
/** M4: drop the edge selection */
export function clearEdgeSelection() {
	withSelectionHistory('edges', () => clearEdgeSelectionInner());
}
/** M4: the edge LOOP through each pick. @returns {boolean} */
export function selectEdgeLoop() {
	return withSelectionHistory('edges', () => selectEdgeLoopInner());
}
/** M4: the edge RING through each pick. @returns {boolean} */
export function selectEdgeRing() {
	return withSelectionHistory('edges', () => selectEdgeRingInner());
}
/** select every REAL edge of the mesh (Ctrl+A in edge mode). @returns {boolean} */
export function selectAllEdges() {
	return withSelectionHistory('edges', () => selectAllEdgesInner());
}
/** invert the edge selection (Ctrl+I in edge mode). @returns {boolean} */
export function invertEdgeSelection() {
	return withSelectionHistory('edges', () => invertEdgeSelectionInner());
}
/** selected edge keys, canonical `ka|kb` @type {import('svelte/store').Writable<string[]>} */
export const edgeEditSelected = writable(/** @type {string[]} */ ([]));
/** the edge under the cursor, or '' @type {import('svelte/store').Writable<string>} */
export const edgeEditHover = writable('');

/** the two endpoints of a canonical edge key, as live positions from the mesh
 * @param {string} key @returns {any[] | null} */
export function edgeEndpoints(key) {
	const [ka, kb] = key.split('|');
	/** @type {any} */ let a = null;
	/** @type {any} */ let b = null;
	for (const t of FS.workingTris)
		for (const v of t) {
			const k = keyOf(v.x, v.y, v.z);
			if (!a && k === ka) a = v;
			if (!b && k === kb) b = v;
		}
	return a && b ? [a, b] : null;
}

/**
 * M4: the edge of triangle `tri` nearest a hit point. In edge mode EVERY click
 * picks an edge, so no pixel threshold is needed — nearest wins, which is also
 * zoom-independent (a screen-space threshold is not). @param {number} tri
 * @param {any} point object-local hit point @returns {string}
 */
export function pickEdgeAt(tri, point) {
	const t = FS.workingTris[tri];
	if (!t || !point) return '';
	// SKIP the quad's internal diagonal: it is a triangulation artifact, not an
	// edge of the model. Offering it let a user pick "an edge" that cannot be
	// dissolved (removing it just re-triangulates the same quad and the line
	// comes straight back) — the reported "dissolve does nothing".
	const mate = FS.quadPartner[tri] ?? -1;
	let diagonal = '';
	if (mate >= 0) {
		const ring = quadRingKeys(Math.min(tri, mate), Math.max(tri, mate));
		if (ring) diagonal = edgeKey(ring[0], ring[2]);
	}
	let best = '';
	let bestD = Infinity;
	for (let e = 0; e < 3; e++) {
		const p0 = t[e];
		const p1 = t[(e + 1) % 3];
		// distance from the point to the SEGMENT
		const ab = new THREE.Vector3().subVectors(p1, p0);
		const len = ab.lengthSq();
		const s = len > 1e-12 ? Math.min(Math.max(new THREE.Vector3().subVectors(point, p0).dot(ab) / len, 0), 1) : 0;
		const key = edgeKey(keyOf(p0.x, p0.y, p0.z), keyOf(p1.x, p1.y, p1.z));
		if (key === diagonal) continue;
		const d = point.distanceToSquared(p0.clone().addScaledVector(ab, s));
		if (d < bestD) {
			bestD = d;
			best = key;
		}
	}
	return best;
}

/** M4: hover an edge; returns true when it CHANGED (VR/overlay gate)
 * @param {string} key */
export function highlightEdge(key) {
	if (get(edgeEditHover) === key) return false;
	edgeEditHover.set(key);
	refreshEdgeOverlay();
	return true;
}

/** M4: pick an edge — additive toggles it into the set, else it replaces it.
 * @param {string} key @param {boolean} [additive] */
function pickEdgeInner(key, additive = false) {
	if (!key) return false;
	edgeEditSelected.update((sel) => {
		if (!additive) return [key];
		const set = new Set(sel);
		if (set.has(key)) set.delete(key);
		else set.add(key);
		return [...set];
	});
	refreshEdgeOverlay();
	return true;
}

/** M4: drop the edge selection */
function clearEdgeSelectionInner() {
	if (get(edgeEditSelected).length) edgeEditSelected.set([]);
	edgeEditHover.set('');
	refreshEdgeOverlay();
}

/**
 * M4: the edge loop through an edge — walk the quad ring the edge crosses and
 * collect the parallel edge on every quad. Reuses M2's ring walk: an edge loop
 * IS the face ring's rungs. @param {string} key @returns {string[]}
 */
/** every REAL (non-diagonal) edge of the mesh, with the quads on either side.
 * @returns {Map<string, number[]>} */
function realEdgeMap() {
	const topo = quadTopology ?? buildQuadTopology();
	return topo.byEdge;
}

/** the edges meeting a welded vertex key @param {string} vk */
function edgesAtVertex(vk) {
	/** @type {string[]} */
	const out = [];
	for (const key of realEdgeMap().keys()) {
		const [a, b] = key.split('|');
		if (a === vk || b === vk) out.push(key);
	}
	return out;
}

/**
 * M4 (round 3): the TRUE edge loop — the standard walk every modeller expects.
 * At each endpoint, continue to the edge that shares NO face with the current
 * one; that only exists at a regular (valence-4) vertex, so the walk stops at
 * poles and borders exactly like Blender's. This is a CHAIN of edges running
 * end to end, which is a different thing from the edge RING below, and mixing
 * the two is what made "loop select on a subdivided top" pick the inner edges.
 * @param {string} key @returns {string[]}
 */
export function edgeLoopChain(key) {
	const byEdge = realEdgeMap();
	if (!byEdge.has(key)) return [key];
	const facesOf = (/** @type {string} */ k) => new Set(byEdge.get(k) ?? []);
	const keys = new Set([key]);
	for (const startVertex of key.split('|')) {
		let current = key;
		let vertex = startVertex;
		for (let guard = 0; guard < 4096; guard++) {
			const mine = facesOf(current);
			const candidates = edgesAtVertex(vertex).filter((k) => {
				if (k === current) return false;
				// share NO face with the current edge = "straight on" through the fan
				return [...facesOf(k)].every((q) => !mine.has(q));
			});
			// a regular vertex leaves exactly one; a pole leaves 0 or many -> stop
			if (candidates.length !== 1) break;
			const next = candidates[0];
			if (keys.has(next)) break; // closed
			keys.add(next);
			const [a, b] = next.split('|');
			vertex = a === vertex ? b : a;
			current = next;
		}
	}
	return [...keys];
}

/** M4: the edge RING — the parallel rungs a FACE loop crosses (not a chain).
 * @param {string} key @returns {string[]} */
export function edgeLoopKeys(key) {
	const topo = quadTopology ?? buildQuadTopology();
	// the quad(s) this edge belongs to; start from either
	const start = (topo.byEdge.get(key) ?? [])[0];
	if (start === undefined) return [key];
	const edges = topo.edges.get(start);
	if (!edges) return [key];
	const at = edges.indexOf(key);
	if (at < 0) return [key];
	// the loop runs across the quad from this edge to the opposite one
	const ring = faceLoopRing(start, at % 2);
	const keys = new Set([key]);
	for (const entry of ring) for (const ek of entry.cross) keys.add(ek);
	return [...keys];
}

/**
 * M4: grow the edge selection to a loop.
 *
 * Two rules, in order, because one click cannot say which loop is meant:
 *  1. If every picked edge borders ONE COMMON quad, complete THAT quad's
 *     border. Picking two edges of a box's top face and pressing Loop then
 *     gives the other two — the reported expectation, and the only reading
 *     that actually uses the fact that several edges were picked.
 *  2. Otherwise take the UNION of each pick's edge ring (the parallel rungs a
 *     face loop crosses), so two unrelated picks give two rings instead of the
 *     first pick silently winning and the rest being discarded.
 * @returns {boolean}
 */
function selectEdgeLoopInner() {
	const sel = get(edgeEditSelected);
	if (!sel.length) {
		showToast('Pick an edge first, then Loop');
		return false;
	}
	const topo = quadTopology ?? buildQuadTopology();
	// rule 1 — SEVERAL picks that all border ONE quad mean "finish this face":
	// complete that quad's border. This only fires for a genuine multi-pick on a
	// single quad, so it can never hijack the loop walk on a subdivided surface.
	if (sel.length > 1) {
		const shared = (topo.byEdge.get(sel[0]) ?? []).filter((quad) =>
			sel.every((/** @type {string} */ key) => (topo.byEdge.get(key) ?? []).includes(quad))
		);
		const border = shared.length ? topo.edges.get(shared[0]) : null;
		if (border?.length) {
			edgeEditSelected.set([...border]);
			refreshEdgeOverlay();
			return true;
		}
	}
	// rule 2 — the true edge LOOP through each pick, unioned. A chain running end
	// to end, NOT the ring of rungs: on a subdivided face the ring is the inner
	// edges, which is exactly the wrong answer for "loop select".
	/** @type {Set<string>} */
	const keys = new Set();
	for (const key of sel) for (const k of edgeLoopChain(key)) keys.add(k);
	edgeEditSelected.set([...keys]);
	refreshEdgeOverlay();
	return true;
}

/** M4: the edge RING through each pick (the parallel rungs a face loop crosses)
 * — the other half of the standard pair, offered as its own command. */
function selectEdgeRingInner() {
	const sel = get(edgeEditSelected);
	if (!sel.length) {
		showToast('Pick an edge first, then Ring');
		return false;
	}
	/** @type {Set<string>} */
	const keys = new Set();
	for (const key of sel) for (const k of edgeLoopKeys(key)) keys.add(k);
	edgeEditSelected.set([...keys]);
	refreshEdgeOverlay();
	return true;
}

/** select every REAL edge of the mesh (Ctrl+A in edge mode) */
function selectAllEdgesInner() {
	if (!FS.object) return false;
	edgeEditSelected.set([...realEdgeMap().keys()]);
	refreshEdgeOverlay();
	return true;
}

/** invert the edge selection (Ctrl+I in edge mode) */
function invertEdgeSelectionInner() {
	if (!FS.object) return false;
	const sel = new Set(get(edgeEditSelected));
	edgeEditSelected.set([...realEdgeMap().keys()].filter((k) => !sel.has(k)));
	refreshEdgeOverlay();
	return true;
}

/**
 * M5 BEVEL, on a FACE selection: fold the face's border into a chamfer.
 *
 * Each step insets the face and pushes the shrinking cap along its normal, so the border
 * becomes a ring of chamfer quads; `segments` steps make it a faceted round. Both halves
 * are the EXISTING pure ops (`insetFace` + the welded `moveFaceAlongNormal`), which is
 * the whole reason this is watertight — the ring insetFace stitches shares the cap's
 * corners, and the welded move carries them together.
 *
 * Why not on an EDGE selection, which is where a modeller reaches for bevel first: a true
 * edge bevel deletes the edge's vertices and hands the NEIGHBOURING faces two vertices in
 * their place, so every face around each endpoint gains a corner. Folding only the two
 * faces that touch the edge leaves the third face at each corner still using the old
 * vertex, and the mesh cracks along the edges it shared with them — measured as 12
 * non-manifold edges on a box, which is why that pass was dropped rather than shipped.
 * The vertex-fan surgery on adjacent faces is the remaining work; edge mode says so.
 */
/**
 * P1 (19-A): the PURE core of the FACE bevel — the inset+push loop, triangles
 * in, triangles out, no session reads. The wrapper (and later the adjust
 * engine) owns the clamps, stores and the commit block.
 *
 * P3: `width` is a WORLD distance now, like the edge and vertex bevels — each
 * step converts its share to an inset fraction PER CONNECTED COMPONENT
 * (`insetDistanceToFraction`), so the border travels ≈ width world units
 * whatever the face size (it used to be an inset fraction, so the same number
 * meant two different chamfer sizes across the three modes). `profile` lerps
 * the step SCHEDULE between linear (0 — a straight 45° chamfer) and the
 * sin/cos quarter-circle (1 — the only schedule until P3, hence the default);
 * both columns sum to 1 across the steps, so the total reach is
 * profile-independent. `direction` signs the push: 'in' recesses the cap
 * (depth used to be hardwired to +total).
 *
 * P7a: `profile` is -1..1 now. A NEGATIVE profile blends toward the CONCAVE
 * quarter circle, which is the same arc with the trig roles swapped — see the
 * schedule comment in the loop below.
 * @param {any[]} tris @param {{triIndices: number[], normal: any, centroid: any}} face
 * @param {{width?: number, segments?: number, profile?: number, direction?: 'out'|'in'}} [options]
 *   width/segments already clamped
 * @returns {{tris: any[], authored: number[][], capTriIndices: number[]}}
 */
export function bevelFacesCore(tris, face, options = {}) {
	// 99 K4 family 2: the kernel face bevel (meshOps/bevel.js) on an op mesh of these triangles
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	ops.bevelRegion(om, face.triIndices, vec(face.normal), options);
	const authored = ops.authoredFaces(om);
	return { tris: opMeshTris(om), authored, capTriIndices: [...face.triIndices] };
}

/** @param {number} width WORLD distance the border travels (P3 — was an inset fraction)
 * @param {number} segments @param {number} [profile] -1 concave quarter-circle ..
 *   0 linear .. 1 convex quarter-circle (P7a widened the range; 1 is unchanged)
 * @param {'out'|'in'} [direction] @returns {boolean} */
export function bevelFaces(width = 0.15, segments = 1, profile = 1, direction = 'out') {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const face = opTargetFace();
	if (!face?.triIndices?.length) {
		showToast('Select a face first, then Bevel');
		return false;
	}
	if (!boundaryEdges(FS.workingTris, face).length) {
		showToast(
			'Nothing to bevel: that selection is a CLOSED surface, so it has no border to fold. Select fewer faces.'
		);
		return false;
	}
	const n = Math.max(1, Math.min(Math.round(segments) || 1, 8));
	// world units since P3: no upper clamp — the per-step fraction conversion
	// saturates at 0.95 per component, so an oversized width collapses inward
	// instead of overshooting past the centre
	const total = Math.max(width, 0.001);
	// 99 K4 family 2: on the kernel (the cap stays selected: scaling or moving it is the usual next move)
	if (!commitKernelFaceOp('bevel', face, { width: total, segments: n, profile, direction })) return false;
	showToast('Bevelled the border in ' + n + ' segment' + (n === 1 ? '' : 's'));
	return true;
}


// ---- M5b: VERTEX bevel, on the corner surgery an EDGE bevel needs too ------
//
// The face bevel (bevelFaces) is built from inset+move and is watertight for free. A VERTEX
// or EDGE bevel cannot be: it has to REMOVE the corner and hand every face around it two
// vertices in its place. That surgery is exactly what the first edge-bevel attempt skipped,
// which is why a bevelled box came out with 12 non-manifold edges — folding only the two
// faces touching the edge left the third face at each corner still on the old vertex.
//
// Doing it per LOGICAL FACE is what makes it correct: a face's ordered boundary
// (boundaryLoop) names the two REAL edges leaving the corner (a triangulation diagonal
// never appears in a boundary), the offset points are keyed by EDGE so the two faces
// sharing one land on the SAME point, and each face is re-fanned from its new polygon. The
// hole left behind is capped, and that cap is the new bevel surface.
//
// 99 K4 family 2: the vertex and edge bevels run on the kernel now (src/lib/meshOps/bevel.js +
// rebuild.js, the same rules — QUESTIONS 9 kept the soup's coplanar regions); what stays here
// is their session / object glue and the soup-shaped exports (adapters).

/** corner key -> {pos, uv} for one face's triangles, so a rebuilt polygon keeps its mapping
 * @param {any[]} tris @param {number[]} triIndices */
function cornerData(tris, triIndices) {
	/** @type {Map<string, {pos: any, uv: number[]}>} */
	const map = new Map();
	for (const ti of triIndices)
		tris[ti]?.forEach((/** @type {any} */ v, /** @type {number} */ c) => {
			const key = keyOf(v.x, v.y, v.z);
			if (!map.has(key)) map.set(key, { pos: v, uv: uvAt(tris[ti], c) });
		});
	return map;
}



/**
 * P1 (19-A): the PURE core of the VERTEX bevel — the per-key corner surgery
 * loop, triangles in, triangles out, no session or scene reads. Each vertex is
 * processed against the CURRENT triangles (two selected corners of one face
 * both land correctly), with the width clamped per edge inside `bevelOneVertex`
 * (`clampedBevelWidth`) so two bevels sharing an edge can never cross.
 * @param {any[]} tris @param {string[]} vertexKeys welded position keys
 * @param {{width?: number, profile?: number, segments?: number}} [options] width/profile
 *   already clamped; P7c segments 1..8 (clamped here)
 * @returns {{tris: any[], caps: string[][], done: number, skipped: number}}
 *   caps = each bevelled corner's cap ring keys, for the wrapper's authoring
 */
export function bevelVerticesCore(tris, vertexKeys, options = {}) {
	// 99 K4 family 2: the kernel vertex bevel (meshOps/bevel.js) on an op mesh of these triangles
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	const r = ops.bevelVertices(om, vertexKeys, options);
	if (!r.done) return { tris, caps: [], done: 0, skipped: r.skipped };
	const p = om.mesh.vPos;
	const caps = r.caps.map((/** @type {number[]} */ cap) => cap.map((/** @type {number} */ v) => keyOf(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])));
	return { tris: opMeshTris(om), caps, done: r.done, skipped: r.skipped };
}

/**
 * M5b VERTEX BEVEL: cut the corner off every selected vertex.
 *
 * Driven from the VERTEX mode selection (any number of vertices) and keyed by welded
 * position, so it needs no live face session. Each vertex is processed against the CURRENT
 * triangles, so two selected corners of one face both land correctly, and the width is
 * clamped per edge so two bevels sharing an edge can never cross.
 * @param {string} uuid @param {string[]} vertexKeys welded position keys
 * @param {{width?: number, profile?: number, segments?: number}} [options]
 * @returns {boolean}
 */
export function bevelVertices(uuid, vertexKeys, options = {}) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	const object = lookupEditable(uuid);
	if (!object?.geometry?.attributes?.position) return false;
	if (!vertexKeys?.length) {
		showToast('Select a vertex first, then Bevel');
		return false;
	}
	const width = Math.max(options.width ?? 0.2, 1e-4);
	const profile = Math.min(Math.max(options.profile ?? 0, -1), 1);
	const ops = editSession.ops;
	if (!ops) {
		showToast(KERNEL_LOADING);
		return false;
	}
	const geometry = object.geometry;
	const inputTris = readTriangles(geometry);
	const pick = captureSelection(uuid);
	// 99 K4 family 2: on the kernel (the held op mesh of this geometry, IDs carried)
	const om = heldOpMesh(ops, geometry, () => partitionOfGeometry(geometry, inputTris), OBJECT_PARTNER);
	const before = {
		positions: trisToPositions(inputTris),
		groups: trisToGroups(inputTris),
		uvs: trisToUVs(inputTris),
		faces: readStoredFaces(geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let out = null;
	let done = 0;
	let skipped = 0;
	try {
		({ done, skipped } = ops.bevelVertices(om, vertexKeys, { width, profile, segments: options.segments }));
		// each cap is ONE face, every other triangle its own (the soup wrapper's composeFaces(null, ...))
		if (done) out = ops.opOutput(om, { order: 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place: re-kept only by a commit
	}
	if (!done) {
		showToast(
			'Nothing to bevel there: a vertex needs at least three faces around it (an open border needs a different tool)'
		);
		return false;
	}
	const after = { positions: out.positions, groups: out.groups, uvs: out.uvs, faces: out.faces, ids: out.ids };
	if (!commitMeshGeoTriple(uuid, before, after, true, pick)) return false;
	keepOpMesh(uuid, om, out, OBJECT_PARTNER);
	showToast(
		'Bevelled ' +
			done +
			(done === 1 ? ' vertex' : ' vertices') +
			(skipped ? ' (' + skipped + ' skipped: open border)' : '')
	);
	return true;
}

/**
 * Commit a full geometry TRIPLE for any object, session or not.
 *
 * `commitMeshGeoSnapshot` is positions-only, and a bevel CHANGES the triangle count, so the
 * carry-over cannot save the groups and uvs — a textured or multi-material mesh lost them.
 * @param {string} uuid @param {any} before @param {any} after
 * @param {boolean} [op] an OPERATOR's commit — the live-symmetry boundary (37 R11)
 * @param {any} [selectionBefore] the operator's starting pick (`captureSelection`), restored by its undo (99 K4)
 * @returns {boolean}
 */
export function commitMeshGeoTriple(uuid, before, after, op = false, selectionBefore = null) {
	// 99 K2: the one commit. `faces` = the partition the caller authored (applied packed); the
	// colours ride both sides (mcp-shapes); the topology on the wire is read off the object.
	// 37 R11: `op` = an operator's commit (vertex mode) — the live-symmetry boundary
	return !!commitMesh({
		uuid,
		apply: 'object',
		before,
		after,
		faces: after.faces,
		carryColors: true,
		record: op ? 'op' : 'entry',
		cap: 'edit',
		selectionBefore
	});
}


/**
 * 19-A P5a: DELETE the selected vertices — every triangle touching one of the welded
 * keys goes away with them.
 *
 * Keyed by welded position like `bevelVertices`, so it needs no live face session: the
 * vertex mode is a meshEdit session and the triangle soup lives here. Deletion makes
 * HOLES by design — that is what the tool is for — so there is deliberately no
 * watertightness check, only the two refusals that would leave nothing behind.
 * @param {string} uuid @param {string[]} vertexKeys welded position keys
 * @returns {boolean}
 */
export function deleteVertices(uuid, vertexKeys) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	const object = lookupEditable(uuid);
	if (!object?.geometry?.attributes?.position) return false;
	if (!vertexKeys?.length) {
		showToast('Select a vertex first, then Delete');
		return false;
	}
	const geometry = object.geometry;
	const inputTris = readTriangles(geometry);
	const stored = readStoredFaces(geometry);
	// 99 K4 family 5: on the kernel. Every survivor keeps the face it was in (the mergeByDistance shape); a mesh
	// with NO stored partition commits every survivor as its own face, as the soup operator did (composeFaces(null))
	const r = objectKernelCommit(
		uuid,
		object,
		() => partitionOfGeometry(geometry, inputTris),
		inputTris,
		(ops, om) => {
			const drop = ops.trianglesTouching(om, ops.verticesOfKeys(om, vertexKeys));
			if (!drop.length) return { error: 'Nothing to delete — no face uses those vertices' };
			if (drop.length >= om.view.count) return { error: 'That would delete every face of the mesh — pick fewer vertices' };
			return ops.deleteTriangles(om, drop);
		},
		{ op: true, faces: stored ? undefined : (count) => Array.from({ length: count }, (_, t) => [t]) }
	);
	if ('error' in r) {
		showToast(r.error);
		return false;
	}
	showToast(
		'Deleted ' +
			r.dropped +
			(r.dropped === 1 ? ' face' : ' faces') +
			' around ' +
			vertexKeys.length +
			(vertexKeys.length === 1 ? ' vertex' : ' vertices')
	);
	return true;
}

/**
 * 19-A P5b: SMOOTH / RELAX the selected vertices — a Laplacian lerp toward the average
 * of each vertex's welded neighbours, `iterations` passes.
 *
 * Keyed by welded position like `bevelVertices`/`deleteVertices` (vertex mode is a
 * meshEdit session, so no face session exists), and the WORK lives here for the same
 * reason theirs does: readTriangles, the commit path and the size cap are this
 * module's. Neighbours = welded keys sharing a TRIANGLE edge (quad diagonals included:
 * the relax wants the full welded star, and the diagonal connections are what keep a
 * quad's interior from lagging its corners). Each pass is JACOBI — every average reads
 * the PRE-pass positions, then all moves land at once — so the result is
 * order-independent and a test can derive it exactly.
 *
 * Counts never change, so this commits POSITIONS-ONLY (`commitMeshGeoSnapshot`):
 * groups/uvs ride the applier's carry-over and the stored topology rides `carryFaces`,
 * both of which succeed here BY CONSTRUCTION because the triangle count matches
 * (verified: applyMeshGeo's positions-only path calls carryFaces, and storeFaces
 * validates against the unchanged count).
 * @param {string} uuid @param {string[]} vertexKeys welded position keys
 * @param {{factor?: number, iterations?: number}} [options]
 * @returns {boolean}
 */
export function smoothVertices(uuid, vertexKeys, options = {}) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	const object = lookupEditable(uuid);
	if (!object?.geometry?.attributes?.position) return false;
	if (!vertexKeys?.length) {
		showToast('Select a vertex first, then Smooth');
		return false;
	}
	const factor = Math.min(Math.max(options.factor ?? 0.5, 0), 1);
	const iterations = Math.max(1, Math.min(Math.round(options.iterations ?? 1) || 1, 10));
	const inputTris = readTriangles(object.geometry);
	// welded positions (evolving, keyed by the ORIGINAL welded key — the map never
	// re-keys, so the write-back below can look corners up by their pre-op position)
	/** @type {Map<string, any>} */
	const pos = new Map();
	/** @type {Map<string, Set<string>>} */
	const adj = new Map();
	for (const t of inputTris) {
		const keys = t.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z));
		keys.forEach((/** @type {string} */ k, /** @type {number} */ c) => {
			if (!pos.has(k)) pos.set(k, t[c].clone());
		});
		for (let e = 0; e < 3; e++) {
			const a = keys[e];
			const b = keys[(e + 1) % 3];
			if (a === b) continue;
			let sa = adj.get(a);
			if (!sa) adj.set(a, (sa = new Set()));
			sa.add(b);
			let sb = adj.get(b);
			if (!sb) adj.set(b, (sb = new Set()));
			sb.add(a);
		}
	}
	const selected = vertexKeys.filter((k) => pos.has(k));
	if (!selected.length) {
		showToast('Nothing to smooth — those vertices are not on this mesh');
		return false;
	}
	for (let pass = 0; pass < iterations; pass++) {
		/** @type {Map<string, any>} */
		const moved = new Map();
		for (const k of selected) {
			const around = adj.get(k);
			if (!around?.size) continue; // an isolated vertex has no average to move toward
			const avg = new THREE.Vector3();
			for (const nk of around) avg.add(pos.get(nk));
			avg.multiplyScalar(1 / around.size);
			moved.set(k, pos.get(k).clone().lerp(avg, factor));
		}
		for (const [k, p] of moved) pos.set(k, p);
	}
	// write through: every corner on a selected key takes its relaxed position. The
	// lookup key is the corner's ORIGINAL position, so all members of a welded group
	// land on the identical Vector3 — no tearing by construction.
	const selSet = new Set(selected);
	const out = cloneTris(inputTris);
	for (const t of out)
		t.forEach((/** @type {any} */ v) => {
			const k = keyOf(v.x, v.y, v.z);
			if (selSet.has(k)) v.copy(pos.get(k));
		});
	const before = trisToPositions(inputTris);
	const after = trisToPositions(out);
	if (JSON.stringify(before) === JSON.stringify(after)) return false; // factor 0 / already flat
	return commitMeshGeoSnapshot(uuid, before, after, true);
}

/**
 * M5c EDGE BEVEL: replace the edge with a chamfer strip, doing the corner surgery properly
 * this time.
 *
 * The first attempt folded only the two faces touching the edge and left every other face at
 * each endpoint still using the old vertex, so the mesh cracked along the edges they shared
 * (12 non-manifold edges on a box). The vertex bevel above showed the shape of the fix: the
 * endpoint is REMOVED and each face around it takes the offset point(s) that belong to it.
 *
 * Per endpoint: the two faces adjacent to the bevelled edge each take ONE offset (their own
 * side), and the remaining face takes BOTH — its corner becomes two, which is the vertex fan.
 * That is exact when an endpoint has exactly THREE faces (a box corner, an extrusion corner,
 * a loop-cut band). With four or more, a face can end up between the two sides with no
 * single answer — 19-A P7c builds the MITERED corner there instead: the endpoint is
 * bevelled like a vertex (an edge-keyed offset on every other edge, each face takes its
 * two) and a cap joins the offsets to the strip's whole side chain. Watertight at every
 * segment count is the gate (tests/unit/meshBevelP7c.test.js).
 */
/**
 * P1 (19-A): the PURE core of the EDGE bevel — the per-edge chamfer loop,
 * triangles in, triangles out, no session reads. One edge at a time, each
 * against the CURRENT triangles: bevelling two edges that share a face has to
 * see the first result, and the shared-vertex case is refused inside
 * `bevelOneEdge` anyway (which also clamps the width per edge —
 * `clampedBevelWidth` — so two bevels on one edge can never cross).
 * @param {any[]} tris @param {string[]} edgeKeys canonical welded edge keys
 * @param {{width?: number, segments?: number, profile?: number}} [options]
 *   segments already clamped (and bumped to 2 for a bulge) by the caller
 * @returns {{tris: any[], done: number, refusedValence: number, refusedBorder: number}}
 */
export function bevelEdgesCore(tris, edgeKeys, options = {}) {
	// 99 K4 family 2: the kernel edge bevel (meshOps/bevel.js) on an op mesh of these triangles
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	const r = ops.bevelEdges(om, edgeKeys, options);
	return { tris: opMeshTris(om), done: r.done, refusedValence: r.refusedValence, refusedBorder: r.refusedBorder };
}

/** @param {number} width @param {number} segments @param {number} profile
 * @returns {boolean} */
export function bevelEdges(width = 0.1, segments = 1, profile = 0) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const selected = get(edgeEditSelected);
	if (!selected.length) {
		showToast('Pick an edge first, then Bevel');
		return false;
	}
	const wanted = Math.min(Math.max(Math.round(segments) || 1, 1), 8);
	// a bulge needs an interior ring to displace; a single flat segment has none
	const n = Math.abs(profile) > 1e-3 ? Math.max(wanted, 2) : wanted;
	// 99 K4 family 2: on the session's op mesh, IDs carried (the partition is derived by the commit, as before)
	const om = sessionOpMesh();
	if (!om) {
		showToast(KERNEL_LOADING);
		return false;
	}
	const ops = editSession.ops;
	const pick = captureSelection(FS.object.uuid);
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: readStoredFaces(FS.object?.geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let out = null;
	let result;
	try {
		result = ops.bevelEdges(om, selected, { width, segments: n, profile });
		if (result.done) out = ops.opOutput(om, { order: 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place; its faces are not the derived partition, so never re-kept
	}
	const { done, refusedValence, refusedBorder } = result;
	if (!done) {
		showToast(
			refusedValence
				? 'Bevel needs a CORNER at each end of the edge — an end that runs straight on into a flat surface has nothing to fold into (pick the whole line, or a creased edge)'
				: 'Bevel needs an edge with a face on BOTH sides — a border edge has nothing to fold into'
		);
		return false;
	}
	const positions = out.positions;
	if (positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, 'bevel'));
		return false;
	}
	clearEdgeSelectionInner(); // the keys name vertices that no longer exist
	faceEditHoverTri.set(-1);
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	commitMesh({
		apply: 'session',
		before,
		after: { positions, groups: out.groups, uvs: out.uvs, ids: out.ids },
		stampFaces: true,
		record: 'op',
		cap: false,
		selectionBefore: pick
	});
	showToast(
		'Bevelled ' +
			done +
			(done === 1 ? ' edge' : ' edges') +
			' in ' +
			n +
			(n === 1 ? ' segment' : ' segments') +
			(refusedValence ? ' (' + refusedValence + ' skipped: an end runs straight on into a flat surface)' : '') +
			(refusedBorder ? ' (' + refusedBorder + ' skipped: border edge)' : '')
	);
	return true;
}

// ---- M9b: KNIFE ------------------------------------------------------------
// Draw a line across the mesh on SCREEN and every triangle it crosses is split along it.
//
// The whole correctness question is where the crossing point lands in 3D, and the obvious
// answer is wrong. Unprojecting the 2D crossing and intersecting the TRIANGLE'S PLANE gives
// two different points for the two triangles sharing an edge whenever they are not coplanar —
// i.e. a crack down every crease the cut touches. So crossings are computed ONCE PER WELDED
// EDGE and both triangles read the same one: the same trick as the bevel's edge-keyed offsets.
//
// The screen parameter is not the 3D parameter either. Under perspective, a point halfway
// along an edge on screen is NOT halfway along it in space, so the split would drift toward
// the camera-near end. `perspectiveParam` (now in meshOps/knife.js, 99 K4) inverts that exactly, using the clip-space w the
// projection already produced.

/** M9b + 37 R11: the cut being placed, in CSS pixels. `points` are the corners clicked so far
 * (points[0] is the first click), `from` is the LAST of them — the start of the live segment —
 * and `to` follows the pointer. A store rather than component state because the clicks come
 * from Scene.svelte and the keys (Enter, Backspace, Escape) from this module's listener.
 * @type {import('svelte/store').Writable<{points: number[][], from: number[], to: number[]}|null>} */
export const knifePreview = writable(null);

/** Drop a pending cut: every placed corner is forgotten and the band disappears. */
export function cancelKnife() {
	knifePreview.set(null);
}

/**
 * Does Escape belong to a PENDING knife cut rather than to the session?
 *
 * Every Escape handler that could tear the session down asks this FIRST — there are two (this
 * module's window listener and the toolbox's). The answer has to travel on the EVENT, not in a
 * flag: a one-shot flag is consumed by whichever handler runs first, and the second then sees a
 * cleared preview and exits the session anyway (measured). `defaultPrevented` is the mechanism
 * the DOM already provides for exactly this.
 * @param {any} [event] @returns {boolean} true when the key was consumed
 */
export function escapeConsumedByKnife(event) {
	if (event?.defaultPrevented) return true; // another handler took it for the same reason
	if (!get(knifePreview)) return false;
	cancelKnife();
	event?.preventDefault?.();
	return true;
}

/**
 * 37 R11: one click of the armed knife. The first click starts a cut. After that a PLAIN click
 * ends the cut there and cuts (the two-click knife, unchanged), while an ADDITIVE click — Shift
 * or Ctrl, or the touch multi-select toggle, the selection's own "add to" gesture — places a
 * CORNER and keeps going. So a polyline is Shift+click ... Shift+click, then a plain click (or
 * Enter, which ends at the last corner). Finishing disarms the knife: it is a one-shot tool.
 * @param {number[]} point [x, y] client pixels @param {boolean} [add] keep going
 * @returns {'started'|'corner'|'cut'|'refused'}
 */
export function knifeClick(point, add = false) {
	const pending = get(knifePreview);
	if (!pending) {
		knifePreview.set({ points: [point], from: point, to: point });
		showToast('Knife: click the far end — Shift+click adds a corner, Enter ends, Esc cancels');
		return 'started';
	}
	const last = pending.points[pending.points.length - 1];
	// a double click must not place the same corner twice (a zero-length segment)
	const repeat = Math.hypot(point[0] - last[0], point[1] - last[1]) < 3;
	if (add) {
		if (!repeat) knifePreview.set({ points: [...pending.points, point], from: point, to: point });
		return 'corner';
	}
	const points = repeat && pending.points.length > 1 ? pending.points : [...pending.points, point];
	cancelKnife();
	const ok = knifePolyline(points);
	setFaceOp('move');
	return ok ? 'cut' : 'refused';
}

/** the band follows the pointer @param {number[]} point */
export function knifeHover(point) {
	const pending = get(knifePreview);
	if (pending) knifePreview.set({ ...pending, to: point });
}

/** Enter: cut through the corners placed so far. The pointer is NOT a corner — Enter ends where
 * you last clicked. @returns {boolean} */
export function knifeFinish() {
	const pending = get(knifePreview);
	if (!pending || pending.points.length < 2) return false;
	cancelKnife();
	const ok = knifePolyline(pending.points);
	setFaceOp('move');
	return ok;
}

/** Backspace: take the last corner back; taking back the first one cancels the cut.
 * @returns {boolean} */
export function knifeDropCorner() {
	const pending = get(knifePreview);
	if (!pending) return false;
	const points = pending.points.slice(0, -1);
	if (!points.length) cancelKnife();
	else knifePreview.set({ points, from: points[points.length - 1], to: pending.to });
	return true;
}

/**
 * Enter and Backspace belong to a PENDING cut (the Escape rule: the verdict rides the event).
 * @param {KeyboardEvent} event @returns {boolean} consumed
 */
export function knifeKeyConsumed(event) {
	// NOT gated on defaultPrevented (unlike Escape): the shortcut registry's viewport
	// Backspace row (objects.delete-backspace) preventDefaults before its action stands down
	// in a mesh session, so the flag says nothing about whether the cut was answered. One
	// listener calls this, so a private mark is enough to stop a second answer.
	const marked = /** @type {any} */ (event);
	if (marked.__knifeKey || !get(knifePreview)) return false;
	if (event.key === 'Enter') {
		marked.__knifeKey = true;
		event.preventDefault();
		if (!knifeFinish()) showToast('Knife: place at least two points first');
		return true;
	}
	if (event.key === 'Backspace') {
		marked.__knifeKey = true;
		event.preventDefault();
		knifeDropCorner();
		return true;
	}
	return false;
}


/**
 * 37 R11: the knife's PURE core — triangles in, triangles out, so the polyline cases run in
 * node (tests/unit/meshKnife.test.js). `project(local)` puts a LOCAL point on screen and
 * returns its view depth `w` for the perspective correction (1 for an orthographic camera).
 *
 * A polyline needs what the straight cut never did: a triangle can hold a CORNER of the cut and
 * be crossed by 3+ cut pieces from different segments. Rather than solving a cut graph per
 * triangle (a constrained triangulation of each one), the cut is BUILT UP:
 *   1. every point that lands on the mesh becomes a real VERTEX first — snapped onto the corner
 *      or edge of the face under it when it is that close, then inserted into every triangle it
 *      falls in (all layers, like the cut itself) or onto the welded EDGE it sits on;
 *   2. then each segment is a straight cut on the result of the previous one. A segment that
 *      starts or ends at an inserted vertex leaves the triangles round it through ONE crossing,
 *      and the one-crossing split fans to the opposite corner — which IS that vertex. Where a
 *      later segment crosses an earlier one it crosses that cut's EDGE and splits it like any
 *      other, so the many-crossings triangle resolves one segment at a time, and every step
 *      keeps the per-welded-edge crossing rule: watertight by construction.
 * The ends become vertices too, so a two-point cut that stops inside the mesh now ends exactly
 * where it was clicked instead of fanning to the far corner.
 * @param {any[]} tris @param {number[][]} points the polyline in pixels, at least two
 * @param {(local: any) => {px: number[], w: number}} project
 * @returns {{tris: any[], cut: number, corners: number}|null} null = it touched nothing
 */
export function knifeCutCore(tris, points, project) {
	// 99 K4 family 3: the kernel knife (meshOps/knife.js) on an op mesh of these triangles
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	const r = ops.knifeCut(om, points, (/** @type {number[]} */ p) => project(new THREE.Vector3(p[0], p[1], p[2])));
	if (!r) return null;
	return { tris: opMeshTris(om), cut: r.cut, corners: r.corners };
}

/**
 * M9b KNIFE: cut the edited mesh along a screen-space line.
 *
 * Both points are in CSS pixels, as a click gives them. Everything the cut crosses is split;
 * everything else is untouched. The two-point form of `knifePolyline`.
 * @param {number[]} from [x, y] in pixels @param {number[]} to [x, y]
 * @returns {boolean}
 */
export function knifeCut(from, to) {
	return knifePolyline([from, to]);
}

/**
 * 37 R11: cut the edited mesh along a screen-space POLYLINE — ONE undo entry, ONE broadcast for
 * the whole cut, however many segments it has.
 * @param {number[][]} points [x, y] client pixels, at least two
 * @returns {boolean}
 */
export function knifePolyline(points) {
	interruptOpAdjust(); // 19-A P2: the knife's commit ends any live adjust first
	if (!FS.object || points.length < 2) return false;
	const camera = get(globalCamera);
	if (!camera) return false;
	// W9: the cut line arrives in CLIENT pixels, so the mesh has to be projected into
	// the same space — against the CANVAS, offset by where it sits. With the bottom
	// dock open a window-sized projection puts the mesh and the line in two different
	// spaces and the cut lands somewhere else entirely.
	const rect = canvasRect();
	let length = 0;
	for (let i = 1; i < points.length; i++)
		length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
	if (length < 4) {
		showToast('Knife: drag a line across the mesh — that cut was too short');
		return false;
	}
	FS.object.updateMatrixWorld(true);
	const tris = readTriangles(FS.object.geometry);
	if (!tris.length) return false;
	/** project a LOCAL point to screen pixels, keeping the clip w for the perspective fix
	 * @param {any} local @returns {{px: number[], w: number}} */
	const project = (local) => {
		const world = FS.object.localToWorld(local.clone());
		const ndc = world.clone().project(camera);
		// project() has already divided by w; recover it from the view-space depth, which is
		// what the perspective correction needs (1 for an orthographic camera)
		const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
		const w = camera.isOrthographicCamera ? 1 : Math.max(-view.z, 1e-6);
		return {
			px: [
				rect.left + ((ndc.x + 1) / 2) * rect.width,
				rect.top + ((1 - ndc.y) / 2) * rect.height
			],
			w
		};
	};
	// 99 K4 family 3: on the session's op mesh, IDs carried (the partition is derived by the commit, as before)
	const om = sessionOpMesh();
	if (!om) {
		showToast(KERNEL_LOADING);
		return false;
	}
	const ops = editSession.ops;
	const pick = captureSelection(FS.object.uuid);
	const before = {
		positions: trisToPositions(tris),
		groups: trisToGroups(tris),
		uvs: trisToUVs(tris),
		faces: readStoredFaces(FS.object.geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let result;
	/** @type {any} */
	let out = null;
	try {
		result = ops.knifeCut(om, points, (/** @type {number[]} */ p) => project(new THREE.Vector3(p[0], p[1], p[2])));
		if (result) out = ops.opOutput(om, { order: 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place; its faces are not the derived partition, so never re-kept
	}
	if (!result) {
		showToast('Knife: that line did not cross the mesh');
		return false;
	}
	const positions = out.positions;
	if (positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, 'cut'));
		return false;
	}
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	clearEdgeSelectionInner();
	commitMesh({
		apply: 'session',
		before,
		after: { positions, groups: out.groups, uvs: out.uvs, ids: out.ids },
		stampFaces: true,
		record: 'op',
		cap: false,
		selectionBefore: pick
	});
	showToast(
		'Knife: cut ' +
			result.cut +
			(result.cut === 1 ? ' triangle' : ' triangles') +
			(points.length > 2 ? ' along ' + (points.length - 1) + ' segments' : '')
	);
	return true;
}

// ---- M7: SYMMETRIZE --------------------------------------------------------
// Keep one half of the mesh and replace the other with its mirror image, across an
// object-local axis plane through the origin.
//
// The roadmap asked for live symmetry — a session toggle that post-processes EVERY committed
// meshgeo. That model has to hook the commit path, and several of its call sites are RESTORE
// paths (cancel, exit, undo replay) which must not mirror; getting that wrong corrupts undo
// rather than a mesh. A one-shot command is the predictable half of the feature, it is what
// Blender ships as Symmetrize, and it needs no hook at all: one op, one snapshot, one undo.
//
// The seam is what makes it watertight: vertices within a whisker of the plane are SNAPPED
// onto it before anything is copied, so the mirrored half reuses those exact positions
// instead of landing a hair away and leaving a crack.

/**
 * The soup form of symmetrize (37 R11: the adjust engine's live mirror and the unit tests read it): keep one side of
 * a triangle soup, clip what straddles the plane, and append the mirror of everything kept. Triangles in,
 * triangles out. 99 K4 family 6: the kernel operator (meshOps/subdivide.js `symmetrize`) on the soup as an op mesh.
 * @param {any[]} tris @param {number[][]|null} prior the partition to carry (null = every triangle its own face)
 * @param {'x'|'y'|'z'} axis @param {number} keep +1 keeps the positive side, -1 the negative
 * @param {number} tolerance vertices this close to the plane are pinned ONTO it
 * @returns {{tris: any[], faces: number[][]|null, kept: Map<number, number>, pairs: number,
 *   clipped: number, dropped: number}|null} null = nothing on the kept side to mirror.
 *   `kept` maps a wholly-kept source triangle to its index in the output (a selection
 *   survives through it).
 */
export function mirrorTrisCore(tris, prior, axis, keep, tolerance) {
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	if (prior) {
		// the soup op mesh is one face per triangle: group them by the partition (a triangle it misses alone)
		const faceOf = new Int32Array(tris.length).fill(-1);
		prior.forEach((face, fi) => face.forEach((ti) => (faceOf[ti] = fi)));
		for (let t = 0; t < om.view.count; t++) om.logical[om.view.tFace[t]] = faceOf[t] >= 0 ? faceOf[t] : prior.length + t;
		om.baseGroup = om.nextGroup = prior.length + tris.length;
	}
	const r = ops.symmetrize(om, axis, keep, tolerance);
	if (!r) return null;
	const out = opMeshTris(om);
	// no partition: the soup made every triangle its own face, in output order
	const faces = prior ? ops.opPartition(om, 'appearance') : out.map((/** @type {any} */ _, /** @type {number} */ t) => [t]);
	return { tris: out, faces, kept: r.kept, pairs: r.pairs, clipped: r.clipped, dropped: r.dropped };
}

/** the snap tolerance scales with the object, so it means the same thing on a chair and on
 * a terrain; 0.1% of the bounding diagonal is below anything a user models deliberately
 * @param {any} object @returns {number} */
function mirrorTolerance(object) {
	const box = new THREE.Box3().setFromObject(object);
	return Math.max(box.getSize(new THREE.Vector3()).length() * 0.001, 1e-5);
}

/**
 * M7 SYMMETRIZE: mirror one half of the edited mesh onto the other.
 * @param {'x'|'y'|'z'} axis the object-local axis to mirror across
 * @param {number} keep +1 keeps the positive side, -1 the negative
 * @returns {boolean}
 */
export function symmetrizeMesh(axis = 'x', keep = 1) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	if (!FS.workingTris.length) return false;
	const tolerance = mirrorTolerance(FS.object);
	// 99 K4 family 6: on the session's op mesh; recorded as an ENTRY (it is the mirror: live symmetry leaves it be)
	const r = sessionKernelCommit(
		(ops, om) =>
			ops.symmetrize(om, axis, keep, tolerance) ?? {
				error:
					'Nothing to mirror: no geometry on the ' +
					(keep > 0 ? 'positive' : 'negative') +
					' side of the ' +
					axis.toUpperCase() +
					' plane'
			},
		() => {
			faceEditSelectedTris.set([]);
			faceEditHighlight.set(-1);
			clearEdgeSelectionInner();
		},
		{ record: 'entry', tooLarge: 'mirror' }
	);
	if (!r) return false;
	showToast(
		'Symmetrized across ' +
			axis.toUpperCase() +
			': mirrored ' +
			r.pairs +
			(r.pairs === 1 ? ' triangle' : ' triangles') +
			(r.clipped ? ', clipped ' + r.clipped : '') +
			(r.dropped ? ', dropped ' + r.dropped : '')
	);
	return true;
}

// ---- 37 R11: LIVE SYMMETRY ------------------------------------------------
// M7 shipped a one-shot Symmetrize because a live mode "post-processes every committed
// meshgeo" and several commit call sites are RESTORE paths (cancel, exit, undo replay, a
// peer's edit) that must not mirror. So this hooks the OPERATOR boundary instead, twice:
//   - the adjust engine mirrors the pure op result before it is applied (beginOpAdjust,
//     every scrub re-run, and the settle all see mirrored triangles — one broadcast each);
//   - every one-shot operator records through `recordOp`, which mirrors right after the op
//     has finished (a microtask, so the op's own "select the new cap/band" code has run)
//     and rewrites the SAME history entry's `after`.
// Restore paths never pass through either, by construction. UNDO: one entry per op — a
// single Ctrl+Z takes back the edit and its mirror together (QUESTIONS-37-mesh #2).
// THE SIDE: whichever side the edit CHANGED (the triangles in `after` that `before` did not
// have, and the ones it lost), so an extrude on the left is mirrored to the right and not
// discarded in favour of the old right half; an edit sitting on the plane uses `symKeep`.

/** a triangle's identity in a soup: its three welded vertex keys, order-free @param {any[]} tri */
function triIdentity(tri) {
	return tri
		.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z))
		.sort()
		.join('|');
}

/**
 * Which side of the plane an edit happened on: +1, -1, or null when it is balanced (an edit
 * on the plane itself, or the same change on both sides).
 * @param {any[]} beforeTris @param {any[]} afterTris @param {'x'|'y'|'z'} axis
 * @returns {number|null}
 */
export function editSide(beforeTris, afterTris, axis) {
	const index = axis === 'y' ? 1 : axis === 'z' ? 2 : 0;
	const before = new Set(beforeTris.map(triIdentity));
	const after = new Set(afterTris.map(triIdentity));
	let sum = 0;
	let count = 0;
	let extent = 0;
	const add = (/** @type {any[]} */ tri) => {
		for (const v of tri) {
			const c = index === 0 ? v.x : index === 1 ? v.y : v.z;
			sum += c;
			extent = Math.max(extent, Math.abs(c));
		}
		count++;
	};
	for (const tri of afterTris) if (!before.has(triIdentity(tri))) add(tri);
	for (const tri of beforeTris) if (!after.has(triIdentity(tri))) add(tri);
	if (!count) return null;
	// balanced within 1% of how far the change reaches: an edit ON the plane
	if (Math.abs(sum / (count * 3)) <= extent * 0.01) return null;
	return sum > 0 ? 1 : -1;
}

/** positions as triangles, for an entry `before` that is a triple or a bare array
 * @param {any} state @returns {any[]} */
function trisOfState(state) {
	const positions = state?.positions ?? state;
	/** @type {any[]} */
	const tris = [];
	if (!positions) return tris;
	for (let i = 0; i + 8 < positions.length; i += 9)
		tris.push([
			new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]),
			new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]),
			new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8])
		]);
	return tris;
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
function sameFloats(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
	return true;
}

/** set while the live mirror applies its own result, so nothing re-enters it */
let liveMirroring = false;

/**
 * Record a one-shot operator's meshgeo entry, then — when live symmetry is on — mirror the
 * result into that same entry. THE operator boundary for every op outside the adjust engine.
 * @param {any} entry
 */
function recordOp(entry) {
	recordEntry(entry);
	if (!get(liveSymmetry) || liveMirroring) return;
	queueMicrotask(() => liveMirrorEntry(entry));
}

/**
 * Mirror the edited mesh after an operator committed `entry`, and make `entry.after` the
 * mirrored state. The object is the face session's, or the VERTEX session's (meshEdit's
 * one-shot ops commit through commitMeshGeoTriple/Snapshot on it). Refuses when the geometry
 * moved on since the entry (an undo or a peer's edit in between), so it can never mirror
 * something that is not the op's result.
 * @param {any} entry @returns {boolean}
 */
export function liveMirrorEntry(entry) {
	if (liveMirroring || !entry?.uuid) return false;
	const session = !!FS.object && entry.uuid === FS.object.uuid;
	if (!session && vertexSelectionHistory?.snapshot()?.uuid !== entry.uuid) return false;
	const object = session ? FS.object : lookupEditable(entry.uuid);
	if (!object?.geometry) return false;
	const tris = readTriangles(object.geometry);
	const current = trisToPositions(tris);
	const recorded = entry.after?.positions ?? entry.after;
	if (!recorded || !sameFloats(current, recorded)) return false;
	const axis = /** @type {'x'|'y'|'z'} */ (get(symAxis));
	const side = editSide(trisOfState(entry.before), tris, axis) ?? get(symKeep);
	const prior = session ? currentPartition() : readStoredFaces(object.geometry);
	// 99 K4 family 6: the kernel operator on the op mesh the op just kept (its IDs ride into the rewritten entry)
	const ops = editSession.ops;
	if (!ops) return false;
	const partner = session ? FS.quadPartner : OBJECT_PARTNER;
	const om = heldOpMesh(ops, object.geometry, () => prior, partner);
	const result = ops.symmetrize(om, axis, side, mirrorTolerance(object));
	if (!result) return false; // nothing changed: the held op mesh still describes the geometry
	editSession.opMesh = null; // edited in place: re-kept below
	const out = ops.opOutput(om, { order: 'appearance' });
	const positions = out.positions;
	if (sameFloats(positions, current)) return false; // already symmetric: nothing to send
	if (positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, 'mirror'));
		return false;
	}
	const groups = out.groups;
	const uvs = out.uvs;
	// no stored partition (a vertex session on a never-edited mesh): the soup made every triangle its own face
	const faces = prior ? out.faces : Array.from({ length: positions.length / 9 }, (_, t) => [t]);
	/** @type {any} */
	let mirrored = null;
	liveMirroring = true;
	try {
		if (session) {
			// the selection rides through the reorder: a wholly-kept triangle has a known
			// new index, anything that was clipped or lay on the replaced side is dropped
			const picked = get(faceEditSelectedTris)
				.map((ti) => result.kept.get(ti))
				.filter((ti) => ti !== undefined);
			const hadHighlight = get(faceEditHighlight) >= 0;
			faceEditSelectedTris.set(/** @type {number[]} */ (picked));
			faceEditHighlight.set(-1);
			faceEditHoverTri.set(-1);
			mirrored = mirrorCommit(entry.uuid, true, positions, groups, uvs, faces, out.ids);
			if (hadHighlight && picked.length) {
				faceEditHighlight.set(faceIndexForTriangle(/** @type {number} */ (picked[0])));
				refreshFaceOverlay();
			}
			// edge keys are positions: the kept side's survive as they are
			edgeEditSelected.set(get(edgeEditSelected).filter((k) => !!edgeEndpoints(k)));
			refreshEdgeOverlay();
			if (FS.gizmoTarget && typeof window !== 'undefined') attachFaceGizmo();
		} else {
			// the vertex session rebuilds its handles in triangle order on the swap, so the
			// picks are carried as POSITIONS (the commitFalloffSnapshot rule)
			const picks = vertexSelectionHistory?.positions?.() ?? null;
			mirrored = mirrorCommit(entry.uuid, false, positions, groups, uvs, faces, out.ids);
			if (picks) vertexSelectionHistory?.reselect?.(picks);
		}
		// the op's ONE entry now holds the mirrored state (99 K2: compact, like every entry)
		entry.after = mirrored.after;
		if (faces === out.faces) keepOpMesh(entry.uuid, om, out, partner);
	} finally {
		liveMirroring = false;
	}
	return true;
}

/**
 * 99 K2: the live mirror's apply + broadcast through the one commit; it records nothing (the
 * op's own entry is rewritten instead). @param {string} uuid @param {boolean} session
 * @param {ArrayLike<number>} positions @param {any} groups @param {any} uvs @param {number[][] | null} faces
 * @param {any} [ids] the op mesh's ID channels (99 K4)
 */
function mirrorCommit(uuid, session, positions, groups, uvs, faces, ids) {
	return /** @type {any} */ (
		commitMesh({
			uuid,
			apply: session ? 'session' : 'object',
			after: { positions, groups, uvs, ...(ids ? { ids } : {}) },
			faces,
			stampFaces: true,
			record: false,
			cap: false
		})
	);
}

/**
 * The adjust engine's half: mirror a run's pure result before anything applies it. The side is
 * decided ONCE per adjust (on its first run), so scrubbing a parameter never flips it. Only
 * inside a face session — the engine's no-session callers (VR on a bare object) are not edits
 * a mirror plane is defined for.
 * @param {any} a the adjust state @param {any} result runAdjustCore's output @returns {any}
 */
function mirrorAdjustResult(a, result) {
	if (!get(liveSymmetry) || !a.session || result.error || !FS.object) return result;
	const axis = /** @type {'x'|'y'|'z'} */ (get(symAxis));
	if (a.mirrorSide === undefined)
		a.mirrorSide = editSide(a.originalTris, result.tris, axis) ?? get(symKeep);
	const mirrored = mirrorTrisCore(result.tris, result.faces ?? null, axis, a.mirrorSide, mirrorTolerance(FS.object));
	if (!mirrored) return result;
	const map = (/** @type {number[]} */ list) =>
		/** @type {number[]} */ (list.map((ti) => mirrored.kept.get(ti)).filter((ti) => ti !== undefined));
	let select = result.select;
	if (select?.kind === 'cap' || select?.kind === 'set') select = { ...select, tris: map(select.tris) };
	else if (select?.kind === 'band') {
		/** @type {number[]} */
		const band = [];
		for (let ti = select.firstNew; ti < select.total; ti++) band.push(ti);
		select = { kind: 'set', tris: map(band) };
	}
	if (select?.kind === 'cap' && !select.tris.length) select = { kind: 'cleared' };
	return { ...result, tris: mirrored.tris, faces: mirrored.faces, ids: null, select };
}

/**
 * M4: dissolve the selected edges — genuinely REMOVE each one by merging the
 * two faces it joins and re-triangulating the merged polygon WITHOUT it.
 *
 * The first pass merged the two TRIANGLES sharing the edge back into a quad,
 * which was a no-op the user could see: a triangle soup has to triangulate that
 * quad again, and the same diagonal came straight back. Two corrections: an
 * internal quad diagonal is no longer pickable at all (it is a triangulation
 * artifact, not an edge of the model — see pickEdgeAt), and dissolve now works
 * on the two QUADS either side of a real edge, fan-triangulating their merged
 * boundary from a corner that is NOT an endpoint of the dissolved edge, so the
 * edge cannot reappear.
 *
 * Only legal where the faces are COPLANAR — dissolving a real corner would
 * change the silhouette. Illegal picks are reported with a count, never
 * silently skipped. @returns {boolean}
 */
export function dissolveEdges() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const sel = get(edgeEditSelected);
	if (!sel.length) {
		showToast('Pick an edge to dissolve');
		return false;
	}
	// 99 K4 family 5: on the session's op mesh (the quads either side, by the session's quad pairing)
	const partner = FS.quadPartner;
	const r = sessionKernelCommit(
		(ops, om) => ops.dissolveEdges(om, ops.edgesOfKeys(om, sel), partner),
		() => clearEdgeSelection()
	);
	if (!r) return false;
	showToast(
		'Dissolved ' + r.dissolved + ' edge' + (r.dissolved === 1 ? '' : 's') +
			(r.skipped ? ' (' + r.skipped + ' skipped — not a coplanar pair)' : '')
	);
	return true;
}

/**
 * 19-A P5a: DELETE the selected edges — every triangle that USES one of them goes.
 *
 * The destructive sibling of `dissolveEdges`: dissolve keeps the surface and merges the
 * two coplanar faces, delete removes the faces on both sides and leaves a hole. That is
 * the point of the tool (it is how you open a mesh up before bridging or filling), so
 * nothing here checks watertightness — only that something is picked and that the mesh
 * does not vanish entirely.
 * @returns {boolean}
 */
export function deleteSelectedEdges() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const sel = get(edgeEditSelected);
	if (!sel.length) {
		showToast('Pick an edge to delete');
		return false;
	}
	// 99 K4 family 5: on the session's op mesh — every triangle with a side on a picked edge goes
	const r = sessionKernelCommit(
		(ops, om) => {
			const drop = ops.trianglesOnSides(om, ops.edgesOfKeys(om, sel));
			if (!drop.length) return { error: 'Nothing to delete — no face uses those edges' };
			if (drop.length >= om.view.count) return { error: 'That would delete every face of the mesh — pick fewer edges' };
			return ops.deleteTriangles(om, drop);
		},
		() => {
			// clear the picks BEFORE the swap: applyGeometrySnapshot rebuilds both overlays from them, and every
			// index past a dropped triangle has moved
			clearEdgeSelectionInner(); // the op tidying up after itself, not a user pick
			faceEditSelectedTris.set([]);
			faceEditHighlight.set(-1);
		}
	);
	if (!r) return false;
	showToast(
		'Deleted ' +
			r.dropped +
			(r.dropped === 1 ? ' face' : ' faces') +
			' along ' +
			sel.length +
			(sel.length === 1 ? ' edge' : ' edges')
	);
	return true;
}

/**
 * 19-A P5b: SUBDIVIDE the selected edges — every triangle that uses one is split at the
 * edge's midpoint.
 *
 * The knife's two crack rules apply verbatim. The midpoint is computed ONCE per welded
 * edge key and both sharers reuse the same Vector3, so the two sides split at the
 * NUMERICALLY IDENTICAL point (per-triangle midpoints drift wherever the corners are
 * not exactly welded, and the mesh cracks along the seam). And a triangle is split for
 * EVERY selected edge it carries — leaving one side whole while its neighbour gains a
 * real vertex on the shared edge is a T-junction.
 *
 * Splits rejoin their PARENT's stored face via the composeFaces origin (every piece
 * maps to the parent triangle): the new spokes are internal to that face, so the
 * structure wireframe keeps drawing the model's edges plus the new half-edges on the
 * face borders — the same rule that hides a quad's diagonal. The knife cannot author
 * this (an arbitrary screen line crosses faces it cannot describe, so it drops the
 * partition); a midpoint split is exactly describable, so here it is authored.
 *
 * Afterwards the two HALF-EDGES of each original pick are selected, ready for another
 * subdivide or a gizmo move. `mi` rides each piece; midpoint uvs are the per-corner
 * LERP of the owning triangle's own corners (per triangle, so a uv seam stays a seam —
 * the knife's uv rule at the u=0.5 special case).
 * @returns {boolean}
 */
export function subdivideSelectedEdges() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const sel = get(edgeEditSelected);
	if (!sel.length) {
		showToast('Pick an edge to subdivide');
		return false;
	}
	// 99 K4 family 6: on the session's op mesh (one midpoint vertex per picked edge, the crack rule by construction)
	const r = sessionKernelCommit(
		(ops, om) => ops.subdivideEdges(om, ops.edgesOfKeys(om, sel)),
		() => {
			// clear the picks BEFORE the swap (applyGeometrySnapshot rebuilds both overlays from them)
			clearEdgeSelectionInner(); // op housekeeping, not a user pick
			faceEditSelectedTris.set([]);
			faceEditHighlight.set(-1);
		}
	);
	if (!r) return false;
	// select the two halves of each pick (direct store write — withSelectionHistory would put a selection entry
	// ON TOP of the meshgeo and Ctrl+Z would undo the housekeeping)
	/** @type {string[]} */
	const halves = [];
	for (const { ka, kb, km } of r.midpoints) halves.push(edgeKey(ka, km), edgeKey(km, kb));
	edgeEditSelected.set(halves.filter((key) => !!edgeEndpoints(key)));
	refreshEdgeOverlay();
	if (typeof window !== 'undefined' && get(faceEditOp) === 'move') attachFaceGizmo();
	showToast(
		'Subdivided ' +
			r.midpoints.length +
			(r.midpoints.length === 1 ? ' edge' : ' edges') +
			' (' +
			r.split +
			(r.split === 1 ? ' triangle' : ' triangles') +
			' split)'
	);
	return true;
}

/** @type {any} scene-root LineSegments showing the edge selection + hover */
let edgeOverlay = null;

/** M4: rebuild the edge highlight. A 4th visual layer mirroring
 * refreshFaceOverlay: scene-root, baked into world space, raycast stubbed so it
 * never eats a pick. */
function refreshEdgeOverlay() {
	const scene = get(globalScene);
	if (edgeOverlay) {
		edgeOverlay.parent?.remove(edgeOverlay);
		edgeOverlay.geometry?.dispose?.();
		edgeOverlay.material?.dispose?.();
		edgeOverlay = null;
	}
	if (!scene || !FS.object || get(faceEditSubmode) !== 'edges') return;
	/** @type {number[]} */
	const points = [];
	if (FS.grab?.edgeLive) {
		// 19-A P7b: a LIVE grab — the selection's keys are POSITION-quantized, so
		// once the endpoints move they resolve to nothing and the overlay would
		// vanish (or, before this, sit stranded at the pre-drag place until
		// release). The grab captured the selected edges' original endpoints and
		// applyFaceGrab transforms them per frame; draw those instead.
		for (const pair of FS.grab.edgeLive)
			points.push(pair[0].x, pair[0].y, pair[0].z, pair[1].x, pair[1].y, pair[1].z);
	} else {
		const keys = new Set(get(edgeEditSelected));
		const hover = get(edgeEditHover);
		if (hover) keys.add(hover);
		if (!keys.size) return;
		for (const key of keys) {
			const ends = edgeEndpoints(key);
			if (!ends) continue;
			points.push(ends[0].x, ends[0].y, ends[0].z, ends[1].x, ends[1].y, ends[1].z);
		}
	}
	if (!points.length) return;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
	edgeOverlay = new THREE.LineSegments(
		geometry,
		new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false, transparent: true })
	);
	edgeOverlay.renderOrder = 999;
	edgeOverlay.name = 'edge-edit-overlay';
	edgeOverlay.raycast = () => {}; // never eat a pick (the buildEditWireframe rule)
	FS.object.updateMatrixWorld(true);
	edgeOverlay.applyMatrix4(FS.object.matrixWorld);
	scene.add(edgeOverlay);
}

/** M4: the edge overlay must be rebuilt on every geometry swap (baked world
 * space, like the face overlay) — exported so the swap paths can call it */
export function refreshEdgeHighlight() {
	refreshEdgeOverlay();
}

/** M4: how many edges are picked (toolbar counts) */
export function edgeSelectionSize() {
	return get(edgeEditSelected).length;
}

/**
 * M4 (edge gizmo): the current edge selection as a GRAB TARGET — vertex keys instead of
 * triangle indices, so `beginFaceGrab` moves exactly those welded vertex groups and
 * leaves every triangle in place.
 *
 * The basis is the reason this is worth building rather than reusing the face gizmo's:
 * X runs ALONG the edge, Z is the average normal of the faces touching it, so the
 * handles mean something on an edge (slide along it, pull it out of the surface). For a
 * multi-edge selection the direction is the longest edge's, which keeps a loop's handles
 * stable instead of flipping per edge.
 * @returns {any|null}
 */
export function edgeGrabTarget() {
	if (!FS.object) return null;
	const selected = get(edgeEditSelected);
	if (!selected.length) return null;
	const keys = new Set();
	const centroid = new THREE.Vector3();
	let counted = 0;
	const direction = new THREE.Vector3();
	let longest = -1;
	for (const key of selected) {
		const ends = edgeEndpoints(key);
		if (!ends) continue;
		for (const point of ends) {
			keys.add(keyOf(point.x, point.y, point.z));
			centroid.add(point);
			counted++;
		}
		const span = ends[1].clone().sub(ends[0]);
		if (span.lengthSq() > longest) {
			longest = span.lengthSq();
			direction.copy(span);
		}
	}
	if (!keys.size || !counted) return null;
	centroid.multiplyScalar(1 / counted);
	// the average normal of every triangle touching a selected vertex — the surface the
	// edge lies in, which is what "pull the edge outward" has to mean
	const normal = new THREE.Vector3();
	FS.workingTris.forEach((/** @type {any} */ t) => {
		if (t.some((/** @type {any} */ v) => keys.has(keyOf(v.x, v.y, v.z)))) normal.add(triNormal(t));
	});
	if (normal.lengthSq() < 1e-9) normal.set(0, 1, 0);
	normal.normalize();
	if (direction.lengthSq() < 1e-12) direction.copy(axisLeastAlignedWith(normal));
	direction.normalize();
	return { triIndices: [], vertexKeys: keys, centroid, normal, direction };
}

/**
 * 19-A P5b: the PURE core of EDGE EXTRUDE — pull each selected BORDER edge out into a
 * quad strip. Triangles in, triangles out, no session reads (the adjust engine re-runs
 * it from the original snapshot on every scrub).
 *
 * Only a BORDER edge extrudes — one that appears in exactly ONE triangle. An interior
 * edge has a face on both sides, so a strip grown from it would be a zero-thickness fin
 * buried in the surface; those are counted and refused (`refusedInterior`, the
 * bevelEdgesCore refusal shape).
 *
 * DIRECTION: the offset is one averaged normal PER CHAIN (border edges connected
 * through shared endpoints), from every owning triangle along it. Per-edge normals
 * would give a shared endpoint two different offset copies — a torn corner; one
 * direction per chain both WELDS the corner by construction (each welded endpoint key
 * gets exactly one copy) and reads smoother around a curved rim.
 *
 * WINDING: each strip quad is wound toward `edgeOutward(p0, p1, owning normal)` — away
 * from the owning face across the border, exactly how extrudeFace winds its walls. The
 * strip stands roughly PERPENDICULAR to the owning surface, so the owning normal
 * itself is useless as a wantDir (it is perpendicular to the strip's normal — the dot
 * that picks the winding would be ~0 and the sign would be numeric noise).
 *
 * UVs advance perpendicular to the base edge at its own texel density — the
 * extrudeFace wall rule, copied rather than reinvented.
 * @param {any[]} tris @param {string[]} edgeKeys canonical welded edge keys
 * @param {{distance?: number}} [options]
 * @returns {{tris: any[], done: number, refusedInterior: number, newEdgeKeys: string[]}}
 */
export function edgeExtrudeCore(tris, edgeKeys, options = {}) {
	const distance = options.distance ?? 0.5;
	const wanted = new Set(edgeKeys);
	/** @type {Map<string, {ti: number, e: number}[]>} selected welded edge -> occurrences */
	const byEdge = new Map();
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(
				keyOf(t[e].x, t[e].y, t[e].z),
				keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z)
			);
			if (!wanted.has(key)) continue;
			let list = byEdge.get(key);
			if (!list) byEdge.set(key, (list = []));
			list.push({ ti, e });
		}
	});
	/** @type {{key: string, ti: number, e: number, ka: string, kb: string}[]} */
	const borders = [];
	let refusedInterior = 0;
	for (const [key, list] of byEdge) {
		if (list.length !== 1) {
			refusedInterior++;
			continue;
		}
		const [ka, kb] = key.split('|');
		borders.push({ key, ...list[0], ka, kb });
	}
	if (!borders.length) return { tris: cloneTris(tris), done: 0, refusedInterior, newEdgeKeys: [] };
	// CHAINS: union-find over the border edges' endpoint keys
	/** @type {Map<string, string>} */
	const parent = new Map();
	const find = (/** @type {string} */ k) => {
		let root = k;
		while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
		while (parent.get(k) !== root) {
			const next = /** @type {string} */ (parent.get(k));
			parent.set(k, root);
			k = next;
		}
		return root;
	};
	for (const b of borders) {
		for (const k of [b.ka, b.kb]) if (!parent.has(k)) parent.set(k, k);
		parent.set(find(b.ka), find(b.kb));
	}
	// one averaged owning-triangle normal per chain — the offset direction
	/** @type {Map<string, any>} */
	const chainNormal = new Map();
	for (const b of borders) {
		const root = find(b.ka);
		const sum = chainNormal.get(root) ?? new THREE.Vector3();
		sum.add(triNormal(tris[b.ti]));
		chainNormal.set(root, sum);
	}
	for (const sum of chainNormal.values()) {
		if (sum.lengthSq() < 1e-12) sum.set(0, 1, 0);
		sum.normalize();
	}
	// ONE offset copy per welded endpoint key — the weld that makes a chain of edges
	// extrude as one strip instead of separate flaps
	/** @type {Map<string, any>} */
	const copies = new Map();
	const copyOf = (/** @type {any} */ point, /** @type {string} */ k) => {
		let copy = copies.get(k);
		if (!copy) {
			copy = point.clone().addScaledVector(chainNormal.get(find(k)), distance);
			copies.set(k, copy);
		}
		return copy;
	};
	const out = cloneTris(tris);
	/** @type {string[]} */
	const newEdgeKeys = [];
	for (const b of borders) {
		const t = tris[b.ti];
		const p0 = t[b.e];
		const p1 = t[(b.e + 1) % 3];
		const q0 = copyOf(p0, keyOf(p0.x, p0.y, p0.z));
		const q1 = copyOf(p1, keyOf(p1.x, p1.y, p1.z));
		// uv: along the base edge at its own density, advanced perpendicular by the
		// world distance (the extrudeFace wall rule)
		const uvA = uvAt(t, b.e);
		const uvB = uvAt(t, (b.e + 1) % 3);
		const along = [uvB[0] - uvA[0], uvB[1] - uvA[1]];
		const uvLen = Math.hypot(along[0], along[1]);
		const worldLen = p0.distanceTo(p1);
		const step = uvLen > 1e-9 && worldLen > 1e-9 ? (uvLen / worldLen) * distance : distance;
		const perp = uvLen > 1e-9 ? [(-along[1] / uvLen) * step, (along[0] / uvLen) * step] : [0, step];
		const uvA2 = [uvA[0] + perp[0], uvA[1] + perp[1]];
		const uvB2 = [uvB[0] + perp[0], uvB[1] + perp[1]];
		pushQuad(
			out,
			p0.clone(),
			p1.clone(),
			q1.clone(),
			q0.clone(),
			edgeOutward(p0, p1, triNormal(t)),
			t.mi,
			t.uv ? [uvA, uvB, uvB2, uvA2] : undefined
		);
		newEdgeKeys.push(edgeKey(keyOf(q0.x, q0.y, q0.z), keyOf(q1.x, q1.y, q1.z)));
	}
	return { tris: out, done: borders.length, refusedInterior, newEdgeKeys };
}

/**
 * 19-A P5b: extrude the selected border edges through the ADJUST ENGINE — the op
 * applies at `distance` immediately and stays scrubbable in the options pane (the
 * engine owns the commit, the ONE history entry, the new-edge selection and the edge
 * gizmo re-seat). @param {number} [distance] @returns {boolean}
 */
export function extrudeSelectedEdges(distance = 0.5) {
	return beginOpAdjust('edge-extrude', { distance });
}

// ---- 19-A P6 (36-mesh-ops): the risky operators ---------------------------
// Edge slide, vertex connect (J-cut), dissolve vertices, fill hole and solidify.
// Every one reasons about LOGICAL faces, never raw triangles: a rail, a cut or a
// dissolve that read the soup would walk straight across a quad's diagonal,
// which is a triangulation artifact and not an edge of the model. So each core
// takes the partition ("stored else derived") and walks face boundary LOOPS.
//
// Orientation rule shared by all five: a new polygon is fanned in the ORDER of
// a boundary loop the source triangles already wound (`fanLoop`), never by
// testing each triangle against an averaged normal. On a non-planar loop (a box
// corner dissolved into a hexagon) the per-triangle normal test can flip one
// triangle of the fan and leave a seam wound the wrong way; the loop order
// cannot, because it is the winding the neighbours already agree with.

/** The partition of an arbitrary geometry's triangles — stored if there is one,
 * derived if not. The session-free twin of `currentPartition`, for the vertex
 * operators (vertex mode is a meshEdit session; no face session exists).
 * @param {any} geometry @param {any[]} tris @returns {number[][]} */
function partitionOfGeometry(geometry, tris) {
	return readStoredFaces(geometry) ?? derivePartition(tris, pairQuads(tris));
}

/**
 * Fan an ordered ring into triangles IN RING ORDER — (r0, ri, ri+1) — with no
 * normal test: the ring's own order carries the winding (see the section note).
 * @param {any[]} out appended to @param {{pos: any, uv: number[]}[]} ring
 * @param {any} mi @param {boolean} textured @param {number} [startAt]
 * @returns {number[]} the out indices appended
 */
function fanLoop(out, ring, mi, textured, startAt = 0) {
	/** @type {number[]} */
	const added = [];
	const n = ring.length;
	if (n < 3) return added;
	const at = (/** @type {number} */ i) => ring[(startAt + i) % n];
	for (let i = 1; i < n - 1; i++) {
		const a = at(0);
		const b = at(i);
		const c = at(i + 1);
		added.push(out.length);
		out.push(
			withSlot([a.pos.clone(), b.pos.clone(), c.pos.clone()], mi, textured ? [a.uv, b.uv, c.uv] : undefined)
		);
	}
	return added;
}

/**
 * Fan a ring from its BEST corner. A dissolved region is rarely a convex planar
 * polygon: a 2x2 grid's centre leaves an octagon whose edge midpoints are
 * collinear with its corners (a corner start emits zero-area slivers), and a box
 * corner leaves a hexagon whose far corners are joined by the NEIGHBOURING faces'
 * diagonals (a spoke along one gives that edge four faces — non-manifold). So
 * every start is scored: a spoke may not duplicate an edge in `avoid` (the
 * surviving mesh's edges), and the start whose smallest triangle is largest wins;
 * ties prefer a corner outside `preferNot` (the removed vertex's neighbours — the
 * dissolve re-appearance rule), then the lowest index. With no valid start the
 * ring is fanned from its centroid instead, whose spokes are new by construction.
 * @param {any[]} out @param {{pos: any, uv: number[]}[]} ring
 * @param {any} mi @param {boolean} textured @param {Set<string>} avoid welded edge keys
 * @param {Set<string>} [preferNot] welded vertex keys
 * @returns {number[]} the out indices appended
 */
function fanBest(out, ring, mi, textured, avoid, preferNot = new Set()) {
	const n = ring.length;
	if (n < 3) return [];
	const keys = ring.map((c) => keyOf(c.pos.x, c.pos.y, c.pos.z));
	let best = -1;
	let bestArea = -1;
	let bestPreferred = false;
	for (let s = 0; s < n; s++) {
		let valid = true;
		for (let i = 2; i < n - 1 && valid; i++) if (avoid.has(edgeKey(keys[s], keys[(s + i) % n]))) valid = false;
		if (!valid) continue;
		let minArea = Infinity;
		for (let i = 1; i < n - 1; i++) {
			const a = ring[s].pos;
			const b = ring[(s + i) % n].pos;
			const c = ring[(s + i + 1) % n].pos;
			const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length();
			minArea = Math.min(minArea, area);
		}
		const preferred = !preferNot.has(keys[s]);
		const better =
			minArea > bestArea * (1 + 1e-9) + 1e-12 ||
			(Math.abs(minArea - bestArea) <= bestArea * 1e-9 + 1e-12 && preferred && !bestPreferred);
		if (best < 0 || better) {
			best = s;
			bestArea = minArea;
			bestPreferred = preferred;
		}
	}
	if (best >= 0 && bestArea > 1e-12) return fanLoop(out, ring, mi, textured, best);
	const hub = { pos: new THREE.Vector3(), uv: [0, 0] };
	for (const c of ring) {
		hub.pos.add(c.pos);
		hub.uv[0] += c.uv[0] / n;
		hub.uv[1] += c.uv[1] / n;
	}
	hub.pos.multiplyScalar(1 / n);
	/** @type {number[]} */
	const added = [];
	for (let i = 0; i < n; i++) added.push(...fanLoop(out, [hub, ring[i], ring[(i + 1) % n]], mi, textured, 0));
	return added;
}

/** every welded edge of the triangles NOT in `drop` — what a new fan must not
 * duplicate @param {any[]} tris @param {Set<number>} drop */
function survivingEdges(tris, drop) {
	/** @type {Set<string>} */
	const edges = new Set();
	tris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (drop.has(ti)) return;
		for (let e = 0; e < 3; e++)
			edges.add(edgeKey(keyOf(t[e].x, t[e].y, t[e].z), keyOf(t[(e + 1) % 3].x, t[(e + 1) % 3].y, t[(e + 1) % 3].z)));
	});
	return edges;
}

/**
 * Rebuild a soup with some FACES dropped and new triangles appended, carrying the
 * partition: survivors keep their face (reindexed), the added polygons become
 * the faces `addedFaces` names (indices relative to `added`). The vertex
 * operators run several keys in a row, and each step must see the previous
 * step's n-gon as ONE face — so the partition has to travel with the triangles.
 * @param {any[]} tris @param {number[][]} faces @param {Set<number>} drop
 * @param {any[]} added @param {number[][]} addedFaces
 * @returns {{tris: any[], faces: number[][]}}
 */
function replaceFaces(tris, faces, drop, added, addedFaces) {
	const newIndex = new Int32Array(tris.length).fill(-1);
	/** @type {any[]} */
	const kept = [];
	tris.forEach((t, ti) => {
		if (drop.has(ti)) return;
		newIndex[ti] = kept.length;
		kept.push(t);
	});
	const base = kept.length;
	const outFaces = faces
		.map((face) => face.map((ti) => newIndex[ti]).filter((ti) => ti >= 0))
		.filter((face) => face.length);
	for (const face of addedFaces) outFaces.push(face.map((i) => base + i));
	return { tris: [...kept, ...added], faces: outFaces };
}

/** a face's boundary as welded keys + positions + per-corner uv, or null when it
 * is not ONE closed loop (a face with a hole) @param {any[]} tris @param {number[]} face */
function faceRing(tris, face) {
	const loop = boundaryLoop(tris, face);
	if (!loop) return null;
	const corners = cornerData(tris, face);
	const keys = loop.map((p) => keyOf(p.x, p.y, p.z));
	return {
		keys,
		ring: loop.map((p, i) => ({ pos: p.clone(), uv: corners.get(keys[i])?.uv ?? [0, 0] }))
	};
}

/**
 * P6 EDGE SLIDE — the pure core. Every vertex of the picked edges slides along
 * its RAIL: the real edge leaving it across a face that flanks the selection.
 * `factor` 0 = where it is, +1 = onto side A's rail end, -1 = onto side B's.
 *
 * SIDES. The two faces flanking one picked edge are opposite sides. Along a
 * chain, two (edge, face) halves are the SAME side when they are the same face
 * (the chain turns a corner inside it) or when they leave a shared vertex along
 * the same rail (a valence-4 vertex: the rail edge belongs to both quads on that
 * side). A breadth-first 2-colouring over that relation, seeded from the first
 * edge in sorted order, makes the labelling deterministic on every peer.
 *
 * POLES. A vertex keeps its position when the wanted side offers no rail (a
 * box corner: the only edge leaving it on that side IS the next picked edge) or
 * more than one distinct rail (valence 5+: no unambiguous direction). Counted.
 * @param {any[]} tris @param {number[][]} faces the partition
 * @param {string[]} edgeKeys picked welded edge keys
 * @param {{factor?: number}} [options]
 * @returns {{tris: any[], moved: number, poles: number, newEdgeKeys: string[]}}
 */
export function edgeSlideCore(tris, faces, edgeKeys, options = {}) {
	const factor = Math.min(Math.max(options.factor ?? 0, -1), 1);
	const wanted = [...new Set(edgeKeys)].sort();
	const wantedSet = new Set(wanted);
	/** @type {Set<string>} */
	const chainKeys = new Set();
	for (const k of wanted) for (const v of k.split('|')) chainKeys.add(v);
	// rings of the faces that touch the chain only — the rest cannot carry a rail
	/** @type {Map<number, {keys: string[], ring: any[]}>} */
	const rings = new Map();
	/** @type {Map<string, number[]>} picked edge -> flanking faces */
	const flank = new Map();
	faces.forEach((face, fi) => {
		const touches = face.some((ti) =>
			tris[ti].some((/** @type {any} */ v) => chainKeys.has(keyOf(v.x, v.y, v.z)))
		);
		if (!touches) return;
		const fr = faceRing(tris, face);
		if (!fr) return;
		rings.set(fi, fr);
		const n = fr.keys.length;
		for (let i = 0; i < n; i++) {
			const k = edgeKey(fr.keys[i], fr.keys[(i + 1) % n]);
			if (!wantedSet.has(k)) continue;
			let list = flank.get(k);
			if (!list) flank.set(k, (list = []));
			list.push(fi);
		}
	});
	/** the rail end leaving `vk` inside face `fi`, away from `otherKey`, or ''
	 * when that rail is itself a picked edge @param {number} fi @param {string} vk @param {string} otherKey */
	const railEnd = (fi, vk, otherKey) => {
		const fr = /** @type {any} */ (rings.get(fi));
		const n = fr.keys.length;
		const i = fr.keys.indexOf(vk);
		if (i < 0) return '';
		const prev = fr.keys[(i - 1 + n) % n];
		const next = fr.keys[(i + 1) % n];
		const end = prev === otherKey ? next : next === otherKey ? prev : '';
		if (!end || end === otherKey) return '';
		return wantedSet.has(edgeKey(vk, end)) ? '' : end;
	};
	// halves: one per (picked edge, flanking face)
	/** @type {{edge: string, fi: number, rails: Map<string, string>}[]} */
	const halves = [];
	for (const k of wanted) {
		const [a, b] = k.split('|');
		for (const fi of flank.get(k) ?? []) {
			const rails = new Map();
			const ra = railEnd(fi, a, b);
			const rb = railEnd(fi, b, a);
			if (ra) rails.set(a, ra);
			if (rb) rails.set(b, rb);
			halves.push({ edge: k, fi, rails });
		}
	}
	// 2-colour the halves
	const side = new Int8Array(halves.length).fill(-1);
	/** @param {number} h @param {number} g */
	const related = (h, g) => {
		const x = halves[h];
		const y = halves[g];
		if (x.edge === y.edge) return x.fi === y.fi ? 0 : -1; // -1 = opposite
		if (x.fi === y.fi) return 1;
		for (const [vk, end] of x.rails) if (y.rails.get(vk) === end) return 1;
		return 0;
	};
	for (let seed = 0; seed < halves.length; seed++) {
		if (side[seed] >= 0) continue;
		side[seed] = 0;
		const queue = [seed];
		while (queue.length) {
			const h = /** @type {number} */ (queue.shift());
			for (let g = 0; g < halves.length; g++) {
				if (side[g] >= 0 || g === h) continue;
				const r = related(h, g);
				if (r === 1) side[g] = side[h];
				else if (r === -1) side[g] = 1 - side[h];
				else continue;
				queue.push(g);
			}
		}
	}
	// per chain vertex: the distinct rail ends on the wanted side
	const wantSide = factor >= 0 ? 0 : 1;
	/** @type {Map<string, Set<string>>} */
	const ends = new Map();
	halves.forEach((half, h) => {
		if (side[h] !== wantSide) return;
		for (const [vk, end] of half.rails) {
			let set = ends.get(vk);
			if (!set) ends.set(vk, (set = new Set()));
			set.add(end);
		}
	});
	/** @type {Map<string, any>} welded key -> position */
	const pos = new Map();
	for (const t of tris)
		for (const v of t) {
			const k = keyOf(v.x, v.y, v.z);
			if (!pos.has(k)) pos.set(k, v);
		}
	/** @type {Map<string, any>} */
	const target = new Map();
	let poles = 0;
	for (const vk of chainKeys) {
		const set = ends.get(vk);
		if (!set || set.size !== 1) {
			poles++;
			continue;
		}
		const endPos = pos.get([...set][0]);
		const from = pos.get(vk);
		if (!endPos || !from) {
			poles++;
			continue;
		}
		target.set(vk, from.clone().lerp(endPos, Math.abs(factor)));
	}
	const out = cloneTris(tris);
	for (const t of out)
		t.forEach((/** @type {any} */ v) => {
			const moved = target.get(keyOf(v.x, v.y, v.z));
			if (moved) v.copy(moved);
		});
	const keyAfter = (/** @type {string} */ k) => {
		const p = target.get(k);
		return p ? keyOf(p.x, p.y, p.z) : k;
	};
	const newEdgeKeys = wanted.map((k) => {
		const [a, b] = k.split('|');
		return edgeKey(keyAfter(a), keyAfter(b));
	});
	return { tris: out, moved: target.size, poles, newEdgeKeys };
}

/**
 * P6 VERTEX CONNECT (J-cut) — the pure core. Exactly two vertices on ONE logical
 * face's boundary, not already neighbours: the face is split along the line
 * between them into TWO faces. No vertex is created, so nothing outside the face
 * changes and no seam can open; each half is fanned FROM a cut vertex, which is
 * what guarantees the cut itself is an edge of both halves.
 * @param {any[]} tris @param {number[][]} faces the partition
 * @param {string} keyA @param {string} keyB welded keys
 * @returns {{tris: any[], faces: number[][]} | {error: string}}
 */
export function connectVerticesCore(tris, faces, keyA, keyB) {
	// 99 K4 family 3: the kernel connect (meshOps/cut.js) on an op mesh of these triangles + partition
	const ops = kernelOps();
	const om = ops.fromSoup(tris, faces);
	const r = ops.connectVerticesRegion(om, keyA, keyB);
	if ('error' in r) return r;
	return { tris: opMeshTris(om), faces: ops.opPartition(om, 'replace') };
}

/**
 * P6 DISSOLVE VERTICES — the pure core. Each vertex is removed and the faces
 * around it become ONE n-gon (the union's boundary loop, fanned from a corner
 * that was NOT the removed vertex's neighbour — the dissolve rule: no spoke may
 * retrace a removed edge). A vertex with exactly TWO edges (an edge midpoint, a
 * leftover T-junction) is instead dropped from each face it sits on, keeping the
 * faces separate: merging them would fold two non-coplanar sides into one.
 * A border vertex simply leaves the border loop. Keys run one after another
 * against the CURRENT soup and partition, so two picks on one face both land.
 * @param {any[]} tris @param {number[][]} faces @param {string[]} vertexKeys
 * @returns {{tris: any[], faces: number[][], done: number, skipped: number}}
 */
export function dissolveVerticesCore(tris, faces, vertexKeys) {
	// 99 K4 family 5: the kernel operator (meshOps/dissolve.js) on an op mesh of these triangles + this partition
	const ops = kernelOps();
	const om = soupOpMesh(tris);
	const faceOf = new Int32Array(tris.length).fill(-1);
	faces.forEach((face, i) => face.forEach((ti) => (faceOf[ti] = i)));
	// the soup's op mesh is one face per triangle: each takes its stored face as its group
	for (let t = 0; t < om.view.count; t++) om.logical[om.view.tFace[t]] = faceOf[t] >= 0 ? faceOf[t] : faces.length + t;
	om.baseGroup = om.nextGroup = faces.length + tris.length;
	const r = ops.dissolveVertices(om, ops.verticesOfKeys(om, vertexKeys));
	if (!r.done) return { tris: cloneTris(tris), faces: faces.map((f) => [...f]), done: 0, skipped: r.skipped };
	return { tris: opMeshTris(om), faces: ops.opPartition(om, 'stored'), done: r.done, skipped: r.skipped };
}

/**
 * P6 FILL HOLE — the pure core. The picked BORDER edges (or the whole border loop of a single picked border
 * edge) must close ONE loop; the cap goes in as ONE face wound against its neighbours (the manifold rule): a
 * convex planar loop fanned from its best corner, anything else from the loop CENTROID. 99 K4 family 4: an
 * adapter over the kernel operator (meshOps/bridgeFill.js `fillHole`).
 * @param {any[]} tris @param {string[]} edgeKeys
 * @returns {{tris: any[], cap: number[], loopKeys: string[], centroid: boolean} | {error: string}}
 */
export function fillHoleCore(tris, edgeKeys) {
	const om = soupOpMesh(tris);
	const ops = kernelOps();
	const r = ops.fillHole(om, ops.edgesOfKeys(om, edgeKeys));
	if ('error' in r) return { error: r.error };
	const next = opMeshTris(om);
	/** @type {number[]} */
	const cap = [];
	for (let i = tris.length; i < next.length; i++) cap.push(i);
	return { tris: next, cap, loopKeys: r.loopKeys, centroid: r.centroid };
}

/**
 * P6 SOLIDIFY / SHELL — the pure core. The selected surface gains a back (a copy offset by `thickness` along
 * each welded vertex's area-weighted normal, positive = INTO the surface, wound the other way) and a rim of
 * quads along the border joining the two; a closed selection gets no rim (a hollow shell). REFUSED when the
 * border is shared with UNSELECTED faces. 99 K4 family 4: an adapter over the kernel operator
 * (meshOps/bridgeFill.js `solidifyRegion`).
 * @param {any[]} tris @param {number[]} triIndices the selection @param {{thickness?: number}} [options]
 * @returns {{tris: any[], copyOf: Map<number, number>, rimFrom: number} | {error: string}}
 *   copyOf = source tri -> its back copy's index; rim quads are pairs from rimFrom
 */
export function solidifyCore(tris, triIndices, options = {}) {
	const om = soupOpMesh(tris);
	const r = kernelOps().solidifyRegion(om, triIndices, options);
	if ('error' in r) return { error: r.error };
	return { tris: opMeshTris(om), copyOf: r.back, rimFrom: r.rimFrom };
}


/** a vertex-mode one-shot's commit: the before/after triple + the composed
 * partition, through `commitMeshGeoTriple` (one replicated meshgeo entry).
 * `beforeFaces` is the partition the op READ (stored else derived) and goes into the
 * before state EXPLICITLY: a fresh mesh stores none, and an absent `faces` makes the
 * undo CARRY the op's own partition whenever the triangle count matches — which a
 * connect's always does, so undo restored the shape with the cut still in its
 * topology and the next connect split a face that was not there (the e2e J case).
 * @param {string} uuid @param {any[]} inputTris @param {any} object
 * @param {any[]} tris @param {number[][]} faces @param {number[][]} beforeFaces */
function commitVertexOp(uuid, object, inputTris, tris, faces, beforeFaces) {
	return commitMeshGeoTriple(
		uuid,
		{
			positions: trisToPositions(inputTris),
			groups: trisToGroups(inputTris),
			uvs: trisToUVs(inputTris),
			faces: readStoredFaces(object.geometry) ?? beforeFaces
		},
		{
			positions: trisToPositions(tris),
			groups: trisToGroups(tris),
			uvs: trisToUVs(tris),
			faces
		},
		true
	);
}

/**
 * P6: CONNECT two selected vertices (vertex mode) — split the face they share.
 * Keyed by welded position like the other vertex operators; one replicated
 * meshgeo commit. @param {string} uuid @param {string[]} vertexKeys
 * @returns {boolean}
 */
export function connectVertices(uuid, vertexKeys) {
	interruptOpAdjust();
	const object = lookupEditable(uuid);
	if (!object?.geometry?.attributes?.position) return false;
	const keys = [...new Set(vertexKeys ?? [])];
	if (keys.length !== 2) {
		showToast('Connect needs exactly TWO vertices on one face (Ctrl+click adds the second)');
		return false;
	}
	const ops = editSession.ops;
	if (!ops) {
		showToast(KERNEL_LOADING);
		return false;
	}
	const geometry = object.geometry;
	const inputTris = readTriangles(geometry);
	const partition = partitionOfGeometry(geometry, inputTris);
	const pick = captureSelection(uuid);
	// 99 K4 family 3: on the kernel (the held op mesh of this geometry, IDs carried)
	const om = heldOpMesh(ops, geometry, () => partition, OBJECT_PARTNER);
	const before = {
		positions: trisToPositions(inputTris),
		groups: trisToGroups(inputTris),
		uvs: trisToUVs(inputTris),
		// the partition the op READ goes into the before state explicitly (commitVertexOp's rule: a fresh mesh
		// stores none, and an absent `faces` would make the undo carry the cut)
		faces: readStoredFaces(geometry) ?? partition,
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let r;
	/** @type {any} */
	let out = null;
	try {
		r = ops.connectVerticesRegion(om, keys[0], keys[1]);
		if (!('error' in r)) out = ops.opOutput(om, { order: 'replace' });
	} finally {
		editSession.opMesh = null; // edited in place: re-kept only by the commit
	}
	if ('error' in r) {
		showToast(r.error);
		return false;
	}
	const after = { positions: out.positions, groups: out.groups, uvs: out.uvs, faces: out.faces, ids: out.ids };
	if (!commitMeshGeoTriple(uuid, before, after, true, pick)) return false;
	keepOpMesh(uuid, om, out, OBJECT_PARTNER);
	showToast('Connected — the face is split in two');
	return true;
}

/**
 * P6: DISSOLVE the selected vertices (vertex mode) — the faces around each merge
 * into one n-gon (or, for a two-edge vertex, the vertex just leaves both faces).
 * @param {string} uuid @param {string[]} vertexKeys @returns {boolean}
 */
export function dissolveVertices(uuid, vertexKeys) {
	interruptOpAdjust();
	const object = lookupEditable(uuid);
	if (!object?.geometry?.attributes?.position) return false;
	if (!vertexKeys?.length) {
		showToast('Select a vertex first, then Dissolve');
		return false;
	}
	const geometry = object.geometry;
	const inputTris = readTriangles(geometry);
	// 99 K4 family 5: on the kernel (the partition keeps the soup's order: the stored faces, then the new ones)
	const r = objectKernelCommit(
		uuid,
		object,
		() => partitionOfGeometry(geometry, inputTris),
		inputTris,
		(ops, om) => {
			const d = ops.dissolveVertices(om, ops.verticesOfKeys(om, vertexKeys));
			return d.done
				? d
				: {
						error:
							'Nothing to dissolve — the faces around that vertex do not form one closed outline (a vertex where two separate pieces only touch, or a face with a hole)'
					};
		},
		{ op: true, order: 'stored', explicitBefore: true }
	);
	if ('error' in r) {
		showToast(r.error);
		return false;
	}
	showToast(
		'Dissolved ' +
			r.done +
			(r.done === 1 ? ' vertex' : ' vertices') +
			(r.skipped ? ' (' + r.skipped + ' skipped)' : '')
	);
	return true;
}

/**
 * P6: FILL the hole the picked border edges close (edges mode) — one cap face,
 * wound with its neighbours. Selects nothing afterwards: the picked rim edges
 * are interior now. @returns {boolean}
 */
export function fillHole() {
	interruptOpAdjust();
	if (!FS.object) return false;
	const sel = get(edgeEditSelected);
	if (!sel.length) {
		showToast('Pick the border edges of a hole first (one border edge fills its whole rim)');
		return false;
	}
	// 99 K4 family 4: on the session's op mesh, committed with its element IDs
	const r = sessionKernelCommit(
		(ops, om) => ops.fillHole(om, ops.edgesOfKeys(om, sel)),
		() => clearEdgeSelectionInner() // the rim is interior now — op housekeeping, not a pick
	);
	if (!r) return false;
	showToast(
		'Filled a ' + r.loopKeys.length + '-edge hole' + (r.centroid ? ' (fanned from its centre — the outline is not a flat convex polygon)' : '')
	);
	return true;
}

/**
 * P6 SEPARATE TO NEW OBJECT — the batch's only REPLICATION surface, and so built
 * last and only from parts that already replicate:
 *   (a) a NEW mesh from the selected triangles (their slots, uvs and stored
 *       faces ride along; same parent and local transform = the same world
 *       matrix; its own material CLONE), added and announced through the
 *       existing `object` message — `PeerConnection.send` runs
 *       gateCreationBroadcast on it, so a viewer's piece stays local exactly like
 *       any other creation of theirs — and recorded as a 'create';
 *   (b) the SAME triangles deleted from the source as an ordinary meshgeo commit.
 * The two entries are wrapped in ONE history batch, so Ctrl+Z inside the session
 * takes the piece back in one step (two steps would leave the separated copy
 * floating over a source that has its faces again); at Done the seal sees a
 * mixed-kind run and keeps it as the composite that replays both.
 * Late joiners get the new object from the ordinary scene walk; like every
 * edited mesh its stored faces do not survive that GLTF path (re-derived there).
 * Refused on a collider proxy (not a scene object — peers never learn its uuid)
 * and when the selection is the whole mesh (that is just the object).
 * @returns {string|null} the new object's uuid, or null when refused
 */
export function separateSelectedFaces() {
	interruptOpAdjust();
	if (!FS.object) return null;
	const group = get(objectsGroup);
	const source = FS.object;
	if (!group || !group.getObjectByProperty('uuid', source.uuid)) {
		showToast('Separate works on scene objects — not inside a collider edit');
		return null;
	}
	const face = opTargetFace();
	if (!face?.triIndices?.length) {
		showToast('Select the faces to separate first');
		return null;
	}
	const sel = new Set(face.triIndices.filter((/** @type {number} */ ti) => !!FS.workingTris[ti]));
	if (sel.size >= FS.workingTris.length) {
		showToast('That is the whole mesh — select part of it to separate');
		return null;
	}
	const ordered = [...sel].sort((x, y) => x - y);
	const pieceTris = cloneTris(ordered.map((ti) => FS.workingTris[ti]));
	const piecePositions = trisToPositions(pieceTris);
	if (piecePositions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(piecePositions.length, 'edit'));
		return null;
	}
	const priorFaces = currentPartition();
	/** @type {Map<number, number>} */
	const pieceIndex = new Map(ordered.map((ti, i) => [ti, i]));
	/** @type {number[][]} */
	const pieceFaces = [];
	for (const f of priorFaces ?? []) {
		const members = f.filter((ti) => pieceIndex.has(ti)).map((ti) => /** @type {number} */ (pieceIndex.get(ti)));
		if (members.length) pieceFaces.push(members);
	}
	// (a) the piece
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(piecePositions), 3));
	const pieceGroups = trisToGroups(pieceTris);
	for (const g of pieceGroups ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
	const pieceUvs = trisToUVs(pieceTris);
	if (pieceUvs) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pieceUvs), 2));
	geometry.computeVertexNormals();
	if (source.userData.shading === 'smooth') smoothWeldedNormals(geometry);
	geometry.computeBoundingSphere();
	storeFaces(geometry, pieceFaces);
	const material = Array.isArray(source.material)
		? pieceGroups
			? source.material.map((/** @type {any} */ m) => m.clone())
			: source.material[pieceTris[0]?.mi ?? 0]?.clone() ?? source.material[0].clone()
		: source.material.clone();
	const piece = new THREE.Mesh(geometry, material);
	piece.name = (source.name || 'Mesh') + ' (part)';
	piece.castShadow = source.castShadow;
	piece.receiveShadow = source.receiveShadow;
	if (source.userData.shading) piece.userData.shading = source.userData.shading;
	piece.userData.faceEdited = true;
	piece.position.copy(source.position);
	piece.quaternion.copy(source.quaternion);
	piece.scale.copy(source.scale);
	const parent = source.parent ?? group;
	// (b) the source without them — computed before anything is applied
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: readStoredFaces(source.geometry)
	};
	const kept = cloneTris(FS.workingTris.filter((/** @type {any} */ _, /** @type {number} */ ti) => !sel.has(ti)));
	const positions = trisToPositions(kept);
	const groups = trisToGroups(kept);
	const uvs = trisToUVs(kept);
	const keptFaces = composeFaces(priorFaces, survivorOrigin(FS.workingTris.length, sel), []);
	/** @type {any} */
	const peer = get(peers);
	beginHistoryBatch();
	try {
		parent.add(piece);
		piece.updateMatrixWorld();
		recordObjectPresence('create', piece);
		if (peer)
			peer.send({
				type: 'object',
				element: piece.toJSON(),
				groupuuid: parent !== group ? parent.uuid : undefined
			});
		// every pick indexes the pre-op soup — clear BEFORE the swap
		faceEditSelectedTris.set([]);
		faceEditHighlight.set(-1);
		faceEditHoverTri.set(-1);
		clearEdgeSelectionInner();
		commitMesh({
			uuid: source.uuid,
			apply: 'session',
			before,
			after: { positions, groups, uvs },
			faces: keptFaces,
			stampFaces: true,
			record: 'entry',
			cap: false
		});
	} finally {
		endHistoryBatch('Separate');
	}
	pokeScene();
	const count = pieceFaces.length || sel.size;
	showToast('Separated ' + count + (count === 1 ? ' face' : ' faces') + ' into “' + piece.name + '”');
	return piece.uuid;
}

// ---- session cancel --------------------------------------------------------
// `sealEditHistorySession('discard')` drops the undo entries above the barrier
// but leaves the GEOMETRY edited, so a cancel needs its own snapshot: the state
// the object was in when the session opened.
/** @type {{uuid: string, positions: number[], groups: any, uvs: any} | null} */
let sessionEntryState = null;

/** Take the "cancel returns here" snapshot. Called on session ENTER only — a
 * mode switch inside one session must not move the goalposts. @param {any} object */
function captureSessionEntry(object) {
	if (!object?.geometry) return;
	if (sessionEntryState?.uuid === object.uuid) return; // same session continuing
	const tris = readTriangles(object.geometry);
	sessionEntryState = {
		uuid: object.uuid,
		positions: trisToPositions(tris),
		groups: trisToGroups(tris),
		uvs: trisToUVs(tris)
	};
}

/** Is there anything a cancel would actually undo? (drives the button's state) */
export function sessionHasChanges() {
	const entry = sessionEntryState;
	if (!FS.object || !entry || entry.uuid !== FS.object.uuid) return false;
	const now = trisToPositions(readTriangles(FS.object.geometry));
	if (now.length !== entry.positions.length) return true;
	for (let i = 0; i < now.length; i++)
		if (Math.abs(now[i] - entry.positions[i]) > 1e-6) return true;
	return false;
}

/**
 * Revert the WHOLE mesh-edit session: put the entry-time geometry back, tell
 * peers, and seal the history session as 'discard' so the undo stack is not
 * left holding steps for edits that no longer exist. @returns {boolean}
 */
export function cancelEditSession() {
	interruptOpAdjust(); // 19-A P2: the whole-session revert supersedes a live adjust
	const entry = sessionEntryState;
	if (!FS.object || !entry || entry.uuid !== FS.object.uuid) return false;
	const { positions, groups, uvs } = entry;
	applyGeometrySnapshot(positions, groups, uvs);
	broadcastMeshGeo(FS.object.uuid, positions, groups, uvs);
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	clearEdgeSelection();
	showToast('Mesh edits reverted');
	return true;
}

// ---- M6: cleanup commands --------------------------------------------------

/**
 * M6: re-wind every triangle so its normal points AWAY from its own shell's
 * interior ("recalculate normals outside"). Imported and hand-built meshes
 * routinely arrive with mixed winding, which reads as holes under lighting;
 * `flip` only ever reversed a hand-picked selection.
 *
 * Per SHELL (a merged mesh has several, each with its own inside), the test is
 * the signed volume of the closed surface: negative means the whole shell is
 * inside-out, so flip it. Then any triangle disagreeing with its neighbours is
 * flipped too — that catches a few stray faces in an otherwise correct shell.
 * @returns {boolean}
 */
export function recalculateNormals() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const before = trisToPositions(FS.workingTris);
	const beforeGroups = trisToGroups(FS.workingTris);
	const beforeUVs = trisToUVs(FS.workingTris);
	const beforeFaces = readStoredFaces(FS.object?.geometry);
	const next = cloneTris(FS.workingTris);
	let flipped = 0;
	for (const shell of shellsOfTris(FS.workingTris)) {
		// signed volume via the divergence theorem: sum of the tetrahedra each
		// triangle forms with the origin. Sign flips with the winding.
		let volume = 0;
		for (const ti of shell) {
			const [a, b, c] = FS.workingTris[ti];
			volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
		}
		if (volume >= 0) continue; // already outward
		for (const ti of shell) {
			const t = next[ti];
			const swap = t[1];
			t[1] = t[2];
			t[2] = swap;
			if (t.uv) t.uv = [t.uv[0], t.uv[2], t.uv[1]];
			flipped++;
		}
	}
	if (!flipped) {
		showToast('Normals already point outward');
		return false;
	}
	const positions = trisToPositions(next);
	const groups = trisToGroups(next);
	const uvs = trisToUVs(next);
	commitMesh({
		apply: 'session',
		before: { positions: before, groups: beforeGroups, uvs: beforeUVs, faces: beforeFaces },
		after: { positions, groups, uvs },
		stampFaces: true,
		record: 'op',
		cap: false
	});
	showToast('Recalculated normals: flipped ' + flipped + ' triangles');
	return true;
}

/**
 * M6: merge vertices closer than `threshold` into their shared centroid
 * ("merge by distance" / remove doubles). weldSelectedVerts only ever merged an
 * explicit hand-picked pair; this is the cleanup pass for imported or
 * bridged geometry with near-coincident duplicates.
 *
 * Clusters by a quantized grid at the threshold, which is O(n) and deterministic
 * — every peer that replays the same snapshot gets the same result.
 * @param {number} threshold @returns {boolean}
 */
export function mergeByDistance(threshold = 0.001) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	// 99 K4 family 5: on the session's op mesh — the soup's grid clusters, then the kernel's own vertex merge
	// (a weld only MOVES vertices and drops degenerate triangles, so every survivor keeps the face it was in)
	const r = sessionKernelCommit(
		(ops, om) => ops.mergeByDistance(om, threshold),
		() => {
			// welding drops triangles, so the old indices point somewhere else after the swap
			faceEditSelectedTris.set([]);
			faceEditHighlight.set(-1);
		}
	);
	if (!r) return false;
	showToast('Merged ' + r.moved + ' vertices' + (r.dropped ? ', removed ' + r.dropped + ' degenerate faces' : ''));
	return true;
}

/** A partition's IDENTITY, order-independent: two partitions are the same when they
 * group the same triangles, however the faces and their members happen to be ordered.
 * Only used by the two cleanup ops, to tell "nothing to do" from a real change.
 * @param {number[][]|null} faces @returns {string} */
function partitionKey(faces) {
	return (faces ?? [])
		.map((face) => [...face].sort((a, b) => a - b).join(','))
		.sort()
		.join(';');
}

/**
 * 19-A P5a CLEANUP: TRIANGULATE — one face per triangle.
 *
 * Positions, material slots and UVs are byte-identical: this op rewrites ONLY the stored
 * face partition, which is what Quad granularity, the loop tools and the structure
 * wireframe read. It is the escape hatch for a partition that no longer describes the
 * model, and the exact inverse of Tris to Quads below.
 *
 * BOTH sides of the history entry write `faces` EXPLICITLY. An absent `faces` means
 * "carry the current partition" to applyMeshGeo, and because the positions do NOT change
 * here the carry always succeeds — so an implicit before would restore the partition this
 * op just wrote, and the change would be silently un-undoable (the trisToGroups-null
 * lesson, generalized).
 * @returns {boolean}
 */
export function triangulateMesh() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object || !FS.workingTris.length) return false;
	const priorFaces = currentPartition();
	const singles = FS.workingTris.map((/** @type {any} */ _, /** @type {number} */ ti) => [ti]);
	if (partitionKey(priorFaces) === partitionKey(singles)) {
		showToast('Already one face per triangle — nothing to split');
		return false;
	}
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: priorFaces
	};
	const after = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: singles
	};
	// the pick UNITS change under the user (a quad becomes two separate triangles), so the
	// picks go before the swap rebuilds the overlays from them
	clearEdgeSelectionInner();
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	if (!commitMeshGeoTriple(FS.object.uuid, before, after, true)) return false;
	showToast('Triangulated: ' + singles.length + ' triangles');
	return true;
}

/**
 * 19-A P5a CLEANUP: TRIS TO QUADS — pair the triangles up and STORE the pairing.
 *
 * The same derivation the fallback uses (`pairQuads`: coplanar, co-facing, convex,
 * greedy best-first by squareness with index tie-breaks, so it is deterministic and every
 * peer replaying the snapshot agrees). This op is "re-derive the pairing and store it",
 * never a second algorithm — reimplementing it would give the toolbar button and the
 * fallback two different ideas of what a quad is.
 *
 * Positions are untouched; `faces` is explicit on both sides for the same reason
 * triangulate needs it.
 * @returns {boolean}
 */
export function trisToQuadsMesh() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object || !FS.workingTris.length) return false;
	const priorFaces = currentPartition();
	const paired = derivePartition(FS.workingTris, pairQuads(FS.workingTris));
	const quads = paired.filter((/** @type {number[]} */ face) => face.length === 2).length;
	if (!quads) {
		showToast('No triangle pairs here form a quad (they must be coplanar and convex)');
		return false;
	}
	if (partitionKey(priorFaces) === partitionKey(paired)) {
		showToast('Already paired — the stored faces are exactly these quads');
		return false;
	}
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: priorFaces
	};
	const after = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: paired
	};
	clearEdgeSelectionInner();
	faceEditSelectedTris.set([]);
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	if (!commitMeshGeoTriple(FS.object.uuid, before, after, true)) return false;
	showToast(quads + (quads === 1 ? ' quad paired' : ' quads paired'));
	return true;
}

/**
 * M6: smooth vs flat shading for the edited object. `smoothWeldedNormals`
 * existed but was hard-wired to terrain; this exposes it as a per-object
 * choice stored on userData (so it replicates, saves and survives every
 * geometry swap through applyMeshGeo). @param {boolean} smooth
 */
export function setShadingSmooth(smooth) {
	if (!FS.object) return false;
	FS.object.userData.shading = smooth ? 'smooth' : 'flat';
	if (smooth) smoothWeldedNormals(FS.object.geometry);
	else FS.object.geometry.computeVertexNormals();
	FS.object.geometry.attributes.normal.needsUpdate = true;
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'objectParameters',
			parameter: 'shading',
			uuid: FS.object.uuid,
			shading: FS.object.userData.shading
		});
	pokeScene();
	showToast(smooth ? 'Shading: smooth' : 'Shading: flat');
	return true;
}

/** the edited object's shading mode ('flat' unless set) */
export function shadingMode() {
	return FS.object?.userData?.shading === 'smooth' ? 'smooth' : 'flat';
}

/** M6: select every triangle of the mesh */
function selectAllFacesInner() {
	if (!FS.object) return false;
	faceEditSelectedTris.set(FS.workingTris.map((/** @type {any} */ _, /** @type {number} */ i) => i));
	refreshFaceOverlay();
	return true;
}

/**
 * #20: BOX SELECT for faces and edges — everything whose screen position falls inside
 * `rect` joins the pick.
 *
 * The gap the user reported: a Shift/Ctrl drag has always marquee-selected OBJECTS, and
 * inside a mesh session there was no drag-select at all, so several elements could only
 * be picked one click at a time.
 *
 * Two decisions worth knowing:
 *
 * - A face is tested by its CENTROID and then EXPANDED through `pickFaceUnitTris`, the
 *   same resolver a click goes through. Testing raw triangles instead would let a box
 *   take half a quad, which no other path in this file can produce and which every
 *   granularity above `triangle` would then have to cope with.
 * - Behind-camera points are dropped rather than mirrored into the frustum, which is
 *   what a naive `project()` does with them.
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect CSS pixels, any corner order
 * @param {any} camera @param {{width:number,height:number}} size the canvas' CSS size
 * @param {boolean} [additive] add to the current pick instead of replacing it
 * @returns {number} how many elements are picked afterwards
 */
function selectElementsInRectInner(rect, camera, size, additive = false) {
	if (!FS.object || !FS.workingTris.length || !camera || !size?.width || !size?.height) return 0;
	const minX = Math.min(rect.x1, rect.x2);
	const maxX = Math.max(rect.x1, rect.x2);
	const minY = Math.min(rect.y1, rect.y2);
	const maxY = Math.max(rect.y1, rect.y2);
	const probe = new THREE.Vector3();
	/** local point -> is it inside the box on screen */
	const inside = (/** @type {any} */ p) => {
		probe.set(p.x, p.y, p.z);
		FS.object.localToWorld(probe);
		probe.project(camera);
		if (probe.z > 1) return false;
		const sx = ((probe.x + 1) / 2) * size.width;
		const sy = ((1 - probe.y) / 2) * size.height;
		return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
	};

	if (get(faceEditSubmode) === 'edges') {
		// build key -> midpoint from the triangles, the same way `pickEdgeAt` does:
		// `edgeKey` takes two WELDED VERTEX KEYS, not two positions — passing positions
		// produced keys that matched nothing in `realEdgeMap`, so an edge box selected
		// exactly zero edges while the face box worked fine.
		const real = new Set(realEdgeMap().keys());
		/** @type {Set<string>} */
		const hit = new Set();
		for (const t of FS.workingTris) {
			if (!t) continue;
			for (let e = 0; e < 3; e++) {
				const p0 = t[e];
				const p1 = t[(e + 1) % 3];
				const key = edgeKey(keyOf(p0.x, p0.y, p0.z), keyOf(p1.x, p1.y, p1.z));
				if (!real.has(key) || hit.has(key)) continue;
				const mid = {
					x: (p0.x + p1.x) / 2,
					y: (p0.y + p1.y) / 2,
					z: (p0.z + p1.z) / 2
				};
				if (inside(mid)) hit.add(key);
			}
		}
		if (!hit.size) return get(edgeEditSelected).length;
		const next = additive ? new Set([...get(edgeEditSelected), ...hit]) : hit;
		edgeEditSelected.set([...next]);
		refreshEdgeOverlay();
		return next.size;
	}

	// faces (and vertices are meshEdit's own box select)
	/** @type {Set<number>} */
	const tris = new Set();
	for (let ti = 0; ti < FS.workingTris.length; ti++) {
		const t = FS.workingTris[ti];
		if (!t) continue;
		const centroid = {
			x: (t[0].x + t[1].x + t[2].x) / 3,
			y: (t[0].y + t[1].y + t[2].y) / 3,
			z: (t[0].z + t[1].z + t[2].z) / 3
		};
		if (!inside(centroid)) continue;
		// expand to the pick UNIT, so a box can never take half a quad
		for (const member of pickFaceUnitTris(ti)) tris.add(member);
	}
	if (!tris.size) return get(faceEditSelectedTris).length;
	const next = additive ? new Set([...get(faceEditSelectedTris), ...tris]) : tris;
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return next.size;
}

/** One undo step per box, like every other selection command here.
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect
 * @param {any} camera @param {{width:number,height:number}} size @param {boolean} [additive] */
export function selectElementsInRect(rect, camera, size, additive = false) {
	const mode = get(faceEditSubmode) === 'edges' ? 'edges' : 'faces';
	return withSelectionHistory(mode, () =>
		selectElementsInRectInner(rect, camera, size, additive)
	);
}

/** M6: invert the selection (by pick UNIT, so quads stay whole) */
function invertFaceSelectionInner() {
	if (!FS.object) return false;
	const sel = new Set(get(faceEditSelectedTris));
	const next = new Set();
	FS.workingTris.forEach((/** @type {any} */ _, /** @type {number} */ ti) => {
		if (!sel.has(ti)) pickFaceUnitTris(ti).forEach((u) => next.add(u));
	});
	// a unit straddling the border would drag selected tris back in
	sel.forEach((ti) => next.delete(ti));
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return true;
}

/** M6: grow the selection to every triangle CONNECTED to it (select linked) */
function selectLinkedFacesInner() {
	if (!FS.object) return false;
	const sel = get(faceEditSelectedTris);
	if (!sel.length) {
		showToast('Select something first, then Linked');
		return false;
	}
	const next = new Set(sel);
	for (const shell of shellsOfTris(FS.workingTris))
		if (shell.some((ti) => next.has(ti))) shell.forEach((ti) => next.add(ti));
	faceEditSelectedTris.set([...next]);
	refreshFaceOverlay();
	return true;
}

/** Synthesize a face {triIndices, normal, centroid} from the op target tris (212).
 * For a single coplanar group this equals the groupFaces() face, so the default
 * FACE path is unchanged. */
function opTargetFace() {
	const tris = opTargetTris();
	if (!tris.length) return null;
	const normal = new THREE.Vector3();
	const centroid = new THREE.Vector3();
	let cnt = 0;
	tris.forEach((/** @type {number} */ ti) => {
		normal.add(triNormal(FS.workingTris[ti]));
		FS.workingTris[ti].forEach((/** @type {any} */ v) => (centroid.add(v), cnt++));
	});
	if (normal.lengthSq() < 1e-9) normal.copy(triNormal(FS.workingTris[tris[0]]));
	return { triIndices: tris, normal: normal.normalize(), centroid: centroid.divideScalar(cnt || 1) };
}

/**
 * 19-A P3: decompose a target's tri indices into the face UNITS the current
 * granularity picks — per QUAD at the default, logical faces, single tris, or
 * connected components for shell/object. Session-reading (quadPartner, faces),
 * so it runs at the engine's CAPTURE time only; the pure `insetFaceEx` then
 * consumes the result as plain data (`face.units`).
 * @param {number[]} triIndices @returns {number[][]}
 */
function selectionUnits(triIndices) {
	const g = granularity();
	if (g === 'triangle') return triIndices.map((ti) => [ti]);
	if (g === 'shell' || g === 'object') return componentsOfTris(FS.workingTris, triIndices);
	/** @type {Map<number, number[]>} */
	const byUnit = new Map();
	for (const ti of triIndices) {
		// quad: the pair id; face: the logical face index — one bucket per unit
		const unit = g === 'face' ? faceIndexForTriangle(ti) : quadKey(ti);
		let list = byUnit.get(unit);
		if (!list) byUnit.set(unit, (list = []));
		list.push(ti);
	}
	return [...byUnit.values()];
}

/** Tris to tint in the overlay: the selection plus the hovered unit (212;
 * E10 — the selection always shows, Multi no longer gates it) */
function overlayTris() {
	const set = new Set();
	get(faceEditSelectedTris).forEach((t) => set.add(t));
	pickFaceUnitTris(get(faceEditHoverTri)).forEach((t) => set.add(t));
	return [...set].filter((ti) => FS.workingTris[ti]);
}

// 99 K3: the face session's state lives on the ONE edit session (editSession.js `session.face`, `FS`):
// object (was faceEdited), workingTris, faces, quadPartner, overlay, overlayParts, grab, adjust, proxy,
// proxyStart, gizmoTarget.
/** 175: remember the last face selected per object, restored on re-entry
 * @type {{uuid: string|null, fi: number}} */
let stashedFace = { uuid: null, fi: -1 };

/** rebuild the working triangles + face groups from the live geometry */
function rebuildFaces() {
	if (!FS.object) return;
	FS.workingTris = readTriangles(FS.object.geometry);
	FS.faces = groupFaces(FS.workingTris);
	// STORED topology wins over re-derivation. Deriving quads from coplanarity is
	// only ever as good as the last operator's luck: a 4-degree rotate twists a wall
	// quad's two triangles ~9 degrees apart, which no threshold separates from a real
	// crease, so every derived quad in a rotated band silently vanished and the loop
	// tools declined. When a partition was authored we trust it instead.
	FS.quadPartner = storedPartner(FS.object.geometry, FS.workingTris.length) ?? pairQuads(FS.workingTris);
	quadTopology = null; // M2: the loop-walk adjacency is rebuilt on demand
}

/**
 * A `quadPartner` array built from a STORED partition, or null when there is none.
 * Only 2-triangle faces become quads; a stored n-gon larger than that is left to
 * `groupFaces` for now (the quad model cannot express it, and phase 1 deliberately
 * does not change what a "quad" means).
 * @param {any} geometry @param {number} triCount @returns {Int32Array|null}
 */
function storedPartner(geometry, triCount) {
	const stored = readStoredFaces(geometry);
	if (!stored) return null;
	const partner = new Int32Array(triCount).fill(-1);
	for (const face of stored)
		if (face.length === 2) {
			partner[face[0]] = face[1];
			partner[face[1]] = face[0];
		}
	return partner;
}

/**
 * The origin map for an op that DROPPED some input triangles and kept the rest in order
 * (`tris.filter(...)`): every survivor's new index maps to the input index it was. Any
 * appended geometry is the caller's business — pad with -1 or hand `composeFaces` its
 * own authored faces.
 * @param {number} count input triangle count @param {Set<number>} dropped
 * @returns {number[]}
 */
function survivorOrigin(count, dropped) {
	/** @type {number[]} */
	const origin = [];
	for (let ti = 0; ti < count; ti++) if (!dropped.has(ti)) origin.push(ti);
	return origin;
}

/**
 * Topology for a geometry nobody authored one for, in order of trust: CARRY the
 * previous partition when it still fits exactly, else derive one now.
 *
 * Carrying first is what makes the twisted band work, and skipping it was the first
 * pass's real gap: the gizmo rotate has no authored partition, and EVERY live preview
 * frame swaps the geometry (liveGeometryUpdate), so a derive-only fallback re-guessed
 * the quads from geometry the rotate had already spoiled — mid-gesture, before the
 * commit could even see them. The partition has to survive the preview to survive the
 * commit.
 * @param {any} geometry the fresh geometry @param {any} previous the one it replaces
 */
function carryOrDeriveFaces(geometry, previous) {
	if (carryFaces(geometry, previous)) return;
	storeDerivedFaces(geometry, readTriangles(geometry));
}

/**
 * Derive a quad partition from coplanarity and STORE it. Only ever reached for geometry
 * with no authored and no carryable topology — a mesh's first edit — because derivation
 * is trustworthy exactly once: while the geometry still looks the way whoever built it
 * meant it to.
 * @param {any} geometry @param {any[]} tris @returns {number[][]|null}
 */
function storeDerivedFaces(geometry, tris) {
	if (!geometry || !tris?.length) return null;
	const partition = derivePartition(tris, pairQuads(tris));
	return storeFaces(geometry, partition) ? partition : null;
}

/**
 * The partition of the LIVE session's triangles: stored if there is one, derived if not.
 * This is what an operator consumes — "stored else derived" in one place, so no operator
 * has to know which world it is in.
 * @returns {number[][]|null}
 */
function currentPartition() {
	if (!FS.object || !FS.workingTris.length) return null;
	return readStoredFaces(FS.object.geometry) ?? derivePartition(FS.workingTris, FS.quadPartner);
}

/**
 * Turn a `quadPartner` pairing into a partition. Every triangle lands in exactly one
 * face, so the result always satisfies facesValidFor.
 * @param {any[]} tris @param {Int32Array} partner @returns {number[][]}
 */
function derivePartition(tris, partner) {
	/** @type {number[][]} */
	const partition = [];
	const claimed = new Uint8Array(tris.length);
	for (let ti = 0; ti < tris.length; ti++) {
		if (claimed[ti]) continue;
		const mate = partner[ti] ?? -1;
		if (mate > ti && !claimed[mate]) {
			claimed[ti] = claimed[mate] = 1;
			partition.push([ti, mate]);
		} else {
			claimed[ti] = 1;
			partition.push([ti]);
		}
	}
	return partition;
}

/** O(1) identity of the quad a triangle belongs to — the lower of the pair, so
 * both halves key the same. -1 for no triangle. @param {number} tri */
function quadKey(tri) {
	if (tri < 0 || !FS.workingTris[tri]) return -1;
	const mate = FS.quadPartner[tri] ?? -1;
	return mate >= 0 ? Math.min(tri, mate) : tri;
}

/** the tri indices of the quad `tri` belongs to — itself when it has no mate
 * (a genuine 3-sided face, or an odd triangle in a fan). @param {number} tri */
export function quadOfTriangle(tri) {
	if (tri < 0 || !FS.workingTris[tri]) return [];
	const mate = FS.quadPartner[tri] ?? -1;
	return mate >= 0 ? [tri, mate] : [tri];
}

export function faceCount() {
	return FS.faces.length;
}
/** exposed for tests/preview: the current face groups */
export function currentFaces() {
	return FS.faces;
}

/** @param {string} uuid */
export function enterFaceEdit(uuid) {
	if (get(faceEditObject)) exitFaceEdit();
	const object = lookupEditable(uuid); // A8: also accepts the collider proxy
	if (!object || !object.geometry?.attributes?.position) {
		// D7: a multi-mesh GROUP blocks face editing — say how to unblock it
		if (object?.type === 'Group')
			showToast('A group can’t be mesh-edited — Ungroup it first, then edit each mesh');
		else showToast('Only meshes can be face-edited');
		return;
	}
	if (!vrFaceEditable(object)) {
		editCapToast(
			'Mesh exceeds the face edit limit (' +
				Math.round(triangleCount(object)) +
				' of ' +
				get(vrFaceCap) +
				' triangles) — raise it in Settings ▸ VR'
		);
		return;
	}
	if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
		showToast('This object is locked by another peer');
		return;
	}
	FS.object = object;
	captureSessionEntry(object); // the state a Cancel returns to
	rebuildFaces();
	resetLoopAxis(); // never inherit the previous object's loop direction
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]); // 212
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach?.();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'lock', uuid: uuid, peerId: peer.peer.id });
	faceEditObject.set(uuid);
	noteEditEnter('face', uuid, object); // 15-F: opens (or continues) the undo barrier (99 K3: and the session)
	refreshFaceWireframe(); // B2: face mode gets the same wireframe as vertex mode
	refreshMeshPivotMarker(object); // a placed pivot comes back with the session
	if (typeof window !== 'undefined') {
		window.addEventListener('keydown', onFaceKeydown);
		prebuildOpMesh(object); // 99 K4: the first operator finds its op mesh built
	}
	// 175: restore the face selected last time in this object (per-mode memory)
	if (stashedFace.uuid === uuid && stashedFace.fi >= 0 && FS.faces[stashedFace.fi]) {
		faceEditHighlight.set(stashedFace.fi);
		refreshFaceOverlay();
		// B1: only the Move op keeps a gizmo on the face (see setFaceOp)
		if (get(faceEditOp) === 'move') attachFaceGizmo();
	}
	// ...and the SELECTION SET for whichever submode we are entering. Only
	// `setFaceSubmode` restored that, and it returns early when the submode already IS the
	// requested one — which it always is on the way back from VERTICES. So a face or edge
	// selection survived Faces <-> Edges but died on any trip through Vertices (reported).
	// `restoreSelection` re-checks the uuid and the geometry signature itself.
	if (restoreSelection(get(faceEditSubmode) === 'edges' ? 'edges' : 'faces')) {
		if (typeof window !== 'undefined' && get(faceEditOp) === 'move') attachFaceGizmo();
	}
}

/** @param {KeyboardEvent} event */
function onFaceKeydown(event) {
	if (!viewportHasKeys(event)) return; // 36 U11: Esc in the node editor leaves a GROUP, not the session
	if (knifeKeyConsumed(event)) return; // 37 R11: Enter ends a pending cut, Backspace drops a corner
	if (event.key === 'Escape') {
		if (escapeConsumedByKnife(event)) return;
		if (escapeConsumedByPivotPick(event)) return; // an armed pivot pick first
		if (escapeConsumedByPivotMove(event)) return; // ...then an armed pivot move
		exitFaceEdit();
		sealEditHistorySession(); // 15-F: Escape = Done, sealed synchronously
	}
}

export function exitFaceEdit() {
	if (!FS.object) return;
	if (get(faceEditHighlight) >= 0) stashedFace = { uuid: FS.object.uuid, fi: get(faceEditHighlight) };
	// 19-A P2: settle or drop a live op adjust BEFORE any teardown (the edge
	// clear below routes through withSelectionHistory, whose own endOpAdjust
	// would otherwise strand a deferred VR adjust's preview in the geometry).
	// A desktop adjust is already applied + recorded — settling just brings its
	// entry's `after` up to the last scrubbed state; a DEFERRED (VR) adjust has
	// no entry yet, so exiting reverts its preview like a cancel (122).
	if (FS.adjust) {
		if (FS.adjust.record === 'deferred') restoreAdjustBefore();
		else settleOpAdjust();
		endOpAdjust();
	}
	cancelKnife(); // a pending cut must not outlive the session
	cancelMeshPivotPick(); // nor an armed pivot pick
	cancelMeshPivotMove(); // ...nor an armed pivot MOVE (puts the gizmo mode back)
	disposeMeshPivotMarker(); // ...and its viewport helper goes with the session
	hideProportionalRing(); // P4: nor the radius ring (safety — grabs hide it themselves)
	endProportionalWheel(); // P7b: nor the wheel claim (faceGrab is dropped below)
	detachFaceGizmo(); // 163: drop the desktop gizmo + its proxy
	clearEdgeSelection(); // M4: the edge sub-mode's pick + overlay go with it
	// revert an uncommitted gesture's live preview before tearing down (122)
	const pendingBefore = FS.grab?.before ?? null;
	FS.grab = null;
	// faceGrab.before is a {positions, groups, uvs} TRIPLE (so an undo can
	// restore a mapping explicitly). Accept a bare array defensively, exactly
	// like the 'meshgeo' history kind.
	if (pendingBefore)
		applyGeometrySnapshot(
			pendingBefore.positions ?? pendingBefore,
			pendingBefore.positions ? pendingBefore.groups : undefined,
			pendingBefore.positions ? pendingBefore.uvs : undefined
		);
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onFaceKeydown);
	for (const key of ['sel', 'hover']) {
		const part = FS.overlayParts[key];
		if (!part) continue;
		part.parent?.remove(part);
		part.geometry?.dispose?.();
		part.material?.dispose?.();
		FS.overlayParts[key] = null;
	}
	FS.overlay = null;
	if (wire) {
		wire.parent?.remove(wire);
		wire.geometry?.dispose?.();
		wire.material?.dispose?.();
		wire = null;
	}
	FS.object = null;
	FS.workingTris = [];
	FS.faces = [];
	resetLoopAxis();
	faceEditHighlight.set(-1);
	faceEditHoverTri.set(-1);
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]); // 212
	faceEditObject.set(null);
	noteEditExit('face'); // 15-F: deferred seal unless another mode re-enters
}

/**
 * Map a raycast hit (three.js faceIndex = TRIANGLE index) to a logical face
 * index and highlight it. Returns TRUE only when the highlight changed, so the
 * caller ticks a haptic once and the overlay rebuilds once (121). A negative
 * triangleIndex clears the highlight. @param {number} triangleIndex
 * @param {boolean} [healStale] E10: outside Multi mode, aiming at anything
 * OUTSIDE the current selection dissolves it (the cap E6 keeps selected is a
 * convenience, not a lock) — VR calls this per-frame from the beam, so VR
 * trigger semantics stay identical. Additive (ctrl) desktop clicks pass false
 * or the heal would wipe the selection they are adding to.
 */
export function highlightFaceByTriangle(triangleIndex, healStale = true) {
	// 212: track the raw tri (polygon picking) + refresh per-tri in polygon mode
	const prevTri = get(faceEditHoverTri);
	faceEditHoverTri.set(triangleIndex);
	const fi = triangleIndex < 0 ? -1 : FS.faces.findIndex((f) => f.triIndices.includes(triangleIndex));
	const prevFi = get(faceEditHighlight);
	faceEditHighlight.set(fi);
	let healed = false;
	if (healStale && triangleIndex >= 0 && !get(faceEditMulti)) {
		const sel = get(faceEditSelectedTris);
		if (sel.length) {
			const set = new Set(sel);
			if (!pickFaceUnitTris(triangleIndex).every((t) => set.has(t))) {
				faceEditSelectedTris.set([]);
				healed = true;
			}
		}
	}
	// "changed" means the picked UNIT changed — that is what the overlay draws.
	// Face compares the coplanar group; 15-G quad compares the PAIR (crossing a
	// quad's internal diagonal is not a new unit, so the overlay must not
	// rebuild); triangle/shell/object stay per raw tri (a shell key would mean
	// re-running the union-find on every hover frame).
	const g = granularity();
	const changed =
		g === 'face'
			? fi !== prevFi
			: g === 'quad'
				? quadKey(triangleIndex) !== quadKey(prevTri)
				: triangleIndex !== prevTri;
	if (changed || healed) refreshFaceOverlay();
	return changed;
}

/** Clear the face highlight (ray left the mesh) — returns TRUE if it changed */
export function clearFaceHighlight() {
	return highlightFaceByTriangle(-1);
}

/** logical face index for a triangle index, or -1 (no highlight side-effect) @param {number} triangleIndex */
export function faceIndexForTriangle(triangleIndex) {
	return triangleIndex < 0 ? -1 : FS.faces.findIndex((f) => f.triIndices.includes(triangleIndex));
}

/**
 * E10: live counts for the toolbar — selected tris, the logical faces they
 * cover, the connected PIECES they form, and (with EXACTLY two pieces) their
 * boundary-edge counts, so a bridge mismatch is visible BEFORE clicking.
 *
 * 19-A: the loop counts key off PIECES, not logical faces, because that is
 * bridgeFaces' real precondition — it splits the selection with
 * `componentsOfTris` and takes one `boundaryLoop` per component. Reading two
 * logical faces instead reported edge counts for a gate that does not exist
 * (two coplanar-merged groups on ONE piece showed numbers; one piece made of
 * two selected bands showed none).
 * @returns {{tris: number, faces: number, pieces: number,
 * loops: [number, number] | null}}
 */
export function faceSelectionInfo() {
	const sel = get(faceEditSelectedTris).filter((/** @type {number} */ ti) => FS.workingTris[ti]);
	if (!sel.length) return { tris: 0, faces: 0, pieces: 0, loops: null };
	/** @type {Set<number>} */
	const faceSet = new Set();
	sel.forEach((/** @type {number} */ ti) => {
		const fi = faceIndexForTriangle(ti);
		if (fi >= 0) faceSet.add(fi);
	});
	const parts = componentsOfTris(FS.workingTris, sel);
	/** @type {[number, number] | null} */
	let loops = null;
	if (parts.length === 2) {
		const a = boundaryLoop(FS.workingTris, parts[0]);
		const b = boundaryLoop(FS.workingTris, parts[1]);
		// null = an OPEN boundary, which bridge refuses outright — no numbers to show
		if (a && b) loops = [a.length, b.length];
	}
	return { tris: sel.length, faces: faceSet.size, pieces: parts.length, loops };
}

/** the op target's world-space centroid + normal (for ghost/preview) — the
 * multi selection or hovered unit (212), falling back to the highlighted face */
export function highlightedFaceInfo() {
	const face = opTargetFace();
	if (!face || !FS.object) return null;
	FS.object.updateMatrixWorld(true);
	return {
		index: get(faceEditHighlight),
		centroid: FS.object.localToWorld(face.centroid.clone()),
		normal: face.normal.clone().transformDirection(FS.object.matrixWorld).normalize()
	};
}

/** tint the op target with a scene-root overlay triangle set (212: selection + hover) */
function refreshFaceOverlay() {
	const scene = get(globalScene);
	if (!scene || !FS.object) return;
	for (const key of ['sel', 'hover']) {
		const old = FS.overlayParts[key];
		if (!old) continue;
		old.parent?.remove(old);
		old.geometry?.dispose?.();
		old.material?.dispose?.();
		FS.overlayParts[key] = null;
	}
	FS.overlay = null;
	// The face tint belongs to the FACES submode only. Without this guard (the
	// mirror of refreshEdgeOverlay's) every geometry swap made in edge mode —
	// dissolve, loop cut — resurrected the face overlay from the surviving
	// faceEditSelectedTris, so the quads you picked before switching stayed lit
	// under the edge highlight.
	if (get(faceEditSubmode) === 'edges') return;
	// SELECTION and HOVER are drawn as two different layers. They used to share
	// one tint, so a face you had just DESELECTED stayed lit exactly like a
	// selected one for as long as the cursor rested on it — reported as "invert
	// leaves the old face highlighted" and "shift-deselect doesn't clear the
	// highlight". Selection is a solid fill; hover is a faint wash.
	const selected = get(faceEditSelectedTris).filter((ti) => FS.workingTris[ti]);
	const selSet = new Set(selected);
	const hovered = pickFaceUnitTris(get(faceEditHoverTri)).filter(
		(ti) => FS.workingTris[ti] && !selSet.has(ti)
	);
	FS.object.updateMatrixWorld(true);
	/** @param {number[]} tris @param {number} opacity @param {string} name */
	const build = (tris, opacity, name) => {
		if (!tris.length) return null;
		/** @type {number[]} */
		const positions = [];
		tris.forEach((ti) =>
			FS.workingTris[ti].forEach((/** @type {any} */ v) => positions.push(v.x, v.y, v.z))
		);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		const mesh = new THREE.Mesh(
			geometry,
			new THREE.MeshBasicMaterial({
				color: 0xff7a1a,
				transparent: true,
				opacity,
				depthTest: false,
				// depthTest off + depthWrite ON let the tint stamp the depth buffer, so
				// anything drawn after it (a later pass, the second overlay part) could
				// be occluded by a surface that is not even visible. A highlight should
				// never contribute depth.
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		mesh.renderOrder = 999;
		mesh.name = name;
		mesh.raycast = () => {};
		mesh.applyMatrix4(FS.object.matrixWorld);
		scene.add(mesh);
		return mesh;
	};
	FS.overlayParts.sel = build(selected, 0.45, 'face-edit-overlay');
	FS.overlayParts.hover = build(hovered, 0.14, 'face-edit-hover');
	FS.overlay = FS.overlayParts.sel; // the teardown paths still hold one reference
}

// ---- 99 K4: the session's op mesh -----------------------------------------------------------------------
// An operator runs on the op mesh of the live geometry. It is KEPT across operators (the output of one is
// the next one's input, IDs and all) and rebuilt only when something else replaced or wrote the geometry —
// an undo or redo, a peer's edit, a vertex drag, an operator not on the kernel yet. A rebuild takes the
// IDs the geometry was applied with (history), else the session kernel's vertex map (built off-thread at
// entry with the same weld), else welds.

/** the IDs to rebuild `geometry`'s op mesh with, or null (weld) @param {any} geometry */
function knownIds(geometry) {
	// valid while nothing wrote the geometry since (a drag that lands two vertices on one key must weld)
	const applied = editSession.geometryIds.get(geometry);
	if (applied && !geometryChanged(applied.stamp, geometry)) return applied.ids;
	const maps = editSession.kernelMaps;
	if (maps && maps.geometry === geometry && !geometryChanged(editSession.kernelStamp ?? editSession.entry, geometry))
		// the worker's faces follow the STORED partition only; a derived one regroups from the vertex IDs
		return { cornerVertex: maps.cornerVertex, triFace: readStoredFaces(geometry) ? maps.triFace : null };
	return null;
}

/** the partner key of the agent / headless path (its derived partition is not the session's pairing) */
const OBJECT_PARTNER = Object.freeze({});

/**
 * The op mesh of `geometry`, begun for one operator: the held one while nothing replaced or wrote the
 * geometry since (and its partition is the same: a stored one, else the same derivation), else a fresh
 * build (with the IDs the geometry is known to have). ONE slot, shared by the session and the agent's
 * headless path, so consecutive operators never rebuild.
 * @param {any} ops @param {any} geometry @param {() => number[][] | null} partition @param {any} partner
 */
function heldOpMesh(ops, geometry, partition, partner) {
	const held = editSession.opMesh;
	const topo = geometry.userData?.__topo;
	if (
		held &&
		held.geometry === geometry &&
		!geometryChanged(held.stamp, geometry) &&
		held.topo === topo &&
		(!!topo || held.partner === partner)
	)
		return ops.beginOp(held.om);
	const om = ops.opMeshFromGeometry(geometry, partition(), knownIds(geometry));
	editSession.opMesh = { geometry, stamp: captureEntry(geometry), topo, partner, om };
	return ops.beginOp(om);
}

/** the live face session's op mesh, begun for one operator; null while the kernel chunk loads */
function sessionOpMesh() {
	const ops = editSession.ops;
	if (!ops || !FS.object?.geometry) return null;
	return heldOpMesh(ops, FS.object.geometry, currentPartition, FS.quadPartner);
}

/**
 * 99 K4: build the session's op mesh while the user picks (an idle moment after entry), so the first
 * operator does not pay for it. Skipped when the session moved on.
 * @param {any} object
 */
function prebuildOpMesh(object) {
	loadKernelOps().then(() => {
		const run = () => {
			if (FS.object === object && !FS.adjust && !FS.grab) sessionOpMesh();
		};
		const idle = typeof window !== 'undefined' ? /** @type {any} */ (window).requestIdleCallback : null;
		if (idle) idle(run, { timeout: 2000 });
		else setTimeout(run, 0);
	});
}

/**
 * After a kernel operator's commit on `uuid`: the op mesh IS the new geometry's (the next operator reuses
 * it), and on the session's object its ID channels become the session's ID maps (selectionToIds reads
 * them). Dropped when the stored partition is not the one the op mesh grouped (it never should be).
 * @param {string} uuid @param {any} om @param {{ faces: number[][], ids: any }} out @param {any} partner
 */
function keepOpMesh(uuid, om, out, partner) {
	const geometry = lookupEditable(uuid)?.geometry;
	const stored = geometry ? readStoredFaces(geometry) : null;
	if (!stored || stored.length !== out.faces.length) {
		editSession.opMesh = null;
		return;
	}
	const stamp = captureEntry(geometry);
	editSession.opMesh = { geometry, stamp, topo: geometry.userData?.__topo, partner, om };
	if (uuid !== editSession.uuid) return;
	editSession.kernelMaps = { triFace: out.ids.triFace, cornerVertex: out.ids.cornerVertex, ms: 0, geometry };
	editSession.kernelStamp = stamp;
	editSession.kernel = null; // the worker's kernel describes the entry geometry, not this one
}

/** 99 K4: remember the element IDs the object's CURRENT geometry was applied with (a weak key: a replaced
 * geometry takes its IDs with it) @param {string} uuid @param {any} ids */
function noteGeometryIds(uuid, ids) {
	const geometry = lookupEditable(uuid)?.geometry;
	if (geometry && ids?.cornerVertex && ids?.triFace) editSession.geometryIds.set(geometry, { ids, stamp: captureEntry(geometry) });
}

/**
 * 99 K4: one family-1/2 face operator on an op mesh (the commit, the agent path and the soup adapters
 * share it). `arg` = the distance / inset fraction, or the bevel's options.
 * @param {any} ops @param {any} om @param {'extrude'|'inset'|'move'|'bevel'} op @param {any} face @param {any} arg
 */
function runKernelFaceOp(ops, om, op, face, arg) {
	if (op === 'extrude') ops.extrudeRegion(om, face.triIndices, vec(face.normal), arg);
	else if (op === 'inset') ops.insetRegion(om, face.triIndices, arg);
	else if (op === 'move') ops.moveRegion(om, face.triIndices, vec(face.normal), arg);
	else ops.bevelRegion(om, face.triIndices, vec(face.normal), arg);
}

/** the closed-region refusal for the bevel (no border to fold) */
const CLOSED_BEVEL =
	'Nothing to bevel: that selection is a CLOSED surface, so it has no border to fold. Select fewer faces.';

/** the closed-region refusal (extrude has no border to build walls from) */
const CLOSED_EXTRUDE =
	'Nothing to extrude from: the selection is a CLOSED surface, so it has no border. Select fewer faces, or use Move/Scale to reposition it.';

/**
 * 99 K4 family 1: extrude / inset / move on the session's op mesh, committed straight from the kernel
 * (no triangle soup): the same positions, partition, uvs and slots as the soup ops, plus the ID channels
 * in both history states, so an undo / redo rebuilds the same element IDs.
 * @param {'extrude'|'inset'|'move'|'bevel'} op @param {any} face the op target @param {any} amount the distance / inset fraction, or the bevel's options
 * @returns {boolean}
 */
function commitKernelFaceOp(op, face, amount) {
	const om = sessionOpMesh();
	if (!om) {
		showToast(KERNEL_LOADING);
		return false;
	}
	const ops = editSession.ops;
	const pick = captureSelection(FS.object.uuid);
	if ((op === 'extrude' || op === 'bevel') && !ops.regionHasBorder(om, face.triIndices)) {
		showToast(op === 'bevel' ? CLOSED_BEVEL : CLOSED_EXTRUDE);
		return false;
	}
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: readStoredFaces(FS.object?.geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let out;
	try {
		runKernelFaceOp(ops, om, op, face, amount);
		out = ops.opOutput(om, { order: op === 'move' ? 'stored' : 'appearance' });
	} finally {
		// the op mesh was edited in place: nothing may reuse it until the commit re-keeps it
		editSession.opMesh = null;
	}
	if (out.positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(out.positions.length, 'edit'));
		return false;
	}
	// the hover holds a pre-op triangle forever otherwise (no desktop pointermove path); the cap's
	// indices survive (walls and rings append), so the selection needs no pre-swap clear
	faceEditHoverTri.set(-1);
	commitMesh({
		apply: 'session',
		before,
		after: { positions: out.positions, groups: out.groups, uvs: out.uvs, ids: out.ids },
		faces: out.faces,
		stampFaces: true,
		record: 'op',
		cap: false,
		selectionBefore: pick
	});
	keepOpMesh(FS.object.uuid, om, out, FS.quadPartner);
	// E6: keep the CAP selected (its triangle indices survive the op); E7: the gizmo comes back seated on it
	faceEditSelectedTris.set([...face.triIndices]);
	faceEditHighlight.set(faceIndexForTriangle(face.triIndices[0]));
	refreshFaceOverlay();
	// (the bevel never seated the gizmo: Bevel stays the armed op)
	if (op !== 'bevel' && typeof window !== 'undefined') attachFaceGizmo();
	return true;
}

/**
 * 99 K4 (99-ops-b): run a kernel operator on the live session's op mesh and commit its output with the ID
 * channels (both history states), keeping the op mesh for the next operator. `run(ops, om)` edits the op
 * mesh and returns its result, or `{error}` to refuse with that toast (nothing committed); `beforeSwap` is
 * the op's own housekeeping just before the geometry swap. `options.record` = how history takes it ('op', the
 * default: live symmetry mirrors it; 'entry' for an op that IS the mirror); `options.tooLarge` = the size
 * refusal's verb. @param {(ops: any, om: any) => any} run @param {() => void} [beforeSwap]
 * @param {{ record?: 'op' | 'entry', tooLarge?: string }} [options]
 * @returns {any} the operator's result, or null when refused
 */
function sessionKernelCommit(run, beforeSwap, options = {}) {
	const om = sessionOpMesh();
	if (!om) {
		showToast(KERNEL_LOADING);
		return null;
	}
	const ops = editSession.ops;
	// the op's starting pick: its undo puts it back (ops-a family 2's rule)
	const pick = captureSelection(FS.object.uuid);
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: readStoredFaces(FS.object?.geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let result;
	/** @type {any} */
	let out;
	try {
		result = run(ops, om);
		if (result && 'error' in result) {
			showToast(result.error);
			return null;
		}
		out = ops.opOutput(om, { order: 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place: re-kept only by the commit below
	}
	if (out.positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(out.positions.length, options.tooLarge ?? 'edit'));
		return null;
	}
	beforeSwap?.();
	faceEditHoverTri.set(-1); // desktop has no pointermove path: the hover would hold a pre-op triangle
	commitMesh({
		apply: 'session',
		before,
		after: { positions: out.positions, groups: out.groups, uvs: out.uvs, ids: out.ids },
		faces: out.faces,
		stampFaces: true,
		record: options.record ?? 'op',
		cap: false,
		selectionBefore: pick
	});
	keepOpMesh(FS.object.uuid, om, out, FS.quadPartner);
	return result;
}

/**
 * Run an op on the highlighted face and commit: rebuild geometry, replicate
 * the snapshot, record history. subdivide/flip take no amount (B4); for M3's
 * loopcut and 18-C5's bridge `amount` is the CUT COUNT, not a distance.
 * @param {'extrude'|'inset'|'move'|'delete'|'subdivide'|'flip'|'bridge'|'loopcut'|'knife'} op
 * @param {number} amount
 */
export function commitFaceOp(op, amount) {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	// B4: bridge validates + commits its own two-face path
	if (op === 'bridge') return bridgeFaces(amount);
	// M3: loop cut owns its ring walk + commit, like bridge; `amount` = cut count
	if (op === 'loopcut') return commitLoopCut(amount);
	// 212: target the multi selection / hovered unit / highlighted face group
	const face = opTargetFace();
	if (!FS.object || !face) return false;
	// 99 K4 family 1: on the kernel
	if (op === 'extrude' || op === 'inset' || op === 'move') return commitKernelFaceOp(op, face, amount);
	// 99 K4 family 5: delete on the session's op mesh (the face only partly picked keeps the rest of itself)
	if (op === 'delete')
		return !!sessionKernelCommit(
			(ops, om) => ops.deleteTriangles(om, face.triIndices),
			() => {
				// the picks address the pre-op triangles (212)
				if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]);
				faceEditHighlight.set(-1);
			}
		);
	// 99 K4 family 6: subdivide on the session's op mesh — quad-aware (a paired quad becomes a 2x2 grid, so the
	// quad topology and with it every loop tool survives the split), the new pieces stay selected
	if (op === 'subdivide') {
		const partner = FS.quadPartner;
		const r = sessionKernelCommit(
			(ops, om) => ops.subdivideUnits(om, face.triIndices, partner),
			() => {
				// subdivide rebuilds the topology: the picks address the pre-op triangles (212)
				if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]);
			}
		);
		if (!r) return false;
		if (r.newTris.length) {
			// keep the subdivided AREA selected (its new pieces): "subdivide, then loop through one of the new
			// quads" is the point of the op, and an empty selection there reads as a failed edit
			faceEditSelectedTris.set(r.newTris);
			refreshFaceOverlay();
		}
		return true;
	}
	const before = trisToPositions(FS.workingTris);
	const beforeGroups = trisToGroups(FS.workingTris);
	const beforeUVs = trisToUVs(FS.workingTris);
	const beforeFaces = readStoredFaces(FS.object?.geometry);
	let next;
	/** @type {number[][] | null} P10: the partition the OP authored, when it can
	 * describe its own output. Null falls back to derive-and-store. */
	let nextFaces = null;
	const priorFaces = currentPartition();
	if (op === 'flip') {
		next = flipFaceNormals(FS.workingTris, face.triIndices);
		// winding only — the grouping is untouched
		nextFaces = priorFaces;
	} else return false;
	const positions = trisToPositions(next);
	if (positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, 'edit'));
		return false;
	}
	// 15-G / M1: these ops change the triangle COUNT, so a multi-material mesh
	// needs its groups recomputed and a textured one its uvs (the grab/adjust
	// paths only move vertices, and their counts match, so applyGeometrySnapshot
	// carries the old groups/uvs over)
	const groups = trisToGroups(next);
	const uvs = trisToUVs(next);
	// Clear the stale picks BEFORE the swap: applyGeometrySnapshot rebuilds the
	// overlay, and the pre-op indices address the NEW triangle array — they light
	// up an unrelated scattering. The hover is the worse half: desktop has no
	// pointermove path, so faceEditHoverTri keeps the pre-op triangle forever.
	faceEditHoverTri.set(-1);
	// flip rebuilds the triangles: indices are stale (212)
	if (get(faceEditSelectedTris).length) faceEditSelectedTris.set([]);
	commitMesh({
		apply: 'session',
		before: { positions: before, groups: beforeGroups, uvs: beforeUVs, faces: beforeFaces },
		after: { positions, groups, uvs },
		faces: nextFaces,
		stampFaces: true,
		record: 'op',
		cap: false
	});
	return true;
}

/**
 * 19-A P5b: DUPLICATE the selected faces — append an exact copy of the picked
 * triangles, COINCIDENT with the source until moved (Blender's Shift+D).
 *
 * mi/uv ride cloneTris; the copies are authored with the SOURCE's stored grouping
 * mapped onto the appended range, so a duplicated quad is still a quad to the loop
 * tools (and a duplicated n-gon an n-gon). The copies become the selection and the
 * gizmo seats on them, ready to drag — beginFaceGrab recognises a fully-coincident
 * patch and skips the weld stitch, which is what lets the copy peel OFF its source
 * instead of dragging the source (and everything welded to it) along.
 * @returns {boolean}
 */
export function duplicateSelectedFaces() {
	interruptOpAdjust(); // 19-A P2: a one-shot commit ends any live adjust first
	if (!FS.object) return false;
	const face = opTargetFace();
	if (!face?.triIndices?.length) {
		showToast('Select a face first, then Duplicate');
		return false;
	}
	const sel = [...face.triIndices];
	const base = FS.workingTris.length;
	const next = [...cloneTris(FS.workingTris), ...cloneTris(sel.map((ti) => FS.workingTris[ti]))];
	const positions = trisToPositions(next);
	if (positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, 'edit'));
		return false;
	}
	const priorFaces = currentPartition();
	// the SOURCE's grouping, re-keyed onto the appended range
	/** @type {Map<number, number>} */
	const newIndexOf = new Map();
	sel.forEach((ti, i) => newIndexOf.set(ti, base + i));
	/** @type {number[][]} */
	const authored = [];
	for (const group of priorFaces ?? []) {
		const members = group
			.filter((/** @type {number} */ ti) => newIndexOf.has(ti))
			.map((/** @type {number} */ ti) => /** @type {number} */ (newIndexOf.get(ti)));
		if (members.length) authored.push(members);
	}
	const before = {
		positions: trisToPositions(FS.workingTris),
		groups: trisToGroups(FS.workingTris),
		uvs: trisToUVs(FS.workingTris),
		faces: readStoredFaces(FS.object?.geometry)
	};
	const groups = trisToGroups(next);
	const uvs = trisToUVs(next);
	// the survivors keep their indices (append-only), so the selection needs no
	// pre-swap clear — but the hover does, always (no desktop pointermove path)
	faceEditHoverTri.set(-1);
	commitMesh({
		apply: 'session',
		before,
		after: { positions, groups, uvs },
		faces: composeFaces(priorFaces, appendOrigin(base, next.length), authored),
		stampFaces: true,
		record: 'op',
		cap: false
	});
	// the COPIES are the selection now (they are what you drag next); the gizmo seats
	// on them exactly like commitFaceOp's extrude cap
	/** @type {number[]} */
	const copyIndices = [];
	for (let i = base; i < next.length; i++) copyIndices.push(i);
	faceEditSelectedTris.set(copyIndices);
	faceEditHighlight.set(faceIndexForTriangle(base));
	refreshFaceOverlay();
	if (typeof window !== 'undefined') attachFaceGizmo();
	const count = authored.length || sel.length;
	showToast(
		'Duplicated ' + count + (count === 1 ? ' face' : ' faces') + ' — drag to move the copy'
	);
	return true;
}

/** swap the LIVE edited object's geometry + re-derive faces + overlay
 * @param {number[]} positions @param {any[] | null} [groups] material groups (15-G)
 * @param {number[] | null} [uvs] texture coordinates (M1)
 * @param {number[][] | null} [faces] P9: the partition the operator AUTHORED. Omitted
 *   means "derive it here", which this function then STORES — see storeDerivedFaces. */
function applyGeometrySnapshot(positions, groups, uvs, faces) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	const previous = FS.object.geometry;
	preserveMaterialGroups(geometry, previous, FS.object, groups);
	preserveUVs(geometry, previous, uvs);
	previous?.dispose?.();
	FS.object.geometry = geometry;
	FS.object.userData.faceEdited = true;
	if (!faces || !storeFaces(geometry, faces)) carryOrDeriveFaces(geometry, previous);
	rebuildFaces();
	refreshFaceOverlay();
	refreshEdgeHighlight(); // M4: baked in world space, same as the face overlay
	refreshFaceWireframe(); // B2: the overlay wraps the NEW geometry
	pokeScene();
}

/**
 * P9: stamp the topology that is CURRENTLY stored on the edited geometry into a meshgeo
 * history state. It lives INSIDE the state object because `endHistorySession` compaction
 * synthesises one entry from `first.before`/`last.after` — a sibling field on the entry
 * would be dropped by that merge (design answer A5).
 * @param {any} state @returns {any}
 */
function withFaces(state) {
	const faces = readStoredFaces(FS.object?.geometry);
	return faces ? { ...state, faces } : state;
}

/** @param {string} uuid @param {ArrayLike<number>} positions @param {any[] | null} [groups]
 * @param {ArrayLike<number> | null} [uvs] @param {ArrayLike<number> | null} [colors] */
function broadcastMeshGeo(uuid, positions, groups, uvs, colors) {
	// P9: the topology rides as OPTIONAL sibling fields read off the object we just
	// committed to — that is the partition by construction, so no call site has to
	// thread it through. An older peer ignores the fields and re-derives, exactly as it
	// does today: absent topology is never WRONG, only less capable.
	// The bytes (raw Float32, optional fields only when present) are meshCommit's one sender.
	if (!get(peers)) return;
	sendMeshGeo(uuid, positions, {
		groups,
		uvs,
		colors,
		faceFields: facesWireFields(readStoredFaces(lookupEditable(uuid)?.geometry))
	});
}

/**
 * 99 K4: the pick an operator starts from — faces, highlight and edges of the face session on `uuid`, the
 * vertex picks of a vertex session on it. An operator's history entry carries it so its UNDO brings that pick
 * back (the geometry the undo restores is byte-identical to pre-op, so the indices and keys are valid again).
 * @param {string} uuid
 */
function captureSelection(uuid) {
	const face = FS.object?.uuid === uuid;
	const vertex = vertexSelectionHistory?.snapshot();
	return {
		uuid,
		faces: face ? [...get(faceEditSelectedTris)] : null,
		highlight: face ? get(faceEditHighlight) : -1,
		edges: face ? [...get(edgeEditSelected)] : null,
		verts: vertex?.uuid === uuid ? vertex.sel : null
	};
}

/**
 * Put a captured pick back on the session it was taken in (no selection history: the undo / redo is the step).
 * @param {any} sel a `captureSelection` result (or the adjust engine's selectionBefore)
 * @param {string} uuid
 */
function restoreCapturedSelection(sel, uuid) {
	if (!sel) return;
	if (sel.faces && FS.object?.uuid === uuid) {
		faceEditSelectedTris.set(sel.faces.filter((/** @type {number} */ ti) => FS.workingTris[ti]));
		faceEditHighlight.set(sel.highlight);
		edgeEditSelected.set((sel.edges ?? []).filter((/** @type {string} */ k) => !!edgeEndpoints(k)));
		faceEditHoverTri.set(-1);
		refreshFaceOverlay();
		refreshEdgeOverlay();
		if (typeof window !== 'undefined') {
			if (get(faceEditOp) === 'move') attachFaceGizmo();
			else detachFaceGizmo();
		}
	} else if (sel.verts && vertexSelectionHistory?.snapshot()?.uuid === uuid) {
		vertexSelectionHistory.apply(sel.verts);
	}
}

/**
 * 99 K2: THE mesh commit — snapshot -> apply -> broadcast -> record, in one place. Every
 * operator, the vertex tools, sculpt, the UV editor, the agent tools and the history replay's
 * sender used to run their own copy of these four steps (about twenty-five of them); they all
 * call this now, and each keeps exactly the message and the history entry it produced before.
 *
 * - snapshot: `before` is the caller's (taken before it mutated anything); both sides are
 *   kept as `compactMeshState` typed arrays, so history counts the bytes it really holds.
 * - apply: `'session'` swaps the live face session's geometry (applyGeometrySnapshot:
 *   overlays, face cache, wireframe); `'object'` swaps any object's (applyMeshGeo).
 * - broadcast: one `meshgeo` through meshCommit's sender, the topology read off the object
 *   just applied to (`wireFaces: 'object'`) or not sent at all (`'none'`, the UV editor's
 *   message, which never carried it).
 * - record: `'op'` (recordOp: the live-symmetry operator boundary), `'entry'` (recordEntry)
 *   or false (the caller owns the entry: the live mirror rewrites one, the adjust engine
 *   records at its own moment).
 *
 * @param {{
 *   uuid?: string,
 *   before?: any,
 *   after: any,
 *   apply: 'session' | 'object',
 *   faces?: number[][] | null,
 *   record?: 'op' | 'entry' | false,
 *   cap?: string | false,
 *   stampFaces?: boolean,
 *   carryColors?: boolean,
 *   selectionBefore?: any,
 *   wireFaces?: 'object' | 'none'
 * }} c `after` = `{positions, groups?, uvs?, colors?}` or a bare positions array; `faces` = the
 *   partition the operator AUTHORED (applied as stored topology; absent = carry or derive);
 *   `cap` = the noun of the size refusal (false: the caller already refused); `stampFaces` =
 *   record the stored partition the apply left (withFaces, A5); `carryColors` = keep a
 *   coloured mesh's colours in both sides (commitMeshGeoTriple's rule); `selectionBefore` = the operator's
 *   starting pick (`captureSelection`), restored by the entry's undo (99 K4).
 * @returns {{ kind: 'meshgeo', uuid: string, before: any, after: any } | null} the entry
 *   (recorded unless `record` is false), or null when the size cap refused the commit
 */
export function commitMesh(c) {
	const uuid = c.uuid ?? FS.object?.uuid;
	if (!uuid) return null;
	let after = c.after;
	const bare = Array.isArray(after) || ArrayBuffer.isView(after);
	const positions = bare ? after : after.positions;
	if (c.cap !== false && positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, c.cap || 'edit'));
		return null;
	}
	let before = c.before;
	const groups = bare ? undefined : after.groups;
	const uvs = bare ? undefined : after.uvs;
	if (c.apply === 'session') {
		applyGeometrySnapshot(positions, groups, uvs, c.faces);
	} else if (bare) {
		applyMeshGeo(uuid, positions);
	} else {
		// mcp-shapes: a coloured mesh's colours go into BOTH sides of the entry, so an undo brings them back exactly
		// (an op's own snapshots are positions/groups/uvs only)
		const had = c.carryColors ? lookupEditable(uuid)?.geometry?.attributes?.color : null;
		if (had && before && typeof before === 'object' && before.colors == null && before.positions?.length === had.count * 3) before = { ...before, colors: Array.from(had.array) };
		const packed = c.faces?.length ? packFaces(c.faces) : null;
		applyMeshGeo(uuid, positions, groups, uvs, packed?.faceCounts, packed?.faceTris, after.colors);
		const now = c.carryColors ? lookupEditable(uuid)?.geometry?.attributes?.color : null;
		if (now && after.colors == null) after = { ...after, colors: Array.from(now.array) };
	}
	// 99 K3: a commit on the object of the open edit session — from the session's own tools, VR,
	// or an agent tool editing headless — marks the one session edited, so its leave keeps the
	// live geometry and never re-emits the entry arrays
	if (uuid === editSession.uuid) editSession.edited = true;
	if (c.wireFaces === 'none') sendMeshGeo(uuid, positions, { groups, uvs });
	else broadcastMeshGeo(uuid, positions, groups, uvs, bare ? undefined : after.colors);
	if (c.stampFaces)
		after = withFacesOn(c.apply === 'session' ? FS.object : lookupEditable(uuid), {
			positions,
			groups,
			uvs,
			...(!bare && c.after.ids ? { ids: c.after.ids } : {})
		});
	// 99 K4: the IDs this geometry now has, for the next operator's rebuild
	if (!bare && c.after.ids) noteGeometryIds(uuid, c.after.ids);
	const entry = meshGeoEntry(uuid, before, after);
	if (c.selectionBefore) /** @type {any} */ (entry).selection = { before: c.selectionBefore, after: null };
	if (c.record === 'op') recordOp(entry);
	else if (c.record === 'entry') recordEntry(entry);
	return entry;
}

/**
 * 99 K2/K3: one `meshgeo` history entry — both sides compact, and the kernel's ID channels (when
 * a state carries them) shared by reference with this object's previous step wherever the
 * topology did not change, so history holds them once (meshCommit `shareIds`).
 * @param {string} uuid @param {any} before @param {any} after
 * @returns {{ kind: 'meshgeo', uuid: string, before: any, after: any }}
 */
function meshGeoEntry(uuid, before, after) {
	const b = compactMeshState(before);
	const a = compactMeshState(after);
	if (b?.ids || a?.ids) {
		const stack = get(undoStack);
		let prev = null;
		for (let i = stack.length - 1; i >= 0 && i >= stack.length - 8; i--)
			if (stack[i]?.kind === 'meshgeo' && stack[i].uuid === uuid) {
				prev = stack[i];
				break;
			}
		shareIds(b, prev?.after, prev?.before);
		shareIds(a, b, prev?.after);
	}
	return { kind: 'meshgeo', uuid, before: b, after: a };
}

/**
 * 99 K2: record a `meshgeo` entry for a change already applied and sent (a vertex drag streams
 * its own previews and lands in place): the record step of `commitMesh` alone, so every
 * producer stores the same compact shape.
 * @param {string} uuid @param {any} before @param {any} after @param {boolean} [op] (37 R11)
 */
export function recordMeshGeo(uuid, before, after, op = false) {
	const entry = meshGeoEntry(uuid, before, after);
	(op ? recordOp : recordEntry)(entry);
	return entry;
}

/**
 * Commit a full geometry snapshot for ANY object (161 stretch, 162/163 face
 * transforms): swap locally, replicate, record ONE undoable meshgeo. Size-
 * capped like the face ops. @param {string} uuid @param {number[]} before
 * @param {number[]} after @param {boolean} [op] an OPERATOR's commit (37 R11)
 * @returns {boolean}
 */
export function commitMeshGeoSnapshot(uuid, before, after, op = false) {
	// 99 K2: the one commit, positions only (a bare array on both sides, as before)
	return !!commitMesh({ uuid, apply: 'object', before, after, record: op ? 'op' : 'entry', cap: 'edit' });
}

/** Order 4 coplanar-ish points into a convex ring around their centroid, so a
 * fan triangulation is non-self-intersecting. @param {THREE.Vector3[]} v */
function orderQuad(v) {
	const c = new THREE.Vector3();
	v.forEach((p) => c.add(p));
	c.multiplyScalar(1 / v.length);
	const n = new THREE.Vector3()
		.subVectors(v[1], v[0])
		.cross(new THREE.Vector3().subVectors(v[2], v[0]))
		.normalize();
	const u = new THREE.Vector3().subVectors(v[0], c).normalize();
	const w = new THREE.Vector3().crossVectors(n, u).normalize();
	const ang = (/** @type {THREE.Vector3} */ p) => {
		const d = new THREE.Vector3().subVectors(p, c);
		return Math.atan2(d.dot(w), d.dot(u));
	};
	return [...v].sort((a, b) => ang(a) - ang(b));
}

/** 177/183: create a triangle (3) or quad (4) face from OBJECT-LOCAL vertex
 * positions and commit it as a meshgeo snapshot (replicated + undoable). Winds
 * the new face outward (normal away from the mesh centre). Shared by the desktop
 * vertices toolbar and VR. @param {string} uuid @param {{x:number,y:number,z:number}[]} verts
 * @param {any} [viewerPos] world-space viewer position; when given, the face is wound to FACE
 * the viewer (191: in VR the face you look at must be the visible side) */
export function createFaceFromVerts(uuid, verts, viewerPos = null) {
	if (!verts || verts.length < 3 || verts.length > 4) return false;
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !object.geometry?.attributes?.position) return false;
	let poly = verts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
	// reject degenerate selections (duplicate/collinear points)
	for (let i = 0; i < poly.length; i++)
		for (let j = i + 1; j < poly.length; j++) if (poly[i].distanceTo(poly[j]) < 1e-6) return false;
	if (poly.length === 4) poly = orderQuad(poly);
	// outward winding: flip if the face normal points toward the mesh centre
	const meshCenter = new THREE.Box3()
		.setFromBufferAttribute(object.geometry.attributes.position)
		.getCenter(new THREE.Vector3());
	const faceCenter = new THREE.Vector3();
	poly.forEach((p) => faceCenter.add(p));
	faceCenter.multiplyScalar(1 / poly.length);
	const normal = new THREE.Vector3()
		.subVectors(poly[1], poly[0])
		.cross(new THREE.Vector3().subVectors(poly[2], poly[0]));
	let flip;
	if (viewerPos) {
		// 191: wind so the normal points AT the viewer (the side they look from)
		const localViewer = object.worldToLocal(viewerPos.clone());
		flip = normal.dot(new THREE.Vector3().subVectors(localViewer, faceCenter)) < 0;
	} else {
		// outward winding: flip if the face normal points toward the mesh centre
		flip = normal.dot(new THREE.Vector3().subVectors(faceCenter, meshCenter)) < 0;
	}
	// fan-triangulate the ordered polygon
	const appended = [];
	for (let i = 1; i < poly.length - 1; i++) {
		const tri = [poly[0], poly[i], poly[i + 1]];
		const ordered = flip ? [tri[0], tri[2], tri[1]] : tri;
		for (const p of ordered) appended.push(p.x, p.y, p.z);
	}
	const before = trisToPositions(readTriangles(object.geometry));
	const after = before.concat(appended);
	return commitMeshGeoSnapshot(uuid, before, after, true);
}

// ---- VR face grab + live extrude/inset (122): a pending edit applied live,
// committed as ONE meshgeo on release/confirm ----

let lastFaceBroadcast = 0;
// The rigid face-grab state is `FS.grab`. The LIVE op adjust (19-A P2) is `FS.adjust`: the engine
/* that generalized the VR extrude/inset adjust to every parameterized op. Shape:
 * { op, kind, params, uuid, session, object?, before: {positions,groups,uvs,faces},
 *   priorFaces, originalTris, target, quadPartner?, selectionBefore, entry,
 *   installedGeometry, record, lastFaces, lastSelect, after, capWarned }
 * The store mirror `opAdjustState` is declared up in the store block (TDZ).
 */

/** Live geometry swap from the CURRENT workingTris WITHOUT re-grouping faces
 * (indices stay stable through a gesture); broadcasts a preview ~5/s. */
function liveGeometryUpdate() {
	const positions = trisToPositions(FS.workingTris);
	// 15-G: the live preview swaps geometry every frame — without the groups a
	// multi-material mesh blinks out for the whole gesture (a live extrude/inset
	// adjust re-stitches walls, so the count changes too)
	const groups = trisToGroups(FS.workingTris);
	const uvs = trisToUVs(FS.workingTris); // M1: same reason — the texture must not blink
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();
	const previous = FS.object.geometry;
	preserveMaterialGroups(geometry, previous, FS.object, groups);
	preserveUVs(geometry, previous, uvs);
	// P10: the preview swaps geometry every frame, so topology has to survive HERE or
	// there is nothing left for the commit to carry (this is why a rotated band still
	// lost its quads after the commit path already carried them)
	carryOrDeriveFaces(geometry, previous);
	previous?.dispose?.();
	FS.object.geometry = geometry;
	FS.object.userData.faceEdited = true;
	refreshFaceOverlay();
	// P7b: the EDGE highlight tracks the gesture too (it used to sit at the
	// pre-drag position until release); submode-guarded inside, and during a
	// grab it draws from the grab's own live endpoints (see refreshEdgeOverlay)
	refreshEdgeOverlay();
	refreshFaceWireframe(); // B2: track the gesture live
	pokeScene();
	const now = Date.now();
	// The PREVIEW is the one thing that must stay small. A gesture streams this
	// ~5×/s, so a mesh at the commit ceiling would be ~60 MB/s at every peer —
	// the session stops being interactive for people who are not even editing.
	// Above the preview ceiling the gesture is LOCAL: peers see the committed
	// result at the end (broadcastMeshGeo in the commit path), just not the
	// rehearsal. That is the whole trade that makes big meshes editable.
	if (now - lastFaceBroadcast > 200 && previewReplicable(positions.length)) {
		lastFaceBroadcast = now;
		broadcastMeshGeo(FS.object.uuid, positions, groups, uvs);
	}
}

/** True while a face grab or a live op adjust is in progress (122) */
export function faceGesturePending() {
	return !!FS.grab || !!FS.adjust;
}

// 19-A P4: the radius ring's EDGES/FACES anchor providers — the registration
// seam (proportionalRing cannot import this module's internals, and this module
// cannot be imported from proportional's leaf). Both convert the LOCAL target
// into a WORLD anchor; null when nothing is selected, which hides the ring.
registerProportionalAnchor('faces', () => {
	if (!FS.object) return null;
	const target = opTargetFace();
	if (!target) return null;
	FS.object.updateMatrixWorld(true);
	return {
		point: FS.object.localToWorld(target.centroid.clone()),
		normal: target.normal.clone().transformDirection(FS.object.matrixWorld).normalize(),
		object: FS.object
	};
});
registerProportionalAnchor('edges', () => {
	if (!FS.object) return null;
	const target = edgeGrabTarget();
	if (!target) return null;
	FS.object.updateMatrixWorld(true);
	return {
		point: FS.object.localToWorld(target.centroid.clone()),
		normal: target.normal.clone().transformDirection(FS.object.matrixWorld).normalize(),
		object: FS.object
	};
});

/** Begin a rigid grab of the target (grip/gizmo). Captures the pre-edit snapshot
 * + the target's original local vertices.
 * @param {any} faceOrIndex a synthesized op target, or a face-group index */
export function beginFaceGrab(faceOrIndex) {
	// 19-A P2: a NEW gesture ends a live adjust (a recorded one keeps its edit —
	// the entry was written at apply), so the gizmo drag that follows an
	// auto-applied extrude never deadlocks on faceGesturePending.
	interruptOpAdjust();
	if (!FS.object || faceGesturePending()) return false;
	// 212-style: accept a SYNTHESIZED target (granularity/multi-aware, see
	// opTargetFace) or a plain face-group index for back-compat. The gizmo passes
	// the synthesized one — grabbing `faces[highlight]` was why a Shell pick
	// highlighted a whole island but only dragged the coplanar face under the
	// cursor, leaving the rest of the shell behind.
	const index = typeof faceOrIndex === 'number' ? faceOrIndex : -1;
	const face = typeof faceOrIndex === 'number' ? FS.faces[faceOrIndex] : faceOrIndex;
	if (!face) return false;
	// M4 EDGE grab: a target may name VERTEX KEYS instead of triangles, and an edge
	// move is then the DEGENERATE case of a face grab — no triangle moves rigidly, and
	// every corner sitting on one of those keys rides the existing weld-neighbour path,
	// which is precisely "welded translate of the edge's two vertex groups". Reusing
	// this gesture rather than writing a second one is what makes the edge gizmo inherit
	// undo, replication and the topology carry-over for free.
	const vertexKeys = face.vertexKeys instanceof Set ? face.vertexKeys : null;
	const triIndices = (face.triIndices ?? []).filter((/** @type {number} */ ti) => FS.workingTris[ti]);
	if (!vertexKeys && !triIndices.length) return false;
	if (vertexKeys && !vertexKeys.size) return false;
	// weld-neighbour set (138): verts OUTSIDE the grabbed set sharing its corner
	// positions — the TRANSLATION carries them so the mesh stretches, not tears.
	// A whole-shell/object grab has none, which is exactly right: it moves rigidly.
	const faceSet = new Set(triIndices);
	const keys = vertexKeys ?? faceVertexKeys(FS.workingTris, { triIndices });
	// 19-A P4 PROPORTIONAL: with the toggle on, the capture widens — every corner
	// within `radius` of the grab set joins `neighbours` with a smoothstep weight
	// (the welded corners keep w = 1: they ARE the grab). Weights are captured
	// HERE, at grab start, so a re-grab (the gizmo re-seats + re-runs this on
	// every drag) recaptures them — the same "weights cannot chase the drag" rule
	// as the vertex path. Distances are OBJECT-LOCAL (workingTris is local
	// space), matching the vertex path's radius semantics; the distance measured
	// is to the NEAREST grabbed corner, so a long edge or face carries a band
	// around itself, not a sphere around its centroid.
	const proportional = get(proportionalEdit);
	const radius = proportional ? Math.max(get(proportionalRadius), 1e-4) : 0;
	const radius2 = radius * radius;
	/** @type {any[]} one position per welded key of the grab set */
	const grabPoints = [];
	if (proportional) {
		const seen = new Set();
		const source = triIndices.length
			? triIndices.map((/** @type {number} */ ti) => FS.workingTris[ti])
			: FS.workingTris; // an edge grab names KEYS only — scan for their positions
		source.forEach((/** @type {any} */ t) =>
			t.forEach((/** @type {any} */ v) => {
				const key = keyOf(v.x, v.y, v.z);
				if (!keys.has(key) || seen.has(key)) return;
				seen.add(key);
				grabPoints.push(v.clone());
			})
		);
	}
	// 19-A P5b: a grab whose EVERY triangle has a coincident TWIN outside the set is a
	// freshly-duplicated patch (Duplicate faces leaves the copy exactly on its source).
	// Position-welding cannot tell the copy from its source, so the normal stitch would
	// hand the source's corners — and everything welded to them — a w=1 ride, and the
	// copy could never be moved OFF its source at all, which is the whole point of the
	// op. Such a grab captures NO neighbours (proportional included): it peels off
	// cleanly, Blender's semantics for duplicated geometry. Tri-based grabs only; an
	// edge grab names keys, not triangles, and keeps its stitch.
	const sigOf = (/** @type {any} */ t) =>
		t.map((/** @type {any} */ v) => keyOf(v.x, v.y, v.z)).sort().join('~');
	let coincidentPatch = false;
	if (triIndices.length) {
		const grabSigs = new Set(triIndices.map((/** @type {number} */ ti) => sigOf(FS.workingTris[ti])));
		const twinned = new Set();
		FS.workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
			if (faceSet.has(ti)) return;
			const sig = sigOf(t);
			if (grabSigs.has(sig)) twinned.add(sig);
		});
		coincidentPatch = twinned.size === grabSigs.size;
	}
	/** @type {any[]} */
	const neighbours = [];
	if (!coincidentPatch)
	FS.workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (faceSet.has(ti)) return;
		t.forEach((/** @type {any} */ v, /** @type {number} */ k) => {
			if (keys.has(keyOf(v.x, v.y, v.z))) {
				neighbours.push({ ti, k, orig: v.clone(), w: 1 });
				return;
			}
			if (!proportional || !grabPoints.length) return;
			let min2 = Infinity;
			for (const p of grabPoints) {
				const d2 = v.distanceToSquared(p);
				if (d2 < min2) min2 = d2;
			}
			if (min2 >= radius2) return; // outside the radius — squared early-out, no sqrt
			const w = falloffWeight(Math.sqrt(min2) / radius);
			if (w > 0) neighbours.push({ ti, k, orig: v.clone(), w });
		});
	});
	FS.grab = {
		index,
		triIndices,
		// a TRIPLE, matching commitFaceGrab's `after`: an undo then restores the
		// pre-grab mapping explicitly instead of relying on carry-over
		before: {
			positions: trisToPositions(FS.workingTris),
			groups: trisToGroups(FS.workingTris),
			uvs: trisToUVs(FS.workingTris)
		},
		// withSlot hangs `mi`/`uv` off the triangle ARRAY, and Array.prototype.map
		// returns a fresh array WITHOUT them — a plain .map here silently dropped the
		// grabbed face's material slot and texture coordinates (the "clicking a face
		// again in move mode makes its texture disappear" report). cloneTris is the
		// idiom; this is the same shape for one triangle.
		originals: triIndices.map((/** @type {number} */ ti) =>
			withSlot(
				FS.workingTris[ti].map((/** @type {any} */ v) => v.clone()),
				FS.workingTris[ti].mi,
				FS.workingTris[ti].uv && FS.workingTris[ti].uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
			)
		),
		neighbours,
		centroid: face.centroid.clone(),
		// what rotate/scale turn AROUND. The target's own centroid unless the user
		// has placed a custom pivot on this object (meshPivot, LOCAL pref) — which
		// is the whole point of placing one: rotating a face about a corner rather
		// than about its middle.
		pivot: meshPivotLocal(FS.object.uuid) ?? face.centroid.clone(),
		normal: face.normal.clone(),
		// P7b: what the mid-drag WHEEL recapture needs — the welded grab keys, the
		// original grab-corner positions (proportional only) and the duplicate-patch
		// verdict, all captured against the PRE-drag positions
		grabKeys: keys,
		grabPoints,
		coincident: coincidentPatch
	};
	// P7b: the edge overlay is keyed by POSITION, so a live grab strands it at the
	// pre-drag place (and the lookups fail outright once the endpoints move).
	// Capture the selected edges' ORIGINAL endpoints; applyFaceGrab transforms
	// them per frame and refreshEdgeOverlay draws those while the grab lives.
	if (get(faceEditSubmode) === 'edges') {
		/** @type {any[][]} */
		const pairs = [];
		for (const key of get(edgeEditSelected)) {
			const ends = edgeEndpoints(key);
			if (ends) pairs.push([ends[0].clone(), ends[1].clone()]);
		}
		FS.grab.edgeOrig = pairs;
	}
	if (index >= 0) faceEditHighlight.set(index);
	// P4: the radius ring for the duration of the drag (hidden on commit/cancel)
	if (proportional && grabPoints.length) {
		FS.object.updateMatrixWorld(true);
		showProportionalRingAt({
			point: FS.object.localToWorld(face.centroid.clone()),
			normal: face.normal.clone().transformDirection(FS.object.matrixWorld).normalize(),
			object: FS.object
		});
		// P7b: the wheel resizes the radius mid-drag; weights recapture from the
		// new radius against the SAME original positions (disarmed on commit/cancel)
		beginProportionalWheel(recaptureGrabFalloff);
	}
	return true;
}

/**
 * 19-A P7b: re-derive the grab's proportional NEIGHBOUR set from the CURRENT
 * radius — the mid-drag wheel's recapture. Everything is measured against the
 * ORIGINAL positions (`before.positions` / `grabPoints`), never the live mesh:
 * the falloff must not chase the drag, and a moved corner's welded key no
 * longer even resolves. Previously-carried corners are restored to their
 * originals first, so one that fell OUT of the shrunken radius snaps back, and
 * the re-applied gesture (absolute from originals) moves the new set.
 */
function recaptureGrabFalloff() {
	const g = FS.grab;
	if (!g || !FS.object || !g.grabPoints?.length || g.coincident) return;
	const radius = Math.max(get(proportionalRadius), 1e-4);
	const radius2 = radius * radius;
	// restore every previously-carried corner — the new set re-moves its members
	for (const n of g.neighbours) FS.workingTris[n.ti][n.k] = n.orig.clone();
	const faceSet = new Set(g.triIndices);
	const keys = g.grabKeys;
	const before = g.before.positions;
	/** @type {any[]} */
	const neighbours = [];
	FS.workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		if (faceSet.has(ti)) return;
		t.forEach((/** @type {any} */ _v, /** @type {number} */ k) => {
			const at = ti * 9 + k * 3;
			const ox = before[at];
			const oy = before[at + 1];
			const oz = before[at + 2];
			if (keys.has(keyOf(ox, oy, oz))) {
				neighbours.push({ ti, k, orig: new THREE.Vector3(ox, oy, oz), w: 1 });
				return;
			}
			let min2 = Infinity;
			for (const p of g.grabPoints) {
				const dx = ox - p.x;
				const dy = oy - p.y;
				const dz = oz - p.z;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 < min2) min2 = d2;
			}
			if (min2 >= radius2) return;
			const w = falloffWeight(Math.sqrt(min2) / radius);
			if (w > 0) neighbours.push({ ti, k, orig: new THREE.Vector3(ox, oy, oz), w });
		});
	});
	g.neighbours = neighbours;
	// re-apply the gesture so the surface reshapes NOW (the ring re-scales via
	// its own radius subscriber); before any movement there is nothing to redo
	if (g.lastT) applyFaceGrab(g.lastT);
	else liveGeometryUpdate();
}

/**
 * Apply a LOCAL-space rigid transform to the grabbed face around its centroid
 * (rebuilt from the snapshot each call — no drift). Pure + testable.
 * E8: `scale` also takes a Vector3 (per-axis, in the PROXY frame given by
 * `scaleQuat` — v' = R·S·R⁻¹·v); a plain number stays uniform, so every VR
 * caller is untouched.
 * @param {{dPos?: any, dQuat?: any, push?: number, scale?: number | any, scaleQuat?: any}} t
 */
export function applyFaceGrab(t) {
	if (!FS.grab || !FS.object) return;
	// `pivot` is the placed pivot when there is one, else the target's centroid
	// (pre-pivot grabs, and every VR caller, still see exactly the centroid)
	const pivot = FS.grab.pivot ?? FS.grab.centroid;
	const dPos = t.dPos || new THREE.Vector3();
	const dQuat = t.dQuat || new THREE.Quaternion();
	const scale = t.scale ?? 1;
	const pushVec = FS.grab.normal.clone().multiplyScalar(t.push || 0);
	/** @type {(v: any) => any} diagonal scale sandwiched in the proxy frame */
	let applyScale;
	if (typeof scale === 'number') {
		applyScale = (v) => v.multiplyScalar(scale);
	} else {
		const R = t.scaleQuat || new THREE.Quaternion();
		const Rinv = R.clone().invert();
		applyScale = (v) => v.applyQuaternion(Rinv).multiply(scale).applyQuaternion(R);
	}
	// the ONE rigid transform (about the face centroid) applied to a base vertex
	const xf = (/** @type {any} */ v) =>
		applyScale(v.clone().sub(pivot)).applyQuaternion(dQuat).add(pivot).add(dPos).add(pushVec);
	FS.grab.triIndices.forEach((/** @type {number} */ ti, /** @type {number} */ k) => {
		const source = FS.grab.originals[k];
		// carry mi/uv across the transform — see the note on `originals` above
		FS.workingTris[ti] = withSlot(
			source.map(xf),
			source.mi,
			source.uv && source.uv.map((/** @type {number[]} */ p) => [p[0], p[1]])
		);
	});
	// 162: the welded neighbours sit at the face's CORNER positions, so they get
	// the SAME rigid transform — shared corners stay welded under rotate + scale
	// too (138 moved them by translation only, which tore the edge when the
	// controller rotated). Their far verts aren't in the set, so adjacent faces
	// stretch instead of moving rigidly.
	FS.grab.neighbours.forEach((/** @type {any} */ n) => {
		// P4: a partial-weight corner (proportional falloff) BLENDS from its original
		// toward the full transform. Absolute from `orig` on every call — like the
		// rigid path above, a long drag cannot drift. `n.w` is 1 for the welded set
		// (and for any pre-P4 entry without a weight).
		const moved = xf(n.orig);
		FS.workingTris[n.ti][n.k] = (n.w ?? 1) >= 1 ? moved : n.orig.clone().lerp(moved, n.w);
	});
	// P7b: keep the last gesture so the wheel recapture can re-apply it, and
	// carry the selected edges' live endpoints for the overlay (the keys are
	// position-quantized, so the moved edge can't be looked up mid-drag)
	FS.grab.lastT = t;
	if (FS.grab.edgeOrig)
		FS.grab.edgeLive = FS.grab.edgeOrig.map((/** @type {any[]} */ pair) => pair.map(xf));
	liveGeometryUpdate();
}

/**
 * 19-A P7b (the lost-edge-selection bug): the welded edge KEYS are position-
 * quantized, so moving an edge CHANGES its key and the stored selection stops
 * resolving — the highlight vanished and the gizmo detached the moment a drag
 * committed. Remap every selected key through the grab's actual movement:
 * old corner position -> its moved position, read straight off the before/after
 * pair, which also covers proportional partial-weight carries for free.
 * Direct store write — op housekeeping, not a user pick (the weld rule).
 * @param {number[]} beforePositions the grab's before snapshot
 */
function remapEdgeSelectionAfterGrab(beforePositions) {
	const sel = get(edgeEditSelected);
	if (!sel.length) return;
	/** @type {Map<string, string>} old welded key -> the moved corner's key */
	const movedKeys = new Map();
	FS.workingTris.forEach((/** @type {any} */ t, /** @type {number} */ ti) => {
		t.forEach((/** @type {any} */ v, /** @type {number} */ k) => {
			const at = ti * 9 + k * 3;
			const ox = beforePositions[at];
			const oy = beforePositions[at + 1];
			const oz = beforePositions[at + 2];
			if (ox === v.x && oy === v.y && oz === v.z) return;
			const oldKey = keyOf(ox, oy, oz);
			if (!movedKeys.has(oldKey)) movedKeys.set(oldKey, keyOf(v.x, v.y, v.z));
		});
	});
	if (!movedKeys.size) return;
	const next = new Set();
	for (const key of sel) {
		const [ka, kb] = key.split('|');
		next.add(edgeKey(movedKeys.get(ka) ?? ka, movedKeys.get(kb) ?? kb));
	}
	edgeEditSelected.set([...next]);
}

/** Commit the grab: finalize geometry, replicate, one undo entry. */
export function commitFaceGrab() {
	if (!FS.grab || !FS.object) return false;
	hideProportionalRing(); // P4: the radius ring lives for the drag only
	endProportionalWheel(); // P7b: the wheel belongs to the live drag only
	const positions = trisToPositions(FS.workingTris);
	const before = FS.grab.before;
	FS.grab = null;
	// carry groups + uvs explicitly rather than leaning on preserveUVs' carry-over
	// (commitFaceAdjust's shape). Positions-only meant the undo entry stored a bare
	// array, so an undo could not heal a mapping the grab had damaged.
	const groups = trisToGroups(FS.workingTris);
	const uvs = trisToUVs(FS.workingTris);
	// P7b: BEFORE the swap — applyGeometrySnapshot rebuilds the edge overlay from
	// the selection, which must already carry the moved edges' NEW keys
	remapEdgeSelectionAfterGrab(before.positions);
	commitMesh({
		apply: 'session',
		before,
		after: { positions, groups, uvs },
		stampFaces: true,
		record: 'op',
		cap: false
	});
	return true;
}

/** Drop a grab without committing — restore the pre-grab geometry. */
export function cancelFaceGrab() {
	if (!FS.grab || !FS.object) return;
	hideProportionalRing();
	endProportionalWheel(); // P7b
	const before = FS.grab.before;
	FS.grab = null;
	applyGeometrySnapshot(before.positions, before.groups, before.uvs);
}

// ---- 163: desktop face transform gizmo (a scene-root proxy driving the 162
// rigid grab). The proxy lives at the SCENE ROOT (not under the object) so it
// never leaks into GLTF sync / raycasts, like the vertex proxy. ----
// the proxy is `FS.proxy` (+ `FS.proxyStart`); `FS.gizmoTarget` = the op target the gizmo was seated on

// placing / clearing the pivot re-seats the FACE-or-EDGE gizmo on it, and moves
// its marker. Registered here rather than watched as a store so the two element
// modes and the vertex mode share one seam (meshEdit registers its own).
registerMeshPivotListener(() => {
	if (!FS.object) return;
	attachFaceGizmo();
	refreshMeshPivotMarker(FS.object);
});

/** meshEdit registers here so the vertex proxy follows both prefs without importing
 * faceEdit's internals (and without a cycle — meshEdit already imports this module)
 * @type {(() => void)[]} */
const gizmoPrefListeners = [];
/** @param {() => void} fn */
export function registerGizmoPrefListener(fn) {
	gizmoPrefListeners.push(fn);
}

// ^ declared ABOVE the stores below: their subscribers run SYNCHRONOUSLY at module
// eval, and reading a `let`/`const` declared later TDZ-crashes the SSR prerender
// (the documented store-subscriber gotcha — this cost one 500 while wiring it).

/** E9: face-gizmo space — 'local' = the FACE basis (Z = normal), 'world' =
 * world axes. Persisted local pref. NOTE three r185: scale mode always
 * orients local, whatever `.space` says. Declared AFTER faceProxy: the
 * subscriber runs at module eval (the store-subscriber TDZ gotcha).
 * @type {import('svelte/store').Writable<'local'|'world'>} */
export const faceGizmoSpace = writable(
	typeof localStorage !== 'undefined' && safeStorage.getItem('faceGizmoSpace') === 'world'
		? 'world'
		: 'local'
);
faceGizmoSpace.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('faceGizmoSpace', String(value));
	/** @type {any} */
	const controls = get(TControls);
	// live flip while the face gizmo is seated
	if (FS.proxy && controls && controls.object === FS.proxy) controls.setSpace?.(value);
	// vertex mode seats its own proxy (meshEdit) — it re-reads this store on change
	gizmoPrefListeners.forEach((fn) => fn());
});

/**
 * Whether a transform gizmo seats at all, in EVERY element mode (vertices/edges/faces).
 * One switch rather than three: the gizmo is a preference about how you like to work, not
 * a property of what you happen to have selected, and a per-mode toggle would need
 * explaining. Local pref, default ON.
 *
 * Modes with no selection detach anyway; this is the answer to "let me get the gizmo out
 * of the way" — modelling with click-select and the ops toolbar only.
 * @type {import('svelte/store').Writable<boolean>} */
export const meshGizmoEnabled = writable(
	typeof localStorage !== 'undefined' ? safeStorage.getItem('meshGizmoEnabled') !== '0' : true
);
meshGizmoEnabled.subscribe((value) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem('meshGizmoEnabled', value ? '1' : '0');
	if (typeof window === 'undefined') return;
	// live: seat or drop the gizmo the moment the switch flips, in whichever mode is open.
	// 24-B1: switching it back ON also restores a pick the mode key hid, so the toolbox
	// button and the key are one control (no-op when nothing is hidden)
	if (value) {
		restoreHiddenElements();
		attachFaceGizmo();
	} else detachFaceGizmo();
	gizmoPrefListeners.forEach((fn) => fn());
});

/** E9: pick the world axis least aligned with n (deterministic tangent seed)
 * @param {any} n */
function axisLeastAlignedWith(n) {
	const ax = Math.abs(n.x),
		ay = Math.abs(n.y),
		az = Math.abs(n.z);
	if (ax <= ay && ax <= az) return new THREE.Vector3(1, 0, 0);
	if (ay <= az) return new THREE.Vector3(0, 1, 0);
	return new THREE.Vector3(0, 0, 1);
}

function ensureFaceProxy() {
	if (FS.proxy) return FS.proxy;
	const scene = get(globalScene);
	if (!scene) return null;
	FS.proxy = new THREE.Object3D();
	FS.proxy.userData.isFaceProxy = true;
	scene.add(FS.proxy);
	return FS.proxy;
}

/** World-space focus target {center,radius} for the selected face, or null (173). */
export function focusTargetFace() {
	if (!FS.object) return null;
	const fi = get(faceEditHighlight);
	if (fi < 0 || !FS.faces[fi]) return null;
	FS.object.updateMatrixWorld(true);
	const center = FS.object.localToWorld(FS.faces[fi].centroid.clone());
	const box = new THREE.Box3().setFromObject(FS.object);
	const objR = box.getSize(new THREE.Vector3()).length() / 2;
	return { center, radius: Math.max(objR * 0.3, 0.3) };
}

/**
 * Attach the transform gizmo to the current op TARGET (desktop) — the same
 * granularity/multi-aware set every other op uses, not just the coplanar face
 * under the cursor. The target is STASHED here because by the time the user
 * presses a gizmo handle the pointer is over the gizmo, not the mesh, so the
 * live hover can no longer be trusted to describe what they meant to grab.
 */
export function attachFaceGizmo() {
	if (typeof window === 'undefined' || !FS.object) return;
	if (get(isVRMode)) return; // the desktop gizmo helper would render in-headset
	/** @type {any} */
	const controls = get(TControls);
	// the one switch, honoured for every mode (see meshGizmoEnabled)
	if (!get(meshGizmoEnabled)) {
		FS.gizmoTarget = null;
		detachFaceGizmo();
		return;
	}
	// M4 EDGE gizmo. It must never fall through to opTargetFace here: that reads
	// faceEditSelectedTris/HoverTri, so before the edge target existed a drag in edge
	// mode silently moved whatever quads were picked BEFORE the switch.
	if (get(faceEditSubmode) === 'edges') {
		const edgeTarget = edgeGrabTarget();
		if (!edgeTarget || !controls) {
			FS.gizmoTarget = null;
			detachFaceGizmo();
			return;
		}
		FS.gizmoTarget = edgeTarget;
		const edgeProxy = ensureFaceProxy();
		if (!edgeProxy) return;
		FS.object.updateMatrixWorld(true);
		edgeProxy.position.copy(
			FS.object.localToWorld(meshPivotLocal(FS.object.uuid) ?? edgeTarget.centroid.clone())
		);
		// X along the edge, Z out of the surface (see edgeGrabTarget)
		const along = edgeTarget.direction.clone().transformDirection(FS.object.matrixWorld).normalize();
		const out = edgeTarget.normal.clone().transformDirection(FS.object.matrixWorld).normalize();
		const side = new THREE.Vector3().crossVectors(out, along).normalize();
		if (side.lengthSq() < 1e-9) side.copy(axisLeastAlignedWith(out));
		const zAxis = new THREE.Vector3().crossVectors(along, side).normalize();
		edgeProxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, side, zAxis));
		edgeProxy.scale.setScalar(1);
		controls.setSpace?.(get(faceGizmoSpace));
		controls.attach(edgeProxy);
		return;
	}
	const target = opTargetFace();
	if (!target || !controls) {
		FS.gizmoTarget = null;
		detachFaceGizmo();
		return;
	}
	FS.gizmoTarget = target;
	const proxy = ensureFaceProxy();
	if (!proxy) return;
	FS.object.updateMatrixWorld(true);
	// a placed pivot seats the gizmo, and `beginFaceGrab` makes the grab turn
	// about the same point — the two must agree or the handles lie
	proxy.position.copy(
		FS.object.localToWorld(meshPivotLocal(FS.object.uuid) ?? target.centroid.clone())
	);
	// E9: FACE basis — gizmo Z = the face WORLD normal (push/pull), X/Y = its
	// tangents (deterministic seed: the world axis least aligned with n). The
	// old object-quaternion copy gave every face of an axis-aligned box the
	// same handles.
	const n = target.normal.clone().transformDirection(FS.object.matrixWorld).normalize();
	const t = new THREE.Vector3().crossVectors(axisLeastAlignedWith(n), n).normalize();
	const bit = new THREE.Vector3().crossVectors(n, t);
	proxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t, bit, n));
	proxy.scale.setScalar(1);
	controls.setSpace?.(get(faceGizmoSpace));
	controls.attach(proxy);
}

/** Detach + remove the face gizmo proxy. */
export function detachFaceGizmo() {
	/** @type {any} */
	const controls = get(TControls);
	if (FS.proxy) {
		if (controls && controls.object === FS.proxy) controls.detach();
		FS.proxy.parent?.remove(FS.proxy);
		FS.proxy = null;
	}
	FS.proxyStart = null;
	FS.gizmoTarget = null;
	// E9 leak fix: setSpace('local') used to stick to the SHARED TransformControls
	// after a face session, silently flipping normal object transforms to local
	controls?.setSpace?.('world');
}

/** Gizmo dragging-changed for the face proxy (163). @param {boolean} dragging */
export function onFaceGizmoDragChanged(dragging) {
	if (!FS.object || !FS.proxy) return;
	// MOVE PIVOT armed: the drag re-points the pivot, in faces AND edges (both
	// seat this one proxy). Diverted BEFORE `beginFaceGrab`, so no grab is ever
	// opened — a face grab that had to be unwound would leave a live preview
	// behind. Drag end writes the pivot only: no geometry, no undo, no message.
	if (get(meshPivotMoving)) {
		if (dragging) setMeshPivotPreview(FS.proxy.position.clone());
		else commitMeshPivotDrag(FS.object, FS.proxy.position);
		return;
	}
	if (dragging) {
		// the target captured when the gizmo was seated (see attachFaceGizmo)
		if (beginFaceGrab(FS.gizmoTarget ?? get(faceEditHighlight))) {
			// E9: R maps proxy-local into object-local (identity when the proxy
			// copied the object frame, the pre-E9 case) — deltas measured in the
			// proxy frame must be conjugated through it before hitting the verts
			const objQuat = FS.object.getWorldQuaternion(new THREE.Quaternion());
			FS.proxyStart = {
				pos: FS.proxy.position.clone(),
				quat: FS.proxy.quaternion.clone(),
				R: objQuat.invert().multiply(FS.proxy.quaternion)
			};
		}
	} else if (FS.proxyStart) {
		FS.proxyStart = null;
		commitFaceGrab(); // ONE meshgeo + undo; rebuilds the face cache
		attachFaceGizmo(); // re-seat on the rebuilt face
	}
}

/** Gizmo onchange for the face proxy — apply the rigid transform (163/162;
 * E9 face-basis frame conjugation; E8 per-axis scale). */
export function onFaceGizmoMoved() {
	// MOVE PIVOT armed: only the marker follows the gizmo (no grab was opened
	// above, so `faceProxyStart` is null and the geometry path below is dead
	// anyway — this branch exists for the live feedback)
	if (get(meshPivotMoving)) {
		if (FS.proxy) setMeshPivotPreview(FS.proxy.position.clone());
		return;
	}
	if (!FS.object || !FS.proxy || !FS.proxyStart) return;
	const dPos = FS.object
		.worldToLocal(FS.proxy.position.clone())
		.sub(FS.object.worldToLocal(FS.proxyStart.pos.clone()));
	// the delta in the PROXY frame, conjugated into object-local (dQuatLocal =
	// R·dQuat·R⁻¹) — with the face-basis proxy the raw delta is in the wrong
	// frame and a rotate-about-normal would smear the cap off its plane
	const dQuatProxy = FS.proxyStart.quat.clone().invert().multiply(FS.proxy.quaternion);
	const R = FS.proxyStart.R;
	const dQuat = R.clone().multiply(dQuatProxy).multiply(R.clone().invert());
	applyFaceGrab({ dPos, dQuat, scale: FS.proxy.scale.clone(), scaleQuat: R });
}

/** The op target as a synthesized face (multi selection / hovered polygon /
 * highlighted group) — for the VR live-adjust + ghost to aim at (212). */
export function currentTargetFace() {
	return opTargetFace();
}

// ---- 19-A P2: THE ADJUST ENGINE ---------------------------------------------
// Generalizes the VR extrude/inset live-adjust (the 122/212 precedent that used
// to live right here) to EVERY parameterized op. The model is Blender's F9:
// the op APPLIES immediately — replicated, ONE history entry recorded AT APPLY,
// so Ctrl+Z works at any moment with zero special cases — and the options pane
// (or the VR sticks) then re-runs the PURE core from the ORIGINAL snapshot at
// new parameters until a pick / mode switch / another op ends the adjust.
// VR is a consumer now: beginFaceAdjust and friends wrap this engine.

/** the object a live adjust edits: the face session's mesh, or (for the
 * session-free VERTEX bevel) whatever lookupEditable resolves @param {any} a */
function liveObjectOf(a) {
	return a.session ? FS.object : lookupEditable(a.uuid);
}

/** like `withFaces` but for an explicit object — the vertex-mode adjust edits
 * the meshEdit session's object, where `faceEdited` is null
 * @param {any} object @param {any} state */
function withFacesOn(object, state) {
	const stored = readStoredFaces(object?.geometry);
	return stored ? { ...state, faces: stored } : state;
}

/** Merge a partial params patch, clamped per op (VR sticks pass absolutes too).
 * @param {any} a @param {any} patch */
function mergeAdjustParams(a, patch) {
	const p = { ...(a.params ?? {}), ...patch };
	if (a.op === 'extrude' || a.op === 'inset') {
		// 192: inset must stay in 0.02..0.9 — clamping to [-5,5] like extrude let
		// controller motion drive the inset to ~0/negative, collapsing it (it
		// looked like the second-trigger confirm had CANCELLED the operation)
		const min = a.op === 'inset' ? 0.02 : -5;
		const max = a.op === 'inset' ? 0.9 : 5;
		p.distance = Math.min(Math.max(p.distance ?? (a.op === 'inset' ? 0.2 : 0.3), min), max);
		p.capScale = Math.min(Math.max(p.capScale ?? 1, 0.05), 5);
		p.individual = !!p.individual; // P3: per-piece direction / per-unit rings
		if (a.op === 'inset') p.depth = Math.min(Math.max(p.depth ?? 0, -2), 2);
	} else if (a.op === 'bevel') {
		p.width = p.width ?? 0.1;
		// P7c: the vertex bevel has segments too now (concentric cap rings)
		p.segments = p.segments ?? 1;
		if (a.kind === 'faces') {
			// P3: the faces profile is the STEP SCHEDULE (1 = quarter-circle, the
			// pre-P3 behaviour); direction signs the push. P7a: -1 = the CONCAVE
			// quarter circle, so the range matches the edge/vertex profile's.
			p.profile = Math.min(Math.max(p.profile ?? 1, -1), 1);
			p.direction = p.direction === 'in' ? 'in' : 'out';
		} else {
			p.profile = Math.min(Math.max(p.profile ?? 0, -1), 1);
		}
	} else if (a.op === 'loopcut') {
		p.cuts = Math.max(1, Math.min(Math.round(p.cuts ?? 1) || 1, 20));
		// P3: single-cut placement; clamped short of the boundary (a cut AT 0/1
		// emits a zero-width band)
		p.position = Math.min(Math.max(p.position ?? 0.5, 0.01), 0.99);
		// P7b: which of the anchor quad's TWO rings the cut runs across — 0 = the
		// begin-time selection pick, 1 = the perpendicular ring captured with it
		p.axis = p.axis === 1 ? 1 : 0;
	} else if (a.op === 'bridge') {
		p.cuts = Math.max(0, Math.min(Math.round(p.cuts ?? 0) || 0, 20));
		p.twist = Math.max(-20, Math.min(Math.round(p.twist ?? 0) || 0, 20));
		p.invert = !!p.invert; // P7a: the user's override on the shell-test guess
	} else if (a.op === 'subdivide') {
		// P3: 4^levels growth — MAX_SNAPSHOT backstops the big-face case
		p.levels = Math.max(1, Math.min(Math.round(p.levels ?? 1) || 1, 3));
	} else if (a.op === 'edge-extrude') {
		// P5b: world units, signed — negative pulls the strip the other way
		p.distance = Math.min(Math.max(p.distance ?? 0.5, -5), 5);
	} else if (a.op === 'edge-slide') {
		// P6: 0 = where the edges are; ±1 = onto either side's rail ends
		p.factor = Math.min(Math.max(p.factor ?? 0, -1), 1);
	} else if (a.op === 'solidify') {
		// P6: world units, positive = into the surface (the back copy goes behind it)
		p.thickness = Math.min(Math.max(p.thickness ?? 0.1, -5), 5);
	}
	a.params = p;
}

/**
 * Run the adjust's PURE core from the ORIGINAL snapshot at the CURRENT params.
 * Returns `{tris, faces, select, info?}` — `faces` is the authored partition
 * composed against the pre-op one, `select` the op's post-selection rule — or
 * `{error}` with the wrapper's exact refusal text. Never touches the session:
 * re-running from `a.originalTris` is what keeps the target indices valid.
 * @param {any} a @returns {any}
 */
function runAdjustCore(a) {
	const p = a.params;
	const origLen = a.originalTris.length;
	if (a.op === 'extrude' || a.op === 'inset') {
		// 99 K4 family 1: every scrub re-runs the kernel operator on a COPY of the op mesh captured at begin
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		if (a.op === 'inset')
			ops.insetExtended(om, a.target.triIndices, {
				amount: p.distance,
				depth: p.depth,
				individual: p.individual,
				units: a.target.units ?? null
			});
		else if (p.individual) ops.extrudeIndividual(om, a.target.triIndices, p.distance);
		else ops.extrudeRegion(om, a.target.triIndices, vec(a.target.normal), p.distance);
		const next = opMeshTris(om);
		// scale the cap (the original face tris, moved in place) around its
		// centroid — the VR stick's second axis. Same trap as the gizmo grab: a
		// plain .map drops the mi/uv that withSlot hangs off the triangle array,
		// so a live adjust used to strip the cap's texture. Skipped for
		// `individual` (the union centroid means nothing across pieces — and the
		// cap-scale stick is VR-only, which never sets individual).
		if ((p.capScale ?? 1) !== 1 && !p.individual) {
			const capCentroid =
				a.op === 'inset'
					? a.target.centroid.clone()
					: a.target.centroid.clone().add(a.target.normal.clone().multiplyScalar(p.distance));
			a.target.triIndices.forEach((/** @type {number} */ ti) => {
				next[ti] = withSlot(
					next[ti].map((/** @type {any} */ v) =>
						v.clone().sub(capCentroid).multiplyScalar(p.capScale).add(capCentroid)
					),
					next[ti].mi,
					next[ti].uv && next[ti].uv.map((/** @type {number[]} */ q) => [q[0], q[1]])
				);
			});
		}
		return {
			tris: next,
			// the kernel's partition = composeFaces(prior, appended walls) (the parity gate)
			faces: ops.opPartition(om, 'appearance'),
			// the element IDs of this output (same triangles, same order); a mirror drops them
			ids: ops.idChannels(om),
			select: { kind: 'cap', tris: [...a.target.triIndices] }
		};
	}
	if (a.op === 'bevel' && a.kind === 'faces') {
		const n = Math.max(1, Math.min(Math.round(p.segments) || 1, 8));
		// world units since P3 — no upper clamp, the per-step fraction conversion
		// saturates at 0.95 per component (the wrapper's rule)
		const total = Math.max(p.width, 0.001);
		// 99 K4 family 2: re-run on a copy of the op mesh captured at begin (the extrude/inset rule)
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		ops.bevelRegion(om, a.target.triIndices, vec(a.target.normal), {
			width: total,
			segments: n,
			profile: p.profile,
			direction: p.direction
		});
		return {
			tris: opMeshTris(om),
			faces: ops.opPartition(om, 'appearance'),
			ids: ops.idChannels(om),
			select: { kind: 'cap', tris: [...a.target.triIndices] },
			info: { segments: n }
		};
	}
	if (a.op === 'bevel' && a.kind === 'edges') {
		const wanted = Math.min(Math.max(Math.round(p.segments) || 1, 1), 8);
		// a bulge needs an interior ring to displace; a single flat segment has none
		const n = Math.abs(p.profile) > 1e-3 ? Math.max(wanted, 2) : wanted;
		// 99 K4 family 2: re-run on a copy of the op mesh captured at begin
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		const r = ops.bevelEdges(om, a.target, {
			width: p.width,
			segments: n,
			profile: p.profile
		});
		if (!r.done)
			return {
				error: r.refusedValence
					? 'Bevel needs a CORNER at each end of the edge — an end that runs straight on into a flat surface has nothing to fold into (pick the whole line, or a creased edge)'
					: 'Bevel needs an edge with a face on BOTH sides — a border edge has nothing to fold into'
			};
		return {
			tris: opMeshTris(om),
			faces: null, // the edge bevel derives (the wrapper's rule)
			ids: ops.idChannels(om),
			select: { kind: 'edgesCleared' },
			info: { done: r.done, refusedValence: r.refusedValence, refusedBorder: r.refusedBorder, segments: n }
		};
	}
	if (a.op === 'bevel' && a.kind === 'vertices') {
		const width = Math.max(p.width ?? 0.2, 1e-4);
		const profile = Math.min(Math.max(p.profile ?? 0, -1), 1);
		// 99 K4 family 2: re-run on a copy of the op mesh captured at begin; caps authored, the rest alone
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		const r = ops.bevelVertices(om, a.target, { width, profile, segments: p.segments });
		if (!r.done)
			return {
				error:
					'Nothing to bevel there: a vertex needs at least three faces around it (an open border needs a different tool)'
			};
		return {
			tris: opMeshTris(om),
			faces: ops.opPartition(om, 'appearance'),
			ids: ops.idChannels(om),
			select: { kind: 'vertsCleared' },
			info: { done: r.done, skipped: r.skipped }
		};
	}
	if (a.op === 'loopcut') {
		// P7b: axis 1 = the PERPENDICULAR ring, captured at begin. Both rings index
		// into originalTris, so either re-runs from the same snapshot; an empty alt
		// (a pole) falls back to the picked ring — the UI disables the toggle then.
		const ring = p.axis === 1 && a.altTarget?.length ? a.altTarget : a.target;
		// 99 K4 family 3: re-run on a copy of the op mesh captured at begin
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		// the base's key cells once per adjust, not per scrub (every scrub copies the same base)
		a.cells ??= ops.cellMap(a.opBase);
		const { firstNew } = ops.loopCutRegion(om, ring, a.quadPartner, {
			cuts: p.cuts,
			position: p.position,
			cells: a.cells
		});
		return {
			tris: opMeshTris(om),
			faces: ops.opPartition(om, 'appearance'),
			ids: ops.idChannels(om),
			select: { kind: 'band', firstNew, total: om.view.count }
		};
	}
	if (a.op === 'bridge') {
		// 99 K4 family 4: every scrub re-runs the kernel operator on a COPY of the op mesh captured at begin
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		const r = ops.bridgeRegions(om, a.target.setA, a.target.setB, { cuts: p.cuts, twist: p.twist, invert: p.invert });
		if ('error' in r) return { error: r.error };
		return { tris: opMeshTris(om), faces: ops.opPartition(om, 'appearance'), ids: ops.idChannels(om), select: { kind: 'cleared' } };
	}
	if (a.op === 'subdivide') {
		// P3 / 99 K4 family 6: the quad-aware split `levels` times on a COPY of the op mesh captured at begin
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		const r = ops.subdivideLevels(om, a.target.triIndices, a.quadPartner, p.levels);
		return {
			tris: opMeshTris(om),
			faces: ops.opPartition(om, 'appearance'),
			ids: ops.idChannels(om),
			// the new triangles are NOT one contiguous range (untouched survivors interleave), so the band rule
			// cannot describe them
			select: { kind: 'set', tris: r.newTris }
		};
	}
	if (a.op === 'edge-extrude') {
		const r = edgeExtrudeCore(a.originalTris, a.target, { distance: p.distance });
		if (!r.done)
			return {
				error:
					'Edge extrude needs a BORDER edge — every picked edge has a face on BOTH sides. Delete a face first to open the mesh, or extrude the face instead.'
			};
		return {
			tris: r.tris,
			// the strips arrive as consecutive pushQuad pairs after the untouched
			// input — the extrude/inset partition shape exactly
			faces: composeFaces(
				a.priorFaces,
				appendOrigin(origLen, r.tris.length),
				appendedQuads(origLen, r.tris.length)
			),
			select: { kind: 'edges', keys: r.newEdgeKeys },
			info: { done: r.done, refusedInterior: r.refusedInterior }
		};
	}
	if (a.op === 'edge-slide') {
		const r = edgeSlideCore(a.originalTris, a.priorFaces ?? [], a.target, { factor: p.factor });
		if (!r.moved)
			return {
				error:
					'Nothing to slide: no picked vertex has a single edge to run along on that side (a box corner has none — slide a loop that runs between quads)'
			};
		return {
			tris: r.tris,
			faces: a.priorFaces, // positions only — every face keeps its triangles
			select: { kind: 'edges', keys: r.newEdgeKeys },
			info: { moved: r.moved, poles: r.poles }
		};
	}
	if (a.op === 'solidify') {
		const ops = kernelOps();
		const om = ops.beginOp(ops.cloneOpMesh(a.opBase));
		const r = ops.solidifyRegion(om, a.target.triIndices, { thickness: p.thickness });
		if ('error' in r) return { error: r.error };
		return {
			tris: opMeshTris(om),
			faces: ops.opPartition(om, 'appearance'),
			ids: ops.idChannels(om),
			// append-only: the source selection's indices are untouched
			select: { kind: 'set', tris: [...a.target.triIndices] },
			info: { rim: r.rim }
		};
	}
	return { error: 'Unknown adjust operation' };
}

/** Full-quality apply of a run's output: the AUTHORED partition + an
 * unconditional broadcast. Returns the meshgeo `after` state.
 * @param {any} a @param {any} result */
function applyAdjustFull(a, result) {
	// 99 K2: the one commit, recording nothing — the engine records at its own moment
	// (at apply, or on the VR commit) and keeps the entry's `after` current in place
	const entry = /** @type {any} */ (
		commitMesh({
			uuid: a.uuid,
			apply: a.session ? 'session' : 'object',
			after: {
				positions: trisToPositions(result.tris),
				groups: trisToGroups(result.tris),
				uvs: trisToUVs(result.tris),
				...(result.ids ? { ids: result.ids } : {})
			},
			faces: result.faces,
			stampFaces: true,
			record: false,
			cap: false
		})
	);
	return entry.after;
}

/** The op's post-selection rule, copied from its one-shot wrapper. The gizmo
 * only re-seats when `seatGizmo` (apply/settle, never per scrub frame).
 * @param {any} a @param {any} select @param {boolean} seatGizmo */
function applyAdjustSelection(a, select, seatGizmo) {
	if (!select) return;
	if (select.kind === 'cap') {
		// E6: keep the CAP selected — its tri indices survive the op
		faceEditSelectedTris.set([...select.tris]);
		faceEditHighlight.set(faceIndexForTriangle(select.tris[0]));
		refreshFaceOverlay();
		// E7 (extrude/inset only, commitFaceOp parity): the gizmo comes back
		// seated on the new cap — never on arm, that's the B1 rule
		if (seatGizmo && (a.op === 'extrude' || a.op === 'inset') && typeof window !== 'undefined')
			attachFaceGizmo();
	} else if (select.kind === 'band') {
		// leave the NEW band selected: it is what you reach for next, and it
		// MOVES as the cut count is scrubbed — so it re-applies on every run
		/** @type {number[]} */
		const band = [];
		for (let ti = select.firstNew; ti < select.total; ti++) band.push(ti);
		faceEditSelectedTris.set(band);
		refreshFaceOverlay();
	} else if (select.kind === 'set') {
		// P3 subdivide: keep the SPLIT AREA selected (its new pieces) — the
		// commitFaceOp rule; unlike the band these indices are not contiguous
		faceEditSelectedTris.set([...select.tris]);
		refreshFaceOverlay();
	} else if (select.kind === 'edges') {
		// P5b edge extrude: the NEW outer edges are the selection — they MOVE as the
		// distance is scrubbed, so this re-applies on every run. Direct store writes,
		// never withSelectionHistory: its interruptOpAdjust would end this very
		// adjust. The edge gizmo re-seats at apply/settle only (the seatGizmo rule),
		// and only under the Move op — the session's B1 rule.
		edgeEditSelected.set(select.keys.filter((/** @type {string} */ k) => !!edgeEndpoints(k)));
		edgeEditHover.set('');
		refreshEdgeHighlight();
		if (seatGizmo && typeof window !== 'undefined' && get(faceEditOp) === 'move')
			attachFaceGizmo();
	} else if (select.kind === 'cleared') {
		faceEditSelectedTris.set([]);
		faceEditHighlight.set(-1);
		refreshFaceOverlay();
	} else if (select.kind === 'edgesCleared') {
		clearEdgeSelectionInner(); // the keys name vertices that no longer exist
		faceEditSelectedTris.set([]);
		faceEditHighlight.set(-1);
	} else if (select.kind === 'vertsCleared') {
		// the bevel replaced the corner, so stale handle indices mean nothing
		// (bevelSelectedVerts' rule); applyMeshGeo already rebuilt the handles
		vertexSelectionHistory?.apply([]);
	}
}

/** the wrappers' success toasts, fired at APPLY only (never on settle)
 * @param {any} a @param {any} result */
function adjustBeginToast(a, result) {
	if (a.op === 'loopcut') {
		const n = a.params.cuts;
		showToast(
			'Loop cut: ' + n + ' loop' + (n === 1 ? '' : 's') + ' across ' + a.target.length + ' quads'
		);
	} else if (a.op === 'bevel' && a.kind === 'faces' && result.info) {
		const n = result.info.segments;
		showToast('Bevelled the border in ' + n + ' segment' + (n === 1 ? '' : 's'));
	} else if (a.op === 'bevel' && a.kind === 'edges' && result.info) {
		const { done, refusedValence, refusedBorder, segments } = result.info;
		showToast(
			'Bevelled ' +
				done +
				(done === 1 ? ' edge' : ' edges') +
				' in ' +
				segments +
				(segments === 1 ? ' segment' : ' segments') +
				(refusedValence ? ' (' + refusedValence + ' skipped: an end runs straight on into a flat surface)' : '') +
				(refusedBorder ? ' (' + refusedBorder + ' skipped: border edge)' : '')
		);
	} else if (a.op === 'bevel' && a.kind === 'vertices' && result.info) {
		const { done, skipped } = result.info;
		showToast(
			'Bevelled ' +
				done +
				(done === 1 ? ' vertex' : ' vertices') +
				(skipped ? ' (' + skipped + ' skipped: open border)' : '')
		);
	} else if (a.op === 'edge-slide' && result.info) {
		const { moved, poles } = result.info;
		showToast(
			'Sliding ' +
				moved +
				(moved === 1 ? ' vertex' : ' vertices') +
				(poles ? ' (' + poles + ' held: no single rail on that side)' : '') +
				' — scrub the factor'
		);
	} else if (a.op === 'solidify' && result.info) {
		showToast(
			result.info.rim
				? 'Solidified — ' + result.info.rim + ' rim quads join the back to the front'
				: 'Solidified a closed selection — it is a hollow shell now (no border, so no rim)'
		);
	} else if (a.op === 'edge-extrude' && result.info) {
		const { done, refusedInterior } = result.info;
		showToast(
			'Extruded ' +
				done +
				(done === 1 ? ' edge' : ' edges') +
				(refusedInterior
					? ' (' + refusedInterior + ' skipped: interior edge — a face on both sides)'
					: '')
		);
	}
}

/** P7b: op-specific extras the UI reads off the state mirror — for loopcut,
 * whether a PERPENDICULAR ring exists at all (the axis toggle disables at a
 * pole). @param {any} a */
function adjustStateExtras(a) {
	return a.op === 'loopcut' ? { axisAlt: !!a.altTarget?.length } : {};
}

/**
 * Begin a live adjust: APPLY the op immediately (replicated + ONE history entry
 * recorded at apply, kept on the adjust so settle can update it in place), then
 * leave the engine live for `reapplyOpAdjust` scrubs.
 *
 * @param {'extrude'|'inset'|'bevel'|'loopcut'|'bridge'|'subdivide'|'edge-extrude'|'edge-slide'|'solidify'} op
 * @param {any} params op parameters (distance / width+segments+profile / cuts / levels)
 * @param {{target?: any, record?: 'deferred', kind?: 'faces'|'edges'|'vertices',
 *   uuid?: string, vertexKeys?: string[]}} [opts] `target` = a pre-resolved face
 *   (VR); `record: 'deferred'` skips the history entry (VR commits explicitly —
 *   the ONE engine knob VR keeps); `kind` picks the bevel flavor; `uuid` +
 *   `vertexKeys` drive the session-free VERTEX bevel (from meshEdit).
 * @returns {boolean} false on a precondition failure (the popup shows a hint)
 */
export function beginOpAdjust(op, params, opts = {}) {
	interruptOpAdjust(); // a new adjust always replaces the previous one
	if (FS.grab) return false; // never start under a live grab gesture
	const kind =
		op === 'bevel' ? (opts.kind ?? (get(faceEditSubmode) === 'edges' ? 'edges' : 'faces')) : undefined;
	const session = kind !== 'vertices';
	if (session && !FS.object) return false;
	/** @type {any} */
	const a = {
		op,
		kind,
		session,
		record: opts.record,
		entry: null,
		installedGeometry: null,
		lastFaces: null,
		lastSelect: null,
		after: null,
		capWarned: false
	};
	// resolve the object, the ORIGINAL snapshot, and the op TARGET — indices
	// into originalTris, NEVER stale, because every re-run starts from it
	if (session) {
		a.uuid = FS.object.uuid;
		a.originalTris = cloneTris(FS.workingTris);
		a.priorFaces = currentPartition();
	} else {
		const object = lookupEditable(opts.uuid ?? '');
		if (!object?.geometry?.attributes?.position) return false;
		a.uuid = opts.uuid;
		a.originalTris = readTriangles(object.geometry);
		a.priorFaces = null; // the vertex bevel composes a fresh partition
	}
	if (op === 'extrude' || op === 'inset') {
		const face = opts.target ?? opTargetFace();
		if (!face?.triIndices?.length) return false;
		// 99 K4: the op mesh every re-run copies (captured BEFORE anything changes the session)
		const base = sessionOpMesh();
		if (!base) {
			showToast(KERNEL_LOADING);
			return false;
		}
		a.opBase = base;
		if (op === 'extrude' && !editSession.ops.regionHasBorder(base, face.triIndices)) {
			showToast(
				'Nothing to extrude from: the selection is a CLOSED surface, so it has no border. Select fewer faces, or use Move/Scale to reposition it.'
			);
			return false;
		}
		a.target = {
			triIndices: [...face.triIndices],
			normal: face.normal.clone(),
			centroid: face.centroid.clone()
		};
		// P3: the granularity units the selection was built from, for inset's
		// Individual mode — captured HERE because the pure core cannot read the
		// session (a VR pre-resolved target has none; insetFaceEx falls back to
		// connected components)
		if (op === 'inset' && !opts.target) a.target.units = selectionUnits(a.target.triIndices);
	} else if (op === 'bevel' && kind === 'faces') {
		const face = opTargetFace();
		if (!face?.triIndices?.length) {
			showToast('Select a face first, then Bevel');
			return false;
		}
		// 99 K4 family 2: the op mesh every re-run copies
		const base = sessionOpMesh();
		if (!base) {
			showToast(KERNEL_LOADING);
			return false;
		}
		a.opBase = base;
		if (!editSession.ops.regionHasBorder(base, face.triIndices)) {
			showToast(CLOSED_BEVEL);
			return false;
		}
		a.target = {
			triIndices: [...face.triIndices],
			normal: face.normal.clone(),
			centroid: face.centroid.clone()
		};
	} else if (op === 'bevel' && kind === 'edges') {
		const selected = get(edgeEditSelected);
		if (!selected.length) {
			showToast('Pick an edge first, then Bevel');
			return false;
		}
		// 99 K4 family 2: the op mesh every re-run copies
		const base = sessionOpMesh();
		if (!base) {
			showToast(KERNEL_LOADING);
			return false;
		}
		a.opBase = base;
		a.target = [...selected];
	} else if (op === 'bevel' && kind === 'vertices') {
		if (!opts.vertexKeys?.length) return false;
		const ops = editSession.ops;
		const geometry = lookupEditable(a.uuid)?.geometry;
		if (!ops || !geometry) {
			if (!ops) showToast(KERNEL_LOADING);
			return false;
		}
		// 99 K4 family 2: the held op mesh of the object's geometry (the vertex bevel's own path)
		a.opBase = heldOpMesh(ops, geometry, () => partitionOfGeometry(geometry, a.originalTris), OBJECT_PARTNER);
		a.target = [...opts.vertexKeys];
	} else if (op === 'loopcut') {
		// P7b: capture BOTH rings — the axis toggle re-runs across the other one,
		// and the walk must happen NOW, while the module state matches originalTris
		const pair = loopCutRingPair();
		if (!pair.pick.length) return false;
		// 99 K4 family 3: the op mesh every re-run copies
		const base = sessionOpMesh();
		if (!base) {
			showToast(KERNEL_LOADING);
			return false;
		}
		a.opBase = base;
		a.target = pair.pick;
		a.altTarget = pair.alt;
		// the pairing that matches originalTris — rebuildFaces REPLACES the module
		// array after the apply, so holding this reference stays correct
		a.quadPartner = FS.quadPartner;
	} else if (op === 'subdivide') {
		// P3: the target is the picked tri set; the pairing rides along exactly
		// like loopcut's (subdivideLevels is quad-aware through it)
		const face = opts.target ?? opTargetFace();
		if (!face?.triIndices?.length) return false;
		a.target = { triIndices: [...face.triIndices] };
		a.quadPartner = FS.quadPartner;
		if (!(a.opBase = sessionOpMesh())) return kernelLoadingRefusal();
	} else if (op === 'bridge') {
		const sel = get(faceEditSelectedTris).filter((/** @type {number} */ ti) => FS.workingTris[ti]);
		if (!sel.length) {
			showToast('Multi-select two faces first (Multi on, click both)');
			return false;
		}
		const parts = componentsOfTris(FS.workingTris, sel);
		if (parts.length !== 2) {
			showToast(
				parts.length < 2
					? 'Bridge needs TWO separate pieces — the selected faces touch each other'
					: 'Bridge needs exactly TWO pieces (' + parts.length + ' separate pieces selected)'
			);
			return false;
		}
		a.target = { setA: parts[0], setB: parts[1] };
		if (!(a.opBase = sessionOpMesh())) return kernelLoadingRefusal();
	} else if (op === 'edge-extrude') {
		// P5b: the picked edge KEYS are the target; the core sorts border from
		// interior itself (and the run refuses when nothing extrudable remains)
		const selected = get(edgeEditSelected).filter((/** @type {string} */ k) => !!edgeEndpoints(k));
		if (!selected.length) {
			showToast('Pick an edge first, then Extrude');
			return false;
		}
		a.target = selected;
	} else if (op === 'edge-slide') {
		// P6: the picked edge KEYS; the rails are walked by the core on originalTris
		const selected = get(edgeEditSelected).filter((/** @type {string} */ k) => !!edgeEndpoints(k));
		if (!selected.length) {
			showToast('Pick an edge (a loop works best), then Slide');
			return false;
		}
		a.target = selected;
	} else if (op === 'solidify') {
		const face = opTargetFace();
		if (!face?.triIndices?.length) {
			showToast('Select a face first, then Solidify');
			return false;
		}
		a.target = { triIndices: [...face.triIndices] };
		if (!(a.opBase = sessionOpMesh())) return kernelLoadingRefusal();
	} else return false;
	mergeAdjustParams(a, params ?? {});
	// the before-triple + stored topology + the selection ✕ restores
	const liveGeometry = liveObjectOf(a)?.geometry;
	a.before = {
		positions: trisToPositions(a.originalTris),
		groups: trisToGroups(a.originalTris),
		uvs: trisToUVs(a.originalTris),
		faces: readStoredFaces(liveGeometry),
		...(a.opBase ? { ids: editSession.ops.idChannels(a.opBase) } : {})
	};
	a.selectionBefore = {
		faces: [...get(faceEditSelectedTris)],
		highlight: get(faceEditHighlight),
		edges: [...get(edgeEditSelected)],
		verts: vertexSelectionHistory?.snapshot()?.sel ?? null
	};
	// run the pure core + apply
	const result = mirrorAdjustResult(a, runAdjustCore(a));
	if (result.error) {
		showToast(result.error);
		return false;
	}
	const positions = trisToPositions(result.tris);
	if (positions.length > MAX_SNAPSHOT) {
		showToast(tooLargeMessage(positions.length, 'edit'));
		return false;
	}
	// clear stale picks BEFORE the swap (applyGeometrySnapshot rebuilds the
	// overlay from them) + the hover always — desktop has no pointermove path,
	// so it would hold the pre-op triangle forever
	faceEditHoverTri.set(-1);
	if (op === 'loopcut' || op === 'bridge' || op === 'subdivide') {
		// these rebuild the topology — the pre-op indices address the NEW array
		faceEditSelectedTris.set([]);
		faceEditHighlight.set(-1);
	}
	if (op === 'edge-slide') edgeEditSelected.set([]); // re-keyed by the 'edges' select rule
	if (op === 'bevel' && kind === 'edges') {
		clearEdgeSelectionInner();
		faceEditSelectedTris.set([]);
		faceEditHighlight.set(-1);
	}
	a.lastFaces = result.faces;
	a.lastIds = result.ids ?? null;
	a.lastSelect = result.select;
	a.after = applyAdjustFull(a, result);
	applyAdjustSelection(a, result.select, true);
	adjustBeginToast(a, result);
	// recording AT APPLY is what makes Ctrl+Z work at any moment with zero
	// special cases; a 'deferred' (VR) begin records on its explicit commit
	if (opts.record !== 'deferred') {
		a.entry = recordMeshGeo(a.uuid, a.before, a.after);
		// 99 K4: the entry's undo brings back the pick the adjust started from
		/** @type {any} */ (a.entry).selection = { before: { uuid: a.uuid, ...a.selectionBefore }, after: null };
	}
	a.installedGeometry = liveObjectOf(a)?.geometry ?? null;
	FS.adjust = a;
	opAdjustState.set({ op, params: { ...a.params }, ...adjustStateExtras(a) });
	return true;
}

/**
 * Re-run the live adjust at merged params — every scrub move. IDENTITY GUARD
 * first: `geometry !== installedGeometry` means an undo / remote meshgeo /
 * another op swapped the geometry out from under the adjust, so it is dropped
 * silently (the rebuildSculptCaches identity-check shape). The entry stays.
 * @param {any} [patch] partial params @returns {boolean}
 */
export function reapplyOpAdjust(patch = {}) {
	const a = FS.adjust;
	if (!a) return false;
	const object = liveObjectOf(a);
	if (!object || object.geometry !== a.installedGeometry) {
		endOpAdjust();
		return false;
	}
	mergeAdjustParams(a, patch);
	const result = mirrorAdjustResult(a, runAdjustCore(a));
	if (result.error) return false; // keep the last good geometry on a refusal
	const positions = trisToPositions(result.tris);
	if (positions.length > MAX_SNAPSHOT) {
		if (!a.capWarned) {
			a.capWarned = true;
			showToast(tooLargeMessage(positions.length, 'edit'));
		}
		return false;
	}
	a.lastFaces = result.faces;
	a.lastIds = result.ids ?? null;
	a.lastSelect = result.select;
	if (a.session) {
		FS.workingTris = result.tris;
		liveGeometryUpdate(); // topology carry + the ~5/s broadcast throttle built in
	} else {
		const groups = trisToGroups(result.tris);
		const uvs = trisToUVs(result.tris);
		applyMeshGeo(a.uuid, positions, groups, uvs);
		const now = Date.now();
		if (now - lastFaceBroadcast > 200) {
			lastFaceBroadcast = now;
			broadcastMeshGeo(a.uuid, positions, groups, uvs);
		}
	}
	applyAdjustSelection(a, result.select, false);
	a.installedGeometry = liveObjectOf(a)?.geometry ?? null;
	opAdjustState.set({ op: a.op, params: { ...a.params }, ...adjustStateExtras(a) });
	return true;
}

/**
 * Settle the live adjust — scrub END (DragRow onscrubend) or the 300ms typed-
 * input debounce: a full applyGeometrySnapshot with the AUTHORED partition (the
 * live path only carries), an UNCONDITIONAL broadcast (the throttle may have
 * eaten the last preview), the post-selection re-applied, and the history
 * entry's `after` MUTATED IN PLACE — one entry, always current. The adjust
 * stays live for further scrubs. @returns {boolean}
 */
export function settleOpAdjust() {
	const a = FS.adjust;
	if (!a) return false;
	const object = liveObjectOf(a);
	if (!object || object.geometry !== a.installedGeometry) {
		endOpAdjust();
		return false;
	}
	const result = {
		tris: a.session ? FS.workingTris : readTriangles(object.geometry),
		faces: a.lastFaces,
		ids: a.lastIds ?? null
	};
	a.after = applyAdjustFull(a, result);
	applyAdjustSelection(a, a.lastSelect, true);
	if (a.entry) a.entry.after = a.after;
	a.installedGeometry = liveObjectOf(a)?.geometry ?? null;
	return true;
}

/** Restore the pre-op geometry + selection (the ✕ path and the VR cancel).
 * @returns {boolean} false when the geometry was already swapped from under us */
function restoreAdjustBefore() {
	const a = FS.adjust;
	if (!a) return false;
	const object = liveObjectOf(a);
	if (!object || object.geometry !== a.installedGeometry) return false;
	const { positions, groups, uvs, faces: beforeFaces } = a.before;
	if (a.session) {
		applyGeometrySnapshot(positions, groups, uvs, beforeFaces ?? null);
	} else {
		const packed = beforeFaces?.length ? packFaces(beforeFaces) : null;
		applyMeshGeo(a.uuid, positions, groups, uvs, packed?.faceCounts, packed?.faceTris);
	}
	// the op's own broadcasts already replicated the edit — the restore has to
	// replicate too, or peers keep the last preview
	broadcastMeshGeo(a.uuid, positions, groups, uvs);
	// the restored geometry is byte-identical to pre-op, so the captured
	// selection indices/keys are valid again
	const sel = a.selectionBefore;
	restoreCapturedSelection({ ...sel, faces: a.session ? sel.faces : null }, a.uuid);
	return true;
}

/**
 * The panel ✕: restore the before-triple (replicated), restore the selection,
 * and RETRACT the adjust's history entry — the restore already replicated, so
 * the retraction touches no wire; a no-op when the entry was already undone or
 * evicted. @returns {boolean}
 */
export function cancelOpAdjust() {
	const a = FS.adjust;
	if (!a) return false;
	const restored = restoreAdjustBefore();
	if (restored && a.entry) retractEntry(a.entry);
	endOpAdjust();
	return restored;
}

/** Clear the engine state + the store mirror. The history entry STAYS — it was
 * recorded at apply and describes a real edit. Called from every path that
 * makes the adjust meaningless: a new begin, one-shot ops, grabs, the knife,
 * picks (withSelectionHistory), mode switches, session exits, and the
 * identity guard. */
export function endOpAdjust() {
	if (!FS.adjust) return;
	FS.adjust = null;
	opAdjustState.set(null);
}

/** An INTERRUPTION (a pick, another op, a grab, a mode switch) ends the adjust
 * — but a DEFERRED (VR) adjust has no history entry yet, so its applied
 * preview must be REVERTED first or the geometry is stranded unrecorded (the
 * old VR code's exit rule). A recorded desktop adjust just ends: its entry was
 * written at apply. `restoreAdjustBefore` self-guards on geometry identity, so
 * a stale deferred adjust never restores over someone else's swap. */
function interruptOpAdjust() {
	if (!FS.adjust) return;
	if (FS.adjust.record === 'deferred') restoreAdjustBefore();
	endOpAdjust();
}

// ---- VR consumer (122/212/192 contracts preserved) --------------------------

/**
 * Begin a live extrude/inset adjust (VR trigger): applies the op at a default
 * amount immediately (visible), then depth/scale sticks reshape it until a
 * second trigger commits. 212: accepts the synthesized op target OR a
 * face-group index (number, back-compat). Deferred recording — VR records on
 * its explicit commit, so a cancelled adjust never touched history.
 * @param {any} faceOrIndex @param {'extrude'|'inset'} op @param {number} defaultAmount
 */
export function beginFaceAdjust(faceOrIndex, op, defaultAmount) {
	const face = typeof faceOrIndex === 'number' ? FS.faces[faceOrIndex] : faceOrIndex;
	if (!FS.object || !face || !face.triIndices?.length || FS.grab) return false;
	return beginOpAdjust(op, { distance: defaultAmount }, { target: face, record: 'deferred' });
}

/** Stick reshapes the pending adjust @param {number} dAmount depth @param {number} dScale cap scale */
export function adjustFaceGesture(dAmount, dScale) {
	const a = FS.adjust;
	if (!a) return;
	/** @type {any} */
	const patch = {};
	if (dAmount) patch.distance = (a.params.distance ?? 0) + dAmount;
	if (dScale) patch.capScale = (a.params.capScale ?? 1) + dScale;
	reapplyOpAdjust(patch);
}

/** the live adjust's distance, or null (192 test hook) */
export function faceAdjustAmount() {
	return FS.adjust ? (FS.adjust.params.distance ?? null) : null;
}

/** Second trigger: commit the pending adjust — settle, record (deferred), end. */
export function commitFaceAdjust() {
	const a = FS.adjust;
	if (!a || !FS.object) return false;
	if (!settleOpAdjust()) return false;
	if (a.record === 'deferred')
		/** @type {any} */ (recordMeshGeo(a.uuid, a.before, a.after)).selection = {
			before: { uuid: a.uuid, ...a.selectionBefore },
			after: null
		};
	endOpAdjust();
	return true;
}

/** Back/hub reverts a pending adjust to the pre-op geometry (no retraction —
 * a deferred adjust never recorded an entry in the first place). */
export function cancelFaceAdjust() {
	if (!FS.adjust) return;
	cancelOpAdjust();
}

// undo/redo replays meshgeo snapshots through the same apply + broadcast path
registerHistoryKind('meshgeo', (entry, state) => {
	// 15-G / M1: a topology op stores {positions, groups, uvs} so a multi-material
	// TEXTURED mesh keeps its slots and mapping through undo/redo; every other
	// producer (sculpt strokes, vertex drags, VR grabs) still stores a bare
	// positions array, and their uvs ride the previous-attribute carry-over
	const positions = state?.positions ?? state;
	const groups = state?.positions ? state.groups : undefined;
	const uvs = state?.positions ? state.uvs : undefined;
	const colors = state?.positions ? state.colors : undefined; // mcp-shapes
	// P9: topology travels INSIDE the state object (A5), and only for producers that
	// authored one. Packed here so the replay and the re-broadcast agree byte for byte
	// (99 K2: history keeps it packed already — `faceCounts`/`faceTris` — or as `faces`).
	const packed = stateFaceFields(state);
	// 99 K4: an operator's entry carries the pick it started from: its undo puts that pick back, and keeps
	// the pick live at that moment (the op's own, or what the user made of it) for the redo
	const sel = entry.selection;
	const undoing = state === entry.before;
	if (sel && undoing) sel.after = captureSelection(entry.uuid);
	applyMeshGeo(entry.uuid, positions, groups, uvs, packed?.faceCounts, packed?.faceTris, colors);
	// 99 K4: an undo / redo of a kernel op's step brings its element IDs back with it
	if (state?.ids) noteGeometryIds(entry.uuid, state.ids);
	if (sel) restoreCapturedSelection(undoing ? sel.before : sel.after, entry.uuid);
	// the one meshgeo sender; the topology is the STATE's, never the object's carry-over
	sendMeshGeo(entry.uuid, positions, { groups, uvs, colors, faceFields: packed });
	return true;
});

// ---- 85 G5: the face operators WITHOUT a session (the agent's edit_mesh) ------------------
//
// commitFaceOp / bevelFaces read the live face session (workingTris, the selection, the
// granularity). An agent has no session and must not open one (it would lock the object and
// draw overlays on the agent page), so these two read the object's own geometry, run the SAME
// pure cores and commit through commitMeshGeoTriple — the meshgeo message + history kind every
// face op already uses. One commit per op; the caller's history batch makes a call one undo step.

/**
 * The face partition an operator would see on `geometry` (stored, else derived from the quad
 * pairing — the default 'quad' granularity's units) and its triangles.
 * @param {any} geometry @returns {{tris: any[], partition: number[][]}}
 */
export function facePartitionOf(geometry) {
	const tris = readTriangles(geometry);
	const partition = readStoredFaces(geometry) ?? derivePartition(tris, storedPartner(geometry, tris.length) ?? pairQuads(tris));
	return { tris, partition };
}

/** the face ops faceOpOnObject runs */
export const OBJECT_FACE_OPS = /** @type {const} */ (['extrude', 'inset', 'move', 'bevel', 'subdivide', 'delete', 'flip']);

/**
 * Run one face operator on an object's triangles `triIndices` (one region, like a multi-select).
 * @param {string} uuid
 * @param {string} op one of OBJECT_FACE_OPS
 * @param {number[]} triIndices
 * @param {{amount?: number, width?: number, segments?: number, profile?: number, direction?: 'out'|'in'}} [options]
 * @returns {{ok: true, triangles: number, kept: number[] | null} | {ok: false, error: string}}
 *   `kept` = the triangles still selected afterwards (the extruded cap, the inset's inner face — the
 *   ops that move the picked triangles in place and APPEND the rest), null where the op reshapes them
 */
export function faceOpOnObject(uuid, op, triIndices, options = {}) {
	interruptOpAdjust();
	const object = lookupEditable(uuid);
	if (!object?.geometry?.attributes?.position) return { ok: false, error: 'not a mesh' };
	const { tris, partition } = facePartitionOf(object.geometry);
	const picked = [...new Set(triIndices)].filter((ti) => Number.isInteger(ti) && tris[ti]);
	if (!picked.length) return { ok: false, error: 'no faces selected' };
	const normal = new THREE.Vector3();
	const centroid = new THREE.Vector3();
	for (const ti of picked) {
		normal.add(triNormal(tris[ti]));
		tris[ti].forEach((/** @type {any} */ v) => centroid.add(v));
	}
	if (normal.lengthSq() < 1e-9) normal.copy(triNormal(tris[picked[0]]));
	const face = { triIndices: picked, normal: normal.normalize(), centroid: centroid.divideScalar(picked.length * 3) };
	const amount = Number.isFinite(options.amount) ? Number(options.amount) : 0.3;
	// 99 K4 family 1: extrude / inset / move on the kernel, IDs carried
	if (op === 'extrude' || op === 'inset' || op === 'move') return kernelOpOnObject(uuid, object, op, face, partition, tris, amount);
	// 99 K4 family 2: the face bevel too (the cap keeps its indices)
	if (op === 'bevel')
		return kernelOpOnObject(uuid, object, op, face, partition, tris, {
			width: Math.max(Number(options.width ?? 0.15) || 0.15, 0.001),
			segments: Math.max(1, Math.min(Math.round(Number(options.segments ?? 1)) || 1, 8)),
			profile: Math.min(Math.max(Number(options.profile ?? 1), -1), 1),
			direction: options.direction === 'in' ? 'in' : 'out'
		});
	/** @type {any[]} */
	let next;
	/** @type {number[][] | null} */
	let nextFaces;
	if (op === 'subdivide') {
		// 99 K4 family 6: on the kernel, IDs carried
		const partner = storedPartner(object.geometry, tris.length) ?? pairQuads(tris);
		const r = objectKernelCommit(uuid, object, () => partition, tris, (ops, om) => ops.subdivideUnits(om, picked, partner));
		return r && !('error' in r) ? { ok: true, triangles: r.count, kept: null } : { ok: false, error: r?.error ?? 'the edit could not be committed' };
	} else if (op === 'delete') {
		if (picked.length >= tris.length) return { ok: false, error: 'delete: that would remove every face of the mesh' };
		// 99 K4 family 5: on the kernel, IDs carried
		const r = objectKernelCommit(uuid, object, () => partition, tris, (ops, om) => ops.deleteTriangles(om, picked));
		return r && !('error' in r) ? { ok: true, triangles: tris.length - picked.length, kept: null } : { ok: false, error: r?.error ?? 'the edit could not be committed' };
	} else if (op === 'flip') {
		next = flipFaceNormals(tris, picked);
		nextFaces = partition;
	} else return { ok: false, error: 'unknown face op "' + op + '"' };
	const before = { positions: trisToPositions(tris), groups: trisToGroups(tris), uvs: trisToUVs(tris), faces: readStoredFaces(object.geometry) };
	const after = { positions: trisToPositions(next), groups: trisToGroups(next), uvs: trisToUVs(next), faces: nextFaces };
	if (after.positions.length > MAX_SNAPSHOT) return { ok: false, error: tooLargeMessage(after.positions.length, 'edit') };
	if (!commitMeshGeoTriple(uuid, before, after)) return { ok: false, error: 'the edit could not be committed' };
	return { ok: true, triangles: next.length, kept: KEEPS_SELECTION.has(op) ? picked : null };
}

/**
 * 99 K4: faceOpOnObject's extrude / inset / move / bevel — the session's kernel operators on an op mesh of the
 * object's own geometry (built with the IDs it was applied with when known), committed with its IDs.
 * @param {string} uuid @param {any} object @param {'extrude'|'inset'|'move'|'bevel'} op @param {any} face
 * @param {number[][]} partition @param {any[]} tris @param {any} amount the distance / inset fraction, or the bevel's options @returns {any}
 */
function kernelOpOnObject(uuid, object, op, face, partition, tris, amount) {
	const ops = editSession.ops;
	if (!ops) return { ok: false, error: KERNEL_LOADING };
	const geometry = object.geometry;
	const om = heldOpMesh(ops, geometry, () => partition, OBJECT_PARTNER);
	if ((op === 'extrude' || op === 'bevel') && !ops.regionHasBorder(om, face.triIndices))
		return { ok: false, error: op + ': the selection is a CLOSED surface (no border) — select fewer faces' };
	const before = {
		positions: trisToPositions(tris),
		groups: trisToGroups(tris),
		uvs: trisToUVs(tris),
		faces: readStoredFaces(geometry),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let out;
	try {
		runKernelFaceOp(ops, om, op, face, op === 'inset' ? Math.min(Math.max(amount, 0.01), 0.95) : amount);
		out = ops.opOutput(om, { order: op === 'move' ? 'stored' : 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place: re-kept only by a commit
	}
	if (out.positions.length > MAX_SNAPSHOT) return { ok: false, error: tooLargeMessage(out.positions.length, 'edit') };
	const after = { positions: out.positions, groups: out.groups, uvs: out.uvs, faces: out.faces, ids: out.ids };
	if (!commitMeshGeoTriple(uuid, before, after)) return { ok: false, error: 'the edit could not be committed' };
	keepOpMesh(uuid, om, out, OBJECT_PARTNER);
	return { ok: true, triangles: out.positions.length / 9, kept: face.triIndices };
}

/**
 * 99 K4 (99-ops-b): run a kernel operator on an object's own geometry — no face session: the vertex-mode operators
 * and the agent's face ops — and commit it through commitMeshGeoTriple with its ID channels, keeping the op mesh for
 * the next operator. `run(ops, om)` edits the op mesh and returns its result, or `{error}` to refuse (nothing
 * committed). `faces` replaces the stored partition the op mesh grouped (the op mesh is then not kept).
 * @param {string} uuid @param {any} object @param {() => number[][] | null} partition the editor's partition
 * @param {any[]} tris the object's triangles @param {(ops: any, om: any) => any} run
 * @param {{ order?: 'appearance' | 'stored', op?: boolean, faces?: (count: number) => number[][], explicitBefore?: boolean }} [options]
 *   op = an operator's commit (the live-symmetry boundary, commitMeshGeoTriple); explicitBefore = the before state
 *   names the partition the op READ when none is stored (commitVertexOp's rule: an absent `faces` would let the
 *   undo carry the op's own partition whenever the triangle count matches)
 * @returns {any} the operator's result, or `{error}` (refused / still loading / not committed)
 */
function objectKernelCommit(uuid, object, partition, tris, run, options = {}) {
	const ops = editSession.ops;
	if (!ops) return { error: KERNEL_LOADING };
	const geometry = object.geometry;
	const pick = captureSelection(uuid);
	const om = heldOpMesh(ops, geometry, partition, OBJECT_PARTNER);
	const before = {
		positions: trisToPositions(tris),
		groups: trisToGroups(tris),
		uvs: trisToUVs(tris),
		faces: readStoredFaces(geometry) ?? (options.explicitBefore ? partition() : null),
		ids: ops.idChannels(om)
	};
	/** @type {any} */
	let result;
	/** @type {any} */
	let out;
	try {
		result = run(ops, om);
		if (result && 'error' in result) return result;
		out = ops.opOutput(om, { order: options.order ?? 'appearance' });
	} finally {
		editSession.opMesh = null; // edited in place: re-kept only by the commit below
	}
	if (out.positions.length > MAX_SNAPSHOT) return { error: tooLargeMessage(out.positions.length, 'edit') };
	const faces = options.faces ? options.faces(out.positions.length / 9) : out.faces;
	const after = { positions: out.positions, groups: out.groups, uvs: out.uvs, faces, ids: out.ids };
	if (!commitMeshGeoTriple(uuid, before, after, !!options.op, pick)) return { error: 'the edit could not be committed' };
	if (faces === out.faces) keepOpMesh(uuid, om, out, OBJECT_PARTNER);
	return result;
}

/** the face ops whose picked triangles survive at the same indices (moved in place; new ones appended) */
const KEEPS_SELECTION = new Set(['extrude', 'inset', 'move', 'flip']);
