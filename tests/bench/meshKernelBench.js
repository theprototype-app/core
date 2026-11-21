// @ts-nocheck — bench harness
// Roadmap 99 K1 row 4: the kernel bench. ONE module, run by node (meshKernel.bench.test.js) and by
// the Deck's browser (meshKernelBrowser.cjs imports it from the vite dev server), so both measure
// the same code on the same meshes.
//
// Meshes: a UV sphere and a quad grid as NON-INDEXED SOUPS (the form an edited mesh has), at
// ~10k / 67k (the audit's edit-entry number) / 100k / 1M triangles.
// Paths, per mesh:
//   kernel.import      fromBufferGeometry, exact weld (lossless) — the adjacency build
//   kernel.import1e-4  the same with weld 1e-4 (the editor's keyOf tolerance)
//   kernel.topo        the grid with its quad partition stored (__topo): n-gon import
//   kernel.ring        one-ring walk of every vertex (vertexFaces) — adjacency query cost
//   kernel.output      toArrays (what a commit would emit)
//   kernel.dissolve    the grid imported WITHOUT its partition, then every quad's diagonal dissolved
//                      (dissolveEdge): what today's pairQuads infers, done as K4 edits
//   kernel.hash        spatialHash over the live vertices + one radius query per vertex (brush-sized)
//   today.enter        readTriangles + groupFaces + pairQuads = faceEdit's rebuildFaces, i.e. what
//                      entering edit mode costs today (the "workingTris path")
// Memory: kernel = exact typed-array bytes in use (byteSize().used) per triangle; both paths also
// as a GC'd heap delta when the runtime exposes one (node --expose-gc; Chromium performance.memory).
import * as THREE from 'three';
import { fromBufferGeometry, toArrays } from '$lib/meshKernel/index.js';
import { readTriangles, groupFaces, pairQuads } from '$lib/faceEdit.js';

/** sphere segments for ~N triangles (2 * w * (h - 1)) */
const SIZES = { '10k': [100, 51], '67k': [260, 130], '100k': [316, 159], '1M': [1000, 501] };

/** @param {string} kind @param {string} size */
export function makeMesh(kind, size) {
	const [w, h] = SIZES[size];
	if (kind === 'sphere') return new THREE.SphereGeometry(1, w, h).toNonIndexed();
	// grid: sqrt(N/2) quads a side, partition = consecutive triangle pairs (PlaneGeometry's order)
	const n = Math.round(Math.sqrt((2 * w * (h - 1)) / 2));
	const g = new THREE.PlaneGeometry(1, 1, n, n).toNonIndexed();
	const tris = g.attributes.position.count / 3;
	const counts = new Array(tris / 2).fill(2);
	const list = Array.from({ length: tris }, (_, i) => i);
	g.userData.__topo = { counts, tris: list };
	return g;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** GC'd heap in bytes, or null when the runtime does not expose one */
async function heap() {
	if (typeof globalThis.gc === 'function') {
		globalThis.gc();
		globalThis.gc();
	}
	if (typeof process !== 'undefined' && process.memoryUsage) {
		const m = process.memoryUsage();
		return m.heapUsed + m.arrayBuffers;
	}
	if (typeof performance !== 'undefined' && performance.memory) {
		await new Promise((r) => setTimeout(r, 50));
		return performance.memory.usedJSHeapSize;
	}
	return null;
}

/**
 * Heap retained by ONE build: GC, build, GC with the result still held, GC again after dropping it.
 * Reported as the larger of (held - before) and (held - after): the second is immune to garbage
 * the build left behind being collected late.
 * @param {() => any} build
 */
async function retained(build) {
	const before = await heap();
	if (before === null) return null;
	let kept = build();
	const held = await heap();
	void kept;
	kept = null;
	const after = await heap();
	return Math.max(held - before, held - after);
}

/** median of `runs` timings of fn @param {() => any} fn */
function time(fn, runs) {
	const out = [];
	let last;
	for (let i = 0; i < runs; i++) {
		const t0 = now();
		last = fn();
		out.push(now() - t0);
	}
	out.sort((a, b) => a - b);
	return { ms: out[Math.floor(out.length / 2)], result: last };
}

/**
 * @param {{ sizes?: string[], todayMax?: string, runs?: number, log?: (s: string) => void }} [options]
 *   `todayMax`: the largest size the old path is run at (it is quadratic in places and holds a
 *   Vector3 per corner; 1M can take minutes and gigabytes)
 */
export async function runBench(options = {}) {
	const sizes = options.sizes ?? ['10k', '67k', '100k', '1M'];
	const order = ['10k', '67k', '100k', '1M'];
	const todayMax = order.indexOf(options.todayMax ?? '1M');
	const log = options.log ?? (() => {});
	const rows = [];
	for (const size of sizes) {
		const runs = size === '1M' ? 1 : (options.runs ?? 3);
		const sphere = makeMesh('sphere', size);
		const tris = sphere.attributes.position.count / 3;
		const row = { size, triangles: tris };

		const imp = time(() => fromBufferGeometry(sphere), runs);
		row['kernel.import ms'] = imp.ms;
		const mesh = imp.result.mesh;
		const bytes = mesh.byteSize();
		row['kernel bytes/tri'] = bytes.used / tris;
		const kHeap = await retained(() => fromBufferGeometry(sphere));
		row['kernel heap bytes/tri'] = kHeap === null ? null : kHeap / tris;
		row.vertices = mesh.stats().vertices;
		row.edges = mesh.stats().edges;
		row['kernel.import1e-4 ms'] = time(() => fromBufferGeometry(sphere, { weld: 1e-4 }), runs).ms;
		row['kernel.ring ms'] = time(() => {
			let s = 0;
			for (let v = 0; v < mesh.vTop; v++) s += mesh.vertexFaces(v).length;
			return s;
		}, runs).ms;
		row['kernel.output ms'] = time(() => toArrays(mesh), runs).ms;
		const grid = makeMesh('grid', size);
		const topo = time(() => fromBufferGeometry(grid), runs);
		row['kernel.topo ms'] = topo.ms;
		row['topo triangles'] = grid.attributes.position.count / 3;
		row['topo ngons'] = topo.result.report.ngons;
		const soup = grid.clone();
		soup.userData = {};
		const dissolve = time(() => {
			const g = fromBufferGeometry(soup).mesh;
			let joined = 0;
			for (let f = 0; f + 1 < g.fTop; f += 2) {
				const other = new Set(g.faceEdges(f + 1));
				const diag = g.faceEdges(f).find((e) => other.has(e));
				if (diag !== undefined && g.dissolveEdge(diag) !== -1) joined++;
			}
			return joined;
		}, runs);
		row['kernel.dissolve ms'] = dissolve.ms;
		row['dissolved quads'] = dissolve.result;
		row['kernel.hash ms'] = time(() => {
			const cell = 4 / Math.sqrt(row.vertices);
			const hash = mesh.spatialHash(cell);
			let hits = 0;
			for (let v = 0; v < mesh.vTop; v++) {
				const [x, y, z] = mesh.position(v);
				hits += hash.within(x, y, z, cell).length;
			}
			return hits;
		}, runs).ms;
		log(`${size}: kernel done ${JSON.stringify(row)}`);

		if (order.indexOf(size) <= todayMax) {
			const enterOnce = () => {
				const working = readTriangles(sphere);
				const faces = groupFaces(working);
				const partner = pairQuads(working);
				return { working, faces, partner };
			};
			row['today.enter ms'] = time(enterOnce, runs).ms;
			const tHeap = await retained(enterOnce);
			row['today heap bytes/tri'] = tHeap === null ? null : tHeap / tris;
		} else {
			row['today.enter ms'] = null;
			row['today heap bytes/tri'] = null;
		}
		log(`${size}: ${JSON.stringify(row)}`);
		rows.push(row);
	}
	return rows;
}

/** the rows as a markdown table @param {any[]} rows @param {string} title */
export function benchTable(rows, title) {
	const cols = [
		['size', 'mesh'],
		['triangles', 'tris'],
		['kernel.import ms', 'kernel build ms'],
		['kernel.import1e-4 ms', 'build+weld 1e-4 ms'],
		['kernel.ring ms', 'one-ring all verts ms'],
		['kernel.output ms', 'output ms'],
		['kernel.topo ms', 'quad-topo build ms'],
		['kernel.dissolve ms', 'build+dissolve to quads ms'],
		['kernel.hash ms', 'hash + query every vert ms'],
		['today.enter ms', 'today enter-edit ms'],
		['kernel bytes/tri', 'kernel B/tri'],
		['kernel heap bytes/tri', 'kernel heap B/tri'],
		['today heap bytes/tri', 'today heap B/tri']
	];
	const fmt = (v) => (v === null || v === undefined ? 'n/a' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 0)) : String(v));
	const lines = [`### ${title}`, '', '| ' + cols.map((c) => c[1]).join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|'];
	for (const r of rows) lines.push('| ' + cols.map((c) => fmt(r[c[0]])).join(' | ') + ' |');
	return lines.join('\n');
}
