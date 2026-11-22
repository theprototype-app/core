// @ts-nocheck — scene JSON is parsed ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K1 row 3: EVERY mesh of EVERY scene round-trips through the kernel bit-identically.
//
// Sources: the core templates (static/templates), the test fixtures, and — when SCENES_DIR names a
// scenes checkout — every .tpscene in it (the sceneSchema.test.js convention; the lane proof sets
// it). Each geometry three's ObjectLoader builds from a scene (parametric primitives included) goes
// geometry -> kernel -> geometry, and the de-indexed positions, uvs, normals, colours and the
// per-triangle material slot must come back equal value for value (Float32; -0 equals 0), with a
// stored `__topo` partition coming back as the same partition. A second pass goes through the
// meshgeo wire with IDs and must rebuild the same vertex and face IDs.
//
// The summary line (meshes, triangles, n-gons, fallbacks, degenerate) is printed for the STATUS.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { fromBufferGeometry, toArrays, toMeshGeo, fromMeshGeo } from '$lib/meshKernel/index.js';
import { toBufferGeometry } from '$lib/meshKernel/three.js';

const ROOT = path.resolve(__dirname, '../..');
const SOURCES = [
	path.join(ROOT, 'static/templates'),
	path.join(ROOT, 'tests/fixtures'),
	...(process.env.SCENES_DIR ? [path.resolve(process.env.SCENES_DIR)] : [])
];

/** @param {string} dir */
function sceneFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) out.push(...sceneFiles(p));
		else if (e.name.endsWith('.tpscene')) out.push(p);
	}
	return out;
}

/** every ObjectLoader element in a document @param {any} doc */
function elementsOf(doc, out = []) {
	if (!doc || typeof doc !== 'object') return out;
	if (!Array.isArray(doc) && doc.metadata?.type === 'Object' && doc.object) out.push(doc);
	else for (const v of Array.isArray(doc) ? doc : Object.values(doc)) elementsOf(v, out);
	return out;
}

/** geometries of a .tpscene, built the way the app's ObjectLoader builds them @param {string} file */
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

/** de-indexed corner values @param {any} g @param {string} name */
function expanded(g, name) {
	const attr = g.attributes[name];
	const index = g.index;
	const count = index ? index.count : attr.count;
	const size = attr.itemSize;
	const out = new Float32Array(count * size);
	const get = ['getX', 'getY', 'getZ', 'getW'];
	for (let i = 0; i < count; i++) {
		const j = index ? index.getX(i) : i;
		for (let k = 0; k < size; k++) out[i * size + k] = attr[get[k]](j);
	}
	return out;
}

/** per-triangle material slot as three draws it (-1 = no group covers it) @param {any} g */
function slots(g) {
	const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
	const out = new Int32Array(tris).fill(g.groups.length ? -1 : 0);
	for (const grp of g.groups) for (let c = grp.start; c < grp.start + grp.count; c++) if (c % 3 === 0 && c / 3 < tris) out[c / 3] = grp.materialIndex ?? 0;
	return out;
}

/** first differing index or -1 @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
function diff(a, b) {
	if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `at ${i}: ${a[i]} vs ${b[i]}`;
	return null;
}

const files = SOURCES.flatMap(sceneFiles);
const totals = { scenes: 0, meshes: 0, triangles: 0, ngons: 0, fallbackFaces: 0, degenerate: 0, topo: 0, closed: 0, partitionsEqual: 0 };

describe('every mesh in every scene round-trips through the kernel', () => {
	it('finds the content (premise)', () => {
		expect(files.length).toBeGreaterThanOrEqual(5); // the five core templates at least
	});
	for (const file of files) {
		it(path.relative(process.env.SCENES_DIR && file.startsWith(path.resolve(process.env.SCENES_DIR)) ? path.resolve(process.env.SCENES_DIR, '..') : ROOT, file), () => {
			const geometries = geometriesOf(file);
			totals.scenes++;
			for (const g of geometries) {
				const { mesh, report } = fromBufferGeometry(g);
				expect(mesh.validate()).toEqual([]);
				totals.meshes++;
				totals.triangles += report.triangles;
				totals.ngons += report.ngons;
				totals.fallbackFaces += report.fallbackFaces;
				totals.degenerate += report.degenerate;
				if (mesh.topologyReport().closed) totals.closed++;
				const { geometry: back, arrays } = toBufferGeometry(mesh, { topo: g.userData?.__topo ? true : 'auto' });
				for (const name of Object.keys(g.attributes)) expect(diff(back.attributes[name].array, expanded(g, name)), `${name} of ${g.type}`).toBe(null);
				expect(diff(arrays.material, slots(g)), `material slots of ${g.type}`).toBe(null);
				if (g.userData?.__topo) {
					totals.topo++;
					const norm = (t) => {
						const faces = [];
						let at = 0;
						for (const c of t.counts) faces.push(t.tris.slice(at, (at += c)).sort((a, b) => a - b).join(','));
						return faces.sort().join('|');
					};
					if (norm(back.userData.__topo) === norm(g.userData.__topo)) totals.partitionsEqual++;
				}
				// through the meshgeo wire with IDs: the receiver rebuilds the sender's IDs
				const msg = toMeshGeo(mesh, { ids: true });
				const again = fromMeshGeo(structuredClone(msg)).mesh;
				expect(again.validate()).toEqual([]);
				expect(Array.from(again.faceIds({ degenerate: true }))).toEqual(Array.from(mesh.faceIds({ degenerate: true })));
				expect(diff(toArrays(again).positions, arrays.positions)).toBe(null);
			}
		});
	}
	it('summary', () => {
		console.log('[meshKernel scenes]', JSON.stringify(totals));
		expect(totals.meshes).toBeGreaterThan(0);
		expect(totals.partitionsEqual).toBe(totals.topo);
	});
});
