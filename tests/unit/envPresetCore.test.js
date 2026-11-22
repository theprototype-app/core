// 78-int PL16 + PL12 — what a preset sets, and what changed since
import { describe, it, expect } from 'vitest';
import { presetSets, envChanges, basedOnOf, presetExposure, PRESET_WHY } from '../../src/lib/envPresetCore.js';
import fs from 'fs';

// environment.js reaches geometries.svelte.js (runes): fixtures here, the key list from its source text
const P = {
	studio: { label: 'Studio', background: '#363b43', fog: null, hemi: { sky: '#ffffff', ground: '#4c525c', intensity: 1.1 }, sun: { color: '#ffffff', intensity: 1.8, position: [6, 10, 4] }, exposure: 1 },
	sunset: { label: 'Sunset', background: '#33202f', fog: { color: '#4a2c3f', near: 30, far: 140 }, hemi: { sky: '#ff9d6b', ground: '#3a2b3d', intensity: 0.9 }, sun: { color: '#ff7b3d', intensity: 1.8, position: [12, 4, -6] }, exposure: 1.1 },
	night: { label: 'Night', background: '#0b0e1a', fog: null, hemi: null, sun: null, exposure: 0.95 },
	daylight: { label: 'Daylight', background: '#8db8dd', fog: null, hemi: null, sun: null, exposure: 1.05 },
	photostudio: { label: 'Photo studio', background: '#3a3d42', gradient: { top: '#4a4e55', bottom: '#2a2c30' }, fog: null, hemi: { sky: '#ffffff', ground: '#cac7c6', intensity: 1 }, sun: { color: '#ffffff', intensity: 0.8, position: [-13.1, 4.1, -8.1] }, exposure: 1, hdri: { src: 'bundled:photostudio', background: false } },
	cinematic: { label: 'Cinematic', pro: true, background: '#ccd0c5', fog: null, hemi: { sky: '#7a97bc', ground: '#594f24', intensity: 0.8 }, sun: { color: '#ffc78a', intensity: 1.6, position: [12.9, 2.2, 9.2] }, exposure: 1.05, hdri: { src: 'bundled:sunrise' } }
};
const SRC = fs.readFileSync('src/lib/environment.js', 'utf8');
const TABLE = SRC.slice(SRC.indexOf('export const ENVIRONMENT_PRESETS'), SRC.indexOf('/** name-indexable view'));
const BUILT_INS = [...TABLE.matchAll(/^\t([a-z]+): \{$/gm)].map((m) => m[1]);
const clone = (/** @type {any} */ o) => JSON.parse(JSON.stringify(o));

describe('presetSets', () => {
	it('names what Studio holds', () => {
		expect(presetSets(P.studio)).toEqual(['backdrop', 'ambient', 'sun', 'no fog', 'exposure 1.00']);
	});
	it('a pro look adds tone mapping and its effect count; a sky image says so', () => {
		const s = presetSets(P.cinematic, { effects: 8 });
		expect(s).toContain('sky image');
		expect(s).toContain('tone mapping');
		expect(s).toContain('8 effects');
		expect(presetSets(P.photostudio)).toContain('sky image (light only)');
	});
	it('every built-in has a why line', () => {
		expect(BUILT_INS.length).toBeGreaterThanOrEqual(13);
		for (const key of BUILT_INS) expect(/** @type {Record<string, string>} */ (PRESET_WHY)[key], key).toBeTruthy();
	});
});

describe('envChanges', () => {
	it('a named preset as applied is not modified', () => {
		expect(envChanges({ preset: 'sunset', exposure: 1 }, P)).toEqual({ basedOn: 'sunset', label: 'Sunset', modified: [] });
		// a pro look writes its own exposure into the slider (the multiplier)
		expect(envChanges({ preset: 'cinematic', exposure: P.cinematic.exposure }, P).modified).toEqual([]);
	});
	it('the exposure slider on a named preset reads as modified', () => {
		expect(envChanges({ preset: 'studio', exposure: 1.4 }, P).modified).toEqual(['exposure']);
	});
	it('an edited copy keeps its origin and names the changed groups', () => {
		const payload = clone(P.cinematic);
		payload.label = 'Custom';
		payload.basedOn = 'cinematic';
		payload.sun.intensity = 3;
		payload.fog = { color: '#ffffff', near: 1, far: 9 };
		const c = envChanges({ preset: 'custom', exposure: P.cinematic.exposure, customPreset: payload }, P);
		expect(c.basedOn).toBe('cinematic');
		expect(c.label).toBe('Cinematic');
		expect(c.modified).toEqual(['sun', 'fog']);
	});
	it('a pro look whose effects changed says effects', () => {
		const c = envChanges({ preset: 'cinematic', exposure: P.cinematic.exposure }, P, { effects: ['ao'], look: ['ao', 'bloom'] });
		expect(presetExposure(P.cinematic)).toBe(1.05);
		expect(presetExposure(P.sunset)).toBe(1);
		expect(c.modified).toEqual(['effects']);
	});
	it('an old custom payload (no basedOn) has no origin', () => {
		const c = envChanges({ preset: 'custom', customPreset: { label: 'Mine', background: '#000000' } }, P);
		expect(c).toEqual({ basedOn: null, label: 'Mine', modified: [] });
	});
});

describe('basedOnOf', () => {
	it('a named preset is its own origin; a custom payload keeps its key; junk is none', () => {
		expect(basedOnOf({ preset: 'night' }, P)).toBe('night');
		expect(basedOnOf({ preset: 'custom', customPreset: { basedOn: 'daylight' } }, P)).toBe('daylight');
		expect(basedOnOf({ preset: 'custom', customPreset: { basedOn: 'nope' } }, P)).toBeUndefined();
		expect(basedOnOf({ preset: 'custom', customPreset: {} }, P)).toBeUndefined();
	});
});
