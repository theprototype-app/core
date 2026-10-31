// Roadmap 56 C10 (+ C8 Keep in Explorer) — THE CHATS OF A SCENE, live: store, wire, saves, seams.
// The format is tpchatCore.js (pure); this module is everything that needs a store or a peer.
//
// WHAT A CHAT IS HERE. Scene data, like the HUD or the Timeline's sequences: it saves INSIDE the scene
// payload (`chats`, omitted when there are none, so every other scene stays byte-identical), rides
// autosave and cloud saves, and a late joiner gets it through `gettpchats`. The Explorer shows each one
// as a `<title>.tpchat` card in the derived Scene ▸ chats folder (sceneAssets entry source below) —
// a READING of this store, never a library record, so there is no second copy to keep in step and no
// file hash churning on every reply.
//
// ONE WRITER (56-chat Q2). The AI window calls `saveChat(chat)` debounced from ONE peer per session
// (the host if it is an editor, else the lowest-id editor). That makes the whole-document latest-wins
// on `changedAt` (the hudSync shape, golden rule 7) exactly right: there is no concurrent author to
// lose. Rename / delete / the publish switch are rare edits by any editor and ride the same rule.
//
// PICTURES TRAVEL ONCE. The live doc holds `{key, mimeType, …}` and the bytes sit in `imageCache` by
// key; the `tpchat` message carries `data` only for keys this peer has not broadcast yet, and every
// receiver re-joins from its own cache. A full-state reply (`tpchats`) carries everything.
//
// PRIVATE BY DEFAULT (F5): `chatsSnapshot('published')` is what an outward door writes — see the
// `payloadForDoor` callers in sessions.js / projectFile.js / cloudPlugin.js / exportBuilder.js.
//
// REFERENCES (C8 Keep in Explorer). A kept picture becomes an image file in the Library's References
// folder (shared, so every peer files it the same way and the bytes ride assetShare, golden rule 9)
// AND a row in `chatRefs`, the scene's own list — which is what puts it under Scene ▸ references and
// into `sceneAssetList()`, so a saved .tpscene bundles its bytes like any texture.
//
// A LEAF for the history cycle: svelte/store + appStore + sessionClock + the two pure modules; the
// Explorer, assetShare and sharedLibrary are DYNAMIC imports. No history kind: a chat is a record of a
// conversation, not an edit to undo.

import { get, writable, derived } from 'svelte/store';
import { peers, showToast } from '../../stores/appStore';
import { sessionNow } from '../sessionClock';
import { rolesInfo } from '../cloudHooks';
import {
	normalizeChat,
	normalizeImage,
	splitImages,
	joinImages,
	capPlan,
	chatToMarkdown,
	chatFileName,
	serializeTpchat,
	parseTpchat,
	chatsForDoor,
	keyOf,
	TPCHAT_EXT
} from './tpchatCore.js';

/** @type {import('svelte/store').Writable<Record<string, any>>} id -> chat (pictures as keys) */
export const chats = writable({});

/** picture bytes by key — shared by every chat of the scene @type {Map<string, {mimeType: string, data: string}>} */
const imageCache = new Map();
/** keys whose bytes this peer has already put on the wire (whole-mesh broadcasts) */
const sentKeys = new Set();
/** id -> stamp of a delete, so a stale document cannot resurrect it this session */
const deletedAt = new Map();

/** C10: the list the AI window's history icon reads — newest first */
export const chatList = derived(chats, ($chats) =>
	Object.values($chats)
		.map((c) => ({
			id: c.id,
			title: c.title,
			target: c.target,
			updatedAt: c.updatedAt,
			count: c.messages.length,
			include: c.include
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
);

/** @type {import('svelte/store').Writable<{list: any[], changedAt: number}>} C8: kept pictures */
export const chatRefs = writable({ list: [], changedAt: 0 });

// ---- helpers -----------------------------------------------------------------------------------

/** @param {string} key */
function lookup(key) {
	return imageCache.get(key);
}

/** am I a viewer (cloud roles)? Inert without a plugin. */
function viewer() {
	/** @type {any} */
	const info = get(rolesInfo);
	return info?.myRole === 'viewer';
}

/** pictures of a normalized doc into the cache; returns the doc with keys only @param {any} doc */
function ingest(doc) {
	const { doc: bare, images } = splitImages(doc);
	for (const [key, img] of Object.entries(images)) if (!imageCache.has(key)) imageCache.set(key, img);
	return bare;
}

/** the wire form: pictures this peer has not broadcast yet carry their bytes @param {any} doc @param {boolean} all */
function wireDoc(doc, all) {
	const joined = joinImages(doc, (key) => (all || !sentKeys.has(key) ? lookup(key) : null), { refs: true });
	if (!all) for (const m of doc.messages) for (const img of m.images ?? []) if (imageCache.has(img.key)) sentKeys.add(img.key);
	const { changedAt, ...rest } = joined;
	return { ...rest, changedAt };
}

/** @param {any} msg */
function broadcast(msg) {
	/** @type {any} */
	const peer = get(peers);
	try {
		peer?.send?.(msg);
	} catch {
		/* a send must never break a save */
	}
}

/** @param {string} id @param {any} doc */
function put(id, doc) {
	chats.update((all) => {
		const next = { ...all };
		if (doc) next[id] = doc;
		else delete next[id];
		return next;
	});
}

// ---- the API the AI window (56-chat) and the agent page (56-bridge) call ------------------------

/**
 * One chat with its pictures filled in from the cache (kept ones too, when held), or null. SYNC —
 * `await readChat(id)` works the same.
 * @param {string} id @returns {any | null}
 */
export function readChat(id) {
	const doc = get(chats)[id];
	return doc ? joinImages(doc, lookup, { refs: true }) : null;
}

/** @returns {string[]} */
export function chatIds() {
	return Object.keys(get(chats));
}

/**
 * C10: the window's ONE writer hands over the whole chat (debounced). Normalized, stamped, kept, and
 * replicated whole. Returns the stored doc (pictures as keys), or null when refused.
 * @param {any} chat @param {{silent?: boolean}} [opts] `silent` = store only (a restore, an import before broadcast)
 * @returns {any | null}
 */
export function saveChat(chat, opts = {}) {
	if (!opts.silent && viewer()) return null; // viewers read the thread (C5); the cloud gate drops it anyway
	const norm = normalizeChat(chat);
	if (!norm) return null;
	const prev = get(chats)[norm.id];
	// fields the window does not own survive its saves: the publish switch is set from the Explorer
	if (prev && chat?.include === undefined) norm.include = prev.include;
	if (prev && !chat?.title) norm.title = prev.title;
	norm.createdAt = prev?.createdAt || norm.createdAt || Date.now();
	norm.updatedAt = Math.max(norm.updatedAt, prev?.updatedAt ?? 0) || Date.now();
	norm.changedAt = Math.max(sessionNow(), (prev?.changedAt ?? 0) + 1);
	// a kept picture stays kept whoever saved the message last
	const kept = new Map(get(chatRefs).list.map((r) => [r.key, r.hash]));
	for (const m of norm.messages) for (const img of m.images ?? []) if (!img.ref && kept.has(img.key)) img.ref = kept.get(img.key);
	const doc = ingest(norm);
	deletedAt.delete(doc.id);
	put(doc.id, doc);
	if (!opts.silent) broadcast({ type: 'tpchat', doc: wireDoc(doc, false) });
	void enforceCap(doc.id);
	return doc;
}

/** @param {string} id @param {(doc: any) => any} edit */
function editChat(id, edit) {
	if (viewer()) return null;
	const doc = get(chats)[id];
	if (!doc) return null;
	const next = { ...edit(doc), changedAt: Math.max(sessionNow(), doc.changedAt + 1) };
	put(id, next);
	broadcast({ type: 'tpchat', doc: wireDoc(next, false) });
	return next;
}

/** C10 rename (Explorer + window) @param {string} id @param {string} title */
export function renameChat(id, title) {
	const t = String(title ?? '').trim().slice(0, 120);
	if (!t) return null;
	return editChat(id, (doc) => ({ ...doc, title: t }));
}

/** F5: "Include when publishing" @param {string} id @param {boolean} include */
export function setChatInclude(id, include) {
	return editChat(id, (doc) => ({ ...doc, include: include === true }));
}

/** C10 delete (Explorer + window) — replicated, with a stamp so a stale copy cannot bring it back @param {string} id */
export function deleteChat(id) {
	if (viewer() || !get(chats)[id]) return false;
	const at = Math.max(sessionNow(), (get(chats)[id]?.changedAt ?? 0) + 1);
	deletedAt.set(id, at);
	put(id, null);
	broadcast({ type: 'tpchatdel', id, changedAt: at });
	return true;
}

// ---- C10: the cap (oldest pictures → thumbnails past ~50 MB) -----------------------------------

/** @param {string} key @returns {Promise<string | null>} a ≤ 256 px WebP as base64 */
async function thumbnailOf(key) {
	const img = imageCache.get(key);
	if (!img || typeof document === 'undefined') return null;
	try {
		const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: img.mimeType }));
		const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close?.();
		const url = canvas.toDataURL('image/webp', 0.7);
		return url.startsWith('data:image/webp') ? url.slice(url.indexOf(',') + 1) : null;
	} catch {
		return null;
	}
}

/** @type {Set<string>} */
const capping = new Set();
/** @param {string} id @param {number} [maxBytes] */
export async function enforceCap(id, maxBytes) {
	const doc = get(chats)[id];
	if (!doc || capping.has(id)) return 0;
	const keys = capPlan(doc, lookup, maxBytes);
	if (!keys.length) return 0;
	capping.add(id);
	try {
		/** @type {Map<string, string>} old key -> new key */
		const swapped = new Map();
		for (const key of keys) {
			const data = await thumbnailOf(key);
			if (!data) continue;
			const nk = keyOf(data);
			imageCache.set(nk, { mimeType: 'image/webp', data });
			swapped.set(key, nk);
		}
		if (!swapped.size) return 0;
		const cur = get(chats)[id];
		if (!cur) return 0;
		const messages = cur.messages.map((/** @type {any} */ m) =>
			m.images?.some((/** @type {any} */ i) => swapped.has(i.key))
				? { ...m, images: m.images.map((/** @type {any} */ i) => (swapped.has(i.key) ? { ...i, key: swapped.get(i.key), mimeType: 'image/webp', thumb: true } : i)) }
				: m
		);
		const next = { ...cur, messages, changedAt: Math.max(sessionNow(), cur.changedAt + 1) };
		put(id, next);
		if (!viewer()) broadcast({ type: 'tpchat', doc: wireDoc(next, false) });
		return swapped.size;
	} finally {
		capping.delete(id);
	}
}

// ---- the wire -----------------------------------------------------------------------------------

/**
 * One chat from a peer: latest-wins on `changedAt`; refused when it is older than a delete we saw.
 * @param {any} data
 */
export function applyRemoteTpchat(data) {
	const norm = normalizeChat(data?.doc);
	if (!norm) return;
	norm.changedAt = Number(data.doc.changedAt) || 0;
	const mine = get(chats)[norm.id];
	if (mine && mine.changedAt > norm.changedAt) return;
	if ((deletedAt.get(norm.id) ?? 0) >= norm.changedAt) return;
	put(norm.id, ingest(norm));
}

/** @param {any} data */
export function applyRemoteTpchatDelete(data) {
	const id = String(data?.id ?? '');
	const at = Number(data?.changedAt) || 0;
	const mine = get(chats)[id];
	if (mine && mine.changedAt > at) return;
	deletedAt.set(id, Math.max(at, deletedAt.get(id) ?? 0));
	if (mine) put(id, null);
}

/** the full-state reply @param {any} data */
export function applyRemoteTpchats(data) {
	for (const doc of Array.isArray(data?.chats) ? data.chats : []) applyRemoteTpchat({ doc });
	if (data?.refs) applyRemoteChatRefs(data.refs);
}

/**
 * Full state for a late joiner (golden rule 3), retried until the conn is OPEN (golden rule 2).
 * @param {string} peerId @param {number} [tries]
 */
export function sendTpchats(peerId, tries = 0) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn) return;
	if (!conn.open) {
		if (tries < 40) setTimeout(() => sendTpchats(peerId, tries + 1), 250);
		return;
	}
	const all = Object.values(get(chats));
	const refs = get(chatRefs);
	if (!all.length && !refs.list.length) return; // nothing to say: the handshake stays quiet
	conn.send({ type: 'tpchats', chats: all.map((d) => wireDoc(d, true)), refs });
}

// ---- C8: Keep in Explorer → References -----------------------------------------------------------

export const REFERENCES_FOLDER = 'References';

/** the Library folder kept pictures land in (created once, shared so peers file it the same way) */
async function referencesFolderId() {
	const explorer = await import('../explorer');
	await explorer.loadExplorer();
	const found = get(explorer.explorerFolders).find((f) => f.name === REFERENCES_FOLDER && !f.parentId);
	if (found) return found.id;
	const made = explorer.createFolder(REFERENCES_FOLDER, null);
	return made?.id ?? null;
}

/** base64 → ArrayBuffer @param {string} b64 */
function bytesOf(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

/**
 * C8 "Keep in Explorer": a picture (from a message, or one still in the composer) becomes an image file
 * in the Library's References folder AND a row of the scene's References list. Idempotent per picture.
 * Editors and admins only. Resolves the Explorer item, or null.
 * @param {any} image `{data|key, mimeType, name?, w?, h?}` @param {{chatId?: string, msgId?: string}} [ctx]
 */
export async function keepImage(image, ctx = {}) {
	if (viewer()) {
		showToast('View-only — ask an editor to keep this picture.');
		return null;
	}
	const img = normalizeImage(image);
	if (!img) return null;
	const data = img.data ?? imageCache.get(img.key)?.data;
	if (!data) {
		showToast('This picture is not on this device yet.');
		return null;
	}
	if (!imageCache.has(img.key)) imageCache.set(img.key, { mimeType: img.mimeType, data });
	const explorer = await import('../explorer');
	const folderId = await referencesFolderId();
	const ext = img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/gif' ? '.gif' : img.mimeType === 'image/webp' ? '.webp' : '.jpg';
	const base = String(img.name || 'reference').replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'reference';
	const item = await explorer.addItemFromBytes(bytesOf(data), base + ext, folderId);
	if (!item) return null;
	// shared: peers file it in the same folder, and the bytes ride assetShare like any shared file
	try {
		const lib = await import('../sharedLibrary');
		if (folderId) lib.shareFolder?.(folderId);
		lib.shareItem?.(item.id);
		const assets = await import('../assetShare');
		void assets.sendAsset(item.hash);
	} catch {
		/* sharing is best-effort: the scene list below still names the hash for a pull */
	}
	const cur = get(chatRefs);
	if (!cur.list.some((r) => r.hash === item.hash)) {
		const row = { hash: item.hash, key: img.key, name: item.name, mimeType: img.mimeType, w: img.w ?? 0, h: img.h ?? 0, chatId: ctx.chatId ?? '', msgId: ctx.msgId ?? '', at: Date.now() };
		setRefs([...cur.list, row]);
	}
	// the chat's copy becomes a pointer at the asset (its bytes now travel as a scene asset)
	for (const doc of Object.values(get(chats))) {
		if (!doc.messages.some((/** @type {any} */ m) => m.images?.some((/** @type {any} */ i) => i.key === img.key && !i.ref))) continue;
		editChat(doc.id, (d) => ({
			...d,
			messages: d.messages.map((/** @type {any} */ m) => (m.images ? { ...m, images: m.images.map((/** @type {any} */ i) => (i.key === img.key ? { ...i, ref: item.hash } : i)) } : m))
		}));
	}
	showToast('Kept in Explorer ▸ ' + REFERENCES_FOLDER + ': ' + item.name);
	return item;
}

/** is this picture kept already? @param {any} image */
export function isKept(image) {
	const key = image?.key ?? (image?.data ? keyOf(String(image.data).replace(/^data:[^,]*,/, '')) : '');
	return !!image?.ref || get(chatRefs).list.some((r) => r.key === key);
}

/** drop a picture from the scene's References list (its Library file stays — delete it there) @param {string} hash */
export function forgetReference(hash) {
	if (viewer()) return;
	setRefs(get(chatRefs).list.filter((r) => r.hash !== hash));
}

/** @param {any[]} list @param {{silent?: boolean}} [opts] */
function setRefs(list, opts = {}) {
	const next = { list: normalizeRefs(list), changedAt: Math.max(sessionNow(), get(chatRefs).changedAt + 1) };
	chatRefs.set(next);
	if (!opts.silent) broadcast({ type: 'tprefs', refs: next });
}

/** @param {any} list */
function normalizeRefs(list) {
	if (!Array.isArray(list)) return [];
	const seen = new Set();
	/** @type {any[]} */
	const out = [];
	for (const r of list.slice(0, 500)) {
		const hash = typeof r?.hash === 'string' && r.hash.length <= 128 ? r.hash : '';
		if (!hash || seen.has(hash)) continue;
		seen.add(hash);
		out.push({
			hash,
			key: String(r.key ?? '').slice(0, 32),
			name: String(r.name ?? 'reference').slice(0, 120),
			mimeType: String(r.mimeType ?? 'image/jpeg').slice(0, 40),
			w: Number(r.w) || 0,
			h: Number(r.h) || 0,
			chatId: String(r.chatId ?? '').slice(0, 64),
			msgId: String(r.msgId ?? '').slice(0, 64),
			at: Number(r.at) || 0
		});
	}
	return out;
}

/** @param {any} data `{list, changedAt}` */
export function applyRemoteChatRefs(data) {
	const at = Number(data?.changedAt) || 0;
	if (get(chatRefs).changedAt > at) return;
	chatRefs.set({ list: normalizeRefs(data?.list), changedAt: at });
	void pullMissingRefs();
}

/** a peer that has the bytes in its chat cache files them itself; otherwise the shared library pulls */
async function pullMissingRefs() {
	const explorer = await import('../explorer');
	for (const r of get(chatRefs).list) {
		if (explorer.itemByHash(r.hash)) continue;
		const cached = imageCache.get(r.key);
		if (cached) continue; // the References row arrives through the shared index; the bytes come with it
		try {
			const assets = await import('../assetShare');
			assets.requestAsset(r.hash);
		} catch {
			/* nobody to ask */
		}
	}
}

// ---- saves: scene payload, autosave, the outward doors ------------------------------------------

/**
 * The chats as a scene payload carries them — each a self-contained `.tpchat` (pictures embedded,
 * kept ones as pointers at their References asset). `null` when there are none (field omitted).
 * @param {'all' | 'published'} [mode] `'published'` = only chats with the Include switch on
 * @returns {any[] | null}
 */
export function chatsSnapshot(mode = 'all') {
	const all = Object.values(get(chats))
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
		.map((doc) => {
			const { changedAt, ...file } = joinImages(doc, lookup, { refs: false });
			void changedAt;
			return file;
		});
	const kept = chatsForDoor(all, mode);
	return kept.length ? kept : null;
}

/** @returns {any | null} the References list, or null when empty */
export function chatRefsSnapshot() {
	const { list } = get(chatRefs);
	return list.length ? list.map(({ key, ...r }) => ({ key, ...r })) : null;
}

/**
 * Reinstate saved chats. A restore is an authoritative local write (fresh stamps, the hudDocs rule).
 * @param {any[] | null | undefined} list @param {any} refs @param {boolean} [replace] @param {boolean} [replicate]
 */
export function chatsRestore(list, refs, replace = false, replicate = false) {
	if (replace) {
		chats.set({});
		chatRefs.set({ list: [], changedAt: sessionNow() });
		deletedAt.clear();
	}
	if (Array.isArray(refs) && refs.length) {
		chatRefs.set({ list: normalizeRefs(refs), changedAt: sessionNow() });
		if (replicate) broadcast({ type: 'tprefs', refs: get(chatRefs) });
	}
	if (!Array.isArray(list)) return;
	let i = 0;
	for (const raw of list) {
		const norm = normalizeChat(raw);
		if (!norm) continue;
		norm.changedAt = sessionNow() + i++;
		const doc = ingest(norm);
		put(doc.id, doc);
		if (replicate) broadcast({ type: 'tpchat', doc: wireDoc(doc, true) });
	}
}

// ---- Explorer seams: cards, open, Markdown, .tpchat files ----------------------------------------

/** @type {((chatId: string) => void) | null} */
let opener = null;
/** 56-chat registers the AI window's "open this chat" @param {((chatId: string) => void) | null} fn */
export function registerChatOpener(fn) {
	opener = fn;
}

/** open a chat in the AI window (Explorer double-click, a drop on the window) @param {string} id */
export function openChat(id) {
	if (!get(chats)[id]) return false;
	if (!opener) {
		showToast('Open the AI assistant to read this chat.');
		return false;
	}
	opener(id);
	return true;
}

/**
 * The chat an Explorer card (or a dropped item / file) stands for. A Scene ▸ chats card carries its
 * id; a `.tpchat` FILE from the Library or the desktop is imported into the scene first.
 * @param {any} item @returns {Promise<string | null>}
 */
export async function chatIdOfItem(item) {
	if (!item) return null;
	if (typeof item.chatId === 'string') return get(chats)[item.chatId] ? item.chatId : null;
	/** @type {string} */
	let text = '';
	try {
		if (typeof item.text === 'function') text = await item.text();
		else if (item.id && String(item.name ?? '').toLowerCase().endsWith(TPCHAT_EXT)) {
			const explorer = await import('../explorer');
			const blob = await explorer.itemBlob(item.id);
			text = blob ? await blob.text() : '';
		}
	} catch {
		return null;
	}
	return text ? importTpchat(text) : null;
}

/**
 * A `.tpchat` file into the open scene. A chat whose id is already here is not overwritten: the file
 * gets a fresh id (it is a copy). Returns the id, or null for a file that is not a chat.
 * @param {string} text
 */
export function importTpchat(text) {
	const doc = parseTpchat(text);
	if (!doc) return null;
	if (get(chats)[doc.id]) doc.id = (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'chat-' + Date.now()).slice(0, 64);
	const saved = saveChat(doc);
	return saved ? saved.id : null;
}

/** @param {string} name @param {string} text @param {string} type */
function download(name, text, type) {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** C10 "Download as Markdown" @param {string} id @param {{images?: 'inline' | 'names'}} [opts] */
export function downloadChatMarkdown(id, opts = {}) {
	const doc = readChat(id);
	if (!doc) return false;
	download(chatFileName(doc, '.md'), chatToMarkdown(doc, opts), 'text/markdown');
	return true;
}

/** the chat as its own `.tpchat` file (self-contained: kept pictures embedded too) @param {string} id */
export function downloadTpchat(id) {
	const doc = readChat(id);
	if (!doc) return false;
	const self = { ...doc, messages: doc.messages.map((/** @type {any} */ m) => (m.images ? { ...m, images: m.images.map((/** @type {any} */ i) => { const { ref, ...rest } = i; void ref; return rest; }) } : m)) };
	download(chatFileName(doc), serializeTpchat(self), 'application/json');
	return true;
}

/** a picture as an object URL for an <img> (cache, else the References file) @param {any} image */
export async function imageUrl(image) {
	const img = normalizeImage(image) ?? image;
	const hit = img?.data ? { data: img.data, mimeType: img.mimeType } : imageCache.get(img?.key ?? '');
	if (hit?.data) return 'data:' + hit.mimeType + ';base64,' + hit.data;
	if (img?.ref) {
		const explorer = await import('../explorer');
		const item = explorer.itemByHash(img.ref);
		const blob = item ? await explorer.itemBlob(item.id) : null;
		if (blob) return URL.createObjectURL(blob);
	}
	return null;
}

/** Scene ▸ chats / Scene ▸ references cards (registered with sceneAssets at start) */
export function sceneEntries() {
	/** @type {any[]} */
	const out = [];
	for (const c of Object.values(get(chats)))
		out.push({ id: 'chat:' + c.id, group: 'chats', name: chatFileName(c), kind: 'tpchat', chatId: c.id, include: c.include, derived: true });
	for (const r of get(chatRefs).list)
		out.push({ id: 'ref:' + r.hash, group: 'references', name: r.name, kind: 'image', hash: r.hash, refEntry: true, derived: false });
	return out;
}

let started = false;
/** wire the store into the scene asset view + autosave's dirty signal (App start) */
export async function startTpchats() {
	if (started || typeof window === 'undefined') return;
	started = true;
	const scene = await import('../sceneAssets');
	scene.registerSceneEntrySource?.(sceneEntries);
	chats.subscribe(() => scene.refreshSceneAssets?.());
	chatRefs.subscribe(() => scene.refreshSceneAssets?.());
}

/** test seam (debugHooks): the whole state, pictures joined */
export function tpchatsForTest() {
	return { chats: Object.keys(get(chats)).map((id) => readChat(id)), refs: get(chatRefs), cached: imageCache.size, sent: sentKeys.size };
}
