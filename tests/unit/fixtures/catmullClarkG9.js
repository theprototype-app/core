// @ts-nocheck
// FROZEN copy of src/lib/ai/worldToolsCore.js catmullClark as of 99-live 9e91c225 (85b G9), before 99 K8 moved it onto
// the kernel: the parity reference for meshKernelCatmullClark.test.js. Do not edit.
export function catmullClark(mesh, levels) {
	let cur = mesh;
	for (let l = 0; l < levels; l++) cur = ccOnce(cur);
	return cur;
}

/** @param {{vertices: number[][], faces: number[][], uvs?: number[][], colors?: number[][], faceMaterials?: number[]}} m */
function ccOnce(m) {
	const V = m.vertices;
	const attrs = /** @type {('uvs'|'colors')[]} */ (['uvs', 'colors']).filter((k) => Array.isArray(m[k]));
	/** @param {number[][]} list @returns {number[]} */
	const avg = (list) => list[0].map((_, i) => list.reduce((s, p) => s + p[i], 0) / list.length);
	/** per vertex: positions + each carried attribute, as one row of arrays */
	const row = (/** @type {number} */ i) => [V[i], ...attrs.map((k) => /** @type {number[][]} */ (m[k])[i])];
	/** @param {number[][][]} rows */
	const avgRows = (rows) => rows[0].map((_, a) => avg(rows.map((r) => r[a])));
	const facePts = m.faces.map((f) => avgRows(f.map(row)));
	/** edge key → {a, b, faces[]} */
	const edges = new Map();
	const key = (/** @type {number} */ a, /** @type {number} */ b) => (a < b ? a + '_' + b : b + '_' + a);
	m.faces.forEach((f, fi) => {
		for (let k = 0; k < f.length; k++) {
			const a = f[k];
			const b = f[(k + 1) % f.length];
			const id = key(a, b);
			const e = edges.get(id) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [] };
			e.faces.push(fi);
			edges.set(id, e);
		}
	});
	/** @type {number[][][]} the new points, as rows (position + attributes) */
	const out = [];
	/** vertex i → new index */
	const vIndex = new Map();
	/** edge key → new index */
	const eIndex = new Map();
	/** face index → new index */
	const fIndex = facePts.map((p) => out.push(p) - 1);
	for (const [id, e] of edges) {
		const ends = [row(e.a), row(e.b)];
		// the position takes the faces' points too (smoothing); attributes stay on the edge (no sliding)
		const mid = avgRows(ends);
		if (e.faces.length === 2) mid[0] = avg([V[e.a], V[e.b], facePts[e.faces[0]][0], facePts[e.faces[1]][0]]);
		eIndex.set(id, out.push(mid) - 1);
	}
	/** per vertex: its faces and edges */
	const vFaces = V.map(() => /** @type {number[]} */ ([]));
	const vEdges = V.map(() => /** @type {any[]} */ ([]));
	m.faces.forEach((f, fi) => f.forEach((v) => vFaces[v].push(fi)));
	for (const e of edges.values()) {
		vEdges[e.a].push(e);
		vEdges[e.b].push(e);
	}
	for (let i = 0; i < V.length; i++) {
		if (!vFaces[i].length) continue; // a vertex no face uses is dropped
		const r = row(i);
		const border = vEdges[i].filter((e) => e.faces.length === 1);
		/** @type {number[]} */
		let p;
		if (border.length >= 2) {
			// the crease rule: a border vertex follows its two border neighbours only
			const nb = border.slice(0, 2).map((e) => V[e.a === i ? e.b : e.a]);
			p = V[i].map((x, k) => (6 * x + nb[0][k] + nb[1][k]) / 8);
		} else {
			const n = vFaces[i].length;
			const F = avg(vFaces[i].map((fi) => facePts[fi][0]));
			const R = avg(vEdges[i].map((e) => avg([V[e.a], V[e.b]])));
			p = V[i].map((x, k) => (F[k] + 2 * R[k] + (n - 3) * x) / n);
		}
		vIndex.set(i, out.push([p, ...r.slice(1)]) - 1);
	}
	/** @type {number[][]} */
	const faces = [];
	/** @type {number[]} */
	const faceMaterials = [];
	m.faces.forEach((f, fi) => {
		for (let k = 0; k < f.length; k++) {
			const v = f[k];
			const next = f[(k + 1) % f.length];
			const prev = f[(k - 1 + f.length) % f.length];
			// the same winding as the source face: corner, edge to next, centre, edge from prev
			faces.push([vIndex.get(v), eIndex.get(key(v, next)), fIndex[fi], eIndex.get(key(prev, v))]);
			if (m.faceMaterials) faceMaterials.push(m.faceMaterials[fi]);
		}
	});
	/** @type {any} */
	const res = { vertices: out.map((p) => p[0]), faces };
	attrs.forEach((k, a) => (res[k] = out.map((p) => p[a + 1])));
	if (m.faceMaterials) res.faceMaterials = faceMaterials;
	return res;
}

