// 54i x: a phone sheet a window ASKS to open taller (the AI welcome: 'full') opens there until the person
// moves it; a height the person chose always wins, and a bad ask is ignored.
import { describe, it, expect } from 'vitest';
import { detentOf } from '../../src/lib/ui/phoneShell.js';

describe('detentOf with first detents', () => {
	it('a window never moved reads half', () => {
		expect(detentOf({}, 'ai')).toBe('half');
		expect(detentOf({}, null, { ai: 'full' })).toBe('half');
	});
	it("the window's ask applies while nothing is remembered", () => {
		expect(detentOf({}, 'ai', { ai: 'full' })).toBe('full');
		expect(detentOf({}, 'chat', { ai: 'full' })).toBe('half');
	});
	it("the person's height wins over the ask", () => {
		expect(detentOf({ ai: 'peek' }, 'ai', { ai: 'full' })).toBe('peek');
	});
	it('an unknown ask is ignored', () => {
		expect(detentOf({}, 'ai', { ai: 'huge' })).toBe('half');
	});
});
