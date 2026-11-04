// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85b (lane 85-world): the world tools' pure core (patterns, Catmull-Clark, asset search, sculpt ops,
// scatter rules, audio sniffing) and the HANDLERS on a real objectsGroup, the real history and a recording peer —
// what each call makes, what it sends, that ONE undo takes it back, and that a viewer is refused.
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

describe('L7 procedural textures', () => {
	it('every pattern draws a canvas add_image accepts, inside the op caps', () => {
		for (const name of Object.keys(core.TEXTURE_PATTERNS)) {
			const p = core.patternCanvas(name);
			expect(p.error, name).toBeUndefined();
			const parsed = parseCanvas(p.canvas);
			expect(parsed.error, name).toBeUndefined();
			expect(p.canvas.ops.length).toBeLessThanOrEqual(500);
		}
	});
	it('is deterministic per seed and takes colours / size', () => {
		const a = core.patternCanvas({ name: 'brick', seed: 3 });
		expect(core.patternCanvas({ name: 'brick', seed: 3 })).toEqual(a);
		expect(core.patternCanvas({ name: 'brick', seed: 4 })).not.toEqual(a);
		const c = core.patternCanvas({ name: 'wood', colors: ['#112233'], size: 256 });
		expect(c.canvas.width).toBe(256);
		expect(JSON.stringify(c.canvas)).toContain('#112233');
	});
	it('names what is wrong', () => {
		expect(core.patternCanvas('lava rock').error).toMatch(/one of wood/);
		expect(core.patternCanvas({ name: 'wood', colors: ['red'] }).error).toMatch(/pattern\.colors/);
		expect(core.patternCanvas(5).error).toMatch(/pattern:/);
	});
});

const CUBE = {
	vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
	faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]]
};

describe('G9 Catmull-Clark', () => {
	it('a cube → 24 quads, 26 vertices, corners pulled in (a rounded box); level 2 → 96 quads', () => {
		const one = core.catmullClark(CUBE, 1);
		expect(one.faces.length).toBe(24);
		expect(one.vertices.length).toBe(26);
		expect(one.faces.every((f) => f.length === 4)).toBe(true);
		const r = Math.max(...one.vertices.map((v) => Math.hypot(...v)));
		expect(r).toBeLessThan(Math.hypot(0.5, 0.5, 0.5));
		const two = core.catmullClark(CUBE, 2);
		expect(two.faces.length).toBe(96);
		expect(core.subdivisionSize(CUBE, 2)).toEqual({ vertices: two.vertices.length, faces: 96 });
	});
	it('keeps an open border in place and carries faceMaterials / colors', () => {
		const quad = { vertices: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], faces: [[0, 1, 2, 3]], faceMaterials: [2], colors: [[1, 0, 0], [1, 0, 0], [0, 0, 1], [0, 0, 1]] };
		const out = core.catmullClark(quad, 1);
		expect(out.faces.length).toBe(4);
		expect(out.faceMaterials).toEqual([2, 2, 2, 2]);
		expect(out.colors.length).toBe(out.vertices.length);
		// every vertex stays on the plane, and the old corners stay inside the square
		expect(out.vertices.every((v) => Math.abs(v[1]) < 1e-9 && v[0] >= 0 && v[0] <= 1 && v[2] >= 0 && v[2] <= 1)).toBe(true);
	});
});

describe('W1 asset search core', () => {
	it('scores name over tags and needs every word', () => {
		const w = core.queryWords('Pine Tree!');
		expect(w).toEqual(['pine', 'tree']);
		expect(core.scoreAsset({ name: 'pine tree' }, w)).toBeGreaterThan(core.scoreAsset({ name: 'pine', tags: ['tree'] }, w));
		expect(core.scoreAsset({ name: 'oak tree' }, w)).toBe(0);
		expect(core.scoreAsset({ name: 'anything' }, [])).toBe(1);
	});
	it('parses the four id shapes and refuses the rest', () => {
		expect(core.parseAssetId('lib:abc')).toEqual({ source: 'lib', ref: 'abc' });
		expect(core.parseAssetId('pack:nature/pine-1')).toEqual({ source: 'pack', ref: 'nature', item: 'pine-1' });
		expect(core.parseAssetId('prefab:p1')).toEqual({ source: 'prefab', ref: 'p1' });
		expect(core.parseAssetId('cc0:polyhaven/brick_wall')).toEqual({ source: 'cc0', ref: 'polyhaven', item: 'brick_wall' });
		for (const bad of ['', 'pine', 'pack:nature', 'pack:/x', 'http://x', 5]) expect(core.parseAssetId(bad).error, String(bad)).toBeTruthy();
	});
	it('places copies centred on the point, spaced along the turned axis', () => {
		expect(core.placementPoints([0, 0, 0], 3, 2).map((p) => p.map((n) => n + 0))).toEqual([[-2, 0, 0], [0, 0, 0], [2, 0, 0]]);
		const p = core.placementPoints([1, 0, 1], 2, 2, Math.PI / 2);
		expect(p[0][0]).toBeCloseTo(1);
		expect(p[0][2]).toBeCloseTo(2);
	});
});

describe('W2 / W3 rules', () => {
	it('sculpt ops: positions, radius clamps, raise height, paint layer', () => {
		const r = core.parseSculptOps([{ op: 'raise', at: [0, 0], radius: 5, height: 3 }, { op: 'paint', at: [1, 2, 3], layer: 2 }], 20);
		expect(r.ops[0]).toMatchObject({ op: 'raise', x: 0, z: 0, radius: 5, height: 3, passes: 1 });
		expect(r.ops[1]).toMatchObject({ op: 'paint', x: 1, z: 3, layer: 2 });
		expect(core.parseSculptOps([{ op: 'dig', at: [0, 0] }], 20).error).toMatch(/ops\[0\]\.op/);
		expect(core.parseSculptOps([{ op: 'raise', at: [50, 0] }], 20).error).toMatch(/off a terrain/);
		expect(core.parseSculptOps([{ op: 'paint', at: [0, 0], layer: 7 }], 20).error).toMatch(/layer/);
		expect(core.stepsForHeight(1, 0.5)).toBe(15);
	});
	it('scatter: density or count, scale range, masks, never both', () => {
		const src = [{ kind: 'primitive', type: 'Cone' }];
		const r = core.scatterSetOf({ density: 0.5, scale: [0.5, 2], rules: { slope: [0, 30], height: [0, 4] }, seed: 7, tint: 0.3 }, src);
		expect(r.set).toMatchObject({ gen: { density: 0.5, scaleMin: 0.5, scaleMax: 2, slope: [0, 30], height: [0, 4], rot: true }, seed: 7, tint: 0.3, source: src[0] });
		expect(core.scatterSetOf({ density: 1, count: 3 }, src).error).toMatch(/not both/);
		expect(core.scatterSetOf({ rules: { wet: 1 } }, src).error).toMatch(/rules\.wet/);
		expect(core.scatterSetOf({}, []).error).toMatch(/asset/);
		const two = core.scatterSetOf({ count: 10 }, [src[0], { kind: 'primitive', type: 'Sphere' }]);
		expect(two.set.sources.length).toBe(2);
	});
});

describe('W6 audio bytes', () => {
	const bytes = (s, pad = 12) => {
		const b = new Uint8Array(Math.max(pad, s.length));
		[...s].forEach((c, i) => (b[i] = c.charCodeAt(0)));
		return b;
	};
	it('knows audio by its bytes, never by a name', () => {
		const wav = bytes('RIFF....WAVE');
		expect(core.sniffAudio(wav).mime).toBe('audio/wav');
		expect(core.sniffAudio(bytes('OggS')).ext).toBe('ogg');
		expect(core.sniffAudio(bytes('ID3')).ext).toBe('mp3');
		expect(core.sniffAudio(bytes('<html><script>'))).toBeNull();
		expect(core.sniffAudio(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
	});
});

describe('W5 particles (+ W5b fireflies)', () => {
	it('the preset list has sparkles and fireflies; the schema offers every preset', () => {
		expect(PARTICLE_PRESETS.map((p) => p.key)).toEqual(expect.arrayContaining(['sparkles', 'fireflies']));
		const schema = WORLD_AI_TOOLS.find((t) => t.function.name === 'create_particles');
		expect(schema.function.parameters.properties.preset.enum).toEqual(PARTICLE_PRESETS.map((p) => p.key));
	});
	it('a new emitter: a scenery marker with the preset, ONE undo removes it', async () => {
		const r = await call('create_particles', { preset: 'fireflies', position: [1, 0, 2], overrides: { count: 50 } });
		expect(r.created[0].preset).toBe('fireflies');
		const o = find(r.created[0].uuid);
		expect(o.userData.particles).toMatchObject({ preset: 'fireflies', count: 50 });
		expect(o.isGroup).toBe(true); // mcp-diorama2 21: nothing drawn but the particles
		expect(sent.some((m) => m.type === 'objectParameters' && m.parameter === 'particles' && m.uuid === o.uuid)).toBe(true);
		expect(stack().length).toBe(1);
		await history.undo();
		expect(find(r.created[0].uuid)).toBeUndefined();
		expect(summarizeToolCall('create_particles', { preset: 'fireflies' }, r)).toMatch(/fireflies/i);
	});
	it('on an object, then removed; refuses a bad override', async () => {
		const host = createBase({ primitive: 'Box', name: 'Torch' });
		history.undoStack.set([]);
		const r = await call('create_particles', { object: host.uuid, preset: 'fire' });
		expect(r.updated[0].ok).toBe(true);
		expect(find(host.uuid).userData.particles.preset).toBe('fire');
		const off = await call('create_particles', { object: host.uuid, remove: true });
		expect(off.updated[0].removed).toBe(true);
		expect(find(host.uuid).userData.particles).toBeFalsy();
		await history.undo();
		expect(find(host.uuid).userData.particles.preset).toBe('fire');
		expect((await call('create_particles', { preset: 'fire', overrides: { glow: 1 } })).error).toMatch(/overrides\.glow/);
		expect((await call('create_particles', { preset: 'lasers' })).error).toMatch(/fireflies/);
	});
});

describe('W4 water', () => {
	it('a lake: a static sensor body, no shadow, the lake preset, its level; ONE undo removes it', async () => {
		const r = await call('water', { kind: 'lake', position: [0, 0, 0], level: 0.7 });
		const o = find(r.created[0].uuid);
		expect(o.userData.water.preset).toBe('lake');
		expect(o.userData.water.level).toBeCloseTo(0.7);
		expect(o.castShadow).toBe(false);
		expect(physicsCalls).toEqual([[o.uuid, { mode: 'static', sensor: true }]]);
		expect(stack().length).toBe(1);
		await history.undo();
		expect(find(r.created[0].uuid)).toBeUndefined();
	});
	it('names a wrong kind / preset, and refuses a non-water object without a preset', async () => {
		expect((await call('water', { kind: 'puddle' })).error).toMatch(/kind: one of/);
		expect((await call('water', { preset: 'milk' })).error).toMatch(/preset: one of/);
		const b = createBase({ primitive: 'Box' });
		expect((await call('water', { uuid: b.uuid, level: 0.5 })).error).toMatch(/not water yet/);
	});
});

describe('W6 music', () => {
	it('volume / stop with ONE undo step each', async () => {
		sm.commitMusic({ hash: 'abc', name: 'Theme', playing: true, volume: 0.6, startedAt: 0 });
		const r = await call('set_music', { volume: 0.2 });
		expect(r.updated[0]).toMatchObject({ ok: true, volume: 0.2 });
		expect(get(sm.music).volume).toBeCloseTo(0.2);
		await call('set_music', { stop: true });
		expect(get(sm.music).playing).toBe(false);
		expect(stack().length).toBe(2);
		await history.undo();
		expect(get(sm.music).playing).toBe(true);
		await history.undo();
		expect(get(sm.music).volume).toBeCloseTo(0.6);
	});
	it('with no track asks for one', async () => {
		sm.commitMusic({ hash: null, name: '', playing: false, volume: 0.6, startedAt: 0 });
		expect((await call('set_music', { play: true })).error).toMatch(/asset/);
	});
});

describe('the tool contract', () => {
	it('every world tool has a schema; only search_assets is read-only; a viewer may only search', () => {
		expect(WORLD_AI_TOOLS.map((t) => t.function.name).sort()).toEqual([...WORLD_TOOL_NAMES].sort());
		expect(WORLD_READ_TOOLS).toEqual(['search_assets']);
		expect(READ_ONLY_TOOLS.has ? READ_ONLY_TOOLS.has('search_assets') : READ_ONLY_TOOLS.includes('search_assets')).toBe(true);
		for (const n of WORLD_TOOL_NAMES) {
			const refused = viewerToolRefusal(n, true);
			if (n === 'search_assets') expect(refused, n).toBeFalsy();
			else expect(refused, n).toBeTruthy();
		}
	});
	it('every writing tool has an A8 line', () => {
		for (const n of WORLD_TOOL_NAMES.filter((x) => x !== 'search_assets')) expect(summarizeToolCall(n, {}, { created: [{ uuid: 'u', name: 'Thing' }] }), n).toBeTruthy();
	});
});
