// 101 F5: the e2e facade `__tp.test.v1` forwards to the live hook table, is read-only, stays live
// for late registrations, and absorbs an internal rename with one table row (0 suite edits).
import { describe, test, expect } from 'vitest';
import { makeTestFacadeV1, TEST_V1_RENAMED_EXPORTS, TEST_V1_MOVED } from '../../src/lib/testFacade.js';
import { DEBUG_HOOKS } from '../../src/lib/debugHooks.js';

const fakeStores = () => {
	/** @type {Record<string, any>} */
	const s = { isLocked: { v: 1 }, history: { undo: () => 'u', undoStack: [1] } };
	return s;
};

describe('__tp.test.v1 facade (101 F5)', () => {
	test('forwards reads, identity included', () => {
		const s = fakeStores();
		const t = makeTestFacadeV1(s);
		expect(t.isLocked).toBe(s.isLocked);
		expect(t.history).toBe(s.history);
		expect(t.history.undo()).toBe('u');
		expect(t.nothing).toBeUndefined();
	});
	test('is read-only', () => {
		const t = /** @type {any} */ (makeTestFacadeV1(fakeStores()));
		expect(() => { t.isLocked = 2; }).toThrow(/read-only/);
		expect(() => { delete t.isLocked; }).toThrow(/read-only/);
		expect(() => Object.defineProperty(t, 'x', { value: 1 })).toThrow(/read-only/);
	});
	test('a hook registered after the install shows at once', () => {
		const s = fakeStores();
		const t = makeTestFacadeV1(s);
		expect('late' in t).toBe(false);
		s.late = { ok: true };
		expect(t.late.ok).toBe(true);
		expect('late' in t).toBe(true);
	});
	test('spread and keys see the live table', () => {
		const s = fakeStores();
		const t = makeTestFacadeV1(s);
		expect(Object.keys(t).sort()).toEqual(['history', 'isLocked']);
		expect({ ...t }.history).toBe(s.history);
	});
	test('PROOF: an internal export rename needs one row, no suite edit', () => {
		// the module renamed `undo` -> `undoLast`; a suite still calls t.history.undo()
		const s = { history: { undoLast: () => 'u2', undoStack: [1] } };
		const t = makeTestFacadeV1(s, { renamed: { history: { undo: 'undoLast' } } });
		expect(t.history.undo()).toBe('u2');
		expect(t.history.undoStack).toEqual([1]);
		expect('undo' in t.history).toBe(true);
		expect(Object.keys(t.history)).toContain('undo');
		expect(t.history).toBe(t.history);
		expect(() => { /** @type {any} */ (t.history).undo = null; }).toThrow(/read-only/);
	});
	test('PROOF: a moved hook needs one row', () => {
		const s = { perf2: { start: () => 's' } };
		const t = makeTestFacadeV1(s, { moved: { perf: (st) => st.perf2 } });
		expect(t.perf.start()).toBe('s');
		expect(Object.keys(t)).toContain('perf');
	});
	test('every rename / move row points at a hook the table publishes', () => {
		const names = new Set(DEBUG_HOOKS.map(([n]) => n));
		for (const hook of Object.keys(TEST_V1_RENAMED_EXPORTS)) expect(names.has(hook), hook).toBe(true);
		for (const v1 of Object.keys(TEST_V1_MOVED)) expect(names.has(v1), `${v1} is still a live name: drop the row`).toBe(false);
	});
});
