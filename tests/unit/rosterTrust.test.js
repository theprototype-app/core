import { describe, it, expect } from 'vitest';
import { acceptedRosterRows, acceptedMeshIds } from '../../src/lib/rosterTrust.js';

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

	it('keeps the sender speaking for itself and rows we already hold', () => {
		const rows = [['g', 'Me', ''], ['held', 'A', ''], ['new', '', '']];
		expect(acceptedRosterRows(rows, guest)).toEqual([['g', 'Me', ''], ['held', 'A', '']]);
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
