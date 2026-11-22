// 104 D1 — Scan my room, the pure half: plane / volume → named boxes at real size, the re-scan plan,
// and the read of a (fake) XR frame.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	polygonRect,
	planePiece,
	meshPiece,
	roomPieces,
	planUpdate,
	scanSummary,
	readFrame,
	labelName,
	ROOM_NAME_RE,
	PANEL,
	MAX_PIECES
} from '../../src/lib/vr/roomScanCore.js';

/** a pose matrix from a position + a quaternion @param {number[]} p @param {THREE.Quaternion} [q] */
const pose = (p, q = new THREE.Quaternion()) => new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(1, 1, 1)).toArray();
/** a w x d rectangle centred on the plane origin @param {number} w @param {number} d */
const rect = (w, d) => [
	{ x: -w / 2, z: -d / 2 },
	{ x: w / 2, z: -d / 2 },
	{ x: w / 2, z: d / 2 },
	{ x: -w / 2, z: d / 2 }
];
/** plane +Y → a world direction (the normal into the room) @param {number[]} n */
const facing = (n) => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n).normalize());
/** a box mesh's 8 corners, centred, in its own space @param {number[]} s */
const boxVerts = (s) => {
	const out = [];
	for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push((x * s[0]) / 2, (y * s[1]) / 2, (z * s[2]) / 2);
	return new Float32Array(out);
};

// A 4 m (x) by 3 m (z) room, 2.5 m high, floor at y = 0, the person standing in the middle.
// A wall's plane space: +Y = the normal INTO the room, the polygon's x along the floor, z = the wall's height.
const wallQ = (/** @type {number[]} */ n) => {
	// +Y to the normal, and the polygon's z axis to world up (so `rect(len, 2.5)` stands upright)
	const y = new THREE.Vector3(...n).normalize();
	const z = new THREE.Vector3(0, 1, 0);
	const x = new THREE.Vector3().crossVectors(y, z).normalize();
	return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
};
const ROOM = {
	planes: [
		{ label: 'floor', polygon: rect(4, 3), matrix: pose([0, 0, 0]) },
		{ label: 'ceiling', polygon: rect(4, 3), matrix: pose([0, 2.5, 0], facing([0, -1, 0])) },
		{ label: 'wall', polygon: rect(4, 2.5), matrix: pose([0, 1.25, -1.5], wallQ([0, 0, 1])) }, // north (−z)
		{ label: 'wall', polygon: rect(3, 2.5), matrix: pose([2, 1.25, 0], wallQ([-1, 0, 0])) }, // east
		{ label: 'wall', polygon: rect(4, 2.5), matrix: pose([0, 1.25, 1.5], wallQ([0, 0, -1])) }, // south
		{ label: 'wall', polygon: rect(3, 2.5), matrix: pose([-2, 1.25, 0], wallQ([1, 0, 0])) }, // west
		{ label: 'table', polygon: rect(1.2, 0.8), matrix: pose([1, 0.75, -0.8]) }, // a top, with a volume below
		{ label: 'couch', polygon: rect(2, 0.9), matrix: pose([-1, 0.45, 1]) }, // a top, NO volume
		{ label: 'door frame', polygon: rect(0.9, 2.1), matrix: pose([1.2, 1.05, 1.5], wallQ([0, 0, -1])) },
		{ label: 'invisible wall face', polygon: rect(1, 1), matrix: pose([0, 1, 0]) }
	],
	meshes: [
		{ label: 'table', vertices: boxVerts([1.2, 0.75, 0.8]), matrix: pose([1, 0.375, -0.8]) },
		{ label: 'global mesh', vertices: boxVerts([4, 2.5, 3]), matrix: pose([0, 1.25, 0]) }
	]
};

describe('104 room scan — one plane', () => {
	it('a rectangle gives its size and centre', () => {
		const r = polygonRect(rect(4, 3));
		expect(r?.w).toBeCloseTo(4);
		expect(r?.d).toBeCloseTo(3);
		expect(r?.cx).toBeCloseTo(0);
		expect(r?.cz).toBeCloseTo(0);
	});

	it('a rectangle turned 30° in its plane keeps its real size (not a loose min/max box)', () => {
		const a = Math.PI / 6;
		const poly = rect(2, 1).map((p) => ({ x: p.x * Math.cos(a) - p.z * Math.sin(a) + 0.5, z: p.x * Math.sin(a) + p.z * Math.cos(a) - 0.25 }));
		const r = polygonRect(poly);
		expect(r?.w).toBeCloseTo(2, 5);
		expect(r?.d).toBeCloseTo(1, 5);
		expect(r?.cx).toBeCloseTo(0.5, 5);
		expect(r?.cz).toBeCloseTo(-0.25, 5);
		// and the piece built from it: its centre lands on the polygon's, its x axis along the long edge
		const piece = planePiece({ label: 'table', polygon: poly, matrix: pose([0, 0.7, 0]) });
		expect(piece?.position[0]).toBeCloseTo(0.5, 3);
		expect(piece?.position[2]).toBeCloseTo(-0.25, 3);
		const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(/** @type {number[]} */ (piece?.quaternion)));
		expect(Math.abs(xAxis.dot(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))))).toBeCloseTo(1, 4);
	});

	it('a wall is a 2 cm panel behind its face, at real size', () => {
		const p = planePiece(ROOM.planes[2]);
		expect(p?.base).toBe('Wall');
		expect(p?.size[0]).toBeCloseTo(4);
		expect(p?.size[1]).toBeCloseTo(PANEL);
		expect(p?.size[2]).toBeCloseTo(2.5);
		// the face stays at z = -1.5: the panel's centre is 1 cm further out (behind the wall)
		expect(p?.position[2]).toBeCloseTo(-1.5 - PANEL / 2, 4);
		expect(p?.position[1]).toBeCloseTo(1.25, 4);
	});

	it('the floor panel sits under the floor; the ceiling panel above the ceiling', () => {
		expect(planePiece(ROOM.planes[0])?.position[1]).toBeCloseTo(-PANEL / 2, 4);
		expect(planePiece(ROOM.planes[1])?.position[1]).toBeCloseTo(2.5 + PANEL / 2, 4);
	});

	it('a furniture top with a floor becomes a box down to the floor', () => {
		const p = planePiece(ROOM.planes[7], { floorY: 0 });
		expect(p?.base).toBe('Couch');
		expect(p?.size[1]).toBeCloseTo(0.45, 4);
		expect(p?.position[1]).toBeCloseTo(0.225, 4);
		// with no floor known it stays a panel
		expect(planePiece(ROOM.planes[7])?.size[1]).toBeCloseTo(PANEL);
	});

	it('a door sits 1 cm IN FRONT of its wall', () => {
		const p = planePiece(ROOM.planes[8]);
		expect(p?.base).toBe('Door');
		expect(p?.position[2]).toBeLessThan(1.5);
		expect(p?.position[2]).toBeCloseTo(1.5 - 0.005, 4);
	});

	it('never built: the room mesh, the invisible walls, malformed or tiny planes', () => {
		expect(planePiece(ROOM.planes[9])).toBeNull();
		expect(meshPiece(ROOM.meshes[1])).toBeNull();
		expect(planePiece({ label: 'wall', polygon: rect(0.01, 2), matrix: pose([0, 0, 0]) })).toBeNull();
		expect(planePiece({ label: 'wall', polygon: [{ x: 0, z: 0 }], matrix: pose([0, 0, 0]) })).toBeNull();
		expect(planePiece(/** @type {any} */ ({ label: 'wall', polygon: rect(1, 1), matrix: [1, 2] }))).toBeNull();
	});

	it('labels: Meta and IWER spellings, unknown → Object', () => {
		expect(labelName('door frame')).toBe('Door');
		expect(labelName('door')).toBe('Door');
		expect(labelName('window frame')).toBe('Window');
		expect(labelName('WALL_FACE'.toLowerCase().replace('_', ' '))).toBe('Wall');
		expect(labelName('spaceship')).toBe('Object');
		expect(labelName(undefined)).toBe('Object');
		expect(labelName('global mesh')).toBeNull();
	});
});

describe('104 room scan — the room', () => {
	const pieces = roomPieces(ROOM);
	const names = pieces.map((p) => p.name);

	it('names every piece once, walls clockwise from the one ahead of -Z', () => {
		expect(names).toEqual(['Floor', 'Ceiling', 'Wall 1', 'Wall 2', 'Wall 3', 'Wall 4', 'Couch', 'Door', 'Table']);
		const at = (/** @type {string} */ n) => pieces.find((p) => p.name === n)?.position ?? [];
		expect(at('Wall 1')[2]).toBeLessThan(-1.4); // north
		expect(at('Wall 2')[0]).toBeGreaterThan(1.9); // east
		expect(at('Wall 3')[2]).toBeGreaterThan(1.4); // south
		expect(at('Wall 4')[0]).toBeLessThan(-1.9); // west
	});

	it('a table given as a top AND a volume is one box, the volume', () => {
		const tables = pieces.filter((p) => p.base === 'Table');
		expect(tables).toHaveLength(1);
		expect(tables[0].from).toBe('volume');
		expect(tables[0].size).toEqual([1.2, 0.75, 0.8]);
		expect(tables[0].position[1]).toBeCloseTo(0.375, 4);
	});

	it('the same room read twice gives the same names (re-scan identity)', () => {
		const shuffled = { planes: [...ROOM.planes].reverse(), meshes: [...ROOM.meshes].reverse() };
		expect(roomPieces(shuffled).map((p) => p.name)).toEqual(names);
	});

	it('a second table of the same kind is "Table 2"', () => {
		const more = roomPieces({ planes: [...ROOM.planes, { label: 'table', polygon: rect(0.6, 0.6), matrix: pose([-1.5, 0.5, -1]) }], meshes: ROOM.meshes });
		expect(more.filter((p) => p.base === 'Table').map((p) => p.name)).toEqual(['Table', 'Table 2']);
	});

	it('caps the pieces at MAX_PIECES (the Quest draw-call budget)', () => {
		const lots = Array.from({ length: 100 }, (_, i) => ({ label: 'plant', polygon: rect(0.2, 0.2), matrix: pose([i * 0.3, 0.5, 0]) }));
		expect(roomPieces({ planes: lots })).toHaveLength(MAX_PIECES);
	});

	it('empty / no room setup → nothing', () => {
		expect(roomPieces({ planes: [], meshes: [] })).toEqual([]);
		expect(roomPieces(/** @type {any} */ (null))).toEqual([]);
	});

	it('the confirm line counts the pieces and says no camera image was used', () => {
		const line = scanSummary(pieces);
		expect(line).toMatch(/^My room: 4 walls, /);
		expect(line).toContain('floor');
		expect(line).toContain('table');
		expect(line).toContain('no camera image used or stored');
	});
});

// What a REAL Quest 3 hands the page (Quest Browser 157, measured 2026-11-22; the shape only, not that room):
// the room mesh comes with NO semanticLabel (thousands of vertices), and a shelf as an unlabelled 8-corner
// volume plus a labelled 'shelf' top plane.
describe('104 room scan — Quest Browser 157 labels', () => {
	/** a closed triangle soup with n vertices spread through a w x h x d box (the room mesh's shape) */
	const roomMesh = (/** @type {number} */ n, /** @type {number[]} */ s) => {
		const v = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) v[i * 3 + k] = ((((i * 7919 + k * 104729) % 1000) / 1000) - 0.5) * s[k];
		return v;
	};
	const QUEST = {
		planes: [
			...ROOM.planes.filter((p) => p.label !== 'table' && p.label !== 'couch' && p.label !== 'invisible wall face'),
			{ label: 'shelf', polygon: rect(0.55, 0.3), matrix: pose([-1.5, 0.9, 1.2]) }
		],
		meshes: [
			{ label: undefined, vertices: roomMesh(6245, [4.4, 2.7, 3.4]), matrix: pose([0, 1.3, 0]) },
			{ label: undefined, vertices: boxVerts([0.55, 0.9, 0.3]), matrix: pose([-1.5, 0.45, 1.2]) },
			{ label: 'table', vertices: boxVerts([1.2, 0.75, 0.8]), matrix: pose([1, 0.375, -0.8]) }
		]
	};
	const pieces = roomPieces(QUEST);
	it('an unlabelled mesh that is not a box is the room mesh: never built', () => {
		expect(pieces.some((p) => p.size.some((n) => n > 4.1))).toBe(false);
		expect(pieces.filter((p) => p.base === 'Object')).toEqual([]);
		expect(meshPiece({ label: undefined, vertices: roomMesh(6245, [4, 2.5, 3]), matrix: pose([0, 1, 0]) })).toBeNull();
		// an unlabelled BOX is still built (an object Space Setup drew without a kind)
		expect(meshPiece({ label: undefined, vertices: boxVerts([0.5, 0.5, 0.5]), matrix: pose([0, 0.25, 0]) })?.base).toBe('Object');
	});
	it('an unlabelled volume under a labelled shelf top is ONE shelf, the volume', () => {
		const shelves = pieces.filter((p) => p.base === 'Shelf');
		expect(shelves).toHaveLength(1);
		expect(shelves[0].from).toBe('volume');
		expect(shelves[0].size).toEqual([0.55, 0.9, 0.3]);
		expect(pieces.map((p) => p.name)).toEqual(['Floor', 'Ceiling', 'Wall 1', 'Wall 2', 'Wall 3', 'Wall 4', 'Door', 'Shelf', 'Table']);
	});
});

describe('104 room scan — re-scan plan', () => {
	const pieces = roomPieces(ROOM);

	it('first scan: everything is created', () => {
		const plan = planUpdate([], pieces);
		expect(plan.create).toHaveLength(pieces.length);
		expect(plan.update).toHaveLength(0);
		expect(plan.remove).toHaveLength(0);
	});

	it('again: the same names update in place; a gone piece is removed; the person’s own things stay', () => {
		const children = [
			...pieces.map((p, i) => ({ uuid: 'u' + i, name: p.name })),
			{ uuid: 'gone', name: 'Window 2' }, // a scan-made piece no longer in the room
			{ uuid: 'mine', name: 'Grandma’s armchair' }, // added by hand / by the assistant
			{ uuid: 'renamed', name: 'Wall 1 (brick)' } // renamed: theirs now
		];
		const plan = planUpdate(children, pieces);
		expect(plan.create).toHaveLength(0);
		expect(plan.update.map((u) => u.uuid)).toEqual(pieces.map((_, i) => 'u' + i));
		expect(plan.remove).toEqual(['gone']);
	});

	it('the name rule only covers names a scan writes', () => {
		for (const n of ['Wall 1', 'Floor', 'Table 2', 'Wall art', 'Object 3']) expect(ROOM_NAME_RE.test(n)).toBe(true);
		for (const n of ['Wall', 'Walls', 'Table two', 'My room', 'Box', 'Wall 1 (brick)']) expect(ROOM_NAME_RE.test(n), n).toBe(n === 'Wall');
	});
});

describe('104 room scan — a fake XR frame', () => {
	/** XRFrame-shaped: planes / meshes in their own spaces, getPose(space, ref) = that space's matrix */
	const fakeFrame = (/** @type {any} */ room, /** @type {{meshes?: boolean, posed?: boolean}} */ opts = {}) => {
		const planes = room.planes.map((/** @type {any} */ p) => ({
			semanticLabel: p.label,
			planeSpace: { m: p.matrix },
			polygon: p.polygon.map((/** @type {any} */ q) => ({ x: q.x, y: 0, z: q.z, w: 1 }))
		}));
		const meshes = room.meshes.map((/** @type {any} */ m) => ({ semanticLabel: m.label, meshSpace: { m: m.matrix }, vertices: m.vertices, indices: new Uint32Array() }));
		return {
			detectedPlanes: new Set(planes),
			...(opts.meshes === false ? {} : { detectedMeshes: new Set(meshes) }),
			getPose: (/** @type {any} */ space, /** @type {any} */ ref) =>
				opts.posed === false || ref !== 'local-floor' ? null : { transform: { matrix: new Float32Array(space.m) } }
		};
	};

	it('reads every plane and mesh with its pose in the app reference space', () => {
		const got = readFrame(fakeFrame(ROOM), 'local-floor');
		expect(got.planes).toHaveLength(ROOM.planes.length);
		expect(got.meshes).toHaveLength(ROOM.meshes.length);
		expect(got.planes[2].label).toBe('wall');
		expect(got.planes[2].polygon[0]).toEqual({ x: -2, z: -1.25 });
		// end to end: the frame's planes become the same room
		expect(roomPieces(got).map((p) => p.name)).toEqual(roomPieces(ROOM).map((p) => p.name));
	});

	it('no mesh-detection granted: planes alone (the table becomes a box down to the floor)', () => {
		const got = readFrame(fakeFrame(ROOM, { meshes: false }), 'local-floor');
		expect(got.meshes).toEqual([]);
		const table = roomPieces(got).find((p) => p.name === 'Table');
		expect(table?.from).toBe('plane');
		expect(table?.size[1]).toBeCloseTo(0.75, 4);
	});

	it('no pose this frame (tracking lost): nothing, never a throw', () => {
		expect(readFrame(fakeFrame(ROOM, { posed: false }), 'local-floor')).toEqual({ planes: [], meshes: [] });
		expect(readFrame({ get detectedPlanes() { throw new Error('InvalidStateError'); } }, 'x')).toEqual({ planes: [], meshes: [] });
		expect(readFrame(null, null)).toEqual({ planes: [], meshes: [] });
	});
});
