// 98-int — THE OLD-SCENE SET for 1.63 (every release that adds a saved type ships one). 1.63 adds the scene `bake`
// record (98 P1), the post kinds antialias / lensflare / godrays / volumetricfog (P3/P4) and the pro environment
// presets (P5). Scenes from 1.61 / 1.62 carry none of them: they must load unchanged. A bake record from a NEWER
// build keeps its version and unknown fields (the "made with a newer version" notice reads isNewerBakeRecord).
import { describe, it, expect } from 'vitest';
import { normalizeBakeRecord, isNewerBakeRecord, BAKE_VERSION } from '../../src/lib/bake/bakeRecordCore.js';
import { normalizeScenePost } from '../../src/lib/scenePost.js';
import { scaleProEffects, PRO_LOOKS, PRO_PRESET_KEYS } from '../../src/lib/post/proPresetsCore.js';

/** a 1.62-shaped scene look: SMAA + a vignette, as 1.62 saved it */
const look162 = () => ({
	enabled: true,
	effects: [
		{ id: 'a1', kind: 'smaa', enabled: true, params: { preset: 'MEDIUM' } },
		{ id: 'a2', kind: 'vignette', enabled: true, params: { offset: 0.4, darkness: 0.5, technique: 'DEFAULT' } }
	],
	changedAt: 1790000000000
});

/** a 1.63 bake record as the baker writes it */
const bake163 = () => ({
	v: BAKE_VERSION,
	full: { hash: 'sha256:abc', side: 1024, bytes: 300000 },
	lite: { hash: 'sha256:def', side: 512, bytes: 80000 },
	lightScale: 1,
	intensity: { light: 1, ao: 1 },
	objects: [{ uuid: 'u-1', src: 'auto', mode: 'full', pad: 2, x: 0, y: 0, s: 0.5, ch: 2, sig: 'f00' }],
	lightsSig: 'beef',
	bakedAt: 1794000000000,
	changedAt: 1794000000000
});

describe('1.63 old-scene set', () => {
	it('a 1.61 / 1.62 scene has no `bake`: it loads with no bake', () => {
		expect(normalizeBakeRecord(undefined)).toBe(null);
		expect(normalizeBakeRecord(null)).toBe(null);
	});
	it("a 1.62 look (SMAA) keeps its kinds, order and params through 1.63's normalize", () => {
		const out = normalizeScenePost(look162());
		expect(out.effects.map((e) => e.kind)).toEqual(['smaa', 'vignette']);
		expect(out.effects[0].params.preset).toBe('MEDIUM');
		expect(out.effects[1].params).toMatchObject({ offset: 0.4, darkness: 0.5 });
		expect(out.changedAt).toBe(1790000000000);
	});
	it('a 1.62 look builds the same on every tier (no pro kinds in it to drop)', () => {
		const effects = normalizeScenePost(look162()).effects;
		for (const tier of /** @type {const} */ (['pc', 'phone', 'quest'])) expect(scaleProEffects(effects, tier).map((e) => e.kind)).toEqual(['smaa', 'vignette']);
	});
	it("1.63's own bake record round-trips (save → load → identical)", () => {
		const rec = normalizeBakeRecord(bake163());
		expect(rec.v).toBe(BAKE_VERSION);
		expect(normalizeBakeRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
	});
	it('a bake record from a newer build keeps its version and unknown fields through our writes', () => {
		const newer = { ...bake163(), v: BAKE_VERSION + 1, bounces: 3 };
		expect(isNewerBakeRecord(newer)).toBe(true);
		expect(isNewerBakeRecord(bake163())).toBe(false);
		const back = normalizeBakeRecord({ ...newer, intensity: { light: 2, ao: 1 } });
		expect(back.v).toBe(BAKE_VERSION + 1);
		expect(back.bounces).toBe(3);
		expect(back.intensity.light).toBe(2);
	});
	it("a 1.63 pro look's kinds survive a build that does not know them (preserved verbatim, skipped at plan time)", () => {
		const doc = { enabled: true, effects: PRO_LOOKS.cinematic.effects.map((e, i) => ({ id: 'p' + i, enabled: true, kind: e.kind + '-from-the-future', params: e.params })), changedAt: 1 };
		const out = normalizeScenePost(doc);
		expect(out.effects.map((e) => e.kind)).toEqual(doc.effects.map((e) => e.kind));
		expect(out.effects[1].params).toEqual(doc.effects[1].params);
		expect(PRO_PRESET_KEYS).toEqual(['product', 'cinematic', 'stylised']);
	});
});
