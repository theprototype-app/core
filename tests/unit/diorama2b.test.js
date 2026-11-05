// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 PART 2 (items 15-28): the world / look handlers on a real objectsGroup, the real history and a
// recording peer — one describe per item.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';

vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, renameObject: () => {}, selectionTintOriginals: () => null }));
const physicsCalls = vi.hoisted(() => []);
vi.mock('$lib/physics', () => ({ setPhysicsFor: (uuid, p) => physicsCalls.push([uuid, p]), physicsShapeChanged: () => {} }));
vi.mock('$lib/audioEngine', () => ({ ensureAudioContext: () => null, bus: () => null }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const history = await import('../../src/lib/history.js');
const core = await import('../../src/lib/ai/worldToolsCore.js');
const { parseCanvas } = await import('../../src/lib/ai/imageToolCore.js');
const { worldTool, WORLD_AI_TOOLS, WORLD_TOOL_NAMES, WORLD_READ_TOOLS } = await import('../../src/lib/ai/worldTools.js');
const { PARTICLE_PRESETS } = await import('../../src/lib/particlePresets.js');
const { summarizeToolCall } = await import('../../src/lib/agentLogCore.js');
const { viewerToolRefusal } = await import('../../src/lib/ai/viewerGate.js');
const { READ_ONLY_TOOLS } = await import('../../src/lib/agent/agentCore.js');
const { stampGeometryParams } = await import('../../src/lib/geometryEdit.js');
const sm = await import('../../src/lib/sceneMusic.js');
// objectActions is mocked (it reaches geometries.svelte.js), so its 'props' kind is stood in for: the userData half
history.registerHistoryKind('props', (entry, state) => {
	const o = get(objectsGroup).getObjectByProperty('uuid', entry.uuid);
	if (!o) return false;
	for (const [k, v] of Object.entries(state)) if (v) o.userData[k] = v;
	else delete o.userData[k];
	return true;
});

let sent = [];
let group;

beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	physicsCalls.length = 0;
	peers.set({ send: (m) => sent.push(m), connections: {}, peer: { id: 'me' } });
	history.undoStack.set([]);
});

/** create_objects' createOne, minus the replication the handlers do not own */
function createBase(spec) {
	if (spec.kind === 'group') {
		const g = new THREE.Group();
		g.name = spec.name || 'Group';
		if (spec.position) g.position.fromArray(spec.position);
		group.add(g);
		history.recordObjectPresence('create', g);
		return { uuid: g.uuid, name: g.name };
	}
	const g = spec.primitive === 'Sphere' ? new THREE.SphereGeometry(spec.params?.[0] ?? 0.5) : spec.primitive === 'Cylinder' ? new THREE.CylinderGeometry() : new THREE.BoxGeometry(...(spec.params ?? [1, 1, 1]));
	const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
	m.name = spec.name || spec.primitive;
	stampGeometryParams(m);
	if (spec.position) m.position.fromArray(spec.position);
	group.add(m);
	history.recordObjectPresence('create', m);
	return { uuid: m.uuid, name: m.name };
}

/** one call in one history batch, as agentCore does */
async function call(name, args) {
	history.beginHistoryBatch();
	try {
		return await worldTool(name, args, createBase);
	} finally {
		history.endHistoryBatch('tool');
	}
}
const stack = () => get(history.undoStack);
const find = (uuid) => group.getObjectByProperty('uuid', uuid);

const { assetUse } = await import('../../src/lib/ai/worldTools.js');

describe('15 search "use" names the call, never a lane', () => {
	it('every kind says how it is used; the sky row names set_look sky', () => {
		for (const kind of ['model', 'prefab', 'material', 'sound', 'image', 'hdri']) expect(assetUse({ kind, name: 'x' })).not.toMatch(/\(\d+[a-z-]*\)|85-scene/);
		expect(assetUse({ kind: 'hdri' })).toMatch(/set_look \{action: 'sky'/);
	});
});

describe('17 the confirm flow says what is asked and where it stands', () => {
	it('a checkpoint restore is asked as a restore, not a look change', async () => {
		const { askLine } = await import('../../src/lib/agent/confirmGate.js');
		expect(askLine('undo_last', 'go back to a checkpoint "cp" (undo its last 2 changes)')).toBe(' wants to go back to a checkpoint "cp" (undo its last 2 changes)');
		expect(askLine('set_sky', 'sky: night')).toBe(' wants to change the whole scene: sky: night');
	});
	it('the host\'s prompt for a relayed restore reads "wants to go back to a checkpoint"', async () => {
		const appStore = await import('../../src/stores/appStore');
		const confirmGate = await import('../../src/lib/agent/confirmGate.js');
		const shown = [];
		const unsub = appStore.toastStore.subscribe((list) => shown.splice(0, shown.length, ...list.map((t) => String(t.message ?? t.text ?? ''))));
		confirmGate.handleConfirmRelay('agentX', { type: 'agentconfirmreq', id: 'c9', tool: 'undo_last', summary: 'go back to a checkpoint "cp" (undo its last 1 change)' });
		unsub();
		expect(shown.some((t) => /wants to go back to a checkpoint "cp"/.test(t))).toBe(true);
		expect(shown.some((t) => /change the whole scene/.test(t))).toBe(false);
	});
});

describe('18 a round pond: size [diameter, depth, diameter], bottom centre, the colour on the whole body', () => {
	it('[4, 1, 4] is 4 m across and 1 m deep, standing on its position; color tints shallow and deep', async () => {
		const specs = [];
		const made = (spec) => {
			specs.push(spec);
			const m = new THREE.Mesh(new THREE.CylinderGeometry(...spec.params), new THREE.MeshStandardMaterial());
			m.position.fromArray(spec.position);
			group.add(m);
			history.recordObjectPresence('create', m);
			return { uuid: m.uuid, name: m.name };
		};
		history.beginHistoryBatch();
		const r = await worldTool('water', { kind: 'round', size: [4, 1, 4], position: [2, 0, 3], color: '#2e8b57' }, made);
		history.endHistoryBatch('tool');
		expect(r.error).toBeUndefined();
		expect(specs[0].params).toEqual([2, 2, 1]); // radius 2, height 1
		expect(specs[0].position).toEqual([2, 0.5, 3]); // the bottom at y 0
		const w = find(r.created[0].uuid).userData.water;
		expect(w.look.shallowColor).toBe('#2e8b57');
		expect(w.look.deepColor).not.toBe('#06304a');
		expect(r.created[0].look.shallowColor).toBe('#2e8b57');
		// the old [radius, depth] still works
		specs.length = 0;
		await worldTool('water', { kind: 'round', size: [1.5, 0.8] }, made);
		expect(specs[0].params).toEqual([1.5, 1.5, 0.8]);
		const before = group.children.length;
		expect((await worldTool('water', { kind: 'round', color: 'mauve-ish' }, made)).error).toMatch(/color/);
		expect(group.children.length).toBe(before); // nothing made
	});
});

describe('21 particles with no object: the emitter draws nothing', () => {
	it('an empty group at the spot carries the particles; rain hangs above it', async () => {
		const r = await call('create_particles', { preset: 'fireflies', position: [1, 0, 2] });
		const o = find(r.created[0].uuid);
		expect(o.isGroup).toBe(true);
		let drawn = 0;
		o.traverse((n) => (n.isMesh || n.isPoints ? drawn++ : 0));
		expect(drawn).toBe(0);
		expect(o.userData.particles.preset).toBe('fireflies');
		expect(o.position.toArray()).toEqual([1, 0, 2]);
		const rain = await call('create_particles', { preset: 'rain', position: [0, 0, 0] });
		expect(find(rain.created[0].uuid).position.y).toBeGreaterThan(0);
	});
});

const { terrainGeometry } = await import('../../src/lib/customGeometries.js');
describe('22 terrain: height is the peak, island edges, layers that show, paint by height', () => {
	function terrainAt() {
		const m = new THREE.Mesh(terrainGeometry({ size: 24, segments: 24, amplitude: 0 }), new THREE.MeshStandardMaterial());
		m.name = 'Terrain';
		m.userData.terrain = true;
		group.add(m);
		stampGeometryParams(m);
		return m;
	}
	const maxY = (m) => {
		let top = -Infinity;
		const a = m.geometry.attributes.position.array;
		for (let i = 1; i < a.length; i += 3) top = Math.max(top, a[i]);
		return top;
	};

	it('heightSplat (pure): every texel sums to 255; low ground is layer 0, the top is the last layer', () => {
		const g = terrainGeometry({ size: 10, segments: 8, amplitude: 0 });
		const a = g.attributes.position.array;
		for (let i = 0; i < a.length; i += 3) a[i + 1] = a[i] + 5; // a ramp rising along +x
		const bytes = core.heightSplat(a, { minX: -5, minZ: -5, sizeX: 10, sizeZ: 10 }, 16, 3);
		for (let o = 0; o < bytes.length; o += 4) expect(bytes[o] + bytes[o + 1] + bytes[o + 2] + bytes[o + 3]).toBe(255);
		expect(bytes[(8 * 16 + 0) * 4]).toBe(255); // the low (west) edge: all layer 0
		expect(bytes[(8 * 16 + 15) * 4 + 2]).toBe(255); // the high (east) edge: all layer 2
		expect(bytes[(8 * 16 + 15) * 4 + 3]).toBe(0); // layer 3 was not asked for
	});

	it('height: 6 with island edges peaks at 6 m and sinks the rim; the answer says the peak', async () => {
		const t = terrainAt();
		const r = await worldTool('terrain', { uuid: t.uuid, height: 6, edges: 'island', seed: 3 }, createBase);
		expect(r.updated?.[0]?.ok, JSON.stringify(r)).toBe(true);
		expect(r.updated[0].peak).toBeCloseTo(6, 1);
		expect(maxY(t)).toBeCloseTo(6, 1);
		const a = t.geometry.attributes.position.array;
		expect(Math.abs(a[1])).toBeLessThan(1e-6); // a corner of an island is at 0
	});

	it('layers on an unpainted terrain get a paint map so they show; paintBy height writes one by height', async () => {
		const t = terrainAt();
		await worldTool('terrain', { uuid: t.uuid, height: 4 }, createBase);
		expect(t.userData.terrainSplat).toBeFalsy();
		await worldTool('terrain', { uuid: t.uuid, layers: [{ color: '#c2b280' }] }, createBase);
		expect(t.userData.terrainSplat).toBeTruthy();
		const r = await worldTool('terrain', { uuid: t.uuid, layers: [{ color: '#c2b280' }, { color: '#3a7d2c' }, { color: '#888888' }], paintBy: 'height' }, createBase);
		expect(r.updated[0].paintedBy).toMatch(/height/);
		expect((await worldTool('terrain', { uuid: t.uuid, paintBy: 'slope' }, createBase)).error).toMatch(/paintBy/);
	});
});

describe('23 scatter: rules.avoid circles round a spot or an object, one named set for every asset', () => {
	function floorMesh() {
		const g = new THREE.PlaneGeometry(20, 20, 10, 10);
		g.rotateX(-Math.PI / 2);
		const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
		m.name = 'Floor';
		group.add(m);
		return m;
	}
	it('rules.avoid [{position, radius}, {uuid, radius}] land as circles in the set; three assets make one set with the given id', async () => {
		const f = floorMesh();
		const hut = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		hut.position.set(4, 0, 4);
		group.add(hut);
		const r = await worldTool('scatter', { surface: f.uuid, assets: ['Cone', 'Sphere', 'Box'], count: 50, seed: 2, id: 'meadow', rules: { slope: [0, 30], avoid: [{ position: [-3, 0, 2], radius: 2 }, { uuid: hut.uuid, radius: 3 }] } });
		expect(r.updated?.[0], JSON.stringify(r)).toMatchObject({ ok: true, set: 'meadow', assets: 3 });
		const set = f.userData.terrainScatter?.sets?.find((s) => s.id === 'meadow') ?? JSON.stringify(f.userData).match(/meadow/);
		expect(set).toBeTruthy();
		expect(JSON.stringify(f.userData)).toContain('[-3,2,2]');
		expect(JSON.stringify(f.userData)).toContain('[4,4,3]');
		expect((await worldTool('scatter', { surface: f.uuid, asset: 'Cone', avoid: [{ position: [0, 0, 0], radius: -1 }] })).error).toMatch(/radius/);
		expect((await worldTool('scatter', { surface: f.uuid, asset: 'Cone', rules: { avoid: [{ position: [0, 0] }] } })).error).toMatch(/avoid/);
	});
});
