// @ts-nocheck — fixture-shaped test data (the tests/unit convention for graph fixtures)
import { describe, it, expect } from 'vitest';
import {
	GRADIENT_NODE,
	GRADIENT_PARAMS,
	normalizeGradient,
	displayRgb,
	gradientCamera,
	gradientClock,
	gradientBudget,
	targetSize,
	randomizeGradient,
	gradientPresetDoc,
	gradientDocFor,
	gradientNodeOf,
	presetKeyFrom,
	SHAPE_BASES
} from '../../src/lib/gradientLabCore.js';
import { shaderNodeDef, shaderNodeDoc } from '../../src/lib/shaderCatalog.js';
import { compileBackgroundGraphToIR } from '../../src/lib/shaderCompile.js';
import { normalizePresetDoc, normalizePresetIndex } from '../../src/lib/backgroundPresetsCore.js';

// 65 gradient — the Gradient lab's pure rules (gradientLabCore) and its node in the catalog.

/** a replayable random source */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
		return (s & 0xffffff) / 0x1000000;
	};
}

describe('65 gradient: normalize', () => {
	it('fills every param with its default from nothing', () => {
		const p = normalizeGradient(undefined);
		for (const def of GRADIENT_PARAMS) expect(p[def.name]).toEqual(def.default);
	});
	it('clamps numbers, refuses unknown enums and bad colours, keeps good ones', () => {
		const p = normalizeGradient({ speed: 99, density: -3, shape: 'cube', lighting: 'environment', color1: '#ABCDEF', color2: 'red', grain: '0.5', posX: null });
		expect(p.speed).toBe(2);
		expect(p.density).toBe(0);
		expect(p.shape).toBe('plane');
		expect(p.lighting).toBe('environment');
		expect(p.color1).toBe('#abcdef');
		expect(p.color2).toBe('#dbba95');
		expect(p.grain).toBe(0.5);
		expect(p.posX).toBe(-1.4);
	});
	it('reads a colour as its display bytes / 255 (no linearisation: ShaderGradient mixes in that space)', () => {
		expect(displayRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
		expect(displayRgb('nope')).toEqual([1, 1, 1]);
	});
});

describe('65 gradient: camera, clock, budget', () => {
	it('orbits about the origin with camera-controls conventions (polar from +Y, azimuth about Y from +Z)', () => {
		const front = gradientCamera(normalizeGradient({ azimuth: 0, polar: 90, distance: 2 }));
		expect(front.position.map((v) => +v.toFixed(6))).toEqual([0, 0, 2]);
		const halo = gradientCamera(normalizeGradient({ azimuth: 180, polar: 90, distance: 3.6 }));
		expect(halo.position[2]).toBeCloseTo(-3.6, 6);
		const top = gradientCamera(normalizeGradient({ polar: 0, distance: 5 }));
		expect(top.position[1]).toBeCloseTo(5, 6);
		expect(Math.hypot(top.position[0], top.position[2])).toBeGreaterThan(0);
	});
	it('wraps the shared clock: seamless at 289 for the planes, bounded for the sphere', () => {
		expect(gradientClock(10, 0.5, 'plane')).toBeCloseTo(5, 9);
		expect(gradientClock(86000, 0.4, 'plane')).toBeCloseTo((86000 * 0.4) % 289, 6);
		expect(gradientClock(86000, 0.4, 'waterPlane')).toBeLessThan(289);
		expect(gradientClock(86000, 2, 'sphere')).toBeLessThan(1000);
		expect(gradientClock(5, 0, 'plane')).toBe(0);
		// the same second gives the same value: every peer's frame is the same
		expect(gradientClock(1234.5, 0.3, 'sphere')).toBe(gradientClock(1234.5, 0.3, 'sphere'));
	});
	it('the budget: high animates the full mesh; low is coarser and every second frame; a headset and reduced motion hold still', () => {
		const high = gradientBudget({ tier: 'high' });
		expect(high).toMatchObject({ mode: 'high', animate: true, every: 1, segments: 192, sphereDetail: 64 });
		const low = gradientBudget({ tier: 'low' });
		expect(low).toMatchObject({ mode: 'low', animate: true, every: 2 });
		expect(low.segments).toBeLessThan(high.segments);
		const xr = gradientBudget({ tier: 'low', xr: true });
		expect(xr).toMatchObject({ mode: 'still', animate: false });
		expect(xr.sphereDetail).toBeLessThan(high.sphereDetail);
		expect(gradientBudget({ tier: 'high', reducedMotion: true })).toMatchObject({ mode: 'still', animate: false, segments: 192 });
	});
	it('sizes the target from the layer, capped on the long side; the XR sphere is 2:1', () => {
		expect(targetSize(1280, 800, gradientBudget({ tier: 'high' }))).toEqual([640, 400]);
		const [w, h] = targetSize(5120, 2880, gradientBudget({ tier: 'high' }));
		expect(Math.max(w, h)).toBe(1280);
		expect(w / h).toBeCloseTo(16 / 9, 2);
		expect(targetSize(1000, 1000, gradientBudget({ tier: 'low', xr: true }), true)).toEqual([1024, 512]);
	});
	it('the sphere budget stays inside the Quest triangle budget', () => {
		// icosahedron detail d = 20 (d + 1)^2 triangles; the headset's is far under 300k
		const d = gradientBudget({ tier: 'low', xr: true }).sphereDetail;
		expect(20 * (d + 1) ** 2).toBeLessThan(50000);
		const s = gradientBudget({ tier: 'low', xr: true }).segments;
		expect(2 * s * s).toBeLessThan(50000);
	});
});

describe('65 gradient: Randomize', () => {
	it('is replayable from its random source and always a valid, framed param set', () => {
		expect(randomizeGradient(seeded(7))).toEqual(randomizeGradient(seeded(7)));
		for (let i = 0; i < 40; i++) {
			const p = randomizeGradient(seeded(i + 1));
			expect(normalizeGradient(p)).toEqual(p);
			expect(['plane', 'sphere', 'waterPlane']).toContain(p.shape);
			expect(p.distance).toBe(SHAPE_BASES[p.shape].distance);
			expect(new Set([p.color1, p.color2, p.color3]).size).toBe(3);
		}
	});
	it('keeps the shape when asked', () => {
		for (let i = 0; i < 10; i++) expect(randomizeGradient(seeded(i), { keepShape: 'sphere' }).shape).toBe('sphere');
	});
});

describe('65 gradient: the node and the preset document', () => {
	it('is a background-only catalog node with a manual line, its params from the schema', () => {
		const def = shaderNodeDef(GRADIENT_NODE);
		expect(def?.stages).toEqual(['background']);
		expect(def?.params?.map((p) => p.name)).toEqual(GRADIENT_PARAMS.map((p) => p.name));
		expect(def?.params?.filter((p) => p.uniform).map((p) => p.name)).toEqual(['grain']);
		expect(shaderNodeDoc(GRADIENT_NODE).length).toBeGreaterThan(40);
	});
	it('compiles: the fragment samples the lab picture, grain is a live uniform, mesh params never recompile', () => {
		const doc = gradientDocFor({ shape: 'sphere' }, 'Test');
		const r = compileBackgroundGraphToIR(doc);
		expect(r.ok, String(r.errors)).toBe(true);
		expect(r.ir.fragment).toContain('tpGradientLab(');
		expect(r.ir.fragment).toContain('uniform sampler2D tpGradientTex;');
		expect(r.ir.uniforms.map((u) => u.name)).toEqual(['u_lab_grain']);
		const moved = structuredClone(doc);
		moved.nodes[0].data = { ...moved.nodes[0].data, color1: '#00ff00', speed: 1.5, shape: 'plane' };
		expect(compileBackgroundGraphToIR(moved).ir.fragment).toBe(r.ir.fragment);
	});
	it('refuses the node outside a background graph', () => {
		const doc = gradientDocFor({}, 'X');
		const surface = {
			nodes: [doc.nodes[0], { id: 's', type: 'surface', position: { x: 0, y: 0 }, data: {} }],
			edges: [{ id: 'e', source: 'lab', sourceHandle: 'out', target: 's', targetHandle: 'albedo' }]
		};
		return import('../../src/lib/shaderCompile.js').then(({ compileShaderGraphToIR }) => {
			const r = compileShaderGraphToIR(surface);
			expect(r.ok).toBe(false);
			expect(String(r.errors)).toMatch(/background/i);
		});
	});
	it('Copy as preset is a packs preset file the loader takes back unchanged', () => {
		const scene = { ...gradientDocFor(randomizeGradient(seeded(3)), 'Ember ribbon'), layer: { mode: 'plane', target: 'abc', pointer: false, scroll: false } };
		const file = gradientPresetDoc(scene, 'My Lovely Gradient!');
		expect(file).toMatchObject({ format: 1, domain: 'background', name: 'My Lovely Gradient!', preset: 'my-lovely-gradient', layer: { pointer: false, scroll: false } });
		// the scene's own placement (mode, target) is not part of a preset
		expect(file.layer.mode).toBeUndefined();
		const back = normalizePresetDoc(JSON.parse(JSON.stringify(file)), file.preset);
		expect(back.ok).toBe(true);
		expect(gradientNodeOf(back.doc)?.data).toEqual(scene.nodes[0].data);
		expect(compileBackgroundGraphToIR(back.doc).ok).toBe(true);
	});
	it('preset keys are safe file stems', () => {
		expect(presetKeyFrom('  Ünïcode — Sunset #2 ')).toBe('unicode-sunset-2');
		expect(presetKeyFrom('***')).toBe('my-gradient');
	});
});

describe('65 gradient: the preset index family + needs', () => {
	const raw = {
		format: 1,
		presets: [
			{ key: 'mesh-gradient', label: 'Mesh gradient', file: 'mesh-gradient.json' },
			{ key: 'ember-ribbon', label: 'Ember ribbon', file: 'ember-ribbon.json', family: 'Gradient', needs: ['gradientLab'] },
			{ key: 'from-the-future', label: 'Future', needs: ['someNodeFromTomorrow'] },
			{ key: 'junk-needs', label: 'Junk', needs: ['../x', 3] }
		]
	};
	it('keeps the family and drops a row whose needs the catalog lacks', () => {
		const r = normalizePresetIndex(raw, (t) => !!shaderNodeDef(t));
		expect(r.presets.map((p) => p.key)).toEqual(['mesh-gradient', 'ember-ribbon', 'junk-needs']);
		expect(r.presets[1]).toMatchObject({ family: 'Gradient', needs: ['gradientLab'] });
		expect(r.presets[0]).toMatchObject({ family: '', needs: [] });
		// an invalid entry is no claim at all, so it cannot hide a row
		expect(r.presets[2].needs).toEqual([]);
	});
	it('counterfactual: a build without the lab node does not list the Gradient rows', () => {
		const r = normalizePresetIndex(raw, (t) => t !== GRADIENT_NODE && !!shaderNodeDef(t));
		expect(r.presets.map((p) => p.key)).toEqual(['mesh-gradient', 'junk-needs']);
	});
});
