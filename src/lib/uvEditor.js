import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry } from './history';
// UV1: read-only reuse of the mesh snapshot pipeline. faceEdit owns the triangle
// <-> geometry conversion AND the 'meshgeo' history kind (which already accepts a
// {positions, groups, uvs} triple and re-broadcasts uvs on undo), so a UV commit
// needs NO new wire type, NO new history kind, and NOT ONE line changed in
// faceEdit.js — which matters because the mesh-hardening lane is rewriting it in
// parallel.
import {
	readTriangles,
	trisToPositions,
	trisToGroups,
	trisToUVs,
	applyMeshGeo,
	triangleCount
} from './faceEdit';

// UV editor core (UV1). The editor is a 2D view of a mesh's `uv` attribute: the
// texture underneath, the UV triangles of ONE material slot on top, and draggable
// vertices. Editing UVs is a GEOMETRY edit as far as the app is concerned — there
// is no standalone uv channel — so a finished drag commits a full geometry
// snapshot through the existing meshgeo path: replicated, undoable, persisted.
//
// Everything here is math + stores; the component owns the canvas and the pointer
// gestures. No top-level DOM access (this module is imported during SSR prerender).

/** hard ceiling on a snapshot message (floats) — mirrors faceEdit's MAX_SNAPSHOT,
 * which is module-private there. ~5k tris. */
const MAX_SNAPSHOT = 45000;

/** quantization for "these two UV corners are the same point" (~1e-5) */
const UV_EPSILON = 1e-5;

/** which material slot the editor is showing @type {import('svelte/store').Writable<number>} */
export const uvActiveSlot = writable(0);
/** the active selection tool: 'select' (pointer) | 'box' | 'lasso'. UV3 adds
 * 'paint'. @type {import('svelte/store').Writable<string>} */
export const uvTool = writable('select');
/** UV3 brush @type {import('svelte/store').Writable<string>} */
export const uvBrushColor = writable('#ff3b30');
/** UV3 brush @type {import('svelte/store').Writable<number>} */
export const uvBrushSize = writable(24);

/** materials as an array, whatever the object wears (a mesh may carry ONE
 * material or an array of slots) @param {any} object */
export function materialsOf(object) {
	const material = object?.material;
	if (!material) return [];
	return Array.isArray(material) ? material : [material];
}

/**
 * Can this object be UV-edited? Needs a uv attribute to edit and has to fit in
 * one snapshot message (the commit swaps the WHOLE geometry).
 * @param {any} object @returns {{ok: boolean, reason: string}}
 */
export function uvEditable(object) {
	if (!object?.geometry?.attributes?.position) return { ok: false, reason: 'Select a mesh to edit its UVs.' };
	if (!object.geometry.attributes.uv)
		return { ok: false, reason: 'This mesh has no texture coordinates to edit.' };
	if (triangleCount(object) * 9 > MAX_SNAPSHOT)
		return { ok: false, reason: 'This mesh is too large to UV-edit (its edits could not sync).' };
	return { ok: true, reason: '' };
}

/**
 * The UV triangles to draw, as flat screen-agnostic data: one entry per triangle
 * of the requested material slot, each carrying its three [u,v] corners AND the
 * uv-attribute INDICES those corners live at (so a drag can write them back).
 * Reads through `geometry.index` when the mesh is indexed.
 *
 * `geometry.groups` only MEAN a material slot when the object actually wears a
 * material ARRAY — three ignores groups entirely for a single material, and a
 * plain BoxGeometry ships six groups (materialIndex 0..5) so that a cube CAN be
 * six-material. Filtering an ordinary textured box by materialIndex therefore
 * hid ten of its twelve triangles. Same test as `preserveMaterialGroups`.
 * @param {any} object @param {number} slot
 * @returns {{corners: number[][], indices: number[]}[]}
 */
export function uvTriangles(object, slot) {
	const geometry = object?.geometry;
	const uv = geometry?.attributes?.uv;
	if (!uv) return [];
	const index = geometry.index;
	const count = index ? index.count : uv.count;
	const perSlot = Array.isArray(object.material) && object.material.length >= 2;
	const slotAt = perSlot ? slotRanges(geometry.groups, count) : () => 0;
	/** @type {{corners: number[][], indices: number[]}[]} */
	const out = [];
	for (let i = 0; i < count; i += 3) {
		if (slotAt(i) !== slot) continue;
		const indices = [0, 1, 2].map((o) => (index ? index.getX(i + o) : i + o));
		out.push({ corners: indices.map((j) => [uv.getX(j), uv.getY(j)]), indices });
	}
	return out;
}

/** element index -> material slot (0 for an ungrouped geometry). Same shape as
 * faceEdit's private slotLookup. @param {any[]} groups @param {number} count */
function slotRanges(groups, count) {
	if (!groups?.length) return () => 0;
	const slots = new Int32Array(count);
	for (const group of groups) {
		const start = Math.max(group.start | 0, 0);
		const end = Math.min(start + (group.count | 0), count);
		for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
	}
	return (/** @type {number} */ i) => slots[i] || 0;
}

/** how many material slots the editor should list @param {any} object */
export function slotCount(object) {
	const materials = materialsOf(object);
	return Math.max(materials.length, 1);
}

/**
 * Every uv-attribute index sitting at the SAME uv coordinate as `uvIndex`.
 * Dragging moves the whole welded cluster — that is what every 3D package does,
 * and a non-indexed mesh (OBJ imports, and anything that has been through a mesh
 * op) stores each corner separately, so moving one index alone would tear the
 * mapping apart.
 * @param {any} geometry @param {number} uvIndex @returns {number[]}
 */
export function weldedCluster(geometry, uvIndex) {
	const uv = geometry?.attributes?.uv;
	if (!uv || uvIndex < 0 || uvIndex >= uv.count) return [];
	const u = uv.getX(uvIndex);
	const v = uv.getY(uvIndex);
	/** @type {number[]} */
	const cluster = [];
	for (let i = 0; i < uv.count; i++)
		if (Math.abs(uv.getX(i) - u) <= UV_EPSILON && Math.abs(uv.getY(i) - v) <= UV_EPSILON)
			cluster.push(i);
	return cluster;
}

/**
 * The uv-attribute index nearest to (u, v), or -1 when nothing is within
 * `radius` (both in UV units, so the caller converts its pixel tolerance).
 * Restricted to the given slot's triangles so a hidden slot can't be grabbed.
 * @param {any} object @param {number} slot @param {number} u @param {number} v @param {number} radius
 */
export function nearestUvIndex(object, slot, u, v, radius) {
	let best = -1;
	let bestDist = radius * radius;
	for (const tri of uvTriangles(object, slot))
		tri.corners.forEach((corner, c) => {
			const du = corner[0] - u;
			const dv = corner[1] - v;
			const dist = du * du + dv * dv;
			if (dist <= bestDist) {
				bestDist = dist;
				best = tri.indices[c];
			}
		});
	return best;
}

/**
 * Grow a set of uv indices to the full welded cluster of each member. Selecting
 * or marquee-hitting one corner has to take its co-located twins with it, or a
 * drag tears the mapping at every seam.
 * @param {any} geometry @param {Iterable<number>} indices @returns {number[]}
 */
export function expandClusters(geometry, indices) {
	/** @type {Set<number>} */
	const out = new Set();
	for (const i of indices) {
		if (out.has(i)) continue;
		for (const j of weldedCluster(geometry, i)) out.add(j);
	}
	return [...out];
}

/**
 * Every uv index of `slot` inside an axis-aligned UV-space rect (box select).
 * Corners exactly on the edge count as inside.
 * @param {any} object @param {number} slot
 * @param {{u0: number, v0: number, u1: number, v1: number}} rect
 * @returns {number[]}
 */
export function uvIndicesInRect(object, slot, rect) {
	const uMin = Math.min(rect.u0, rect.u1);
	const uMax = Math.max(rect.u0, rect.u1);
	const vMin = Math.min(rect.v0, rect.v1);
	const vMax = Math.max(rect.v0, rect.v1);
	/** @type {Set<number>} */
	const hit = new Set();
	for (const tri of uvTriangles(object, slot))
		tri.corners.forEach((corner, c) => {
			if (corner[0] >= uMin && corner[0] <= uMax && corner[1] >= vMin && corner[1] <= vMax)
				hit.add(tri.indices[c]);
		});
	return [...hit];
}

/**
 * Every uv index of `slot` inside a freehand polygon (lasso select), by the
 * even-odd ray-crossing rule. `polygon` is [[u,v], ...] and is treated as
 * closed. Fewer than 3 points selects nothing.
 * @param {any} object @param {number} slot @param {number[][]} polygon
 * @returns {number[]}
 */
export function uvIndicesInPolygon(object, slot, polygon) {
	if (!polygon || polygon.length < 3) return [];
	/** @type {Set<number>} */
	const hit = new Set();
	for (const tri of uvTriangles(object, slot))
		tri.corners.forEach((corner, c) => {
			if (pointInPolygon(corner[0], corner[1], polygon)) hit.add(tri.indices[c]);
		});
	return [...hit];
}

/** even-odd point-in-polygon @param {number} u @param {number} v @param {number[][]} poly */
function pointInPolygon(u, v, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [ui, vi] = poly[i];
		const [uj, vj] = poly[j];
		// does the edge straddle the horizontal ray, and is the crossing to the right?
		if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
	}
	return inside;
}

/** a full {positions, groups, uvs} snapshot of an object's current geometry —
 * the shape the meshgeo wire message and the 'meshgeo' history kind both take
 * @param {any} object */
export function readUvSnapshot(object) {
	const tris = readTriangles(object.geometry);
	return { positions: trisToPositions(tris), groups: trisToGroups(tris), uvs: trisToUVs(tris) };
}

// --- drag session -----------------------------------------------------------
// A gesture is: beginUvDrag (snapshot the BEFORE) -> moveUvCluster xN (write the
// attribute in place for local feedback) -> endUvDrag (commit once). Positions
// never move, so there is no live preview broadcast: peers would pay a full
// snapshot per frame to watch a mapping they cannot see mid-drag. They get the
// result the moment the gesture ends.

/** @type {{uuid: string, before: any, uv: any} | null} */
let dragSession = null;

/**
 * Open a drag gesture on `uuid`. Stashes the BEFORE snapshot and the uv
 * attribute we are about to mutate — if a remote meshgeo or an undo swaps the
 * geometry mid-drag, `moveUvCluster` sees a different attribute object and
 * abandons the gesture rather than writing into a detached buffer.
 * @param {string} uuid @returns {boolean}
 */
export function beginUvDrag(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object || !uvEditable(object).ok) return false;
	dragSession = { uuid, before: readUvSnapshot(object), uv: object.geometry.attributes.uv };
	return true;
}

/** is a drag gesture open? */
export function uvDragging() {
	return !!dragSession;
}

/**
 * Move a welded cluster by (du, dv) in UV space. Writes the attribute in place
 * and pokes objectsGroup so the texture visibly slides on the model while the
 * user drags — THREE trees aren't reactive, the poke is the only signal.
 * @param {any} object @param {number[]} indices @param {number} du @param {number} dv
 */
export function moveUvCluster(object, indices, du, dv) {
	const uv = object?.geometry?.attributes?.uv;
	if (!uv || !indices?.length) return false;
	// the geometry was swapped under us (remote commit / undo) — drop the gesture
	if (dragSession && dragSession.uv !== uv) {
		dragSession = null;
		return false;
	}
	for (const i of indices) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
	uv.needsUpdate = true;
	objectsGroup.update((v) => v);
	return true;
}

/**
 * Close the gesture: swap the geometry to the edited snapshot locally, replicate
 * it, and record ONE undo entry for the whole drag. `applyMeshGeo` normalizes our
 * local geometry to the same index-expanded form peers and the undo replay hold,
 * so undo/redo round-trips exactly.
 * @param {string} uuid @returns {boolean} true when something was committed
 */
export function endUvDrag(uuid) {
	const session = dragSession;
	dragSession = null;
	if (!session || session.uuid !== uuid) return false;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return false;
	const after = readUvSnapshot(object);
	if (!after.uvs || sameFloats(session.before.uvs, after.uvs)) return false;
	if (after.positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	applyMeshGeo(uuid, after.positions, after.groups, after.uvs);
	broadcastUvGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before: session.before, after });
	return true;
}

/** abandon an open gesture without committing (Esc / target changed) */
export function cancelUvDrag() {
	dragSession = null;
}

/** @param {number[] | null} a @param {number[] | null} b */
function sameFloats(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
	return true;
}

/**
 * The meshgeo wire message, byte-identical to faceEdit's private
 * broadcastMeshGeo (raw Float32 BYTES — binarypack recurses per element and
 * silently blows the call stack on a big plain array, and broadcast() swallows
 * the throw). `groups`/`uvs` are omitted when absent so an older peer just sees
 * today's message.
 * @param {string} uuid @param {{positions: number[], groups: any[] | null, uvs: number[] | null}} snapshot
 */
function broadcastUvGeo(uuid, snapshot) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	peer.send({
		type: 'meshgeo',
		uuid: uuid,
		positions: new Float32Array(snapshot.positions).buffer,
		...(snapshot.groups?.length ? { groups: snapshot.groups } : {}),
		...(snapshot.uvs?.length ? { uvs: new Float32Array(snapshot.uvs).buffer } : {})
	});
}
