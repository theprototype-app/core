import { describe, it, expect } from 'vitest';
import { simulateVerdict } from '../../src/lib/simAuthority.js';

// 29-F. The whole dual-simulator rule is a pure function of four facts, so its truth
// table belongs here rather than behind two browsers: what an e2e run can show is that
// the rule REACHES a real match (game-football section 7); what it cannot show in a
// reasonable time is that the rule is SYMMETRIC — that the two sides of every race read
// the same message pair and reach opposite verdicts, so exactly one world survives.
// That is what these cover, plus the two ways the rule must stay out of the way: an
// older sender with no `peerId`, and a session with no race in it at all.

/** @param {Record<string, any>=} over */
const start = (over) => ({ running: true, mine: 'bbb', theirs: 'aaa', simulating: false, remote: null, ...over });

describe('simulateVerdict — the normal session, with no race in it', () => {
	it('adopts a peer that starts while we are idle', () => {
		expect(simulateVerdict(start())).toBe('adopt');
	});
	it('adopts a pause/resume from the peer we are already watching', () => {
		expect(simulateVerdict(start({ remote: 'aaa' }))).toBe('adopt');
	});
	it('clears when the peer we are watching stops', () => {
		expect(simulateVerdict(start({ running: false, remote: 'aaa' }))).toBe('clear');
	});
	it('takes a stop with no id at all — the pre-29-F behaviour, verbatim', () => {
		expect(simulateVerdict(start({ running: false, theirs: null, remote: 'aaa' }))).toBe('clear');
	});
});

describe('simulateVerdict — the race is SYMMETRIC', () => {
	// the two sides of one race, built from ONE pair of ids so the test cannot
	// accidentally read two different worlds
	/** @param {string} lo @param {string} hi */
	const race = (lo, hi) => [
		// the LOW-id peer hears the high one start
		simulateVerdict({ running: true, mine: lo, theirs: hi, simulating: true, remote: null }),
		// ...and the HIGH-id peer hears the low one
		simulateVerdict({ running: true, mine: hi, theirs: lo, simulating: true, remote: null })
	];

	it('elects exactly one winner: the lower id keeps, the higher yields', () => {
		expect(race('aaa', 'bbb')).toEqual(['keep', 'yield']);
	});
	it('holds whichever way round the ids happen to fall', () => {
		expect(race('0f3c1a', 'f001de')).toEqual(['keep', 'yield']);
		expect(race('A', 'a')).toEqual(['keep', 'yield']); // '<' is codepoint order, not locale
	});
	it('can never elect two winners or none, over a spread of real-shaped ids', () => {
		const ids = ['0a1b2c', '4e86d', 'f0f0f0', 'zz', 'ZZ', 'abc123', '9', '-'];
		for (const a of ids)
			for (const b of ids) {
				if (a === b) continue;
				const verdicts = [
					simulateVerdict({ running: true, mine: a, theirs: b, simulating: true, remote: null }),
					simulateVerdict({ running: true, mine: b, theirs: a, simulating: true, remote: null })
				];
				expect(verdicts.filter((v) => v === 'keep')).toHaveLength(1);
				expect(verdicts.filter((v) => v === 'yield')).toHaveLength(1);
			}
	});
});

describe('simulateVerdict — a spectator agrees with the racers', () => {
	it('keeps the LOWER id when told about two simulators', () => {
		// told about 'aaa' first, then 'bbb': the second claim is the loser's
		expect(simulateVerdict({ running: true, mine: 'zzz', theirs: 'bbb', simulating: false, remote: 'aaa' })).toBe('ignore');
	});
	it('...and in the other arrival order adopts the lower one over the higher', () => {
		expect(simulateVerdict({ running: true, mine: 'zzz', theirs: 'aaa', simulating: false, remote: 'bbb' })).toBe('adopt');
	});
	it('does not blank its view of the winner when the LOSER stops', () => {
		// the yielding peer broadcasts running:false on its way out; a spectator
		// watching the winner must not read that as "nobody is simulating" — that store
		// is what arms the knock probes and play-mode grab (24-A A2)
		expect(simulateVerdict({ running: false, mine: 'zzz', theirs: 'bbb', simulating: false, remote: 'aaa' })).toBe('ignore');
	});
});

describe('simulateVerdict — additive: absent = old behaviour', () => {
	it('adopts a start from an older sender that carries no peerId, even mid-run', () => {
		expect(simulateVerdict(start({ theirs: null, simulating: true }))).toBe('adopt');
		expect(simulateVerdict(start({ theirs: null, simulating: false }))).toBe('adopt');
	});
	it('adopts rather than guessing when we have no id of our own yet', () => {
		expect(simulateVerdict(start({ mine: null, simulating: true }))).toBe('adopt');
	});
	it('ignores our own message coming back at us', () => {
		expect(simulateVerdict(start({ mine: 'aaa', theirs: 'aaa', simulating: true }))).toBe('ignore');
		expect(simulateVerdict(start({ mine: 'aaa', theirs: 'aaa', simulating: false }))).toBe('ignore');
	});
	it('treats an empty-string id as no id', () => {
		expect(simulateVerdict(start({ theirs: '', simulating: true }))).toBe('adopt');
	});
});
