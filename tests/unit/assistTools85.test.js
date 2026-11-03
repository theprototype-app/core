// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// Roadmap 85 (owner's 85a additions): undo_last, set_pivot, create_pivot, add_image.
// Handlers on a real objectsGroup, the real history and a recording peer; the A8 recorder driven through
// its observer seam exactly as executeAiTool drives it. Mocked only because they reach
// `geometries.svelte.js` (runes need the svelte compiler): createGroup, objectActions, physics, tools.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get, writable } from 'svelte/store';

const sim = writable(null);
const shapeChanged = vi.fn();
let observer = null;
vi.mock('$lib/physics', () => ({ physicsShapeChanged: (u) => shapeChanged(u), remoteSimulating: sim }));
vi.mock('../../src/lib/physics.js', () => ({ physicsShapeChanged: (u) => shapeChanged(u), remoteSimulating: sim }));
vi.mock('../../src/lib/ai/tools.js', () => ({ setAiToolObserver: (fn) => (observer = fn) }));
vi.mock('../../src/lib/agent/agentInbox.js', () => ({ agentInbox: () => ({ state: () => ({}) }) }));
vi.mock('$lib/geometries.svelte.js', () => ({
	createGroup: () => {
		const g = new THREE.Group();
		get(objectsGroup).add(g);
		return g.uuid;
	}
}));
vi.mock('$lib/objectActions', () => ({
	renameObject: (uuid, name) => (get(objectsGroup).getObjectByProperty('uuid', uuid).name = name),
	moveObjectToGroup: (uuid, target) => {
		const root = get(objectsGroup);
		const o = root.getObjectByProperty('uuid', uuid);
		const from = o.parent.uuid;
		root.getObjectByProperty('uuid', target).attach(o);
		get(peers).send({ type: 'group', uuid, group: target });
		history.recordEntry({ kind: 'group', uuid, before: { parent: from }, after: { parent: target } });
	}
}));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const history = await import('../../src/lib/history.js');
const { agentLog } = await import('../../src/lib/agentLog.js');
const { notePeerActivity, dropPeerFacts } = await import('../../src/lib/peerFacts.js');
const recorder = await import('../../src/lib/agentLogRecorder.js');
const { assistTool, ASSIST_AI_TOOLS, ASSIST_TOOL_NAMES } = await import('../../src/lib/ai/assistTools.js');
const { aboutOriginPosition, originWorld, setOriginFor } = await import('../../src/lib/objectOrigin.js');
const core = await import('../../src/lib/undoLastCore.js');
const img = await import('../../src/lib/ai/imageToolCore.js');
const { summarizeToolCall, touchedUuids } = await import('../../src/lib/agentLogCore.js');
const { createAgentCore } = await import('../../src/lib/agent/agentCore.js');
const { TOOL_ANNOTATIONS, connectorInstructions } = await import('../../tools/agent/src/catalog.js');

history.registerHistoryKind('group', (entry, state) => {
	const root = get(objectsGroup);
	const o = root.getObjectByProperty('uuid', entry.uuid);
	const to = state.parent === root.uuid ? root : root.getObjectByProperty('uuid', state.parent);
	to.attach(o);
	return true;
});
// the 'props' kind lives in objectActions (mocked): the origin half of it
history.registerHistoryKind('props', (entry, state) => {
	const o = get(objectsGroup).getObjectByProperty('uuid', entry.uuid);
	if (state.origin) o.userData.origin = state.origin;
	else delete o.userData.origin;
	return true;
});

let sent = [];
let group;
beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	peers.set({ peer: { id: 'agent' }, send: (m) => sent.push(m) });
	history.undoStack.set([]);
	agentLog.set([]);
	recorder.resetAgentRecorder();
	shapeChanged.mockClear();
	dropPeerFacts('host');
	sim.set(null);
});

const box = (name = 'Box', pos = [0, 0, 0]) => {
	const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
	m.name = name;
	m.position.fromArray(pos);
	group.add(m);
	return m;
};
const live = (uuid) => group.getObjectByProperty('uuid', uuid);
const close = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < 1e-6);

/** one exec: the batch + the observer, what agentCore + executeAiTool do */
async function call(tool, args, body) {
	const done = observer?.(tool, args);
	history.beginHistoryBatch();
	const result = await body();
	history.endHistoryBatch('Agent: ' + tool);
	await done?.(result);
	return result;
}
const move = (m, to) => {
	const before = { pos: m.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] };
	m.position.fromArray(to);
	history.recordTransform({ uuid: m.uuid, before, after: { pos: to, rot: [0, 0, 0], scale: [1, 1, 1] } });
};
const moveCall = (m, to) => call('update_objects', { updates: [{ uuid: m.uuid, position: to }] }, () => (move(m, to), { updated: [{ uuid: m.uuid, ok: true }] }));
const undoLast = (args = {}) => call('undo_last', args, () => assistTool('undo_last', args));

describe('undo_last on the A8 recorder', () => {
	beforeEach(() => {
		recorder.stopAgentRecorder();
		recorder.startAgentRecorder();
	});

	it('takes back only the last call, newest first; the line is marked undone', async () => {
		const a = box('A');
		await moveCall(a, [1, 0, 0]);
		await moveCall(a, [2, 0, 0]);
		const r = await undoLast();
		expect(r.undone.length).toBe(1);
		expect(a.position.x).toBe(1);
		const again = await undoLast();
		expect(again.undone.length).toBe(1);
		expect(a.position.x).toBe(0);
		expect(get(agentLog).filter((l) => l.tool === 'update_objects').every((l) => l.undone)).toBe(true);
	});

	it('count takes back several as one call, with one log line of its own', async () => {
		const a = box('A');
		for (const x of [1, 2, 3]) await moveCall(a, [x, 0, 0]);
		const before = get(agentLog).length;
		const r = await undoLast({ count: 2 });
		expect(r.count).toBe(2);
		expect(a.position.x).toBe(1);
		expect(get(agentLog).filter((l) => l.tool === 'undo_last').length).toBe(1);
		expect(get(agentLog).length).toBe(before + 1);
		expect(get(agentLog).find((l) => l.tool === 'undo_last').undoable).toBe(false);
	});

	it('COUNTERFACTUAL: a peer who edited the object since refuses it, whole; nothing changes', async () => {
		const a = box('Lamp');
		const b = box('Rock');
		await moveCall(b, [5, 0, 0]);
		await moveCall(a, [1, 0, 0]);
		await new Promise((r) => setTimeout(r, 5));
		notePeerActivity('host', { type: 'color', uuid: b.uuid });
		// the newest call touched only the lamp: alone it goes through…
		const r1 = await undoLast({ count: 2 });
		expect(r1.refused).toBe(true);
		expect(r1.conflicts[0]).toMatchObject({ uuid: b.uuid, name: 'Rock', what: 'recoloured' });
		expect(r1.error).not.toContain(b.uuid); // said out loud
		expect(a.position.x).toBe(1); // …but this asked for both, and a refusal is all or nothing
		expect(b.position.x).toBe(5);
		const r2 = await undoLast();
		expect(r2.undone.length).toBe(1);
		expect(a.position.x).toBe(0);
	});

	it('an edit from BEFORE the call is no conflict; nor is the host simulation streaming moves', async () => {
		const a = box('A');
		notePeerActivity('host', { type: 'color', uuid: a.uuid });
		await new Promise((r) => setTimeout(r, 5));
		await moveCall(a, [1, 0, 0]);
		await new Promise((r) => setTimeout(r, 5));
		sim.set('host');
		notePeerActivity('host', { type: 'move', uuid: a.uuid });
		expect((await undoLast()).undone.length).toBe(1);
	});

	it('a person at this tab who edited the same object since (connector) refuses too; a different object does not', async () => {
		const a = box('A');
		const other = box('Other');
		await moveCall(a, [1, 0, 0]);
		move(other, [9, 0, 0]);
		await moveCall(a, [2, 0, 0]);
		move(a, [7, 0, 0]); // the person
		const r = await undoLast();
		expect(r.refused).toBe(true);
		expect(a.position.x).toBe(7);
		history.undo(); // they took their own edit back
		const ok = await undoLast();
		expect(ok.undone.length).toBe(1);
		expect(other.position.x).toBe(9);
	});

	it('steps the person already undid (Ctrl+Z) are skipped, never undone twice', async () => {
		const a = box('A');
		await moveCall(a, [1, 0, 0]);
		await moveCall(a, [2, 0, 0]);
		history.undo();
		expect(a.position.x).toBe(1);
		await undoLast();
		expect(a.position.x).toBe(0);
		expect((await undoLast()).undone).toEqual([]);
	});

	it('a viewer-safe answer when there is nothing: no error, no log line', async () => {
		const r = await undoLast();
		expect(r.undone).toEqual([]);
		expect(get(agentLog).length).toBe(0);
	});

	it('a call right before it counts: its line may still be settling', async () => {
		const a = box('A');
		const done = observer('update_objects', {});
		history.beginHistoryBatch();
		move(a, [1, 0, 0]);
		history.endHistoryBatch('Agent: update_objects');
		done({ updated: [{ uuid: a.uuid, ok: true }] }); // not awaited: the result went out
		const r = await assistTool('undo_last', {});
		expect(r.undone?.length).toBe(1);
		expect(a.position.x).toBe(0);
	});
});

describe('undo_last for the in-app assistant (no recorder)', () => {
	beforeEach(() => recorder.stopAgentRecorder());
	const prompt = (m, to) => {
		history.beginHistoryBatch();
		move(m, to);
		history.endHistoryBatch('AI: move it');
	};

	it('takes back the last prompt; a person\'s edit above it of the same object refuses', async () => {
		const a = box('A');
		prompt(a, [1, 0, 0]);
		move(a, [4, 0, 0]);
		const r = await assistTool('undo_last', {});
		expect(r.refused).toBe(true);
		expect(r.conflicts[0].by).toBe('you');
		history.undo();
		expect((await assistTool('undo_last', {})).undone[0].text).toBe('move it');
		expect(a.position.x).toBe(0);
	});

	it('never touches a person\'s own steps', async () => {
		const a = box('A');
		move(a, [4, 0, 0]);
		expect((await assistTool('undo_last', {})).undone).toEqual([]);
		expect(a.position.x).toBe(4);
	});
});

describe('agentCore runs undo_last with no batch of its own', () => {
	it('COUNTERFACTUAL: begin/end batch wrap an edit, not undo_last', async () => {
		const begun = [];
		const c = createAgentCore({
			appVersion: 't', getTools: () => [], runTool: async () => ({ ok: 1 }), resolveName: (n, a) => ({ name: n, args: a }), systemPrompt: () => '', summarize: () => ({}),
			beginBatch: () => begun.push('begin'), endBatch: (l) => begun.push(l), peerId: () => 'a', role: () => 'editor', rolesSettled: () => true, host: () => null, behaviourErrors: () => [],
			hostAway: () => null, loading: () => null, room: () => null, waiting: () => false, openPeers: () => [], inVR: () => false, missingTools: () => [], missingModules: () => [],
			onSceneChange: () => () => {}, screenshot: async () => null, leave: async () => {}, extraTools: {}, inSession: () => true
		});
		await c.agent.exec('undo_last', {});
		expect(begun).toEqual([]);
		await c.agent.exec('update_objects', {});
		expect(begun).toEqual(['begin', 'Agent: update_objects']);
	});
});

describe('set_pivot', () => {
	it('at: a world point, through the origin message; the object does not move; one undo clears it', async () => {
		const m = box('Head', [0, 2, 0]);
		history.beginHistoryBatch();
		const r = await assistTool('set_pivot', { updates: [{ uuid: m.uuid, at: [0, 1.5, 0] }] });
		history.endHistoryBatch('Agent: set_pivot');
		expect(r.updated[0]).toMatchObject({ ok: true, pivot: [0, 1.5, 0], local: [0, -0.5, 0] });
		expect(m.position.toArray()).toEqual([0, 2, 0]);
		expect(sent.find((s) => s.type === 'objectParameters')).toMatchObject({ parameter: 'origin', uuid: m.uuid, origin: [0, -0.5, 0] });
		expect(shapeChanged).toHaveBeenCalledWith(m.uuid);
		expect(get(history.undoStack).length).toBe(1);
		history.undo();
		expect(m.userData.origin).toBeUndefined();
	});

	it('preset, local, reset; a row with two answers, a bad preset and a gone object each say so', async () => {
		const m = box('Lamp');
		expect((await assistTool('set_pivot', { updates: [{ uuid: m.uuid, preset: 'bottom' }] })).updated[0].local).toEqual([0, -0.5, 0]);
		expect((await assistTool('set_pivot', { updates: [{ uuid: m.uuid, local: [0.5, 0, 0] }] })).updated[0].local).toEqual([0.5, 0, 0]);
		expect((await assistTool('set_pivot', { updates: [{ uuid: m.uuid, reset: true }] })).updated[0].local).toBe(null);
		const r = await assistTool('set_pivot', { updates: [{ uuid: m.uuid, at: [0, 0, 0], local: [0, 0, 0] }, { uuid: m.uuid, preset: 'nose' }, { uuid: 'gone', at: [0, 0, 0] }] });
		expect(r.error).toMatch(/exactly one/);
		expect(r.updated[1].error).toMatch(/preset/);
		expect(r.updated[2].error).toMatch(/no object/);
		expect((await assistTool('set_pivot', { updates: [{ uuid: m.uuid, at: [0, 'x', 0] }] })).error).toMatch(/\[x, y, z\]/);
	});

	it('COUNTERFACTUAL: turning an object with a pivot keeps the pivot where it was (the head nods at the neck)', () => {
		const m = box('Head', [0, 2, 0]);
		m.scale.set(2, 2, 2);
		setOriginFor(m.uuid, [0, -0.5, 0]); // the neck, 1 m under its centre at scale 2
		const had = [m.quaternion.clone(), m.scale.clone()];
		const neck = originWorld(m).toArray();
		m.rotation.set(Math.PI / 2, 0, 0);
		m.scale.set(3, 3, 3);
		aboutOriginPosition(m, had[0], had[1]);
		expect(close(originWorld(m).toArray(), neck)).toBe(true);
		expect(m.position.y).not.toBe(2);
	});

	it('no pivot: a rotation moves nothing', () => {
		const m = box('A', [1, 2, 3]);
		const had = [m.quaternion.clone(), m.scale.clone()];
		m.rotation.set(1, 0, 0);
		aboutOriginPosition(m, had[0], had[1]);
		expect(m.position.toArray()).toEqual([1, 2, 3]);
	});
});

describe('create_pivot', () => {
	it('a group at the point holding the objects, which stay put in the world; ids returned; one undo', async () => {
		const a = box('Upper', [1, 2, 0]);
		const b = box('Lower', [1, 1, 0]);
		history.beginHistoryBatch();
		const r = await assistTool('create_pivot', { objects: [a.uuid, b.uuid, a.uuid], at: [1, 2.5, 0], name: 'Shoulder' });
		history.endHistoryBatch('Agent: create_pivot');
		const g = live(r.groupUuid);
		expect(g.name).toBe('Shoulder');
		expect(g.position.toArray()).toEqual([1, 2.5, 0]);
		expect(a.parent).toBe(g);
		expect(close(a.getWorldPosition(new THREE.Vector3()).toArray(), [1, 2, 0])).toBe(true);
		expect(r.members).toEqual([a.uuid, b.uuid]);
		expect(sent.find((s) => s.type === 'move' && s.uuid === r.groupUuid).pos).toEqual([1, 2.5, 0]);
		// turning the group swings them about that point
		g.rotation.z = Math.PI;
		g.updateMatrixWorld(true);
		expect(close(a.getWorldPosition(new THREE.Vector3()).toArray(), [1, 3, 0])).toBe(true);
		expect(get(history.undoStack).length).toBe(1);
		g.rotation.z = 0;
		history.undo();
		expect(a.parent).toBe(group);
		expect(live(r.groupUuid)).toBeUndefined();
	});

	it('named points measure the objects; parts of one model stay inside it', async () => {
		const lamp = new THREE.Group();
		group.add(lamp);
		const a = box('Shade', [0, 2, 0]);
		lamp.attach(a);
		const r = await assistTool('create_pivot', { objects: [a.uuid], at: 'bottom' });
		expect(r.at).toEqual([0, 1.5, 0]);
		expect(r.parentUuid).toBe(lamp.uuid);
		expect(live(r.groupUuid).parent).toBe(lamp);
	});

	it('refuses with nothing to hold or nowhere to go, and makes no group', async () => {
		const a = box('A');
		const count = group.children.length;
		expect((await assistTool('create_pivot', { objects: ['gone'], at: [0, 0, 0] })).error).toMatch(/no object/);
		expect((await assistTool('create_pivot', { objects: [a.uuid] })).error).toMatch(/at:/);
		expect((await assistTool('create_pivot', { objects: [a.uuid], at: 'elsewhere' })).error).toMatch(/at:/);
		expect(group.children.length).toBe(count);
	});
});

describe('add_image: the rules', () => {
	const png = (w = 2, h = 2) => {
		const b = new Uint8Array(40);
		b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
		new DataView(b.buffer).setUint32(16, w);
		new DataView(b.buffer).setUint32(20, h);
		return b;
	};
	const text = (s) => new TextEncoder().encode(s);

	it('COUNTERFACTUAL: https only, no logins, nothing on this machine or its network', () => {
		expect(img.checkImageUrl('https://example.com/a.png')).toEqual({ url: 'https://example.com/a.png' });
		for (const bad of ['http://example.com/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'javascript:alert(1)', 'nope', 'https://me:pw@example.com/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.8/a.png', 'https://192.168.1.1/a.png', 'https://172.16.0.1/a.png', 'https://169.254.169.254/latest', 'https://[::1]/a.png', 'https://printer.local/a.png'])
			expect(img.checkImageUrl(bad).error, bad).toBeTruthy();
		expect(img.checkImageUrl('https://172.32.0.1/a.png').url).toBeTruthy();
	});

	it('the bytes decide: a web page, an SVG and an empty file are refused by name', () => {
		expect(img.sniffImage(png())).toEqual({ mime: 'image/png' });
		expect(img.sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')).error).toMatch(/SVG/);
		expect(img.sniffImage(text('<!doctype html><html>login</html>')).error).toMatch(/web page/);
		expect(img.sniffImage(text('hello there, a plain text')).error).toMatch(/not a PNG/);
		expect(img.sniffImage(new Uint8Array(0)).error).toMatch(/empty/);
		expect(img.sniffImage(new Uint8Array(img.MAX_INPUT_BYTES + 1)).error).toMatch(/limit/);
	});

	it('a decompression bomb is refused from its header, before it is decoded', () => {
		expect(img.pixelRefusal(png(), 'image/png')).toBe(null);
		expect(img.pixelRefusal(png(20000, 20000), 'image/png')).toMatch(/megapixels/);
		const jpeg = new Uint8Array(30);
		jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x4e, 0x20, 0x4e, 0x20]);
		expect(img.pixelRefusal(jpeg, 'image/jpeg')).toMatch(/megapixels/);
		const gif = new Uint8Array(30);
		gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x4e, 0x20, 0x4e]);
		expect(img.pixelRefusal(gif, 'image/gif')).toMatch(/megapixels/);
	});

	it('the long side is capped, the aspect kept', () => {
		expect(img.outputSize(100, 50)).toEqual({ w: 100, h: 50, scaled: false });
		expect(img.outputSize(8192, 4096)).toEqual({ w: 4096, h: 2048, scaled: true });
	});

	it('the provenance keeps no query string (it can hold a token)', () => {
		expect(img.sourceOfUrl('https://cdn.example.com/a/b.png?token=SECRET#x')).toBe('https://cdn.example.com/a/b.png');
	});
});

describe('add_image: the canvas is data', () => {
	it('colours are hex or names, never a function', () => {
		expect(img.canvasColor('#336699')).toBe('#336699');
		expect(img.canvasColor('white')).toBe('white');
		for (const bad of ['url(javascript:alert(1))', 'rgb(1,2,3)', '#12', 7, null]) expect(img.canvasColor(bad)).toBe(null);
	});

	it('each bad op is named; the caps hold', () => {
		expect(img.parseCanvas({ width: 4096, height: 4 }).error).toMatch(/2048/);
		expect(img.parseCanvas({ width: 4, height: 4 }).error).toMatch(/nothing to draw/);
		expect(img.parseCanvas({ width: 4, height: 4, ops: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'url(x)' }] }).error).toMatch(/ops\[0\]: fill/);
		expect(img.parseCanvas({ width: 4, height: 4, ops: [{ op: 'script', code: 'alert(1)' }] }).error).toMatch(/unknown op/);
		expect(img.parseCanvas({ width: 4, height: 4, ops: Array(501).fill({ op: 'checker', colors: ['red', 'blue'] }) }).error).toMatch(/at most 500/);
		expect(img.parseCanvas({ width: 4, height: 4, ops: Array(5).fill({ op: 'noise' }) }).error).toMatch(/noise/);
		expect(img.parseCanvas({ width: 4, height: 4, background: 'white' }).ops).toEqual([]);
	});

	it('noise is seeded (the same on every machine), differs by seed, and tiles at the edges', () => {
		const o = { scale: 4, octaves: 3, seed: 7 };
		const a = img.noiseField(64, 64, o);
		expect(img.noiseField(64, 64, o)).toEqual(a);
		expect(img.noiseField(64, 64, { ...o, seed: 8 })).not.toEqual(a);
		expect(Math.max(...a)).toBeLessThanOrEqual(1);
		// the step across the seam is no larger than the steps beside it
		const row = (x) => a[10 * 64 + x];
		const seam = Math.abs(row(63) - row(0));
		const inside = Math.max(...Array.from({ length: 62 }, (_, i) => Math.abs(row(i) - row(i + 1))));
		expect(seam).toBeLessThanOrEqual(inside * 1.5);
	});

	it('draws the ops in order on a context', () => {
		const calls = [];
		const ctx = new Proxy(
			{ fillStyle: '' },
			{
				get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])),
				set: (t, k, v) => ((t[k] = v), true)
			}
		);
		const spec = img.parseCanvas({ width: 8, height: 8, background: '#000', ops: [{ op: 'checker', cols: 2, rows: 2, colors: ['red', 'blue'] }, { op: 'circle', x: 4, y: 4, r: 2, fill: 'red' }, { op: 'text', text: 'Hi', x: 1, y: 1 }] });
		img.drawCanvas(ctx, spec);
		expect(calls.filter((c) => c[0] === 'fillRect').length).toBe(5);
		expect(calls.some((c) => c[0] === 'arc')).toBe(true);
		expect(calls.find((c) => c[0] === 'fillText')).toEqual(['fillText', 'Hi', 1, 1]);
	});
});

describe('the tool contract', () => {
	it('every tool has a schema in the shared registry, limits and catalog words', () => {
		expect(ASSIST_AI_TOOLS.map((t) => t.function.name)).toEqual(ASSIST_TOOL_NAMES);
		for (const n of ASSIST_TOOL_NAMES) expect(TOOL_ANNOTATIONS[n]?.title, n).toBeTruthy();
		expect(connectorInstructions(['undo_last'])).toMatch(/undo_last/);
		expect(connectorInstructions(['status'])).not.toMatch(/undo_last/);
	});

	it('one A8 line each, in words; a part of an upload and an empty undo get none', () => {
		expect(summarizeToolCall('undo_last', {}, { undone: [{ text: 'moved Lamp' }] })).toBe('undid “moved Lamp”');
		expect(summarizeToolCall('undo_last', {}, { undone: [{}, {}] })).toBe('undid 2 of its calls');
		expect(summarizeToolCall('undo_last', {}, { undone: [] })).toBe(null);
		expect(summarizeToolCall('undo_last', {}, { error: 'not undone: x', undone: [] })).toMatch(/^tried undo last/);
		expect(summarizeToolCall('set_pivot', {}, { updated: [{ uuid: 'a', ok: true }] }, () => 'Head')).toBe('set the pivot of 1 object (Head)');
		expect(summarizeToolCall('create_pivot', {}, { name: 'Neck', members: ['a', 'b'] })).toBe('made a pivot (Neck) for 2 objects');
		expect(summarizeToolCall('add_image', {}, { name: 'wood.png' })).toBe('added the image wood.png');
		expect(summarizeToolCall('add_image', {}, { partial: true, received: 1, of: 3 })).toBe(null);
		expect(touchedUuids('create_pivot', {}, { groupUuid: 'g', members: ['a'] })).toEqual(['g', 'a']);
	});
});

describe('undoLastCore', () => {
	it('entryUuids walks composites and sets', () => {
		const e = { kind: 'aibatch', entries: [{ uuid: 'a' }, { kind: 'transformSet', items: [{ uuid: 'b' }] }, { kind: 'gesture', entries: [{ uuid: 'c' }] }] };
		expect([...core.entryUuids(e)].sort()).toEqual(['a', 'b', 'c']);
	});
	it('undoCount clamps', () => {
		expect([core.undoCount(undefined), core.undoCount(0), core.undoCount(3.7), core.undoCount(999)]).toEqual([1, 1, 3, core.UNDO_LAST_MAX]);
	});
	it('conflictWords caps the list and names no uuid', () => {
		const list = ['a', 'b', 'c', 'd'].map((uuid) => ({ uuid, name: 'N' + uuid, by: 'Sam', what: 'moved' }));
		const w = core.conflictWords(list);
		expect(w).toMatch(/Na \(Sam moved it\)/);
		expect(w).toMatch(/and 1 more/);
		expect(w).not.toMatch(/Nd/);
	});
});
