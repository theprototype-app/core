// 33 — the LOD GROUP rule (src/lib/lodGroupCore.js), pure: the block's one boundary, screen
// size, the level pick with hysteresis + cull + bias, the pack `lods` row, threshold drags.
import { describe, it, expect } from 'vitest';
import {
	normalizeLodGroup,
	screenSizeOf,
	pickGroupLevel,
	packLodsOf,
	groupFromPackLods,
	generatedGroup,
	withThreshold,
	thresholdsOf,
	defaultScreenSizes,
	levelColor,
	sameGroup,
	MAX_LEVELS
} from '../../src/lib/lodGroupCore.js';

describe('normalizeLodGroup', () => {
	it('is null for anything that is not a group (absent = today)', () => {
		expect(normalizeLodGroup(null)).toBe(null);
		expect(normalizeLodGroup({})).toBe(null);
		expect(normalizeLodGroup({ levels: 'x' })).toBe(null);
		expect(normalizeLodGroup({ levels: [{ source: 'nope' }] })).toBe(null);
	});
	it('always starts with LOD0 = self, and only once', () => {
		const g = normalizeLodGroup({ levels: [{ source: 'generated', ratio: 0.5 }, { source: 'self' }] });
		expect(g?.levels.map((l) => l.source)).toEqual(['self', 'generated']);
	});
	it('forces thresholds strictly descending and fills missing ones from the defaults', () => {
		const g = normalizeLodGroup({ levels: [{ source: 'self', screenSize: 0.1 }, { source: 'generated', ratio: 0.5, screenSize: 0.4 }, { source: 'generated', ratio: 0.2 }] });
		const s = g?.levels.map((l) => l.screenSize) ?? [];
		expect(s[0]).toBe(0.1);
		expect(s[1]).toBeLessThan(s[0]);
		expect(s[2]).toBeLessThan(s[1]);
	});
	it('drops a level that cannot be built (a generated level with no ratio, a pack level with no file)', () => {
		const g = normalizeLodGroup({ levels: [{ source: 'self' }, { source: 'generated' }, { source: 'pack' }, { source: 'pack', ref: 'a.lod1.glb' }] });
		expect(g?.levels.length).toBe(2);
		expect(g?.levels[1].ref).toBe('a.lod1.glb');
	});
	it('a forced level outside the list falls back to auto; a valid one is kept', () => {
		const levels = [{ source: 'self' }, { source: 'generated', ratio: 0.5 }];
		expect(normalizeLodGroup({ mode: 'forced', forced: 5, levels })?.mode).toBe('auto');
		const g = normalizeLodGroup({ mode: 'forced', forced: 1, levels });
		expect(g?.mode).toBe('forced');
		expect(g?.forced).toBe(1);
	});
	it('keeps offsets and material overrides, drops identity ones and bad values', () => {
		const g = normalizeLodGroup({
			levels: [
				{ source: 'self' },
				{ source: 'generated', ratio: 0.5, offset: { pos: [0, 0.1, 0], rot: [0, 0, 0], scale: [1, 1, 1] }, material: { color: '#FF0000', roughness: 4, metalness: 'x' } },
				{ source: 'generated', ratio: 0.2, offset: { pos: [NaN, 0, 0] }, material: { color: 'red' } }
			]
		});
		expect(g?.levels[1].offset).toEqual({ pos: [0, 0.1, 0] });
		expect(g?.levels[1].material).toEqual({ color: '#ff0000', roughness: 1 });
		expect(g?.levels[2].offset).toBeUndefined();
		expect(g?.levels[2].material).toBeUndefined();
	});
	it('caps the level count', () => {
		const levels = [{ source: 'self' }, ...Array.from({ length: 12 }, (_, i) => ({ source: 'generated', ratio: 0.9 - i * 0.05 }))];
		expect(normalizeLodGroup({ levels })?.levels.length).toBe(MAX_LEVELS);
	});
	it('is idempotent', () => {
		const g = generatedGroup();
		expect(normalizeLodGroup(g)).toEqual(g);
		expect(sameGroup(g, JSON.parse(JSON.stringify(g)))).toBe(true);
	});
});

describe('screenSizeOf', () => {
	it('is r / (d·tan(fov/2)) for a perspective camera', () => {
		const s = screenSizeOf(1, 10, { fov: 90 });
		expect(s).toBeCloseTo(0.1, 6);
	});
	it('reads inside the sphere as filling the screen', () => {
		expect(screenSizeOf(2, 1, { fov: 50 })).toBeGreaterThan(1);
	});
	it('ortho uses the frustum height and zoom', () => {
		expect(screenSizeOf(1, 999, { isOrthographicCamera: true, top: 5, bottom: -5, zoom: 1 })).toBeCloseTo(0.2, 6);
		expect(screenSizeOf(1, 999, { isOrthographicCamera: true, top: 5, bottom: -5, zoom: 2 })).toBeCloseTo(0.4, 6);
	});
});

describe('pickGroupLevel', () => {
	const t = [0.3, 0.12, 0.04];
	it('LOD0 while big, each level under its threshold, the last level stays without cull', () => {
		expect(pickGroupLevel(0.5, t, 0)).toBe(0);
		expect(pickGroupLevel(0.2, t, 0)).toBe(1);
		expect(pickGroupLevel(0.05, t, 0)).toBe(2);
		expect(pickGroupLevel(0.001, t, 0)).toBe(2);
	});
	it('culls below the last threshold when cull is on', () => {
		expect(pickGroupLevel(0.001, t, 0, { cull: true })).toBe(-1);
		expect(pickGroupLevel(0.05, t, 0, { cull: true })).toBe(2);
	});
	it('HYSTERESIS: an object bobbing on an edge does not flip every frame', () => {
		// just under the LOD0 edge -> LOD1; back just over it (inside the band) -> stays LOD1
		const down = pickGroupLevel(0.299, t, 0);
		expect(down).toBe(1);
		expect(pickGroupLevel(0.31, t, down)).toBe(1);
		// clearly above the band -> back to LOD0
		expect(pickGroupLevel(0.36, t, down)).toBe(0);
		// COUNTERFACTUAL: with no band it would have popped back at 0.31
		expect(pickGroupLevel(0.31, t, down, { hysteresis: 0 })).toBe(0);
		// a frame-by-frame bob 0.295 <-> 0.305 for 100 frames: ONE switch, not 100
		let cur = 0;
		let switches = 0;
		for (let i = 0; i < 100; i++) {
			const next = pickGroupLevel(i % 2 ? 0.305 : 0.295, t, cur);
			if (next !== cur) switches++;
			cur = next;
		}
		expect(switches).toBe(1);
	});
	it('scale > 1 (low quality) steps down sooner; < 1 (group bias) keeps detail', () => {
		expect(pickGroupLevel(0.4, t, 0, { scale: 2 })).toBe(1);
		expect(pickGroupLevel(0.2, t, 0, { scale: 0.5 })).toBe(0);
	});
	it('a culled object comes back only above the band', () => {
		expect(pickGroupLevel(0.041, t, -1, { cull: true })).toBe(-1);
		expect(pickGroupLevel(0.05, t, -1, { cull: true })).toBe(2);
	});
});

describe('thresholdsOf', () => {
	it('folds the quality bias (coarser sooner) and the group bias (detail longer)', () => {
		const g = /** @type {any} */ ({ ...generatedGroup(), bias: 2 });
		expect(thresholdsOf(g, 1).scale).toBeCloseTo(0.5, 6);
		expect(thresholdsOf(generatedGroup(), 0.5).scale).toBeCloseTo(2, 6);
	});
});

describe('the pack row (contract P1)', () => {
	it('reads lods finest first and refuses paths that leave the item folder', () => {
		const row = { lods: [{ file: 'b.lod2.glb', ratio: 0.2 }, { file: 'b.lod1.glb', ratio: 0.5 }, { file: '../x.glb', ratio: 0.1 }, { file: 'https://x/y.glb' }] };
		expect(packLodsOf(row)).toEqual([
			{ file: 'b.lod1.glb', ratio: 0.5 },
			{ file: 'b.lod2.glb', ratio: 0.2 }
		]);
		expect(packLodsOf({})).toEqual([]);
	});
	it('a row with lods becomes a group: self + one pack level per file', () => {
		const g = groupFromPackLods({ lods: [{ file: 'b.lod1.glb', ratio: 0.5 }, { file: 'b.lod2.glb', ratio: 0.2 }] });
		expect(g?.levels.map((l) => l.source)).toEqual(['self', 'pack', 'pack']);
		expect(g?.levels[2]).toMatchObject({ ref: 'b.lod2.glb', ratio: 0.2 });
		expect(groupFromPackLods({ variants: {} })).toBe(null);
	});
});

describe('withThreshold (the bar drag)', () => {
	it('moves one edge and never past its neighbours', () => {
		const g = generatedGroup([0.5, 0.2]);
		const moved = withThreshold(g, 1, 0.2);
		expect(moved.levels[1].screenSize).toBe(0.2);
		const crossed = withThreshold(g, 1, 0.9);
		expect(crossed.levels[1].screenSize).toBeLessThan(g.levels[0].screenSize);
		const under = withThreshold(g, 1, -1);
		expect(under.levels[1].screenSize).toBeGreaterThan(g.levels[2].screenSize);
	});
});

describe('defaults + colours', () => {
	it('default thresholds descend', () => {
		const d = defaultScreenSizes(4);
		for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThan(d[i - 1]);
	});
	it('a colour per level, grey when culled', () => {
		expect(levelColor(0)).not.toBe(levelColor(1));
		expect(levelColor(-1)).toBe('#6b7280');
	});
});
