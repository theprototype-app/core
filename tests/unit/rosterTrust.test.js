import { describe, it, expect } from 'vitest';
import { acceptedRosterRows, acceptedMeshIds, acceptsGoneReport, asSendersOwn, acceptedChatLines, SELF_SPOKEN } from '../../src/lib/rosterTrust.js';

const known = (/** @type {string} */ id) => id === 'held';
const guest = { from: 'g', speaksForSession: false, known };
const host = { from: 'h', speaksForSession: true, known };

describe('acceptedRosterRows', () => {
	it('takes new ids from the peer that speaks for the session', () => {
		const rows = [['new', '', ''], ['held', 'A', '']];
		expect(acceptedRosterRows(rows, host)).toEqual(rows);
	});

	it('drops a new id from anybody else', () => {
		expect(acceptedRosterRows([['new', '', '']], guest)).toEqual([]);
	});

	it('lets anybody else speak only for its own row', () => {
		const rows = [['g', 'Me', ''], ['held', 'A', ''], ['new', '', '']];
		expect(acceptedRosterRows(rows, guest)).toEqual([['g', 'Me', '']]);
	});

	it('does not let a guest change a row we already hold, whatever the fields', () => {
		const forged = ['held', 'Someone', 'data:image/png;base64,AA', null, null, { character: 'x' }, { kind: 'agent' }];
		expect(acceptedRosterRows([forged], guest)).toEqual([]);
		expect(acceptedRosterRows([forged], host)).toEqual([forged]);
	});

	it('takes the sender\'s own row even before we hold it', () => {
		expect(acceptedRosterRows([['g', 'Me', '']], { from: 'g', speaksForSession: false })).toEqual([['g', 'Me', '']]);
	});

	it('drops malformed rows from a guest', () => {
		expect(acceptedRosterRows([null, 'g', [7], {}], guest)).toEqual([]);
	});
});

describe('acceptedMeshIds', () => {
	it('takes new ids only from the peer that speaks for the session', () => {
		expect(acceptedMeshIds(['new', 'held'], host)).toEqual(['new', 'held']);
		expect(acceptedMeshIds(['new', 'held'], guest)).toEqual(['held']);
	});

	it('does not let a guest name itself into a dial it did not earn, and drops non-strings', () => {
		expect(acceptedMeshIds(['g', 7, null], guest)).toEqual([]);
		expect(acceptedMeshIds([7, null], host)).toEqual([]);
	});
});

describe('acceptsGoneReport', () => {
	it('takes a goodbye from the peer itself', () => {
		expect(acceptsGoneReport('g', guest)).toBe(true);
	});

	it('takes word of somebody else only from the peer that speaks for the session', () => {
		expect(acceptsGoneReport('held', host)).toBe(true);
		expect(acceptsGoneReport('held', guest)).toBe(false);
	});

	it('drops a malformed id', () => {
		expect(acceptsGoneReport(undefined, host)).toBe(false);
		expect(acceptsGoneReport(7, guest)).toBe(false);
	});
});

describe('asSendersOwn', () => {
	it('leaves a peer speaking for itself untouched', () => {
		const m = { type: 'camera', peerId: 'g', position: [0, 0, 0] };
		expect(asSendersOwn(m, 'g')).toBe(m);
	});

	it('reads presence and chat that name somebody else, or nobody, as the sender\'s own', () => {
		for (const [type, field] of Object.entries(SELF_SPOKEN)) {
			const m = { type, [field]: 'k', x: 1 };
			expect(asSendersOwn(m, 'g')).toEqual({ type, [field]: 'g', x: 1 });
			expect(m[field]).toBe('k');
			expect(asSendersOwn({ type }, 'g')[field]).toBe('g');
		}
	});

	it('leaves every other message to its own rules', () => {
		const move = { type: 'move', peerId: 'k' };
		expect(asSendersOwn(move, 'g')).toBe(move);
		const odd = { type: 'toString', peerId: 'k' };
		expect(asSendersOwn(odd, 'g')).toBe(odd);
		expect(asSendersOwn(null, 'g')).toBe(null);
	});
});

describe('acceptedChatLines', () => {
	const lines = [
		{ id: '1', text: 'a', sender: 'g' },
		{ id: '2', text: 'b', sender: 'k' },
		{ id: '3', text: 'c', sender: '' }
	];
	it('takes every line from the peer that speaks for the session', () => {
		expect(acceptedChatLines(lines, host)).toEqual(lines);
	});
	it('takes only its own lines from anybody else', () => {
		expect(acceptedChatLines(lines, guest)).toEqual([lines[0]]);
	});
	it('drops a malformed history', () => {
		expect(acceptedChatLines('x', host)).toEqual([]);
	});
});
