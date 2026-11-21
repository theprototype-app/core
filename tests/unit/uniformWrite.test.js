// 102b-papercuts (row 18): Set Shader Uniform drives colour and vector uniforms
import { describe, it, expect } from 'vitest';
import { writeUniformSlot, hexToLinear } from '../../src/lib/uniformWrite.js';

describe('writeUniformSlot', () => {
	it('a float slot takes the number, exactly as before', () => {
		const slot = { value: 0 };
		expect(writeUniformSlot(slot, { value: 0.5 })).toBe('number');
		expect(slot.value).toBe(0.5);
		expect(writeUniformSlot(slot, { value: 'x' })).toBe(null);
		expect(slot.value).toBe(0.5);
	});
	it('a vec3 slot takes a colour in LINEAR space, in place', () => {
		const arr = [0, 0, 0];
		const slot = { value: arr };
		expect(writeUniformSlot(slot, { value: 0, color: '#ff8000' })).toBe('color');
		expect(slot.value).toBe(arr); // same array three uploads from
		expect(arr[0]).toBeCloseTo(1);
		expect(arr[1]).toBeCloseTo(hexToLinear('#008000')[1]);
		expect(arr[1]).toBeLessThan(0.5); // linear, not 128/255
		expect(arr[2]).toBe(0);
	});
	it('a vector wins over a colour; a vec4 keeps its own w', () => {
		const slot = { value: [0, 0, 0, 0.25] };
		expect(writeUniformSlot(slot, { color: '#ffffff', vector: [1, 2, 3] })).toBe('vector');
		expect(slot.value).toEqual([1, 2, 3, 0.25]);
	});
	it('a vec2 takes the first two components', () => {
		const slot = { value: [0, 0] };
		writeUniformSlot(slot, { vector: [4, 5, 6] });
		expect(slot.value).toEqual([4, 5]);
	});
	it('a number alone fills every component of a vector slot (vec4 keeps alpha)', () => {
		const slot = { value: [0, 0, 0, 1] };
		expect(writeUniformSlot(slot, { value: 0.3 })).toBe('number');
		expect(slot.value).toEqual([0.3, 0.3, 0.3, 1]);
	});
	it('nothing readable writes nothing', () => {
		const slot = { value: [1, 1, 1] };
		expect(writeUniformSlot(slot, { value: NaN, color: 'red', vector: ['a'] })).toBe(null);
		expect(slot.value).toEqual([1, 1, 1]);
		expect(writeUniformSlot(null, { value: 1 })).toBe(null);
	});
	it('THREE-style objects are written by component', () => {
		const v = { x: 0, y: 0, z: 0, fromArray() {} };
		writeUniformSlot({ value: v }, { vector: { x: 1, y: 2, z: 3 } });
		expect([v.x, v.y, v.z]).toEqual([1, 2, 3]);
		const c = { r: 0, g: 0, b: 0, fromArray() {} };
		writeUniformSlot({ value: c }, { color: '#ffffff' });
		expect(c.g).toBeCloseTo(1);
	});
});
