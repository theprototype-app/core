// @ts-nocheck — plain fixtures; the code under test is typed
// 52 V2: the VR radial's Arrange ring gives the SAME results as the desktop. Two layers:
//  1. the table — every desktop control (the multi-select Inspector's Arrange buttons, the object menu's
//     Transform ▸ rows) has a VR sector naming the identical align.js call with identical arguments;
//  2. the result — the REAL align.js run on two identical scenes, one through the desktop call and one
//     through the VR sector (buildRings.runArrange), leaves every object in the same place, and records
//     ONE undo entry each.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObjects } from '../../src/stores/sceneStore';
import { arrangeCall, arrangeIds, arrangeMinimum, sectorOp, nextAxis, ARRANGE_AXES, ALIGN_EDGES, DISTRIBUTE_MODES } from '../../src/lib/vr/arrangeCore.js';
import { runArrange, vrAlignToActive, vrArrangeAxis, registerArrangeRings } from '../../src/lib/vr/buildRings.js';
import * as align from '../../src/lib/align.js';
import { undoStack } from '../../src/lib/history.js';

describe('the table: one sector per desktop control, the same call', () => {
	it('align: 3 axes × min / centre / max, to the selection or the active object', () => {
		for (const axis of ['x', 'y', 'z'])
			for (const edge of ['min', 'center', 'max']) {
				// ArrangeSection: alignSelection(axis, e.edge, { to: alignTo === 'active' ? 'active' : 'selection' })
				expect(arrangeCall(`align:${axis}:${edge}`)).toEqual({ fn: 'alignSelection', args: [axis, edge, { to: 'selection' }] });
				expect(arrangeCall(`align:${axis}:${edge}`, true)).toEqual({ fn: 'alignSelection', args: [axis, edge, { to: 'active' }] });
			}
	});
	it('distribute: 3 axes × even centres / even gaps', () => {
		for (const axis of ['x', 'y', 'z'])
			for (const mode of ['centers', 'gaps'])
				expect(arrangeCall(`distribute:${axis}:${mode}`)).toEqual({ fn: 'distributeSelection', args: [axis, mode] });
	});
	it('drop to ground', () => {
		expect(arrangeCall('arrange:drop')).toEqual({ fn: 'dropSelection', args: [] });
	});
	it('every sector id resolves, unknown ids do not, and the minimums match the desktop toasts', () => {
		const ids = arrangeIds();
		expect(ids.length).toBe(ARRANGE_AXES.length * (ALIGN_EDGES.length + DISTRIBUTE_MODES.length) + 1);
		for (const id of ids) expect(arrangeCall(id)).not.toBeNull();
		expect(arrangeCall('align:w:min')).toBeNull();
		expect(arrangeCall('align:x:middle')).toBeNull();
		expect(arrangeCall('distribute:x:spread')).toBeNull();
		expect([arrangeMinimum('align:x:min'), arrangeMinimum('distribute:y:gaps'), arrangeMinimum('arrange:drop')]).toEqual([2, 3, 1]);
		expect([arrangeMinimum('arrange:center'), arrangeMinimum('arrange:gaps')]).toEqual([2, 3]);
	});
	it('the ring: an Axis sector cycles X → Y → Z, every op sector acts on that axis', () => {
		expect([nextAxis('x'), nextAxis('y'), nextAxis('z')]).toEqual(['y', 'z', 'x']);
		for (const axis of ['x', 'y', 'z']) {
			for (const edge of ['min', 'center', 'max']) expect(sectorOp('arrange:' + edge, axis)).toBe(`align:${axis}:${edge}`);
			for (const mode of ['centers', 'gaps']) expect(sectorOp('arrange:' + mode, axis)).toBe(`distribute:${axis}:${mode}`);
		}
		expect(sectorOp('arrange:drop', 'y')).toBe('arrange:drop');
		expect(sectorOp('arrange:axis', 'x')).toBeNull();
		expect(sectorOp('arrange:to', 'x')).toBeNull();
	});
	it('the ring is ONE level (Selected ▸ Arrange ▸ acts) and offers every desktop op', () => {
		const entries = [];
		registerArrangeRings((e) => entries.push(e));
		const ring = entries.filter((e) => e.group === 'arrange');
		expect(ring.some((e) => e.ring)).toBe(false); // no deeper ring: the radial's two-level rule
		expect(ring.map((e) => e.id)).toEqual(['arrange:axis', 'arrange:min', 'arrange:center', 'arrange:max', 'arrange:centers', 'arrange:gaps', 'arrange:drop', 'arrange:to']);
		const opener = entries.find((e) => e.id === 'nav:arrange');
		expect(opener.group).toBe('object');
		expect(opener.ring).toBe('arrange');
		// every desktop op is reachable: 3 axes (the Axis sector) × the 5 op sectors + drop
		const reach = new Set();
		for (const axis of ['x', 'y', 'z']) for (const e of ring) { const op = sectorOp(e.id, axis); if (op) reach.add(op); }
		expect([...reach].sort()).toEqual(arrangeIds().sort());
	});
});

/** a fresh scene of boxes at deterministic, irregular places; returns their uuids (fixed per index) */
function buildScene() {
	const group = new THREE.Group();
	group.name = 'objects';
	const scene = new THREE.Scene();
	scene.add(group);
	const spec = [
		{ p: [0, 2, 0], s: [1, 1, 1] },
		{ p: [3.2, 4.1, -1], s: [2, 0.5, 1] },
		{ p: [-1.7, 1.3, 2.4], s: [0.5, 2, 0.5] },
		{ p: [6.1, 0.9, 0.3], s: [1, 1, 3] }
	];
	const uuids = spec.map((o, i) => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(...o.s), new THREE.MeshBasicMaterial());
		mesh.position.set(...o.p);
		mesh.uuid = 'box-' + i;
		group.add(mesh);
		return mesh.uuid;
	});
	group.updateMatrixWorld(true);
	objectsGroup.set(group);
	selectedObjects.set(uuids);
	return { group, uuids };
}
const poses = (group) => group.children.map((c) => c.position.toArray().map((n) => +n.toFixed(9)));

describe('the result: the VR sector moves objects exactly where the desktop call does', () => {
	beforeEach(() => {
		vrAlignToActive.set(false);
		vrArrangeAxis.set('x');
	});
	const cases = [
		...['x', 'y', 'z'].flatMap((axis) => ['min', 'center', 'max'].map((edge) => [`align:${axis}:${edge}`, () => align.alignSelection(axis, edge, { to: 'selection' })])),
		...['x', 'y', 'z'].flatMap((axis) => ['centers', 'gaps'].map((mode) => [`distribute:${axis}:${mode}`, () => align.distributeSelection(axis, mode)])),
		['arrange:drop', () => align.dropSelection()]
	];
	for (const [id, desktop] of cases)
		it(id, async () => {
			const a = buildScene();
			const before = poses(a.group);
			const depth0 = get(undoStack).length;
			const movedDesktop = desktop();
			const desktopPoses = poses(a.group);
			const depthDesktop = get(undoStack).length;
			const b = buildScene();
			// through the RING: set the ring's axis, press the sector (arrange:min …), exactly what the headset does
			const [, axis, which] = id.split(':');
			if (id !== 'arrange:drop') vrArrangeAxis.set(axis);
			const movedVR = await runArrange(id === 'arrange:drop' ? id : 'arrange:' + which);
			expect(poses(b.group)).toEqual(desktopPoses);
			expect(movedVR).toBe(movedDesktop);
			expect(movedVR).toBeGreaterThan(0); // the fixture is irregular on purpose: every op moves something
			expect(depthDesktop - depth0).toBe(1); // ONE undo entry for the whole set
			expect(get(undoStack).length - depthDesktop).toBe(1);
			expect(poses(b.group)).not.toEqual(before);
		});
	it('Align to: Active lines everything up with the active (last picked) object, which stays', async () => {
		const a = buildScene();
		align.alignSelection('x', 'min', { to: 'active' });
		const desktopPoses = poses(a.group);
		const b = buildScene();
		vrAlignToActive.set(true);
		await runArrange('arrange:min');
		expect(poses(b.group)).toEqual(desktopPoses);
		expect(b.group.children[3].position.x).toBeCloseTo(6.1, 9); // the active one stayed
	});
});
