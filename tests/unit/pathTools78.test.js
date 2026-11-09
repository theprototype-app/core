// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// 78 F4: the agent's create_path (create_shape {action: 'path'}) on a real objectsGroup, the real
// history and a recording peer: the record it writes (world points re-seated on the object,
// per-point extras kept), the `splineedit` it sends, the refusals, ONE undo entry per call, and
// that the path it makes walks the schedule it says (round_seconds).
// Mocked: spawnAtPoint (it reaches geometries.svelte.js — runes) with the real Path stamp.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('../../src/lib/addObjects.js', () => ({ spawnAtPoint: (cmd, at) => globalThis.__spawn(cmd, at) }));
vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, deleteObjectsByUuid: () => {} }));
vi.mock('../../src/lib/objectActions', () => ({ moveObjectToGroup: () => {}, deleteObjectsByUuid: () => {} }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const history = await import('../../src/lib/history.js');
const { stampPathObject } = await import('../../src/lib/path/pathObject.js');
const { pathTool, PATH_AI_TOOLS } = await import('../../src/lib/ai/pathTools.js');
const { pathOfObject } = await import('../../src/lib/path/pathRuntime.js');

let sent = [];
let group;
globalThis.__spawn = (cmd, at) => {
	const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
	if (cmd === '/create Path') stampPathObject(m);
	if (at) m.position.fromArray(at);
	group.add(m);
	m.updateMatrixWorld(true);
	history.recordObjectPresence('create', m);
	return m;
};

beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	peers.set({ send: (m) => sent.push(m) });
	history.undoStack.set([]);
});

const live = (uuid) => group.getObjectByProperty('uuid', uuid);

describe('78 F4 create_path', () => {
	it('declares the tool with world points and per-point fields', () => {
		const t = PATH_AI_TOOLS[0].function;
		expect(t.name).toBe('create_path');
		expect(t.parameters.required).toEqual(['points']);
		expect(t.parameters.properties.walk.enum).toEqual(['loop', 'pingpong', 'once', 'random']);
	});
	it('makes a Path whose WORLD points are the ones given, extras kept, one undo entry', async () => {
		const r = await pathTool('create_path', {
			points: [[0, 0, 0], { pos: [4, 0, 0], wait: 2, event: 'door' }, { pos: [4, 0, 4], jump: true }, [0, 0, 4]],
			walk: 'pingpong',
			speed: 2,
			name: 'Guard route'
		});
		expect(r.ok).toBe(true);
		const o = live(r.uuid);
		expect(o.name).toBe('Guard route');
		const rec = o.userData.spline;
		expect(rec.path.mode).toBe('pingpong');
		expect(rec.path.speed).toBe(2);
		expect(rec.points[1]).toMatchObject({ wait: 2, event: 'door' });
		expect(rec.points[2].gap).toBe(true);
		const view = pathOfObject(o);
		expect(view.points.map((p) => p.pos.map((v) => +v.toFixed(6)))).toEqual([
			[0, 0, 0],
			[4, 0, 0],
			[4, 0, 4],
			[0, 0, 4]
		]);
		// 4 m at 2 m/s, a 2 s wait, a jump, 4 m at 2 m/s, then back: the schedule's own period
		expect(r.round_seconds).toBeCloseTo(view.period, 2);
		expect(sent.some((m) => m.type === 'splineedit')).toBe(true);
		const stack = [];
		history.undoStack.subscribe((s) => stack.push(s))();
		expect(stack[0].length).toBe(1);
	});
	it('refuses bad input before writing anything', async () => {
		expect((await pathTool('create_path', { points: [[0, 0, 0]] })).error).toMatch(/at least two/);
		expect((await pathTool('create_path', { points: [[0, 0, 0], 'x'] })).error).toMatch(/points\[1\]/);
		expect((await pathTool('create_path', { points: [[0, 0, 0], [1, 0, 0]], walk: 'zigzag' })).error).toMatch(/walk:/);
		expect(group.children.length).toBe(0);
	});
	it('reports a walker that is not in the scene', async () => {
		const r = await pathTool('create_path', { points: [[0, 0, 0], [1, 0, 0]], walkers: ['nope'] });
		expect(r.ok).toBe(true);
		expect(r.errors[0]).toMatch(/no object nope/);
	});
});
