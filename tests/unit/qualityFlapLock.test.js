// 40 F12 — the user's phone: Aquarium's water switched its refraction OFF and ON by itself.
// Level 6 ("post off") drops the water's screen-space pass, so its frames are cheap and the
// governor recovered to level 5 after the hold — where the pass comes back and overloads 3 s
// later. The old flap rule only doubled the hold (10 / 20 / 40 / 80 s), so the switch kept
// flipping for as long as the scene was open. The flap LOCK: once a recovery had to be undone,
// it is not retried (until a new scene, "Keep full quality", or the auto switch).
import { describe, it, expect } from 'vitest';
import { createGovernor, phoneThresholds, overridesAt } from '../../src/lib/qualityGovernorCore.js';

const ctx = { profile: /** @type {'desktop'} */ ('desktop'), heavy: true, calls: 60 };

/**
 * A 60 Hz phone whose frame cost depends on the level: at `cheapFrom` and above the frames
 * are on time, below it every third frame is missed (the screen-space water pass). Decides
 * every 250 ms like the wiring and records every level change.
 * @param {ReturnType<typeof createGovernor>} g @param {number} from @param {number} dur @param {number} cheapFrom
 */
function phone(g, from, dur, cheapFrom) {
	/** @type {{t: number, level: number}[]} */
	const moves = [];
	let t = from;
	let i = 0;
	let next = from + 250;
	while (t < from + dur) {
		const ms = g.level() >= cheapFrom ? 16.7 : i % 3 === 0 ? 33.3 : 16.7;
		t += ms;
		i++;
		g.noteFrame(ms, t);
		if (t >= next) {
			next = t + 250;
			const d = g.decide(t, ctx);
			if (d.moved) moves.push({ t: Math.round(t), level: d.level });
		}
	}
	return { t, moves };
}

/** the water tier the level gives (waterRuntime.resolveTier's auto rule) @param {number} level */
const waterTier = (level) => {
	const o = overridesAt(level);
	return o.postOff ? 'quest' : o.aoOff || o.dprScale < 0.8 ? 'medium' : 'high';
};

/** how many times the water's refraction switched (quest <-> screen-space) @param {{level: number}[]} moves @param {number} start */
function refractionFlips(moves, start) {
	let flips = 0;
	let was = waterTier(start) === 'quest';
	for (const m of moves) {
		const now = waterTier(m.level) === 'quest';
		if (now !== was) flips++;
		was = now;
	}
	return flips;
}

describe('flap lock (F12)', () => {
	it('the phone premise: level 5 refracts, level 6 does not', () => {
		expect(waterTier(5)).toBe('medium');
		expect(waterTier(6)).toBe('quest');
	});

	it('COUNTERFACTUAL: without the lock the refraction keeps switching for the whole session', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(5, 0);
		// the lock disabled: clear it after every decision, which is the pre-F12 rule
		const realDecide = g.decide;
		g.decide = (t, c) => {
			const d = realDecide(t, c);
			g.clearFlapLock();
			return d;
		};
		const { moves } = phone(g, 1000, 600000, 6);
		expect(refractionFlips(moves, 5)).toBeGreaterThan(8);
	});

	it('with the lock: off, one retry, off for good — at most 3 switches in 10 minutes', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(5, 0);
		const { moves } = phone(g, 1000, 600000, 6);
		expect(refractionFlips(moves, 5)).toBeLessThanOrEqual(3);
		expect(g.level()).toBe(6);
		expect(g.flapLock()).toBe(6);
		// and the last move happened within the first minute: nothing after that
		expect(moves[moves.length - 1].t).toBeLessThan(61000);
	});

	it('a step up LONG after a walk down is a heavier scene, not a flap — no lock', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(6, 0);
		let t = phone(g, 1000, 15000, 0).t; // cheap everywhere: recovers 6 -> 5
		expect(g.level()).toBe(5);
		// a long calm, then the scene gets heavy
		const calm = phone(g, t, 60000, 0);
		t = calm.t;
		const heavyCtx = { ...ctx };
		for (let i = 0; i < 400; i++) {
			t += 33.3;
			g.noteFrame(33.3, t);
		}
		const lv = g.level();
		const d = g.decide(t, heavyCtx);
		expect(d.moved).toBe('up');
		expect(g.level()).toBe(lv + 1);
		expect(g.flapLock()).toBe(-1);
	});

	it('a scene that becomes LIGHT still walks back through the lock (new evidence)', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(5, 0);
		const { t } = phone(g, 1000, 120000, 6);
		expect(g.flapLock()).toBe(6);
		let tt = t;
		for (let i = 0; i < 700; i++) {
			tt += 16.7;
			g.noteFrame(16.7, tt);
		}
		expect(g.decide(tt, { ...ctx, heavy: false })).toMatchObject({ moved: 'down', reason: 'scene is light' });
	});

	it('clearFlapLock (a new scene) gives recovery back', () => {
		const g = createGovernor();
		g.setThresholds(phoneThresholds(60));
		g.setLevel(5, 0);
		const { t } = phone(g, 1000, 120000, 6);
		g.clearFlapLock();
		expect(g.flapLock()).toBe(-1);
		// cheap at every level now (a lighter scene): recovery walks down again
		const after = phone(g, t, 200000, 0);
		expect(after.moves.some((m) => m.level < 6)).toBe(true);
	});
});
