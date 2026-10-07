// @ts-nocheck — assertions on plain objects
// 37 R15: chat v2's text rules — shortcodes expand on send, @mentions resolve on render.
import { describe, it, expect } from 'vitest';
import { expandShortcodes, shortcodeSuggestions, tokenizeChat, mentionsIn, mentionSuggestions, mergeChat, SHORTCODES } from '../../src/lib/chatTokens.js';

const people = [
	{ id: 'p1', name: 'Ada' },
	{ id: 'p2', name: 'Ada Lovelace' },
	{ id: 'p3' },
	{ id: 'p4', name: 'Bob' }
];

describe('shortcodes', () => {
	it('expands known codes and leaves the rest', () => {
		expect(expandShortcodes('nice :tada: :+1:')).toBe('nice 🎉 👍');
		expect(expandShortcodes('meet at 12:30:45 :nope:')).toBe('meet at 12:30:45 :nope:');
		expect(expandShortcodes(':FIRE:')).toBe('🔥');
	});
	it('suggests by prefix, capped', () => {
		expect(shortcodeSuggestions('thu').map((s) => s.code)).toEqual(['thumbsup', 'thumbsdown']);
		expect(shortcodeSuggestions('')).toEqual([]);
		expect(shortcodeSuggestions('s', 3)).toHaveLength(3);
		expect(Object.values(SHORTCODES).every((e) => typeof e === 'string' && e.length)).toBe(true);
	});
});

describe('mentions', () => {
	it('longest name first, and only at a word end', () => {
		const t = tokenizeChat('hey @Ada Lovelace and @Ada, not @Adam', people);
		expect(t.filter((x) => x.kind === 'mention').map((x) => [x.text, x.id])).toEqual([
			['@Ada Lovelace', 'p2'],
			['@Ada', 'p1']
		]);
		expect(t.map((x) => x.text).join('')).toBe('hey @Ada Lovelace and @Ada, not @Adam');
	});
	it('a peer id works, case-insensitively; an email is not a mention', () => {
		expect(mentionsIn('@P3 look', people)).toEqual(['p3']);
		expect(mentionsIn('mail bob@Bob.com', people)).toEqual([]);
		expect(mentionsIn('@bob @Bob', people)).toEqual(['p4']);
	});
	it('a string can never become markup: tokens are text', () => {
		const t = tokenizeChat('<img src=x onerror=alert(1)> @Bob', people);
		expect(t[0]).toEqual({ kind: 'text', text: '<img src=x onerror=alert(1)> ' });
	});
	it('suggests people (not me) by name or id prefix', () => {
		expect(mentionSuggestions('ad', people, 'p1').map((p) => p.id)).toEqual(['p2']);
		expect(mentionSuggestions('p3', people).map((p) => p.label)).toEqual(['p3']);
	});
});

describe('mergeChat', () => {
	it('adds by id, keeps order by sender time, ignores duplicates and junk', () => {
		const mine = [{ id: 'a', text: 'one', at: 10 }, { id: 'c', text: 'three', at: 30 }];
		const merged = mergeChat(mine, [{ id: 'b', text: 'two', at: 20 }, { id: 'a', text: 'one', at: 10 }, { id: 'x', at: 5 }, null]);
		expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(mergeChat(merged, [{ id: 'b', text: 'two', at: 20 }])).toBe(merged);
	});
	it('caps to the newest', () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, text: 't', at: i }));
		expect(mergeChat([], many, 4).map((m) => m.id)).toEqual(['m6', 'm7', 'm8', 'm9']);
	});
});
