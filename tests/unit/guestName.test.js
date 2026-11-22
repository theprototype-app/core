// 78 PL34: nobody is "Peer" — the guest names and the join ask
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { nextGuestName, guestClash, displayName, isGuestName, maybeAskJoinName, joinNameAsk, saveJoinName, hasOwnName } from '../../src/lib/guestName.js';
import { safeStorage } from '../../src/lib/safeStorage.js';
import { username } from '../../src/stores/appStore.js';

describe('nextGuestName', () => {
	it('gives the host Guest 1 and the first joiner Guest 2', () => {
		expect(nextGuestName([['me', '']], 'me', true)).toBe('Guest 1');
		expect(nextGuestName([['host', 'Guest 1'], ['me', '']], 'me', false)).toBe('Guest 2');
	});
	it('skips every number another row wears, never our own', () => {
		const roster = [['a', 'Guest 1'], ['b', 'Guest 2'], ['c', 'Ada'], ['me', 'Guest 3']];
		expect(nextGuestName(roster, 'me', false)).toBe('Guest 3');
		expect(nextGuestName([['a', 'Guest 2'], ['b', 'Guest 4'], ['me', '']], 'me', false)).toBe('Guest 3');
	});
});

describe('guestClash', () => {
	it('moves the later id when two people took one number', () => {
		const roster = [['aaa', 'Guest 2'], ['bbb', 'Guest 2']];
		expect(guestClash(roster, 'bbb', 'Guest 2')).toBe(true);
		expect(guestClash(roster, 'aaa', 'Guest 2')).toBe(false);
		expect(guestClash(roster, 'bbb', 'Ada')).toBe(false);
	});
});

describe('displayName', () => {
	it('is the name, else AI agent for an agent, else Guest — never Peer or a raw id', () => {
		expect(displayName(['x', 'Ada'])).toBe('Ada');
		expect(displayName(['x', '', '', null, null, null, { kind: 'agent' }])).toBe('AI agent');
		expect(displayName(['x', ''])).toBe('Guest');
		expect(displayName(['x', null])).toBe('Guest');
		expect(isGuestName('Guest 12')).toBe(true);
		expect(isGuestName('Guestimate')).toBe(false);
	});
});

describe('the join ask', () => {
	beforeEach(() => {
		safeStorage.removeItem('username');
		safeStorage.removeItem('usernameCustom');
		safeStorage.setItem('joinName:e2e', '1');
		joinNameAsk.set(false);
	});
	it('asks a person with no name of their own, and nobody else', () => {
		maybeAskJoinName({});
		expect(get(joinNameAsk)).toBe(true);
		joinNameAsk.set(false);
		maybeAskJoinName({ accountName: 'ada' });
		expect(get(joinNameAsk)).toBe(false);
		maybeAskJoinName({ agent: true });
		expect(get(joinNameAsk)).toBe(false);
	});
	it('Save remembers the name (the Edit profile keys), so the next join does not ask', () => {
		maybeAskJoinName({});
		expect(saveJoinName('  Mira  ')).toBe(true);
		expect(get(joinNameAsk)).toBe(false);
		expect(get(username)).toBe('Mira');
		expect(safeStorage.getItem('username')).toBe('Mira');
		expect(hasOwnName()).toBe(true);
		maybeAskJoinName({});
		expect(get(joinNameAsk)).toBe(false);
	});
	it('an empty answer closes the card and stores nothing', () => {
		maybeAskJoinName({});
		expect(saveJoinName('   ')).toBe(false);
		expect(get(joinNameAsk)).toBe(false);
		expect(hasOwnName()).toBe(false);
	});
});
