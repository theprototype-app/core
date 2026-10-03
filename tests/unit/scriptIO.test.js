import { describe, it, expect } from 'vitest';
import {
	scriptInputs,
	scriptOutputs,
	isScriptV2,
	isScriptValue,
	scriptSocketType,
	coerceInput,
	coerceOutput,
	harvestOutputs,
	SCRIPT_HELPERS
} from '../../src/lib/scriptIO.js';

// 34 D3: Script node v2's sockets. The line that matters most is the compatibility one —
// a node with no declaration is v1 and must read as v1 everywhere.

describe('declarations', () => {
	it('a node with neither list is v1', () => {
		const v1 = { code: 'object.position.y = 1' };
		expect(scriptInputs(v1)).toBeNull();
		expect(scriptOutputs(v1)).toEqual([]);
		expect(isScriptV2(v1)).toBe(false);
		expect(isScriptValue(v1)).toBe(false);
	});
	it('an empty declaration still opts in (inputs: [] is a v2 node with no inputs)', () => {
		expect(isScriptV2({ inputs: [] })).toBe(true);
		expect(scriptInputs({ inputs: [] })).toEqual([]);
	});
	it('drops invalid, duplicate and reserved names; unknown types read as number', () => {
		const ins = scriptInputs({
			inputs: [
				{ name: 'hand', type: 'vector3' },
				{ name: 'hand', type: 'number' },
				{ name: '2bad', type: 'number' },
				{ name: 'time', type: 'number' },
				{ name: 'code', type: 'number' },
				{ name: 'reach', type: 'weird', value: 1.2 }
			]
		});
		expect(ins).toEqual([
			{ name: 'hand', type: 'vector3' },
			{ name: 'reach', type: 'number', value: 1.2 }
		]);
	});
	it('outputs cannot be events (a pure function cannot mint a stamp)', () => {
		expect(scriptOutputs({ outputs: [{ name: 'fire', type: 'event' }] })).toEqual([{ name: 'fire', type: 'number' }]);
	});
	it('only outputs make it a value node', () => {
		expect(isScriptValue({ inputs: [{ name: 'a', type: 'number' }] })).toBe(false);
		expect(isScriptValue({ outputs: [{ name: 'o', type: 'number' }] })).toBe(true);
	});
	it('answers a socket type only for the script node and declared handles', () => {
		const data = { inputs: [{ name: 'piece', type: 'object' }], outputs: [{ name: 'allow', type: 'boolean' }] };
		expect(scriptSocketType('script', data, 'piece', 'input')).toBe('object');
		expect(scriptSocketType('script', data, 'allow', 'output')).toBe('boolean');
		expect(scriptSocketType('script', data, 'nope', 'input')).toBeNull();
		expect(scriptSocketType('math', data, 'piece', 'input')).toBeNull();
	});
});

describe('coercion', () => {
	it('gives the script one shape per declared type', () => {
		expect(coerceInput('number', true)).toBe(1);
		expect(coerceInput('number', [4, 5, 6])).toBe(4);
		expect(coerceInput('number', 'nope')).toBe(0);
		expect(coerceInput('boolean', 0.0)).toBe(false);
		expect(coerceInput('boolean', 2)).toBe(true);
		expect(coerceInput('event', 1)).toBe(true);
		expect(coerceInput('vector3', 2)).toEqual([2, 2, 2]);
		expect(coerceInput('vector3', { x: 1, y: 2, z: 3 })).toEqual([1, 2, 3]);
		expect(coerceInput('color', 5)).toBe('#ffffff');
		expect(coerceInput('vector3', undefined)).toEqual([0, 0, 0]);
	});
	it('an object output carries a uuid', () => {
		expect(coerceOutput('object', 'abc')).toBe('abc');
		expect(coerceOutput('object', { uuid: 'u1', position: [0, 0, 0] })).toBe('u1');
		expect(coerceOutput('object', 3)).toBeUndefined();
		expect(coerceOutput('number', undefined)).toBeUndefined();
	});
});

describe('harvest', () => {
	const outs = [
		{ name: 'allow', type: 'boolean' },
		{ name: 'gap', type: 'number' }
	];
	it('builds the runtime handle map, first output as the default', () => {
		const { value, problems } = harvestOutputs({ allow: 1, gap: '2.5' }, outs);
		expect(problems).toEqual([]);
		expect(value).toEqual({ __handles: { allow: true, gap: 2.5 }, __default: true });
	});
	it('names what is missing instead of throwing', () => {
		expect(harvestOutputs({ allow: true }, outs).problems).toEqual(['missing output `gap`']);
		expect(harvestOutputs(undefined, outs).problems[0]).toMatch(/^return an object like \{ allow: …, gap: … \}/);
		expect(harvestOutputs(undefined, outs).value.__handles).toEqual({ allow: undefined, gap: undefined });
	});
});

describe('helpers', () => {
	it('dist reads arrays, {x,y,z} and object views alike', () => {
		expect(SCRIPT_HELPERS.dist([0, 0, 0], [3, 4, 0])).toBe(5);
		expect(SCRIPT_HELPERS.dist({ x: 0, y: 0, z: 0 }, { position: [0, 0, 2] })).toBe(2);
		expect(SCRIPT_HELPERS.lerp(0, 10, 0.25)).toBe(2.5);
		expect(SCRIPT_HELPERS.clamp(5, 0, 1)).toBe(1);
	});
});
