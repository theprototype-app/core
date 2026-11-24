// 80a K6: the idle-expiry rule (lockIdle.idleVerdict): ask LOCK_ASK_MS before the end, once; let go at the end.
import { describe, it, expect } from 'vitest';
import { idleVerdict, LOCK_IDLE_MS, LOCK_ASK_MS } from '../../src/lib/lockIdle.js';

describe('lock idle expiry', () => {
	const asked = new Set();
	it('keeps a recently edited object, asks before the end, lets go at the end', () => {
		const v = idleVerdict(
			[
				['fresh', 1000],
				['soon', LOCK_IDLE_MS - LOCK_ASK_MS + 1],
				['gone', LOCK_IDLE_MS]
			],
			asked
		);
		expect(v.ask).toEqual(['soon']);
		expect(v.release).toEqual(['gone']);
	});
	it('asks once', () => {
		const v = idleVerdict([['soon', LOCK_IDLE_MS - 1]], new Set(['soon']));
		expect(v.ask).toEqual([]);
		expect(v.release).toEqual([]);
	});
	it('lets go of an asked object at the end whatever was asked', () => {
		expect(idleVerdict([['soon', LOCK_IDLE_MS + 5]], new Set(['soon'])).release).toEqual(['soon']);
	});
	it('five minutes, asked thirty seconds before', () => {
		expect(LOCK_IDLE_MS).toBe(300000);
		expect(LOCK_ASK_MS).toBe(30000);
	});
	it('takes shorter windows for a test', () => {
		expect(idleVerdict([['a', 3500]], new Set(), { idleMs: 6000, askMs: 3000 }).ask).toEqual(['a']);
		expect(idleVerdict([['a', 6000]], new Set(), { idleMs: 6000, askMs: 3000 }).release).toEqual(['a']);
	});
});
