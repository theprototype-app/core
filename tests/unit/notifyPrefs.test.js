// profile-notify — the per-device notification switches (src/lib/notifyPrefs.js): absent = on, only the kinds switched
// OFF are stored, unknown kinds are never silenced, and Reset puts every switch back on.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { NOTIFY_KINDS, notifyPrefs, notifyOn, setNotify, resetNotifyPrefs } from '../../src/lib/notifyPrefs.js';

describe('notifyPrefs', () => {
	beforeEach(() => resetNotifyPrefs());

	it('every kind starts on (today’s behaviour), and an unknown kind is on', () => {
		for (const k of NOTIFY_KINDS) expect(notifyOn(k.id)).toBe(true);
		expect(notifyOn('no-such-kind')).toBe(true);
	});

	it('a switch turns one kind off and back on; only the off ones are kept', () => {
		setNotify('peerLeft', false);
		expect(notifyOn('peerLeft')).toBe(false);
		expect(notifyOn('chat')).toBe(true);
		expect(get(notifyPrefs)).toEqual({ peerLeft: false });
		setNotify('peerLeft', true);
		expect(notifyOn('peerLeft')).toBe(true);
		expect(get(notifyPrefs)).toEqual({});
	});

	it('an unknown kind cannot be switched off', () => {
		setNotify('no-such-kind', false);
		expect(notifyOn('no-such-kind')).toBe(true);
		expect(get(notifyPrefs)).toEqual({});
	});

	it('reset turns every switch back on', () => {
		for (const k of NOTIFY_KINDS) setNotify(k.id, false);
		resetNotifyPrefs();
		for (const k of NOTIFY_KINDS) expect(notifyOn(k.id)).toBe(true);
	});

	it('each kind has a label, a sentence and search words; ids are unique', () => {
		const ids = new Set();
		for (const k of NOTIFY_KINDS) {
			expect(k.label.length).toBeGreaterThan(2);
			expect(k.description.trim().endsWith('.')).toBe(true);
			expect(k.keywords.split(' ').length).toBeGreaterThan(1);
			expect(ids.has(k.id)).toBe(false);
			ids.add(k.id);
		}
	});
});
