import { describe, it, expect } from 'vitest';
import {
	LEVELS, SHAPES, ZONES, levelById, nextLevelId, supplyCount, goalHeight, starsFor, starsText, formatTime,
	normalizeProgress, mergeResult, isUnlocked, totalStars, layoutSupply, towerTop, towerPieces, isOutside,
	outlineCells, cellsFilled, gustAt, gust, windFrom, judge, verdictTitle, STATUS, statusName, HOLD_SECONDS
} from '../../src/modules/towers/levels.js';

// 31-towers P2: the Towers levels leaf — data, stars, unlocks, layout, the judge, the wind.

describe('the level table', () => {
	it('twelve levels, ids 1..12, each with a known zone, known shapes, a goal and par', () => {
		expect(LEVELS.map((l) => l.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		for (const l of LEVELS) {
			expect(ZONES[/** @type {string} */ (l.zone)]).toBeTruthy();
			for (const s of l.supply) expect(SHAPES[/** @type {string} */ (s.shape)]).toBeTruthy();
			expect(['height', 'outline', 'deliver']).toContain(l.goal.type);
			expect(l.par.pieces).toBeGreaterThan(0);
			expect(l.par.time).toBeLessThan(l.limit);
			expect(l.par.pieces).toBeLessThanOrEqual(supplyCount(l));
			expect(typeof l.intro).toBe('string');
		}
	});
	it('the shapes progress: cubes, then planks, wedges, barrels, arches, balls, a heavy base', () => {
		const firstUse = (/** @type {string} */ shape) => LEVELS.find((l) => l.supply.some((/** @type {any} */ s) => s.shape === shape))?.id;
		expect(firstUse('cube')).toBe(1);
		expect(firstUse('plank')).toBe(2);
		expect(firstUse('wedge')).toBe(4);
		expect(firstUse('barrel')).toBe(5);
		expect(firstUse('arch')).toBe(6);
		expect(firstUse('lblock')).toBe(6);
		expect(firstUse('ball')).toBe(9);
		expect(firstUse('base')).toBe(10);
		expect(firstUse('star')).toBe(12);
	});
	it('lookups', () => {
		expect(levelById('3')?.name).toBe('Climb');
		expect(levelById(13)).toBe(null);
		expect(nextLevelId(11)).toBe(12);
		expect(nextLevelId(12)).toBe(null);
		expect(goalHeight(levelById(3))).toBe(3.6);
		expect(goalHeight(levelById(11))).toBeGreaterThan(1);
	});
});

describe('stars and progress', () => {
	const l1 = levelById(1);
	it('a win is a star, par pieces and par time a star each; a loss is none', () => {
		expect(starsFor(l1, { won: false, time: 10, pieces: 1 })).toBe(0);
		expect(starsFor(l1, { won: true, time: 999, pieces: 99 })).toBe(1);
		expect(starsFor(l1, { won: true, time: 999, pieces: 3 })).toBe(2);
		expect(starsFor(l1, { won: true, time: 45, pieces: 3 })).toBe(3);
		expect(starsText(2)).toBe('★★☆');
		expect(formatTime(92.2)).toBe('1:33');
	});
	it('the saved progress keeps the best of every number and ignores rubbish', () => {
		let p = normalizeProgress({ levels: { 1: { stars: 9, time: 'x' }, 99: { stars: 3 }, 2: { stars: 0 } } });
		expect(p).toEqual({ levels: { 1: { stars: 3, time: 0, pieces: 0 } } });
		p = mergeResult({}, 1, { stars: 1, time: 80, pieces: 5 });
		p = mergeResult(p, 1, { stars: 2, time: 95, pieces: 3 });
		p = mergeResult(p, 1, { stars: 0, time: 10, pieces: 1 }); // a loss changes nothing
		expect(p.levels['1']).toEqual({ stars: 2, time: 80, pieces: 3 });
		expect(totalStars(p)).toBe(2);
	});
	it('level 1 is open; level k+1 opens with a star on level k', () => {
		expect(isUnlocked({}, 1)).toBe(true);
		expect(isUnlocked({}, 2)).toBe(false);
		const p = mergeResult({}, 1, { stars: 1, time: 100, pieces: 5 });
		expect(isUnlocked(p, 2)).toBe(true);
		expect(isUnlocked(p, 3)).toBe(false);
		expect(isUnlocked(p, 99)).toBe(false);
	});
});

describe('the supply layout', () => {
	// two 1.6 x 0.8 x 4 racks either side of the spawn, a 3 m ledge, a perch
	const racks = {
		'Rack west': { min: [-5, 0, 0.2], max: [-3.4, 0.8, 4.2] },
		'Rack east': { min: [3.4, 0, 0.2], max: [5, 0.8, 4.2] },
		'High ledge': { min: [-1.5, 2.7, -3.45], max: [1.5, 3.0, -2.55] },
		'Star perch': { min: [2.05, 3.2, -2.55], max: [2.75, 3.4, -1.85] }
	};
	const sizes = {
		cube: [0.6, 0.6, 0.6], plank: [1.4, 0.3, 0.6], beam: [2.0, 0.25, 0.4], wedge: [0.8, 0.6, 0.6],
		barrel: [0.6, 0.7, 0.6], arch: [1.2, 0.8, 0.5], lblock: [0.9, 0.5, 0.9], ball: [0.6, 0.6, 0.6],
		base: [1.4, 0.35, 1.4], star: [0.5, 0.5, 0.5]
	};
	const inside = (/** @type {number[]} */ p, /** @type {any} */ b) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[2] >= b.min[2] && p[2] <= b.max[2];
	it('every level deals every piece onto a rack, nothing hanging off', () => {
		for (const l of LEVELS) {
			const slots = layoutSupply(l, racks, sizes);
			expect(slots.length).toBe(supplyCount(l));
			for (const s of slots) expect(Object.values(racks).some((b) => inside(s.pos, b) && s.pos[1] > b.max[1])).toBe(true);
		}
	});
	it('the climb level puts three cubes on the HIGH ledge, the summit its star on the perch', () => {
		const climb = layoutSupply(levelById(3), racks, sizes);
		expect(climb.filter((s) => s.pos[1] > 2.9).length).toBe(3);
		const summit = layoutSupply(levelById(12), racks, sizes);
		expect(summit.filter((s) => s.shape === 'star').every((s) => inside(s.pos, racks['Star perch']))).toBe(true);
	});
	it('slots on one rack never overlap (a stacked pair shares a column, one above the other)', () => {
		for (const l of LEVELS) {
			const slots = layoutSupply(l, racks, sizes);
			for (let i = 0; i < slots.length; i++)
				for (let j = i + 1; j < slots.length; j++) {
					const a = slots[i], b = slots[j];
					const sameColumn = Math.abs(a.pos[0] - b.pos[0]) < 1e-6 && Math.abs(a.pos[2] - b.pos[2]) < 1e-6;
					if (sameColumn) expect(Math.abs(a.pos[1] - b.pos[1])).toBeGreaterThan(0.2);
					else expect(Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2])).toBeGreaterThan(0.3);
				}
		}
	});
});

describe('measuring', () => {
	const zone = { center: [0, 0, 0], footprint: 1.9, yard: 3.4, top: 0.2 };
	const piece = (/** @type {number[]} */ pos, /** @type {number} */ top, /** @type {any} */ over = {}) => ({ uuid: String(Math.random()), pos, top, bottom: top - 0.6, speed: 0, held: false, ...over });
	it('the tower is the resting, unheld pieces over the zone', () => {
		const ps = [piece([0, 0.5, 0], 0.8), piece([0.3, 1.1, 0], 1.4), piece([0, 2, 0], 2.3, { held: true }), piece([0, 1.7, 0], 2.0, { speed: 2 }), piece([4, 0.3, 0], 0.6)];
		expect(towerPieces(ps, zone).length).toBe(2);
		expect(towerTop(ps, zone)).toBe(1.4);
		expect(towerTop([], zone)).toBe(0.2);
	});
	it('a resting piece on the floor outside the yard and off every rack is lost', () => {
		const rack = { min: [3.4, 0, 0.2], max: [5, 0.8, 4.2] };
		expect(isOutside({ pos: [0, 0.3, 4], bottom: 0, speed: 0, held: false }, zone, [rack])).toBe(true);
		expect(isOutside({ pos: [0, 0.3, 3], bottom: 0, speed: 0, held: false }, zone, [rack])).toBe(false); // in the yard
		expect(isOutside({ pos: [4, 1.1, 2], bottom: 0.8, speed: 0, held: false }, zone, [rack])).toBe(false); // on a rack
		expect(isOutside({ pos: [0, 0.3, 4], bottom: 0, speed: 1, held: false }, zone, [rack])).toBe(false); // still moving
	});
	it('the outline: six cells on the pad, counted by resting boxes', () => {
		const cells = outlineCells(zone);
		expect(cells.length).toBe(6);
		const box = (/** @type {number[]} */ c) => ({ min: [c[0] - 0.3, c[1] - 0.3, c[2] - 0.3], max: [c[0] + 0.3, c[1] + 0.3, c[2] + 0.3] });
		expect(cellsFilled(cells, cells.slice(0, 4).map(box))).toBe(4);
		expect(cellsFilled(cells, cells.map(box))).toBe(6);
		expect(cellsFilled(cells, cells.map((c) => ({ ...box(c), held: true })))).toBe(0);
	});
});

describe('the wind', () => {
	const gusts = levelById(8);
	it('no wind, no gust; the schedule is deterministic and turns', () => {
		expect(gustAt(levelById(1), 100)).toBe(null);
		expect(gustAt(gusts, 7.9)).toBe(null);
		expect(gustAt(gusts, 8)?.index).toBe(0);
		expect(gustAt(gusts, 17.5)?.index).toBe(1);
		expect(gust(gusts, 1).at).toBe(17);
		expect(gust(gusts, 0).dir).not.toEqual(gust(gusts, 1).dir);
		expect(gust(gusts, 3)).toEqual(gust(gusts, 3));
		expect(windFrom([1, 0, 0])).toBe('west');
		expect(windFrom([0, 0, 1])).toBe('north');
	});
});

describe('the judge', () => {
	const l1 = levelById(1); // goal 1.8, lost 2, limit 180
	const step = (/** @type {any} */ memo, /** @type {any} */ over) => judge(l1, { elapsed: 10, top: 0.2, anyHeld: false, lost: 0, ...over }, memo);
	it('a tower at the goal must HOLD for three seconds, and a hand on a piece restarts the count', () => {
		let r = step(null, { elapsed: 10, top: 1.9 });
		expect(r.verdict).toBe(null);
		expect(r.hold).toBe(HOLD_SECONDS);
		r = step(r.memo, { elapsed: 11.2, top: 1.9 });
		expect(r.hold).toBe(2);
		r = step(r.memo, { elapsed: 11.5, top: 1.9, anyHeld: true });
		expect(r.hold).toBe(0);
		r = step(r.memo, { elapsed: 12, top: 1.9 });
		r = step(r.memo, { elapsed: 14.9, top: 1.9 });
		expect(r.verdict).toBe(null);
		r = step(r.memo, { elapsed: 15.1, top: 1.9 });
		expect(r.verdict).toBe('won');
	});
	it('out of time, out of pieces, a collapse', () => {
		expect(step(null, { elapsed: 180 }).verdict).toBe('time');
		expect(step(null, { lost: 3 }).verdict).toBe('lost');
		expect(step(null, { lost: 2 }).verdict).toBe(null);
		let r = step(null, { elapsed: 20, top: 1.3 });
		r = step(r.memo, { elapsed: 21.5, top: 0.4 });
		expect(r.verdict).toBe('fell');
		// taking the tower down piece by piece is slower than a fall
		r = step(null, { elapsed: 20, top: 1.3 });
		r = step(r.memo, { elapsed: 26, top: 0.4 });
		expect(r.verdict).toBe(null);
	});
	it('outline and deliver goals', () => {
		const outline = levelById(11);
		expect(judge(outline, { elapsed: 5, top: 1.4, filled: 5, cells: 6, anyHeld: false, lost: 0 }, null).hold).toBe(0);
		expect(judge(outline, { elapsed: 5, top: 1.4, filled: 6, cells: 6, anyHeld: false, lost: 0 }, null).hold).toBe(3);
		const summit = levelById(12);
		expect(judge(summit, { elapsed: 5, top: 3.9, star: { top: 3.9, inTower: false }, anyHeld: false, lost: 0 }, null).hold).toBe(0);
		expect(judge(summit, { elapsed: 5, top: 3.9, star: { top: 3.9, inTower: true }, anyHeld: false, lost: 0 }, null).hold).toBe(3);
		expect(judge(summit, { elapsed: 5, top: 3.9, starLost: true, anyHeld: false, lost: 0 }, null).verdict).toBe('star');
	});
	it('the words', () => {
		expect(verdictTitle('won')).toBe('Level complete!');
		expect(statusName(STATUS.fell)).toBe('fell');
	});
});
