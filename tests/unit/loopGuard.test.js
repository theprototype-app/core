import { describe, it, expect } from 'vitest';
import { instrument, LOOP_LIMIT, GUARD_VAR } from '../../src/lib/loopGuard.js';

// 27-D (audit C1). This is the guard that stops one peer's `while (true)` hanging every
// peer in the session, and it is a pure string transform — so it is tested by RUNNING
// its output, not by matching its text. A shape assertion would pass on code that throws
// a SyntaxError the moment a user's script reaches it.

/** Narrow the union ONCE here. `instrument` returns the transformed code OR a refusal,
 * and an `expect('error' in out)` does not narrow it for the type checker — so every
 * later `.code` read would be an error while passing perfectly at runtime.
 * @param {string} src @returns {{ code: string, loops: number }} */
const ok = (src) => {
	const out = instrument(src);
	if ('error' in out) throw new Error('refused: ' + out.error);
	return out;
};

/** @param {string} src */
const build = (src) => new Function(ok(src).code);

describe('it produces code that still runs', () => {
	it('leaves an ordinary loop result untouched', () => {
		const fn = build('let n=0; for (let i=0;i<1000;i++) { n+=i; } return n;');
		expect(fn()).toBe(499500);
	});

	it('handles an UNBRACED body by giving it braces', () => {
		const fn = build('let n=0; for (let i=0;i<10;i++) n+=i; return n;');
		expect(fn()).toBe(45);
	});

	it('guards nested loops without crossing their braces', () => {
		const fn = build('let n=0; for(let i=0;i<3;i++) for(let j=0;j<3;j++) n++; return n;');
		expect(fn()).toBe(9);
	});

	it('leaves code with no loops alone apart from the declaration', () => {
		const out = ok('return 1 + 1;');
		expect(out.loops).toBe(0);
		expect(new Function(out.code)()).toBe(2);
	});
});

describe('it stops a hang', () => {
	it('throws out of a while(true) instead of freezing the session', () => {
		expect(() => build('while (true) { }')()).toThrow(/Script loop limit/);
	});

	it('throws out of an unbraced runaway too', () => {
		expect(() => build('let n=0; while (true) n++;')()).toThrow(/Script loop limit/);
	});

	it('throws out of a do/while', () => {
		expect(() => build('do { } while (true)')()).toThrow(/Script loop limit/);
	});

	it('counts per RUN, so a fresh call starts from zero', () => {
		const fn = build('let n=0; for(let i=0;i<10;i++){n++;} return n;');
		expect(fn()).toBe(10);
		expect(fn()).toBe(10); // not 20 — the declaration is inside the function body
	});
});

describe('it knows code from text', () => {
	it('does not instrument a loop keyword inside a string', () => {
		const out = ok('return "while (true) {";');
		expect(out.loops).toBe(0);
		expect(new Function(out.code)()).toBe('while (true) {');
	});

	it('does not instrument one inside a comment', () => {
		const out = ok('// while (true) { }\n/* for (;;) */\nreturn 7;');
		expect(out.loops).toBe(0);
		expect(new Function(out.code)()).toBe(7);
	});

	it('does not instrument one inside a template literal', () => {
		const out = ok('return `for (;;) ${1 + 1}`;');
		expect(out.loops).toBe(0);
		expect(new Function(out.code)()).toBe('for (;;) 2');
	});

	it('reads a / as division, not as the start of a regex', () => {
		const out = ok('const a = 10; const b = 2; return a / b / 1;');
		expect(new Function(out.code)()).toBe(5);
	});

	it('reads a real regex as a regex, loop keywords and all', () => {
		const out = ok('return /while (true)/.source;');
		expect(out.loops).toBe(0);
		expect(new Function(out.code)()).toBe('while (true)');
	});

	it('does not mistake an identifier ENDING in a keyword', () => {
		const out = ok('const meanwhile = 1; const format = (x) => x; return meanwhile;');
		expect(out.loops).toBe(0);
		expect(new Function(out.code)()).toBe(1);
	});
});

describe('it refuses what it cannot read', () => {
	it('refuses an unterminated string rather than guessing', () => {
		expect('error' in instrument('const s = "oops; while(true){}')).toBe(true);
	});

	it('refuses an unterminated block comment', () => {
		expect('error' in instrument('/* while (true) {}')).toBe(true);
	});

	it('refuses an unbalanced loop header', () => {
		expect('error' in instrument('while (true {}')).toBe(true);
	});
});

describe('the constants the badge and the injected code share', () => {
	it('keeps a limit high enough for real work and low enough to catch a hang', () => {
		expect(LOOP_LIMIT).toBeGreaterThanOrEqual(100000);
		expect(GUARD_VAR.startsWith('__')).toBe(true);
	});
});
