// @ts-nocheck — bench runner (node)
// Roadmap 99 K2 row 2: what one face-op undo step costs on a 67k-triangle mesh, before and after
// K2, counted (meshBudget.entryBytes, what HISTORY_BYTES bounds) AND held (GC'd heap), and how
// many such steps the unchanged 256 MB budget keeps.
//   before K2: history kept the op's plain number arrays (8 B per number in V8) and the face
//              partition as number[][]; entryBytes counted 4 B per number.
//   after K2:  commitMesh keeps compactMeshState typed arrays (Float32 positions / uvs, the
//              partition packed Int32), counted at their byteLength. Optional: the kernel's ID
//              channels (+16 B/tri per side) for the K3 session's ID-preserving undo.
// Run: NODE_OPTIONS='--expose-gc --max-old-space-size=8192' npx vitest run --config tests/bench/vitest.bench.config.js meshHistory
import { it } from 'vitest';
import fs from 'fs';
import os from 'os';
import { makeMesh } from './meshKernelBench.js';
import { compactMeshState } from '$lib/meshCommit.js';
import { commitStateFromKernel } from '$lib/meshCommitKernel.js';
import { HISTORY_BYTES } from '$lib/meshBudget.js';
import { fromBufferGeometry } from '$lib/meshKernel/index.js';

/** entryBytes as it was before K2 (meshBudget.js at v1.72.0), verbatim */
function entryBytesBase(entry) {
	let total = 0;
	for (const state of [entry.before, entry.after]) {
		if (!state) continue;
		if (Array.isArray(state)) {
			total += state.length * 4;
			continue;
		}
		for (const key of ['positions', 'uvs', 'faceTris', 'faceCounts']) {
			const value = state[key];
			if (Array.isArray(value)) total += value.length * 4;
			else if (value?.byteLength) total += value.byteLength;
		}
		if (Array.isArray(state.faces))
			for (const face of state.faces) total += (face?.length ?? 0) * 4;
	}
	return total;
}

async function heap() {
	globalThis.gc?.();
	globalThis.gc?.();
	const m = process.memoryUsage();
	return m.heapUsed + m.arrayBuffers;
}

/** retained bytes of `count` built values (the larger of held-before / held-after) */
async function retained(build, count) {
	const before = await heap();
	let kept = Array.from({ length: count }, (_, i) => build(i));
	const held = await heap();
	void kept;
	kept = null;
	const after = await heap();
	return Math.max(held - before, held - after) / count;
}

it('meshgeo history bytes per undo step (node)', async () => {
	const g = makeMesh('grid', process.env.BENCH_SIZE ?? '67k');
	const tris = g.attributes.position.count / 3;
	const pos = g.attributes.position.array;
	const uv = g.attributes.uv.array;
	const partition = [];
	for (let t = 0; t < tris; t += 2) partition.push([t, t + 1]);
	// one face-op side exactly as an operator hands it over: plain arrays from trisToPositions /
	// trisToUVs (fresh doubles), groups null (one material), the stored partition
	const plainSide = (k) => ({
		positions: Array.from(pos, (v) => v + k * 1e-9),
		groups: null,
		uvs: Array.from(uv, (v) => v + k * 1e-9),
		faces: partition.map((f) => [...f])
	});
	const baseEntry = (k) => ({ kind: 'meshgeo', before: plainSide(k), after: plainSide(k + 0.5) });
	const k2Entry = (k) => ({
		kind: 'meshgeo',
		before: compactMeshState(plainSide(k)),
		after: compactMeshState(plainSide(k + 0.5))
	});
	const { entryBytes } = await import('$lib/meshBudget.js');
	const { mesh } = fromBufferGeometry(g, { weld: 1e-4 });
	const idSide = commitStateFromKernel(mesh, { ids: true });
	const idEntry = () => ({ kind: 'meshgeo', before: idSide, after: idSide });

	const N = Number(process.env.BENCH_ENTRIES ?? 8);
	const rows = [];
	const row = async (name, build, counted) => {
		const held = await retained(build, N);
		rows.push({
			name,
			'counted B/step': counted,
			'held B/step': Math.round(held),
			'steps in 256 MB (counted)': Math.floor(HISTORY_BYTES / counted),
			'held MB at the cap': Math.round((Math.floor(HISTORY_BYTES / counted) * held) / 2 ** 20)
		});
	};
	await row('before K2 (plain arrays)', baseEntry, entryBytesBase(baseEntry(0)));
	await row('after K2 (typed arrays)', k2Entry, entryBytes(k2Entry(0)));
	const idCounted = entryBytes({ before: idSide, after: idSide });
	rows.push({
		name: 'after K2 + ID channels (K3 session)',
		'counted B/step': idCounted,
		'held B/step': idCounted,
		'steps in 256 MB (counted)': Math.floor(HISTORY_BYTES / idCounted),
		'held MB at the cap': Math.round((Math.floor(HISTORY_BYTES / idCounted) * idCounted) / 2 ** 20)
	});
	void idEntry;
	const title = `meshgeo undo step, ${tris} triangles (quad grid, uvs, one material) — node ${process.version}, ${os.cpus()[0]?.model ?? 'cpu'}, gc ${typeof globalThis.gc === 'function' ? 'exposed' : 'off'}, ${N} entries held`;
	const keys = Object.keys(rows[0]);
	const table = [
		`### ${title}`,
		'',
		'| ' + keys.join(' | ') + ' |',
		'|' + keys.map(() => '---').join('|') + '|',
		...rows.map((r) => '| ' + keys.map((k) => r[k]).join(' | ') + ' |')
	].join('\n');
	console.log(table);
	if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, table + '\n');
});

// 99 K3 (claude:9's ask): undo steps per EDIT KIND once states carry the kernel's ID channels, with
// the channels shared by reference between steps whose topology did not change (meshCommit
// `shareIds`, counted once by meshBudget `historyBytes`) versus every side holding its own copy.
// A real stack is built entry by entry the way faceEdit's meshGeoEntry builds it (before shares
// the previous step's after, after shares its own before when the topology held) and trimmed the
// way history.recordEntry trims it, so the step counts are the stack's, not arithmetic.
it('undo steps per edit kind with shared ID channels (node)', async () => {
	const { shareIds } = await import('$lib/meshCommit.js');
	const { historyBytes } = await import('$lib/meshBudget.js');
	const g = makeMesh('grid', process.env.BENCH_SIZE ?? '67k');
	const tris = g.attributes.position.count / 3;
	const { mesh } = fromBufferGeometry(g, { weld: 1e-4 });
	const base = commitStateFromKernel(mesh, { ids: true });
	// every array is a FRESH copy per side (a commit snapshots the geometry anew each time), so only
	// what shareIds shares can be counted once
	const copy = (v) => (ArrayBuffer.isView(v) ? v.slice() : v);
	const side = (k, ids) => {
		const s = {};
		for (const [key, v] of Object.entries(base)) if (key !== 'ids') s[key] = copy(v);
		s.positions = base.positions.map((v) => v + k * 1e-3);
		if (ids) s.ids = { cornerVertex: ids.cornerVertex.slice(), triFace: ids.triFace.slice() };
		return compactMeshState(s);
	};
	/** fill a stack under the budget the way history.recordEntry trims it. A step's BEFORE is the
	 * state the previous step left (same IDs by value, a new copy); its AFTER keeps those IDs for a
	 * positions-only edit and mints new ones for a topology edit. */
	const fill = (topology, mode) => {
		const stack = [];
		let ids = base.ids;
		/** @type {any} */ let prevAfter = null;
		for (let k = 1; k < 400; k++) {
			const before = side(k - 1, mode === 'none' ? null : ids);
			if (topology) {
				ids = { cornerVertex: ids.cornerVertex.slice(), triFace: ids.triFace.slice() };
				ids.triFace[k % ids.triFace.length] = -k;
			}
			const after = side(k, mode === 'none' ? null : ids);
			if (mode === 'shared') {
				shareIds(before, prevAfter);
				shareIds(after, before, prevAfter);
			}
			prevAfter = after;
			stack.push({ kind: 'meshgeo', uuid: 'bench', before, after });
			let bytes = historyBytes(stack);
			while (bytes > HISTORY_BYTES && stack.length > 1) {
				stack.shift();
				bytes = historyBytes(stack);
			}
			if (stack.length < k) return { steps: stack.length, bytes };
		}
		return { steps: stack.length, bytes: historyBytes(stack) };
	};
	const rows = [];
	for (const [kind, topology] of [
		['positions only (move, drag, sculpt, snapshot)', false],
		['topology (extrude, inset, cut, delete)', true]
	]) {
		const none = fill(topology, 'none');
		const own = fill(topology, 'own');
		const shared = fill(topology, 'shared');
		rows.push({
			'edit kind': kind,
			'no ID channels (K3 as shipped)': none.steps,
			'ID channels, own copy per side': own.steps,
			'ID channels, shared when unchanged': shared.steps,
			'stack MB (shared)': Math.round(shared.bytes / 2 ** 20)
		});
	}
	const keys = Object.keys(rows[0]);
	const table = [
		`### undo steps in the unchanged 256 MB budget, ${tris} triangles, per edit kind`,
		'',
		'| ' + keys.join(' | ') + ' |',
		'|' + keys.map(() => '---').join('|') + '|',
		...rows.map((r) => '| ' + keys.map((k) => r[k]).join(' | ') + ' |')
	].join('\n');
	console.log(table);
	if (process.env.BENCH_OUT) fs.appendFileSync(process.env.BENCH_OUT, '\n' + table + '\n');
});
