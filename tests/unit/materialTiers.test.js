// @ts-nocheck — plain fixtures; the code under test is typed
// 40 F16: the fish-scale look — the Fish scales starter, the tileable scale relief, and the
// LOOK TIER that draws transmission / thin film only where a device can pay for them while the
// authored look rides beside the material.
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

vi.mock('../../src/lib/qualityGovernor', async () => {
	const { writable } = await import('svelte/store');
	return { qualityOverrides: writable({}) };
});

import { lookTier, tieredValue, planTier, TIERED_FIELDS } from '../../src/lib/materialTiersCore.js';
import { applyTierTo } from '../../src/lib/materialTiers.js';
import { STARTER_PRESETS, normalizePreset, snapshotLook, swatchLayers } from '../../src/lib/materialPresetsCore.js';
import { heightField, scaleHeight, MAP_SIZE } from '../../src/lib/materialPresetMaps.js';

describe('the look tier rule', () => {
	it('desktop full quality = high; a phone start = mid; post off or a headset = low', () => {
		expect(lookTier({ overrides: {} })).toBe('high');
		expect(lookTier({ overrides: { aoOff: true, dprScale: 0.72 } })).toBe('mid');
		expect(lookTier({ overrides: { dprScale: 0.72 } })).toBe('mid');
		expect(lookTier({ overrides: { postOff: true } })).toBe('low');
		expect(lookTier({ xr: true, overrides: {} })).toBe('low');
		expect(lookTier({ xr: true, pin: 'high' })).toBe('high');
	});
	it('mid drops only the extra pass; low drops the per-pixel terms too', () => {
		expect(tieredValue('transmission', 0.3, 'high')).toBe(0.3);
		expect(tieredValue('transmission', 0.3, 'mid')).toBe(0);
		expect(tieredValue('iridescence', 0.9, 'mid')).toBe(0.9);
		expect(tieredValue('iridescence', 0.9, 'low')).toBe(0);
		expect(tieredValue('roughness', 0.4, 'low')).toBe(0.4); // not a tiered field
	});
	it('an edit made since the last pass becomes the authored value', () => {
		const first = planTier({ transmission: 0.3, sheen: 0, iridescence: 0.8 }, null, null, 'low');
		expect(first.authored).toEqual({ transmission: 0.3, sheen: 0, iridescence: 0.8 });
		expect(first.draw).toEqual({ transmission: 0, sheen: 0, iridescence: 0 });
		// nobody touched it: the record wins over the drawn zeros
		const again = planTier(first.draw, first.authored, first.draw, 'low');
		expect(again.authored.iridescence).toBe(0.8);
		// the Inspector set transmission to 0.5 while drawn at 0: that is the new look
		const edited = planTier({ ...first.draw, transmission: 0.5 }, first.authored, first.draw, 'high');
		expect(edited.authored.transmission).toBe(0.5);
		expect(edited.draw.transmission).toBe(0.5);
	});
});

describe('the tier on a real material', () => {
	it('lowers, records, restores — and recompiles only when a term crosses zero', () => {
		const m = new THREE.MeshPhysicalMaterial({ iridescence: 0.9, transmission: 0.2 });
		const v0 = m.version;
		expect(applyTierTo(m, 'high')).toBe(false);
		expect(m.userData.lookTierAuthored).toBeUndefined(); // a desktop writes nothing
		expect(m.version).toBe(v0);
		expect(applyTierTo(m, 'mid')).toBe(true);
		expect(m.transmission).toBe(0);
		expect(m.iridescence).toBe(0.9);
		expect(m.version).toBeGreaterThan(v0); // needsUpdate
		applyTierTo(m, 'low');
		expect(m.iridescence).toBe(0);
		expect(m.userData.lookTierAuthored).toEqual({ transmission: 0.2, sheen: 0, iridescence: 0.9 });
		// a save on this device: toJSON carries the drawn zeros AND the authored record …
		const json = m.toJSON();
		const loaded = new THREE.MaterialLoader().parse(json);
		expect(loaded.iridescence).toBe(0);
		// … so the desktop that opens it draws the full look again
		applyTierTo(loaded, 'high');
		expect(loaded.iridescence).toBeCloseTo(0.9, 9);
		expect(loaded.transmission).toBeCloseTo(0.2, 9);
	});
	it('a preset snapshot taken on a low device reads the authored look', () => {
		const m = new THREE.MeshPhysicalMaterial({ iridescence: 0.7 });
		applyTierTo(m, 'low');
		expect(m.iridescence).toBe(0);
		expect(snapshotLook(m, 'Mine').iridescence).toBeCloseTo(0.7, 4);
	});
	it('leaves standard materials alone', () => {
		const m = new THREE.MeshStandardMaterial();
		expect(applyTierTo(m, 'low')).toBe(false);
		expect(m.userData.lookTierAuthored).toBeUndefined();
	});
	it('every tiered field is a real MeshPhysicalMaterial property', () => {
		const m = new THREE.MeshPhysicalMaterial();
		for (const f of TIERED_FIELDS) expect(typeof m[f]).toBe('number');
	});
});

describe('the Fish scales preset', () => {
	const fish = STARTER_PRESETS.find((p) => p.id === 'fishscale');
	it('is a physical, iridescent, scale-relief look that survives normalisation', () => {
		expect(fish.type).toBe('MeshPhysicalMaterial');
		const n = normalizePreset(fish);
		expect(n.iridescence).toBeGreaterThan(0.5);
		expect(n.iridescenceThicknessMax).toBeGreaterThan(n.iridescenceThicknessMin);
		expect(n.procedural).toBe('scales');
		expect(n.transmission).toBeGreaterThan(0);
	});
	it('its swatch shows the film', () => {
		expect(swatchLayers(fish).some((l) => l.startsWith('conic-gradient'))).toBe(true);
		expect(swatchLayers(STARTER_PRESETS.find((p) => p.id === 'metal')).some((l) => l.startsWith('conic'))).toBe(false);
	});
	it('the scale relief tiles seamlessly and has real relief', () => {
		const n = 64;
		const h = heightField('scales', n);
		let lo = 1;
		let hi = 0;
		for (const v of h) {
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
		expect(hi - lo).toBeGreaterThan(0.5);
		// the left edge continues the right edge, the top the bottom (a wrap, not a seam)
		for (let i = 0; i < 1; i += 0.05) {
			expect(Math.abs(scaleHeight(0, i) - scaleHeight(1 - 1e-9, i))).toBeLessThan(0.05);
			expect(Math.abs(scaleHeight(i, 0) - scaleHeight(i, 1 - 1e-9))).toBeLessThan(0.05);
		}
		expect(MAP_SIZE).toBe(256);
	});
});
