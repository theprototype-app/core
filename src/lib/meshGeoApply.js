// 102-boot-diet-2: THE PEER / UNDO GEOMETRY SWAP, kept on the boot while faceEdit.js is a lazy chunk.
// A remote `meshgeo` must apply IN ORDER with the `verts` / UV-paint / material messages behind it, so
// it cannot wait for a chunk: this is applyMeshGeo and exactly the helpers it needs, moved verbatim out
// of faceEdit.js (which imports them back and re-exports applyMeshGeo / smoothWeldedNormals). The one
// session-only step (re-derive the open face session's tris + overlays) is `editHooks.faceSessionSwap`,
// registered by faceEdit — an open face session implies the module is loaded.
import * as THREE from 'three';
import { pokeScene } from '../stores/sceneStore';
import { session as editSession } from './editSessionState';
import { lookupEditable, editHooks } from './faceEditState';
import { frameOfGeometry, normalPlan, applyNormalPlan, changedCorners } from './triFrame';
import { clearStoredFaces, applyFacesWire, carryFaces } from './meshTopology';

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
export function preserveMaterialGroups(geometry, previous, object, groups) {
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
export function preserveUVs(geometry, previous, uvs) {
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
	const previous = object.geometry;
	const smooth = !!(object.userData.terrain || object.userData.shading === 'smooth');
	// 99 K5: a MOVE (same triangles, some corners elsewhere) updates only the touched normals, from the previous
	// geometry's — the live grab's own policy (triFrame.normalPlan), so a peer and an undo land the same normals as
	// the editor that made the move, authored normals elsewhere stay byte-identical, and a stroke on a dense mesh
	// skips the full recompute. Anything else recomputes in full, as before.
	if (!incrementalNormals(geometry, previous, smooth)) {
		geometry.computeVertexNormals();
		// T-2: terrain reads smooth, not faceted — average normals across
		// position-welded vertices (deterministic: every peer derives the same
		// shading from the same positions; nothing extra on the wire). M6 makes the
		// same treatment a per-object CHOICE, so it has to survive every swap.
		if (smooth) smoothWeldedNormals(geometry);
	}
	geometry.computeBoundingSphere();
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
	if (editSession.face.object === object) editHooks.faceSessionSwap?.(); // faceEdit registers it (a session implies it is loaded)
	// a live sculpt session's weld map is a cache over THIS geometry — rebuild
	// it after a remote stroke / undo swap (terrainSculpt imports us, so it registers
	// the hook at its module eval; rebuildSculptCaches picks the terrain OR mesh map)
	editHooks.sculptCacheRefresher?.(uuid, object);
	// D1: a live VERTEX session's handles are a cache over THIS geometry too —
	// rebuild them after an undo / remote commit. meshEdit registers the hook at
	// module eval (it imports us — a dynamic import back would be a SECOND module
	// instance under vite's ?t= HMR stamps, whose editingObject is always null).
	editHooks.vertexSessionRefresher?.(uuid);
	pokeScene();
}

/**
 * 99 K5: give `geometry` (positions only) the previous geometry's normals with only the moved corners' touched
 * normals recomputed — when it is a move: the same corner count on a plain non-indexed Float32 previous geometry
 * with normals, at most half of the corners moved. Returns false (the caller recomputes in full) otherwise.
 * @param {any} geometry @param {any} previous @param {boolean} smooth
 */
function incrementalNormals(geometry, previous, smooth) {
	const pos = previous?.attributes?.position;
	const normal = previous?.attributes?.normal;
	const next = geometry.attributes.position.array;
	if (!pos || !normal || previous.index || pos.isInterleavedBufferAttribute || normal.isInterleavedBufferAttribute) return false;
	if (!(pos.array instanceof Float32Array) || !(normal.array instanceof Float32Array)) return false;
	if (pos.array.length !== next.length || normal.array.length !== next.length || !next.length) return false;
	const moved = changedCorners(pos.array, next);
	if (moved.length * 2 > next.length / 3) return false;
	const normals = Float32Array.from(normal.array);
	geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
	if (!moved.length) return true;
	const before = frameOfGeometry(previous);
	const plan = normalPlan(before, normals, moved, { smooth });
	if (!plan) return false;
	applyNormalPlan(frameOfGeometry(geometry), normals, plan);
	return true;
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
