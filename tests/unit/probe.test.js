// @ts-nocheck — plain three fixtures; the module under test is typed
// 104 B1 + B3 — probe (what is under a point) and floatSummary (how an object sits in water), on a scene built
// from three objects only: the scout's island (a raised mesh flagged terrain), an ocean box made water, a table.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { probeScene, waterUnder, PROBE_MAX_POINTS, PROBE_AI_TOOLS } from '../../src/lib/ai/probeTools.js';
import { floatSummary, floatWords } from '../../src/lib/sim/floatSummary.js';
import { waterPreset } from '../../src/lib/water/presets.js';
import { READ_ONLY_TOOLS } from '../../src/lib/agent/agentCore.js';

/** the island: a 24 m plate whose top is 2.25 m, the ocean: 80 x 2 x 80 with its top at 0.4, a sensor box, a table */
function world() {
	const group = new THREE.Group();
	const island = new THREE.Mesh(new THREE.BoxGeometry(24, 2.25, 24), new THREE.MeshBasicMaterial());
	island.position.set(0, 1.125, 0);
	island.name = 'Island';
	island.userData.terrain = { size: 24 };
	const ocean = new THREE.Mesh(new THREE.BoxGeometry(80, 2, 80), new THREE.MeshBasicMaterial());
	ocean.position.set(0, -0.6, 0);
	ocean.name = 'Ocean';
	ocean.userData.water = waterPreset('ocean', { shape: 'plane' });
	ocean.userData.physics = { mode: 'static', sensor: true };
	const trigger = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 2), new THREE.MeshBasicMaterial());
	trigger.position.set(20, 3, 20);
	trigger.name = 'Trigger';
	trigger.userData.physics = { mode: 'static', sensor: true };
	const table = new THREE.Group();
	table.name = 'Table';
	const top = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 1), new THREE.MeshBasicMaterial());
	top.position.set(0, 0.75, 0);
	table.add(top);
	table.position.set(-30, 0, 0);
	group.add(island, ocean, trigger, table);
	group.updateWorldMatrix(true, true);
	return { group, island, ocean, trigger, table };
}
const GROUND = { ground: { enabled: true, height: 0 } };

describe('probe (104 B1)', () => {
	it('stands on the terrain, not on the water over it (the row-1 bug, as a read)', () => {
		const { group, island } = world();
		const r = probeScene(group, { at: [0, 0] }, GROUND);
		expect(r.surface).toBe('terrain');
		expect(r.uuid).toBe(island.uuid);
		expect(r.y).toBeCloseTo(2.25, 3);
		expect(r.normal).toEqual([0, 1, 0]);
		expect(r.water).toBeUndefined(); // the ground is above the sea here
	});

	it('over open sea: no floor, the water surface and no depth', () => {
		const { group, ocean } = world();
		const r = probeScene(group, { at: [30, 30] }, GROUND);
		expect(r.surface).toBe('none');
		expect(r.y).toBeNull();
		expect(r.water.uuid).toBe(ocean.uuid);
		expect(r.water.surface).toBeCloseTo(0.4, 3);
		expect(r.water.depth).toBeNull();
	});

	it('looks through a sensor volume unless include is "all"', () => {
		const { group, trigger } = world();
		const solid = probeScene(group, { at: [20, 20] }, GROUND);
		expect(solid.uuid).not.toBe(trigger.uuid);
		const all = probeScene(group, { at: [20, 20], include: 'all' }, GROUND);
		expect(all.hits[0].uuid).toBe(trigger.uuid);
		expect(all.hits[0].surface).toBe('sensor');
		expect(all.hits.some((h) => h.surface === 'water')).toBe(true);
	});

	it('a table top under a point, in a group, names the top-level object', () => {
		const { group, table } = world();
		const r = probeScene(group, { at: [-30, 0] }, GROUND);
		expect(r.uuid).toBe(table.uuid);
		expect(r.y).toBeCloseTo(0.8, 3);
		expect(r.water).toBeUndefined(); // its top is above the sea surface
	});

	it('points keep their order and cap at 64; bad input says what to send', () => {
		const { group } = world();
		const r = probeScene(group, { points: [[0, 0], [30, 30], [-30, 0]] }, GROUND);
		expect(r.points.map((p) => p.surface)).toEqual(['terrain', 'none', 'mesh']);
		expect(probeScene(group, { points: Array.from({ length: PROBE_MAX_POINTS + 1 }, () => [0, 0]) }).error).toMatch(/at most 64/);
		expect(probeScene(group, {}).error).toMatch(/at: \[x, z\]/);
		expect(probeScene(group, { at: [0, 0], include: 'water' }).error).toMatch(/include/);
	});

	it('the ground plane when nothing is there and the scene has one; none without it', () => {
		const group = new THREE.Group();
		expect(probeScene(group, { at: [5, 5] }, GROUND)).toMatchObject({ y: 0, surface: 'ground', uuid: null });
		expect(probeScene(group, { at: [5, 5] }, { ground: { enabled: false } })).toMatchObject({ y: null, surface: 'none' });
	});

	it('ray: the first solid surface, water looked through', () => {
		const { group, island } = world();
		const r = probeScene(group, { ray: { from: [0, 10, 0], dir: [0, -1, 0] } }, GROUND);
		expect(r.hit.uuid).toBe(island.uuid);
		expect(r.hit.distance).toBeCloseTo(10 - 2.25, 3);
		const sea = probeScene(group, { ray: { from: [30, 10, 30], dir: [0, -1, 0], max: 50 } }, GROUND);
		expect(sea.hit).toBeNull();
		const seaAll = probeScene(group, { ray: { from: [30, 10, 30], dir: [0, -1, 0] }, include: 'all' }, GROUND);
		expect(seaAll.hit.surface).toBe('water');
		expect(probeScene(group, { ray: { from: [0, 0, 0], dir: [0, 0, 0] } }).error).toMatch(/direction/);
	});

	it('answers in the build frame when objectsGroup is moved', () => {
		const { group } = world();
		group.position.set(100, 5, 0);
		group.updateWorldMatrix(true, true);
		const r = probeScene(group, { at: [0, 0] }, GROUND);
		expect(r.y).toBeCloseTo(2.25, 3);
		expect(waterUnder(group, 30, 30).surface).toBeCloseTo(0.4, 3);
	});

	it('is a read-only tool (viewers, the read scope) and its description says what list_scene near is for', () => {
		expect(READ_ONLY_TOOLS.has('probe')).toBe(true);
		expect(PROBE_AI_TOOLS[0].function.description).toMatch(/list_scene \{near\}/);
	});
});

describe('floatSummary (104 B3)', () => {
	const box = (physics) => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
		m.userData.physics = physics;
		return m;
	};
	it('the default floats half under', () => {
		const s = floatSummary(box({ mode: 'dynamic' }));
		expect(s).toMatchObject({ density: 500, under: 0.5, draft: 0.5, height: 1, sinks: false });
		expect(floatWords(s)).toMatch(/50% under: 0.5 m of its 1 m/);
	});
	it('by mass: three 1 m boxes, 200 / 700 / 2000 kg → high, low, sinks', () => {
		const [a, b, c] = [200, 700, 2000].map((mass) => floatSummary(box({ mode: 'dynamic', mass, floats: { density: 'mass' } })));
		expect(a).toMatchObject({ densityFrom: 'mass', density: 200, under: 0.2, sinks: false });
		expect(b).toMatchObject({ density: 700, under: 0.7, sinks: false });
		expect(c).toMatchObject({ density: 2000, under: null, draft: null, sinks: true });
	});
	it('a cube between ~21 % and ~79 % of water tips over; a flat plank at the same density does not', () => {
		const cube = (mass) => floatSummary(box({ mode: 'dynamic', mass, floats: { density: 'mass' } }));
		expect(cube(150).upright).toBeUndefined();
		expect(cube(500).upright).toBe(false);
		expect(floatWords(cube(700))).toMatch(/tips over/);
		expect(cube(850).upright).toBeUndefined();
		const plank = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), new THREE.MeshBasicMaterial());
		plank.userData.physics = { mode: 'dynamic', floats: { density: 500 } };
		expect(floatSummary(plank).upright).toBeUndefined();
	});
	it('buoyancy and off', () => {
		expect(floatSummary(box({ floats: { density: 600, multiplier: 2 } })).under).toBe(0.3);
		expect(floatSummary(box({ floats: { off: true } }))).toMatchObject({ off: true, under: null, sinks: false });
		expect(floatSummary(new THREE.Group())).toBeNull();
	});
});
