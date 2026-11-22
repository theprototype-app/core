// 104 wall names — a re-scan keeps each wall's name on the same real wall (nameWalls), matched by shape:
// length within 3 cm + the walls around it, laid over the old room. Rows with two REAL Quest 3 frames.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { roomPieces, nameWalls, planUpdate, scanSummary, wallNormal, WALL_LENGTH_TOL } from '../../src/lib/vr/roomScanCore.js';

// The owner's room, two sessions on a real Quest 3 (2026-11-22), DERIVED numbers only (no frame file, no
// image): per plane [label, width, depth, centre, quaternion], rounded to the mm. Session 1 = the first
// scan's plane read; session 2 = the second session's full frame reduced to the same shape. Both were read
// in one reference space, which is why they agree to ~5 mm; the scan's own space in session 2 was turned
// (it named the long walls Wall 1 + Wall 3, session 1 Wall 2 + Wall 4 — the sizes in that order were
// 4.126 / 3.421 / 4.126 / 3.422), and turning the frame 90° about +Y gives exactly that order (below).
/** @type {[string, number, number, number[], number[]][]} */
const SESSION_1 = [
	['wall', 3.422, 2.481, [2.25, 1.396, -2.679], [-0.702, -0.082, -0.082, 0.702]],
	['shelf', 0.546, 0.294, [-0.034, 0.909, 0.842], [-0.116, 0, 0.993, 0]],
	['table', 1.713, 0.683, [0.315, 0.786, -0.376], [0.784, 0, -0.62, 0]],
	['wall', 4.126, 2.481, [3.44, 1.387, -0.276], [-0.438, -0.555, -0.555, 0.438]],
	['ceiling', 4.126, 3.424, [1.775, 2.576, -0.671], [0, -0.784, 0, 0.62]],
	['wall', 3.421, 2.481, [1.3, 1.275, 1.336], [-0.082, 0.702, 0.702, 0.082]],
	['wall', 4.126, 2.481, [0.11, 1.284, -1.068], [-0.555, 0.439, 0.439, 0.555]],
	['table', 0.434, 0.543, [0.496, 0.46, 0.832], [-0.116, 0, 0.993, 0]],
	['floor', 4.127, 3.425, [1.775, 0.095, -0.671], [0.62, 0, 0.784, 0]]
];
/** @type {[string, number, number, number[], number[]][]} */
const SESSION_2 = [
	['wall', 3.422, 2.481, [2.256, 1.334, -2.682], [-0.702, -0.082, -0.082, 0.702]],
	['shelf', 0.546, 0.294, [-0.029, 0.907, 0.84], [-0.116, 0, 0.993, 0]],
	['table', 1.713, 0.683, [0.32, 0.784, -0.378], [0.784, 0, -0.62, 0]],
	['wall', 4.126, 2.481, [3.445, 1.334, -0.281], [0.439, 0.555, 0.555, -0.439]],
	['ceiling', 4.126, 3.424, [1.78, 2.575, -0.674], [0, -0.784, 0, 0.62]],
	['wall', 3.421, 2.481, [1.304, 1.334, 1.333], [-0.082, 0.702, 0.702, 0.082]],
	['wall', 4.126, 2.481, [0.115, 1.334, -1.068], [-0.555, 0.439, 0.439, 0.555]],
	['table', 0.543, 0.434, [0.501, 0.458, 0.831], [0.62, 0, 0.784, 0]],
	['floor', 4.127, 3.425, [1.78, 0.093, -0.674], [0.621, 0, 0.784, 0]]
];

/** a frame from rows, as seen from a session whose space is turned `deg` about +Y and shifted
 * @param {typeof SESSION_1} rows @param {number} [deg] @param {number[]} [shift] */
const frame = (rows, deg = 0, shift = [0, 0, 0]) => {
	const T = space(deg, shift);
	return {
		planes: rows.map(([label, w, d, pos, q]) => ({
			label,
			polygon: [
				{ x: -w / 2, z: -d / 2 },
				{ x: w / 2, z: -d / 2 },
				{ x: w / 2, z: d / 2 },
				{ x: -w / 2, z: d / 2 }
			],
			matrix: T.clone()
				.multiply(new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion(...q), new THREE.Vector3(1, 1, 1)))
				.toArray()
		}))
	};
};
/** @param {number} deg @param {number[]} shift */
const space = (deg, shift) => new THREE.Matrix4().makeRotationY((deg * Math.PI) / 180).setPosition(...shift);
/** a point of a turned session back in the first one's frame @param {number[]} p @param {number} deg @param {number[]} shift */
const back = (p, deg, shift) => new THREE.Vector3(...p).applyMatrix4(space(deg, shift).invert()).toArray();

/** the group after a scan: its walls and other pieces as applyRoom reads them @param {import('../../src/lib/vr/roomScanCore.js').NamedPiece[]} pieces */
const oldOf = (pieces) => ({
	walls: pieces
		.filter((p) => p.base === 'Wall')
		.map((p, i) => ({ uuid: 'w' + i, name: p.name, length: p.size[0], position: p.position, normal: wallNormal(p) })),
	others: pieces.filter((p) => !['Wall', 'Floor', 'Ceiling'].includes(p.base)).map((p) => ({ base: p.base, position: p.position }))
});
const wallsOf = (/** @type {any[]} */ pieces) => pieces.filter((p) => p.base === 'Wall');
const longNames = (/** @type {any[]} */ pieces) => wallsOf(pieces).filter((p) => p.size[0] > 4).map((p) => p.name).sort();

describe('104 wall names — the real room, two sessions', () => {
	const first = roomPieces(frame(SESSION_1));
	const old = oldOf(first);
	const TURN = 90;
	const SHIFT = [0.4, 0, -0.3];
	const second = roomPieces(frame(SESSION_2, TURN, SHIFT));

	it('the first scan keeps today’s numbering: the long walls are Wall 2 + Wall 4', () => {
		expect(wallsOf(first).map((p) => [p.name, Math.round(p.size[0] * 1000) / 1000])).toEqual([
			['Wall 1', 3.422],
			['Wall 2', 4.126],
			['Wall 3', 3.421],
			['Wall 4', 4.126]
		]);
		expect(nameWalls(first, []).pieces).toBe(first);
	});

	it('the turned second session numbers by its own facing (the bug): long walls Wall 1 + Wall 3, sizes as on the headset', () => {
		expect(wallsOf(second).map((p) => Math.round(p.size[0] * 1000) / 1000)).toEqual([4.126, 3.421, 4.126, 3.422]);
		expect(longNames(second)).toEqual(['Wall 1', 'Wall 3']);
	});

	it('matched by shape, the re-scan keeps Wall 2 + Wall 4 on the long walls, each name on the SAME real wall', () => {
		const got = nameWalls(second, old.walls, { others: old.others });
		expect(got.matched).toBe(4);
		expect(got.missing).toEqual([]);
		expect(longNames(got.pieces)).toEqual(['Wall 2', 'Wall 4']);
		for (const w of wallsOf(got.pieces)) {
			const was = first.find((p) => p.name === w.name);
			const at = back(w.position, TURN, SHIFT);
			expect(Math.hypot(at[0] - (was?.position[0] ?? 0), at[2] - (was?.position[2] ?? 0)), w.name).toBeLessThan(0.02);
		}
		// nothing else is renamed, and the plan updates the four old walls in place
		expect(got.pieces.filter((p) => p.base !== 'Wall').map((p) => p.name)).toEqual(second.filter((p) => p.base !== 'Wall').map((p) => p.name));
		const plan = planUpdate(old.walls.map((w) => ({ uuid: w.uuid, name: w.name })), wallsOf(got.pieces));
		expect(plan.create).toHaveLength(0);
		for (const u of plan.update) expect(old.walls.find((w) => w.uuid === u.uuid)?.name).toBe(u.piece.name);
	});

	it('every turn of the session keeps the names (the room is a rectangle: the furniture picks the way round)', () => {
		for (const deg of [-135, -90, -45, 0, 30, 90, 180]) {
			const again = roomPieces(frame(SESSION_2, deg, [-0.7, 0, 1.1]));
			const got = nameWalls(again, old.walls, { others: old.others });
			expect(got.missing, String(deg)).toEqual([]);
			for (const w of wallsOf(got.pieces)) {
				const was = first.find((p) => p.name === w.name);
				const at = back(w.position, deg, [-0.7, 0, 1.1]);
				expect(Math.hypot(at[0] - (was?.position[0] ?? 0), at[2] - (was?.position[2] ?? 0)), deg + ' ' + w.name).toBeLessThan(0.02);
			}
		}
	});

	it('with no furniture to tell the two ways round apart, the smaller move wins (an empty rectangle room)', () => {
		// unturned: the fit that moves nothing keeps every name where it was
		const got = nameWalls(roomPieces(frame(SESSION_2)), old.walls);
		expect(wallsOf(got.pieces).map((p) => p.name)).toEqual(['Wall 1', 'Wall 2', 'Wall 3', 'Wall 4']);
		// turned 90°: both fits place 4 walls; whichever wins, the long walls keep the long-wall names
		const turned = nameWalls(second, old.walls);
		expect(turned.matched).toBe(4);
		expect(longNames(turned.pieces)).toEqual(['Wall 2', 'Wall 4']);
	});

	it('the same session again (no turn) keeps every name', () => {
		const got = nameWalls(roomPieces(frame(SESSION_2)), old.walls, { others: old.others });
		expect(wallsOf(got.pieces).map((p) => p.name)).toEqual(['Wall 1', 'Wall 2', 'Wall 3', 'Wall 4']);
		expect(got.missing).toEqual([]);
	});

	it('a wall gone from the room setup keeps its name, is not removed, and the toast says so', () => {
		const rows = SESSION_2.filter((r) => !(r[0] === 'wall' && r[3][2] > 1.3)); // session 1's Wall 3
		const got = nameWalls(roomPieces(frame(rows, TURN, SHIFT)), old.walls, { others: old.others });
		expect(got.missing).toEqual(['Wall 3']);
		expect(wallsOf(got.pieces).map((p) => p.name).sort()).toEqual(['Wall 1', 'Wall 2', 'Wall 4']);
		const plan = planUpdate([...old.walls.map((w) => ({ uuid: w.uuid, name: w.name })), { uuid: 'tv', name: 'Screen' }], got.pieces);
		expect(plan.remove).toEqual(['tv']); // a gone Screen goes; the missing wall stays
		expect(plan.update.map((u) => u.piece.name).sort()).toEqual(['Wall 1', 'Wall 2', 'Wall 4']);
		expect(scanSummary(got.pieces, { created: 0, updated: 9, removed: 0, missing: got.missing })).toContain(
			'Wall 3 not found in this scan. From your headset'
		);
	});

	it('a genuinely new wall gets the next free number; the old ones keep theirs', () => {
		/** @type {typeof SESSION_1} */
		const extra = [['wall', 2.7, 2.481, [1.775, 1.334, -0.671], [-0.702, -0.082, -0.082, 0.702]]]; // a partition mid-room
		const got = nameWalls(roomPieces(frame([...SESSION_2, ...extra], TURN, SHIFT)), old.walls, { others: old.others });
		expect(got.missing).toEqual([]);
		expect(longNames(got.pieces)).toEqual(['Wall 2', 'Wall 4']);
		expect(wallsOf(got.pieces).find((p) => Math.abs(p.size[0] - 2.7) < 0.01)?.name).toBe('Wall 5');
	});

	it('a wall whose length changed by more than 3 cm is not the same wall: new number, the old one reported', () => {
		const rows = SESSION_2.map((r) => (r[0] === 'wall' && r[3][0] > 3 ? /** @type {typeof r} */ ([r[0], r[1] + 0.1, r[2], r[3], r[4]]) : r));
		const got = nameWalls(roomPieces(frame(rows, TURN, SHIFT)), old.walls, { others: old.others });
		expect(got.missing).toEqual(['Wall 2']);
		expect(wallsOf(got.pieces).find((p) => p.size[0] > 4.2)?.name).toBe('Wall 5');
		expect(WALL_LENGTH_TOL).toBe(0.03);
	});

	it('within 3 cm (a redone room setup, a slightly different trace) it is still the same wall', () => {
		const rows = SESSION_2.map((r) => (r[0] === 'wall' ? /** @type {typeof r} */ ([r[0], r[1] + 0.025, r[2], r[3], r[4]]) : r));
		const got = nameWalls(roomPieces(frame(rows, TURN, SHIFT)), old.walls, { others: old.others });
		expect(got.missing).toEqual([]);
		expect(longNames(got.pieces)).toEqual(['Wall 2', 'Wall 4']);
	});
});

describe('104 wall names — the toast and the edges', () => {
	it('lists several missing walls in plain words', () => {
		const one = scanSummary([], { created: 0, updated: 0, removed: 0, missing: ['Wall 1', 'Wall 3'] });
		expect(one).toContain('Wall 1 and Wall 3 not found in this scan.');
		const three = scanSummary([], { created: 0, updated: 0, removed: 0, missing: ['Wall 1', 'Wall 2', 'Wall 3'] });
		expect(three).toContain('Wall 1, Wall 2 and Wall 3 not found in this scan.');
		expect(scanSummary([], { created: 0, updated: 0, removed: 0, missing: [] })).not.toContain('not found');
	});

	it('only "Wall N" boxes are matched; malformed old walls are ignored, never a throw', () => {
		const pieces = roomPieces(frame(SESSION_1));
		const got = nameWalls(pieces, /** @type {any} */ ([{ name: 'Wall 1 (brick)', length: 3.422, position: [2.25, 1.3, -2.7], normal: [0, 0, 1] }, { name: 'Wall 7' }, null]));
		expect(got.pieces).toBe(pieces);
		expect(got.missing).toEqual([]);
	});

	it('old walls that match nothing at all: all reported, the new walls numbered after them', () => {
		const pieces = roomPieces(frame(SESSION_1));
		const far = [{ uuid: 'a', name: 'Wall 2', length: 9, position: [0, 1, 0], normal: [1, 0, 0] }];
		const got = nameWalls(pieces, far);
		expect(got.missing).toEqual(['Wall 2']);
		expect(wallsOf(got.pieces).map((p) => p.name)).toEqual(['Wall 3', 'Wall 4', 'Wall 5', 'Wall 6']);
	});
});
