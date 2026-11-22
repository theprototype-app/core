import { describe, it, expect, beforeEach } from 'vitest';
import { noteCheck, lastCheck, clearChecks, whyCardLine, whySentence, agoText, WHY_REASONS, FRESH_MS } from '../../src/lib/triggerWhy.js';

describe('78 F26 triggerWhy', () => {
	beforeEach(() => clearChecks());

	it('a fresh block wins over a standing reason', () => {
		noteCheck('n1', { who: 'Box 2', reason: 'not-player', at: 1000 });
		expect(whyCardLine(lastCheck('n1'), 'edit', 1500)).toBe('blocked: not the player');
	});

	it('a fresh fire says when', () => {
		noteCheck('n1', { who: 'the player', fired: true, at: 1000 });
		expect(whyCardLine(lastCheck('n1'), null, 2200)).toBe('fired 1.2 s ago');
		expect(lastCheck('n1')?.reason).toBe(null);
	});

	it('an old check yields to the standing reason', () => {
		noteCheck('n1', { who: 'x', fired: true, at: 0 });
		expect(whyCardLine(lastCheck('n1'), 'no-sim', FRESH_MS + 1)).toBe("won't fire: " + WHY_REASONS['no-sim']);
		expect(whyCardLine(lastCheck('n1'), null, FRESH_MS + 1)).toMatch(/^fired \d+ s ago$/);
	});

	it('nothing known = null (the card keeps its plain line)', () => {
		expect(whyCardLine(null, null)).toBe(null);
	});

	it('a kit refusal carries its own words', () => {
		noteCheck('n1', { reason: 'refused', detail: 'already taken', at: 0 });
		expect(whyCardLine(lastCheck('n1'), null, 10)).toBe('blocked: refused: already taken');
	});

	it('every card line fits the 40-character card', () => {
		for (const key of Object.keys(WHY_REASONS)) {
			if (key === 'refused') continue;
			// @ts-ignore
			expect(("won't fire: " + WHY_REASONS[key]).length, key).toBeLessThanOrEqual(40);
		}
	});

	it('the debugger sentence names time, who and the block', () => {
		noteCheck('n1', { who: 'Crate', reason: 'filter', at: 0 });
		const s = whySentence(lastCheck('n1'), 'authority', 400);
		expect(s.last).toBe('Last check 0.4 s ago · Crate: blocked, the filter did not match.');
		expect(s.standing).toBe('Right now it cannot fire: checked on the physics peer.');
		expect(whySentence(null, null).last).toMatch(/No check yet/);
	});

	it('agoText rounds by size', () => {
		expect(agoText(400)).toBe('0.4 s ago');
		expect(agoText(30000)).toBe('30 s ago');
		expect(agoText(600000)).toBe('10 min ago');
	});
});
