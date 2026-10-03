import { describe, it, expect } from 'vitest';
import {
	BUDGET,
	costOf,
	SERIES,
	SCENE_GROUP,
	EDITOR_GROUP,
	isEditorRow,
	spanOf,
	frameIndexAt,
	framesIn,
	bucketize,
	scaleOf,
	rangeStats,
	cpuPhases,
	capturesFor,
	mergeCaptures,
	placeOfRow,
	buildTree,
	sortTree,
	rankings,
	delta,
	compareDocs,
	fmtCount,
	fmtMs
} from '../../src/lib/perf/profilerModel.js';
import { validateTpprof } from '../../src/lib/perf/tpprof.js';

// 34 PF — the Profiler tab's maths. Pure over T1 documents, so every rule the panel shows is
// proven here without a browser: the tree's grouping and sums, the rankings, range selection,
// capture merging and the comparison of two recordings.

/** @param {number} n @param {(i: number) => Partial<import('../../src/lib/perf/tpprof.js').TpFrame>} [over] */
function frames(n, over = () => ({})) {
	const out = [];
	let t = 0;
	for (let i = 0; i < n; i++) {
		const f = { ms: 16.7, calls: 100, tris: 50000, quality: 0, ...over(i) };
		t += f.ms;
		out.push({ t: Math.round(t * 10) / 10, ...f });
	}
	return out;
}

/** a detailed-looking capture: one heavy object, two light ones, a child mesh, a module group, shadows */
function capture(t = 500, scale = 1) {
	return {
		t,
		frames: 3,
		objects: [
			{ uuid: 'heavy', name: 'Heavy', path: 'Scene/Heavy', module: null, calls: 1, tris: 60000 * scale, material: 'MeshStandardMaterial', shadow: false, ms: 0.4 },
			{ uuid: 'heavy', name: 'Heavy', path: 'Scene/Heavy', module: null, calls: 1, tris: 60000 * scale, material: 'MeshDepthMaterial', shadow: true },
			{ uuid: 'boxA', name: 'Box A', path: 'Scene/Box A', module: null, calls: 1, tris: 12, material: 'Red', shadow: false, ms: 0.02 },
			{ uuid: 'wheel', name: 'Wheel', path: 'Scene/Car/Wheel', module: null, calls: 2, tris: 400, material: 'Rubber+Chrome', shadow: false, ms: 0.05 },
			{ uuid: 'body', name: 'Body', path: 'Scene/Car/Body', module: null, calls: 1, tris: 900, material: 'Paint', shadow: false, ms: 0.04 },
			{ uuid: 'glass', name: 'Glass', path: 'Scene/Car/Glass', module: null, calls: 1, tris: 300, material: 'Glass', shadow: false, transparent: true, ms: 0.01 },
			{ uuid: 'ball', name: 'Ball', path: 'football-module/Ball', module: 'football', calls: 3, tris: 2000, material: 'Leather', shadow: false, ms: 0.1 },
			{ uuid: 'grid', name: 'editor-grid', path: 'editor-grid', module: null, calls: 1, tris: 2, material: 'LineBasicMaterial', shadow: false, ms: 0 },
			...['X', 'Y', 'Z', 'XY', 'YZ', 'XZ', 'XYZ'].map((a) => ({ uuid: 'g' + a, name: a, path: 'Object3D/TransformControlsGizmo/Object3D/' + a, module: null, calls: 3, tris: 72, material: 'MeshBasicMaterial', shadow: false, ms: 0.01 })),
			{ uuid: 'lh', name: 'DirectionalLightHelper', path: 'DirectionalLightHelper/Line', module: null, calls: 1, tris: 0, material: 'LineBasicMaterial', shadow: false }
		]
	};
}

function doc(extra = {}) {
	return {
		tpprof: 1,
		meta: { build: 'abc', version: '1.20.0', modules: {}, device: 'test', xr: false, startedAt: 1_800_000_000_000, mode: 'detailed', scene: 'Test scene' },
		frames: frames(60, (i) => ({ cpu: { input: 0.1, physics: 0.5, modules: 0.2, flow: 0.3, render: 4 + (i % 2), other: 1 } })),
		events: [{ t: 100, kind: 'mark', detail: { text: 'go' } }, { t: 600, kind: 'stall', detail: { ms: 140 } }],
		captures: [capture(300), capture(700)],
		...extra
	};
}

describe('timeline series and buckets', () => {
	it('draws the Quest budget: 150 calls and 13.9 ms (72 fps)', () => {
		expect(BUDGET).toEqual({ calls: 150, tris: 300000, ms: 13.9, fps: 72 });
		expect(costOf({ calls: 1, tris: 0 })).toBeCloseTo(costOf({ calls: 0, tris: 2000 }), 9);
		expect(SERIES.map((s) => s.key)).toEqual(['fps', 'ms', 'calls', 'tris', 'quality']);
		expect(SERIES.find((s) => s.key === 'calls')?.budget).toBe(150);
		expect(SERIES.find((s) => s.key === 'fps')?.of({ t: 0, ms: 10 })).toBe(100);
		expect(SERIES.find((s) => s.key === 'calls')?.of({ t: 0, ms: 10, calls: null })).toBeNull();
	});

	it('spans a recording from its first frame start to its last frame (and its events)', () => {
		const f = frames(10);
		expect(spanOf({ frames: f, events: [] })).toEqual({ from: 0, to: f[9].t });
		expect(spanOf({ frames: f, events: [{ t: 999, kind: 'mark' }] }).to).toBe(999);
		expect(spanOf({ frames: [], events: [] })).toEqual({ from: 0, to: 1 });
	});

	it('finds the frame under a time and the frames of a range; a click is never empty', () => {
		const f = frames(10, () => ({ ms: 10 }));
		expect(frameIndexAt(f, 0)).toBe(0);
		expect(frameIndexAt(f, 25)).toBe(2); // frame 2 covers (20, 30]
		expect(frameIndexAt(f, 30)).toBe(2);
		expect(frameIndexAt(f, 10_000)).toBe(9);
		expect(framesIn(f, 21, 40).map((x) => x.t)).toEqual([30, 40]);
		expect(framesIn(f, 40, 21).map((x) => x.t)).toEqual([30, 40]);
		expect(framesIn(f, 25, 25).length).toBe(1);
		// one frame's own span is that frame, not also the one ending where it starts
		expect(framesIn(f, 20, 30).map((x) => x.t)).toEqual([30]);
		// rounding: t and ms are rounded separately, so a span may start 0.1 ms early
		expect(framesIn(f, 19.9, 30).map((x) => x.t)).toEqual([30]);
		expect(framesIn([], 0, 10)).toEqual([]);
	});

	it('keeps every spike when 72 000 frames are bucketed into 400 columns', () => {
		const f = frames(72000, (i) => ({ ms: i === 51234 ? 250 : 13.9 }));
		const span = spanOf({ frames: f, events: [] });
		const b = bucketize(f, span.from, span.to, 400, (x) => x.ms);
		let peak = 0;
		for (let c = 0; c < 400; c++) if (b.has[c] && b.max[c] > peak) peak = b.max[c];
		expect(peak).toBe(250);
		expect(Math.min(...Array.from(b.min).filter((_, c) => b.has[c]))).toBeCloseTo(13.9, 4);
		// a null value (no calls) leaves its column empty rather than drawing a 0
		const holes = bucketize(frames(10, () => ({ calls: null })), 0, 200, 10, (x) => x.calls ?? null);
		expect(Array.from(holes.has).every((h) => h === 0)).toBe(true);
	});

	it('scales a series to a round number above both its max and its budget line', () => {
		const f = frames(5, () => ({ calls: 80 }));
		expect(scaleOf(f, (x) => x.calls, 150)).toBeGreaterThanOrEqual(150 * 1.15);
		expect(scaleOf(frames(5, () => ({ calls: 420 })), (x) => x.calls, 150)).toBe(500);
		expect(scaleOf([], (x) => x.calls, null)).toBe(1);
		// one outlier (a 2.5 ms frame = 400 fps) does not flatten the lane
		const spiky = frames(300, (i) => ({ ms: i === 7 ? 2.5 : 16.7 }));
		expect(scaleOf(spiky, (x) => 1000 / x.ms, 72)).toBeLessThan(150);
	});
});

describe('a frame or a range', () => {
	it('summarises the selection and its CPU phases', () => {
		const d = doc();
		const s = rangeStats(d, 0, d.frames[29].t);
		expect(s.frames).toBe(30);
		expect(s.cpu?.frames).toBe(30);
		const render = s.cpu?.phases.find((p) => p.phase === 'render');
		expect(render?.mean).toBeCloseTo(4.5, 3);
		expect(render?.max).toBe(5);
		expect(s.cpu?.phases.map((p) => p.phase)).toEqual(['input', 'physics', 'modules', 'flow', 'render', 'other']);
		const shares = (s.cpu?.phases ?? []).reduce((n, p) => n + p.share, 0);
		expect(shares).toBeCloseTo(1, 2);
		expect(s.events.map((e) => e.kind)).toEqual(['mark']);
	});

	it('a light recording has no CPU phases (null, not zeros)', () => {
		expect(cpuPhases(frames(10))).toBeNull();
	});

	it('keeps an unknown phase a newer build wrote', () => {
		const c = cpuPhases([{ t: 1, ms: 10, cpu: { render: 2, audio: 1 } }]);
		expect(c?.phases.map((p) => p.phase)).toContain('audio');
	});
});

describe('captures behind a selection', () => {
	it('takes the captures inside a range, else the nearest one with its distance', () => {
		const d = doc();
		expect(capturesFor(d, 0, 1000).captures.length).toBe(2);
		const near = capturesFor(d, 650, 660);
		expect(near.nearest).toBe(true);
		expect(near.captures[0].t).toBe(700);
		expect(near.distance).toBe(45);
		expect(capturesFor({ ...d, captures: undefined }, 0, 10).captures).toEqual([]);
	});

	it('merges captures into per-row means, an absent row counting as zero', () => {
		const a = capture(100, 1);
		const b = capture(200, 2);
		b.objects = b.objects.filter((o) => o.uuid !== 'boxA');
		const m = mergeCaptures([a, b]);
		const heavy = m.find((o) => o.uuid === 'heavy' && !o.shadow);
		expect(heavy?.tris).toBe(90000);
		expect(m.find((o) => o.uuid === 'heavy' && o.shadow)?.ms).toBeUndefined();
		expect(m.find((o) => o.uuid === 'boxA')?.calls).toBe(0.5);
		expect(mergeCaptures([])).toEqual([]);
	});
});

describe('the tree: scene → module/game → object → mesh/material', () => {
	it('places a row by owner and top-level object', () => {
		expect(placeOfRow({ uuid: 'x', path: 'Scene/Car/Wheel', calls: 1, tris: 1 })).toEqual({ group: SCENE_GROUP, object: 'Car', scene: true, depth: 2, editor: false });
		expect(placeOfRow({ uuid: 'x', path: 'football-module/Ball', module: 'football', calls: 1, tris: 1 }).group).toBe('football');
		expect(placeOfRow({ uuid: 'x', path: 'editor-grid', calls: 1, tris: 1 }).group).toBe(EDITOR_GROUP);
		expect(placeOfRow({ uuid: 'x', path: 'Object3D/TransformControlsGizmo/Object3D/X', calls: 3, tris: 72 })).toMatchObject({ group: EDITOR_GROUP, object: 'TransformControlsGizmo', editor: true });
		expect(placeOfRow({ uuid: 'x', path: 'sky-dome', helper: true, calls: 1, tris: 1 }).group).toBe(EDITOR_GROUP);
		// a module's content and the scene's own objects are never the editor's, whatever their names
		expect(placeOfRow({ uuid: 'x', path: 'Scene/Light helper prop', calls: 1, tris: 1 }).group).toBe(SCENE_GROUP);
		expect(placeOfRow({ uuid: 'x', path: 'mod/AxesHelper', module: 'mod', calls: 1, tris: 1 }).group).toBe('mod');
		expect(placeOfRow({ uuid: 'x', path: 'env-rig/Sun', calls: 1, tris: 1 }).group).toBe('env-rig');
	});

	it('every level sums what is under it, and the heaviest object comes first', () => {
		const t = buildTree(capture().objects, { scene: 'Test scene' });
		expect(t.label).toBe('Test scene');
		expect(t.calls).toBe(11 + 21 + 1);
		expect(t.tris).toBe(60000 * 2 + 12 + 400 + 900 + 300 + 2000 + 2 + 7 * 72);
		const scene = t.children.find((g) => g.label === SCENE_GROUP);
		expect(scene?.children[0].label).toBe('Heavy');
		expect(scene?.children[0].calls).toBe(2);
		expect(scene?.children[0].shadowCalls).toBe(1);
		expect(scene?.children[0].uuid).toBe('heavy');
		expect(scene?.children[0].top).toBe(true);
		const car = scene?.children.find((o) => o.label === 'Car');
		expect(car?.calls).toBe(4);
		expect(car?.children.length).toBe(3);
		expect(car?.top).toBe(false); // the mesh rows are children; selecting reaches Car through any of them
		expect(t.children.find((g) => g.label === 'football')?.calls).toBe(3);
		// the groups sort by cost too: Scene objects (8 calls) before football (3) — and the editor's
		// own drawing (the gizmo: 23 calls, more than either) LAST, because it does not ship
		expect(t.children[0].label).toBe(SCENE_GROUP);
		const ed = t.children[t.children.length - 1];
		expect(ed.label).toBe(EDITOR_GROUP);
		expect(ed.calls).toBe(23);
		expect(ed.editor).toBe(true);
	});

	it('re-sorts every level by the chosen column', () => {
		const t = sortTree(buildTree(capture().objects), 'name');
		const scene = t.children.find((g) => g.label === SCENE_GROUP);
		expect(scene?.children.map((o) => o.label)).toEqual(['Box A', 'Car', 'Heavy']);
		sortTree(t, 'ms');
		expect(t.children.find((g) => g.label === SCENE_GROUP)?.children[0].label).toBe('Heavy');
	});

	it('the planted heavy object is first even when every object costs one draw call', () => {
		const rows = ['Light A', 'Heavy', 'Light B'].map((name, i) => ({ uuid: 'u' + i, name, path: 'Scene/' + name, calls: 1, tris: name === 'Heavy' ? 60000 : 12, material: 'M', shadow: false, ms: 0.01 }));
		const t = buildTree(rows);
		expect(t.children[0].children[0].label).toBe('Heavy');
	});
});

describe('who draws most', () => {
	it('ranks objects, materials, shadow casters and transparent overdraw', () => {
		const r = rankings(capture().objects);
		expect(r.objects[0].label).toBe('Heavy'); // 2 calls + 120k triangles outweigh the car's 4 cheap draws
		expect(r.objects[1].label).toBe('Car');
		expect(r.materials[0].label).toBe('MeshStandardMaterial'); // the heavy mesh's material
		expect(r.materials.find((m) => m.label === 'MeshDepthMaterial')).toBeUndefined(); // shadow passes are not materials
		expect(r.shadows.map((s) => s.label)).toEqual(['Heavy']);
		expect(r.transparent.map((s) => s.label)).toEqual(['Glass']);
		expect(r.totals.shadowCalls).toBe(1);
		expect(r.totals.calls).toBe(10); // the editor's 23 calls are not in the rankings...
		expect(r.totals.editorCalls).toBe(23); // ...they are counted on their own
		expect(r.objects.some((o) => o.label === 'TransformControlsGizmo')).toBe(false);
		expect(isEditorRow({ uuid: 'x', path: 'editor-grid', calls: 1, tris: 1 })).toBe(true);
		expect(rankings(capture().objects, 2).objects.length).toBe(2);
	});
});

describe('comparing two recordings', () => {
	it('names the direction of each change and treats < 2 % as the same', () => {
		expect(delta(100, 150).verdict).toBe('worse');
		expect(delta(100, 150, true).verdict).toBe('better');
		expect(delta(100, 101).verdict).toBe('same');
		expect(delta(null, 5).verdict).toBeNull();
		expect(delta(0, 5).pct).toBeNull();
		expect(delta(80, 60).delta).toBe(-20);
	});

	it('per object and per owner when both are detailed; objects match by owner + name', () => {
		const a = doc();
		const b = doc({ captures: [capture(300, 0.5), capture(700, 0.5)] });
		b.captures.forEach((c) => c.objects.push({ uuid: 'new', name: 'Tree', path: 'Scene/Tree', module: null, calls: 4, tris: 8000, material: 'Leaf', shadow: false, ms: 0.2 }));
		b.frames = frames(60, (i) => ({ calls: 140, ms: 20, cpu: { render: 9 + (i % 2), other: 1 } }));
		const c = compareDocs(a, b);
		expect(c.detailed).toBe(true);
		const heavy = c.objects.find((o) => o.label === 'Heavy');
		expect(heavy?.tris.delta).toBe(-60000);
		expect(heavy?.status).toBe('both');
		expect(c.objects.find((o) => o.label === 'Tree')?.status).toBe('added');
		expect(c.objects[0].label).toBe('Tree'); // the biggest change in calls first
		expect(c.groups.find((g) => g.label === SCENE_GROUP)?.calls.delta).toBe(4);
		expect(c.summary.find((s) => s.key === 'callsP50')?.verdict).toBe('worse');
		expect(c.summary.find((s) => s.key === 'fpsP50')?.verdict).toBe('worse');
		expect(c.cpu?.find((p) => p.phase === 'render')?.delta).toBeCloseTo(5, 3);
	});

	it('two light recordings compare their summaries only', () => {
		const light = { ...doc(), captures: undefined, frames: frames(30) };
		const c = compareDocs(light, light);
		expect(c.detailed).toBe(false);
		expect(c.objects).toEqual([]);
		expect(c.cpu).toBeNull();
		expect(c.summary.every((s) => s.verdict === 'same' || s.verdict === null)).toBe(true);
	});

	it('the fixture is a valid T1 document (the model reads what the recorder writes)', () => {
		expect(validateTpprof(doc()).ok).toBe(true);
	});
});

describe('formatting', () => {
	it('shortens counts and keeps ms precision sensible', () => {
		expect(fmtCount(1234567)).toBe('1.2M');
		expect(fmtCount(12345)).toBe('12.3k');
		expect(fmtCount(150)).toBe('150');
		expect(fmtCount(0.5)).toBe('0.5');
		expect(fmtCount(null)).toBe('–');
		expect(fmtMs(13.94)).toBe('13.9 ms');
		expect(fmtMs(0.0123)).toBe('0.012 ms');
		expect(fmtMs(250.4)).toBe('250 ms');
	});
});
