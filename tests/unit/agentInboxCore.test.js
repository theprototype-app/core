import { describe, it, expect } from 'vitest';
import { createInbox, cleanImages, summarizeThread, HISTORY_COUNT, AWAY_AFTER_MS, MAX_IMAGES } from '../../src/lib/agent/agentInboxCore.js';
import { createAgentCore } from '../../src/lib/agent/agentCore.js';

// 56 C2-C6 + C11: the agent page's chat inbox against fakes (a manual clock, a recording send).

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fake(over = {}) {
	/** @type {any[]} */ const sent = [];
	/** @type {{at: number, fn: () => void, id: number}[]} */ let timers = [];
	let t = 1000;
	let tid = 0;
	const roles = /** @type {Record<string, string>} */ ({ host1: 'admin', ed1: 'editor', view1: 'viewer' });
	const state = { roles: /** @type {boolean} */ (true), chats: /** @type {Record<string, any>} */ ({}) };
	const deps = {
		selfId: () => 'agent1',
		roleOf: (/** @type {string} */ id) => (state.roles ? roles[id] ?? null : null),
		host: () => 'host1',
		nameOf: (/** @type {string} */ id) => ({ host1: 'Alex', ed1: 'Eddie', view1: 'Vic' })[id] ?? '',
		myName: () => 'Claude',
		send: (/** @type {any} */ m) => sent.push(m),
		readChat: (/** @type {string} */ id) => state.chats[id] ?? null,
		now: () => t,
		setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
			const id = ++tid;
			timers.push({ at: t + ms, fn, id });
			return id;
		},
		clearTimer: (/** @type {number} */ id) => {
			timers = timers.filter((x) => x.id !== id);
		},
		...over
	};
	const inbox = createInbox(deps);
	const advance = (/** @type {number} */ ms) => {
		t += ms;
		const due = timers.filter((x) => x.at <= t);
		timers = timers.filter((x) => x.at > t);
		for (const x of due) x.fn();
	};
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { inbox, sent, state, advance, flush, deps };
}

const req = (/** @type {any} */ o = {}) => ({ type: 'agentchat', id: 'r1', chatId: 'c1', to: 'agent1', text: 'add three trees', ...o });
const statuses = (/** @type {any[]} */ sent) => sent.filter((m) => m.status).map((m) => m.status);

describe('agent inbox: delivery', () => {
	it('a request addressed to the agent is delivered with the sender role looked up locally', async () => {
		const { inbox } = fake();
		const p = inbox.next(5000);
		inbox.receive('ed1', req({ role: 'admin' }));
		const m = await p;
		expect(m).toMatchObject({ id: 'r1', chatId: 'c1', from: 'ed1', name: 'Eddie', role: 'editor', text: 'add three trees' });
	});

	it('a message for someone else, a backlog and a forged from never reach the agent', async () => {
		const { inbox, advance } = fake();
		inbox.receive('ed1', req({ to: 'agent2' }));
		inbox.receive('ed1', { type: 'agentchat', backlog: [req()] });
		inbox.receive('ed1', req({ id: 'r2', from: 'host1' }));
		const p = inbox.next(1000);
		advance(1001);
		expect(await p).toBeNull();
		expect(inbox.state().queued).toBe(0);
	});

	it('queued requests wait for the next wait (FIFO), and a duplicate id is dropped', async () => {
		const { inbox } = fake();
		inbox.receive('ed1', req({ id: 'a' }));
		inbox.receive('ed1', req({ id: 'a' }));
		inbox.receive('host1', req({ id: 'b' }));
		expect(inbox.state().queued).toBe(2);
		expect((await inbox.next(10)).id).toBe('a');
		expect((await inbox.next(10)).id).toBe('b');
	});

	it('timeout → null so the loop re-arms', async () => {
		const { inbox, advance } = fake();
		const p = inbox.next(3000);
		advance(2999);
		inbox.receive('ed1', req({ to: 'nobody' }));
		advance(2);
		expect(await p).toBeNull();
	});

	it('abortWait releases a wait; requeue puts a delivered request back at the front', async () => {
		const { inbox } = fake();
		const p = inbox.next(60000, 'tok');
		expect(inbox.abortWait('tok')).toBe(true);
		expect(await p).toBeNull();
		inbox.receive('ed1', req({ id: 'x' }));
		inbox.receive('ed1', req({ id: 'y' }));
		const got = await inbox.next(10);
		expect(inbox.requeue(got)).toBe(true);
		expect((await inbox.next(10)).id).toBe('x');
	});

	it('no roles in this build: everyone is an editor', async () => {
		const { inbox, state } = fake();
		state.roles = false;
		inbox.receive('anyone', req());
		expect((await inbox.next(10)).role).toBe('editor');
	});
});

describe('agent inbox: viewers, images, mute', () => {
	it('a viewer is delivered as a viewer WITHOUT images, and edits are refused while it runs', async () => {
		const { inbox } = fake();
		inbox.receive('view1', req({ images: [{ mimeType: 'image/png', data: PNG }] }));
		const m = await inbox.next(10);
		expect(m.role).toBe('viewer');
		expect(m.images).toBeUndefined();
		expect(m.imagesDropped).toBe(true);
		expect(inbox.gate('create_objects', true)).toMatchObject({ refused: true, role: 'viewer' });
		expect(inbox.gate('list_scene', false)).toBeNull();
		inbox.reply({ text: 'Viewers cannot edit.', final: true });
		expect(inbox.gate('create_objects', true)).toBeNull();
	});

	it('an editor image arrives as base64 with its type (a data: prefix is stripped)', async () => {
		const { inbox } = fake();
		inbox.receive('ed1', req({ images: [{ data: 'data:image/png;base64,' + PNG, name: 'phone.jpg' }] }));
		const m = await inbox.next(10);
		expect(m.images).toEqual([{ mimeType: 'image/png', data: PNG, name: 'phone.jpg' }]);
	});

	it('cleanImages: unknown types, oversize and junk are dropped; at most 4', () => {
		const ok = { mimeType: 'image/webp', data: PNG };
		expect(cleanImages([{ mimeType: 'image/svg+xml', data: PNG }, { mimeType: 'image/png', data: '<script>' }, null, ok])).toEqual([ok]);
		expect(cleanImages([{ mimeType: 'image/png', data: 'A'.repeat(2_000_000) }])).toEqual([]);
		expect(cleanImages(Array(9).fill(ok))).toHaveLength(MAX_IMAGES);
	});

	it('mute only from the host or an admin; muted drops requests and says so in the status', async () => {
		const { inbox, sent, advance } = fake();
		inbox.receive('ed1', { type: 'agentchat', to: 'agent1', mute: true });
		expect(inbox.state().muted).toBe(false);
		inbox.receive('host1', { type: 'agentchat', to: 'agent1', mute: true });
		expect(inbox.state().muted).toBe(true);
		expect(sent.at(-1)).toMatchObject({ type: 'agentchat', from: 'agent1', muted: true });
		inbox.receive('ed1', req());
		const p = inbox.next(100);
		advance(101);
		expect(await p).toBeNull();
		inbox.receive('host1', { type: 'agentchat', to: 'agent1', mute: false });
		inbox.receive('ed1', req({ id: 'r9' }));
		expect((await inbox.next(10)).id).toBe('r9');
	});
});

describe('agent inbox: Stop', () => {
	it('cancel marks the running request: every gated call answers cancelled until the next request', async () => {
		const { inbox } = fake();
		inbox.receive('ed1', req());
		await inbox.next(10);
		expect(inbox.gate('create_objects', true)).toBeNull();
		inbox.receive('ed1', { type: 'agentchat', cancel: 'r1', chatId: 'c1', to: 'agent1' });
		expect(inbox.gate('create_objects', true)).toMatchObject({ error: 'cancelled', cancelled: true });
		expect(inbox.gate('list_scene', false)).toMatchObject({ cancelled: true });
		expect(inbox.reply({ text: 'more' })).toMatchObject({ ok: false, cancelled: true });
		expect(inbox.reply({ text: 'Stopped.', final: true }).ok).toBe(true);
		inbox.receive('ed1', req({ id: 'r2' }));
		await inbox.next(10);
		expect(inbox.gate('create_objects', true)).toBeNull();
	});

	it('a viewer cannot Stop someone else; the host can; a queued request can be withdrawn', async () => {
		const { inbox } = fake();
		inbox.receive('ed1', req());
		inbox.receive('ed1', req({ id: 'r2' }));
		await inbox.next(10);
		inbox.receive('view1', { type: 'agentchat', cancel: 'r1', to: 'agent1' });
		expect(inbox.state().current.cancelled).toBe(false);
		inbox.receive('host1', { type: 'agentchat', cancel: 'r1', to: 'agent1' });
		expect(inbox.state().current.cancelled).toBe(true);
		inbox.receive('ed1', { type: 'agentchat', cancel: 'r2', to: 'agent1' });
		expect(inbox.state().queued).toBe(0);
	});

	it('the gate inside agentCore: a Stopped request never reaches the tool', async () => {
		const { inbox } = fake();
		/** @type {string[]} */ const ran = [];
		const core = createAgentCore({
			getTools: () => [],
			runTool: async (/** @type {string} */ n) => (ran.push(n), { ok: true }),
			systemPrompt: () => '',
			summarize: () => ({}),
			beginBatch: () => {},
			endBatch: () => {},
			peerId: () => 'agent1',
			role: () => 'editor',
			host: () => 'host1',
			waiting: () => false,
			openPeers: () => [{ id: 'host1', name: 'Host' }], // 1.49: an edit needs the host's link open (isJoined)
			inVR: () => false,
			missingTools: () => [],
			missingModules: () => [],
			onSceneChange: () => () => {},
			screenshot: async () => null,
			leave: async () => {},
			gate: (/** @type {string} */ n, /** @type {boolean} */ e) => inbox.gate(n, e)
		});
		inbox.receive('ed1', req());
		await inbox.next(10);
		expect(await core.agent.exec('create_objects', { objects: [{}] })).toEqual({ ok: true });
		inbox.receive('ed1', { type: 'agentchat', cancel: 'r1', to: 'agent1' });
		expect(await core.agent.exec('create_objects', { objects: [{}] })).toMatchObject({ error: 'cancelled' });
		expect(ran).toEqual(['create_objects']);
	});
});

describe('agent inbox: replies, terminal turns, asks', () => {
	it('reply streams ONE message (full text each time) and the final copy has no partial', async () => {
		const { inbox, sent } = fake();
		inbox.receive('ed1', req());
		await inbox.next(10);
		const a = inbox.reply({ text: 'Building the trees.' });
		const b = inbox.reply({ text: 'Done: three pines.', final: true });
		const replies = sent.filter((m) => m.replyTo === 'r1');
		expect(a.id).toBe(b.id);
		expect(replies[0]).toMatchObject({ to: 'ed1', chatId: 'c1', partial: true, text: 'Building the trees.', name: 'Claude' });
		expect(replies[1].partial).toBeUndefined();
		expect(replies[1].text).toBe('Building the trees.\n\nDone: three pines.');
		expect(inbox.state().current.done).toBe(true);
	});

	it('delta appends raw text (token streaming)', async () => {
		const { inbox, sent } = fake();
		inbox.receive('ed1', req());
		await inbox.next(10);
		inbox.reply({ delta: 'Hel' });
		inbox.reply({ delta: 'lo', final: true });
		expect(sent.filter((m) => m.replyTo === 'r1').at(-1).text).toBe('Hello');
	});

	it('a terminal turn: the prompt is echoed via cli, the reply too, and a Stop no longer applies', async () => {
		const { inbox, sent } = fake();
		inbox.receive('ed1', req());
		await inbox.next(10);
		inbox.receive('ed1', { type: 'agentchat', cancel: 'r1', to: 'agent1' });
		const r = inbox.reply({ prompt: 'make the fire bigger', text: 'Scaled it 2x.', final: true });
		const turn = sent.find((m) => m.role === 'user');
		expect(turn).toMatchObject({ via: 'cli', text: 'make the fire bigger', chatId: 'c1', from: 'agent1' });
		const rep = sent.find((m) => m.id === r.id);
		expect(rep).toMatchObject({ via: 'cli', to: null, text: 'Scaled it 2x.' });
		expect(inbox.gate('create_objects', true)).toBeNull();
	});

	it('a reply with no app request running is tagged via cli', () => {
		const { inbox, sent } = fake();
		inbox.reply({ text: 'hello from the terminal', final: true });
		expect(sent.find((m) => m.text === 'hello from the terminal').via).toBe('cli');
	});

	it('ask sends buttons; the click arrives as a request with answers', async () => {
		const { inbox, sent } = fake();
		inbox.receive('ed1', req());
		await inbox.next(10);
		const a = inbox.ask({ question: 'Pine or oak?', options: ['Pine', 'Oak'] });
		expect(sent.find((m) => m.ask)).toMatchObject({ id: a.id, to: 'ed1', ask: { question: 'Pine or oak?', options: ['Pine', 'Oak'] } });
		inbox.receive('ed1', req({ id: 'r2', text: 'Oak', answers: a.id }));
		expect(await inbox.next(10)).toMatchObject({ text: 'Oak', answers: a.id });
	});
});

describe('agent inbox: status', () => {
	it('listening while a wait is armed, working once delivered, away after the grace with nothing armed', async () => {
		const { inbox, sent, advance } = fake();
		const p = inbox.next(60000);
		expect(statuses(sent).at(-1)).toBe('listening');
		inbox.receive('ed1', req());
		await p;
		await new Promise((r) => setTimeout(r, 0));
		expect(inbox.state().status).toBe('working');
		// SENT, not just derived: a chat switch reads history first, and the badge must not wait for it
		expect(statuses(sent).at(-1)).toBe('working');
		inbox.reply({ text: 'ok', final: true });
		advance(AWAY_AFTER_MS + 100);
		expect(inbox.state().status).toBe('away');
		expect(statuses(sent).at(-1)).toBe('away');
		inbox.next(1000);
		expect(statuses(sent).at(-1)).toBe('listening');
	});

	it('chatStatus pins the badge; heartbeat re-sends it', () => {
		const { inbox, sent } = fake();
		inbox.setStatus('working');
		const n = sent.length;
		inbox.heartbeat();
		expect(sent.length).toBe(n + 1);
		expect(sent.at(-1).status).toBe('working');
		inbox.setStatus(null);
		expect(inbox.state().status).not.toBe('working');
	});
});

describe('agent inbox: chats and history (C11)', () => {
	it('the first request in another chat carries that chat history + a summary; the same chat does not', async () => {
		const { inbox } = fake();
		// chat c1 happened while the agent watched (everyone sees every message — F1)
		for (let i = 0; i < 25; i++) inbox.receive('ed1', req({ id: 'h' + i, to: 'agent2', text: 'line ' + i }));
		inbox.receive('ed1', req({ id: 'n1', chatId: 'c2', text: 'new chat' }));
		const m1 = await inbox.next(10);
		expect(m1.history).toBeUndefined(); // c2 has no earlier messages
		inbox.receive('ed1', req({ id: 'back', text: 'back to the first chat' }));
		const m2 = await inbox.next(10);
		expect(m2.chatId).toBe('c1');
		expect(m2.history).toHaveLength(HISTORY_COUNT);
		expect(m2.history.at(-1).text).toBe('line 24');
		expect(m2.olderMessages).toBe(5);
		expect(m2.summary).toMatch(/25 earlier messages/);
		inbox.receive('ed1', req({ id: 'again', text: 'and more' }));
		expect((await inbox.next(10)).history).toBeUndefined();
	});

	it('a chat this page never saw comes from the .tpchat store', async () => {
		const { inbox, state } = fake();
		state.chats.old = { messages: [{ id: 'o1', from: 'ed1', name: 'Eddie', text: 'build a campfire', at: 10 }, { id: 'o2', from: 'agent1', text: 'Done.', at: 20 }] };
		inbox.receive('ed1', req({ id: 'r', chatId: 'old', text: 'add trees' }));
		const m = await inbox.next(10);
		expect(m.history.map((/** @type {any} */ h) => h.id)).toEqual(['o1', 'o2']);
		expect(m.summary).toMatch(/build a campfire/);
	});

	it('thread pages back with before + limit', async () => {
		const { inbox } = fake();
		for (let i = 0; i < 30; i++) inbox.receive('ed1', req({ id: 'm' + i, to: 'x', text: 't' + i }));
		const a = await inbox.thread({ chatId: 'c1', limit: 10 });
		expect(a.messages.map((/** @type {any} */ m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => 'm' + (20 + i)));
		expect(a.more).toBe(true);
		const b = await inbox.thread({ chatId: 'c1', before: 'm20', limit: 50 });
		expect(b.messages).toHaveLength(20);
		expect(b.more).toBe(false);
	});

	it('summarizeThread names who spoke and the first + last request', () => {
		const s = summarizeThread(
			[
				{ from: 'ed1', name: 'Eddie', text: 'build a campfire' },
				{ from: 'agent1', text: 'Done' },
				{ from: 'agent1', via: 'cli', text: 'hi', kind: 'terminal' },
				{ from: 'ed1', name: 'Eddie', text: 'now add rocks' }
			],
			'agent1'
		);
		expect(s).toMatch(/4 earlier messages/);
		expect(s).toMatch(/Eddie 2/);
		expect(s).toMatch(/now add rocks/);
	});
});

describe('agent inbox: how the agent is driven', () => {
	it('mode + model ride every status message (the window labels the agent with them)', () => {
		const { inbox, sent } = fake();
		inbox.setStatus(null, { mode: 'repl', model: 'grok-3-mini' });
		expect(sent.at(-1)).toMatchObject({ status: expect.any(String), mode: 'repl', model: 'grok-3-mini' });
		inbox.heartbeat();
		expect(sent.at(-1)).toMatchObject({ mode: 'repl', model: 'grok-3-mini' });
		inbox.setStatus(null, { mode: 'bogus' });
		expect(sent.at(-1).mode).toBeUndefined();
	});
});

describe('agent inbox: empty partials', () => {
	it('a terminal prompt with no text yet posts the turn but no empty reply bubble', () => {
		const { inbox, sent } = fake();
		const r = inbox.reply({ prompt: 'hello', via: 'cli' });
		expect(sent.filter((m) => m.role === 'user')).toHaveLength(1);
		expect(sent.some((m) => m.id === r.id)).toBe(false);
		inbox.reply({ delta: 'Hi!', via: 'cli', final: true });
		expect(sent.find((m) => m.id === r.id)).toMatchObject({ text: 'Hi!', via: 'cli' });
	});
});
