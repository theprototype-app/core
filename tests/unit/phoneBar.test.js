import { describe, it, expect } from 'vitest';
import { normalizeBar, toggleSlot, splitAroundPlay, DEFAULT_BAR, MAX_SLOTS } from '../../src/lib/ui/phoneBar.js';

// 38 R9 / NOTES-38 #7: the phone bar's four slots around Play. The one rule that keeps the
// editor reachable — More never leaves the bar — is asserted on every path that edits it.
describe('phoneBar', () => {
	it('defaults to Add, Objects, Explorer, More', () => {
		expect(DEFAULT_BAR).toEqual(['add', 'objects', 'explorer', 'more']);
		expect(normalizeBar(null)).toEqual(DEFAULT_BAR);
		expect(normalizeBar('nope')).toEqual(DEFAULT_BAR);
	});

	it('drops unknown keys and repeats, caps at four', () => {
		expect(normalizeBar(['add', 'bogus', 'add', 'chat', 'more'])).toEqual(['add', 'chat', 'more']);
		expect(normalizeBar(['add', 'objects', 'explorer', 'chat', 'flow', 'more']).length).toBe(MAX_SLOTS);
	});

	it('More always stays on the bar', () => {
		expect(normalizeBar(['add', 'chat'])).toEqual(['add', 'chat', 'more']);
		expect(normalizeBar(['add', 'chat', 'flow', 'objects'])).toEqual(['add', 'chat', 'flow', 'more']);
		expect(normalizeBar([])).toEqual(['more']);
		expect(toggleSlot(DEFAULT_BAR, 'more')).toEqual(DEFAULT_BAR);
	});

	it('a tap removes a slot, or adds one before More while there is room', () => {
		const three = toggleSlot(DEFAULT_BAR, 'explorer');
		expect(three).toEqual(['add', 'objects', 'more']);
		expect(toggleSlot(three, 'chat')).toEqual(['add', 'objects', 'chat', 'more']);
		// a full bar refuses a fifth
		expect(toggleSlot(DEFAULT_BAR, 'chat')).toEqual(DEFAULT_BAR);
		// an unknown key changes nothing
		expect(toggleSlot(DEFAULT_BAR, 'bogus')).toEqual(DEFAULT_BAR);
	});

	it('Play sits in the middle; the left half takes the odd one', () => {
		expect(splitAroundPlay(DEFAULT_BAR)).toEqual({ left: ['add', 'objects'], right: ['explorer', 'more'] });
		expect(splitAroundPlay(['add', 'chat', 'more'])).toEqual({ left: ['add', 'chat'], right: ['more'] });
		expect(splitAroundPlay(['more'])).toEqual({ left: ['more'], right: [] });
	});
});
