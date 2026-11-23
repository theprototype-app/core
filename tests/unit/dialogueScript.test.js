// 92-dialogue (GC6): the Dialogue script — what a line, a choice, a section, a set and a jump read as.
import { describe, test, expect } from 'vitest';
import { parseScript, toScript, toLines, lineCount, labelKey, SCRIPT_MAX } from '../../src/lib/dialogue/script.js';

const SAMPLE = `@portrait Old Man = old-man.png
// the greeting
Old Man: Welcome, traveller!
Old Man: Will you find my cat?
> Yes, I will. [set helping = 1] -> yes
> Not today. -> no
# yes
Old Man: Thank you! It went north.
[set gold += 5]
-> end
# no
The old man sighs.`;

describe('parseScript', () => {
	test('lines, speakers, choices, sections, sets and jumps', () => {
		const s = parseScript(SAMPLE);
		expect(s.errors).toEqual([]);
		expect(s.order).toEqual(['', 'yes', 'no']);
		expect(s.portraits).toEqual({ 'Old Man': 'old-man.png' });
		const top = s.sections[''];
		expect(top[0]).toEqual({ kind: 'line', speaker: 'Old Man', text: 'Welcome, traveller!', choices: [] });
		expect(top[1].kind).toBe('line');
		expect(top[1].choices).toEqual([
			{ text: 'Yes, I will.', set: [{ name: 'helping', op: 'set', value: 1 }], goto: 'yes' },
			{ text: 'Not today.', set: [], goto: 'no' }
		]);
		expect(s.sections.yes[1]).toEqual({ kind: 'set', set: [{ name: 'gold', op: 'add', value: 5 }] });
		expect(s.sections.yes[2]).toEqual({ kind: 'goto', to: 'end' });
		expect(s.sections.no[0]).toEqual({ kind: 'line', speaker: '', text: 'The old man sighs.', choices: [] });
		expect(lineCount(s)).toBe(4);
	});

	test('set forms: = number, += / -=, toggle, quoted and bare text', () => {
		const s = parseScript('[set a = 3] [set b += 2] [set c -= 1] [toggle d] [set e = "hi there"] [set f = happy]');
		expect(s.errors).toEqual([]);
		expect(s.sections[''][0]).toEqual({
			kind: 'set',
			set: [
				{ name: 'a', op: 'set', value: 3 },
				{ name: 'b', op: 'add', value: 2 },
				{ name: 'c', op: 'subtract', value: 1 },
				{ name: 'd', op: 'toggle', value: 0 },
				{ name: 'e', op: 'text', value: 'hi there' },
				{ name: 'f', op: 'text', value: 'happy' }
			]
		});
	});

	test('what it cannot read is an error, never a throw', () => {
		const s = parseScript('> orphan choice\nHi -> nowhere\n# end\n[set = 3]\n@portrait broken');
		expect(s.errors.length).toBeGreaterThanOrEqual(4);
		expect(s.errors.join(' ')).toMatch(/no line above/);
		expect(s.errors.join(' ')).toMatch(/no section "# nowhere"/);
		expect(() => parseScript(/** @type {any} */ (null))).not.toThrow();
		expect(parseScript('x'.repeat(SCRIPT_MAX * 2)).sections[''][0].text.length).toBeLessThanOrEqual(300);
	});

	test('labels match however they are typed', () => {
		expect(labelKey('  The Cat  Is Found ')).toBe('the-cat-is-found');
		const s = parseScript('Hi\n> go -> Cat Found\n# cat found\nYay');
		expect(s.errors).toEqual([]);
		expect(s.sections[''][0].choices[0].goto).toBe('cat-found');
	});
});

describe('toScript / toLines', () => {
	test('structured lines round-trip through the script', () => {
		const lines = [
			{ speaker: 'Old Man', text: 'Welcome, traveller!', portrait: 'old-man.png' },
			{ speaker: 'Old Man', text: 'Will you help?', choices: [{ text: 'Yes', set: { name: 'helping', value: 1 }, goto: 'yes' }, { text: 'No', goto: 'end' }] },
			{ label: 'yes', speaker: 'Old Man', text: 'Thanks!', set: { name: 'gold', op: 'add', value: 5 } }
		];
		const { script, errors } = toScript(lines);
		expect(errors).toEqual([]);
		expect(script).toContain('@portrait Old Man = old-man.png');
		expect(script).toContain('> Yes [set helping = 1] -> yes');
		const back = toLines(parseScript(script));
		expect(back[0]).toEqual({ speaker: 'Old Man', text: 'Welcome, traveller!' });
		expect(back[1].choices).toEqual([{ text: 'Yes', set: [{ name: 'helping', op: 'set', value: 1 }], goto: 'yes' }, { text: 'No', goto: 'end' }]);
		expect(back[2]).toEqual({ label: 'yes', speaker: 'Old Man', text: 'Thanks!' });
	});

	test('a text cannot break the syntax', () => {
		const { script } = toScript([{ speaker: 'A:B', text: '# not a label [set x = 1] -> gone' }]);
		const s = parseScript(script);
		expect(s.order).toEqual(['']);
		expect(s.sections[''].length).toBe(1);
		expect(s.sections[''][0].kind).toBe('line');
	});
});
