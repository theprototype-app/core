// Roadmap 99 K4: the two adapters between the editor's shapes and an op mesh, kept in the LAZY chunk
// (faceEdit is in both boot graphs; this is what it would otherwise carry).
//  - the triangle SOUP (`[Vector3, Vector3, Vector3]` with `mi` / `uv` tags, faceEdit's withSlot shape),
//    which the soup-shaped exports (VR, the bevel core, the e2e suites) still speak;
//  - a three.js GEOMETRY (the session and agent paths).
import * as THREE from 'three';
import { plainAttribute } from '../meshKernel/geometry.js';
import { opMeshFromArrays, opTriangles, beginOp } from './opMesh.js';

/**
 * A triangle soup as an op mesh, begun (no stored partition: each triangle its own face, the soup ops'
 * own view of their input). @param {any[]} tris
 */
export function fromSoup(tris) {
	const positions = new Float64Array(tris.length * 9);
	const textured = tris.some((t) => !!t.uv);
	const uv = textured ? new Float64Array(tris.length * 6) : null;
	/** @type {{ start: number, count: number, materialIndex: number }[]} */
	const groups = [];
	tris.forEach((t, ti) => {
		for (let c = 0; c < 3; c++) {
			positions[ti * 9 + c * 3] = t[c].x;
			positions[ti * 9 + c * 3 + 1] = t[c].y;
			positions[ti * 9 + c * 3 + 2] = t[c].z;
			if (uv) {
				const pair = t.uv ? t.uv[c] : [0, 0];
				uv[ti * 6 + c * 2] = pair[0];
				uv[ti * 6 + c * 2 + 1] = pair[1];
			}
		}
		const slot = t.mi || 0;
		const last = groups[groups.length - 1];
		if (last && last.materialIndex === slot) last.count += 3;
		else groups.push({ start: ti * 3, count: 3, materialIndex: slot });
	});
	const multi = groups.some((g) => g.materialIndex > 0);
	return beginOp(opMeshFromArrays({ positions, uv, groups: multi ? groups : null }));
}

/** An op mesh as a triangle soup (`mi` always, `uv` when textured: withSlot's shape) @param {any} om
 * @returns {any[]} */
export function toSoup(om) {
	const { positions: p, uv, material, count } = opTriangles(om);
	/** @type {any[]} */
	const out = new Array(count);
	for (let t = 0; t < count; t++) {
		/** @type {any} */
		const tri = [
			new THREE.Vector3(p[t * 9], p[t * 9 + 1], p[t * 9 + 2]),
			new THREE.Vector3(p[t * 9 + 3], p[t * 9 + 4], p[t * 9 + 5]),
			new THREE.Vector3(p[t * 9 + 6], p[t * 9 + 7], p[t * 9 + 8])
		];
		tri.mi = Math.max(material[t], 0);
		if (uv)
			tri.uv = [
				[uv[t * 6], uv[t * 6 + 1]],
				[uv[t * 6 + 2], uv[t * 6 + 3]],
				[uv[t * 6 + 4], uv[t * 6 + 5]]
			];
		out[t] = tri;
	}
	return out;
}

/**
 * A geometry as an op mesh: its positions, index, uvs and material groups, the partition the editor
 * sees, and the element IDs it is known to carry (null = weld). @param {any} geometry
 * @param {number[][] | null} partition @param {any} ids
 */
export function opMeshFromGeometry(geometry, partition, ids) {
	const uv = geometry.attributes.uv;
	return opMeshFromArrays({
		positions: plainAttribute(geometry.attributes.position).array,
		index: geometry.index ? plainAttribute(geometry.index).array : null,
		uv: uv ? plainAttribute(uv).array : null,
		groups: geometry.groups,
		partition,
		ids
	});
}
