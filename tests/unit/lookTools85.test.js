// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85 L1-L5: the look tools' pure core, the Allow / Deny policy, and the HANDLERS on a real objectsGroup, the
// real history and a recording peer — what each call changes, what it sends, and that ONE undo takes it back.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';

const agentPage = vi.hoisted(() => ({ on: false }));
vi.mock('$lib/agent/agentMode.js', () => ({ agentRequested: () => agentPage.on }));
vi.mock('../../src/lib/agent/agentMode.js', () => ({ agentRequested: () => agentPage.on }));
vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {}, selectionTintOriginals: () => null }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers, toastStore } = await import('../../src/stores/appStore');
const { sessionHost } = await import('../../src/lib/connectionState');
const history = await import('../../src/lib/history.js');
const core = await import('../../src/lib/ai/lookToolsCore.js');
const confirmCore = await import('../../src/lib/agent/confirmCore.js');
const confirmGate = await import('../../src/lib/agent/confirmGate.js');
const { lookTool, fetchTextureUrl, LOOK_AI_TOOLS, LOOK_TOOL_NAMES, LOOK_READ_TOOLS } = await import('../../src/lib/ai/lookTools.js');
const { summarizeToolCall } = await import('../../src/lib/agentLogCore.js');
const sg = await import('../../src/lib/shaderGraph.js');
const shaderSync = await import('../../src/lib/shaderSync.js');
const scenePost = await import('../../src/lib/scenePost.js');
const { unwrap } = await import('../../src/lib/uvUnwrap.js');
const { viewerToolRefusal } = await import('../../src/lib/ai/viewerGate.js');
const { READ_ONLY_TOOLS } = await import('../../src/lib/agent/agentCore.js');

let sent = [];
let group;

beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	peers.set({ send: (m) => sent.push(m), connections: {}, peer: { id: 'me' } });
	history.undoStack.set([]);
	sessionHost.set(null);
	agentPage.on = false;
	toastStore.set([]);
	sg.shaderGraphs.set({});
	scenePost.postStacks.set({});
	shaderSync.startShaderSync();
});

function box(name = 'Box', material = new THREE.MeshStandardMaterial()) {
	const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
	m.name = name;
	group.add(m);
	return m;
}

/** one call in one history batch, as agentCore does */
async function call(name, args) {
	history.beginHistoryBatch();
	try {
		return await lookTool(name, args);
	} finally {
		history.endHistoryBatch('tool');
	}
}

const stack = () => get(history.undoStack);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const res = (bytes, headers = {}, status = 200) => new Response(bytes, { status, headers });

describe('texture sources', () => {
	it('takes https only, never a local address or a login', () => {
		expect(core.checkTextureUrl('https://example.com/a.png').ok).toBe(true);
		for (const bad of ['http://example.com/a.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://192.168.1.2/a.png', 'https://10.0.0.1/a.png', 'https://[::1]/a.png', 'https://printer.local/a.png', 'https://u:p@example.com/a.png'])
			expect(core.checkTextureUrl(bad).ok, bad).toBe(false);
	});
	it('keeps 1.48.0\'s refusal of a raw string', () => {
		expect(core.parseMapSource('wood.png').error).toBeTruthy();
		expect(core.parseMapSource('data:image/png;base64,AAAA').error).toBeTruthy();
		expect(core.parseMapSource(5).error).toBeTruthy();
		expect(core.parseMapSource(null).clear).toBe(true);
		expect(core.parseMapSource('https://example.com/a.png').url).toBe('https://example.com/a.png');
		expect(core.parseMapSource('ABCDEF0123456789abcdef').hash).toBe('abcdef0123456789abcdef');
	});
	it('names the slots either way, and refuses an unknown one', () => {
		const { slots, errors } = core.parseMaps({ albedo: null, normalMap: null, sparkle: null, __proto__x: null });
		expect(Object.keys(slots).sort()).toEqual(['map', 'normalMap']);
		expect(errors.length).toBe(2);
	});
	it('believes the bytes, not the header: an SVG called a PNG is refused', async () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
		const got = await fetchTextureUrl('https://example.com/a.png', async () => res(svg, { 'content-type': 'image/png' }));
		expect(got.error).toMatch(/not an image/);
	});
	it('caps the size whether or not the server says it', async () => {
		const declared = await fetchTextureUrl('https://example.com/a.png', async () => res(PNG, { 'content-length': String(core.URL_MAX_BYTES + 1) }));
		expect(declared.error).toMatch(/limit/);
		const big = new Uint8Array(core.URL_MAX_BYTES + 1);
		big.set(PNG);
		const undeclared = await fetchTextureUrl('https://example.com/a.png', async () => res(big));
		expect(undeclared.error).toMatch(/limit/);
	});
	it('says so when CORS or the server refuses, and takes a real image', async () => {
		expect((await fetchTextureUrl('https://example.com/a.png', async () => { throw new TypeError('cors'); })).error).toMatch(/CORS/);
		expect((await fetchTextureUrl('https://example.com/a.png', async () => res(PNG, {}, 404))).error).toMatch(/404/);
		const ok = await fetchTextureUrl('https://example.com/dir/wood%20top.png', async () => res(PNG));
		expect(ok.type).toBe('image/png');
		expect(ok.name).toBe('wood top.png');
	});
	it('lights a map that three would multiply to nothing, unless the call says otherwise', () => {
		expect(core.fieldsForMaps(['metalnessMap'], { metalness: 0 }, {})).toEqual({ metalness: 1 });
		expect(core.fieldsForMaps(['metalnessMap'], { metalness: 0 }, { metalness: 0.2 })).toEqual({});
		expect(core.fieldsForMaps(['emissiveMap'], { emissive: '#000000' }, {})).toEqual({ emissive: '#ffffff' });
		expect(core.fieldsForMaps(['emissiveMap'], { emissive: '#ff0000' }, {})).toEqual({});
	});
});

describe('tiling a payload', () => {
	const payload = () => ({ materials: [{ map: 't1', normalMap: 't1' }], textures: [{ uuid: 't1', repeat: [1, 1], offset: [0, 0], wrap: [1001, 1001] }], images: [] });
	it('turns REPEAT on (a clamped tile smears its border) and keeps a shared texture separate', () => {
		const p = payload();
		const written = core.setPayloadTransform(p, 0, { tiling: [4, 2] }, ['map'], () => 'new');
		expect(written).toEqual(['map']);
		expect(p.materials[0].map).toBe('new');
		expect(p.materials[0].normalMap).toBe('t1');
		const moved = p.textures.find((t) => t.uuid === 'new');
		expect(moved.repeat).toEqual([4, 2]);
		expect(moved.wrap).toEqual([1000, 1000]);
		expect(p.textures.find((t) => t.uuid === 't1').repeat).toEqual([1, 1]);
	});
	it('checks its numbers', () => {
		expect(core.parseUvTransform({ tiling: 3 }).tiling).toEqual([3, 3]);
		expect(core.parseUvTransform({ tiling: [0, 1] }).errors.length).toBe(1);
		expect(core.parseUvTransform({ offset: ['a', 1] }).errors.length).toBe(1);
		expect(core.parseUvTransform({ rotation: 'x' }).errors.length).toBe(1);
	});
	it('a per-face projection fills 0..1, the right way up from the front', () => {
		const v = (x, y, z) => new THREE.Vector3(x, y, z);
		// the +z side of a box, wound outward
		const tris = [[v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1)], [v(-1, -1, 1), v(1, 1, 1), v(-1, 1, 1)]];
		const uvs = core.projectFaceUvs(tris);
		expect(uvs[0][0]).toEqual([0, 0]);
		expect(uvs[0][1]).toEqual([1, 0]);
		expect(uvs[0][2]).toEqual([1, 1]);
		const tiled = core.projectFaceUvs(tris, { tiling: [2, 3], offset: [0.5, 0] });
		expect(tiled[0][2]).toEqual([2.5, 3]);
	});
});

describe('shader graphs', () => {
	const defs = { color: { outputs: [{ name: 'out' }] }, surface: { inputs: [{ name: 'emissive' }] } };
	const check = (g) => core.checkShaderGraph(g, (k) => defs[k], Object.keys(defs));
	it('names the node and what is allowed', () => {
		expect(check({ nodes: [{ id: 'a', type: 'nope' }], edges: [] })[0]).toMatch(/unknown type "nope".*color, surface/);
		const edges = (e) => check({ nodes: [{ id: 'c', type: 'color' }, { id: 's', type: 'surface' }], edges: [e] });
		expect(edges({ source: 'c', target: 's', targetHandle: 'albedoo' })[0]).toMatch(/no input "albedoo" \(emissive\)/);
		expect(edges({ source: 'x', target: 's', targetHandle: 'emissive' })[0]).toMatch(/no node "x"/);
		expect(edges({ source: 'c', sourceHandle: 'r', target: 's', targetHandle: 'emissive' })[0]).toMatch(/no output "r"/);
		expect(edges({ source: 'c', target: 's' })[0]).toMatch(/say which input/);
		expect(edges({ source: 'c', target: 's', targetHandle: 'emissive' })).toEqual([]);
	});
	it('says which uniforms a flow can drive', () => {
		const rows = core.uniformsOf([
			{ name: 'u_f_value', type: 'float', value: 2, nodeId: 'f', param: 'value' },
			{ name: 'u_c_value', type: 'vec3', value: [1, 0, 0], nodeId: 'c', param: 'value' },
			{ name: 'uShaderTime', type: 'float', value: 0, clock: true }
		]);
		expect(rows.map((r) => [r.uniform, r.drivable])).toEqual([['u_f_value', true], ['u_c_value', false]]);
	});
	it('a new wire replaces the one on that input; removing a node takes its wires', () => {
		const g = { nodes: [{ id: 'a', data: { v: 1 } }, { id: 'b' }, { id: 's' }], edges: [{ source: 'a', target: 's', targetHandle: 'x' }] };
		const swapped = core.mergeShaderGraph(g, { nodes: [], edges: [{ source: 'b', target: 's', targetHandle: 'x' }] });
		expect(swapped.edges).toEqual([{ source: 'b', target: 's', targetHandle: 'x' }]);
		expect(core.mergeShaderGraph(g, null, { nodes: ['a'] }).edges).toEqual([]);
	});
	it('create_shader: a bad graph writes nothing, a good one returns its uniform names', async () => {
		const o = box();
		const bad = await call('create_shader', { objects: [o.uuid], text: 'c = colour\nout = surface\nc -> out.emissive' });
		expect(bad.errors[0]).toMatch(/unknown type "colour"/);
		expect(get(sg.shaderGraphs)[o.uuid]).toBeUndefined();
		expect(stack().length).toBe(0);
		const empty = await call('create_shader', { objects: [o.uuid], text: 'out = surface' });
		expect(empty.errors[0]).toMatch(/Nothing is connected/);

		const made = await call('create_shader', { objects: [o.uuid], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		expect(made.error).toBeUndefined();
		expect(made.created[0].shader).toBe(o.uuid);
		expect(made.created[0].nodes.sort()).toEqual(['glow', 'out']);
		const u = made.created[0].uniforms.find((r) => r.node === 'glow');
		expect(u).toMatchObject({ uniform: 'u_glow_value', drivable: true });
		expect(sg.shaderUniform(o.uuid, 'u_glow_value')).toBeTruthy(); // what setuniform writes
		expect(sent.some((m) => m.type === 'shadergraph')).toBe(true);
		expect(stack().length).toBe(1);

		const again = await call('create_shader', { objects: [o.uuid], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		expect(again.skipped[0].reason).toMatch(/already has a shader/);

		history.undo();
		expect(get(sg.shaderGraphs)[o.uuid]).toBeUndefined();
	});
	it('edit_shader: params, text, and a refused edit leaves it as it was', async () => {
		const o = box();
		await call('create_shader', { objects: [o.uuid], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		const edited = await call('edit_shader', { shader: o.uuid, params: [{ node: 'glow', param: 'value', value: 5 }] });
		expect(edited.updated[0].uniforms[0].value).toBe(5);
		const wrong = await call('edit_shader', { shader: o.uuid, params: [{ node: 'glow', param: 'nope', value: 1 }] });
		expect(wrong.errors[0]).toMatch(/no param "nope" \(value\)/);
		const broke = await call('edit_shader', { shader: o.uuid, removeNodes: ['glow'] });
		expect(broke.errors[0]).toMatch(/Nothing is connected/);
		expect(sg.shaderGraphOf(o.uuid).nodes.length).toBe(2);
		const added = await call('edit_shader', { shader: o.uuid, add: 'r = float {value: 0.1}\nr -> out.roughness' });
		expect(added.updated[0].nodes.sort()).toEqual(['glow', 'out', 'r']);
	});
	it('assign_shader copies, and null takes it off with one undo', async () => {
		const a = box('A');
		const b = box('B');
		const baseB = b.material;
		await call('create_shader', { objects: [a.uuid], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		const copied = await call('assign_shader', { objects: [b.uuid], shader: a.uuid });
		expect(copied.updated[0].uuid).toBe(b.uuid);
		expect(sg.isShaderDriven(b.uuid)).toBe(true);
		const off = await call('assign_shader', { objects: [b.uuid], shader: null });
		expect(off.updated[0].shader).toBe(null);
		await sg.compileAndApply(b.uuid);
		expect(b.material).toBe(baseB);
		const nothing = await call('assign_shader', { objects: [b.uuid], shader: null });
		expect(nothing.error).toMatch(/no shader graph/);
	});
	it('set_material refuses a shader-driven object rather than edit a clone the next compile discards', async () => {
		const o = box();
		await call('create_shader', { objects: [o.uuid], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		const r = await call('set_material', { objects: [o.uuid], roughness: 0.2 });
		expect(r.error).toMatch(/wears a shader graph/);
	});
	it('the catalog tool lists a node with its doc and sockets', async () => {
		const r = await lookTool('describe_shader_nodes', { types: ['fresnel'] });
		expect(r.nodes[0].type).toBe('fresnel');
		expect(r.nodes[0].doc.length).toBeGreaterThan(3);
		expect(r.uniforms).toMatch(/setuniform/);
	});
});

describe('set_material', () => {
	it('sets the fields through the same messages as the Inspector, one undo for the call', async () => {
		const a = box('A');
		const b = box('B');
		const r = await call('set_material', { objects: [a.uuid, b.uuid], color: '#ff0000', roughness: 0.25, metalness: 2, emissive: 'orange' });
		expect(r.updated.map((u) => u.uuid)).toEqual([a.uuid, b.uuid]);
		expect(a.material.color.getHexString()).toBe('ff0000');
		expect(a.material.roughness).toBe(0.25);
		expect(a.material.metalness).toBe(1); // clamped
		expect(b.material.emissive.getHexString()).toBe('ffa500');
		expect(sent.filter((m) => m.type === 'objectParameters' && m.parameter === 'materialParam').length).toBe(6);
		expect(stack().length).toBe(1);
		history.undo();
		expect(a.material.roughness).not.toBe(0.25);
		expect(a.material.color.getHexString()).toBe('ffffff');
	});
	it('see-through turns transparent on unless the call says otherwise', async () => {
		const o = box();
		await call('set_material', { objects: [o.uuid], opacity: 0.4 });
		expect(o.material.transparent).toBe(true);
	});
	it('reports what it cannot do, per object, and changes nothing there', async () => {
		const ok = box('OK');
		const basic = box('Basic', new THREE.MeshBasicMaterial());
		const r = await call('set_material', { objects: [ok.uuid, basic.uuid, 'nope'], roughness: 0.3 });
		expect(r.updated.map((u) => u.uuid)).toEqual([ok.uuid]);
		expect(r.skipped.map((s) => s.uuid)).toEqual([basic.uuid, 'nope']);
		expect(r.skipped[0].reason).toMatch(/roughness/);
	});
	it('refuses a raw string map and an empty call before anything moves', async () => {
		const o = box();
		expect((await call('set_material', { objects: [o.uuid], maps: { albedo: 'wood.png' } })).error).toMatch(/neither a library image hash/);
		expect((await call('set_material', { objects: [o.uuid], maps: { albedo: 'https://localhost/a.png' } })).error).toMatch(/local or private/);
		expect((await call('set_material', { objects: [o.uuid], params: { normalMap: 'x' } })).error).toMatch(/texture slots go in maps/);
		expect((await call('set_material', { objects: [o.uuid] })).error).toMatch(/nothing to set/);
		expect((await call('set_material', { objects: [] })).error).toMatch(/objects/);
		expect(stack().length).toBe(0);
	});
	it('a library hash that is not an image is refused', async () => {
		const o = box();
		expect((await call('set_material', { objects: [o.uuid], maps: { normal: 'abcdef0123456789' } })).error).toMatch(/not an image in the library/);
	});
	it('list_materials and get_material read it back, shader included', async () => {
		const o = box('Crate');
		await call('set_material', { objects: [o.uuid], color: '#00ff00', opacity: 0.5 });
		const list = await lookTool('list_materials', {});
		expect(list.objects[0]).toMatchObject({ uuid: o.uuid, name: 'Crate' });
		expect(list.objects[0].slots[0]).toMatchObject({ color: '#00ff00', opacity: 0.5, transparent: true });
		expect(list.presets.length).toBeGreaterThan(0);
		await call('create_shader', { objects: [o.uuid], text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		const one = await lookTool('get_material', { object: o.uuid });
		expect(one.slots[0].color).toBe('#00ff00'); // the base material, not the compiled clone
		expect(one.shader.uniforms[0].uniform).toBe('u_glow_value');
		expect(one.shader.text).toMatch(/glow = float/);
		expect((await lookTool('get_material', { object: 'nope' })).error).toBeTruthy();
	});
});

describe('the Allow / Deny policy', () => {
	it('an agent asks, the connector asks here, a person in their own scene just does it', () => {
		const r = (facts) => confirmCore.confirmRoute({ agentPage: false, connector: false, host: null, amAdmin: false, ...facts });
		expect(r({ agentPage: true, host: 'h' })).toBe('ask');
		expect(r({ agentPage: true })).toBe('apply');
		expect(r({ connector: true })).toBe('local');
		expect(r({})).toBe('apply');
		expect(r({ host: 'h' })).toBe('ask');
		expect(r({ host: 'h', amAdmin: true })).toBe('apply');
		expect(r({ host: 'h', amAdmin: true, connector: true })).toBe('local');
	});
	it('asks the host and the admins, never itself or another agent', () => {
		const t = confirmCore.confirmTargets({ host: 'h', me: 'me', open: ['h', 'a', 'e', 'bot', 'me'], roleOf: (id) => ({ a: 'admin', bot: 'admin', me: 'admin', e: 'editor' })[id], isAgent: (id) => id === 'bot' });
		expect(t.sort()).toEqual(['a', 'h']);
		expect(confirmCore.confirmTargets({ host: 'gone', me: 'me', open: ['e'] })).toEqual([]);
	});
	it('refuses a viewer and a flood; a summary is one capped line', () => {
		expect(confirmCore.askRefusal({ role: 'viewer', pending: 0, summary: 'x' })).toMatch(/view-only/);
		expect(confirmCore.askRefusal({ role: 'editor', pending: confirmCore.CONFIRM_MAX_PENDING, summary: 'x' })).toMatch(/too many/);
		expect(confirmCore.askRefusal({ role: null, pending: 0, summary: 'x' })).toBe(null);
		expect(confirmCore.cleanSummary('a\nb' + 'c'.repeat(500)).length).toBe(confirmCore.CONFIRM_SUMMARY_MAX);
		expect(confirmCore.cleanSummary('a\nb')).toBe('a b');
	});
});

/** an agent page joined to host `h` over a recording conn */
function asAgent() {
	agentPage.on = true;
	sessionHost.set('h');
	const out = [];
	peers.set({ send: (m) => sent.push(m), peer: { id: 'me' }, connections: { h: { open: true, send: (m) => out.push(m) } } });
	return out;
}

describe('set_post', () => {
	it('a person in their own scene: applied, one undo step, one message', async () => {
		const r = await call('set_post', { effects: [{ kind: 'bloom', params: { intensity: 2 } }, { kind: 'vignette' }] });
		expect(r.effects.map((e) => e.kind)).toEqual(['bloom', 'vignette']);
		expect(r.effects[0].id).toBeTruthy();
		expect(r.effects[0].params.intensity).toBe(2);
		expect(stack().length).toBe(1);
		expect(sent.filter((m) => m.type === 'scenepost').length).toBe(1);
		history.undo();
		expect(scenePost.postStackFor('scene').effects.length).toBe(0);
	});
	it('matches by kind, so a retry adjusts instead of stacking a second bloom; replace drops the rest', async () => {
		await call('set_post', { effects: [{ kind: 'bloom' }, { kind: 'grain' }] });
		const again = await call('set_post', { effects: [{ kind: 'bloom', params: { intensity: 3 } }] });
		expect(again.effects.filter((e) => e.kind === 'bloom').length).toBe(1);
		const only = await call('set_post', { replace: true, effects: [{ kind: 'vignette' }] });
		expect(only.effects.map((e) => e.kind)).toEqual(['vignette']);
		const removed = await call('set_post', { effects: [{ kind: 'vignette', remove: true }] });
		expect(removed.effects).toEqual([]);
	});
	it('refuses what the registry does not know, before asking anyone', async () => {
		asAgent();
		const out = await call('set_post', { effects: [{ kind: 'lensflare' }] });
		expect(out.errors[0]).toMatch(/unknown kind "lensflare".*bloom/);
		const param = await call('set_post', { effects: [{ kind: 'bloom', params: { sparkle: 1 } }] });
		expect(param.errors[0]).toMatch(/no param "sparkle"/);
		expect((await call('set_post', {})).error).toMatch(/nothing to set/);
		expect(get(toastStore).length).toBe(0);
	});
	it('an agent: nothing changes until the host allows; the allowed call is the one undo step + the ids', async () => {
		const out = asAgent();
		const asked = await call('set_post', { effects: [{ kind: 'bloom', params: { intensity: 2 } }] });
		expect(asked.needsConfirm).toBe(true);
		expect(asked.summary).toMatch(/add bloom/);
		expect(out[0]).toMatchObject({ type: 'agentconfirmreq', id: asked.confirmId, tool: 'set_post' });
		expect(scenePost.postStackFor('scene').effects.length).toBe(0);
		expect(stack().length).toBe(0);
		expect(summarizeToolCall('set_post', {}, asked)).toBe(null); // no A8 line for a question

		const pending = await call('set_post', { confirmId: asked.confirmId });
		expect(pending.needsConfirm).toBe(true);

		// someone not asked cannot answer
		confirmGate.handleConfirmRelay('stranger', { type: 'agentconfirmans', id: asked.confirmId, allow: true });
		expect((await call('set_post', { confirmId: asked.confirmId })).needsConfirm).toBe(true);

		confirmGate.handleConfirmRelay('h', { type: 'agentconfirmans', id: asked.confirmId, allow: true });
		const applied = await call('set_post', { confirmId: asked.confirmId });
		expect(applied.effects[0].kind).toBe('bloom');
		expect(applied.effects[0].id).toBeTruthy();
		expect(stack().length).toBe(1);
		expect(summarizeToolCall('set_post', {}, applied)).toMatch(/bloom/);

		const twice = await call('set_post', { confirmId: asked.confirmId });
		expect(twice.alreadyApplied).toBe(true);
		expect(stack().length).toBe(1);
		history.undo();
		expect(scenePost.postStackFor('scene').effects.length).toBe(0);
	});
	it('a Deny leaves it as it was, and wait wakes on the answer', async () => {
		asAgent();
		const asked = await call('set_post', { enabled: false });
		setTimeout(() => confirmGate.handleConfirmRelay('h', { type: 'agentconfirmans', id: asked.confirmId, allow: false }), 20);
		const t0 = Date.now();
		const denied = await call('set_post', { confirmId: asked.confirmId, wait: 30 });
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(denied.denied).toBe(true);
		expect(stack().length).toBe(0);
	});
	it('with no host to ask it says so', async () => {
		agentPage.on = true;
		sessionHost.set('h');
		const r = await call('set_post', { enabled: false });
		expect(r.error).toMatch(/not connected/);
	});
	it('the asked side shows Allow / Deny and answers once; a viewer gets no prompt', async () => {
		const out = [];
		peers.set({ send: () => {}, peer: { id: 'host' }, connections: { bot: { open: true, send: (m) => out.push(m) } } });
		confirmGate.handleConfirmRelay('bot', { type: 'agentconfirmreq', id: 'c1', tool: 'set_post', summary: 'post effects: add bloom' });
		const toast = get(toastStore)[0];
		expect(toast.text).toMatch(/add bloom/);
		expect(toast.actions.map((a) => a.label)).toEqual(['Allow', 'Deny']);
		toast.actions[0].action();
		toast.actions[1].action();
		expect(out).toEqual([{ type: 'agentconfirmans', id: 'c1', allow: true }]);
	});
	it('create_shader scene:true and create_post_graph go through the same question', async () => {
		const out = asAgent();
		const s = await call('create_shader', { scene: true, text: 'glow = float {value: 2}\nout = surface\nglow -> out.emissive' });
		expect(s.needsConfirm).toBe(true);
		expect(get(sg.shaderGraphs).scene).toBeUndefined();
		confirmGate.handleConfirmRelay('h', { type: 'agentconfirmans', id: s.confirmId, allow: true });
		const applied = await call('create_shader', { confirmId: s.confirmId });
		expect(applied.created[0].scene).toBe(true);
		expect(get(sg.shaderGraphs).scene).toBeTruthy();
		const g = await call('create_post_graph', { preset: 'posterise' });
		expect(g.needsConfirm).toBe(true);
		expect(out.length).toBe(2);
		const badText = await call('create_post_graph', { text: 'out = postOutput' });
		expect(badText.errors[0]).toMatch(/Nothing is connected/);
	});
});

describe('uv', () => {
	it('smart keeps a flat side on one island and proportions true', () => {
		const faces = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
		const pos = faces.attributes.position;
		const list = [];
		for (let i = 0; i < pos.count; i += 3) list.push({ corners: [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, i + k)), tri: i / 3 });
		const r = unwrap('smart', list);
		expect(r.islands.length).toBe(6);
		for (const tri of r.uvs) for (const [u, v] of tri) expect(u >= 0 && u <= 1 && v >= 0 && v <= 1).toBe(true);
	});
	it('uv_unwrap commits through meshgeo, one undo', async () => {
		const o = box();
		// a mesh edit stores triangles unindexed, so undo gives back the same corners in that form
		const before = o.geometry.toNonIndexed().attributes.uv.array.slice();
		const r = await call('uv_unwrap', { objects: [o.uuid], method: 'box' });
		expect(r.updated[0]).toMatchObject({ uuid: o.uuid, ok: true });
		expect(sent.some((m) => m.type === 'meshgeo')).toBe(true);
		expect(stack().length).toBe(1);
		history.undo();
		expect(Array.from(o.geometry.attributes.uv.array)).toEqual(Array.from(before));
		expect((await call('uv_unwrap', { objects: [o.uuid], method: 'magic' })).error).toMatch(/box, planar, smart/);
	});
	it('set_uv refuses a slot with no texture and reads its numbers first', async () => {
		const o = box();
		expect((await call('set_uv', { objects: [o.uuid], tiling: 2 })).error).toMatch(/no texture/);
		expect((await call('set_uv', { objects: [o.uuid] })).error).toMatch(/nothing to set/);
		expect((await call('set_uv', { objects: [o.uuid], tiling: [0, 1] })).error).toMatch(/tiling/);
		expect(stack().length).toBe(0);
	});
	it('per-face: only the picked side changes, the others keep their UVs, one undo', async () => {
		const o = box();
		const r = await call('set_uv', { objects: [o.uuid], faces: { normal: 'up' }, tiling: 2 });
		expect(r.updated[0].triangles).toBe(2);
		expect(sent.some((m) => m.type === 'meshgeo')).toBe(true);
		const pos = o.geometry.attributes.position;
		const uv = o.geometry.attributes.uv;
		const top = [];
		for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i) - 1) < 1e-6) top.push(i);
		const us = top.map((i) => uv.getX(i));
		expect(Math.max(...us)).toBeGreaterThan(1.5); // tiled twice somewhere on top
		expect(stack().length).toBe(1);
		const none = await call('set_uv', { objects: [o.uuid], faces: { normal: 'up', box: { min: [9, 9, 9], max: [10, 10, 10] } } });
		expect(none.error).toMatch(/picks nothing/);
	});
});

describe('the registry', () => {
	it('every tool has a schema, the read ones are open to a viewer, the rest refused', () => {
		const names = LOOK_AI_TOOLS.map((t) => t.function.name);
		expect(names.sort()).toEqual([...LOOK_TOOL_NAMES].sort());
		for (const n of LOOK_READ_TOOLS) {
			expect(viewerToolRefusal(n, true), n).toBe(null);
			expect(READ_ONLY_TOOLS.has(n), n).toBe(true);
		}
		for (const n of LOOK_TOOL_NAMES.filter((t) => !LOOK_READ_TOOLS.includes(t))) {
			expect(viewerToolRefusal(n, true)?.viewOnly, n).toBe(true);
			expect(READ_ONLY_TOOLS.has(n), n).toBe(false);
		}
	});
	it('one A8 line per call, none for a read', () => {
		expect(summarizeToolCall('list_materials', {}, { objects: [] })).toBe(null);
		expect(summarizeToolCall('set_material', {}, { updated: [{ uuid: 'a', ok: true, maps: ['albedo', 'normal'] }] }, () => 'Crate')).toMatch(/textured 1 object \(Crate\).*albedo/);
		expect(summarizeToolCall('create_shader', {}, { created: [{ uuid: 'a' }] }, () => 'Sign')).toMatch(/gave 1 object a shader \(Sign\)/);
		expect(summarizeToolCall('assign_shader', { shader: null }, { updated: [{ ok: true }] })).toMatch(/took the shader off/);
		expect(summarizeToolCall('set_post', {}, { effects: [{ kind: 'bloom' }] })).toMatch(/bloom/);
		expect(summarizeToolCall('uv_unwrap', { method: 'box' }, { updated: [{}] })).toMatch(/\(box\)/);
		expect(summarizeToolCall('set_uv', { faces: {} }, { updated: [{}] })).toMatch(/mapped faces/);
	});
});
