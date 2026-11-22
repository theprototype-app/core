import { describe, expect, it } from 'vitest';
import { elapsedNow } from '../../src/lib/scriptElapsed.js';
import { scriptNodeWarnings } from '../../src/lib/ai/scriptNotes.js';
import { NODE_DOCS } from '../../src/lib/nodeDocs.js';

describe('a script reads elapsed', () => {
	it('starts near 0 on a Play press and again after leaving it', () => {
		const anchor = {};
		expect(elapsedNow({ round: null, playing: false, now: 500 }, anchor)).toBe(0);
		expect(elapsedNow({ round: null, playing: false, now: 510 }, anchor)).toBe(10);
		expect(elapsedNow({ round: null, playing: true, now: 520 }, anchor)).toBe(0);
		expect(elapsedNow({ round: null, playing: true, now: 522.5 }, anchor)).toBe(2.5);
		expect(elapsedNow({ round: null, playing: false, now: 530 }, anchor)).toBe(0);
	});
	it('in a game round it is the round clock, the same for every peer whenever they pressed Play', () => {
		const late = {};
		elapsedNow({ round: null, playing: false, now: 1 }, late);
		expect(elapsedNow({ round: 42, playing: true, now: 900 }, late)).toBe(42);
		expect(elapsedNow({ round: 42, playing: false, now: 901 }, {})).toBe(42);
		expect(elapsedNow({ round: -1, playing: true, now: 900 }, {})).toBe(0);
	});
	it('a += that reads elapsed is not called stuck, and the warning teaches elapsed', () => {
		expect(scriptNodeWarnings({ code: 'object.position.y += Math.sin(elapsed);' }, { unwired: false })).toEqual([]);
		expect(scriptNodeWarnings({ code: 'object.rotation.y += 0.02;' }, { unwired: false }).join(' ')).toMatch(/base\.rot\[1\] \+ elapsed \* speed/);
	});
	it('the docs say both clocks, and which way particle gravity goes', () => {
		expect(NODE_DOCS.script).toMatch(/elapsed is seconds since Play|`elapsed` is seconds since Play/);
		expect(NODE_DOCS.script).toMatch(/shared clock, seconds of the day/);
		expect(NODE_DOCS.particle).toMatch(/world Y/);
		expect(NODE_DOCS.particle).toMatch(/negative falls/);
		expect(NODE_DOCS.particle).toMatch(/positive rises/);
	});
});
