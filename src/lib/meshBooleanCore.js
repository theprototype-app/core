import * as THREE from 'three';

// B10 (36-mesh-ops): the PURE half of the CSG booleans — imports three and nothing
// else, so the unit layer runs it in node (the app wrapper, meshBoolean.js, owns the
// stores, the history batch and the replication). See meshBoolean.js for the design.

/** @typedef {'union'|'subtract'|'intersect'} BooleanOp */

/** welded edges used other than exactly twice — 0 = closed @param {any[]} tris */
export function openEdgeCount(tris) {
	const keyOf = (/** @type {any} */ v) =>
		`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
	/** @type {Map<string, number>} */
	const use = new Map();
	for (const t of tris)
		for (let e = 0; e < 3; e++) {
			const a = keyOf(t[e]);
			const b = keyOf(t[(e + 1) % 3]);
			const k = a < b ? a + '|' + b : b + '|' + a;
			use.set(k, (use.get(k) || 0) + 1);
		}
	let odd = 0;
	for (const n of use.values()) if (n !== 2) odd++;
	return odd;
}

/**
 * The PURE core: two geometries + their world matrices in, the boolean result
 * out, expressed in the TARGET's local frame (so it can replace the target's
 * geometry in place). Both inputs are baked into world space first and run as
 * identity-transform brushes, which keeps the frame question out of the
 * library entirely. `csg` is the three-bvh-csg module (injected: the wrapper
 * lazy-loads it, the unit suite imports it directly).
 * @param {any} csg @param {THREE.BufferGeometry} geomA @param {THREE.Matrix4} matrixA
 * @param {THREE.BufferGeometry} geomB @param {THREE.Matrix4} matrixB @param {BooleanOp} op
 * @returns {THREE.BufferGeometry} non-indexed, in A's local frame
 */
export function booleanGeometry(csg, geomA, matrixA, geomB, matrixB, op) {
	/** world-space copy carrying exactly `attrs` @param {any} geometry @param {any} matrix @param {string[]} attrs */
	const prepare = (geometry, matrix, attrs) => {
		const g = new THREE.BufferGeometry();
		for (const name of attrs) g.setAttribute(name, geometry.getAttribute(name).clone());
		if (geometry.index) g.setIndex(geometry.index.clone());
		if (!g.getAttribute('normal')) g.computeVertexNormals();
		g.applyMatrix4(matrix);
		return g;
	};
	const uv = !!geomA.getAttribute('uv') && !!geomB.getAttribute('uv');
	const attrs = ['position', ...(geomA.getAttribute('normal') && geomB.getAttribute('normal') ? ['normal'] : []), ...(uv ? ['uv'] : [])];
	const a = new csg.Brush(prepare(geomA, matrixA, attrs));
	const b = new csg.Brush(prepare(geomB, matrixB, attrs));
	a.updateMatrixWorld();
	b.updateMatrixWorld();
	const evaluator = new csg.Evaluator();
	evaluator.useGroups = false;
	evaluator.attributes = attrs.includes('normal') ? attrs : [...attrs, 'normal'];
	const kind = op === 'union' ? csg.ADDITION : op === 'intersect' ? csg.INTERSECTION : csg.SUBTRACTION;
	const result = evaluator.evaluate(a, b, kind);
	const flat = result.geometry.index ? result.geometry.toNonIndexed() : result.geometry;
	const out = repairTJunctions(flat);
	out.applyMatrix4(new THREE.Matrix4().copy(matrixA).invert());
	a.geometry.dispose();
	b.geometry.dispose();
	return out;
}

/**
 * Split away the T-JUNCTIONS a CSG result is full of. The library cuts each
 * triangle where the other mesh crosses it, so a vertex the cut put on one side
 * of an edge is not on the triangle across it: the surface is closed to the eye
 * but its welded edges are not shared — every mesh tool (loops, fill, bevel, the
 * watertight checks) then sees a crack. For every edge used ONCE, any open-edge
 * endpoint lying strictly inside it is a T-junction vertex; the triangle owning
 * the edge is split there (all such vertices at once, in order along the edge).
 * Repeats until nothing changes (a split can expose the next one). Positions only
 * — uvs/normals of the split corners are LERPED along the edge, so the mapping
 * does not shear.
 * @param {THREE.BufferGeometry} geometry non-indexed, position (+ uv/normal)
 * @returns {THREE.BufferGeometry} a new non-indexed geometry
 */
export function repairTJunctions(geometry) {
	const names = ['position', 'normal', 'uv'].filter((n) => geometry.getAttribute(n));
	const sizes = names.map((n) => geometry.getAttribute(n).itemSize);
	/** @type {number[][][]} triangles -> 3 corners -> flat [attr0..., attr1..., ...] */
	let tris = [];
	const pos = geometry.getAttribute('position');
	for (let i = 0; i + 2 < pos.count; i += 3) {
		/** @type {number[][]} */
		const tri = [];
		for (let c = 0; c < 3; c++) {
			/** @type {number[]} */
			const corner = [];
			names.forEach((n, k) => {
				const a = geometry.getAttribute(n);
				for (let j = 0; j < sizes[k]; j++) corner.push(a.array[(i + c) * sizes[k] + j]);
			});
			tri.push(corner);
		}
		tris.push(tri);
	}
	const keyOf = (/** @type {number[]} */ c) =>
		`${Math.round(c[0] * 1e4)},${Math.round(c[1] * 1e4)},${Math.round(c[2] * 1e4)}`;
	for (let pass = 0; pass < 8; pass++) {
		/** @type {Map<string, number>} */
		const use = new Map();
		for (const t of tris)
			for (let e = 0; e < 3; e++) {
				const a = keyOf(t[e]);
				const b = keyOf(t[(e + 1) % 3]);
				const k = a < b ? a + '|' + b : b + '|' + a;
				use.set(k, (use.get(k) || 0) + 1);
			}
		/** @type {Map<string, number[]>} open-edge endpoints: the only T-junction candidates */
		const candidates = new Map();
		for (const t of tris)
			for (let e = 0; e < 3; e++) {
				const a = keyOf(t[e]);
				const b = keyOf(t[(e + 1) % 3]);
				if (use.get(a < b ? a + '|' + b : b + '|' + a) !== 1) continue;
				candidates.set(a, t[e]);
				candidates.set(b, t[(e + 1) % 3]);
			}
		if (!candidates.size) break;
		const points = [...candidates.values()];
		let changed = false;
		/** @type {number[][][]} */
		const next = [];
		for (const t of tris) {
			let split = null;
			for (let e = 0; e < 3 && !split; e++) {
				const A = t[e];
				const B = t[(e + 1) % 3];
				const a = keyOf(A);
				const b = keyOf(B);
				if (use.get(a < b ? a + '|' + b : b + '|' + a) !== 1) continue;
				const dx = B[0] - A[0];
				const dy = B[1] - A[1];
				const dz = B[2] - A[2];
				const len2 = dx * dx + dy * dy + dz * dz;
				if (len2 < 1e-16) continue;
				/** @type {{s: number, p: number[]}[]} */
				const inside = [];
				for (const p of points) {
					const s = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy + (p[2] - A[2]) * dz) / len2;
					if (s <= 1e-6 || s >= 1 - 1e-6) continue;
					const ex = A[0] + dx * s - p[0];
					const ey = A[1] + dy * s - p[1];
					const ez = A[2] + dz * s - p[2];
					if (ex * ex + ey * ey + ez * ez > 1e-10 * Math.max(len2, 1)) continue;
					inside.push({ s, p });
				}
				if (inside.length) split = { e, inside: inside.sort((x, y) => x.s - y.s) };
			}
			if (!split) {
				next.push(t);
				continue;
			}
			changed = true;
			const A = t[split.e];
			const B = t[(split.e + 1) % 3];
			const C = t[(split.e + 2) % 3];
			// the chain A, v1, ..., vn, B — every new corner takes the T vertex's exact
			// position (so it welds) and the edge's lerped non-position attributes
			const chain = [A];
			for (const { s, p } of split.inside) {
				const corner = A.map((v, j) => v + (B[j] - v) * s);
				corner[0] = p[0];
				corner[1] = p[1];
				corner[2] = p[2];
				chain.push(corner);
			}
			chain.push(B);
			for (let i = 0; i + 1 < chain.length; i++) next.push([chain[i], chain[i + 1], C]);
		}
		tris = next;
		if (!changed) break;
	}
	const out = new THREE.BufferGeometry();
	names.forEach((n, k) => {
		const array = new Float32Array(tris.length * 3 * sizes[k]);
		let o = 0;
		let offset = 0;
		for (let j = 0; j < k; j++) offset += sizes[j];
		for (const t of tris)
			for (const c of t) for (let j = 0; j < sizes[k]; j++) array[o++] = c[offset + j];
		out.setAttribute(n, new THREE.BufferAttribute(array, sizes[k]));
	});
	return out;
}
