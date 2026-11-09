// 93 LP5 — a resumed save writes the kept VARIABLES back (restoreKept covers the score and module-owned state;
// the travel carry re-asserts vars on a hop, but a reload has no hop to carry them). Found by levels-export:
// coins came back 0 after a reload.
import { describe, it, expect } from 'vitest';
import { withKeptVars } from '../../src/lib/gameLevels/keep.js';

describe('93 LP5 — resuming a save restores the kept variables', () => {
	it('lays the saved kept vars over the scene\'s own', () => {
		const vars = { coins: 0, doorOpen: 1 };
		expect(withKeptVars(vars, { vars: { coins: 5 } })).toEqual({ coins: 5, doorOpen: 1 });
		expect(vars.coins).toBe(0); // pure
	});
	it('nothing kept = no write (null)', () => {
		expect(withKeptVars({ coins: 0 }, { vars: {} })).toBe(null);
		expect(withKeptVars({ coins: 0 }, null)).toBe(null);
		expect(withKeptVars(undefined, { vars: { coins: 2 } })).toEqual({ coins: 2 });
	});
});
