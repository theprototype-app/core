// @ts-nocheck — fixture states built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K2: the commit service's pure half (src/lib/meshCommit.js).
//  1. THE WIRE IS UNCHANGED: `meshGeoMessage` builds, byte for byte and key for key, what each of
//     the five hand-built senders built before K2 (copied verbatim below from v1.72.0), for every
//     shape they sent: bare positions, groups, uvs, colours, the CSR topology.
//  2. History keeps typed arrays (`compactMeshState`) WITHOUT changing a value the replay applies
//     or sends: every number is the Float32 the apply and the wire already rounded it to, and the
//     replay's topology bytes are what packing the old `faces` gave.
//  3. `entryBytes` counts what is held: a compact entry's count is the sum of its byteLengths.
//  4. The kernel's output is a commit state (meshCommitKernel `commitStateFromKernel`), with ID
//     channels on ask, and they rebuild the same IDs (undo keeps element IDs).
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

const sent = [];
vi.mock('../../src/stores/appStore', async () => {
	const { writable } = await import('svelte/store');
	return { peers: writable({ send: (m) => sent.push(m) }) };
});

const { meshGeoMessage, sendMeshGeo, compactMeshState, stateFaceFields } =
	await import('../../src/lib/meshCommit.js');
const { commitStateFromKernel } = await import('../../src/lib/meshCommitKernel.js');
const { packFaces } = await import('../../src/lib/meshTopology.js');
const { entryBytes } = await import('../../src/lib/meshBudget.js');
const { fromBufferGeometry, fromMeshGeo, toArrays } =
	await import('../../src/lib/meshKernel/index.js');

// ---- the pre-K2 senders, verbatim (v1.72.0) ------------------------------------------------
/** faceEdit.broadcastMeshGeo (faceFields = facesWireFields of the object's stored partition) */
function oldBroadcastMeshGeo(uuid, positions, groups, uvs, colors, faceFields) {
	return {
		type: 'meshgeo',
		uuid: uuid,
		positions: new Float32Array(positions).buffer,
		...(groups?.length ? { groups } : {}),
		...(uvs?.length ? { uvs: new Float32Array(uvs).buffer } : {}),
		...(colors?.length ? { colors: new Float32Array(colors).buffer } : {}),
		...faceFields
	};
}
/** the 'meshgeo' history replay */
function oldReplay(entry, state) {
	const positions = state?.positions ?? state;
	const groups = state?.positions ? state.groups : undefined;
	const uvs = state?.positions ? state.uvs : undefined;
	const colors = state?.positions ? state.colors : undefined;
	const packed = state?.faces ? packFaces(state.faces) : null;
	return {
		type: 'meshgeo',
		uuid: entry.uuid,
		positions: new Float32Array(positions).buffer,
		...(groups?.length ? { groups } : {}),
		...(uvs?.length ? { uvs: new Float32Array(uvs).buffer } : {}),
		...(colors?.length ? { colors: new Float32Array(colors).buffer } : {}),
		...(packed ? packed : {})
	};
}
/** uvEditor.broadcastUvGeo */
function oldUvGeo(uuid, snapshot) {
	return {
		type: 'meshgeo',
		uuid: uuid,
		positions: new Float32Array(snapshot.positions).buffer,
		...(snapshot.groups?.length ? { groups: snapshot.groups } : {}),
		...(snapshot.uvs?.length ? { uvs: new Float32Array(snapshot.uvs).buffer } : {})
	};
}
/** terrainSculpt (index conversion + stroke preview) */
function oldSculpt(uuid, array) {
	return { type: 'meshgeo', uuid, positions: new Float32Array(array).buffer };
}

/** a message as comparable data: key order + every buffer's bytes */
function wire(msg) {
	return Object.entries(msg).map(([k, v]) => [
		k,
		v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v
	]);
}

/** seeded mulberry32 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function fixture(seed, tris, { groups = false, uvs = false, colors = false, faces = false } = {}) {
	const r = rng(seed);
	const n = (k) => Array.from({ length: k }, () => (r() - 0.5) * 200); // doubles, |x| up to 100
	const state = { positions: n(tris * 9) };
	state.groups = groups
		? [
				{ start: 0, count: 3, materialIndex: 0 },
				{ start: 3, count: (tris - 1) * 3, materialIndex: 1 }
			]
		: null;
	state.uvs = uvs ? n(tris * 6) : null;
	if (colors) state.colors = Array.from({ length: tris * 9 }, () => r());
	if (faces) {
		state.faces = [];
		for (let t = 0; t + 1 < tris; t += 2) state.faces.push([t, t + 1]);
		if (tris % 2) state.faces.push([tris - 1]);
	}
	return state;
}
const SHAPES = [
	{},
	{ groups: true },
	{ uvs: true },
	{ uvs: true, groups: true, faces: true },
	{ colors: true },
	{ uvs: true, colors: true, faces: true, groups: true }
];

describe('1. the wire is unchanged', () => {
	it('faceEdit broadcastMeshGeo: same keys, same order, same bytes, every shape', () => {
		SHAPES.forEach((shape, i) => {
			const s = fixture(10 + i, 7, shape);
			const faceFields = s.faces ? packFaces(s.faces) : {};
			const before = oldBroadcastMeshGeo('u', s.positions, s.groups, s.uvs, s.colors, faceFields);
			const now = meshGeoMessage('u', s.positions, {
				groups: s.groups,
				uvs: s.uvs,
				colors: s.colors,
				faceFields: s.faces ? faceFields : null
			});
			expect(wire(now)).toEqual(wire(before));
		});
	});

	it('the history replay: the old plain state and the compact state both send the old bytes', () => {
		SHAPES.forEach((shape, i) => {
			const s = fixture(20 + i, 9, shape);
			const before = oldReplay({ uuid: 'u' }, s);
			for (const state of [s, compactMeshState(s)]) {
				const positions = state.positions;
				const now = meshGeoMessage('u', positions, {
					groups: state.groups,
					uvs: state.uvs,
					colors: state.colors,
					faceFields: stateFaceFields(state)
				});
				expect(wire(now)).toEqual(wire(before));
			}
		});
		// a bare positions array (sculpt strokes, vertex drags, VR grabs)
		const bare = fixture(30, 5).positions;
		const before = oldReplay({ uuid: 'u' }, bare);
		for (const state of [bare, compactMeshState(bare)])
			expect(wire(meshGeoMessage('u', state, { faceFields: stateFaceFields(state) }))).toEqual(
				wire(before)
			);
	});

	it('the UV editor and terrain sculpt messages', () => {
		const s = fixture(40, 6, { uvs: true, groups: true });
		expect(wire(meshGeoMessage('u', s.positions, { groups: s.groups, uvs: s.uvs }))).toEqual(
			wire(oldUvGeo('u', s))
		);
		const attr = new Float32Array(fixture(41, 6).positions);
		expect(wire(meshGeoMessage('u', attr))).toEqual(wire(oldSculpt('u', attr)));
	});

	it('empty fields stay absent (an older peer reads the message it always did)', () => {
		const msg = meshGeoMessage('u', [0, 0, 0, 1, 0, 0, 0, 1, 0], {
			groups: [],
			uvs: [],
			colors: null,
			faceFields: null
		});
		expect(Object.keys(msg)).toEqual(['type', 'uuid', 'positions']);
	});

	it('sendMeshGeo sends exactly that message and reports it', () => {
		sent.length = 0;
		const s = fixture(50, 4, { uvs: true });
		expect(sendMeshGeo('u', s.positions, { uvs: s.uvs })).toBe(true);
		expect(sent).toHaveLength(1);
		expect(wire(sent[0])).toEqual(
			wire(oldUvGeo('u', { positions: s.positions, groups: null, uvs: s.uvs }))
		);
	});
});

describe('2. history keeps typed arrays, not different values', () => {
	it('every value is the Float32 the apply and the wire already used', () => {
		const s = fixture(60, 11, { uvs: true, colors: true, faces: true, groups: true });
		const c = compactMeshState(s);
		expect(c.positions).toBeInstanceOf(Float32Array);
		expect(Array.from(c.positions)).toEqual(Array.from(new Float32Array(s.positions)));
		expect(Array.from(c.uvs)).toEqual(Array.from(new Float32Array(s.uvs)));
		expect(Array.from(c.colors)).toEqual(Array.from(new Float32Array(s.colors)));
		expect(c.groups).toBe(s.groups);
		expect('faces' in c).toBe(false);
		expect(c.faceCounts).toBeInstanceOf(Int32Array);
		const packed = packFaces(s.faces);
		expect(Array.from(c.faceCounts)).toEqual(Array.from(new Int32Array(packed.faceCounts)));
		expect(Array.from(c.faceTris)).toEqual(Array.from(new Int32Array(packed.faceTris)));
	});

	it('is idempotent, and leaves the caller its own object', () => {
		const s = fixture(61, 5, { uvs: true, faces: true });
		const copy = JSON.parse(JSON.stringify(s));
		const once = compactMeshState(s);
		const twice = compactMeshState(once);
		expect(twice.positions).toBe(once.positions);
		expect(Array.from(twice.faceTris)).toEqual(Array.from(once.faceTris));
		expect(s).toEqual(copy); // the operator's own `before` (a grab's cancel reads it) is untouched
	});

	it('null / empty partitions stay absent; non-geometry passes through', () => {
		expect('faceCounts' in compactMeshState({ positions: [0, 0, 0], faces: null })).toBe(false);
		expect('faceCounts' in compactMeshState({ positions: [0, 0, 0], faces: [] })).toBe(false);
		expect(stateFaceFields(compactMeshState({ positions: [0, 0, 0], faces: [] }))).toBe(null);
		expect(compactMeshState(null)).toBe(null);
		const other = { pos: { x: 1 } };
		expect(compactMeshState(other)).toBe(other);
		expect(compactMeshState([1, 2, 3])).toBeInstanceOf(Float32Array);
	});
});

describe('3. entryBytes counts what is held', () => {
	it('a compact entry = the sum of its byteLengths (ids included)', () => {
		const s = fixture(70, 13, { uvs: true, colors: true, faces: true });
		const before = compactMeshState({
			...s,
			ids: { cornerVertex: new Int32Array(39), triFace: new Int32Array(13) }
		});
		const after = compactMeshState(fixture(71, 13, { uvs: true, faces: true }));
		const held = (st) =>
			['positions', 'uvs', 'colors', 'faceCounts', 'faceTris'].reduce(
				(n, k) => n + (st[k]?.byteLength ?? 0),
				0
			) + (st.ids ? st.ids.cornerVertex.byteLength + st.ids.triFace.byteLength : 0);
		expect(entryBytes({ kind: 'meshgeo', before, after })).toBe(held(before) + held(after));
		expect(
			entryBytes({ kind: 'meshgeo', before: compactMeshState(s.positions), after: null })
		).toBe(s.positions.length * 4);
	});
});

describe('4. the kernel output is a commit state', () => {
	it('toMeshGeo through compactMeshState, and the ID channels rebuild the same IDs', () => {
		const g = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).toNonIndexed();
		const { mesh } = fromBufferGeometry(g);
		const state = commitStateFromKernel(mesh, { ids: true });
		expect(state.positions).toBeInstanceOf(Float32Array);
		expect(state.ids.cornerVertex).toBeInstanceOf(Int32Array);
		expect(state.ids.triFace.length).toBe(state.positions.length / 9);
		const out = toArrays(mesh);
		expect(Array.from(state.positions)).toEqual(Array.from(out.positions));
		// undo rebuilds from the stored arrays + IDs: same vertex and face IDs
		const msg = {
			positions: state.positions.buffer,
			uvs: state.uvs?.buffer,
			faceCounts: state.faceCounts?.buffer,
			faceTris: state.faceTris?.buffer,
			ids: { cornerVertex: state.ids.cornerVertex.buffer, triFace: state.ids.triFace.buffer }
		};
		const { mesh: back } = fromMeshGeo(msg);
		expect(Array.from(toArrays(back).cornerVertex)).toEqual(Array.from(out.cornerVertex));
		expect(Array.from(toArrays(back).triFace)).toEqual(Array.from(out.triFace));
	});
});
