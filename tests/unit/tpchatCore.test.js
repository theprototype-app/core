// 56 C10 — the `.tpchat` format's pure half: the schema (normalize), picture identity and the
// split/join the wire uses, the ~50 MB cap plan, Markdown, and the outward-door filter (fork F5).
import { describe, it, expect } from 'vitest';
import {
	normalizeChat,
	normalizeMessage,
	normalizeImage,
	splitImages,
	joinImages,
	capPlan,
	chatBytes,
	chatToMarkdown,
	serializeTpchat,
	parseTpchat,
	payloadForDoor,
	privateChatCount,
	chatsForDoor,
	keyOf,
	bareBase64,
	base64Bytes,
	TPCHAT_FORMAT,
	MAX_IMAGES_PER_MESSAGE
} from '../../src/lib/chat/tpchatCore.js';

const PIX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** @param {any} [over] */
function chat(over = {}) {
	return {
		id: 'c1',
		title: 'Trees',
		target: { kind: 'agent', id: 'agent-1', label: 'Claude' },
		participants: [{ id: 'p1', name: 'Ana' }],
		messages: [
			{ id: 'm1', chatId: 'c1', from: 'p1', role: 'editor', text: 'add three trees', at: 1000, images: [{ mimeType: 'image/png', data: PIX, name: 'fire.png', w: 1, h: 1 }] },
			{ id: 'm2', chatId: 'c1', from: 'agent-1', replyTo: 'm1', text: 'Done — three trees.', at: 2000 }
		],
		log: [{ id: 'l1', tool: 'create_objects', summary: 'made 3 trees', at: 1500 }],
		...over
	};
}

describe('schema', () => {
	it('normalizes a chat and keeps the thread in order', () => {
		const c = normalizeChat(chat());
		expect(c.format).toBe(TPCHAT_FORMAT);
		expect(c.messages.map((/** @type {any} */ m) => m.id)).toEqual(['m1', 'm2']);
		expect(c.include).toBe(false); // private by default (F5)
		expect(c.target).toEqual({ kind: 'agent', id: 'agent-1', label: 'Claude' });
		expect(c.createdAt).toBe(2000);
	});
	it('refuses what is not a chat', () => {
		expect(normalizeChat(null)).toBeNull();
		expect(normalizeChat({ title: 'no id' })).toBeNull();
		expect(normalizeChat({ id: 'x'.repeat(65) })).toBeNull();
	});
	it('the last copy of a re-sent (streamed) message wins', () => {
		const c = normalizeChat(chat({ messages: [{ id: 'r', text: 'Do', at: 1 }, { id: 'r', text: 'Done', at: 2 }] }));
		expect(c.messages).toHaveLength(1);
		expect(c.messages[0].text).toBe('Done');
	});
	it('a message drops partial/type, keeps small unknown fields, caps pictures at four', () => {
		const m = normalizeMessage({ id: 'm', type: 'agentchat', partial: true, text: 'x', at: 5, futureFlag: true, big: { a: 1 }, images: Array(6).fill({ mimeType: 'image/png', data: PIX }) });
		expect(m.type).toBeUndefined();
		expect(m.partial).toBeUndefined();
		expect(m.futureFlag).toBe(true);
		expect(m.big).toBeUndefined();
		expect(m.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
	});
	it('a picture needs a known type and bytes or a key', () => {
		expect(normalizeImage({ mimeType: 'image/heic', data: PIX })).toBeNull();
		expect(normalizeImage({ mimeType: 'image/png' })).toBeNull();
		expect(normalizeImage({ mimeType: 'image/png', data: 'data:image/png;base64,' + PIX })?.data).toBe(PIX);
		expect(normalizeImage({ mimeType: 'image/png', key: 'abc', ref: 'h1' })).toEqual({ key: 'abc', mimeType: 'image/png', ref: 'h1' });
	});
});

describe('picture identity + the wire split', () => {
	it('keyOf is deterministic and content-sensitive', () => {
		expect(keyOf(PIX)).toBe(keyOf(PIX));
		expect(keyOf(PIX)).not.toBe(keyOf(PIX + 'A'));
		expect(keyOf(PIX)).toMatch(/^[0-9a-f]{14}$/);
	});
	it('split takes the bytes out, join puts them back', () => {
		const c = normalizeChat(chat());
		const { doc, images } = splitImages(c);
		const img = doc.messages[0].images[0];
		expect(img.data).toBeUndefined();
		expect(images[img.key].data).toBe(PIX);
		const back = joinImages(doc, (k) => images[k]);
		expect(back.messages[0].images[0].data).toBe(PIX);
	});
	it('join leaves a kept picture as a pointer for a file', () => {
		const c = normalizeChat(chat());
		c.messages[0].images[0].ref = 'hash-of-reference';
		const { doc, images } = splitImages(c);
		expect(joinImages(doc, (k) => images[k], { refs: false }).messages[0].images[0].data).toBeUndefined();
		expect(joinImages(doc, (k) => images[k], { refs: true }).messages[0].images[0].data).toBe(PIX);
	});
	it('base64 helpers', () => {
		expect(bareBase64('data:image/jpeg;base64,QUJD')).toBe('QUJD');
		expect(base64Bytes('QUJD')).toBe(3);
		expect(base64Bytes('QUI=')).toBe(2);
	});
});

describe('the ~50 MB cap', () => {
	const big = (/** @type {string} */ seed) => seed + 'A'.repeat(4 * 1024 * 1024); // ~3 MB each
	it('nothing to do under the cap', () => {
		expect(capPlan(normalizeChat(chat()))).toEqual([]);
	});
	it('thumbnails the OLDEST pictures first, never kept ones, until it fits', () => {
		const messages = [0, 1, 2, 3].map((i) => ({ id: 'm' + i, text: '', at: i, images: [{ mimeType: 'image/jpeg', data: big(String(i)) }] }));
		const c = normalizeChat({ id: 'c', messages });
		c.messages[0].images[0].ref = 'kept'; // the oldest is kept: its bytes are a scene asset
		const total = chatBytes(c);
		const max = total - 4 * 1024 * 1024; // must shed a bit more than one picture
		const keys = capPlan(c, undefined, max);
		expect(keys).toEqual([c.messages[1].images[0].key, c.messages[2].images[0].key]);
	});
});

describe('Markdown', () => {
	it('names people, tags, pictures and interleaves action lines', () => {
		const md = chatToMarkdown(normalizeChat(chat()));
		expect(md.startsWith('# Trees')).toBe(true);
		expect(md).toContain('**Ana** (editor)');
		expect(md).toContain('**Claude**');
		expect(md).toContain('_[picture: fire.png]_');
		expect(md).not.toContain('base64');
		expect(md.indexOf('made 3 trees')).toBeGreaterThan(md.indexOf('add three trees'));
		expect(md.indexOf('made 3 trees')).toBeLessThan(md.indexOf('Done — three trees'));
	});
	it('inline mode embeds pictures as data URLs', () => {
		expect(chatToMarkdown(normalizeChat(chat()), { images: 'inline' })).toContain('](data:image/png;base64,' + PIX + ')');
	});
	it('says "via terminal" for a CLI turn', () => {
		const md = chatToMarkdown(normalizeChat(chat({ messages: [{ id: 't', from: 'agent-1', role: 'user', via: 'cli', text: 'hi', at: 1 }] })));
		expect(md).toContain('via terminal');
	});
});

describe('files', () => {
	it('round-trips through .tpchat text without the live stamp', () => {
		const text = serializeTpchat({ ...chat(), changedAt: 99 });
		expect(text).not.toContain('changedAt');
		const back = parseTpchat(text);
		expect(back.messages[0].images[0].data).toBe(PIX);
		expect(back.title).toBe('Trees');
	});
	it('refuses a newer major format and junk', () => {
		expect(parseTpchat(JSON.stringify({ ...chat(), format: TPCHAT_FORMAT + 1 }))).toBeNull();
		expect(parseTpchat('not json')).toBeNull();
	});
});

describe('outward doors (fork F5)', () => {
	const payload = { name: 'S', objects: [], chats: [{ id: 'a', include: false }, { id: 'b', include: true }] };
	it('a door keeps only the included chats; the scene’s own save keeps all', () => {
		expect(payloadForDoor(payload, 'published').chats.map((/** @type {any} */ c) => c.id)).toEqual(['b']);
		expect(payloadForDoor(payload, 'all').chats).toHaveLength(2);
		expect(privateChatCount(payload)).toBe(1);
	});
	it('omits the field when nothing is left, and never mutates', () => {
		const p = { name: 'S', chats: [{ id: 'a' }] };
		const out = payloadForDoor(p, 'published');
		expect('chats' in out).toBe(false);
		expect(p.chats).toHaveLength(1);
		const plain = { name: 'S' };
		expect(payloadForDoor(plain, 'published')).toBe(plain); // byte-identical path for chat-free scenes
	});
	it('chatsForDoor', () => {
		expect(chatsForDoor(null, 'all')).toEqual([]);
		expect(chatsForDoor([{ include: true }, {}], 'published')).toHaveLength(1);
	});
});
