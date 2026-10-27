// 50 Y1/Y2 — SHARED TEXT: one Yjs document per open code/text source, over the room's
// existing data channels (no new server). The arithmetic is `sharedTextCore.js`; this is the
// registry, the wire and the awareness (who else is here, their cursor and selection).
//
// THE MODEL. A shareable tab's BUFFER is a Y.Text every peer with that source open edits
// together: two people typing in one line both keep their text. The SOURCE (the node's code,
// the file's bytes) is untouched by typing and written only by Ctrl+S, exactly as before —
// so a save is still one ordinary `nodedata` / file write, and what lands on disk is plain
// text. The Y.Doc is session state: it exists while somebody has the source open.
//
// THE WIRE (all three carry Yjs's own binary encodings as raw bytes — golden rule 6):
//   ytext    {key, u}            an update (incremental, or a full diff answering getytext);
//            {key, none: true}   the answer "I do not hold that document"
//   ytextaw  {key, a}            an awareness update (cursor, selection, name, colour)
//   getytext {key, sv, sender}   "send me what I am missing" — a REQUEST, so it sits on the
//                                capability floor and is answered only within the room
// `ytext`/`ytextaw` are ROOM_SCOPED (a node id is the same in two copies of one scene).
// A viewer's ytext is dropped by the roles plugin's gate on every editor, and a viewer's own
// editor is read-only, so viewers watch and never write.
//
// OPENING: a peer asks every connected peer (`getytext`) and adopts the first document that
// comes back; if nobody holds one (every peer answered `none`, or 900 ms passed) it SEEDS the
// document from the source text under a client id derived from (key, text) — see
// sharedTextCore for why two simultaneous openers then agree.
//
// Yjs itself (yjs, y-protocols, y-codemirror.next) is loaded LAZILY with the first editor
// that binds; this module is in the main bundle only as the dispatcher's entry points.

import { writable, get } from 'svelte/store';
import { peers, username } from '../stores/appStore';
import { peerColor } from './lockControl';
import { isViewer } from './objectPermissions';
import { seedClientId, minimalEdit, isExternalWriter, lineAt, selectionTint, fnv1a, isDocKey } from './sharedTextCore';

/** how long an opener waits for the room before seeding the document itself */
const SEED_WAIT_MS = 900;
/** outbound updates are merged for this long (a burst of keys leaves as one message) */
const FLUSH_MS = 24;
/** a change that arrived through the source waits this long for the buffer to catch up first */
const FOLLOW_WAIT_MS = 450;
/** the last editor letting go keeps the document this long: a remount (dock <-> float, the
 * 50-window pop-out and back) re-binds the SAME document — undo history, cursors and all */
const RELEASE_GRACE_MS = 2000;

const REMOTE = 'tp-remote';
const SEED = 'tp-seed';
/** a Revert / a followed source change: shared like typing, but not in anyone's Ctrl+Z stack
 * (the undo manager tracks typing only — an automatic follow is nobody's edit to undo) */
const REPLACE = 'tp-replace';

/** @type {Promise<{Y: any, aw: any, cm: any}> | null} */
let loading = null;
/** @type {{Y: any, aw: any, cm: any} | null} */
let libs = null;
/** the lazy chunk: yjs + awareness + the CodeMirror binding, loaded together, once */
export function loadYjs() {
	loading ??= Promise.all([import('yjs'), import('y-protocols/awareness'), import('y-codemirror.next')]).then(([Y, aw, cm]) => (libs = { Y, aw, cm }));
	return loading;
}

/**
 * @typedef {{
 *   key: string, doc: any, text: any, meta: any, awareness: any, undo: any,
 *   refs: number, settled: boolean, ready: Promise<void>, settle: () => void,
 *   asked: Set<string>, answered: Set<string>, pending: Uint8Array[], timer: any,
 *   awPending: Set<number>, awTimer: any, remoteDepth: number, followTimer: any, seedText: string,
 *   dropTimer: any
 * }} Entry
 */
/** @type {Map<string, Entry>} */
const docs = new Map();

/** key -> the other people in that document: [{peerId, name, color, line, selected}] */
export const sharedPresence = writable(/** @type {Record<string, {peerId: string, name: string, color: string, line: number | null, selected: number}[]>} */ ({}));
/** the keys this peer holds open right now (tests + the tab badge) */
export const sharedDocs = writable(/** @type {string[]} */ ([]));

function myId() {
	/** @type {any} */
	const p = get(peers);
	return String(p?.peer?.id ?? '');
}
/** @returns {any} */
function peerConn() {
	return get(peers);
}
/** the peers whose connection is open @returns {string[]} */
function openPeers() {
	/** @type {any} */
	const p = get(peers);
	return p?.openedPeers ? [...p.openedPeers] : [];
}

/** @param {any} v @returns {Uint8Array | null} binarypack hands back views; copy to a fresh array */
function toBytes(v) {
	if (v instanceof Uint8Array) return new Uint8Array(v);
	if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
	if (ArrayBuffer.isView(v)) return new Uint8Array(/** @type {any} */ (v).buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
	return null;
}

/** @param {any} payload */
function broadcast(payload) {
	const p = peerConn();
	if (!p?.broadcast) return;
	try {
		p.broadcast(payload);
	} catch {}
}
/** @param {string} peerId @param {any} payload */
function sendTo(peerId, payload) {
	const conn = peerConn()?.connections?.[peerId];
	if (!conn?.open) return false;
	try {
		conn.send(payload);
		return true;
	} catch {
		return false;
	}
}

function publishDocs() {
	sharedDocs.set([...docs.keys()]);
}

// ---------------------------------------------------------------- the registry

/** @param {string} key @returns {Entry} */
function createEntry(key) {
	const { Y, aw } = /** @type {any} */ (libs);
	const doc = new Y.Doc();
	const text = doc.getText('text');
	const meta = doc.getMap('meta');
	const awareness = new aw.Awareness(doc);
	/** @type {() => void} */
	let settle = () => {};
	const ready = new Promise((r) => (settle = /** @type {() => void} */ (r)));
	/** @type {Entry} */
	const entry = {
		key, doc, text, meta, awareness, undo: null,
		refs: 0, settled: false, ready, settle: () => {},
		asked: new Set(), answered: new Set(), pending: [], timer: null,
		awPending: new Set(), awTimer: null, remoteDepth: 0, followTimer: null, seedText: '',
		dropTimer: null
	};
	entry.settle = () => {
		if (entry.settled) return;
		entry.settled = true;
		settle();
	};
	doc.on('update', (/** @type {Uint8Array} */ update, /** @type {any} */ origin) => {
		if (origin === REMOTE || isViewer()) return;
		entry.pending.push(update);
		entry.timer ??= setTimeout(() => flush(entry), FLUSH_MS);
	});
	awareness.on('update', (/** @type {any} */ change, /** @type {any} */ origin) => {
		if (origin !== 'local') return;
		for (const id of [...change.added, ...change.updated, ...change.removed]) entry.awPending.add(id);
		entry.awTimer ??= setTimeout(() => flushAwareness(entry), FLUSH_MS * 2);
	});
	awareness.on('change', () => publishPresence());
	const me = myId();
	const color = peerColor(me);
	awareness.setLocalState({
		peerId: me,
		user: { name: String(get(username) || (me ? 'Peer ' + me.slice(0, 4) : 'Me')), color, colorLight: selectionTint(color) }
	});
	return entry;
}

/** send the merged burst @param {Entry} entry */
function flush(entry) {
	clearTimeout(entry.timer);
	entry.timer = null;
	if (!entry.pending.length || !libs) return;
	const u = entry.pending.length === 1 ? entry.pending[0] : libs.Y.mergeUpdates(entry.pending);
	entry.pending = [];
	broadcast({ type: 'ytext', key: entry.key, u });
}

/** @param {Entry} entry */
function flushAwareness(entry) {
	clearTimeout(entry.awTimer);
	entry.awTimer = null;
	if (!entry.awPending.size || !libs) return;
	const ids = [...entry.awPending];
	entry.awPending.clear();
	broadcast({ type: 'ytextaw', key: entry.key, a: libs.aw.encodeAwarenessUpdate(entry.awareness, ids) });
}

/**
 * Hold a document open (one ref per bound editor). Resolves once the document has its first
 * content — adopted from the room, or seeded from `sourceText`.
 * @param {string} key @param {string} sourceText
 * @returns {Promise<Entry>}
 */
export async function acquire(key, sourceText) {
	await loadYjs();
	let entry = docs.get(key);
	if (!entry) {
		entry = createEntry(key);
		entry.seedText = String(sourceText ?? '');
		docs.set(key, entry);
		publishDocs();
		const others = openPeers();
		const e = entry;
		if (!others.length) seed(e);
		else {
			for (const id of others) e.asked.add(id);
			broadcast({ type: 'getytext', key, sv: libs?.Y.encodeStateVector(e.doc), sender: myId() });
			setTimeout(() => {
				if (!e.settled) seed(e);
			}, SEED_WAIT_MS);
		}
	}
	entry.refs++;
	clearTimeout(entry.dropTimer);
	entry.dropTimer = null;
	await entry.ready;
	return entry;
}

/** nobody holds it: start from the source, under the deterministic client @param {Entry} entry */
function seed(entry) {
	if (entry.settled || docs.get(entry.key) !== entry) return;
	const text = entry.seedText;
	if (!entry.text.length && text) {
		const { Y } = /** @type {any} */ (libs);
		const s = new Y.Doc();
		s.clientID = seedClientId(entry.key, text);
		s.getText('text').insert(0, text);
		Y.applyUpdate(entry.doc, Y.encodeStateAsUpdate(s), SEED);
		s.destroy();
	}
	entry.settle();
}

/** let go of one editor's hold; the last one drops the document @param {string} key */
export function release(key) {
	const entry = docs.get(key);
	if (!entry) return;
	entry.refs = Math.max(0, entry.refs - 1);
	if (entry.refs) return;
	clearTimeout(entry.dropTimer);
	entry.dropTimer = setTimeout(() => drop(entry), RELEASE_GRACE_MS);
}

/** nobody here edits it any more: leave the document @param {Entry} entry */
function drop(entry) {
	const key = entry.key;
	if (entry.refs || docs.get(key) !== entry) return;
	flush(entry);
	clearTimeout(entry.followTimer);
	// tell the room our cursor is gone (an awareness "null" for our client), then forget it all
	if (libs) {
		libs.aw.removeAwarenessStates(entry.awareness, [entry.doc.clientID], 'local');
		flushAwareness(entry);
	}
	entry.awareness.destroy();
	entry.doc.destroy();
	docs.delete(key);
	publishDocs();
	publishPresence();
}

/** @param {string} key */
export function holds(key) {
	return docs.has(key);
}

/** the shared text of a held document, or null @param {string} key */
export function sharedTextOf(key) {
	const e = docs.get(key);
	return e ? String(e.text.toString()) : null;
}

/**
 * The CodeMirror extension that binds an editor to a held document, plus what the editor
 * needs to tell a remote change from typing. Call after `acquire` resolved.
 * @param {string} key
 */
export function editorBinding(key) {
	const entry = docs.get(key);
	if (!entry || !libs) return null;
	const { Y, cm } = libs;
	// typing only: y-codemirror adds its own sync origin; nothing else (seed, replace) is undoable
	entry.undo ??= new Y.UndoManager(entry.text, { trackedOrigins: new Set() });
	return {
		text: String(entry.text.toString()),
		extension: cm.yCollab(entry.text, entry.awareness, { undoManager: entry.undo }),
		undoKeymap: cm.yUndoManagerKeymap,
		syncAnnotation: cm.ySyncAnnotation,
		/** true while a peer's update is being applied (its editor transactions are not typing) */
		applyingRemote: () => entry.remoteDepth > 0
	};
}

// ---------------------------------------------------------------- writes that are not typing

/**
 * Put `next` into the shared buffer as the smallest single edit (Reload, "Don't save" on a
 * stale tab, a source change this peer is the writer for). @param {string} key @param {string} next
 */
export function replaceText(key, next) {
	const entry = docs.get(key);
	if (!entry || isViewer()) return false;
	const edit = minimalEdit(String(entry.text.toString()), String(next ?? ''));
	if (!edit) return false;
	entry.doc.transact(() => {
		if (edit.remove) entry.text.delete(edit.index, edit.remove);
		if (edit.insert) entry.text.insert(edit.index, edit.insert);
	}, REPLACE);
	return true;
}

/**
 * Ctrl+S is about to write `code` to the source: record it in the document FIRST and send it
 * now, so a peer that sees the source change knows it was a save of the shared buffer (and
 * stays clean) rather than a foreign edit (and goes stale). Same ordered conn, sent before the
 * save's own message. @param {string} key @param {string} code
 */
export function noteSaved(key, code) {
	const entry = docs.get(key);
	if (!entry || isViewer()) return;
	entry.meta.set('s:' + fnv1a(code), Date.now());
	flush(entry);
}

/** was `text` saved from the shared buffer during this session? @param {string} key @param {string} text */
export function wasSharedSave(key, text) {
	const entry = docs.get(key);
	return !!entry && entry.meta.has('s:' + fnv1a(String(text ?? '')));
}

/**
 * The source changed under a CLEAN shared tab through something other than the buffer (an
 * undo of the node, a peer on an older build saving). Exactly one holder — the lowest peer
 * id — pushes it into the buffer, after a beat in which the buffer may catch up by itself.
 * @param {string} key @param {string} external @param {() => boolean} [stillWanted]
 */
export function followExternal(key, external, stillWanted = () => true) {
	const entry = docs.get(key);
	if (!entry) return;
	clearTimeout(entry.followTimer);
	entry.followTimer = setTimeout(() => {
		if (docs.get(key) !== entry || !stillWanted()) return;
		if (String(entry.text.toString()) === external) return;
		if (!isExternalWriter(holdersOf(entry), myId())) return;
		replaceText(key, external);
	}, FOLLOW_WAIT_MS);
}

/** the peer ids holding a document (us + every awareness state with a peer id) @param {Entry} entry */
function holdersOf(entry) {
	/** @type {Set<string>} */
	const out = new Set();
	const me = myId();
	if (me) out.add(me);
	for (const s of entry.awareness.getStates().values()) if (s?.peerId) out.add(String(s.peerId));
	return out;
}

// ---------------------------------------------------------------- the dispatcher's entry points

/** `ytext` from a peer @param {any} data @param {string} from */
export function applyRemoteYText(data, from) {
	const entry = docs.get(data?.key);
	if (!entry || !libs) return;
	if (from) entry.answered.add(from);
	const u = toBytes(data.u);
	if (u && u.byteLength) {
		entry.remoteDepth++;
		try {
			libs.Y.applyUpdate(entry.doc, u, REMOTE);
		} catch {
		} finally {
			entry.remoteDepth--;
		}
		// a document came back: adopt it rather than seeding our own
		if (data.held || entry.text.length) entry.settle();
	} else if (data.held) entry.settle();
	// everyone we asked has answered and nobody holds it: seed now instead of waiting
	if (!entry.settled) {
		const open = openPeers();
		if ([...entry.asked].every((id) => entry.answered.has(id) || !open.includes(id))) seed(entry);
	}
}

/** `ytextaw` from a peer @param {any} data */
export function applyRemoteYAwareness(data) {
	const entry = docs.get(data?.key);
	const a = toBytes(data?.a);
	if (!entry || !libs || !a) return;
	try {
		libs.aw.applyAwarenessUpdate(entry.awareness, a, REMOTE);
	} catch {}
}

/**
 * `getytext` from a peer: what they are missing, straight down their conn — or `none`. The
 * room check is the dispatcher's (`inRoom` false answers `none`, so the asker stops waiting).
 * @param {any} data @param {string} from @param {boolean} inRoom
 */
export function answerYText(data, from, inRoom) {
	const key = data?.key;
	if (!isDocKey(key) || !from) return;
	const entry = inRoom ? docs.get(key) : null;
	if (!entry || !entry.settled || !libs) {
		sendTo(from, { type: 'ytext', key, none: true });
		return;
	}
	const sv = toBytes(data.sv);
	let u;
	try {
		u = sv ? libs.Y.encodeStateAsUpdate(entry.doc, sv) : libs.Y.encodeStateAsUpdate(entry.doc);
	} catch {
		u = libs.Y.encodeStateAsUpdate(entry.doc);
	}
	sendTo(from, { type: 'ytext', key, u, held: true });
	// and who is here: every known cursor, so the newcomer sees them before anyone moves
	const ids = [...entry.awareness.getStates().keys()];
	if (ids.length) sendTo(from, { type: 'ytextaw', key, a: libs.aw.encodeAwarenessUpdate(entry.awareness, ids) });
}

// ---------------------------------------------------------------- presence + peers coming and going

let lastOpen = new Set();
let watching = false;
function watchPeers() {
	if (watching || typeof window === 'undefined') return;
	watching = true;
	peers.subscribe((/** @type {any} */ p) => {
		const now = new Set(p?.openedPeers ? [...p.openedPeers] : []);
		// a peer that left: its cursors go (awareness would time them out after 30 s anyway)
		for (const entry of docs.values()) {
			if (!libs) break;
			/** @type {number[]} */
			const gone = [];
			for (const [client, s] of entry.awareness.getStates()) if (client !== entry.doc.clientID && s?.peerId && !now.has(String(s.peerId))) gone.push(client);
			if (gone.length) libs.aw.removeAwarenessStates(entry.awareness, gone, REMOTE);
		}
		// a peer that arrived (or came back after a drop): exchange what each side is missing.
		// They ask us the same for the documents THEY hold, so both directions converge.
		for (const id of now) {
			if (lastOpen.has(id)) continue;
			for (const entry of docs.values()) if (entry.settled && libs) sendTo(id, { type: 'getytext', key: entry.key, sv: libs.Y.encodeStateVector(entry.doc), sender: myId() });
		}
		lastOpen = now;
	});
}

function publishPresence() {
	/** @type {Record<string, any[]>} */
	const out = {};
	for (const [key, entry] of docs) {
		const list = [];
		const text = String(entry.text.toString());
		for (const [client, s] of entry.awareness.getStates()) {
			if (client === entry.doc.clientID || !s?.peerId) continue;
			let line = null;
			let selected = 0;
			const cur = s.cursor;
			if (cur?.head && libs) {
				try {
					const Y = libs.Y;
					const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cur.head), entry.doc);
					const anchor = cur.anchor ? Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cur.anchor), entry.doc) : head;
					if (head) {
						line = lineAt(text, head.index);
						selected = anchor ? Math.abs(anchor.index - head.index) : 0;
					}
				} catch {}
			}
			list.push({ peerId: String(s.peerId), name: String(s.user?.name ?? ''), color: String(s.user?.color ?? ''), line, selected });
		}
		if (list.length) out[key] = list;
	}
	sharedPresence.set(out);
}

/**
 * Open a document for an editor and wait for its first content. `sourceText` seeds it when
 * nobody in the room holds it yet.
 * @param {string} key @param {string} sourceText
 */
export function openShared(key, sourceText) {
	watchPeers();
	return acquire(key, sourceText);
}

/** debug: a snapshot of what this peer holds */
export function sharedTextDebug() {
	return [...docs.values()].map((e) => ({ key: e.key, text: String(e.text.toString()), refs: e.refs, settled: e.settled, clients: [...e.awareness.getStates().keys()].length }));
}
