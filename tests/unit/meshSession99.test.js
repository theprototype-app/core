// @ts-nocheck — scene JSON is parsed ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K3: the ONE edit session (editSession.js + editSessionState.js + meshSession.js).
//  1. ENTER + LEAVE IS LOSSLESS on every mesh of every scene: a session opened on the mesh, its
//     kernel built with the editor's weld (what the session does after entry), then sealed with
//     nothing edited, leaves the geometry byte-identical — every attribute, the index, the groups,
//     the stored partition — and says it re-emitted the ENTRY arrays. The counterfactual is
//     measured, not assumed: on the same meshes the kernel's welded output differs from the input
//     for N meshes, which is why the leave re-emits the entry rather than the kernel.
//     Sources: static/templates + tests/fixtures + SCENES_DIR (the K1 convention; the proof sets
//     it to a scenes checkout at 3d3c99c, K1's 1818-mesh set).
//  2. "Edited" is any geometry swap or in-place write; the leave then emits the live geometry.
//  3. The kernel's ID maps keep the source triangle order, and the selection round-trips through
//     element IDs (faces, vertices, edges as vertex-ID pairs).
//  4. ID channels shared by reference between steps are counted once by the undo budget.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';

const {
	noteEditEnter,
	sealEditHistorySession,
	editSessionDebug,
	captureEntry,
	geometryChanged,
	leaveOutput,
	session
} = await import('../../src/lib/editSession.js');
const { buildSessionKernelSync, selectionToIds, idsToSelection } =
	await import('../../src/lib/meshSession.js');
const { toArrays, fromArrays, geometryArrays } = await import('../../src/lib/meshKernel/index.js');
const { compactMeshState, shareIds } = await import('../../src/lib/meshCommit.js');
const { historyBytes, entryBytes } = await import('../../src/lib/meshBudget.js');

const ROOT = path.resolve(__dirname, '../..');
const SOURCES = [
	path.join(ROOT, 'static/templates'),
	path.join(ROOT, 'tests/fixtures'),
	...(process.env.SCENES_DIR ? [path.resolve(process.env.SCENES_DIR)] : [])
];
function sceneFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
			out.push(...sceneFiles(p));
		else if (e.name.endsWith('.tpscene')) out.push(p);
	}
	return out;
}
function elementsOf(doc, out = []) {
	if (!doc || typeof doc !== 'object') return out;
	if (!Array.isArray(doc) && doc.metadata?.type === 'Object' && doc.object) out.push(doc);
	else for (const v of Array.isArray(doc) ? doc : Object.values(doc)) elementsOf(v, out);
	return out;
}
function geometriesOf(file) {
	const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
	const loader = new THREE.ObjectLoader();
	const out = [];
	for (const [name, data] of Object.entries(zip)) {
		if (!name.endsWith('.json') || name.startsWith('assets/')) continue;
		for (const el of elementsOf(JSON.parse(strFromU8(data)))) {
			const built = loader.parseGeometries(el.geometries ?? []);
			for (const g of Object.values(built)) if (g?.attributes?.position) out.push(g);
		}
	}
	return out;
}

/** every byte of a geometry, as one comparable string */
function bytesOf(g) {
	const parts = [];
	for (const name of Object.keys(g.attributes).sort()) {
		const a = g.attributes[name];
		parts.push(
			name,
			a.itemSize,
			a.normalized,
			Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength).toString('base64')
		);
	}
	if (g.index)
		parts.push(
			'index',
			Buffer.from(
				g.index.array.buffer,
				g.index.array.byteOffset,
				g.index.array.byteLength
			).toString('base64')
		);
	parts.push(JSON.stringify(g.groups), JSON.stringify(g.userData?.__topo ?? null));
	return parts.join('|');
}
/** de-indexed corner values of one attribute */
function expanded(g, name) {
	const attr = g.attributes[name];
	const index = g.index;
	const count = index ? index.count : attr.count;
	const out = new Float32Array(count * attr.itemSize);
	const get = ['getX', 'getY', 'getZ', 'getW'];
	for (let i = 0; i < count; i++) {
		const j = index ? index.getX(i) : i;
		for (let k = 0; k < attr.itemSize; k++) out[i * attr.itemSize + k] = attr[get[k]](j);
	}
	return out;
}
function same(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(a[i] === 0 && b[i] === 0)) return false;
	return true;
}

const files = SOURCES.flatMap(sceneFiles);
const totals = {
	scenes: 0,
	meshes: 0,
	triangles: 0,
	leftIdentical: 0,
	weldDiffers: 0,
	orderKept: 0
};

describe('1. enter + leave with nothing edited is byte-identical, on every mesh of every scene', () => {
	it('finds the content (premise)', () => expect(files.length).toBeGreaterThan(0));
	let n = 0;
	for (const file of files) {
		it(path.basename(file), () => {
			totals.scenes++;
			for (const geometry of geometriesOf(file)) {
				const object = { uuid: 'mesh-' + n++, geometry };
				const before = bytesOf(geometry);
				noteEditEnter('face', object.uuid, object);
				expect(session.uuid).toBe(object.uuid);
				// what the session builds after entry (off-thread in the app): the kernel with the weld
				const built = buildSessionKernelSync(geometry);
				const tris =
					(geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
				if (built.triFace.length === tris) totals.orderKept++;
				// the counterfactual: would re-emitting the KERNEL have been lossless?
				const out = toArrays(fromArrays(geometryArrays(geometry).arrays, { weld: 1e-4 }).mesh);
				if (!same(out.positions, expanded(geometry, 'position'))) totals.weldDiffers++;
				sealEditHistorySession();
				const leave = editSessionDebug().lastLeave;
				expect(leave.uuid).toBe(object.uuid);
				expect(leave.source).toBe('entry');
				expect(leave.edited).toBe(false);
				expect(object.geometry).toBe(geometry);
				expect(bytesOf(object.geometry)).toBe(before);
				totals.leftIdentical++;
				totals.meshes++;
				totals.triangles += tris;
			}
		});
	}
	it('summary', () => {
		console.log(
			`[99 K3] enter+leave: ${totals.scenes} scenes, ${totals.meshes} meshes, ${totals.triangles} triangles — ` +
				`${totals.leftIdentical} left byte-identical (re-emit = entry); the kernel's welded output differs from the input on ` +
				`${totals.weldDiffers} of them (why the leave re-emits the entry); triangle order kept by the ID maps on ${totals.orderKept}`
		);
		expect(totals.leftIdentical).toBe(totals.meshes);
		expect(totals.orderKept).toBe(totals.meshes);
	});
});

describe('2. edited = a swap or an in-place write', () => {
	it('a swapped geometry leaves as the live one', () => {
		const object = { uuid: 'swap', geometry: new THREE.BoxGeometry(1, 1, 1) };
		noteEditEnter('face', object.uuid, object);
		expect(leaveOutput().source).toBe('entry');
		object.geometry = new THREE.BoxGeometry(2, 1, 1);
		expect(leaveOutput().source).toBe('live');
		sealEditHistorySession();
		expect(editSessionDebug().lastLeave).toMatchObject({
			uuid: 'swap',
			source: 'live',
			edited: true
		});
	});
	it('an in-place write (needsUpdate) counts; a mode switch on the same mesh keeps the session', () => {
		const geometry = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
		const object = { uuid: 'drag', geometry };
		noteEditEnter('vertex', 'drag', object);
		const entry = session.entry;
		noteEditEnter('face', 'drag', object); // Vertices -> Faces: the same session
		expect(session.entry).toBe(entry);
		geometry.attributes.position.array[0] += 0.5;
		geometry.attributes.position.needsUpdate = true;
		expect(geometryChanged(entry, geometry)).toBe(true);
		sealEditHistorySession();
		expect(editSessionDebug().lastLeave.source).toBe('live');
	});
	it('captureEntry holds references, not copies (no memory per session)', () => {
		const g = new THREE.BoxGeometry(1, 1, 1);
		const e = captureEntry(g);
		expect(e.attributes.position[0]).toBe(g.attributes.position);
	});
});

describe('3. the selection as element IDs', () => {
	const keyOf = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
	it('faces, vertices and edges (vertex-ID pairs) round-trip on an indexed box', () => {
		const g = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
		const maps = buildSessionKernelSync(g);
		const tris = [0, 1, 7, 30];
		const ids = selectionToIds(
			maps,
			g,
			{
				tris,
				handles: [[0], [5, 9]],
				edgeKeys: [`${keyOf(0.5, 0.5, 0.5)}|${keyOf(0.5, 0.5, 0)}`]
			},
			keyOf
		);
		const back = idsToSelection(maps, g, ids);
		// no stored partition: each triangle is its own face, so the round trip is exact
		expect(back.tris).toEqual(tris);
		expect(ids.verts.length).toBeGreaterThan(0);
		// every attribute index of a selected vertex comes back, including its seam copies
		for (const a of [0, 5, 9]) expect(back.attrs).toContain(a);
		expect(ids.edges).toHaveLength(1);
		expect(ids.edges[0][0]).toBeLessThan(ids.edges[0][1]);
		const [pa, pb] = back.edgeAttrs[0];
		const p = g.attributes.position;
		const ends = [
			keyOf(p.getX(pa), p.getY(pa), p.getZ(pa)),
			keyOf(p.getX(pb), p.getY(pb), p.getZ(pb))
		].sort();
		expect(ends).toEqual([keyOf(0.5, 0.5, 0.5), keyOf(0.5, 0.5, 0)].sort());
	});
	it('a stored partition makes a quad ONE face ID', () => {
		const g = new THREE.PlaneGeometry(1, 1, 2, 2).toNonIndexed();
		g.userData.__topo = { counts: [2, 2, 2, 2], tris: [0, 1, 2, 3, 4, 5, 6, 7] };
		const maps = buildSessionKernelSync(g);
		const ids = selectionToIds(maps, g, { tris: [2, 3] }, keyOf);
		expect(ids.faces).toHaveLength(1);
		expect(idsToSelection(maps, g, ids).tris).toEqual([2, 3]);
	});
});

describe('4. shared ID channels are counted once', () => {
	const ids = () => ({
		cornerVertex: Int32Array.from({ length: 300 }, (_, i) => i % 100),
		triFace: Int32Array.from({ length: 100 }, (_, i) => i)
	});
	const side = (k, withIds) =>
		compactMeshState({
			positions: Array.from({ length: 900 }, (_, i) => i + k),
			groups: null,
			uvs: null,
			ids: withIds
		});
	it('a positions-only step shares the previous step ids; a topology step keeps its own', () => {
		const a = side(0, ids());
		const b = shareIds(side(1, ids()), a);
		expect(b.ids).toBe(a.ids);
		const changed = ids();
		changed.triFace[3] = 99;
		const c = shareIds(side(2, changed), b);
		expect(c.ids).not.toBe(b.ids);
		const e1 = { kind: 'meshgeo', before: a, after: b };
		const e2 = { kind: 'meshgeo', before: b, after: c };
		const idBytes = 300 * 4 + 100 * 4;
		const posBytes = 900 * 4;
		expect(entryBytes(e1)).toBe(2 * posBytes + 2 * idBytes); // alone, each side counts
		// the stack: positions a, b, b (shared object), c; ids a(=b) once, c once
		expect(historyBytes([e1, e2])).toBe(3 * posBytes + 2 * idBytes);
	});
});
