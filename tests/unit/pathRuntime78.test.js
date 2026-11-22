// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// 78 F4 + F9: the Path runtime on a real THREE scene — pathOf (the read API 61's Patrol calls:
// world points, not the record's local ones), applyPatrolOnPath (the walker sits on the
// schedule's pose in WORLD space under a moved parent) and the event clock's three guards: first
// sight, a scrub back and a clock jump fire NOTHING; an ordinary frame fires each arrival once.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { newPathRecord } from '../../src/lib/path/pathCore.js';
import { pathOf, applyPatrolOnPath, patrolStateOf, resetPathRuntime, pathObjectsIn } from '../../src/lib/path/pathRuntime.js';

let root, path, guard;
beforeEach(() => {
	resetPathRuntime();
	root = new THREE.Group();
	path = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
	path.userData.spline = newPathRecord({ points: [{ pos: [0, 0, 0] }, { pos: [4, 0, 0], event: 'door' }], mode: 'pingpong', speed: 2, smooth: false });
	path.position.set(10, 0, 0);
	root.add(path);
	guard = new THREE.Object3D();
	const parent = new THREE.Group();
	parent.position.set(0, 0, 5);
	parent.add(guard);
	root.add(parent);
	root.updateMatrixWorld(true);
});

const run = (t, events) =>
	applyPatrolOnPath(guard, { path: path.uuid }, t, { root, key: 'k', nodeId: 'n', start: null, onEvent: (u, name, at) => events.push([name, +at.toFixed(6)]) });
const world = (o) => (o.updateWorldMatrix(true, false), new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).toArray().map((v) => +v.toFixed(6)));

describe('78 F9 pathOf', () => {
	it('answers WORLD points and a schedule; refuses a non-path', () => {
		const v = pathOf(root, path.uuid);
		expect(v.isPath).toBe(true);
		expect(v.points.map((p) => p.pos)).toEqual([
			[10, 0, 0],
			[14, 0, 0]
		]);
		expect(v.points[1].event).toBe('door');
		expect(v.period).toBeCloseTo(4, 9);
		expect(pathOf(root, guard.uuid)).toBeNull();
		expect(pathObjectsIn(root)).toEqual([path]);
	});
	it('follows the object when it moves (the cache keys on matrixWorld)', () => {
		const a = pathOf(root, path.uuid).points[0].pos;
		path.position.x = 20;
		root.updateMatrixWorld(true);
		expect(a).toEqual([10, 0, 0]);
		expect(pathOf(root, path.uuid).points[0].pos).toEqual([20, 0, 0]);
	});
});

describe('78 F4 applyPatrolOnPath', () => {
	it('puts the walker on the pose in WORLD space under a moved parent, and records its state', () => {
		const ev = [];
		expect(run(1, ev)).toBe(true);
		expect(world(guard)).toEqual([12, 0, 0]);
		const s = patrolStateOf('k');
		expect(s).toMatchObject({ kind: 'move', point: 0, next: 1, path: path.uuid, t: 1, start: 0, offset: 0 });
		expect(patrolStateOf('n')).toBe(s);
	});
	it('fires an arrival once per ordinary frame step; first sight / scrub back / clock jump fire nothing', () => {
		const ev = [];
		run(1.9, ev); // first sight: seeds
		expect(ev).toEqual([]);
		run(2.1, ev); // arrives at point 2 (t=2)
		expect(ev).toEqual([['door', 2]]);
		run(2.2, ev);
		expect(ev.length).toBe(1);
		run(1.5, ev); // scrub back: re-seed
		run(2.5, ev); // passes t=2 again from the re-seeded clock: an ordinary step, fires
		expect(ev.length).toBe(2);
		run(9.9, ev); // a 7.4 s jump (a reload, a tab coming back): seeds, never replays
		expect(ev.length).toBe(2);
		// counterfactual: the same window as one ORDINARY step does fire (t=10 is the next arrival)
		run(10.1, ev);
		expect(ev.length).toBe(3);
	});
	it('a missing path places nothing and clears the state (the caller falls back)', () => {
		run(1, []);
		expect(applyPatrolOnPath(guard, { path: 'gone' }, 1, { root, key: 'k', start: null })).toBe(false);
		expect(patrolStateOf('k')).toBeNull();
	});
});
