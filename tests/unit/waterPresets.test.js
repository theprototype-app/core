// @ts-nocheck — plain fixtures; the module under test is typed
// 36-water — presets are data: every one must produce a complete, valid blob that the
// contract reader accepts unchanged, and user presets must round-trip without stealing the
// object's shape or level.
import { describe, it, expect } from 'vitest';
import {
	WATER_PRESETS,
	waterPreset,
	resolveLook,
	resolveBubbles,
	userPresetFrom,
	applyUserPreset,
	LOOK_DEFAULTS,
	BUBBLE_DEFAULTS,
	MAX_BUBBLES
} from '../../src/lib/water/presets.js';
import { normalizeWater } from '../../src/lib/water/volumes.js';
import { waveComponents } from '../../src/lib/water/waves.js';

describe('water presets', () => {
	it('the lineup the brief asks for, with unique keys', () => {
		const keys = WATER_PRESETS.map((p) => p.key);
		for (const k of ['pool', 'aquarium', 'ocean', 'lake', 'river', 'lava', 'swamp', 'toxic', 'ice']) expect(keys).toContain(k);
		expect(new Set(keys).size).toBe(keys.length);
	});
	it('every preset is a complete blob the W1 reader keeps as-is', () => {
		for (const p of WATER_PRESETS) {
			const blob = waterPreset(p.key);
			expect(blob.version).toBe(1);
			expect(blob.preset).toBe(p.key);
			const n = normalizeWater(blob);
			expect(n.shape).toBe(blob.shape);
			expect(n.density).toBe(blob.density);
			for (const k of Object.keys(LOOK_DEFAULTS)) expect(blob.look).toHaveProperty(k);
			for (const k of Object.keys(BUBBLE_DEFAULTS)) expect(blob.bubbles).toHaveProperty(k);
			expect(JSON.parse(JSON.stringify(blob))).toEqual(blob); // plain JSON: replicates + saves
		}
	});
	it('the special cases: river flows, lava glows without refraction, ice is frozen and still', () => {
		expect(waterPreset('river').flow[0]).toBeGreaterThan(0);
		const lava = waterPreset('lava');
		expect(lava.look.refraction).toBe(0);
		expect(lava.look.emissiveStrength).toBeGreaterThan(0);
		const ice = waterPreset('ice');
		expect(ice.look.frozen).toBe(true);
		expect(waveComponents(ice.waves)).toEqual([]);
		expect(resolveLook(ice).detailSpeed).toBe(0);
		expect(waterPreset('ocean').shape).toBe('plane');
		expect(waterPreset('aquarium').bubbles.enabled).toBe(true);
	});
	it('applying a preset keeps a caller-given shape', () => {
		expect(waterPreset('ocean', { shape: 'cylinder' }).shape).toBe('cylinder');
		expect(waterPreset('nope')).toBe(null);
	});
	it('resolveLook fills the fog colour from the deep colour', () => {
		const L = resolveLook({ look: { deepColor: '#123456' } });
		expect(L.fogColor).toBe('#123456');
		expect(resolveLook({ look: { deepColor: '#123456', fogColor: '#ff0000' } }).fogColor).toBe('#ff0000');
	});
	it('resolveBubbles clamps', () => {
		const b = resolveBubbles({ count: 99999, sizeMin: 0.5, sizeMax: 0.1, opacity: 4, mode: 'weird', pop: 0 });
		expect(b.count).toBe(MAX_BUBBLES);
		expect(b.sizeMax).toBeGreaterThanOrEqual(b.sizeMin);
		expect(b.opacity).toBe(1);
		expect(b.mode).toBe('continuous');
		expect(b.pop).toBe(true); // only an explicit false turns the pop off
		expect(resolveBubbles({ pop: false }).pop).toBe(false);
	});
	it('a user preset round-trips the look and leaves shape + level alone', () => {
		const tuned = normalizeWater({ ...waterPreset('pool'), look: { ...waterPreset('pool').look, deepColor: '#ff00ff' }, level: 0.3, bubbles: { enabled: true, burstAt: 55 } });
		const rec = userPresetFrom('Pink pool', tuned);
		expect(rec.name).toBe('Pink pool');
		expect(rec.water.bubbles.burstAt).toBe(-1); // a stale burst never travels in a preset
		const other = normalizeWater({ ...waterPreset('ocean'), level: 7 });
		const applied = applyUserPreset(rec, other);
		expect(applied.shape).toBe('plane');
		expect(applied.level).toBe(7);
		expect(applied.look.deepColor).toBe('#ff00ff');
		expect(applied.preset).toBe('user:Pink pool');
	});
});
