// uir-chat (q-chat-save c) — saved chats, the pure half: which scene a log belongs to, which lines are
// kept and how they come back, provider chats with their pictures as separate attachments, and the
// one History list both tabs share.
import { describe, it, expect } from 'vitest';
import {
	roomOf,
	keepLine,
	lineOf,
	cleanLine,
	appendLines,
	liveOf,
	logRow,
	upsertRow,
	aiTitle,
	splitAiImages,
	joinAiImages,
	imageKeysOf,
	transcriptOf,
	historyList,
	SESSION_CAP
} from '../../src/lib/chat/chatSavesCore.js';

describe('session logs', () => {
	it('a scene is its name; no name = the shared untitled log', () => {
		expect(roomOf({ name: 'Castle', hash: 'h' })).toEqual({ key: 'scene:Castle', title: 'Castle' });
		expect(roomOf(null)).toEqual({ key: 'untitled', title: 'Untitled scene' });
		expect(roomOf({ name: '  ' }).key).toBe('untitled');
	});
	it('keeps what people said, never notes or lines that came from a save', () => {
		expect(keepLine({ id: 'a', type: 'sent', text: 'hi' })).toBe(true);
		expect(keepLine({ id: 'a', type: 'received', text: 'hi' })).toBe(true);
		expect(keepLine({ id: 'a', type: 'info', text: 'created a box' })).toBe(false);
		expect(keepLine({ type: 'sent', text: 'no id' })).toBe(false);
		expect(keepLine({ id: 'a', type: 'received', text: 'x', saved: 'scene:A' })).toBe(false);
	});
	it('a line keeps its author name and whether it was mine', () => {
		const ctx = { me: 'me1', myName: 'Ana', nameOf: (/** @type {string} */ id) => (id === 'p2' ? 'Sam' : '') };
		expect(lineOf({ id: '1', type: 'sent', text: 'hi', sender: 'me1', at: 5 }, ctx)).toEqual({ id: '1', text: 'hi', sender: 'me1', at: 5, name: 'Ana', mine: true });
		expect(lineOf({ id: '2', type: 'received', text: 'yo', sender: 'p2', at: 6 }, ctx)).toEqual({ id: '2', text: 'yo', sender: 'p2', at: 6, name: 'Sam' });
		expect(cleanLine({ id: 3 })).toBeNull();
		expect(cleanLine({ id: 'x', text: 't', sender: 's', at: 'bad', evil: 1 })).toEqual({ id: 'x', text: 't', sender: 's', at: 0 });
	});
	it('append is by id, in time order, capped to the newest', () => {
		const a = { id: 'a', text: '1', sender: 's', at: 1 };
		const b = { id: 'b', text: '2', sender: 's', at: 2 };
		const c = { id: 'c', text: '3', sender: 's', at: 3 };
		expect(appendLines([a, c], [b, a]).map((l) => l.id)).toEqual(['a', 'b', 'c']);
		const many = Array.from({ length: SESSION_CAP + 5 }, (_, i) => ({ id: 'l' + i, text: '', sender: '', at: i }));
		const capped = appendLines([], many);
		expect(capped.length).toBe(SESSION_CAP);
		expect(capped[0].id).toBe('l5');
	});
	it('a saved line comes back as past, marked with its scene; mine stays mine under a new peer id', () => {
		const live = liveOf({ id: '1', text: 'hi', sender: 'old-id', at: 9, mine: true, name: 'Ana' }, 'scene:A', 'new-id');
		expect(live).toMatchObject({ type: 'sent', past: true, saved: 'scene:A', name: 'Ana', at: 9 });
		expect(liveOf({ id: '2', text: 'x', sender: 'p', at: 1 }, 'k', 'me').type).toBe('received');
	});
	it('the index row names the other people and the newest time; upsert keeps one per key', () => {
		const row = logRow('scene:A', 'A', [
			{ id: '1', text: '', sender: 'p', at: 1, name: 'Sam' },
			{ id: '2', text: '', sender: 'm', at: 4, name: 'Ana', mine: true }
		]);
		expect(row).toEqual({ key: 'scene:A', title: 'A', updatedAt: 4, count: 2, people: ['Sam'] });
		const idx = upsertRow([{ key: 'scene:A', updatedAt: 1 }, { key: 'scene:B', updatedAt: 3 }], row);
		expect(idx.map((r) => r.key)).toEqual(['scene:A', 'scene:B']);
		expect(idx.length).toBe(2);
	});
});

describe('provider chats', () => {
	const png = 'data:image/png;base64,iVBORw0KGgo=';
	it('pictures are split into attachments by key, once, and joined back', () => {
		const msgs = [
			{ role: 'user', content: 'make it red', images: [{ url: png, name: 'a.png' }] },
			{ role: 'assistant', content: 'done', streaming: true },
			{ role: 'user', content: 'again', images: [{ url: png, name: 'b.png' }] }
		];
		const { messages, images } = splitAiImages(msgs);
		expect(Object.keys(images).length).toBe(1);
		expect(JSON.stringify(messages)).not.toContain('base64');
		expect(messages[1].streaming).toBeUndefined();
		const key = messages[0].images[0].key;
		expect(images[key]).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgo=' });
		expect(imageKeysOf([{ messages }])).toEqual(new Set([key]));
		const back = joinAiImages(messages, (k) => images[k]);
		expect(back[0].images).toEqual([{ url: png, name: 'a.png' }]);
		// bytes gone: the words stay, the picture is left out
		expect(joinAiImages(messages, () => null)[0]).toEqual({ role: 'user', content: 'make it red' });
	});
	it('title = the first words; transcript = text turns only', () => {
		expect(aiTitle([{ role: 'user', content: '  a   small campfire ring with six rocks and a cone flame and more words here ' }])).toMatch(/^a small campfire ring.*…$/);
		expect(aiTitle([{ role: 'user', content: '', images: [{}] }])).toBe('A picture');
		expect(
			transcriptOf([
				{ role: 'user', content: 'hi' },
				{ role: 'tool-status', content: 'Adding' },
				{ role: 'assistant', content: 'ok' },
				{ role: 'error', content: 'x' }
			])
		).toEqual([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'ok' }
		]);
	});
});

describe('one History', () => {
	const src = {
		logs: [
			{ key: 'scene:A', title: 'A', updatedAt: 50, count: 3, people: ['Sam'] },
			{ key: 'scene:B', title: 'B', updatedAt: 10, count: 2, people: [] }
		],
		agents: [{ id: 'g1', title: 'Make the fence taller', label: 'Claude', updatedAt: 40 }],
		ai: [{ id: 'ai-1', title: 'Shader help', provider: 'Gemini', updatedAt: 30 }],
		room: { key: 'scene:A', title: 'A' },
		liveCount: 4
	};
	it('the scene you are in first, then newest; both kinds marked', () => {
		const rows = historyList(src);
		expect(rows.map((r) => r.kind + ':' + r.id)).toEqual(['people:scene:A', 'agent:g1', 'ai:ai-1', 'people:scene:B']);
		expect(rows[0]).toMatchObject({ current: true, title: 'Session · A' });
		expect(rows[0].sub).toBe('Sam · 4 messages');
	});
	it('filters People | AI and searches', () => {
		expect(historyList({ ...src, filter: 'people' }).every((r) => r.kind === 'people')).toBe(true);
		expect(historyList({ ...src, filter: 'ai' }).map((r) => r.id)).toEqual(['g1', 'ai-1']);
		expect(historyList({ ...src, query: 'gemini' }).map((r) => r.id)).toEqual(['ai-1']);
	});
	it('a new scene with nothing said still lists its live session row', () => {
		const rows = historyList({ logs: [], agents: [], ai: [], room: { key: 'untitled', title: 'Untitled scene' }, liveCount: 0 });
		expect(rows).toHaveLength(1);
		expect(rows[0].sub).toBe('No one else yet · 0 messages');
	});
});
