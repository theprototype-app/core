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
