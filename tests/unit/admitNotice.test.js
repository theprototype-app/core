import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { composeAdmitNotice, shortPeer } from '../../src/lib/admitNotice.js';
import { connectBadge, setConnectBadge, peerMenuItems, setPeerMenuItems } from '../../src/lib/cloudHooks.js';

// F-5: an automatic admission is never silent, and a standing "guests join" setting is visible.
describe('F-5 auto-admit notice', () => {
	it('uses the provider text and its Turn off', () => {
		let off = 0;
		const n = composeAdmitNotice('e6f54', {
			text: 'E6F54 joined as a guest (view-only) because Allow guests to join automatically is on.',
			turnOff: () => off++
		});
		expect(n.text).toMatch(/joined as a guest/);
		expect(n.turnOffLabel).toBe('Turn off');
		n.turnOff?.();
		expect(off).toBe(1);
	});
	it('falls back to a generic line with no Turn off (no provider, a throwing one, junk)', () => {
		for (const provided of [null, undefined, 'x', 42, { text: '   ' }, { turnOff: 'nope' }]) {
			const n = composeAdmitNotice('a1b2c', provided);
			expect(n.text).toBe('A1B2C joined automatically — your session settings let them in without approval.');
			expect(n.turnOff).toBeNull();
		}
	});
	it('caps what the provider can put on screen', () => {
		const n = composeAdmitNotice('a1b2c', { text: 'x'.repeat(500), turnOffLabel: 'y'.repeat(80), turnOff() {} });
		expect(n.text.length).toBe(200);
		expect(n.turnOffLabel.length).toBe(24);
	});
	it('shortPeer is the six-char upper-case id the other join toasts use', () => {
		expect(shortPeer('e6f54')).toBe('E6F54');
		expect(shortPeer(/** @type {any} */ (undefined))).toBe('');
	});
});

describe('F-5 Connect pill badge seam', () => {
	it('normalises, caps and clears', () => {
		setConnectBadge({ text: '  Public · guests join  ', title: 'Anyone can join', onClick: () => {} });
		const b = get(connectBadge);
		expect(b?.text).toBe('Public · guests join');
		expect(b?.title).toBe('Anyone can join');
		expect(typeof b?.onClick).toBe('function');
		setConnectBadge({ text: 'z'.repeat(99) });
		expect(get(connectBadge)?.text.length).toBe(32);
		expect(get(connectBadge)?.onClick).toBeNull();
		for (const v of [null, {}, { text: '' }, 'Public']) {
			setConnectBadge(v);
			expect(get(connectBadge)).toBeNull();
		}
	});
});

describe('reports: Users peer menu seam', () => {
	it('keeps only runnable, labelled items, capped', () => {
		const run = () => {};
		setPeerMenuItems([{ id: 'report', label: ' Report… ', run }, { label: 'no run' }, { label: '', run }, null]);
		expect(get(peerMenuItems)).toEqual([{ id: 'report', label: 'Report…', run }]);
		setPeerMenuItems(Array.from({ length: 12 }, (_, n) => ({ label: 'x' + n, run })));
		expect(get(peerMenuItems).length).toBe(8);
		setPeerMenuItems('junk');
		expect(get(peerMenuItems)).toEqual([]);
	});
});
