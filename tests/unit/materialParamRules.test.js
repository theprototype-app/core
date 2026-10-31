import { describe, it, expect } from 'vitest';
import { checkMaterialParam, toHexColor, isMaterialParamKey } from '../../src/lib/materialParamRules.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';

// 55 (41's research, round 6): validate material parameters — a texture slot handed a string broke
// rendering on every peer; unknown keys were written silently.
const standard = { type: 'MeshStandardMaterial', roughness: 1, metalness: 0, opacity: 1, transparent: false, wireframe: false, side: 0, map: null, emissive: {} };

describe('checkMaterialParam', () => {
	it('coerces and clamps numbers, booleans, colours and side', () => {
		expect(checkMaterialParam(standard, 'roughness', '0.25')).toEqual({ ok: true, value: 0.25 });
		expect(checkMaterialParam(standard, 'metalness', 7)).toEqual({ ok: true, value: 1 });
		expect(checkMaterialParam(standard, 'wireframe', 'true')).toEqual({ ok: true, value: true });
		expect(checkMaterialParam(standard, 'emissive', 'F80')).toEqual({ ok: true, value: '#ff8800' });
		expect(checkMaterialParam(standard, 'side', 'double')).toEqual({ ok: true, value: 2 });
	});
	it('refuses a texture slot given a string, an unknown key, a key this material lacks, and wrong kinds', () => {
		expect(checkMaterialParam(standard, 'map', 'https://example.com/a.png').ok).toBe(false);
		expect(checkMaterialParam(standard, 'onBeforeCompile', 'x').ok).toBe(false);
		expect(checkMaterialParam(standard, 'shininess', 30).ok).toBe(false);
		expect(checkMaterialParam(standard, 'roughness', 'rough').ok).toBe(false);
		expect(checkMaterialParam(standard, 'emissive', { r: 1 }).ok).toBe(false);
		expect(checkMaterialParam(standard, 'side', 5).ok).toBe(false);
	});
	it('a texture slot takes null (clear) and, locally, a Texture', () => {
		expect(checkMaterialParam(standard, 'map', null)).toEqual({ ok: true, value: null });
		const tex = { isTexture: true };
		expect(checkMaterialParam(standard, 'map', tex, { texture: true })).toEqual({ ok: true, value: tex });
		expect(checkMaterialParam(standard, 'map', tex).ok).toBe(false);
	});
	it('helpers', () => {
		expect(toHexColor(0x00ff00)).toBe('#00ff00');
		expect(toHexColor('red')).toBeNull();
		expect(isMaterialParamKey('roughness')).toBe(true);
		expect(isMaterialParamKey('__proto__')).toBe(false);
	});
});

describe('the receiving side', () => {
	const msg = (/** @type {string} */ key, /** @type {any} */ value) => ({ type: 'objectParameters', parameter: 'materialParam', uuid: 'u1', key, value });
	it('drops a bad replicated material parameter, passes a good one', () => {
		expect(validateWireMessage(msg('map', 'https://example.com/a.png'))).toBe(false);
		expect(validateWireMessage(msg('notAKey', 1))).toBe(false);
		expect(validateWireMessage(msg('roughness', Number.NaN))).toBe(false);
		expect(validateWireMessage(msg('roughness', 0.4))).toBe(true);
		expect(validateWireMessage(msg('emissive', '#112233'))).toBe(true);
		expect(validateWireMessage(msg('map', null))).toBe(true);
	});
});
