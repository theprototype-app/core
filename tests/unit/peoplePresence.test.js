import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { mergeRowMeta, presenceOf, sparkPoints, publishPresence, setPresenceEnabled, setMyPresence, presenceEnabled } from '../../src/lib/peoplePresence.js';
import { peers, userdata } from '../../src/stores/appStore.js';

describe('mergeRowMeta (roster slot 6)', () => {
	it('keeps 55 A7 kind semantics with no presence on either side', () => {
		expect(mergeRowMeta(undefined, { kind: 'agent' })).toEqual({ kind: 'agent' });
		expect(mergeRowMeta({ kind: 'agent' }, { kind: 'x' })).toEqual({ kind: 'person' });
	});

	it('takes a NEWER owner stamp', () => {
		const local = { kind: 'person', presence: 'available', presenceAt: 10 };
		expect(mergeRowMeta(local, { kind: 'person', presence: 'busy', presenceAt: 20 })).toEqual({ kind: 'person', presence: 'busy', presenceAt: 20 });
	});

	it('refuses an OLDER stamp (a host relaying a stale roster cannot put an old status back)', () => {
		const local = { kind: 'person', presence: 'busy', presenceAt: 20 };
		expect(mergeRowMeta(local, { kind: 'person', presence: 'available', presenceAt: 10 }).presence).toBe('busy');
	});

	it('keeps the status when the incoming row says nothing about it (an older relay)', () => {
		const local = { kind: 'person', presence: 'away', presenceAt: 5 };
		expect(mergeRowMeta(local, { kind: 'person' })).toEqual(local);
	});

	it('a newer empty status CLEARS (turned off on their side)', () => {
		const local = { kind: 'person', presence: 'away', presenceAt: 5 };
		const out = mergeRowMeta(local, { kind: 'person', presence: '', presenceAt: 9 });
		expect(presenceOf(['x', '', '', null, null, null, out])).toBe('');
	});

	it('never takes a status for OUR OWN row from outside', () => {
		const local = { kind: 'person', presence: 'busy', presenceAt: 5 };
		expect(mergeRowMeta(local, { kind: 'person', presence: 'away', presenceAt: 99 }, { self: true }).presence).toBe('busy');
	});

	it('drops garbage', () => {
		const out = mergeRowMeta({}, { kind: 'person', presence: '<b>x</b>', presenceAt: 3 });
		expect(out.presence).toBe('');
		expect(presenceOf(['x', '', '', null, null, null, { presence: 'nope' }])).toBe('');
		expect(presenceOf(null)).toBe('');
	});
});

describe('publishPresence', () => {
	/** @type {any[]} */
	let sent;
	beforeEach(() => {
		sent = [];
		peers.set(/** @type {any} */ ({ peer: { id: 'me' }, send: (/** @type {any} */ m) => sent.push(m) }));
		userdata.set(/** @type {any} */ ([['me', 'Mira', ''], ['sam', 'Sam', '']]));
		presenceEnabled.set(false);
	});

	it('writes our row and sends the roster once per change', () => {
		setPresenceEnabled(true);
		setMyPresence('busy');
		const me = /** @type {any[]} */ (get(userdata)).find((r) => r[0] === 'me');
		expect(presenceOf(me)).toBe('busy');
		expect(sent.length).toBe(2);
		publishPresence();
		expect(sent.length).toBe(2); // nothing new to say
	});

	it('off sends an empty status (clears it on peers)', () => {
		setPresenceEnabled(true);
		setPresenceEnabled(false);
		const me = /** @type {any[]} */ (get(userdata)).find((r) => r[0] === 'me');
		expect(me[6].presence).toBe('');
		expect(me[6].presenceAt).toBeGreaterThan(0);
	});
});

describe('sparkPoints', () => {
	it('is empty without samples and fits the box', () => {
		expect(sparkPoints([], 100, 20)).toBe('');
		const pts = sparkPoints([10, 30, 20], 100, 20).split(' ').map((p) => p.split(',').map(Number));
		expect(pts[0][0]).toBe(0);
		expect(pts[2][0]).toBe(100);
		for (const [, y] of pts) expect(y >= 0 && y <= 20).toBe(true);
	});
});
