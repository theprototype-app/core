// 33-scenes — the PURE half of kit instancing (kitInstancing.js is the runtime). No three,
// no stores: the numbers here are what a suite can pin without a GL context.

/** Batches are cut into square COLUMNS of this many metres, so a batch can still be culled:
 * one InstancedMesh holding every wall of a town is drawn or skipped as a whole, while a
 * column of walls behind you is skipped and the one in front is drawn. The columns are
 * CENTRED on the origin (-8..8, 8..24, …) because a level is authored around it: 8 m columns
 * cut the 12 × 10 m tavern into four and left a quarter of its batches with one member each
 * (measured: 117 groups for 45 pieces, 224 calls at the spawn). */
export const CELL_METRES = 16;

/** A batch is only worth an InstancedMesh with at least this many members — one member is
 * drawn as itself (instancing a single mesh would only cost a program variant). */
export const MIN_BATCH = 2;

/** The column (cx, cz) packed into one integer, plus the two shadow flags, so the per-pass
 * grouping is a Map lookup by number (no string per mesh per pass).
 * @param {number} x @param {number} z @param {boolean} cast @param {boolean} receive
 * @param {number} [cell] metres */
export function cellKey(x, z, cast, receive, cell = CELL_METRES) {
	const cx = Math.max(-2048, Math.min(2047, Math.floor(x / cell + 0.5))) + 2048;
	const cz = Math.max(-2048, Math.min(2047, Math.floor(z / cell + 0.5))) + 2048;
	return ((cx * 4096 + cz) * 4) + (cast ? 2 : 0) + (receive ? 1 : 0);
}

/** The inverse of cellKey (for the stats and the suite) @param {number} key @param {number} [cell] */
export function cellOf(key, cell = CELL_METRES) {
	const flags = key % 4;
	const rest = (key - flags) / 4;
	const cz = (rest % 4096) - 2048;
	const cx = Math.floor(rest / 4096) - 2048;
	// the column's CENTRE
	return { x: cx * cell, z: cz * cell, cast: (flags & 2) === 2, receive: (flags & 1) === 1 };
}

const SCALAR_FIELDS = ['type', 'side', 'opacity', 'transparent', 'alphaTest', 'roughness', 'metalness', 'emissiveIntensity', 'envMapIntensity', 'wireframe', 'flatShading', 'vertexColors', 'visible', 'depthWrite', 'depthTest', 'aoMapIntensity', 'normalScale', 'clearcoat', 'transmission'];
const COLOR_FIELDS = ['color', 'emissive', 'specularColor', 'sheenColor'];
const MAP_FIELDS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap'];

/**
 * What a material LOOKS like, as a string: two materials with the same signature draw the
 * same pixels, so the copy of a pack piece can be drawn with its TEMPLATE's material. Any
 * edit a user can make (a colour, a roughness, a dropped or swapped texture, transparency)
 * changes it, which is what takes an edited piece out of its batch.
 * @param {any} m a three material (or a plain object with the same fields)
 */
export function materialSignature(m) {
	if (!m) return '';
	const parts = [];
	for (const k of SCALAR_FIELDS) {
		const v = m[k];
		if (v === undefined) continue;
		parts.push(k + '=' + (v && typeof v === 'object' && 'x' in v ? v.x + ',' + v.y : v));
	}
	for (const k of COLOR_FIELDS) {
		const c = m[k];
		if (c && typeof c.getHex === 'function') parts.push(k + '#' + c.getHex());
		else if (c && typeof c === 'object' && 'r' in c) parts.push(k + '#' + [c.r, c.g, c.b].join(','));
	}
	for (const k of MAP_FIELDS) {
		const t = m[k];
		if (!t) continue;
		// a texture is the same picture when it is the same texture OBJECT (packRefs shares
		// one per image) — or, for a plain record, the same uuid
		parts.push(k + '@' + (t.uuid ?? t));
		if (t.offset && t.repeat) parts.push(k + 'uv' + [t.offset.x, t.offset.y, t.repeat.x, t.repeat.y, t.rotation ?? 0].join(','));
	}
	return parts.join('|');
}

/**
 * Why a mesh cannot join a batch ('' = it can). The runtime's per-scan test, kept pure so
 * the suite can walk every rule.
 * @param {{mesh: any, source: any, selected?: boolean}} c the mesh, its kit source record
 *   ({geometry, version, material, sig}) and whether its piece is selected
 */
export function ineligible({ mesh, source, selected = false }) {
	if (!mesh?.isMesh) return 'not a mesh';
	if (!source) return 'not a kit piece';
	if (mesh.isSkinnedMesh || mesh.isInstancedMesh) return 'skinned or instanced';
	if (Array.isArray(mesh.material)) return 'material slots';
	const morph = mesh.geometry?.morphAttributes;
	if (morph && Object.keys(morph).some((k) => morph[k]?.length)) return 'morph targets';
	if (mesh.geometry !== source.geometry) return 'geometry replaced';
	if ((mesh.geometry?.attributes?.position?.version ?? 0) !== source.version) return 'geometry edited';
	if (mesh.material !== source.material) return 'material replaced';
	if (mesh.material?.transparent) return 'transparent';
	if (materialSignature(mesh.material) !== source.sig) return 'material edited';
	if (selected) return 'selected';
	return '';
}
