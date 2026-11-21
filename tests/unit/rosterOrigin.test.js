// 80a R1: roster changes are tied to the connection that made them.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { userdata } from '../../src/stores/appStore.js';
import { noteRosterRows, confirmRosterRows, rollBackRosterRows, rosterOriginOf, shareableRosterRows } from '../../src/lib/rosterOrigin.js';

/** @type {any} */
const roster = userdata;
const ids = () => /** @type {any[]} */ (get(userdata)).map((u) => u[0]);

describe('roster origin', () => {
	beforeEach(() => roster.set([['me', 'Me', ''], ['x', '', '']]));
	it('rolls back with the request', () => {
		const before = new Set(ids());
		roster.update((/** @type {any[]} */ u) => [...u, ['a', 'A', ''], ['b', 'B', '']]);
		noteRosterRows('x', [['x', 'X', ''], ['a', 'A', ''], ['b', 'B', '']], before, true);
		expect(rosterOriginOf('a')).toBe('x');
		expect(rosterOriginOf('x')).toBe(null);
		const gone = rollBackRosterRows('x', { self: 'me', linked: (id) => id === 'b' });
		expect(gone).toEqual(['a']);
		expect(ids()).toEqual(['me', 'x', 'b']);
	});
	it('an approval keeps them', () => {
		const before = new Set(ids());
		roster.update((/** @type {any[]} */ u) => [...u, ['a', 'A', '']]);
		noteRosterRows('x', [['a', 'A', '']], before, true);
		confirmRosterRows('x');
		expect(rollBackRosterRows('x')).toEqual([]);
		expect(ids()).toContain('a');
	});
	it('keeps rows another source confirms', () => {
		const before = new Set(ids());
		roster.update((/** @type {any[]} */ u) => [...u, ['a', 'A', '']]);
		noteRosterRows('x', [['me', 'Me', ''], ['a', 'A', '']], before, true);
		expect(rosterOriginOf('me')).toBe(null);
		noteRosterRows('host', [['a', 'A', '']], new Set(ids()), false);
		expect(rollBackRosterRows('x')).toEqual([]);
		expect(ids()).toContain('a');
	});
	it('shareable rows', () => {
		const rows = [['me'], ['x'], ['y']];
		expect(shareableRosterRows(rows, [['x', 'pending']])).toEqual([['me'], ['y']]);
		expect(shareableRosterRows(rows, [])).toBe(rows);
		expect(shareableRosterRows(rows, [['x', 'approved']])).toEqual(rows);
	});
});
