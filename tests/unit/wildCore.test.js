// The generator bench's pure half (tools/bench/wildCore.mjs): settings normalisation, the image-type
// sniff, the up-axis guess, the set, and the import-wild picks. No dataset needed.
import { describe, it, expect } from 'vitest';
import {
	familyOf,
	requestedFaces,
	budgetClass,
	settingsLabel,
	sniffMime,
	scaleClass,
	shapeDistance,
	median,
	quantile,
	upAxisGuesses,
	taggedWith,
	groupMap,
	topGroups,
	pickFixtures,
	pickPairs
} from '../../tools/bench/wildCore.mjs';

/** a measured bench row @param {Partial<any>} o */
function row(o) {
	const m = {
		bytes: 1e6,
		cost: { meshes: 1, triangles: 1000, vertices: 600, draws: 1, maxMeshVertices: 600, maxMeshTriangles: 1000, textures: 1, textureBytes: 1, maxTextureSize: 1024 },
		primitives: 1,
		nodes: 1,
		materialsUsed: 1,
		pbr: 'pbr',
		textures: { count: 1, maxPx: 1024, sizes: [1024], formats: { 'image/png': 1 }, mimeMismatch: 0 },
		skinnedPrims: 0,
		morphPrims: 0,
		animations: 0,
		size: [1, 2, 1],
		maxDim: 2,
		topNodes: [{ scale: [1, 1, 1], quaternion: [0, 0, 0, 1] }],
		fileIssues: [],
		topology: { nonManifold: 0 },
		...(o.m ?? {})
	};
	return { id: o.id ?? 'asset_x', model: o.model ?? 'meshy-img23d', family: o.family ?? familyOf(o.model ?? 'meshy-img23d'), groups: o.groups ?? ['inputs/g1.png'], path: o.path ?? `assets/${o.id ?? 'x'}/output.glb`, sha256: 'ab', role: 'output', up: o.up ?? 'y', m };
}

describe('families', () => {
	it('follows the tag browser table', () => {
		expect(familyOf('rodin-hyper3d-highpack')).toBe('Rodin');
		expect(familyOf('tripo-v3-1-image-to-3d')).toBe('Tripo');
		expect(familyOf('vast-ai-triposplat')).toBe('Splat');
		expect(familyOf('hitem-sparc-3d-2')).toBe('Hitem / Sparc');
		expect(familyOf('scenario-claude-opus-5-5-3d')).toBe('Claude');
		expect(familyOf('something-new')).toBe('Other');
	});
});

describe('the face budget a row asked for', () => {
	it('reads every provider key, quads count twice', () => {
		expect(requestedFaces({ targetPolycount: 30000 })).toBe(30000);
		expect(requestedFaces({ face: 1000000 })).toBe(1000000);
		expect(requestedFaces({ faceLimit: 20000 })).toBe(20000);
		expect(requestedFaces({ maxFaceNum: 80000 })).toBe(80000);
		expect(requestedFaces({ face_budget: 60000 })).toBe(60000);
		expect(requestedFaces({ qualityMeshOption: '500K Triangle' })).toBe(500000);
		expect(requestedFaces({ quality: '50K Quad' })).toBe(100000);
		expect(requestedFaces({ quality: 'high' })).toBe(null);
		expect(requestedFaces(null)).toBe(null);
	});
	it('classes and labels', () => {
		expect(budgetClass(null)).toBe('unset');
		expect(budgetClass(50000)).toBe('≤50k');
		expect(budgetClass(300000)).toBe('50k-300k');
		expect(budgetClass(300001)).toBe('>300k');
		expect(settingsLabel({ targetPolycount: 30000, shouldRemesh: false, enablePbr: true })).toBe('30k faces, no remesh, PBR');
	});
});

describe('the image type sniff', () => {
	it('knows the four formats and ignores the declared one', () => {
		const pad = (/** @type {number[]} */ b) => new Uint8Array([...b, ...new Array(12).fill(0)]);
		expect(sniffMime(pad([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
		expect(sniffMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(sniffMime(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
		expect(sniffMime(pad([0xab, 0x4b, 0x54, 0x58]))).toBe('image/ktx2');
		expect(sniffMime(pad([1, 2, 3]))).toBe(null);
		expect(sniffMime(new Uint8Array(3))).toBe(null);
	});
});

describe('scale and the up axis', () => {
	it('classes a box', () => {
		expect(scaleClass(0)).toBe('empty');
		expect(scaleClass(0.01)).toMatch(/^tiny/);
		expect(scaleClass(120)).toMatch(/^huge/);
		expect(scaleClass(1.9)).toMatch(/^unit/);
		expect(scaleClass(4)).toBe('metric');
	});
	it('stats', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(quantile([0, 10], 0.9)).toBeCloseTo(9);
		expect(Number.isNaN(median([]))).toBe(true);
		expect(shapeDistance([1, 2, 1], [2, 4, 2])).toBeCloseTo(0);
	});
	it('a member lying down against its group reads z?', () => {
		const tall = [0.5, 2, 0.5];
		const guesses = upAxisGuesses([{ size: tall }, { size: [0.6, 2.1, 0.5] }, { size: [0.5, 1.9, 0.6] }, { size: [0.5, 0.5, 2] }, { size: null }]);
		expect(guesses).toEqual(['y', 'y', 'y', 'z?', '-']);
		expect(upAxisGuesses([{ size: tall }, { size: tall }])).toEqual(['-', '-']);
	});
});

describe('the set', () => {
	it("reads the owner's tags", () => {
		const state = { tags: { a: { cats: ['Benchmark', 'Prop'] }, b: { cats: ['Import test'] }, c: {} } };
		expect(taggedWith(state, 'Benchmark')).toEqual(['a']);
		expect(taggedWith(state, 'Import test')).toEqual(['b']);
	});
	it('ranks groups by distinct generators', () => {
		const items = [
			{ id: '1', model: 'm1', inputs: [{ path: 'g1' }] },
			{ id: '2', model: 'm1', inputs: [{ path: 'g1' }] },
			{ id: '3', model: 'm1', inputs: [{ path: 'g2' }] },
			{ id: '4', model: 'm2', inputs: [{ path: 'g2' }] },
			{ id: '5', model: 'm3', inputs: [{ path: 'g2' }, { path: 'g3' }] },
			{ id: '6', model: 'm3', inputs: [{ path: 'g4' }] }
		];
		const by = groupMap(items);
		expect(by.get('g2')?.length).toBe(3);
		expect(by.get('g3')?.map((i) => i.id)).toEqual(['5']);
		// g1 (one generator) and the single-member groups are no comparison
		expect(topGroups(by, 5).map((t) => t.g)).toEqual(['g2']);
	});
});

describe('the import-wild picks', () => {
	it('takes n NEW rows per reason and tags the overlaps', () => {
		const rows = [
			row({ id: 'big', path: 'a/big.glb', m: { bytes: 9e7, cost: { meshes: 1, triangles: 3e6, vertices: 1, draws: 1, maxMeshVertices: 1, maxMeshTriangles: 3e6, textures: 0, textureBytes: 0, maxTextureSize: 0 } } }),
			row({ id: 'mid', path: 'a/mid.glb', m: { bytes: 5e7 } }),
			row({ id: 'small', path: 'a/small.glb', m: { bytes: 1e5, pbr: 'none' } }),
			row({ id: 'pc', path: 'a/pc.glb', model: 'partcrafter', m: { primitives: 12 } })
		];
		const { fixtures } = pickFixtures(rows, [], { tags: { mid: { cats: ['Import test'] } } });
		const why = Object.fromEntries(fixtures.map((f) => [f.id, f.why]));
		expect(why.mid[0]).toBe('owner: Import test');
		expect(why.big).toContain('largest file');
		expect(why.big).toContain('most triangles');
		expect(why.small).toContain('no PBR maps');
		expect(why.pc).toContain('PartCrafter multi-part');
		// every pick carries what the suite compares against
		expect(fixtures.find((f) => f.id === 'big')?.expect?.cost.triangles).toBe(3e6);
		expect(new Set(fixtures.map((f) => f.path)).size).toBe(fixtures.length);
	});
	it('adds the FBX outputs, unmeasured', () => {
		const items = [{ id: 'f', model: 'tripo-v3-0-image-to-3d', inputs: [{ path: 'g' }], outputs: [{ role: 'output', format: 'fbx', path: 'assets/f/output.fbx', sha256: 'cd' }] }];
		const { fixtures } = pickFixtures([], items, { tags: {} });
		expect(fixtures).toEqual([expect.objectContaining({ format: 'fbx', expect: null, why: ['FBX output'] })]);
	});
	it("Replace pairs follow modelSanity's rule on the two boxes", () => {
		const g = ['inputs/same.png'];
		const rows = [
			row({ id: 'a', model: 'meshy-img23d', groups: g, path: 'a.glb', m: { size: [1, 2, 1] } }),
			row({ id: 'b', model: 'tripo-p1-image-to-3d', groups: g, path: 'b.glb', m: { size: [1.1, 2, 1] } }),
			row({ id: 'big', model: 'sparc3d', groups: g, path: 'big.glb', m: { size: [100, 200, 100] } }),
			row({ id: 'lying', model: 'pixal3d', groups: g, path: 'lying.glb', m: { size: [1, 1, 2] } }),
			row({ id: 'turned', model: 'rodin-hyper3d', groups: g, path: 'turned.glb', m: { size: [1, 2, 1], topNodes: [{ scale: [1, 1, 1], quaternion: [0.7071, 0, 0, 0.7071] }] } })
		];
		const pairs = pickPairs(rows);
		const by = Object.fromEntries(pairs.map((p) => [p.why, p]));
		expect(Object.keys(by).sort()).toEqual(['replace: none', 'replace: scale', 'replace: transforms', 'replace: zup']);
		expect(by['replace: scale'].expectIssues).toContain('scale');
		expect(by['replace: zup'].expectIssues).toContain('zup');
		expect(by['replace: transforms'].expectIssues).toEqual(['transforms']);
		expect(by['replace: none'].expectIssues).toEqual([]);
	});
});
