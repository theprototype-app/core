// 71-int: the receive gate's stats seam takes a type string a PEER chose, so it must never become a key on a plain
// object (`__proto__` would write onto Object.prototype in the receiver's page) or grow with every new string.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/stores/appStore', () => ({ showToast: vi.fn() }));
vi.mock('../../src/lib/peerModeration', () => ({ canModerate: () => false, peerLabel: (id) => id, removePeer: vi.fn() }));

const { admitRate, rateGateStats } = await import('../../src/lib/peerRateGate.js');

describe('peer rate gate stats', () => {
	it('a hostile type string cannot reach Object.prototype, and junk types are not kept', () => {
		const conn = { peer: 'evil', send: vi.fn() };
		for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(admitRate(conn, t)).toBe(true);
		for (let i = 0; i < 2000; i++) admitRate(conn, 'junk-' + i);
		const probe = /** @type {any} */ ({});
		expect(probe.last).toBeUndefined();
		expect(probe.ok).toBeUndefined();
		expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'last')).toBe(false);
		const by = rateGateStats().byType;
		expect(Object.keys(by).length).toBe(0);
		// the types the seam does report still count
		admitRate(conn, 'name');
		admitRate(conn, 'group', { type: 'group', pos: [0, 0, 0] });
		expect(Object.keys(rateGateStats().byType).sort()).toEqual(['group', 'name']);
		expect(rateGateStats().byType.group.ok).toBe(1);
	});
});
