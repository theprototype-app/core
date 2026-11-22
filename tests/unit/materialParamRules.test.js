import { describe, it, expect } from 'vitest';
import {
	checkMaterialParam,
	toHexColor,
	isMaterialParamKey,
	MAP_SLOTS,
	MAP_SLOT_MAX_URL,
	isMapSlotKey,
	isMapSlotImage,
	normalizeTexTransform,
	isIdentityTexTransform,
	guessMapSlot
} from '../../src/lib/materialParamRules.js';
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

// 72 LK1: map slots
describe('map slot rules', () => {
	it('knows the five slots, and only those', () => {
		expect(MAP_SLOTS.map((slot) => slot.key)).toEqual(['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']);
		expect(isMapSlotKey('map')).toBe(false);
		expect(isMapSlotKey('__proto__')).toBe(false);
		expect(MAP_SLOTS.filter((slot) => slot.srgb).map((slot) => slot.key)).toEqual(['emissiveMap']);
	});
	it('takes an inline image or null, never a URL', () => {
		expect(isMapSlotImage(null)).toBe(true);
		expect(isMapSlotImage('data:image/webp;base64,AAAA')).toBe(true);
		expect(isMapSlotImage('https://example.com/a.png')).toBe(false);
		expect(isMapSlotImage('data:image/svg+xml;base64,AAAA')).toBe(false);
		expect(isMapSlotImage('data:text/html;base64,AAAA')).toBe(false);
		expect(isMapSlotImage(undefined)).toBe(false);
		expect(isMapSlotImage('data:image/png;base64,' + 'A'.repeat(MAP_SLOT_MAX_URL))).toBe(false);
	});
	it('normalizes a transform: fills gaps, refuses bad shapes, keeps tiling away from zero', () => {
		expect(normalizeTexTransform({})).toEqual({ repeat: [1, 1], offset: [0, 0], rotation: 0 });
		expect(normalizeTexTransform({ repeat: [2, 3], offset: [0.5, -1], rotation: 1 })).toEqual({ repeat: [2, 3], offset: [0.5, -1], rotation: 1 });
		expect(normalizeTexTransform({ repeat: [0, -2] })?.repeat).toEqual([0.001, -2]);
		expect(normalizeTexTransform({ repeat: [1e9, 1] })?.repeat[0]).toBe(1000);
		for (const bad of [null, 5, [], { repeat: [1] }, { repeat: ['1', 1] }, { offset: [NaN, 0] }, { rotation: Infinity }]) {
			expect(normalizeTexTransform(bad)).toBe(null);
		}
		expect(isIdentityTexTransform(normalizeTexTransform({}))).toBe(true);
		expect(isIdentityTexTransform({ repeat: [2, 1], offset: [0, 0], rotation: 0 })).toBe(false);
	});
	it('reads the slot from a file name by the last word that names a map', () => {
		const cases = {
			'wood_normal.png': 'normalMap',
			'metal_plate_nor_gl_1k.jpg': 'normalMap',
			'metal_plate_diff_1k.jpg': 'map',
			'metal_plate_rough_1k.jpg': 'roughnessMap',
			'metal_plate_metal_1k.jpg': 'metalnessMap',
			'Metal032_2K_Color.jpg': 'map',
			'bricks-AmbientOcclusion.png': 'aoMap',
			'bricksAO.png': 'aoMap',
			'lamp_emissive.webp': 'emissiveMap',
			'chaos_garden.png': null,
			'photo.jpg': null,
			'__proto__.png': null
		};
		for (const [name, slot] of Object.entries(cases)) expect([name, guessMapSlot(name)]).toEqual([name, slot]);
		expect(guessMapSlot(undefined)).toBe(null);
	});
	it('the wire refuses a bad slot message and lets a good one through', () => {
		const uuid = '11111111-1111-4111-8111-111111111111';
		const check = (/** @type {any} */ m) => validateWireMessage({ type: 'objectParameters', uuid, ...m });
		expect(check({ parameter: 'mapSlot', key: 'normalMap', map: 'data:image/png;base64,AA' })).toBe(true);
		expect(check({ parameter: 'mapSlot', key: 'normalMap', map: null })).toBe(true);
		expect(check({ parameter: 'mapSlot', key: 'normalMap', map: 'http://attacker.example/x.png' })).toBe(false);
		expect(check({ parameter: 'mapSlot', key: 'onBeforeCompile', map: null })).toBe(false);
		expect(check({ parameter: 'texTransform', transform: { repeat: [2, 2] } })).toBe(true);
		expect(check({ parameter: 'texTransform', transform: { repeat: 'x' } })).toBe(false);
		expect(check({ parameter: 'normalStrength', value: 1 })).toBe(true);
		expect(check({ parameter: 'normalStrength', value: 'x' })).toBe(false);
	});
});
