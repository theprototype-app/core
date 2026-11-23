import { describe, it, expect } from 'vitest';
import { runChecks, sortRows, summarize, ruleApplies } from '../../src/lib/export/checkCore.js';

/** @param {string} id @param {any} sev */
const row = (id, sev) => ({ id, owner: /** @type {const} */ ('scene'), severity: sev, title: id });

describe('checkCore (63: one check, two doors)', () => {
	it('sorts error, warn, info, then id, stable', () => {
		const out = sortRows([row('b', 'info'), row('z', 'warn'), row('a', 'error'), row('a', 'warn'), row('c', 'info')]);
		expect(out.map((r) => r.severity + ':' + r.id)).toEqual(['error:a', 'warn:a', 'warn:z', 'info:b', 'info:c']);
	});

	it('publish never blocks; an export target blocks on errors only', () => {
		const rows = [row('a', 'error'), row('b', 'warn'), row('c', 'info'), row('d', 'error')];
		expect(summarize(rows, 'publish')).toEqual({ error: 2, warn: 1, info: 1, blocking: 0 });
		expect(summarize(rows, 'itch')).toEqual({ error: 2, warn: 1, info: 1, blocking: 2 });
		expect(summarize([row('b', 'warn')], 'crazygames').blocking).toBe(0);
	});

	it('runs only the rules for the target; no targets = every target', () => {
		const a = { id: 'a', owner: /** @type {const} */ ('scene'), targets: ['publish'], run: () => [row('a', 'warn')] };
		const b = { id: 'b', owner: /** @type {const} */ ('export'), targets: ['itch'], run: () => [row('b', 'warn')] };
		const c = { id: 'c', owner: /** @type {const} */ ('scene'), run: () => [row('c', 'info')] };
		expect(ruleApplies(a, 'itch')).toBe(false);
		return runChecks([a, b, c], { target: 'publish' }).then((rows) => expect(rows.map((r) => r.id)).toEqual(['a', 'c']));
	});

	it('a throwing or async rule never hides the rest', async () => {
		const bad = { id: 'bad', owner: /** @type {const} */ ('scene'), run: () => { throw new Error('boom'); } };
		const slow = { id: 'slow', owner: /** @type {const} */ ('export'), run: async () => [{ id: '', severity: 'error', title: 'x' }] };
		const rows = await runChecks(/** @type {any} */ ([bad, slow]), { target: 'itch' });
		expect(rows[0]).toMatchObject({ id: 'slow', owner: 'export', severity: 'error' });
		expect(rows[1]).toMatchObject({ id: 'bad-failed', severity: 'info', owner: 'scene' });
		expect(rows[1].detail).toContain('boom');
	});

	it('drops malformed rows (no title)', async () => {
		const r = { id: 'r', owner: /** @type {const} */ ('scene'), run: () => /** @type {any} */ ([null, { id: 'x' }, row('ok', 'warn')]) };
		expect((await runChecks([r], { target: 'publish' })).map((x) => x.id)).toEqual(['ok']);
	});
});
