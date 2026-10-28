import { describe, it, expect } from 'vitest';
import { createAgentCore, createOffers, viewerRefusal, leftBehindRefusal, hostAwayRefusal, toolName, READ_ONLY_TOOLS } from '../../src/lib/agent/agentCore.js';
import { TP_AGENT_VERSION } from '../../src/lib/agent/contract.js';

// 55 A2: the tpAgent methods against fakes. Each test names the test-flight finding it pins.

/** a fake app: records batches, tool calls and scene-change subscribers */
function fakeApp(over = {}) {
	/** @type {any[]} */ const log = [];
	/** @type {Set<() => void>} */ const subs = new Set();
	const state = { role: /** @type {string|null} */ (null), host: /** @type {string|null} */ ('host1'), waiting: false, vr: false, peers: [{ id: 'host1', name: 'Alex' }] };
	const deps = {
		appVersion: '1.45.0',
		getTools: () => [
			{ type: 'function', function: { name: 'list_scene', description: 'd', parameters: { type: 'object', properties: {} } } },
			{ type: 'function', function: { name: 'create_objects', description: 'd', parameters: { type: 'object', properties: { objects: { type: 'array' } }, required: ['objects'] } } }
		],
		resolveName: (/** @type {string} */ n) => ({ name: n === 'scene' ? 'list_scene' : n }),
		runTool: async (/** @type {string} */ raw, /** @type {any} */ args) => {
			// the real executeAiTool repairs the name itself
			const name = raw === 'scene' ? 'list_scene' : raw;
			log.push(['run', name, args]);
			// a mutating tool pokes the scene, as the real executors do
			if (name !== 'list_scene') for (const fn of subs) fn();
			if (name === 'boom') throw new Error('kaput');
			return name === 'list_scene' ? { objects: [] } : { created: [{ uuid: 'u1' }] };
		},
		systemPrompt: () => 'PROMPT',
		summarize: (/** @type {number} */ cap) => ({ objects: [], cap }),
		beginBatch: () => log.push(['begin']),
		endBatch: (/** @type {string} */ label) => log.push(['end', label]),
		peerId: () => 'e6f54',
		role: () => state.role,
		host: () => state.host,
		waiting: () => state.waiting,
		openPeers: () => state.peers,
		inVR: () => state.vr,
		missingTools: () => [{ name: 'generate_mesh', reason: 'no provider' }],
		missingModules: () => [],
		onSceneChange: (/** @type {() => void} */ cb) => {
			subs.add(cb);
			cb(); // a store subscription fires once on subscribe
			return () => subs.delete(cb);
		},
		screenshot: async () => 'data:image/png;base64,AAAA',
		leave: async () => {
			log.push(['leave']);
		},
		...over
	};
	return { deps, log, subs, state, poke: () => [...subs].forEach((fn) => fn()) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('tools()', () => {
	it('returns the assistant tools with full schemas plus the agent-only tools (T10)', () => {
		const app = fakeApp({ extraTools: { install_modules: { schema: { description: 'x', parameters: { type: 'object', properties: {} } }, run: () => ({}) } } });
		const { agent } = createAgentCore(app.deps);
		const list = agent.tools();
		expect(list.map(toolName)).toEqual(['list_scene', 'create_objects', 'install_modules']);
		expect(list[1].function.parameters.required).toEqual(['objects']);
		expect(list[2].function.parameters.type).toBe('object');
	});
});

describe('exec()', () => {
	it('wraps a mutating call in ONE history batch labelled by the tool', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		const res = await agent.exec('create_objects', { objects: [{ kind: 'primitive' }] });
		expect(res.created[0].uuid).toBe('u1');
		expect(app.log.map((l) => l[0])).toEqual(['begin', 'run', 'end']);
		expect(app.log[2][1]).toBe('Agent: create_objects');
	});
	it('runs a read without a batch', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		await agent.exec('list_scene', {});
		expect(app.log.map((l) => l[0])).toEqual(['run']);
		expect(READ_ONLY_TOOLS.has('list_scene')).toBe(true);
	});
	it('REFUSES a viewer edit with a reason and never runs it (T1)', async () => {
		const app = fakeApp();
		app.state.role = 'viewer';
		const { agent } = createAgentCore(app.deps);
		const res = await agent.exec('create_objects', { objects: [{}] });
		expect(res.refused).toBe(true);
		expect(res.role).toBe('viewer');
		expect(res.error).toBe(viewerRefusal('e6f54'));
		expect(res.error).toMatch(/E6F54/);
		expect(app.log).toEqual([]);
		// an alias of a read still reads
		const read = await agent.exec('scene', {});
		expect(read.objects).toEqual([]);
	});
	it('serialises pipelined calls so batches never interleave', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		await Promise.all([agent.exec('create_objects', { objects: [1] }), agent.exec('update_objects', { updates: [1] })]);
		expect(app.log.map((l) => l[0])).toEqual(['begin', 'run', 'end', 'begin', 'run', 'end']);
	});
	it('never throws: a thrown executor is an {error} and the batch still closes', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		const res = await agent.exec('boom', {});
		expect(res.error).toBe('kaput');
		expect(app.log.at(-1)[0]).toBe('end');
	});
	it('runs agent-only tools locally, unbatched, even for a viewer', async () => {
		const app = fakeApp({ extraTools: { install_modules: { schema: {}, run: (/** @type {any} */ a) => ({ installed: a.ids }) } } });
		app.state.role = 'viewer';
		const { agent } = createAgentCore(app.deps);
		expect(await agent.exec('install_modules', { ids: ['waves'] })).toEqual({ installed: ['waves'] });
		expect(app.log).toEqual([]);
	});
});

describe('snapshot() / systemPrompt()', () => {
	it('pass through with a bounded cap', () => {
		const { agent } = createAgentCore(fakeApp().deps);
		expect(agent.systemPrompt()).toBe('PROMPT');
		expect(agent.snapshot().cap).toBe(1000);
		expect(agent.snapshot(99999).cap).toBe(5000);
		expect(agent.snapshot(5).cap).toBe(5);
	});
});

describe('status()', () => {
	it('says who and where the agent is', () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		const s = agent.status();
		expect(s.version).toBe(TP_AGENT_VERSION);
		expect(s.appVersion).toBe('1.45.0');
		expect(s.peerId).toBe('e6f54');
		expect(s.joined).toBe(true);
		expect(s.canEdit).toBe(true);
		expect(s.role).toBe(null);
		expect(s.missingTools[0].name).toBe('generate_mesh');
		expect(s.inVR).toBe(false);
	});
	it('is not joined while waiting for Approve, nor when the host link is closed', () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		app.state.waiting = true;
		expect(agent.status().joined).toBe(false);
		app.state.waiting = false;
		app.state.peers = [];
		expect(agent.status().joined).toBe(false);
		app.state.host = null;
		expect(agent.status().joined).toBe(false);
	});
	it('is not joined until the host\'s roles have arrived (a roles plugin), then is', () => {
		const app = fakeApp();
		let settled = false;
		const { agent } = createAgentCore({ ...app.deps, rolesSettled: () => settled });
		expect(agent.status().joined).toBe(false);
		settled = true;
		expect(agent.status().joined).toBe(true);
	});
	it('1.2: the host LEFT and nobody is here — paused: status says so and edits are refused (41)', async () => {
		const app = fakeApp();
		/** @type {any} */
		let away = { host: 'ff637aa', since: 1000, until: Date.now() + 600000, expired: false };
		const { agent } = createAgentCore({ ...app.deps, hostAway: () => away });
		expect(agent.status()).toMatchObject({ hostAway: { host: 'ff637aa', expired: false }, withHost: false });
		const res = await agent.exec('create_objects', { objects: [{}] });
		expect(res).toMatchObject({ refused: true, hostAway: { host: 'ff637aa' } });
		expect(res.error).toBe(hostAwayRefusal(away));
		expect(res.error).toMatch(/paused/);
		expect(app.log).toEqual([]);
		// reads still work while paused
		expect((await agent.exec('list_scene', {})).refused).toBeUndefined();
		away = null;
		expect(agent.status().hostAway).toBeUndefined();
	});
	it('1.2: says a scene is still arriving, and which behaviours are failing (41)', () => {
		const app = fakeApp();
		/** @type {{arrived: number, total: number} | null} */
		let arriving = { arrived: 3, total: 9 };
		/** @type {any[]} */
		let failing = [];
		const { agent } = createAgentCore({ ...app.deps, loading: () => arriving, behaviourErrors: () => failing });
		expect(agent.status()).toMatchObject({ loading: true, objects: { arrived: 3, total: 9 } });
		expect(agent.status().behaviourErrors).toBeUndefined();
		arriving = null;
		failing = [{ name: 'Gems', where: 'on.load', message: 'findAll is not defined' }];
		const st = agent.status();
		expect(st.loading).toBe(false);
		expect(st.objects).toBeUndefined();
		expect(st.behaviourErrors).toEqual(failing);
	});
	it('says where it is and where the host is, and REFUSES edits while apart (55 owner finding 1)', async () => {
		const app = fakeApp();
		let room = { scene: 'Run1', hostScene: 'Run1', withHost: true, following: false };
		const { agent } = createAgentCore({ ...app.deps, room: () => room });
		expect(agent.status()).toMatchObject({ scene: 'Run1', hostScene: 'Run1', withHost: true });
		room = { scene: 'Run1', hostScene: 'Run2', withHost: false, following: true };
		const st = agent.status();
		expect(st.joined).toBe(true); // still in the session …
		expect(st).toMatchObject({ withHost: false, hostScene: 'Run2', following: true }); // … but not with the host
		const res = await agent.exec('create_objects', { objects: [{}] });
		expect(res).toMatchObject({ refused: true, withHost: false });
		expect(res.error).toBe(leftBehindRefusal('Run2', true));
		expect(res.error).toMatch(/"Run2"/);
		expect(app.log).toEqual([]);
		expect((await agent.exec('list_scene', {})).objects).toEqual([]); // reading still works
		room = { ...room, withHost: true, following: false, scene: 'Run2' };
		expect((await agent.exec('create_objects', { objects: [{}] })).created).toBeTruthy();
	});
	it('without a room dep (an older wiring) nothing changes', () => {
		const st = createAgentCore(fakeApp().deps).agent.status();
		expect('withHost' in st).toBe(false);
	});
	it('reports a viewer as unable to edit', () => {
		const app = fakeApp();
		app.state.role = 'viewer';
		expect(createAgentCore(app.deps).agent.status().canEdit).toBe(false);
	});
	it('keeps the last notices', () => {
		const core = createAgentCore(fakeApp().deps);
		for (let i = 0; i < 15; i++) core.notice('n' + i);
		expect(core.agent.status().notices).toEqual(['n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11', 'n12', 'n13', 'n14']);
	});
});

describe('waitForEdit()', () => {
	it('resolves on the next change made by someone else', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		const wait = agent.waitForEdit(1000);
		await tick();
		app.poke();
		const res = await wait;
		expect(res.changed).toBe(true);
		expect(app.subs.size).toBe(0); // unsubscribed
	});
	it('does not count the subscribe call, and times out cleanly', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		const res = await agent.waitForEdit(20);
		expect(res).toEqual({ changed: false, timedOut: true });
		expect(app.subs.size).toBe(0);
	});
	it("is not woken by the agent's own exec", async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		const wait = agent.waitForEdit(60);
		await agent.exec('create_objects', { objects: [1] });
		expect(await wait).toEqual({ changed: false, timedOut: true });
	});
});

describe('screenshot() / leave()', () => {
	it('returns the frame, and null in VR', async () => {
		const app = fakeApp();
		const { agent } = createAgentCore(app.deps);
		expect(await agent.screenshot({ view: 'top' })).toMatch(/^data:image\/png/);
		app.state.vr = true;
		expect(await agent.screenshot()).toBe(null);
	});
	it('a failing renderer is null, never a throw', async () => {
		const { agent } = createAgentCore(fakeApp({ screenshot: async () => { throw new Error('gl'); } }).deps);
		expect(await agent.screenshot()).toBe(null);
	});
	it('leave() delegates', async () => {
		const app = fakeApp();
		await createAgentCore(app.deps).agent.leave();
		expect(app.log).toEqual([['leave']]);
	});
});

describe('offers (T2)', () => {
	it('keeps a question until answered, presses the named button, and forgets it', () => {
		let t = 1000;
		const offers = createOffers(() => t);
		/** @type {string[]} */ const pressed = [];
		let removed = 0;
		const id = offers.put('k1', 'Admin offered. Accept?', [
			{ label: 'Accept', action: () => pressed.push('accept') },
			{ label: 'Decline', action: () => pressed.push('decline') }
		], () => removed++);
		expect(offers.list()).toEqual([{ id, text: 'Admin offered. Accept?', actions: ['Accept', 'Decline'], at: 1000 }]);
		expect(offers.accept(id, 'decline')).toEqual({ ok: true, action: 'Decline' });
		expect(pressed).toEqual(['decline']);
		expect(removed).toBe(1);
		expect(offers.list()).toEqual([]);
		expect(offers.accept(id).ok).toBe(false);
	});
	it('defaults to the first button, refuses an unknown one, refreshes by key and withdraws', () => {
		let t = 0;
		const offers = createOffers(() => t);
		/** @type {string[]} */ const pressed = [];
		const a = offers.put('share', 'v1', [{ label: 'Share', action: () => pressed.push('share') }]);
		const b = offers.put('share', 'v2', [{ label: 'Share', action: () => pressed.push('share2') }, { label: 'Stash', action: () => {} }]);
		expect(b).toBe(a);
		expect(offers.list()[0].text).toBe('v2');
		expect(offers.accept(a, 'nope').ok).toBe(false);
		expect(offers.accept(a)).toEqual({ ok: true, action: 'Share' });
		expect(pressed).toEqual(['share2']);
		offers.put('gone', 'x', [{ label: 'Ok', action: () => {} }]);
		offers.withdraw('gone');
		expect(offers.list()).toEqual([]);
	});
	it('expires an unanswered offer', () => {
		let t = 0;
		const offers = createOffers(() => t);
		offers.put('x', 'old', [{ label: 'Ok', action: () => {} }]);
		t = 11 * 60 * 1000;
		expect(offers.list()).toEqual([]);
	});
	it('surface through the agent', () => {
		const core = createAgentCore(fakeApp().deps);
		const id = core.offers.put('k', 'Join?', [{ label: 'Yes', action: () => {} }]);
		expect(core.agent.pendingOffers().map((o) => o.id)).toEqual([id]);
		expect(core.agent.status().pendingOffers).toBe(1);
		expect(core.agent.accept(id).ok).toBe(true);
	});
});

describe('missingModulesFrom (T6)', () => {
	it('lists modules open peers run that this page lacks or runs at another version', async () => {
		const { missingModulesFrom } = await import('../../src/lib/agent/agentCore.js');
		const adv = {
			host: [{ id: 'health', version: '1.0.0' }, { id: 'waves', version: '2.2.0' }, { id: 'hello', version: '1.0.0' }],
			gone: [{ id: 'smart-unwrap', version: '0.1.0' }],
			other: [{ id: 'health', version: '1.0.0' }]
		};
		const loaded = [{ id: 'hello', version: '1.0.0' }, { id: 'waves', version: '2.1.0' }];
		expect(missingModulesFrom(adv, ['host', 'other'], loaded)).toEqual([
			{ id: 'health', version: '1.0.0' },
			{ id: 'waves', version: '2.2.0', have: '2.1.0' }
		]);
		expect(missingModulesFrom(adv, ['host'], loaded, ['waves']).map((r) => r.inGallery)).toEqual([false, true]);
		expect(missingModulesFrom(adv, [], loaded)).toEqual([]);
	});
});
