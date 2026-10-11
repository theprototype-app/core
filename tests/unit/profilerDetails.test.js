// @ts-nocheck — plain fixtures; the module under test (src/lib/perf/profilerModel.js) is typed
import { describe, it, expect } from 'vitest';
import { selectionDetails, BUDGET } from '../../src/lib/perf/profilerModel.js';

// 41 G17 — the Profiler's Details sidebar reads `selectionDetails`: a frame, a range or the whole
// recording, and from the detailed captures the materials, the module costs and the picked object.

function frames(n, over = () => ({})) {
	const out = [];
	let t = 0;
	for (let i = 0; i < n; i++) {
		const f = { ms: 16, calls: 100, tris: 50000, quality: 0, ...over(i) };
		t += f.ms;
		out.push({ t, ...f });
	}
	return out;
}
const row = (uuid, path, extra = {}) => ({ uuid, name: path.split('/').pop(), path, module: null, calls: 1, tris: 100, material: 'Mat-' + uuid, shadow: false, ms: 0.1, ...extra });
function doc(opts = {}) {
	return {
		tpprof: 1,
		meta: { build: 'x', version: '1', modules: {}, device: 'test', xr: false, startedAt: 0, mode: opts.light ? 'light' : 'detailed' },
		frames: frames(10, (i) => (i === 4 ? { ms: 40, calls: 220, tris: 410000, gpu: 9, quality: 2, cpu: { scene: 3, render: 30 } } : { gpu: 5, cpu: { scene: 1, render: 10 } })),
		events: [{ t: 80, kind: 'stall' }],
		captures: opts.light
			? []
			: [
					{
						t: 80,
						objects: [
							row('heavy', 'Scene/Heavy', { tris: 60000, calls: 2 }),
							row('heavy', 'Scene/Heavy', { material: 'Depth', shadow: true }),
							row('wheel', 'Scene/Car/Wheel', { material: 'Rubber' }),
							row('body', 'Scene/Car/Body', { material: 'Paint' }),
							row('ball', 'football-module/Ball', { module: 'football', calls: 3 })
						]
					}
				]
	};
}

describe('selectionDetails', () => {
	it('with nothing selected it describes the whole recording', () => {
		const d = selectionDetails(doc(), null);
		expect(d.kind).toBe('recording');
		expect(d.frames).toBe(10);
		expect(d.ms.max).toBe(40);
		expect(d.calls).toMatchObject({ max: 220, budget: BUDGET.calls });
		expect(d.tris.max).toBe(410000);
		expect(d.stalls).toBe(1);
		expect(d.quality).toEqual({ min: 0, max: 2 });
		expect(d.gpu.max).toBe(9);
	});
	it('one frame is a FRAME, with its own numbers and its heaviest CPU phase first', () => {
		const d = selectionDetails(doc(), { from: 64, to: 104 }); // frame 4 ends at 104
		expect(d.kind).toBe('frame');
		expect(d.frames).toBe(1);
		expect(d.ms.p50).toBe(40);
		expect(d.calls.p50).toBe(220);
		expect(d.cpu[0]).toMatchObject({ phase: 'render' });
		expect(d.gpu).toEqual({ mean: 9, max: 9 });
	});
	it('a range counts its frames', () => {
		const d = selectionDetails(doc(), { from: 0, to: 64 });
		expect(d.kind).toBe('range');
		expect(d.frames).toBe(4);
		expect(d.ms.max).toBe(16);
	});
	it('from a detailed capture: materials, module costs and the picked object', () => {
		const d = selectionDetails(doc(), null, 'wheel');
		expect(d.detailed).toBe(true);
		expect(d.materials).toBe(4); // the shadow pass's depth material is not a drawn material
		const labels = d.modules.map((m) => m.label);
		expect(labels.some((l) => /football/i.test(l))).toBe(true);
		expect(d.modules.reduce((a, m) => a + m.share, 0)).toBeCloseTo(100, 0);
		expect(d.object).toMatchObject({ label: 'Car', meshes: 2, materials: 2, calls: 2 });
		expect(selectionDetails(doc(), null, 'heavy').object).toMatchObject({ label: 'Heavy', tris: 60100, shadowCalls: 1, materials: 1 });
	});
	it('a light recording has no per-object answers, and says so with nulls', () => {
		const d = selectionDetails(doc({ light: true }), null, 'wheel');
		expect(d.detailed).toBe(false);
		expect(d.materials).toBeNull();
		expect(d.modules).toEqual([]);
		expect(d.object).toBeNull();
	});
});
