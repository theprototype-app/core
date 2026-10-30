// Roadmap 56 C10 — CHATS ARE FILES: the `.tpchat` format, PURE (imports nothing, so the unit layer
// covers it with no browser). The store, the wire and the Explorer cards live in tpchatStore.js.
//
// A `.tpchat` is ONE conversation as JSON: its messages (the `agentchat` wire record minus `type`,
// 56-bridge Q1 / 56-chat Q2), the 55 A8 action lines, who took part, and its pictures. A picture is
// either EMBEDDED (`data`, base64 of the already downscaled + EXIF-stripped bytes the sender sent) or,
// once somebody pressed Keep in Explorer, a POINTER at the scene's References asset (`ref` = that
// Explorer content hash) whose bytes travel as an ordinary scene asset. Past the ~50 MB cap the oldest
// embedded pictures become thumbnails (`thumb: true`) — the words of a conversation are never dropped.
//
// IMAGE IDENTITY. Inside a chat a picture is keyed by `key` = a cheap sync hash of its base64 text:
// the live store keeps the bytes ONCE in a cache by key, so the whole-document wire message carries
// each picture over the network once (tpchatStore's sent-key set) and two messages showing the same
// picture hold one copy. It is an identity, not a security property (sha256 is the Explorer's).
//
// PRIVATE BY DEFAULT (fork F5). A chat is scene data and saves with the scene (its own file, a cloud
// save, autosave), but every OUTWARD door — downloading a .tpscene, Publish, export as a game, a .tp
// project — keeps only the chats whose `include` switch ("Include when publishing") is on.

export const TPCHAT_FORMAT = 1;
export const TPCHAT_EXT = '.tpchat';
/** the cap per chat (C10): past it the oldest embedded pictures turn into thumbnails */
export const MAX_CHAT_BYTES = 50 * 1024 * 1024;
/** C8: at most four pictures per message */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** what a thumbnail is assumed to cost when planning the cap (the store makes them ≤ 256 px WebP) */
export const THUMB_BYTES = 16 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const MAX_MESSAGES = 5000;
const MAX_LOG = 2000;
const MAX_TEXT = 100_000;
const MAX_ID = 64;

/** @param {unknown} v @param {number} [max] @returns {string} */
function str(v, max = 1000) {
	return typeof v === 'string' ? v.slice(0, max) : '';
}
/** @param {unknown} v @returns {string} an id (≤ 64 chars) or '' */
function idOf(v) {
	return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : '';
}
/** @param {unknown} v @returns {number} */
function num(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * FNV-1a over a string, 53 bits (two 32-bit lanes folded), as 14 hex chars. Sync and deterministic,
 * so every peer derives the same key from the same base64 text.
 * @param {string} s @returns {string}
 */
export function keyOf(s) {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193 ^ s.length;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
	}
	return (h1.toString(16).padStart(8, '0') + (h2 & 0x1fffff).toString(16).padStart(6, '0')).slice(0, 14);
}

/** "data:image/png;base64,AAAA" → "AAAA"; a bare base64 string passes through @param {unknown} v */
export function bareBase64(v) {
	if (typeof v !== 'string') return '';
	const comma = v.startsWith('data:') ? v.indexOf(',') : -1;
	return comma >= 0 ? v.slice(comma + 1) : v;
}

/** bytes a base64 string decodes to @param {string} b64 */
export function base64Bytes(b64) {
	if (!b64) return 0;
	const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/**
 * One picture of a message. Needs `data` or a `key` (a key alone = the bytes are in the store's cache
 * or, with `ref`, in the scene's References asset). Unknown MIME types are refused: the agent's model
 * reads jpeg / png / webp / gif.
 * @param {any} img @returns {any | null}
 */
export function normalizeImage(img) {
	if (!img || typeof img !== 'object') return null;
	const mimeType = IMAGE_TYPES.includes(img.mimeType) ? img.mimeType : '';
	if (!mimeType) return null;
	const data = bareBase64(img.data);
	const key = data ? keyOf(data) : str(img.key, 32);
	if (!key) return null;
	/** @type {any} */
	const out = { key, mimeType };
	if (data) out.data = data;
	const name = str(img.name, 120);
	if (name) out.name = name;
	if (num(img.w) > 0) out.w = Math.round(num(img.w));
	if (num(img.h) > 0) out.h = Math.round(num(img.h));
	const ref = str(img.ref, 128);
	if (ref) out.ref = ref;
	if (img.thumb === true) out.thumb = true;
	return out;
}

/** fields of a message record this build understands (the rest: small primitives pass through) */
const MESSAGE_FIELDS = new Set(['id', 'chatId', 'from', 'name', 'to', 'replyTo', 'role', 'via', 'text', 'at', 'images', 'ask', 'answers', 'cancelled', 'partial', 'type']);

/**
 * One message: the `agentchat` record minus `type` (and minus `partial` — a file holds what was SAID,
 * the streaming state is the window's). A field a newer build adds rides through when it is a small
 * primitive, so an older peer re-saving a chat does not strip it.
 * @param {any} m @returns {any | null}
 */
export function normalizeMessage(m) {
	if (!m || typeof m !== 'object') return null;
	const id = idOf(m.id);
	if (!id) return null;
	/** @type {any} */
	const out = { id };
	for (const k of ['chatId', 'from', 'to', 'replyTo', 'answers']) {
		const v = idOf(m[k]);
		if (v) out[k] = v;
	}
	for (const k of ['name', 'role', 'via']) {
		const v = str(m[k], 120);
		if (v) out[k] = v;
	}
	out.text = str(m.text, MAX_TEXT);
	out.at = num(m.at);
	if (Array.isArray(m.images)) {
		const images = m.images.slice(0, MAX_IMAGES_PER_MESSAGE).map(normalizeImage).filter(Boolean);
		if (images.length) out.images = images;
	}
	if (m.ask && typeof m.ask === 'object') {
		const options = Array.isArray(m.ask.options) ? m.ask.options.slice(0, 10).map((/** @type {any} */ o) => str(o, 200)).filter(Boolean) : [];
		out.ask = { question: str(m.ask.question, 2000), options };
	}
	if (m.cancelled === true) out.cancelled = true;
	for (const [k, v] of Object.entries(m)) {
		if (MESSAGE_FIELDS.has(k) || k in out) continue;
		if ((typeof v === 'string' && v.length <= 1000) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
	}
	return out;
}

/** an A8 action line, kept as small plain JSON (the agentLog shape is 55's; this only bounds it) @param {any} e */
function normalizeLogEntry(e) {
	if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
	try {
		const json = JSON.stringify(e);
		return json.length <= 4000 ? JSON.parse(json) : null;
	} catch {
		return null;
	}
}

/** @param {any} t */
function normalizeTarget(t) {
	const kind = t?.kind === 'provider' ? 'provider' : 'agent';
	return { kind, id: str(t?.id, 120), label: str(t?.label, 120) };
}

/**
 * A whole chat. Returns null for something that is not one (no id). Message order is kept as given —
 * the window appends in arrival order and the file must replay the same thread.
 * @param {any} doc @returns {any | null}
 */
export function normalizeChat(doc) {
	if (!doc || typeof doc !== 'object') return null;
	const id = idOf(doc.id);
	if (!id) return null;
	const seen = new Set();
	/** @type {any[]} */
	const messages = [];
	for (const raw of Array.isArray(doc.messages) ? doc.messages : []) {
		const m = normalizeMessage(raw);
		if (!m) continue;
		// the window re-sends one id with longer text while it streams: the LAST one is the message
		if (seen.has(m.id)) {
			const at = messages.findIndex((x) => x.id === m.id);
			messages[at] = m;
			continue;
		}
		seen.add(m.id);
		messages.push(m);
	}
	const participants = (Array.isArray(doc.participants) ? doc.participants : [])
		.slice(0, 50)
		.map((/** @type {any} */ p) => {
			const pid = idOf(p?.id);
			if (!pid) return null;
			/** @type {any} */
			const row = { id: pid, name: str(p?.name, 120) };
			const kind = str(p?.kind, 20);
			if (kind) row.kind = kind;
			return row;
		})
		.filter(Boolean);
	const lastAt = messages.reduce((t, m) => Math.max(t, m.at), 0);
	return {
		format: TPCHAT_FORMAT,
		id,
		title: str(doc.title, 120).trim() || 'Chat',
		target: normalizeTarget(doc.target),
		participants,
		messages: messages.slice(-MAX_MESSAGES),
		log: (Array.isArray(doc.log) ? doc.log : []).map(normalizeLogEntry).filter(Boolean).slice(-MAX_LOG),
		include: doc.include === true,
		createdAt: num(doc.createdAt) || lastAt,
		updatedAt: num(doc.updatedAt) || lastAt,
		changedAt: num(doc.changedAt)
	};
}

/**
 * Take the picture bytes OUT of a chat: the doc keeps `{key, mimeType, …}` and the bytes go into the
 * returned map. What the store keeps live, and what the wire uses to send each picture once.
 * @param {any} doc a normalized chat @returns {{doc: any, images: Record<string, {mimeType: string, data: string}>}}
 */
export function splitImages(doc) {
	/** @type {Record<string, {mimeType: string, data: string}>} */
	const images = {};
	const messages = doc.messages.map((/** @type {any} */ m) => {
		if (!m.images) return m;
		return {
			...m,
			images: m.images.map((/** @type {any} */ img) => {
				if (!img.data) return img;
				images[img.key] = { mimeType: img.mimeType, data: img.data };
				const { data, ...rest } = img;
				void data;
				return rest;
			})
		};
	});
	return { doc: { ...doc, messages }, images };
}

/**
 * Put bytes back from a cache. `refs: false` leaves a kept picture as a pointer (the file form: its
 * bytes are the References asset); `refs: true` fills it too when the cache holds it (what the window
 * and the agent read).
 * @param {any} doc @param {(key: string) => ({data: string} | null | undefined)} lookup
 * @param {{refs?: boolean}} [opts] @returns {any}
 */
export function joinImages(doc, lookup, opts = {}) {
	const withRefs = opts.refs !== false;
	return {
		...doc,
		messages: doc.messages.map((/** @type {any} */ m) => {
			if (!m.images) return m;
			return {
				...m,
				images: m.images.map((/** @type {any} */ img) => {
					if (img.ref && !withRefs) {
						const { data, ...rest } = img;
						void data;
						return rest;
					}
					if (img.data) return img;
					const hit = lookup(img.key);
					return hit?.data ? { ...img, data: hit.data } : img;
				})
			};
		})
	};
}

/** every picture of a chat in thread order, with the message it belongs to @param {any} doc */
export function imagesOf(doc) {
	/** @type {{msgId: string, at: number, img: any}[]} */
	const out = [];
	for (const m of doc?.messages ?? []) for (const img of m.images ?? []) out.push({ msgId: m.id, at: m.at, img });
	return out;
}

/**
 * Bytes a chat costs as a file: its text plus every embedded picture (a key's bytes counted once).
 * @param {any} doc @param {(key: string) => ({data: string} | null | undefined)} [lookup]
 */
export function chatBytes(doc, lookup) {
	let bytes = 0;
	const counted = new Set();
	for (const m of doc?.messages ?? []) {
		bytes += (m.text?.length ?? 0) + 120;
		for (const img of m.images ?? []) {
			if (img.ref || counted.has(img.key)) continue;
			counted.add(img.key);
			const data = img.data ?? lookup?.(img.key)?.data ?? '';
			bytes += img.thumb ? Math.min(base64Bytes(data), THUMB_BYTES) : base64Bytes(data);
		}
	}
	return bytes + (doc?.log?.length ?? 0) * 200;
}

/**
 * The C10 cap: which pictures to turn into thumbnails, OLDEST FIRST, until the chat fits. Kept pictures
 * (their bytes are a scene asset) and existing thumbnails are never picked. Pure: the store does the
 * re-encode and saves again.
 * @param {any} doc @param {(key: string) => ({data: string} | null | undefined)} [lookup]
 * @param {number} [maxBytes] @returns {string[]} keys
 */
export function capPlan(doc, lookup, maxBytes = MAX_CHAT_BYTES) {
	let bytes = chatBytes(doc, lookup);
	if (bytes <= maxBytes) return [];
	/** @type {string[]} */
	const keys = [];
	const picked = new Set();
	for (const { img } of imagesOf(doc)) {
		if (bytes <= maxBytes) break;
		if (img.ref || img.thumb || picked.has(img.key)) continue;
		const size = base64Bytes(img.data ?? lookup?.(img.key)?.data ?? '');
		if (size <= THUMB_BYTES) continue;
		picked.add(img.key);
		keys.push(img.key);
		bytes -= size - THUMB_BYTES;
	}
	return keys;
}

/** @param {number} at */
function stamp(at) {
	if (!at) return '';
	const d = new Date(at);
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** @param {any} entry an A8 log line */
function logLine(entry) {
	const tool = str(entry?.tool ?? entry?.name, 80);
	const summary = str(entry?.summary ?? entry?.text ?? entry?.label, 300);
	return [tool, summary].filter(Boolean).join(': ') || 'action';
}

/**
 * C10 "Download as Markdown". Pictures: kept ones are named (their file is in the scene), embedded ones
 * inline as data URLs only with `images: 'inline'` (a 40 MB .md is not what "download as text" means),
 * else a placeholder. A8 action lines interleave by time when they carry one.
 * @param {any} doc a normalized chat
 * @param {{images?: 'inline' | 'names', nameOf?: (id: string) => string}} [opts]
 * @returns {string}
 */
export function chatToMarkdown(doc, opts = {}) {
	const inline = opts.images === 'inline';
	const who = (/** @type {any} */ m) =>
		m.name || opts.nameOf?.(m.from) || doc.participants?.find((/** @type {any} */ p) => p.id === m.from)?.name || (m.from === doc.target?.id ? doc.target.label : '') || m.from || 'someone';
	const first = doc.messages[0]?.at ?? doc.createdAt;
	const last = doc.messages[doc.messages.length - 1]?.at ?? doc.updatedAt;
	const lines = ['# ' + doc.title.replace(/\n/g, ' '), ''];
	const span = [stamp(first), stamp(last)].filter(Boolean);
	lines.push('_Chat with ' + (doc.target?.label || 'the assistant') + (span.length ? ' · ' + [...new Set(span)].join(' – ') : '') + '_', '');
	/** @type {{at: number, md: string}[]} */
	const rows = [];
	for (const m of doc.messages) {
		const tags = [m.role, m.via === 'cli' ? 'via terminal' : m.via, m.cancelled ? 'stopped' : ''].filter(Boolean);
		const head = '**' + who(m) + '**' + (tags.length ? ' (' + tags.join(', ') + ')' : '') + (m.at ? ' · ' + stamp(m.at) : '');
		const body = [head, '', m.text || (m.ask ? m.ask.question : '')];
		if (m.ask?.options?.length) body.push('', m.ask.options.map((/** @type {string} */ o) => '- ' + o).join('\n'));
		for (const img of m.images ?? []) {
			const label = img.name || 'image';
			if (inline && img.data) body.push('', '![' + label + '](data:' + img.mimeType + ';base64,' + img.data + ')');
			else if (img.ref) body.push('', '_[picture: ' + label + ' — kept in the scene’s References]_');
			else body.push('', '_[picture: ' + label + (img.thumb ? ', thumbnail' : '') + ']_');
		}
		rows.push({ at: m.at, md: body.join('\n') });
	}
	for (const e of doc.log ?? []) {
		const at = num(e?.at);
		if (!at) continue;
		rows.push({ at, md: '> ⚙ ' + logLine(e) });
	}
	// stable: messages keep their order; a log line slots in after the last message not newer than it
	rows.sort((a, b) => (a.at && b.at ? a.at - b.at : 0));
	lines.push(rows.map((r) => r.md).join('\n\n'), '');
	return lines.join('\n');
}

/** a file name for a chat (no path characters) @param {any} doc @param {string} ext */
export function chatFileName(doc, ext = TPCHAT_EXT) {
	const base = String(doc?.title || 'Chat').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 80) || 'Chat';
	return base + ext;
}

/** a chat as `.tpchat` text (pictures as given — pass a joined doc for a self-contained file) @param {any} doc */
export function serializeTpchat(doc) {
	const chat = normalizeChat(doc);
	if (!chat) return '';
	const { changedAt, ...rest } = chat;
	void changedAt;
	return JSON.stringify(rest);
}

/** `.tpchat` text → a chat, or null. A NEWER major format is refused rather than half-read. @param {string} text */
export function parseTpchat(text) {
	try {
		const raw = JSON.parse(text);
		if (!raw || typeof raw !== 'object') return null;
		if (num(raw.format) > TPCHAT_FORMAT) return null;
		return normalizeChat(raw);
	} catch {
		return null;
	}
}

/**
 * Which chats an outward door may carry. `'all'` = the scene's own save (its file, a cloud save,
 * autosave); anything else = only the chats whose Include-when-publishing switch is on.
 * @param {any[] | null | undefined} chats @param {'all' | 'published'} mode @returns {any[]}
 */
export function chatsForDoor(chats, mode) {
	if (!Array.isArray(chats)) return [];
	return mode === 'all' ? chats : chats.filter((c) => c?.include === true);
}

/**
 * A scene payload as an outward door may write it: `chats` filtered, and OMITTED when nothing is left
 * so a scene without chats stays byte-identical. Never mutates the payload.
 * @param {any} payload @param {'all' | 'published'} mode @returns {any}
 */
export function payloadForDoor(payload, mode) {
	if (!payload || typeof payload !== 'object' || !('chats' in payload)) return payload;
	const kept = chatsForDoor(payload.chats, mode);
	const out = { ...payload };
	if (kept.length) out.chats = kept;
	else delete out.chats;
	return out;
}

/** how many chats a door would leave out (for the export toast) @param {any} payload */
export function privateChatCount(payload) {
	return Array.isArray(payload?.chats) ? payload.chats.filter((/** @type {any} */ c) => c?.include !== true).length : 0;
}
