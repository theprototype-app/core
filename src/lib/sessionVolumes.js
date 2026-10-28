// Roadmap 56 C13 — ONE EXPLORER VOLUME PER CONNECTION (owner decision 2026-10-28e).
//
// A guest who joins sees the host's files as a READ-ONLY root, "<HOST>'s session", above its own
// Library — built like `mountedVolumes.js` (its own namespace, `vol:session-<peerId>`; it never
// touches `explorerItems` / `explorerFolders`), mounted when the host's index arrives and unmounted
// when the guest leaves. Nothing is swapped or merged into the guest's Library; nothing is
// downloaded until the guest opens or copies a file.
//
// TWO HALVES, one module, both lazy (peerHandler imports it on a `vol*` message or a connection):
//
//   HOST  — the SHARE SCOPE (Current scene's files, the default · Project · Whole library · None) and
//           the projection it implies (sessionVolumeCore.volumeProjection), sent as `volidx` on join
//           and re-sent on change; thumbnails follow in `volthumbs`, once per hash per peer. It
//           answers `volget` ONLY for a hash in the projection it sent THAT peer (the trust
//           boundary lives here, never in the guest's UI), and `volsave` through `hostSave.js` —
//           the same host-side path an agent's save_scene takes (C12), editors only.
//   GUEST — the `sessionVolumes` store (rows + thumbnails, no bytes) and the three actions: Open
//           (bytes by hash through assetShare.pullVolumeBytes, which never lands them in the
//           Library), Copy to my library (`addItemFromBytes`, keeps the name and the folder path)
//           and Save on host (editors). A pull above ~50 MB asks first.
//
// Messages (all small; every one has a wireValidate row):
//   volidx     host -> guest  {rev, scope, host, role, folders, items}
//   volthumbs  host -> guest  {thumbs: {hash: dataURL}}
//   volget     guest -> host  {hash}            -> the ordinary assetstart/assetchunk/assetfile or assetmissing
//   volsave    guest -> host  {id, name?}       -> volsaveack {id, ok, name?, error?}

import { get } from 'svelte/store';
import { peers, userdata, showToast } from '../stores/appStore';
import { sessionHost } from './connectionState';
import { rolesInfo } from './cloudHooks';
import { shareScope, setShareScope } from './shareScope';
import { sessionVolumes, sessionVolumeById, isSessionVolumeId } from './sessionVolumeState';
import { explorerItems, explorerFolders, addItemFromBytes, createFolder } from './explorer';
import { sceneAssets } from './sceneAssets';
import { currentLevel, levelItems } from './levels';
import { amPrivate } from './peerScenes';
import { answerAssetRequest, pullVolumeBytes, cancelPull, volumePullRunning, stopSendingTo } from './assetShare';
import { showChoice } from './confirmDialog';
import {
	normalizeShareScope,
	volumeProjection,
	projectionHas,
	needsPullConfirm,
	pullQuestion,
	totalBytes,
	sessionVolumeId,
	sessionVolumeName
} from './sessionVolumeCore';

/** how many thumbnails ride one `volthumbs` message */
const THUMBS_PER_MESSAGE = 24;
/** how long a guest waits for the host's Save answer (ms) */
const SAVE_TIMEOUT_MS = 30000;

/** @param {string} peerId */
function nameOf(peerId) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => Array.isArray(u) && u[0] === peerId);
	return row?.[1] ? String(row[1]) : String(peerId ?? '').slice(0, 6).toUpperCase();
}

/** the conn each guest's handshake ran on — `peers.connections` may not list it yet at that moment
 * @type {Map<string, any>} */
const handshakeConns = new Map();

/** @param {string} peerId @param {any} msg */
function sendTo(peerId, msg) {
	/** @type {any} */
	const peer = get(peers);
	let conn = peer?.connections?.[peerId];
	if (!conn?.open) conn = handshakeConns.get(peerId);
	if (!conn?.open) return false;
	try {
		conn.send(msg);
		return true;
	} catch {
		return false;
	}
}

/** The role the HOST sees for a peer: 'viewer' or 'editor' (no roles plugin = everyone edits). @param {string} peerId */
function roleOf(peerId) {
	/** @type {any} */
	const roles = get(rolesInfo);
	return roles?.roleOf?.(peerId) === 'viewer' ? 'viewer' : 'editor';
}

/** what the e2e reads: every request and answer this page made, newest last @type {string[]} */
const volumeLog = [];
/** @param {string} line */
function note(line) {
	volumeLog.push(line);
	if (volumeLog.length > 80) volumeLog.shift();
}

// =================================================================================================
// HOST
// =================================================================================================

// the share scope itself lives in a leaf (the Connect drawer shows it); re-exported for callers here
export { shareScope, setShareScope };

/** per guest: the projection (and scope) we last sent it, and the thumbnails it already has
 * @type {Map<string, {proj: {folders: any[], items: any[]}, scope: string, role: string, thumbs: Set<string>}>} */
const sentTo = new Map();
let rev = 0;

/** The hashes the open scene stands on: its own file and everything it references. */
function sceneHashes() {
	/** @type {Set<string>} */
	const out = new Set();
	/** @type {any} */
	const at = get(currentLevel);
	if (at?.hash) out.add(String(at.hash));
	// a named scene's CURRENT file, found by name when the pointer is a loose/adopted one
	if (at?.name) {
		const file = levelItems().find((i) => String(i.name).replace(/\.tpscene$/i, '') === at.name);
		if (file) out.add(file.hash);
	}
	for (const entry of get(sceneAssets)) if (entry?.hash) out.add(String(entry.hash));
	return out;
}

/** Project scope's extra hashes: every project scene file and every file the session already shares. */
function projectHashes() {
	/** @type {Set<string>} */
	const out = new Set(levelItems().map((i) => i.hash));
	for (const i of get(explorerItems)) if (i.share === 'mine' || i.share === 'peer') out.add(i.hash);
	return out;
}

/** What this host shows right now (empty while its scene is private). */
export function currentProjection() {
	const scope = get(shareScope);
	if (scope === 'none' || amPrivate()) return { folders: [], items: [] };
	return volumeProjection({
		scope,
		folders: get(explorerFolders),
		items: get(explorerItems),
		sceneHashes: scope === 'library' ? [] : sceneHashes(),
		projectHashes: scope === 'project' ? projectHashes() : []
	});
}

/** Are we hosting a session with somebody in it? */
function hosting() {
	/** @type {any} */
	const peer = get(peers);
	if (get(sessionHost)) return false;
	const open = (/** @type {any} */ c) => !!c?.open;
	return Object.values(peer?.connections ?? {}).some(open) || [...handshakeConns.values()].some(open);
}

/** Send the volume to one guest (and the thumbnails it lacks). @param {string} peerId @param {any} [proj]
 * @returns {boolean} the rows left */
function sendVolume(peerId, proj = currentProjection()) {
	const prior = sentTo.get(peerId);
	const thumbs = prior?.thumbs ?? new Set();
	sentTo.set(peerId, { proj, scope: get(shareScope), role: roleOf(peerId), thumbs });
	const ok = sendTo(peerId, {
		type: 'volidx',
		rev: ++rev,
		scope: get(shareScope),
		host: nameOf(String(/** @type {any} */ (get(peers))?.peer?.id ?? '')),
		role: roleOf(peerId),
		folders: proj.folders,
		items: proj.items
	});
	note('out volidx to ' + peerId + ' ' + proj.items.length + ' rows' + (ok ? '' : ' (NO OPEN CONN)'));
	if (!ok) return false;
	// thumbnails AFTER the rows, once per hash per guest, in small batches
	const byHash = new Map(get(explorerItems).map((i) => [i.hash, i.thumbnail]));
	/** @type {Record<string, string>} */
	let batch = {};
	let n = 0;
	for (const row of proj.items) {
		const t = byHash.get(row.hash);
		if (!t || thumbs.has(row.hash) || !String(t).startsWith('data:image/')) continue;
		thumbs.add(row.hash);
		batch[row.hash] = t;
		if (++n >= THUMBS_PER_MESSAGE) {
			sendTo(peerId, { type: 'volthumbs', thumbs: batch });
			batch = {};
			n = 0;
		}
	}
	if (n) sendTo(peerId, { type: 'volthumbs', thumbs: batch });
	return true;
}

/** Re-send to every guest that has a volume, if what it would see changed. */
function republish() {
	if (!hosting()) return;
	const proj = currentProjection();
	const key = JSON.stringify(proj);
	for (const [peerId, prior] of sentTo) {
		// a role change (made viewer / editor) is resent too: it decides Save on host on the guest
		if (JSON.stringify(prior.proj) === key && prior.scope === get(shareScope) && prior.role === roleOf(peerId)) continue;
		sendVolume(peerId, proj);
	}
}

/** @type {any} */ let republishTimer = null;
function scheduleRepublish() {
	clearTimeout(republishTimer);
	republishTimer = setTimeout(republish, 400);
}

let watching = false;
/** Watch what the projection is made of (once, from the first guest on). */
function watch() {
	if (watching) return;
	watching = true;
	for (const store of [explorerItems, explorerFolders, currentLevel, sceneAssets, shareScope, rolesInfo])
		/** @type {any} */ (store).subscribe(() => sentTo.size && scheduleRepublish());
}

/**
 * A connection to `peerId` opened (peerHandler's handshake, which only calls this while we host).
 * The handshake's own `conn` is used: at that moment `peers.connections` may not list it yet, which
 * left a guest with no volume at all whenever the two raced (measured on a busy machine). A send
 * that still finds no open conn is retried a few times.
 * @param {string} peerId @param {any} [conn]
 */
export function volumePeerOpened(peerId, conn) {
	if (get(sessionHost)) return;
	if (conn) handshakeConns.set(peerId, conn);
	watch();
	let tries = 0;
	const attempt = () => {
		if (get(sessionHost)) return;
		if (!sendVolume(peerId) && ++tries < 6) setTimeout(attempt, 1000);
	};
	attempt();
}

/** The guest asked for bytes. Only a hash in what we SENT it is answered. @param {string} from @param {any} data */
function answerVolumeGet(from, data) {
	const hash = String(data?.hash ?? '');
	const sent = sentTo.get(from);
	// re-check against the CURRENT scope too: a scope narrowed since the last send must already bite
	if (!sent || !projectionHas(sent.proj, hash) || !projectionHas(currentProjection(), hash)) {
		note('refused volget ' + hash.slice(0, 12) + ' from ' + from);
		sendTo(from, { type: 'assetmissing', hash });
		return;
	}
	note('answer volget ' + hash.slice(0, 12) + ' to ' + from);
	void answerAssetRequest(from, { hash });
}

/** The guest pressed Save on host. @param {string} from @param {any} data */
async function answerVolumeSave(from, data) {
	const id = String(data?.id ?? '');
	const name = typeof data?.name === 'string' ? data.name : undefined;
	/** @type {{ok: boolean, name?: string, error?: string}} */
	let result;
	try {
		const { saveSceneOnHost } = await import('./hostSave');
		result = await saveSceneOnHost(name ? { name } : {}, { by: nameOf(from), role: roleOf(from) });
	} catch (e) {
		// ANSWER EVEN A THROW: the guest is waiting on this ack, and silence reads as "no answer" 30 s later
		console.warn('save on host', e);
		result = { ok: false, error: 'the save failed on the host (' + (e instanceof Error ? e.message : String(e)).slice(0, 160) + ')' };
	}
	note('volsave from ' + from + ': ' + (result.ok ? 'saved ' + result.name : result.error));
	/** @type {any} */
	const ack = { type: 'volsaveack', id, ok: result.ok };
	if (result.name) ack.name = result.name;
	if (result.error) ack.error = result.error;
	sendTo(from, ack);
}

// =================================================================================================
// GUEST
// =================================================================================================

// the store and its two lookups live in a leaf (the Explorer renders them from boot); re-exported here
export { sessionVolumes, sessionVolumeById, isSessionVolumeId };
/** @typedef {import('./sessionVolumeState').SessionVolume} SessionVolume */

/** @param {string} from @param {any} data */
function applyVolumeIndex(from, data) {
	const id = sessionVolumeId(from);
	const prior = sessionVolumeById(id);
	const thumbs = new Map((prior?.items ?? []).map((i) => [i.hash, i.thumbnail]));
	const host = String(data.host || nameOf(from)).slice(0, 60);
	/** @type {SessionVolume} */
	const vol = {
		id,
		peerId: from,
		name: sessionVolumeName(host),
		host,
		scope: normalizeShareScope(data.scope),
		role: data.role === 'viewer' ? 'viewer' : 'editor',
		folders: (data.folders ?? []).map((/** @type {any} */ f) => ({
			id: String(f.id),
			name: String(f.name ?? 'Folder').slice(0, 200),
			parentId: f.parentId == null ? null : String(f.parentId)
		})),
		items: (data.items ?? []).map((/** @type {any} */ r) => ({
			id: 'sv:' + String(r.id),
			name: String(r.name ?? 'file').slice(0, 200),
			kind: String(r.kind ?? 'text'),
			folderId: r.folderId == null ? null : String(r.folderId),
			hash: String(r.hash),
			size: Math.max(0, Number(r.size) || 0),
			thumbnail: thumbs.get(String(r.hash)) ?? null,
			createdAt: 0
		})),
		session: true,
		readOnly: true,
		rev: Number(data.rev) || 0,
		at: prior?.at ?? Date.now()
	};
	sessionVolumes.update((list) => (prior ? list.map((v) => (v.id === id ? vol : v)) : [...list, vol]));
	note('in volidx from ' + from + ' ' + vol.items.length + ' rows, scope ' + vol.scope);
}

/** @param {string} from @param {any} data */
function applyVolumeThumbs(from, data) {
	const id = sessionVolumeId(from);
	/** @type {Record<string, string>} */
	const thumbs = {};
	for (const [hash, t] of Object.entries(data.thumbs ?? {}))
		if (typeof t === 'string' && t.startsWith('data:image/') && t.length <= 200000) thumbs[hash] = t;
	sessionVolumes.update((list) =>
		list.map((v) =>
			v.id !== id ? v : { ...v, items: v.items.map((i) => (thumbs[i.hash] ? { ...i, thumbnail: thumbs[i.hash] } : i)) }
		)
	);
}

/** Unmount one host's volume (it left, or we did). @param {string} peerId */
export function dropSessionVolume(peerId) {
	const id = sessionVolumeId(peerId);
	sentTo.delete(peerId);
	handshakeConns.delete(peerId);
	if (!sessionVolumeById(id)) return;
	sessionVolumes.update((list) => list.filter((v) => v.id !== id));
	note('unmounted ' + id);
}

/** We left the session: every session volume goes, and the host side forgets its guests. */
export function dropAllSessionVolumes() {
	sentTo.clear();
	handshakeConns.clear();
	if (get(sessionVolumes).length) sessionVolumes.set([]);
}

/** how many byte pulls this page has sent (the e2e's "no bytes until open") */
let pullCount = 0;

/**
 * Ask the person before a big pull. Resolves true to go ahead.
 * @param {number} bytes @param {SessionVolume} vol
 */
export async function confirmPull(bytes, vol) {
	if (!needsPullConfirm(bytes)) return true;
	const answer = await showChoice({
		title: pullQuestion(bytes, vol.host),
		message: 'The files stay on ' + vol.host + "'s device until you open or copy them.",
		choices: [{ value: 'go', label: 'Download' }]
	});
	note('confirm ' + bytes + ' -> ' + (answer === 'go' ? 'download' : 'cancel'));
	return answer === 'go';
}

/**
 * The bytes of one volume file, pulled from the host by hash (never landing in the Library).
 * @param {string} volumeId @param {string} itemId @param {{confirmed?: boolean}} [opts]
 * @returns {Promise<Blob | null>}
 */
export async function sessionVolumeBlob(volumeId, itemId, opts = {}) {
	const vol = sessionVolumeById(volumeId);
	const row = vol?.items.find((i) => i.id === itemId);
	if (!vol || !row) return null;
	if (!opts.confirmed && !(await confirmPull(row.size, vol))) return null;
	pullCount++;
	note('pull ' + row.name + ' ' + row.hash.slice(0, 12));
	const buffer = await pullVolumeBytes(vol.peerId, row.hash, { name: row.name, size: row.size });
	note('pulled ' + row.name + ' ' + (buffer ? buffer.byteLength + ' bytes' : 'NOTHING'));
	return buffer ? new Blob([buffer]) : null;
}

/** Stop a running pull of one row. @param {string} volumeId @param {string} itemId */
export function cancelSessionPull(volumeId, itemId) {
	const vol = sessionVolumeById(volumeId);
	const row = vol?.items.find((i) => i.id === itemId);
	if (!vol || !row || !volumePullRunning(row.hash)) return false;
	// tell the host too, or it keeps sending the whole file down the link for nothing
	sendTo(vol.peerId, { type: 'volcancel', hash: row.hash });
	note('out volcancel ' + row.hash.slice(0, 12));
	return cancelPull(row.hash);
}

/**
 * The Library folder for a volume folder path, made under `into` where missing. The copy keeps the
 * host's folder NAMES; it never reuses the host's folder ids (that would be merging libraries).
 * @param {SessionVolume} vol @param {string | null} volFolderId @param {string | null} into
 */
function libraryFolderFor(vol, volFolderId, into) {
	/** @type {string[]} */
	const chain = [];
	let at = volFolderId;
	for (let n = 0; at && n < 64; n++) {
		const f = vol.folders.find((x) => x.id === at);
		if (!f) break;
		chain.unshift(f.name);
		at = f.parentId;
	}
	let parent = into;
	for (const name of chain) {
		const held = get(explorerFolders).find((f) => (f.parentId ?? null) === parent && f.name === name);
		parent = held?.id ?? createFolder(name, parent)?.id ?? parent;
	}
	return parent;
}

/**
 * COPY TO MY LIBRARY: the rows' bytes pulled once each and imported as ordinary Library files
 * (`addItemFromBytes`, hash-deduped), keeping each name and its folder path under `into`.
 * @param {string} volumeId @param {string[]} itemIds @param {string | null} [into]
 * @returns {Promise<number>} how many were copied
 */
export async function copySessionItems(volumeId, itemIds, into = null) {
	const vol = sessionVolumeById(volumeId);
	if (!vol) return 0;
	const rows = vol.items.filter((i) => itemIds.includes(i.id));
	if (!rows.length) return 0;
	if (!(await confirmPull(totalBytes(rows), vol))) return 0;
	let copied = 0;
	let missing = 0;
	for (const row of rows) {
		const blob = await sessionVolumeBlob(volumeId, row.id, { confirmed: true });
		if (!blob) {
			missing++;
			continue;
		}
		await addItemFromBytes(await blob.arrayBuffer(), row.name, libraryFolderFor(vol, row.folderId, into), { imported: true });
		copied++;
	}
	if (copied)
		showToast(copied + ' file' + (copied === 1 ? '' : 's') + ' copied into your Library from ' + vol.host + (missing ? ' (' + missing + ' could not be fetched)' : ''));
	else if (missing) showToast(vol.host + ' did not send ' + (missing === 1 ? 'that file' : 'those files'));
	return copied;
}

/** save requests waiting on the host: id -> resolve @type {Map<string, (r: any) => void>} */
const pendingSaves = new Map();
let saveSeq = 0;

/**
 * SAVE ON HOST: ask the host to save the session's scene into ITS library (editors only — the host
 * checks too). Resolves the host's answer.
 * @param {string} volumeId @param {{name?: string, quiet?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, name?: string, error?: string}>}
 */
export function saveOnHost(volumeId, opts = {}) {
	const vol = sessionVolumeById(volumeId);
	if (!vol) return Promise.resolve({ ok: false, error: 'not in that session any more' });
	if (vol.role === 'viewer') {
		const error = "You're view-only in " + vol.host + "'s session — use Copy to my library instead";
		if (!opts.quiet) showToast(error);
		return Promise.resolve({ ok: false, error });
	}
	const id = 's' + Date.now().toString(36) + '-' + ++saveSeq;
	/** @type {any} */
	const msg = { type: 'volsave', id };
	if (opts.name) msg.name = String(opts.name).slice(0, 120);
	if (!sendTo(vol.peerId, msg)) return Promise.resolve({ ok: false, error: vol.host + ' is not connected' });
	note('out volsave to ' + vol.peerId);
	return new Promise((resolve) => {
		pendingSaves.set(id, (r) => {
			if (!opts.quiet)
				showToast(r.ok ? 'Saved "' + (r.name ?? 'the scene') + '" on ' + vol.host + "'s device" : 'Save on host failed: ' + (r.error ?? 'no answer'));
			resolve(r);
		});
		setTimeout(() => {
			const done = pendingSaves.get(id);
			if (!done) return;
			pendingSaves.delete(id);
			done({ ok: false, error: vol.host + ' did not answer (an older app version, or the link dropped)' });
		}, SAVE_TIMEOUT_MS);
	});
}

// =================================================================================================
// DISPATCH (peerHandler, lazily)
// =================================================================================================

/** @param {string} from @param {any} data */
export function handleVolumeMessage(from, data) {
	try {
		// only a HOST sends `volidx` (volumePeerOpened checks it is hosting), so whoever sends one is a
		// session this page joined — no sessionHost check here, which would race the approval dial-back
		if (data.type === 'volidx') applyVolumeIndex(from, data);
		else if (data.type === 'volthumbs') applyVolumeThumbs(from, data);
		else if (data.type === 'volget') answerVolumeGet(from, data);
		else if (data.type === 'volsave') void answerVolumeSave(from, data);
		else if (data.type === 'volcancel') note('volcancel from ' + from + ': ' + (stopSendingTo(from, String(data.hash)) ? 'stopped' : 'nothing running'));
		else if (data.type === 'volsaveack') {
			const done = pendingSaves.get(String(data.id));
			if (done) {
				pendingSaves.delete(String(data.id));
				done({ ok: data.ok === true, ...(data.name ? { name: String(data.name) } : {}), ...(data.error ? { error: String(data.error) } : {}) });
			}
		}
	} catch (e) {
		note('threw ' + (e instanceof Error ? e.message : String(e)));
		console.warn('session volume', e);
	}
}

/** what the e2e reads (the debug hook row exposes the module): this page's pull count and log */
export function volumeDebug() {
	return { pullCount, log: [...volumeLog], sentTo: [...sentTo.keys()] };
}
