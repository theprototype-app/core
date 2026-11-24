// 92-dialogue (GC6): the Dialogue runtime against a fake seam — who it opens for, how it walks, what a
// choice writes, and that it fires its end once.
import { describe, test, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { tickDialogues, dialogueAdvance, dialogueChoose, closeDialogue, dialogueState } from '../../src/lib/dialogue/runtime.js';
import { dialogueView } from '../../src/lib/dialogue/view.js';

const SCRIPT = `Old Man: Welcome, {name}!
Old Man: Will you help?
> Yes [set helping = 1] -> yes
> No -> no
# yes
Old Man: Thanks!
# no
Old Man: Pity.`;

/** a seam whose trigger the test drives */
function makeSeam() {
	const s = {
		trigger: /** @type {number | null} */ (null),
		liveOn: false,
		mineSet: new Set(),
		staleBefore: 0,
		isActive: true,
		fired: /** @type {string[]} */ ([]),
		vars: /** @type {any[]} */ ([]),
		seam: /** @type {any} */ (null)
	};
	s.seam = {
		stamp: () => s.trigger,
		stopStamp: () => null,
		live: () => s.liveOn,
		seen: () => {},
		stale: (/** @type {any} */ _n, /** @type {number} */ t) => t < s.staleBefore,
		mine: (/** @type {any} */ _n, /** @type {number} */ t) => s.mineSet.has(t),
		fire: (/** @type {any} */ n) => s.fired.push(n.id),
		setVar: (/** @type {any[]} */ ...a) => s.vars.push(a),
		getVar: (/** @type {string} */ name) => (name === 'name' ? 'Ada' : undefined),
		active: () => s.isActive,
		anchor: () => [0, 2, -4]
	};
	return s;
}

const node = (data = {}) => ({ id: 'd1', type: 'dialogue', data: { script: SCRIPT, ...data } });

beforeEach(() => closeDialogue());

describe('dialogue runtime', () => {
	test('a live trigger opens it on the rising edge; it walks, a choice sets and jumps, the end fires once', () => {
		const s = makeSeam();
		const n = node();
		tickDialogues([n], s.seam, 1, null);
		expect(get(dialogueView)).toBe(null);
		s.liveOn = true;
		tickDialogues([n], s.seam, 2, null);
		let v = /** @type {any} */ (get(dialogueView));
		expect(v.speaker).toBe('Old Man');
		expect(v.text).toBe('Welcome, Ada!');
		expect(v.anchor).toEqual([0, 2, -4]);
		expect(v.last).toBe(false);
		// still near: no reopen while it is open or after it ends
		tickDialogues([n], s.seam, 3, null);
		dialogueAdvance();
		v = get(dialogueView);
		expect(v.choices).toEqual(['Yes', 'No']);
		dialogueAdvance(); // a line with choices does not advance
		expect(dialogueState()?.at).toBe(1);
		dialogueChoose(0);
		expect(s.vars).toEqual([['helping', 'set', 1, 'shared', expect.stringMatching(/^dlg:d1:/)]]);
		v = get(dialogueView);
		expect(v.text).toBe('Thanks!');
		expect(v.last).toBe(true); // the section ends at "# no"
		dialogueAdvance();
		expect(get(dialogueView)).toBe(null);
		expect(s.fired).toEqual(['d1']);
		tickDialogues([n], s.seam, 4, null);
		expect(get(dialogueView)).toBe(null);
		// walk away and back: it opens again
		s.liveOn = false;
		tickDialogues([n], s.seam, 5, null);
		s.liveOn = true;
		tickDialogues([n], s.seam, 6, null);
		expect(get(dialogueView)?.text).toBe('Welcome, Ada!');
	});

	test('a logged trigger opens only for the peer that made it (who: me), for all with who: everyone', () => {
		const s = makeSeam();
		tickDialogues([node()], s.seam, 1, null);
		s.trigger = 10; // somebody else's click
		tickDialogues([node()], s.seam, 2, null);
		expect(get(dialogueView)).toBe(null);
		s.trigger = 11;
		s.mineSet.add(11); // my click
		tickDialogues([node()], s.seam, 3, null);
		expect(get(dialogueView)?.text).toBe('Welcome, Ada!');
		closeDialogue();
		const e = makeSeam();
		tickDialogues([node({ who: 'everyone' })], e.seam, 1, null);
		e.trigger = 20;
		tickDialogues([node({ who: 'everyone' })], e.seam, 2, null);
		expect(get(dialogueView)?.text).toBe('Welcome, Ada!');
	});

	test('history opens nothing; leaving Play closes it without firing; player scope writes my row', () => {
		const s = makeSeam();
		s.staleBefore = 100;
		s.trigger = 50;
		s.mineSet.add(50);
		tickDialogues([node()], s.seam, 1, null);
		expect(get(dialogueView)).toBe(null);
		s.trigger = 150;
		s.mineSet.add(150);
		tickDialogues([node({ scope: 'player' })], s.seam, 2, null);
		expect(get(dialogueView)).not.toBe(null);
		dialogueAdvance();
		dialogueChoose(1);
		expect(get(dialogueView)?.text).toBe('Pity.');
		s.isActive = false;
		tickDialogues([node()], s.seam, 3, null);
		expect(get(dialogueView)).toBe(null);
		expect(s.fired).toEqual([]);
		// a player-scope set
		s.isActive = true;
		s.trigger = 160;
		s.mineSet.add(160);
		tickDialogues([node({ scope: 'player' })], s.seam, 4, null);
		dialogueAdvance();
		dialogueChoose(0);
		expect(s.vars.at(-1).slice(0, 4)).toEqual(['helping', 'set', 1, 'player']);
	});

	test('a deleted node takes its talk with it; an empty script just ends', () => {
		const s = makeSeam();
		s.liveOn = true;
		tickDialogues([node()], s.seam, 1, null);
		expect(get(dialogueView)).not.toBe(null);
		tickDialogues([], s.seam, 2, null);
		expect(get(dialogueView)).toBe(null);
		const e = makeSeam();
		e.liveOn = true;
		tickDialogues([node({ script: '// nothing' })], e.seam, 1, null);
		expect(get(dialogueView)).toBe(null);
		expect(e.fired).toEqual(['d1']);
	});
});
