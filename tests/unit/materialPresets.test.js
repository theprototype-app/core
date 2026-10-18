import { describe, it, expect } from 'vitest';
import {
	STARTER_PRESETS,
	PRESET_TYPES,
	normalizePreset,
	snapshotLook,
	sameLook,
	uniqueName,
	planBroadcast,
	splitParts,
	presetKey,
	isPresetRef,
	cleanName,
	swatchBackground,
	NAME_MAX
} from '../../src/lib/materialPresetsCore.js';
import { heightField, mapBytes } from '../../src/lib/materialPresetMaps.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';

// 37 R5 — material presets, the pure half: the payload boundary every source (IndexedDB, a
// peer, an imported file) passes through, the look compare that lights the active swatch, and
// the procedural maps the starter set's wood and stone wear.

/** a material-shaped double (what snapshotLook reads off a THREE material) @param {any} fields */
function fakeMaterial(fields) {
	const color = (/** @type {string} */ hex) => ({ getHexString: () => hex.replace('#', '') });
	return {
		type: 'MeshStandardMaterial',
		color: color('#ffffff'),
		emissive: color('#000000'),
		roughness: 1,
		metalness: 0,
		emissiveIntensity: 1,
		opacity: 1,
		transparent: false,
		...fields
	};
}

describe('the starter set', () => {
	it('is the seven the brief names, in order', () => {
		expect(STARTER_PRESETS.map((p) => p.id)).toEqual(['wood', 'metal', 'plastic', 'glass', 'stone', 'rubber', 'fishscale', 'neon']);
	});

	it('every starter survives its own normalisation unchanged in look', () => {
		for (const p of STARTER_PRESETS) {
			const n = normalizePreset(p);
			expect(n, p.id).not.toBeNull();
			expect(sameLook(n, p), p.id).toBe(true);
			expect(PRESET_TYPES).toContain(n.type);
		}
	});

	it('glass is see-through WITHOUT transmission (the Quest budget: no extra scene pass)', () => {
		const glass = STARTER_PRESETS.find((p) => p.id === 'glass');
		expect(glass.transparent).toBe(true);
		expect(glass.opacity).toBeLessThan(1);
		expect(glass.transmission ?? 0).toBe(0);
	});

	it('neon glows and wood/stone carry procedural maps', () => {
		expect(STARTER_PRESETS.find((p) => p.id === 'neon').emissive).not.toBe('#000000');
		expect(STARTER_PRESETS.find((p) => p.id === 'wood').procedural).toBe('wood');
		expect(STARTER_PRESETS.find((p) => p.id === 'stone').procedural).toBe('stone');
	});
});

describe('normalizePreset — the boundary', () => {
	it('refuses what is not a preset', () => {
		expect(normalizePreset(null)).toBeNull();
		expect(normalizePreset('wood')).toBeNull();
		expect(normalizePreset({ label: 'x', type: 'ShaderMaterial' })).toBeNull();
		expect(normalizePreset({ label: '', type: 'MeshStandardMaterial' })).toBeNull();
		expect(normalizePreset({ label: 'x', type: 'MeshNormalMaterial' })).toBeNull();
	});

	it('clamps numbers, canonicalises colours, drops unknown fields', () => {
		const n = normalizePreset({
			label: '  Hot  ',
			type: 'MeshStandardMaterial',
			color: 'FF0000',
			roughness: 7,
			metalness: -2,
			opacity: NaN,
			emissiveIntensity: 1e9,
			evil: '<script>',
			uuid: 'abc'
		});
		expect(n.label).toBe('Hot');
		expect(n.color).toBe('#ff0000');
		expect(n.roughness).toBe(1);
		expect(n.metalness).toBe(0);
		expect(n.opacity).toBeUndefined();
		expect(n.emissiveIntensity).toBe(20);
		expect(n.evil).toBeUndefined();
		expect(n.uuid).toBeUndefined();
	});

	it('takes image data-URLs only — never a remote URL a library would fetch', () => {
		const ok = 'data:image/webp;base64,AAAA';
		expect(normalizePreset({ label: 'a', type: 'MeshStandardMaterial', map: ok }).map).toBe(ok);
		expect(normalizePreset({ label: 'a', type: 'MeshStandardMaterial', map: 'https://x/y.png' }).map).toBeUndefined();
		expect(normalizePreset({ label: 'a', type: 'MeshStandardMaterial', map: 'data:text/html;base64,AA' }).map).toBeUndefined();
	});

	it('caps the name and strips control characters', () => {
		expect(cleanName('a\u0000b\nc')).toBe('abc');
		expect(cleanName('x'.repeat(100)).length).toBe(NAME_MAX);
	});
});

describe('snapshotLook + sameLook — the active swatch', () => {
	it('a material dressed as a starter reads back as that starter', () => {
		const metal = STARTER_PRESETS.find((p) => p.id === 'metal');
		const m = fakeMaterial({
			color: { getHexString: () => metal.color.slice(1) },
			roughness: metal.roughness,
			metalness: metal.metalness
		});
		const look = snapshotLook(m, 'whatever');
		expect(sameLook(look, metal)).toBe(true);
		// and NOT as the others
		for (const p of STARTER_PRESETS.filter((q) => q.id !== 'metal')) expect(sameLook(look, p), p.id).toBe(false);
	});

	it('a slider nudge breaks the match (it is a different look now)', () => {
		const metal = STARTER_PRESETS.find((p) => p.id === 'metal');
		const m = fakeMaterial({
			color: { getHexString: () => metal.color.slice(1) },
			roughness: metal.roughness + 0.05,
			metalness: metal.metalness
		});
		expect(sameLook(snapshotLook(m, 'x'), metal)).toBe(false);
	});

	it('float noise below a thousandth is the same look', () => {
		const a = { version: 1, label: 'a', type: 'MeshStandardMaterial', roughness: 0.5 };
		const b = { ...a, roughness: 0.50004 };
		expect(sameLook(a, b)).toBe(true);
	});

	it('fields a type does not have are ignored (Phong has no metalness)', () => {
		const a = { version: 1, label: 'a', type: 'MeshPhongMaterial', color: '#123456', metalness: 1 };
		const b = { version: 1, label: 'b', type: 'MeshPhongMaterial', color: '#123456' };
		expect(sameLook(a, b)).toBe(true);
	});

	it('the map is part of the look', () => {
		const base = { version: 1, label: 'a', type: 'MeshStandardMaterial' };
		expect(sameLook({ ...base, map: 'data:image/png;base64,AA' }, base)).toBe(false);
	});

	it('the snapshot keeps the map URL and the repeat', () => {
		const m = fakeMaterial({ map: { repeat: { x: 2, y: 3 } } });
		const look = snapshotLook(m, 'tiled', { mapUrl: 'data:image/png;base64,AA' });
		expect(look.map).toBe('data:image/png;base64,AA');
		expect(look.repeat).toEqual([2, 3]);
	});
});

describe('names', () => {
	it('uniqueName counts up past taken names, case-insensitively', () => {
		expect(uniqueName('Wood', ['Metal'])).toBe('Wood');
		expect(uniqueName('Wood', ['wood'])).toBe('Wood 2');
		expect(uniqueName('Wood', ['Wood', 'Wood 2'])).toBe('Wood 3');
		expect(uniqueName('', [])).toBe('Material');
	});
});

describe('the library broadcast', () => {
	it('48 F2: every preset is listed, in order — small ones inline, big ones by reference', () => {
		const big = 'data:image/jpeg;base64,' + 'A'.repeat(5000);
		const list = Array.from({ length: 10 }, (_, i) => ({ label: 'p' + i, type: 'MeshStandardMaterial', map: i % 3 ? undefined : big }));
		const plan = planBroadcast(list, { cap: 3500, inlineMax: 2000 });
		expect(plan.presets.map((p) => p.label)).toEqual(list.map((p) => p.label));
		const refs = plan.presets.filter(isPresetRef);
		expect(refs.map((r) => r.label)).toEqual(['p0', 'p3', 'p6', 'p9']);
		for (const r of refs) {
			const json = plan.json.get(r.ref);
			expect(json && presetKey(json)).toBe(r.ref);
			expect(r.size).toBe(json?.length);
		}
		// the inline part stays under the cap
		expect(JSON.stringify(plan.presets.filter((p) => !isPresetRef(p))).length).toBeLessThanOrEqual(3500);
	});

	it('48 F2: a past-the-cap inline run spills to references, never drops', () => {
		const list = Array.from({ length: 30 }, (_, i) => ({ label: 'q' + i, type: 'MeshStandardMaterial', map: 'data:image/png;base64,' + 'B'.repeat(150) }));
		const plan = planBroadcast(list, { cap: 2000 });
		expect(plan.presets.length).toBe(30);
		expect(plan.presets.some(isPresetRef)).toBe(true);
		expect(plan.presets.findIndex(isPresetRef)).toBeGreaterThan(0);
	});

	it('48 F2: parts rejoin to the same JSON, and the key tells two payloads apart', () => {
		const s = JSON.stringify({ label: 'x', map: 'data:' + 'C'.repeat(1234) });
		const parts = splitParts(s, 100);
		expect(parts.length).toBe(Math.ceil(s.length / 100));
		expect(parts.join('')).toBe(s);
		expect(presetKey(s)).toMatch(/^[0-9a-f]{14}$/);
		expect(presetKey(s)).not.toBe(presetKey(s.replace('x', 'y')));
		expect(isPresetRef({ ref: presetKey(s), label: 'x' })).toBe(true);
		expect(isPresetRef({ ref: 'nothex!', label: 'x' })).toBe(false);
	});

	it('the wire validator takes a library and refuses a malformed one', () => {
		expect(validateWireMessage({ type: 'matpresets', from: 'peer-a', presets: [] })).toBe(true);
		expect(validateWireMessage({ type: 'matpresets', from: 'peer-a', presets: 'x' })).toBe(false);
		expect(validateWireMessage({ type: 'matpresets', presets: [] })).toBe(false);
		expect(validateWireMessage({ type: 'matpresets', from: 'a', presets: new Array(201).fill({}) })).toBe(false);
		// 48 F2: the pull and its parts
		expect(validateWireMessage({ type: 'getmatpreset', ref: '0123456789abcd' })).toBe(true);
		expect(validateWireMessage({ type: 'getmatpreset', ref: 7 })).toBe(false);
		expect(validateWireMessage({ type: 'matpresetpart', from: 'a', ref: 'r', i: 0, n: 2, data: 'xx' })).toBe(true);
		expect(validateWireMessage({ type: 'matpresetpart', from: 'a', ref: 'r', i: 2, n: 2, data: 'xx' })).toBe(false);
		expect(validateWireMessage({ type: 'matpresetpart', from: 'a', ref: 'r', i: 0, n: 999, data: 'xx' })).toBe(false);
	});
});

describe('swatches', () => {
	it('renders every starter as a CSS background with no undefined in it', () => {
		for (const p of STARTER_PRESETS) {
			const bg = swatchBackground(p);
			expect(bg, p.id).not.toMatch(/undefined|NaN/);
		}
	});
});

describe('procedural maps', () => {
	for (const kind of /** @type {const} */ (['wood', 'stone'])) {
		it(`${kind}: a height field in [0,1] with real variation`, () => {
			const size = 64;
			const h = heightField(kind, size);
			let lo = 1;
			let hi = 0;
			for (const v of h) {
				expect(Number.isFinite(v)).toBe(true);
				lo = Math.min(lo, v);
				hi = Math.max(hi, v);
			}
			expect(lo).toBeGreaterThanOrEqual(0);
			expect(hi).toBeLessThanOrEqual(1);
			expect(hi - lo).toBeGreaterThan(0.3);
		});

		it(`${kind}: TILES — the wrap-around seam is no rougher than the inside`, () => {
			const size = 128;
			const h = heightField(kind, size);
			const at = (/** @type {number} */ x, /** @type {number} */ y) => h[y * size + x];
			// mean step across the seam (last column -> first) vs across a column inside
			let seam = 0;
			let inner = 0;
			let seamV = 0;
			let innerV = 0;
			for (let i = 0; i < size; i++) {
				seam += Math.abs(at(size - 1, i) - at(0, i));
				inner += Math.abs(at(size / 2 - 1, i) - at(size / 2, i));
				seamV += Math.abs(at(i, size - 1) - at(i, 0));
				innerV += Math.abs(at(i, size / 2 - 1) - at(i, size / 2));
			}
			expect(seam).toBeLessThan(inner * 2 + 1);
			expect(seamV).toBeLessThan(innerV * 2 + 1);
		});

		it(`${kind}: is deterministic (every peer that generates it gets the same bytes)`, () => {
			expect(heightField(kind, 32)).toEqual(heightField(kind, 32));
		});
	}

	it('the normal map is unit-ish and points out of the surface', () => {
		const size = 32;
		const { color, normal } = mapBytes(heightField('stone', size), size, 4);
		expect(color.length).toBe(size * size * 4);
		for (let i = 0; i < normal.length; i += 4) {
			const nx = normal[i] / 127.5 - 1;
			const ny = normal[i + 1] / 127.5 - 1;
			const nz = normal[i + 2] / 127.5 - 1;
			expect(nz).toBeGreaterThan(0);
			expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(0.05);
		}
	});
});
