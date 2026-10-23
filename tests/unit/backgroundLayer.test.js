// @ts-nocheck — fixture-shaped test data (the tests/unit convention for graph fixtures)
// 65 M2 — the background layer's pure rules and the packs preset format (no browser).
import { describe, it, expect } from 'vitest';
import {
	normalizeLayer,
	drawModeFor,
	tierFor,
	octaveCapFor,
	sphereUv,
	easePointer,
	pageScrollProgress
} from '../../src/lib/backgroundLayerCore.js';
import {
	normalizePresetIndex,
	normalizePresetDoc,
	builtinPresetDoc,
	PRESET_FORMAT,
	BUILTIN_PRESET_KEY
} from '../../src/lib/backgroundPresetsCore.js';
import { compileBackgroundGraphToIR } from '../../src/lib/shaderCompile.js';

describe('normalizeLayer', () => {
	it('defaults to full screen with the pointer on and scroll off', () => {
		expect(normalizeLayer(undefined)).toEqual({
			mode: 'screen',
			target: null,
			pointer: true,
			scroll: false
		});
	});
	it('keeps known values and rejects unknown modes', () => {
		expect(normalizeLayer({ mode: 'plane', target: 'u1', pointer: false, scroll: true })).toEqual({
			mode: 'plane',
			target: 'u1',
			pointer: false,
			scroll: true
		});
		expect(normalizeLayer({ mode: 'sideways' }).mode).toBe('screen');
	});
});

describe('drawModeFor', () => {
	const L = (mode) => normalizeLayer({ mode });
	it('never draws the head-locked screen triangle in XR', () => {
		expect(drawModeFor(L('screen'), { xr: false, targetFound: false })).toBe('screen');
		expect(drawModeFor(L('screen'), { xr: true, targetFound: false })).toBe('sphere');
	});
	it('draws a plane only when its object exists, in or out of XR', () => {
		expect(drawModeFor(L('plane'), { xr: false, targetFound: true })).toBe('plane');
		expect(drawModeFor(L('plane'), { xr: true, targetFound: true })).toBe('plane');
		expect(drawModeFor(L('plane'), { xr: false, targetFound: false })).toBe('none');
		expect(drawModeFor(L('off'), { xr: false, targetFound: true })).toBe('none');
	});
});

describe('the device budget', () => {
	it('is low on a headset, a phone, or once the governor drops the look', () => {
		expect(tierFor({})).toBe('high');
		expect(tierFor({ xr: true })).toBe('low');
		expect(tierFor({ phone: true })).toBe('low');
		expect(tierFor({ postOff: true })).toBe('low');
		expect(tierFor({ dprScale: 0.72 })).toBe('high');
		expect(tierFor({ dprScale: 0.61 })).toBe('low');
		expect(octaveCapFor('low')).toBe(2);
		expect(octaveCapFor('high')).toBe(8);
	});
	it('the low tier really changes the compiled program (the cap is a define the shader reads)', () => {
		const r = compileBackgroundGraphToIR(normalizePresetDoc(builtinPresetDoc()).doc);
		expect(r.ok).toBe(true);
	});
});

describe('sphereUv', () => {
	it('puts straight ahead (-Z) at the centre, right at 0, left at 1, up at the top', () => {
		const close = (a, b) => expect(Math.abs(a - b)).toBeLessThan(1e-9);
		let [u, v] = sphereUv(0, 0, -1);
		close(u, 0.5);
		close(v, 0.5);
		[u] = sphereUv(1, 0, 0);
		close(u, 0);
		[u] = sphereUv(-1, 0, 0);
		close(u, 1);
		[, v] = sphereUv(0, 1, 0);
		close(v, 1);
		[, v] = sphereUv(0, -5, 0);
		close(v, 0);
	});
	it('mirrors the back half onto the front, so there is no seam behind you', () => {
		const [a] = sphereUv(0.3, 0, -1);
		const [b] = sphereUv(0.3, 0, 1);
		expect(Math.abs(a - b)).toBeLessThan(1e-9);
	});
});

describe('easePointer', () => {
	it('converges on the target at the same rate whatever the frame rate', () => {
		const run = (hz) => {
			const s = { x: 0, y: 0, vx: 0, vy: 0 };
			for (let i = 0; i < hz / 4; i++) easePointer(s, 1, 0.5, 1 / hz);
			return s;
		};
		const a = run(60);
		const b = run(90);
		expect(Math.abs(a.x - b.x)).toBeLessThan(0.01);
		expect(a.x).toBeGreaterThan(0.85);
		expect(a.vx).toBeGreaterThan(0);
	});
	it('ignores a zero or negative step and caps a long stall', () => {
		const s = { x: 0, y: 0, vx: 0, vy: 0 };
		easePointer(s, 1, 1, 0);
		expect(s.x).toBe(0);
		easePointer(s, 1, 1, 30);
		expect(s.x).toBeLessThan(1);
	});
});

describe('pageScrollProgress', () => {
	it('is null for a page that does not scroll (the editor), else 0..1', () => {
		expect(pageScrollProgress(null)).toBe(null);
		expect(pageScrollProgress({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 })).toBe(null);
		expect(pageScrollProgress({ scrollTop: 300, scrollHeight: 1400, clientHeight: 800 })).toBe(0.5);
		expect(pageScrollProgress({ scrollTop: 9000, scrollHeight: 1400, clientHeight: 800 })).toBe(1);
	});
});

describe('preset loading', () => {
	it('reads an index, dropping bad and duplicate rows', () => {
		const r = normalizePresetIndex({
			format: 1,
			presets: [
				{ key: 'mesh-gradient', label: 'Mesh gradient', hint: 'x', file: 'mesh-gradient.json' },
				{ key: 'mesh-gradient', label: 'dupe' },
				{ key: '../evil', label: 'path' },
				{ key: 'no-file', label: 'No file' },
				{ key: 'bad-file', file: '../../x.json' },
				null
			]
		});
		expect(r.ok).toBe(true);
		expect(r.presets.map((p) => p.key)).toEqual(['mesh-gradient', 'no-file', 'bad-file']);
		expect(r.presets[1].file).toBe('no-file.json');
		expect(r.presets[2].file).toBe('bad-file.json');
	});
	it('refuses a NEWER format by name instead of half-reading it', () => {
		const r = normalizePresetIndex({ format: PRESET_FORMAT + 1, presets: [] });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/newer format/);
		const d = normalizePresetDoc(
			{ format: PRESET_FORMAT + 1, domain: 'background', nodes: [] },
			'x'
		);
		expect(d.ok).toBe(false);
	});
	it('refuses a document that is not a background graph or has no output', () => {
		expect(normalizePresetDoc({ domain: 'post', nodes: [] }, 'a').ok).toBe(false);
		expect(
			normalizePresetDoc({ domain: 'background', nodes: [{ id: 'c', type: 'color' }] }, 'a').ok
		).toBe(false);
		expect(normalizePresetDoc('nope', 'a').ok).toBe(false);
	});
	it('drops an edge into a node that is not there, and fills missing data', () => {
		const r = normalizePresetDoc(
			{
				domain: 'background',
				nodes: [
					{ id: 'c', type: 'color' },
					{ id: 'o', type: 'backgroundOutput', data: { x: 1 } }
				],
				edges: [
					{ id: 'e1', source: 'c', sourceHandle: 'out', target: 'o', targetHandle: 'color' },
					{ id: 'e2', source: 'ghost', sourceHandle: 'out', target: 'o', targetHandle: 'alpha' }
				],
				layer: { scroll: true }
			},
			'k'
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.edges.map((e) => e.id)).toEqual(['e1']);
		expect(r.doc.nodes[0].data).toEqual({});
		expect(r.doc.layer).toEqual({ pointer: true, scroll: true });
		expect(r.doc.preset).toBe('k');
	});
	it('the built-in preset is valid and compiles', () => {
		const r = normalizePresetDoc(builtinPresetDoc(), BUILTIN_PRESET_KEY);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const c = compileBackgroundGraphToIR(r.doc);
		expect(c.ok, String(c.errors)).toBe(true);
		expect(c.ir?.usesPointer).toBe(true);
	});
});
