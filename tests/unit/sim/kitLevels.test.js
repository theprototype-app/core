// 34 R2 — kit.levels on the logic sim: the table, unlocks, stars, per-device progress, carrying the
// level across modes, and the K3 picker feed.
import { describe, it, expect } from 'vitest';
import { createSim, agree } from './logicSim.js';
import { defaultStars, isUnlockedBy, normalizeProgress, betterResult } from '../../../src/lib/kit/levels.js';

const L = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.levels;
const TABLE = {
	id: 'demo',
	list: [
		{ id: '1', label: 'Stack', par: { time: 45, score: 100 } },
		{ id: '2', label: 'Planks', par: { time: 70 } },
		{ id: '3', label: 'Climb' }
	],
	modes: ['globe', 'board']
};
/** every peer defines the same table (the same module code runs on each) @param {any} sim */
const defineAll = (sim, table = TABLE) => {
	for (const p of sim.peers.values()) p.kit.impls.levels.extra.define(table);
};

describe('kit.levels — the table and the current level', () => {
	it('select reaches every peer; a locked level is refused with the reason', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		defineAll(sim);
		L(sim, 'c').select('1');
		sim.settle();
		expect([...sim.peers.values()].map((p) => p.kit.impls.levels.current())).toEqual(['1', '1', '1']);
		expect(L(sim, 'a').currentLabel()).toBe('Stack');
		expect(L(sim, 'a').index()).toBe(1);
		expect(L(sim, 'a').select('2')).toEqual({ ok: false, reason: 'Level Planks is locked' });
		expect(L(sim, 'a').select('9')).toEqual({ ok: false, reason: 'no level 9' });
	});
	it('a win unlocks the next level (the Towers chain: a star on the level before) and Next goes there', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		defineAll(sim);
		/** @type {any[]} */
		const unlocks = [];
		L(sim, 'b').on('unlockedNext', (/** @type {any} */ p) => unlocks.push(p.level));
		L(sim, 'a').select('1');
		const r = L(sim, 'a').complete(true, 120, 40);
		expect(r).toMatchObject({ ok: true, stars: 3 });
		sim.settle();
		expect(unlocks).toEqual(['2']);
		expect(L(sim, 'b').unlocked('2')).toBe(true);
		L(sim, 'b').next();
		sim.settle();
		expect(L(sim, 'a').current()).toBe('2');
	});
	it('a loss gives no stars and unlocks nothing', () => {
		const sim = createSim({ peers: ['a'] });
		defineAll(sim);
		L(sim, 'a').select('1');
		expect(L(sim, 'a').complete(false, 999, 10)).toMatchObject({ ok: true, stars: 0 });
		expect(L(sim, 'a').unlocked('2')).toBe(false);
		expect(L(sim, 'a').next()).toEqual({ ok: false, reason: 'Level Planks is locked' });
	});
	it("'all' unlocks every level; a custom rule decides when given", () => {
		const sim = createSim({ peers: ['a'] });
		L(sim, 'a').extra.define({ ...TABLE, unlock: 'all' });
		expect(L(sim, 'a').unlocked('3')).toBe(true);
		L(sim, 'a').extra.define({ ...TABLE, unlock: (/** @type {string} */ id) => id !== '2' });
		expect([L(sim, 'a').unlocked('2'), L(sim, 'a').unlocked('3')]).toEqual([false, true]);
	});
	it("the game's own star rule (Towers: win + par pieces + par time) replaces the default", () => {
		const sim = createSim({ peers: ['a'] });
		L(sim, 'a').extra.define({ ...TABLE, stars: (/** @type {any} */ level, /** @type {any} */ r) => (r.won ? (r.score <= 3 ? 2 : 1) : 0) });
		L(sim, 'a').select('1');
		expect(L(sim, 'a').complete(true, 3, 10).stars).toBe(2);
	});
	it('the time defaults to the kit round clock', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		defineAll(sim);
		sim.peer('a').kit.impls.round.configure(0, 0, 'lose', 2);
		sim.peer('a').kit.impls.round.start();
		L(sim, 'a').select('1');
		sim.advance(30_000);
		const r = L(sim, 'b').complete(true, 200, 0);
		sim.settle();
		expect(r.pending).toBe(true);
		expect(L(sim, 'a').extra.progress().levels['1'].time).toBeGreaterThan(29);
		expect(L(sim, 'a').extra.progress().levels['1'].time).toBeLessThan(31);
		expect(L(sim, 'b').starsOf('1')).toBe(3);
	});
});

describe('kit.levels — progress is per DEVICE, earned by everyone who was there', () => {
	it('every peer saves the stars it saw earned; a later joiner keeps its own (empty) device', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		defineAll(sim);
		L(sim, 'a').select('1');
		L(sim, 'a').complete(true, 100, 30);
		sim.settle();
		for (const id of ['a', 'b']) expect(sim.peer(id).storage.get('levels:demo').levels['1'].stars).toBe(3);
		const late = sim.add('c');
		late.kit.impls.levels.extra.define(TABLE);
		sim.join('c');
		sim.settle();
		expect(late.storage.get('levels:demo', null)).toBe(null);
		// …but the SESSION's result counts for its picker while it plays with them
		expect(late.kit.impls.levels.unlocked('2')).toBe(true);
		expect(late.kit.impls.levels.starsOf('1')).toBe(3);
	});
	it('a device keeps its best: a worse result never overwrites a better one', () => {
		const sim = createSim({ peers: ['a'] });
		defineAll(sim);
		L(sim, 'a').select('1');
		L(sim, 'a').complete(true, 100, 30);
		L(sim, 'a').complete(true, 0, 90);
		expect(sim.peer('a').storage.get('levels:demo').levels['1']).toEqual({ stars: 3, time: 30, score: 100 });
		expect(L(sim, 'a').totalStars()).toBe(3);
	});
	it("progress a device already holds unlocks levels on it (last week's save)", () => {
		const sim = createSim({ peers: ['a'] });
		sim.peer('a').storage.set('levels:demo', { levels: { 1: { stars: 1 }, 2: { stars: 2 } } });
		defineAll(sim);
		expect(L(sim, 'a').unlocked('3')).toBe(true);
		L(sim, 'a').select('3');
		expect(L(sim, 'a').current()).toBe('3');
	});
	it('where the device left off is remembered (resume)', () => {
		const sim = createSim({ peers: ['a'] });
		defineAll(sim);
		L(sim, 'a').select('1');
		expect(L(sim, 'a').extra.resumeLevel()).toBe('1');
	});
});

describe('kit.levels — carry the level across modes (31 U6)', () => {
	it('switching the mode keeps the current level and every star earned in either mode', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		defineAll(sim);
		L(sim, 'a').setMode('globe');
		L(sim, 'a').select('1');
		L(sim, 'a').complete(true, 100, 30);
		L(sim, 'a').next();
		sim.settle();
		L(sim, 'b').setMode('board');
		sim.settle();
		expect([L(sim, 'a').mode(), L(sim, 'a').current()]).toEqual(['board', '2']);
		expect(L(sim, 'b').starsOf('1')).toBe(3);
		expect(agree(sim)).toBe(true);
	});
});

describe('kit.levels — the K3 level picker feed', () => {
	it('the picker gets the table with locks + stars + current, and only when it changes; a pick selects', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		/** @type {any[]} */
		const published = [];
		L(sim, 'b').extra.attachShell((/** @type {any} */ spec, /** @type {string} */ owner) => {
			published.push({ spec, owner });
			return () => {};
		});
		defineAll(sim);
		expect(published.at(-1).spec.list.map((/** @type {any} */ l) => l.locked)).toEqual([false, true, true]);
		const count = published.length;
		sim.peer('a').kit.impls.round.start(); // a kit change that does not touch the picker
		sim.settle();
		expect(published.length).toBe(count);
		published.at(-1).spec.onPick('1'); // the player picked in the pause menu
		sim.settle();
		expect(L(sim, 'a').current()).toBe('1');
		expect(published.at(-1).spec.current).toBe('1');
	});
	it('define() through the SDK records the calling module as the owner and is torn down with it', () => {
		const sim = createSim({ peers: ['a'] });
		/** @type {any[]} */
		const owners = [];
		let removed = 0;
		L(sim, 'a').extra.attachShell((/** @type {any} */ _spec, /** @type {string} */ owner) => {
			owners.push(owner);
			return () => removed++;
		});
		/** @type {(() => void)[]} */
		const journal = [];
		const api = sim.peer('a').kit.api({ onDispose: (/** @type {() => void} */ fn) => journal.push(fn), moduleId: 'towers' });
		api.levels.define(TABLE);
		expect(owners.at(-1)).toBe('towers');
		expect(journal.length).toBe(1);
		journal.forEach((fn) => fn());
		expect(removed).toBe(1);
		expect(L(sim, 'a').extra.table()).toEqual([]);
	});
});

describe('kit.levels — pure helpers', () => {
	it('default stars: win, par time, par score (three for a win with no par)', () => {
		expect(defaultStars({ data: { par: { time: 45, score: 100 } } }, { won: true, time: 50, score: 120 })).toBe(2);
		expect(defaultStars({ data: { par: { time: 45, score: 100 } } }, { won: true, time: 40, score: 120 })).toBe(3);
		expect(defaultStars({ data: {} }, { won: true, time: 0, score: 0 })).toBe(3);
		expect(defaultStars({ data: {} }, { won: false, time: 0, score: 0 })).toBe(0);
	});
	it('unlock chain and progress normalisation', () => {
		const list = [{ id: 'a' }, { id: 'b' }];
		expect(isUnlockedBy(list, normalizeProgress({ levels: { a: { stars: 0 } } }), 'b', 'sequential')).toBe(false);
		expect(isUnlockedBy(list, normalizeProgress({ levels: { a: { stars: 1 } } }), 'b', 'sequential')).toBe(true);
		expect(normalizeProgress({ levels: { x: { stars: 'nope', time: -4 } } }).levels.x).toEqual({ stars: 0, time: 0, score: 0 });
		expect(betterResult({ stars: 2, time: 30, score: 5 }, { stars: 1, time: 20, score: 9 })).toEqual({ stars: 2, time: 20, score: 9 });
	});
});
