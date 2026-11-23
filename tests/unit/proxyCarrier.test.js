// 102-int-2: decal and splat carriers draw nothing of their own, so Paint, Simplify, the print/AR
// exporters and decal placement skip or refuse them (cross-lane seams of the 102-int-2 union).
import { describe, it, expect } from 'vitest';
import { carrierKindOf, isProxyCarrier, carrierRefusal } from '../../src/lib/proxyCarrier.js';
import { simplifyRefusal } from '../../src/lib/meshSimplify.js';
import { targetRefusal } from '../../src/lib/decalCore.js';

const decal = { userData: { decal: { image: null } } };
const splat = { userData: { splat: { hash: 'ab' } } };
const text = { userData: { textPath: { text: 'hi' } } };
const plain = { userData: {} };

describe('proxy carriers', () => {
	it('names decal and splat carriers, nothing else', () => {
		expect(carrierKindOf(decal)).toBe('decal');
		expect(carrierKindOf(splat)).toBe('splat');
		expect(carrierKindOf(text)).toBe('');
		expect(carrierKindOf(plain)).toBe('');
		expect(carrierKindOf(null)).toBe('');
		expect(isProxyCarrier({ userData: { decal: true } })).toBe(false); // a record is an object
	});
	it('Paint refuses a carrier with a reason, and says nothing for a mesh', () => {
		expect(carrierRefusal(decal, 'paint')).toMatch(/Properties ▸ Decal/);
		expect(carrierRefusal(splat, 'paint')).toMatch(/not a mesh/);
		expect(carrierRefusal(plain, 'paint')).toBe('');
	});
	it('Simplify refuses decals and splats before anything else', () => {
		expect(simplifyRefusal({ mesh: true, triangles: 5000, carrier: 'decal' })).toMatch(/decal/);
		expect(simplifyRefusal({ mesh: true, triangles: 5000, carrier: 'splat' })).toMatch(/splat/i);
		expect(simplifyRefusal({ mesh: true, triangles: 5000, carrier: '' })).toBe('');
	});
	it('a decal does not go on a splat', () => {
		expect(targetRefusal({ splat: true })).toMatch(/Gaussian splat/);
	});
});
