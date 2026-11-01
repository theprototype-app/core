// 56 C1/C4/C5/C6 — the agent chat reducer: requests and streamed replies merge by id, a peer
// speaks only for itself, Stop marks the request, status rows, the late joiner's backlog, and
// the thread interleaved with the 55 A8 action lines.
import { describe, it, expect } from 'vitest';
import {
	applyAgentChat,
	emptyState,
	kindOf,
	isAgentChatWire,
	cleanMessage,
	runningRequest,
	streamingReply,
	threadItems,
	chatTitle,
	historyRows,
	backlogOf,
	loadChat,
	chatRecord,
	agentGone,
	isChatWriter,
	CHAT_CAP,
	TEXT_MAX
} from '../../src/lib/agentChatCore.js';

const AG = 'agent1';
const HOST = 'host1';
const VIEW = 'viewer1';
const req = (/** @type {any} */ o = {}) => ({ type: 'agentchat', id: 'r1', chatId: 'c1', from: HOST, to: AG, text: 'add three trees', at: 100, ...o });
const rep = (/** @type {any} */ o = {}) => ({ type: 'agentchat', id: 'a1', chatId: 'c1', from: AG, to: HOST, replyTo: 'r1', text: 'Adding', partial: true, at: 110, ...o });

/** @param {any[]} steps [fromPeer, msg][] */
function run(steps, s = emptyState()) {
	for (const [from, m] of steps) s = applyAgentChat(s, from, m, 500);
	return s;
}

describe('kindOf / wire row', () => {
	it('tells the eight kinds apart', () => {
		expect(kindOf(req())).toBe('request');
		expect(kindOf(rep())).toBe('reply');
		expect(kindOf({ id: 'x', chatId: 'c', from: AG, role: 'user', via: 'cli', text: 'hi' })).toBe('cli');
		expect(kindOf({ id: 'x', chatId: 'c', from: AG, ask: { question: 'Which?', options: ['a'] } })).toBe('ask');
		expect(kindOf({ cancel: 'r1', from: HOST, to: AG })).toBe('cancel');
		expect(kindOf({ status: 'listening', from: AG })).toBe('status');
		expect(kindOf({ mute: true, from: HOST, to: AG })).toBe('mute');
		expect(kindOf({ backlog: [] })).toBe('backlog');
		expect(kindOf({ id: 'x', chatId: 'c', from: AG, text: 'unprompted' })).toBe('reply');
		expect(kindOf(null)).toBe(null);
		expect(kindOf({})).toBe(null);
	});
	it('validates shapes', () => {
		expect(isAgentChatWire(req())).toBe(true);
		expect(isAgentChatWire(req({ id: 'x'.repeat(65) }))).toBe(false);
		expect(isAgentChatWire(req({ chatId: 3 }))).toBe(false);
		expect(isAgentChatWire({ status: 'sleeping', from: AG })).toBe(false);
		expect(isAgentChatWire({ status: 'working', from: AG })).toBe(true);
		expect(isAgentChatWire({ mute: 'yes', to: AG })).toBe(false);
		expect(isAgentChatWire({ backlog: new Array(201).fill(req()) })).toBe(false);
		expect(isAgentChatWire({ cancel: 'r1' })).toBe(true);
	});
});

describe('requests and streamed replies', () => {
	it('a request opens the chat with its agent', () => {
		const s = run([[HOST, req()]]);
		expect(s.chats.c1.agent).toBe(AG);
		expect(s.chats.c1.messages).toHaveLength(1);
		expect(s.chats.c1.messages[0]).toMatchObject({ kind: 'request', text: 'add three trees', from: HOST, to: AG });
	});
	it('partials grow one bubble; the final one settles it; a late partial does not undo it', () => {
		let s = run([[HOST, req()], [AG, rep()], [AG, rep({ text: 'Adding three' })]]);
		expect(s.chats.c1.messages).toHaveLength(2);
		expect(s.chats.c1.messages[1]).toMatchObject({ text: 'Adding three', partial: true });
		expect(runningRequest(s.chats.c1)?.id).toBe('r1');
		expect(streamingReply(s.chats.c1, 'r1')?.text).toBe('Adding three');
		s = run([[AG, rep({ text: 'Added three trees.', partial: undefined })]], s);
		expect(s.chats.c1.messages[1].text).toBe('Added three trees.');
		expect('partial' in s.chats.c1.messages[1]).toBe(false);
		expect(runningRequest(s.chats.c1)).toBe(null);
		const again = run([[AG, rep({ text: 'Adding' })]], s);
		expect(again).toBe(s); // unchanged state object
	});
	it('a shorter partial never shrinks the bubble', () => {
		const s = run([[HOST, req()], [AG, rep({ text: 'Adding three' })], [AG, rep({ text: 'Add' })]]);
		expect(s.chats.c1.messages[1].text).toBe('Adding three');
	});
	it('caps text and the thread', () => {
		const s = run([[HOST, req({ text: 'x'.repeat(TEXT_MAX + 50) })]]);
		expect(s.chats.c1.messages[0].text).toHaveLength(TEXT_MAX);
		let t = emptyState();
		for (let i = 0; i < CHAT_CAP + 20; i++) t = applyAgentChat(t, HOST, req({ id: 'r' + i, at: i }), 0);
		expect(t.chats.c1.messages).toHaveLength(CHAT_CAP);
		expect(t.chats.c1.messages[0].id).toBe('r20');
	});
	it('drops an empty request and keeps one with only an image', () => {
		expect(cleanMessage(req({ text: '   ' }))).toBe(null);
		expect(cleanMessage(req({ text: '', images: [{ mimeType: 'image/webp', data: 'AAA' }] }))?.images).toHaveLength(1);
		expect(cleanMessage(req({ images: [{ mimeType: 'text/html', data: 'x' }] }))?.images).toBeUndefined();
	});
});

describe('who may say what', () => {
	it('a peer speaks only for itself (live)', () => {
		const forged = run([[VIEW, req({ from: HOST })]]);
		expect(forged.chats.c1).toBeUndefined();
		const forgedReply = run([[HOST, req()], [VIEW, rep({ text: 'I am the agent' })]]);
		expect(forgedReply.chats.c1.messages).toHaveLength(1);
	});
	it('nobody rewrites another sender’s message id', () => {
		const s = run([[HOST, req()], [AG, { ...rep(), id: 'r1' }]]);
		expect(s.chats.c1.messages[0].text).toBe('add three trees');
	});
	it('one chat belongs to one agent', () => {
		const s = run([[HOST, req()], ['agent2', rep({ from: 'agent2', id: 'z' })]]);
		expect(s.chats.c1.messages).toHaveLength(1);
	});
	it('a role field is not kept (the window computes roles itself)', () => {
		const s = run([[VIEW, req({ from: VIEW, role: 'admin' })]]);
		expect(s.chats.c1.messages[0].role).toBeUndefined();
	});
	it('a mute command changes nothing here — the agent’s status says it', () => {
		const s0 = run([[HOST, req()]]);
		expect(run([[HOST, { mute: true, from: HOST, to: AG }]], s0)).toBe(s0);
		const s = run([[AG, { status: 'listening', muted: true, from: AG }]], s0);
		expect(s.agents[AG]).toMatchObject({ status: 'listening', muted: true });
	});
});

describe('Stop, status, the terminal and asks', () => {
	it('cancel marks the request and ends the running state', () => {
		let s = run([[HOST, req()], [AG, rep()]]);
		s = run([[HOST, { type: 'agentchat', cancel: 'r1', chatId: 'c1', from: HOST, to: AG }]], s);
		expect(s.chats.c1.messages[0]).toMatchObject({ cancelled: true, cancelledBy: HOST });
		expect(runningRequest(s.chats.c1)).toBe(null);
	});
	it('status rows, and an agent gone is away', () => {
		let s = run([[AG, { status: 'working', from: AG, chatId: 'c1' }]]);
		expect(s.agents[AG]).toMatchObject({ status: 'working', chatId: 'c1', muted: false });
		const same = run([[AG, { status: 'working', from: AG, chatId: 'c1' }]], s);
		expect(same).toBe(s);
		s = agentGone(s, 'AGENT1');
		expect(s.agents[AG].status).toBe('away');
	});
	it('a terminal turn is part of the thread, tagged', () => {
		const s = run([[HOST, req()], [AG, { id: 't1', chatId: 'c1', from: AG, role: 'user', via: 'cli', text: 'also a bench', at: 120 }]]);
		expect(s.chats.c1.messages[1]).toMatchObject({ kind: 'cli', via: 'cli', text: 'also a bench' });
		expect(s.chats.c1.agent).toBe(AG);
	});
	it('an ask hands the turn back; answering it marks it answered', () => {
		let s = run([[HOST, req()], [AG, { id: 'q1', chatId: 'c1', from: AG, to: HOST, ask: { question: 'Pine or oak?', options: ['Pine', 'Oak', 7] }, at: 120 }]]);
		expect(s.chats.c1.messages[1].ask).toEqual({ question: 'Pine or oak?', options: ['Pine', 'Oak'] });
		expect(runningRequest(s.chats.c1)).toBe(null);
		s = run([[HOST, req({ id: 'r2', text: 'Pine', answers: 'q1', at: 130 })]], s);
		const items = threadItems(s.chats.c1);
		expect(items.find((i) => i.key === 'm:q1')?.m.answered).toBe(true);
		expect(runningRequest(s.chats.c1)?.id).toBe('r2');
	});
});

describe('thread, history, backlog, files', () => {
	it('interleaves the agent’s A8 lines from the chat’s start', () => {
		const s = run([[HOST, req()], [AG, rep({ text: 'Done', partial: undefined, at: 150 })]]);
		const log = [
			{ id: 'agent1:0', peer: AG, text: 'before the chat', at: 50 },
			{ id: 'agent1:1', peer: AG, text: 'created 3 objects (Tree)', at: 120 },
			{ id: 'other:1', peer: 'agent2', text: 'another agent', at: 130 }
		];
		const items = threadItems(s.chats.c1, log);
		expect(items.map((i) => i.key)).toEqual(['m:r1', 'l:agent1:1', 'm:a1']);
	});
	it('a reply that streams across a step reads after it, and keeps that through the backlog', () => {
		const s = run([[HOST, req()], [AG, rep({ text: 'Plant', at: 110 })], [AG, rep({ text: 'Planted three', partial: undefined, at: 160 })]]);
		const log = [{ id: 'agent1:1', peer: AG, text: 'created 3 objects (Tree)', at: 130 }];
		expect(threadItems(s.chats.c1, log).map((i) => i.key)).toEqual(['m:r1', 'l:agent1:1', 'm:a1']);
		const late = applyAgentChat(emptyState(), HOST, { type: 'agentchat', backlog: backlogOf(s) }, 600);
		expect(threadItems(late.chats.c1, log).map((i) => i.key)).toEqual(['m:r1', 'l:agent1:1', 'm:a1']);
	});
	it('titles from the first request', () => {
		const s = run([[HOST, req({ text: 'a small campfire ring with six rocks and a cone flame and benches' })]]);
		expect(chatTitle(s.chats.c1)).toMatch(/^a small campfire ring.*…$/);
		expect(chatTitle({ messages: [] })).toBe('New chat');
		expect(chatTitle({ title: 'Mine', messages: [] })).toBe('Mine');
	});
	it('history rows merge memory and files, newest first, searchable', () => {
		const s = run([[HOST, req({ at: 300 })], [HOST, req({ id: 'r9', chatId: 'c2', text: 'make a bridge', at: 400 })]]);
		const files = [
			{ id: 'c1', title: 'Trees', target: { kind: 'agent', id: AG, label: 'Claude' }, updatedAt: 200, count: 4 },
			{ id: 'c0', title: 'Old one', target: { kind: 'provider', id: 'p', label: 'grok' }, updatedAt: 50, count: 2 }
		];
		const rows = historyRows(s, files, '', () => 'Claude');
		expect(rows.map((r) => r.id)).toEqual(['c2', 'c1', 'c0']);
		expect(rows[1]).toMatchObject({ title: 'Trees', count: 4, saved: true });
		expect(historyRows(s, files, 'bridge').map((r) => r.id)).toEqual(['c2']);
		expect(historyRows(s, files, 'grok').map((r) => r.id)).toEqual(['c0']);
	});
	it('the backlog rebuilds the thread on a late joiner, without image bytes or control', () => {
		const s = run([
			[HOST, req({ images: [{ mimeType: 'image/jpeg', data: 'BYTES', w: 4, h: 3 }] })],
			[AG, rep({ text: 'Done', partial: undefined })],
			[AG, { id: 't1', chatId: 'c1', from: AG, role: 'user', via: 'cli', text: 'bench too', at: 200 }]
		]);
		const backlog = backlogOf(s);
		expect(backlog).toHaveLength(3);
		expect(backlog[0].images[0]).toEqual({ mimeType: 'image/jpeg', w: 4, h: 3 });
		expect(backlog[2]).toMatchObject({ role: 'user', via: 'cli' });
		// relayed by the HOST, the agent's lines keep their own sender
		const late = applyAgentChat(emptyState(), HOST, { type: 'agentchat', backlog }, 600);
		expect(late.chats.c1.messages.map((/** @type {any} */ m) => m.from)).toEqual([HOST, AG, AG]);
		expect(late.chats.c1.messages[2].kind).toBe('cli');
	});
	it('a saved chat loads and round-trips through its record', () => {
		const s = run([[HOST, req()], [AG, rep({ text: 'Done', partial: undefined })]]);
		const rec = chatRecord(s.chats.c1, 'Claude');
		expect(rec).toMatchObject({ id: 'c1', title: 'add three trees', target: { kind: 'agent', id: AG, label: 'Claude' }, participants: [HOST, AG] });
		const back = loadChat(emptyState(), { ...rec, title: 'Trees' });
		expect(back.chats.c1.messages).toEqual(s.chats.c1.messages);
		expect(back.chats.c1.title).toBe('Trees');
	});
	it('one writer per session', () => {
		expect(isChatWriter({ myId: 'b', hostId: null, iCanEdit: true, editors: ['a'] })).toBe(true);
		expect(isChatWriter({ myId: 'b', hostId: null, iCanEdit: false, editors: [] })).toBe(false);
		expect(isChatWriter({ myId: 'b', hostId: 'h', iCanEdit: true, editors: ['h', 'a'] })).toBe(false);
		expect(isChatWriter({ myId: 'b', hostId: 'h', iCanEdit: true, editors: ['c'] })).toBe(true);
		expect(isChatWriter({ myId: 'b', hostId: 'h', iCanEdit: true, editors: ['a'] })).toBe(false);
	});
});

describe('the wire row and the viewer floor', async () => {
	const { validateWireMessage } = await import('../../src/lib/wireValidate.js');
	const { canApply, setCapabilityProvider } = await import('../../src/lib/cloudHooks.js');
	it('accepts every kind and refuses bad shapes', () => {
		for (const m of [req(), rep(), { type: 'agentchat', cancel: 'r1', from: HOST, to: AG }, { type: 'agentchat', status: 'away', from: AG }, { type: 'agentchat', mute: true, from: HOST, to: AG }, { type: 'agentchat', backlog: [req()] }])
			expect(validateWireMessage(m), JSON.stringify(m)).not.toBe(false);
		expect(validateWireMessage({ type: 'agentchat', status: 'asleep', from: AG })).toBe(false);
		expect(validateWireMessage(req({ text: 42 }))).toBe(false);
		expect(validateWireMessage(req({ images: [1, 2, 3, 4, 5] }))).toBe(false);
	});
	it('a viewer’s agentchat passes a plugin that gates everything else (C5)', () => {
		setCapabilityProvider(() => false);
		try {
			expect(canApply('v', 'agentchat')).toBe(true);
			expect(canApply('v', 'agentlog')).toBe(false);
		} finally {
			setCapabilityProvider(null);
		}
	});
});

describe('runningRequest with two requests in flight', () => {
	it('a final reply to the first does not close the second', () => {
		const s = run([[HOST, req()], [VIEW, req({ id: 'r2', from: VIEW, text: 'what is this?', at: 105 })], [AG, rep({ text: 'Done', partial: undefined, at: 120 })]]);
		expect(runningRequest(s.chats.c1)?.id).toBe('r2');
	});
});
