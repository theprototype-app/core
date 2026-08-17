import { MAX_FACE_TRIS } from './meshBudget';

// STORED MESH TOPOLOGY (the half-edge/n-gon workstream, phase 1).
//
// The geometry in this app is a triangle SOUP: which triangles form one logical face
// is RE-DERIVED from coplanarity every time the mesh changes (`pairQuads`,
// `groupFaces`). The hardening batch measured exactly why that is a dead end: rotate
// an extruded band 4 degrees and each wall quad's two triangles diverge by ~9 degrees,
// which no coplanarity threshold can separate from a genuine crease — so all eight
// wall quads silently leave the topology and every loop tool declines. Subdivide had
// the same shape: a 4-way triangle split gave a quad eight triangles with no grid
// pairing, `pairQuads` matched the kites, and the pinwheel made loops undefined.
//
// So topology becomes DATA the operators author, and derivation becomes the fallback.
// This module owns only the boring, testable half: storage, validation, and the wire
// packing. Derivation stays in faceEdit (it is the operators' business), which keeps
// this file free of scene and store imports and makes it a pure unit.
//
// Design decisions this implements (posted for review in the cloud plan doc):
// - A2 topology is an EXTRA CHANNEL, not a rewrite: a face is a GROUPING of triangle
//   indices, positions stay the geometric truth, and every operator keeps its
//   tris-in/tris-out shape. An operator that does not author faces simply lets the
//   applier re-derive, i.e. today's behaviour.
// - A4 the wire packs CSR-style as flat Int32 raw BYTES (`faceCounts` + `faceTris`),
//   never nested arrays: binarypack recurses per element and `broadcast`'s catch
//   swallows the overflow, so the message would silently never leave.
// - A7 a carry-over must DROP mismatched topology rather than keep it, because several
//   commit paths are positions-only and lean on carry-over.
//
// UVs are deliberately NOT stored here. They are already per face CORNER on the
// triangle soup (`tri.uv`), which is the face-varying model A1 requires — a UV seam is
// one position carrying two different UVs — so the existing channel is already
// correct and needs no migration.

/** where stored topology lives on a geometry. `userData` round-trips through
 * toJSON/ObjectLoader and through GLTF extras, so it survives the paths that matter
 * without a new field on any message. */
const TOPO_KEY = '__topo';

/**
 * Is this face partition VALID for a mesh of `triCount` triangles? Every triangle
 * must belong to exactly one face, and every index must be in range.
 *
 * This is the A7 invariant and the reason stored topology can never corrupt a mesh:
 * anything that fails here is dropped and the caller re-derives.
 * @param {number[][]|null|undefined} faces @param {number} triCount
 * @returns {boolean}
 */
export function facesValidFor(faces, triCount) {
	if (!Array.isArray(faces) || !faces.length) return false;
	const seen = new Uint8Array(triCount);
	let total = 0;
	for (const face of faces) {
		if (!Array.isArray(face) || !face.length) return false;
		for (const tri of face) {
			if (!Number.isInteger(tri) || tri < 0 || tri >= triCount) return false;
			if (seen[tri]) return false; // a triangle in two faces
			seen[tri] = 1;
			total++;
		}
	}
	return total === triCount;
}

/**
 * Write a face partition onto a geometry. Stored as PLAIN ARRAYS in `userData` so it
 * survives toJSON/ObjectLoader and GLTF extras untouched.
 * @param {any} geometry @param {number[][]} faces @returns {boolean} stored
 */
export function storeFaces(geometry, faces) {
	if (!geometry) return false;
	const triCount = triangleCountOf(geometry);
	if (!facesValidFor(faces, triCount)) return false;
	geometry.userData = geometry.userData ?? {};
	geometry.userData[TOPO_KEY] = {
		counts: faces.map((face) => face.length),
		tris: faces.flat()
	};
	return true;
}

/** Forget any stored topology — an operator that cannot describe its output should
 * clear rather than leave a stale partition for the applier to trust.
 * @param {any} geometry */
export function clearStoredFaces(geometry) {
	if (geometry?.userData) delete geometry.userData[TOPO_KEY];
}

/**
 * Read the stored partition, or null when there is none or it does not fit the mesh.
 * Validation is not optional: a positions-only commit can change the triangle count
 * under a partition that was correct a moment ago.
 * @param {any} geometry @returns {number[][]|null}
 */
export function readStoredFaces(geometry) {
	const stored = geometry?.userData?.[TOPO_KEY];
	if (!stored?.counts?.length || !stored?.tris?.length) return null;
	const faces = unpackFaces(stored.counts, stored.tris);
	return facesValidFor(faces, triangleCountOf(geometry)) ? faces : null;
}

/** triangles in a geometry, index-expanded like `readTriangles` counts them
 * @param {any} geometry */
export function triangleCountOf(geometry) {
	const position = geometry?.attributes?.position;
	if (!position) return 0;
	return (geometry.index ? geometry.index.count : position.count) / 3;
}

// ---- wire format -----------------------------------------------------------

/**
 * CSR pack for the wire: one Int32 count per face plus a flat Int32 run of triangle
 * indices. Integers, so this is exact and about half the size of a plain array — and
 * crucially NOT nested, which is what blows binarypack's per-element recursion.
 * @param {number[][]} faces
 * @returns {{faceCounts: ArrayBuffer, faceTris: ArrayBuffer}|null}
 */
export function packFaces(faces) {
	if (!Array.isArray(faces) || !faces.length) return null;
	const counts = new Int32Array(faces.length);
	let total = 0;
	faces.forEach((face, i) => {
		counts[i] = face.length;
		total += face.length;
	});
	const tris = new Int32Array(total);
	let at = 0;
	for (const face of faces) for (const tri of face) tris[at++] = tri;
	return { faceCounts: counts.buffer, faceTris: tris.buffer };
}

/**
 * Unpack whatever arrives: a plain array (a history replay), an ArrayBuffer (the wire)
 * or a typed-array VIEW — binarypack may hand back a view into a LARGER buffer, so the
 * exact bytes have to be sliced. Same normalisation `toFloats` does for positions.
 * @param {any} faceCounts @param {any} faceTris @returns {number[][]}
 */
export function unpackFaces(faceCounts, faceTris) {
	const counts = toInts(faceCounts);
	const tris = toInts(faceTris);
	/** @type {number[][]} */
	const faces = [];
	let at = 0;
	for (const count of counts) {
		if (count <= 0 || at + count > tris.length) return [];
		faces.push(Array.from(tris.subarray(at, at + count)));
		at += count;
	}
	return faces;
}

/** @param {any} data @returns {Int32Array} */
function toInts(data) {
	if (data instanceof ArrayBuffer) return new Int32Array(data);
	if (ArrayBuffer.isView(data))
		return new Int32Array(
			/** @type {any} */ (data).buffer.slice(
				/** @type {any} */ (data).byteOffset,
				/** @type {any} */ (data).byteOffset + /** @type {any} */ (data).byteLength
			)
		);
	return new Int32Array(data ?? []);
}

/** Corner budget, the integer sibling of MAX_SNAPSHOT — indices, not coordinates,
 * so it stays a separate number. It lives in meshBudget.js now, with the rest of
 * the ceilings and the measurement that set them; re-exported here because that is
 * where callers already look for it. */
export { MAX_FACE_TRIS };

/**
 * The optional wire fields for a snapshot, or `{}` when there is nothing worth
 * sending. Absent means "re-derive", which is exactly what an older peer does anyway —
 * so an old client is never WRONG, only less capable (the groups/uvs precedent).
 * @param {number[][]|null} faces @returns {any}
 */
export function facesWireFields(faces) {
	if (!faces?.length) return {};
	const total = faces.reduce((sum, face) => sum + face.length, 0);
	if (total > MAX_FACE_TRIS) return {};
	const packed = packFaces(faces);
	return packed ? packed : {};
}

/**
 * Apply incoming topology to a geometry, dropping it unless it fits.
 * @param {any} geometry @param {any} faceCounts @param {any} faceTris
 * @returns {boolean} whether stored topology is now present
 */
export function applyFacesWire(geometry, faceCounts, faceTris) {
	if (!geometry) return false;
	if (faceCounts == null || faceTris == null) {
		// nothing on the wire: a positions-only sender, or an older peer. Whatever the
		// geometry already carries is about to be replaced, so it cannot be trusted.
		clearStoredFaces(geometry);
		return false;
	}
	const faces = unpackFaces(faceCounts, faceTris);
	if (!storeFaces(geometry, faces)) {
		clearStoredFaces(geometry);
		return false;
	}
	return true;
}

/**
 * Carry topology across a geometry SWAP: keep it only when it still describes the new
 * mesh exactly. A rigid move (same triangle count and order) keeps its faces; anything
 * that adds or removes triangles drops them and the caller re-derives.
 *
 * This is the invariant that lets positions-only commit paths stay positions-only.
 * @param {any} geometry the fresh geometry @param {any} previous the one being replaced
 * @returns {boolean} whether topology survived
 */
export function carryFaces(geometry, previous) {
	const faces = readStoredFaces(previous);
	if (!faces) return false;
	return storeFaces(geometry, faces);
}

/**
 * Compose the partition an operator's OUTPUT deserves (P10).
 *
 * Three kinds of triangle come out of an operator and each needs different treatment:
 * `authored` faces are what the operator KNOWS it built (a wall quad, one cell of a
 * subdivision grid) and are taken verbatim; everything else that came from an old
 * triangle rejoins that triangle's old face; anything genuinely new and unclaimed
 * becomes its own single-triangle face.
 *
 * Authored faces win over the carry-over on purpose. Subdivide is the case that forces
 * it: its eight output triangles all descend from ONE old quad, so a pure carry-over
 * would call them one eight-triangle face, when the truth is four sub-quads.
 * @param {number[][]|null} oldFaces the partition the operator consumed
 * @param {number[]} origin newIndex -> the old index it came from, or -1
 * @param {number[][]} authored faces the operator built, in NEW indices
 * @returns {number[][]}
 */
export function composeFaces(oldFaces, origin, authored) {
	const claimed = new Set();
	/** @type {number[][]} */
	const out = [];
	for (const face of authored ?? []) {
		if (!face?.length || face.some((tri) => claimed.has(tri))) continue;
		face.forEach((tri) => claimed.add(tri));
		out.push([...face]);
	}
	/** @type {Map<number, number>} old tri -> which old face it was in */
	const faceOf = new Map();
	(oldFaces ?? []).forEach((face, fi) => face.forEach((tri) => faceOf.set(tri, fi)));
	/** @type {Map<number, number[]>} */
	const grouped = new Map();
	origin.forEach((from, to) => {
		if (claimed.has(to)) return;
		const fi = from >= 0 ? faceOf.get(from) : undefined;
		if (fi === undefined) {
			out.push([to]);
			return;
		}
		let list = grouped.get(fi);
		if (!list) grouped.set(fi, (list = []));
		list.push(to);
	});
	return [...out, ...grouped.values()];
}

/**
 * The trivial origin map for an operator that KEPT every input triangle at its index and
 * appended new ones (extrude, inset — `cloneTris` then `pushQuad`).
 * @param {number} oldCount @param {number} newCount @returns {number[]}
 */
export function appendOrigin(oldCount, newCount) {
	/** @type {number[]} */
	const origin = [];
	for (let i = 0; i < newCount; i++) origin.push(i < oldCount ? i : -1);
	return origin;
}

/**
 * The appended triangles read as consecutive PAIRS, which is exactly what `pushQuad`
 * emits: one quad = two triangles, in order. An odd tail is left as a singleton rather
 * than paired with something it does not belong to.
 * @param {number} oldCount @param {number} newCount @returns {number[][]}
 */
export function appendedQuads(oldCount, newCount) {
	/** @type {number[][]} */
	const quads = [];
	for (let i = oldCount; i < newCount; i += 2)
		quads.push(i + 1 < newCount ? [i, i + 1] : [i]);
	return quads;
}

/**
 * Re-key a partition after an operator emitted a NEW triangle list, given a map from
 * new triangle index to the OLD index it came from (-1 for genuinely new triangles).
 * New triangles are appended as their own single-triangle faces, which is the honest
 * default: an operator that knows better should author its faces explicitly.
 * @param {number[][]} oldFaces @param {number[]} origin newIndex -> oldIndex | -1
 * @returns {number[][]}
 */
export function remapFaces(oldFaces, origin) {
	/** @type {Map<number, number>} old tri -> which old face it was in */
	const faceOf = new Map();
	oldFaces.forEach((face, fi) => face.forEach((tri) => faceOf.set(tri, fi)));
	/** @type {Map<number, number[]>} old face -> new tris */
	const grouped = new Map();
	/** @type {number[][]} */
	const fresh = [];
	origin.forEach((from, to) => {
		const fi = from >= 0 ? faceOf.get(from) : undefined;
		if (fi === undefined) {
			fresh.push([to]);
			return;
		}
		let list = grouped.get(fi);
		if (!list) grouped.set(fi, (list = []));
		list.push(to);
	});
	return [...grouped.values(), ...fresh];
}
