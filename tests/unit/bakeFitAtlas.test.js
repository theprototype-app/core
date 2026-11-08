// 98-int T1 — a scene too detailed for one lightmap still bakes (device-lab: Templates ▸ Tavern interior failed
// "the scene does not fit one lightmap" on the PC, the phone and at Quality ▸ High: 414 receivers, 111 599 charts,
// and every chart costs (pad + 1)² texels whatever the density). Offline on the real Tavern input (scratch dump of
// collectBakeScene): every tier now keeps all 411 unwrappable receivers (PC normal: 198 by their own uv0, 19 of them AO
// only, density 3.95 texel/m); before, planAtlas failed on every tier.
import { describe, it, expect, vi } from 'vitest';
import { planAtlas, fitAtlas } from '../../src/lib/bake/bakeAtlasCore.js';

/**
 * a mesh of `charts` square charts of `size` world units: its auto layout pays the padding once per chart
 * @param {string} key @param {number} charts @param {number} size @param {{alt?: boolean, ws?: number}} [o]
 * @returns {any}
 */
function mesh(key, charts, size, { alt = true, ws = 1 } = {}) {
	const n = Math.ceil(Math.sqrt(charts));
	return {
		key,
		ws,
		area: charts * size * size,
		charts,
		layoutFor: (/** @type {number} */ pad) => ({ ok: true, w: n * (size + pad), h: n * (size + pad) }),
		alt: alt ? () => ({ src: 'uv0', mode: 'full', charts: 1, layoutFor: () => ({ ok: true, w: n * size, h: n * size }) }) : null
	};
}

describe('fitAtlas — a scene too detailed for one lightmap', () => {
	it('a scene that fits is planned exactly as before (the own-uv0 fallback is never even asked)', () => {
		const alt = vi.fn(() => null);
		const items = [mesh('a', 4, 1), mesh('b', 1, 2), { ...mesh('c', 9, 0.5), alt }];
		const fit = fitAtlas(items, 256, 2, 64);
		expect('error' in fit).toBe(false);
		if ('error' in fit) return;
		expect(fit.atlas).toEqual(planAtlas(items, 256, 2, 64));
		expect(fit.kept).toBe(items);
		expect(fit.dropped).toEqual([]);
		expect(alt).not.toHaveBeenCalled();
	});

	it('chart-heavy meshes switch to their own uv0 and NOTHING is left out (the Tavern case)', () => {
		const items = Array.from({ length: 40 }, (_, i) => mesh('prop' + i, 400, 0.05));
		// the counterfactual: the padding alone (40 × 400 × 9 texels) is over a 256² atlas
		expect('error' in planAtlas(items, 256, 2, 64)).toBe(true);
		const fit = fitAtlas(items, 256, 2, 64);
		expect('error' in fit).toBe(false);
		if ('error' in fit) return;
		expect(fit.dropped).toEqual([]);
		expect(fit.kept.length).toBe(40);
		expect(fit.kept.every((it) => /** @type {any} */ (it).src === 'uv0' && it.charts === 1)).toBe(true);
		expect(fit.atlas.placements.map((p) => p.key)).toEqual(items.map((it) => it.key));
	});

	it('the heaviest switch first: a light mesh keeps its auto layout while switching the heavy ones is enough', () => {
		const items = [...Array.from({ length: 30 }, (_, i) => mesh('heavy' + i, 600, 0.04)), mesh('wall', 2, 3)];
		const fit = fitAtlas(items, 256, 2, 64);
		expect('error' in fit).toBe(false);
		if ('error' in fit) return;
		const wall = fit.kept.find((it) => it.key === 'wall');
		expect(/** @type {any} */ (wall).src).toBeUndefined(); // untouched: still the auto layout
		expect(fit.kept.filter((it) => it.key.startsWith('heavy')).every((it) => it.charts === 1)).toBe(true);
	});

	it('with no uv0 to fall back on, the big surfaces stay and the chart-heavy props are left out — the same ones every run', () => {
		const props = Array.from({ length: 60 }, (_, i) => mesh('prop' + i, 400, 0.05, { alt: false }));
		const walls = [mesh('floor', 1, 6, { alt: false }), mesh('wallN', 1, 5, { alt: false })];
		const items = [...props.slice(0, 30), ...walls, ...props.slice(30)];
		expect('error' in planAtlas(items, 256, 2, 64)).toBe(true);
		const a = fitAtlas(items, 256, 2, 64);
		const b = fitAtlas(items, 256, 2, 64);
		expect('error' in a).toBe(false);
		if ('error' in a || 'error' in b) return;
		expect(a.kept.map((it) => it.key)).toEqual(b.kept.map((it) => it.key));
		expect(a.kept.map((it) => it.key)).toEqual(expect.arrayContaining(['floor', 'wallN']));
		expect(a.dropped.length).toBeGreaterThan(0);
		expect(a.kept.length + a.dropped.length).toBe(items.length);
		// the kept set really fits, in input order
		expect(a.atlas).toEqual(planAtlas(a.kept, 256, 2, 64));
	});

	it('a single mesh that cannot fit still reports the plain error', () => {
		const one = [mesh('huge', 20000, 0.01, { alt: false })];
		const fit = fitAtlas(one, 64, 4, 64);
		expect(fit).toEqual({ error: 'the scene does not fit one lightmap' });
	});
});
