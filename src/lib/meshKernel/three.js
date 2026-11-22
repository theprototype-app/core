// Roadmap 99 K1: kernel -> THREE.BufferGeometry. The one kernel file that imports three.js; the
// kernel itself never does, so a Worker builds the arrays (`toArrays`) and the page wraps them.

import { BufferGeometry, BufferAttribute } from 'three';
import { toArrays } from './arrays.js';

/**
 * Build a non-indexed BufferGeometry from the kernel: position, every corner attribute, the
 * material groups and (`topo`) the face partition on `userData.__topo` in meshTopology's own
 * `{counts, tris}` shape. `topo: 'auto'` (default) stores it when some face is more than one
 * triangle, which is exactly when re-deriving would lose information.
 * Normals are carried when the source had them; `computeNormals: true` recomputes instead.
 * @param {import('./kernel.js').MeshKernel} mesh
 * @param {{ topo?: boolean|'auto', computeNormals?: boolean }} [options]
 */
export function toBufferGeometry(mesh, options = {}) {
	const out = toArrays(mesh);
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(out.positions, 3));
	for (const [name, attr] of Object.entries(out.attributes)) {
		if (name === 'normal' && options.computeNormals) continue;
		geometry.setAttribute(name, new BufferAttribute(attr.array, attr.itemSize));
	}
	if (out.groups) for (const g of out.groups) geometry.addGroup(g.start, g.count, g.materialIndex ?? 0);
	if (options.computeNormals || !out.attributes.normal) geometry.computeVertexNormals();
	const topo = options.topo ?? 'auto';
	if (topo === true || (topo === 'auto' && out.faces.some((face) => face.length > 1)))
		geometry.userData.__topo = { counts: out.faces.map((face) => face.length), tris: out.faces.flat() };
	geometry.computeBoundingSphere();
	return { geometry, arrays: out };
}
