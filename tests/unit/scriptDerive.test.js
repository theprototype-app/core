// 36 (G1 phase 4): a Script node's sockets follow its code (src/lib/scriptDerive.js).
import { describe, test, expect } from 'vitest';
import { socketsUsedBy, followCode } from '../../src/lib/scriptDerive.js';

describe('socketsUsedBy', () => {
	test('inputs.x reads and returned keys, first-use order, no duplicates', () => {
		const code = 'const p = inputs.power * 2;\nif (inputs.on) return { shot: p, allow: true };\nreturn { shot: 0, allow: false, n: inputs.power };';
		expect(socketsUsedBy(code)).toEqual({ inputs: ['power', 'on'], outputs: ['shot', 'allow', 'n'] });
	});
	test('strings and comments add nothing', () => {
		const code = '// inputs.ghost\nconst s = "inputs.fake"; /* return { nope: 1 } */\nreturn { real: inputs.a };';
		expect(socketsUsedBy(code)).toEqual({ inputs: ['a'], outputs: ['real'] });
	});
	test("bracket access with a literal, shorthand keys, nested literals, spreads and methods", () => {
		const code = "const v = inputs['speed'];\nconst allow = 1;\nreturn { allow, pos: { x: 1, y: [2, 3] }, ...rest, f() { return 1; } };";
		expect(socketsUsedBy(code)).toEqual({ inputs: ['speed'], outputs: ['allow', 'pos', 'f'] });
	});
	test('a property named inputs on another object is not an input', () => {
		expect(socketsUsedBy('return { a: data.inputs.x, b: myinputs.y };').inputs).toEqual([]);
	});
});

describe('followCode', () => {
	test('adds what the code uses, keeps what it no longer mentions (wires may hang on it)', () => {
		const r = followCode('return { out: inputs.a + inputs.b };', [{ name: 'a', type: 'vector3' }, { name: 'old', type: 'number' }], [{ name: 'out', type: 'boolean' }]);
		expect(r.changed).toBe(true);
		expect(r.inputs).toEqual([{ name: 'a', type: 'vector3' }, { name: 'old', type: 'number' }, { name: 'b', type: 'number' }]);
		expect(r.outputs).toEqual([{ name: 'out', type: 'boolean' }]);
	});
	test('nothing new = unchanged; reserved names are never added', () => {
		expect(followCode('return { out: inputs.a };', [{ name: 'a', type: 'number' }], [{ name: 'out', type: 'number' }]).changed).toBe(false);
		expect(followCode('return { time: 1 };', [], [], new Set(['time'])).changed).toBe(false);
	});
});
