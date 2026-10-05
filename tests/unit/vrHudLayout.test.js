// @ts-nocheck — a fixture-driven test (the checkJs rule for tests/unit: JSDoc or this)
// 36 B12 — the VR HUD's layout maths, against the playing HUD of EVERY shipped game
// (fixtures/vrHudLayouts.json, dumped from the scenes feed).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
	STAGE_W,
	STAGE_H,
	HUD_SIZES,
	stageRect,
	hudItems,
	scaleAbout,
	overlaps,
	insideStage,
	scaleClusters,
	clusterAnchor,
	clusterRects,
	degPerPx,
	stageAngles,
	texelScale,
	packShelves,
	bandGeometry,
	followState,
	followHead,
	anchorWorld,
	pickRadius,
	easeRadius,
	vrActionHints,
	coercePlacement,
	coerceSize,
	wrapAngle
} from '../../src/lib/vrHudLayout.js';
import { rectInFrame } from '../../src/lib/hudDocs.js';

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vrHudLayouts.json'), 'utf8')).games;
const GAMES = Object.keys(FIX);
const DEG = Math.PI / 180;

describe('the stage', () => {
	it('places every anchor the way hudDocs does', () => {
		for (const anchor of ['top-left', 'top-center', 'top-right', 'center', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'])
			for (const [x, y] of [
				[0, 0],
				[24, 30],
				[-40, 12]
			]) {
				const el = { anchor, x, y, w: 200, h: 40 };
				expect(stageRect(el)).toEqual(rectInFrame(el, STAGE_W, STAGE_H));
			}
	});
	it('drops kinds with no headset form and empty boxes', () => {
		const items = hudItems([
			{ id: 'a', kind: 'text', anchor: 'top-left', x: 0, y: 0, w: 10, h: 10 },
			{ id: 'c', kind: 'crosshair', anchor: 'center', x: 0, y: 0, w: 24, h: 24 },
			{ id: 'z', kind: 'text', anchor: 'center', x: 0, y: 0, w: 0, h: 10 },
			{ id: 'u', kind: 'mystery', anchor: 'center', x: 0, y: 0, w: 10, h: 10 }
		], (k) => k !== 'mystery');
		expect(items.map((i) => i.id)).toEqual(['a']);
	});
});

describe('anchored scale-up', () => {
	it('keeps the anchor point fixed', () => {
		const r = { left: 100, top: 50, w: 200, h: 40 };
		expect(scaleAbout(r, 'left', 'top', 1.5)).toEqual({ left: 100, top: 50, w: 300, h: 60 });
		const br = scaleAbout(r, 'right', 'bottom', 1.5);
		expect(br.left + br.w).toBe(300);
		expect(br.top + br.h).toBe(90);
		const c = scaleAbout(r, 'center', 'middle', 2);
		expect(c.left + c.w / 2).toBe(200);
		expect(c.top + c.h / 2).toBe(70);
	});
	it('scales each group as far as its neighbours allow (and the counterfactual is real)', () => {
		const items = hudItems([
			{ id: 'a', kind: 'text', anchor: 'top-left', x: 16, y: 16, w: 300, h: 30 },
			{ id: 'b', kind: 'text', anchor: 'top-center', x: 0, y: 16, w: 300, h: 30 },
			{ id: 'c', kind: 'text', anchor: 'bottom-right', x: 16, y: 16, w: 200, h: 30 }
		]);
		const { rects, clusters } = scaleClusters(items, 1.6);
		expect(clusters.length).toBe(3);
		const fa = clusters.find((c) => c.members.includes(0)).f;
		const fc = clusters.find((c) => c.members.includes(2)).f;
		expect(fa).toBeGreaterThan(1);
		expect(fa).toBeLessThan(1.6); // the title beside it holds it back
		expect(fc).toBe(1.6); // the lone corner group is free
		for (let i = 0; i < clusters.length; i++)
			for (let j = i + 1; j < clusters.length; j++) expect(overlaps(clusters[i].rect, clusters[j].rect, 0)).toBe(false);
		// what the guard prevented: both top groups at the maximum collide
		const top = clusters.filter((c) => !c.members.includes(2));
		const at16 = top.map((c) => {
			const an = clusterAnchor(c.rect, c.members.map((m) => items[m]));
			const raw = { left: c.rect.left, top: c.rect.top, w: c.rect.w / c.f, h: c.rect.h / c.f };
			if (an.h === 'center') raw.left = c.rect.left + (c.rect.w - raw.w) / 2;
			return scaleAbout(raw, an.h, an.v, 1.6);
		});
		expect(overlaps(at16[0], at16[1], 0)).toBe(true);
		// members keep their order and grow with their group, from its anchor
		expect(rects[0].left).toBeCloseTo(8 + (16 - 8) * fa, 5); // the group's anchor is its padded corner (16 - pad 8)
		expect(rects[0].w).toBeCloseTo(300 * fa);
	});
	it('never grows a group past the stage edge', () => {
		const items = hudItems([{ id: 'w', kind: 'text', anchor: 'center', x: 0, y: 0, w: 1100, h: 40 }]);
		const { clusters } = scaleClusters(items, 1.6);
		expect(insideStage(clusters[0].rect)).toBe(true);
		expect(clusters[0].f).toBeLessThan(1.17);
	});
	it('a group under its own panel needs no plate; bare text gets one', () => {
		const { clusters } = scaleClusters(
			hudItems([
				{ id: 'p', kind: 'panel', anchor: 'top-left', x: 16, y: 16, w: 300, h: 100 },
				{ id: 't', kind: 'text', anchor: 'top-left', x: 30, y: 30, w: 200, h: 30 },
				{ id: 'h', kind: 'text', anchor: 'bottom-center', x: 0, y: 12, w: 500, h: 20 }
			])
		);
		expect(clusters.map((c) => c.plate)).toEqual([false, true]);
	});
});

describe('every shipped game HUD', () => {
	for (const game of GAMES) {
		it(game + ': scaled up with no new overlap, inside the band, readable', () => {
			const items = hudItems(FIX[game]);
			expect(items.length).toBeGreaterThan(0);
			const { rects, clusters } = scaleClusters(items);
			for (let i = 0; i < items.length; i++) {
				if (insideStage(items[i].rect)) expect(insideStage(rects[i])).toBe(true);
				for (let j = i + 1; j < items.length; j++)
					if (!overlaps(items[i].rect, items[j].rect)) expect(overlaps(rects[i], rects[j])).toBe(false);
			}
			for (const c of clusters) expect(c.f).toBeGreaterThanOrEqual(1);
			// the smallest authored font, in degrees on a medium band: never under ~0.45 deg (11 px on a Quest 3)
			const s = degPerPx(HUD_SIZES.medium);
			for (const c of clusters)
				for (const m of c.members) {
					const size = FIX[game].find((e) => e.id === items[m].id)?.style?.size;
					if (size) expect(size * s * c.f).toBeGreaterThan(0.4);
				}
			// a handful of quads, all on one geometry, none overlapping
			expect(clusters.length).toBeGreaterThan(0);
			expect(clusters.length).toBeLessThanOrEqual(10);
			for (let i = 0; i < clusters.length; i++)
				for (let j = i + 1; j < clusters.length; j++) expect(overlaps(clusters[i].rect, clusters[j].rect, 0)).toBe(false);
			// every member sits inside its group's quad
			for (const c of clusters)
				for (const m of c.members) {
					const r = rects[m];
					expect(r.left >= c.rect.left - 0.01 && r.top >= c.rect.top - 0.01 && r.left + r.w <= c.rect.left + c.rect.w + 0.01 && r.top + r.h <= c.rect.top + c.rect.h + 0.01).toBe(true);
				}
		});
	}
});

describe('the band', () => {
	it('maps the stage linearly: centre straight ahead (less the rest pitch), corners at ±halfWidth', () => {
		const c = stageAngles(STAGE_W / 2, STAGE_H / 2, 30, 0);
		expect(c.yaw).toBeCloseTo(0);
		expect(c.pitch).toBeCloseTo(0);
		const tl = stageAngles(0, 0, 30, 0);
		expect(tl.yaw / DEG).toBeCloseTo(-30);
		expect(tl.pitch / DEG).toBeCloseTo((30 * STAGE_H) / STAGE_W);
	});
	it('builds strips on a unit cylinder, counter-clockwise from inside, uvs in range', () => {
		const g = bandGeometry(
			[
				{ rect: { left: 0, top: 0, w: 640, h: 100 }, uv: { u0: 0, v0: 0.5, u1: 1, v1: 1 } },
				{ rect: { left: 1000, top: 600, w: 200, h: 50 }, uv: { u0: 0, v0: 0, u1: 0.5, v1: 0.5 } }
			],
			30
		);
		expect(g.positions.length % 3).toBe(0);
		for (let i = 0; i < g.positions.length; i += 3) expect(Math.hypot(g.positions[i], g.positions[i + 2])).toBeCloseTo(1, 6);
		for (const u of g.uvs) expect(u >= 0 && u <= 1).toBe(true);
		const count = g.positions.length / 3;
		for (const i of g.indices) expect(i < count).toBe(true);
		// the first triangle faces the eye at the origin
		const p = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]];
		const [a, b, c] = [p(g.indices[0]), p(g.indices[1]), p(g.indices[2])];
		const ab = a.map((v, i) => b[i] - v);
		const ac = a.map((v, i) => c[i] - v);
		const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
		expect(n[0] * -a[0] + n[1] * -a[1] + n[2] * -a[2]).toBeGreaterThan(0);
		// 640 px on a 30-degree band = 30 degrees = ceil(30/4) columns
		expect(count).toBe((8 + 1) * 2 + (Math.ceil((200 * degPerPx(30)) / 4) + 1) * 2);
	});
	it('sizes the canvas so a texel never covers more than a headset pixel', () => {
		for (const half of Object.values(HUD_SIZES))
			for (const f of [1, 1.3, 1.6]) {
				const s = degPerPx(half) * f;
				const k = texelScale(s);
				expect(k / s).toBeGreaterThanOrEqual(25 - 1e-9); // canvas px per degree >= headset px per degree
			}
		expect(texelScale(0.001)).toBe(1);
		expect(texelScale(1)).toBe(3);
	});
	it('packs atlas boxes without overlap inside the width', () => {
		const sizes = [
			{ w: 300, h: 40 },
			{ w: 500, h: 120 },
			{ w: 200, h: 60 },
			{ w: 900, h: 30 }
		];
		const { slots, w, h } = packShelves(sizes, 1024);
		expect(w).toBeLessThanOrEqual(1024);
		const rects = sizes.map((s, i) => ({ left: slots[i].x, top: slots[i].y, w: s.w, h: s.h }));
		for (const r of rects) expect(r.left + r.w <= w && r.top + r.h <= h).toBe(true);
		for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j], 0)).toBe(false);
	});
});

describe('comfort', () => {
	const head = (yawDeg, x = 0, pitchDeg = 0) => ({ x, y: 1.6, z: 0, yaw: yawDeg * DEG, pitch: pitchDeg * DEG });
	it('a tremor inside the dead zone moves nothing (no jitter)', () => {
		const st = followHead(followState(), head(0), 1 / 72);
		const start = { ...st };
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
		for (let i = 0; i < 720; i++) followHead(st, { x: rnd() * 0.01, y: 1.6 + rnd() * 0.01, z: rnd() * 0.01, yaw: rnd() * DEG, pitch: rnd() * DEG }, 1 / 72);
		expect(st.yaw).toBe(start.yaw);
		expect(st.pitch).toBe(start.pitch);
		expect(st.x).toBe(start.x);
		expect(st.y).toBe(start.y);
	});
	it('a turn brings it along with lag, and it settles inside the dead zone', () => {
		const st = followHead(followState(), head(0), 1 / 72);
		followHead(st, head(30), 1 / 72);
		expect(st.yaw / DEG).toBeGreaterThan(0);
		expect(st.yaw / DEG).toBeLessThan(5); // lags: one frame does not snap it
		for (let i = 0; i < 72; i++) followHead(st, head(30), 1 / 72);
		expect(Math.abs(30 - st.yaw / DEG)).toBeLessThanOrEqual(1.75); // the dead-zone edge, plus what is left of the ease after 1 s
	});
	it('follows through the ±180 wrap the short way', () => {
		const st = followHead(followState(), head(175), 1 / 72);
		for (let i = 0; i < 144; i++) followHead(st, head(-175), 1 / 72);
		expect(Math.abs(wrapAngle(st.yaw - -175 * DEG)) / DEG).toBeLessThanOrEqual(1.6);
	});
	it('the world anchor ignores a glance and re-centres after a real turn', () => {
		const st = anchorWorld(followState(), head(0), 1 / 72);
		for (let i = 0; i < 144; i++) anchorWorld(st, head(35), 1 / 72);
		expect(st.yaw).toBe(0);
		for (let i = 0; i < 288; i++) anchorWorld(st, head(80), 1 / 72);
		expect(Math.abs(80 - st.yaw / DEG)).toBeLessThan(2);
		expect(st.moving).toBe(false);
	});
	it('is pulled in front of a nearer surface, never past the minimum, and eases in fast / out slow', () => {
		expect(pickRadius([])).toBe(1.6);
		expect(pickRadius([Infinity, NaN, 9])).toBe(1.6);
		expect(pickRadius([1.2, 3])).toBeCloseTo(1.08);
		expect(pickRadius([0.2])).toBe(0.75);
		const inStep = easeRadius(1.6, 1.0, 1 / 72) - 1.6;
		const outStep = easeRadius(1.0, 1.6, 1 / 72) - 1.0;
		expect(-inStep).toBeGreaterThan(outStep * 4);
		expect(easeRadius(NaN, 1.2, 1 / 72)).toBe(1.2);
	});
});

describe('the game\'s input actions in the headset (U8)', () => {
	const controls = { jump: 'A', trigger: 'Trigger', grip: 'Grip', menu: 'X' };
	it('maps what a headset can press and drops what it cannot', () => {
		const hints = vrActionHints(
			[
				{ id: 'jump', label: 'Jump', keys: ['Space'] },
				{ id: 'fire', label: 'Fire', pointer: 'press' },
				{ id: 'interact', label: 'Use', pointer: 'tap' },
				{ id: 'grab', label: 'Grab', pointer: 'press' },
				{ id: 'crouch', label: 'Crouch', keys: ['KeyC'] },
				{ id: 'key:KeyF', label: 'F', keys: ['KeyF'] }
			],
			controls
		);
		expect(hints).toEqual([
			{ control: 'A', label: 'Jump' },
			{ control: 'Trigger', label: 'Fire' },
			{ control: 'Grip', label: 'Grab' },
			{ control: 'X', label: 'Menu' }
		]);
	});
	it('a game with no jump in the headset shows none, and no menu means no Menu', () => {
		expect(vrActionHints([{ id: 'jump', label: 'Jump' }], { ...controls, jump: null, menu: null })).toEqual([]);
	});
	it('coerces stored settings', () => {
		expect(coercePlacement('world')).toBe('world');
		expect(coercePlacement('nope')).toBe('head');
		expect(coerceSize('large')).toBe('large');
		expect(coerceSize(3)).toBe('medium');
	});
});
