// 93 LP4 — New game resets what the game keeps across levels: the kept variables (inventory, health, named
// ones) go, the variables the keep list does not name stay (they are the level's own business).
import { describe, it, expect } from 'vitest';
import { withoutKeptVars } from '../../src/lib/gameLevels/keep.js';
import { normalizeLevelsTable } from '../../src/lib/gameLevels/table.js';

describe('93 LP4 — New game resets the kept variables', () => {
	it('drops the kept variables and leaves the others', () => {
		const table = normalizeLevelsTable({ list: [{ name: 'One' }], keep: ['var:coins', 'inventory', 'score'] });
		const vars = { coins: 7, inventory: ['key'], doorOpen: 1 };
		expect(withoutKeptVars(vars, table)).toEqual({ doorOpen: 1 });
		expect(vars.coins).toBe(7); // pure
	});
	it('no keep list = nothing to reset (null: no write)', () => {
		expect(withoutKeptVars({ coins: 1 }, normalizeLevelsTable({ list: [{ name: 'One' }] }))).toBe(null);
		expect(withoutKeptVars({ doorOpen: 1 }, normalizeLevelsTable({ list: [{ name: 'One' }], keep: ['var:coins'] }))).toBe(null);
	});
});
