import { describe, it, expect } from 'vitest';
import { planEviction, fingerprint, dayLabel, formatBytes } from '../../src/lib/checkpointsCore.js';

const MB = 1024 * 1024;
/** @param {string} id @param {number} createdAt @param {number} mb @param {{pinned?: boolean, auto?: boolean}} [o] */
const row = (id, createdAt, mb, o = {}) => ({ id, createdAt, bytes: mb * MB, pinned: !!o.pinned, auto: !!o.auto });

describe('planEviction (36 B14)', () => {
	it('evicts nothing while both limits hold', () => {
		const rows = [row('new', 30, 10), row('a', 10, 10), row('b', 20, 10)];
		expect(planEviction(rows, 100 * MB, 60, 'new')).toEqual({ evict: [], fits: true });
	});

	it('evicts the OLDEST unpinned rows until the byte cap holds', () => {
		const rows = [row('new', 40, 40), row('a', 10, 40), row('b', 20, 40), row('c', 30, 40)];
		// 160 MB against 100: a then b go (oldest first), c stays
		expect(planEviction(rows, 100 * MB, 60, 'new')).toEqual({ evict: ['a', 'b'], fits: true });
	});

	it('takes automatic rows before named ones, whatever their age', () => {
		const rows = [row('new', 50, 30), row('named-old', 1, 30), row('auto-young', 40, 30, { auto: true })];
		expect(planEviction(rows, 70 * MB, 60, 'new').evict).toEqual(['auto-young']);
	});

	it('never evicts a pinned row or the newcomer', () => {
		const rows = [row('new', 50, 30), row('pin', 1, 30, { pinned: true }), row('x', 2, 30)];
		const plan = planEviction(rows, 60 * MB, 60, 'new');
		expect(plan.evict).toEqual(['x']);
		expect(plan.fits).toBe(true);
	});

	it('refuses (fits=false) when pinned rows alone are over the cap', () => {
		const rows = [row('new', 50, 30), row('p1', 1, 40, { pinned: true }), row('p2', 2, 40, { pinned: true })];
		expect(planEviction(rows, 100 * MB, 60, 'new')).toEqual({ evict: [], fits: false });
	});

	it('honours the row count as well as the bytes', () => {
		const rows = [row('new', 9, 0.1), ...Array.from({ length: 5 }, (_, i) => row('r' + i, i, 0.1))];
		expect(planEviction(rows, 1000 * MB, 4, 'new').evict).toEqual(['r0', 'r1']);
	});

	it('COUNTERFACTUAL: without the keepId guard the newest row is still never the first to go', () => {
		// the newcomer is the youngest, so even unguarded it sorts last; the guard matters when it
		// is an AUTO row and an older NAMED row would otherwise survive in its place
		const rows = [row('new', 50, 60, { auto: true }), row('named', 1, 60)];
		expect(planEviction(rows, 100 * MB, 60, 'new').evict).toEqual(['named']);
		expect(planEviction(rows, 100 * MB, 60, null).evict).toEqual(['new']);
	});
});

describe('fingerprint', () => {
	it('is stable for equal text and differs for a one-character change', () => {
		expect(fingerprint('{"objects":[1,2,3]}')).toBe(fingerprint('{"objects":[1,2,3]}'));
		expect(fingerprint('{"objects":[1,2,3]}')).not.toBe(fingerprint('{"objects":[1,2,4]}'));
		expect(fingerprint('')).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('labels', () => {
	const now = new Date(2026, 9, 5, 15, 0).getTime();
	it('names today and yesterday', () => {
		expect(dayLabel(new Date(2026, 9, 5, 1, 0).getTime(), now)).toBe('Today');
		expect(dayLabel(new Date(2026, 9, 4, 23, 59).getTime(), now)).toBe('Yesterday');
		expect(dayLabel(new Date(2026, 8, 1).getTime(), now)).not.toMatch(/Today|Yesterday/);
	});
	it('formats sizes', () => {
		expect(formatBytes(0)).toBe('0 KB');
		expect(formatBytes(500)).toBe('1 KB');
		expect(formatBytes(3.25 * MB)).toBe('3.3 MB');
		expect(formatBytes(42 * MB)).toBe('42 MB');
	});
});
