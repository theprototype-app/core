// R22 ROUND 13 P3 — MOUNTED PROJECT VOLUMES.
//
// "mount button is a new button... it would likely be better to be able to mount/unmount
//  multiple projects and have them above 'Library' with save icon and x icon, so current
//  open project memory is not affected."
//
// A mount is a saved PROJECT session (a session record carrying `payload.library`) opened
// as a browsable root in the Explorer. Load still means "replace everything"; mounting
// means "look at that project's files from here", and the last clause of the ask is the
// design constraint: nothing about the OPEN project may move.
//
// WHY A SEPARATE NAMESPACE, and not rows in the library. An Explorer item's identity is
// its content HASH, and every hash-addressed read in the app (`itemByHash`, the shared
// index, travel-by-hash, an assetShare pull, the .tp export) stands on ONE item per hash.
// Inserting a mounted project's rows into `explorerItems` would collide with all of that
// the moment the two projects share a file — which, for two saves of one project, is every
// file. So a volume holds its OWN `folders`/`items` arrays and `explorerItems` /
// `explorerFolders` / `hiddenItems` are never touched. Every one of those invariants then
// holds BY CONSTRUCTION rather than by care, including the one with a replication
// consequence:
//
//   THE SHARED INDEX MUST NEVER PUBLISH A MOUNTED VOLUME'S ROWS. A mount is a view of a
//   file on THIS machine; a peer has no access to it. `sharedLibrary.projection()` reads
//   only `explorerFolders` / `explorerItems`, so a volume is invisible to it — which is
//   the whole argument for the namespace, and is asserted rather than believed
//   (`explorer-mounts` §3 publishes with a volume mounted and compares the document).
//
// WHY NO REGISTRATION SEAM. `explorer.js` is the module every consumer of it sits above,
// and the plan forbids it importing this one — but nothing here needs a hook INTO it:
// volumes are read through this module's own accessors by the surfaces that draw them
// (Explorer.svelte, FilePreviewWindow.svelte), and copying between a volume and the
// library is an ordinary `addItemFromBytes` import made by the caller. So the seam shapes
// (`registerDuplicateResolver` / `registerSharedIndexListener`) are not needed at all.
//
// EDITS ARE BUFFERED. Rename / move / delete / new folder / copy-in write THIS store and
// set `dirty`; nothing reaches the saved session until `saveVolume`. Two consequences the
// plan calls out and this module owes:
//   - The buffer must survive a RELOAD, or a reload silently discards work — so the idb
//     record carries the edited folders/items (and, for a file copied IN, its bytes),
//     not just a pointer to the session.
//   - Save-back must not go near the live stores. It reads the session record, replaces
//     its `payload.library` and writes it back (`sessions.writeSessionLibrary`).
//
// LOCAL, always: no message type, no history kind, no manifest. A mount is a fact about
// this machine, like a view mode.
//
// Import discipline: a LEAF — svelte/store, idb and the toast. `sessions` is reached
// through a DYNAMIC import (its own `saveSessionWithLibrary` reaches `explorer` the same
// way) so this module stays cheap and cannot participate in an import cycle.

import { writable, get } from 'svelte/store';
import { idbGet, idbPut } from './idb';
import { showToast } from '../stores/appStore';

const STORE_KEY = 'explorer:mounts';

/**
 * @typedef {{id: string, name: string, parentId: string | null}} VolumeFolder
 * @typedef {{id: string, name: string, kind: string, folderId: string | null, hash: string,
 *   size: number, thumbnail: string | null, createdAt: number, blob?: Blob}} VolumeItem
 * @typedef {{id: string, sessionId: string, name: string, folders: VolumeFolder[],
 *   items: VolumeItem[], dirty: boolean, at: number, missing?: boolean}} MountedVolume
 */

/**
 * The mounted volumes, newest mount last (the roots section draws them in this order, so
 * a fresh mount appears at the bottom of the group rather than reshuffling the others).
 * @type {import('svelte/store').Writable<MountedVolume[]>}
 */
export const mountedVolumes = writable([]);

let loaded = false;
/** the in-flight load, so a second caller awaits it instead of racing past the flag with
 * an empty store (the `loadExplorer` shape) @type {Promise<void> | null} */
let loading = null;

/** @param {MountedVolume[]} list */
function persist(list) {
	if (typeof indexedDB === 'undefined') return Promise.resolve();
	// the store shape IS the record shape (Blobs included — idb structured-clones them,
	// which is exactly how a project session carries its files)
	return idbPut(STORE_KEY, list).catch((error) => console.log('mounts persist failed', error));
}

/**
 * Apply a change and persist it. Returns the PERSISTENCE, not the list: an async caller
 * (mount, unmount, refresh, save) awaits it, so "mounted" means "durably mounted" — a
 * reload one moment after mounting must not lose the mount, and fire-and-forget
 * persistence is exactly the shape that loses it (it showed up as a suite flake, which
 * is the same race a user hits by pressing F5).
 * @param {(list: MountedVolume[]) => MountedVolume[]} fn
 * @returns {Promise<void>}
 */
function write(fn) {
	/** @type {MountedVolume[]} */
	let next = [];
	mountedVolumes.update((list) => (next = fn(list)));
	return persist(next);
}

export async function loadMountedVolumes() {
	if (typeof indexedDB === 'undefined') return;
	if (loaded) return loading ?? undefined;
	loaded = true;
	loading = (async () => {
		try {
			const stored = await idbGet(STORE_KEY);
			if (Array.isArray(stored)) mountedVolumes.set(stored.map(normalizeVolume));
		} catch (error) {
			console.log('mounts load failed', error);
		}
		// fork 3: the source of a mount is a session record the user can delete from the
		// Sessions manager at any time. A row whose source has gone is marked UNAVAILABLE
		// rather than dropped — its buffered edits are real work, and silently discarding
		// a root the user is looking at is the one behaviour a mount must not have.
		await revalidateVolumes();
	})();
	return loading;
}

/** Fill in anything a record written by an older build lacks. @param {any} v */
function normalizeVolume(v) {
	return {
		id: String(v?.id ?? crypto.randomUUID()),
		sessionId: String(v?.sessionId ?? ''),
		name: String(v?.name ?? 'Project'),
		folders: Array.isArray(v?.folders) ? v.folders : [],
		items: Array.isArray(v?.items) ? v.items : [],
		dirty: !!v?.dirty,
		at: Number(v?.at) || Date.now(),
		...(v?.missing ? { missing: true } : {})
	};
}

/**
 * THE NAMESPACE, and the only place it is spelled. `activeFolder` gains two shapes:
 *
 *   'vol:<volumeId>'             the volume's root
 *   'vol:<volumeId>:<folderId>'  one folder inside it
 *
 * PURE — no store read, so it is testable with no browser and cannot be the reason a
 * `$derived` fails to re-run. The caller pairs it with `volumeById` when it needs the
 * record. A volume id is a uuid and a folder id may be one too, hence `slice` rather than
 * `split`: a folder id is whatever is left after the second colon, colons included.
 * @param {any} key @returns {{volumeId: string, folderId: string | null} | null}
 */
export function volumeOf(key) {
	if (typeof key !== 'string' || !key.startsWith('vol:')) return null;
	const rest = key.slice(4);
	if (!rest) return null;
	const cut = rest.indexOf(':');
	if (cut < 0) return { volumeId: rest, folderId: null };
	const volumeId = rest.slice(0, cut);
	const folderId = rest.slice(cut + 1);
	return { volumeId, folderId: folderId || null };
}

/** The `activeFolder` value for a place inside a volume — the inverse of `volumeOf`, and
 * also the CARD ID a volume folder is drawn with (unique across the tree, where the
 * library's own folders are listed at the same time and a saved project shares their
 * uuids exactly).
 * @param {string} volumeId @param {string | null} [folderId] */
export function volumeKey(volumeId, folderId = null) {
	return folderId ? 'vol:' + volumeId + ':' + folderId : 'vol:' + volumeId;
}

/** @param {string | null | undefined} id @returns {MountedVolume | null} */
export function volumeById(id) {
	if (!id) return null;
	return get(mountedVolumes).find((v) => v.id === id) ?? null;
}

/** @param {string} id @returns {VolumeFolder[]} */
export function volumeFolders(id) {
	return volumeById(id)?.folders ?? [];
}

/** @param {string} id @returns {VolumeItem[]} */
export function volumeItems(id) {
	return volumeById(id)?.items ?? [];
}

/** Every folder id inside a volume subtree, root included (the cascade delete's reach).
 * @param {string} id @param {string} folderId */
export function volumeSubtree(id, folderId) {
	const list = volumeFolders(id);
	const out = [folderId];
	for (let i = 0; i < out.length; i++)
		for (const f of list) if (f.parentId === out[i]) out.push(f.id);
	return out;
}

/**
 * A volume's rows, as the session payload's `library` block. One `library.items` row per
 * item, in the shape `saveSessionWithLibrary` writes — this is what save-back puts back.
 * The bytes come from `volumeBlob`, so an untouched row's Blob is the one already in the
 * session and a copied-in row's is the one this store buffered.
 * @param {string} id @returns {Promise<{folders: any[], items: any[]} | null>}
 */
async function libraryBlockOf(id) {
	const volume = volumeById(id);
	if (!volume) return null;
	/** @type {any[]} */
	const items = [];
	for (const row of volume.items) {
		const blob = await volumeBlob(id, row.id);
		if (!blob) continue; // a row whose bytes we cannot resolve carries nothing
		items.push({
			name: row.name,
			kind: row.kind,
			folderId: row.folderId ?? null,
			hash: row.hash,
			blob,
			...(row.thumbnail ? { thumbnail: row.thumbnail } : {})
		});
	}
	return {
		folders: volume.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null })),
		items
	};
}

/**
 * Read a saved session's library into volume rows.
 *
 * IDS ARE MINTED HERE, because a session's `library.items` rows carry NONE — they are
 * `{name, kind, folderId, hash, blob}` and nothing else, so the grid (whose keyed each
 * blocks, selection set and marquee are all id-addressed) has nothing to key on. The
 * minted id is persisted with the mount, so it is stable across a reload; a Refresh mints
 * fresh ones, which is correct — it is a re-read, and the selection is reset with it.
 *
 * FOLDER ids are the session's own, unchanged: they are internal to the volume and every
 * `folderId` reference in the payload resolves against them. They may equal a LIVE library
 * folder's uuid (a project saved from this machine carries exactly those), which is why
 * the tree draws a volume folder under `volumeKey` rather than under its bare id.
 * @param {any} payload @returns {{folders: VolumeFolder[], items: VolumeItem[]}}
 */
function rowsFromPayload(payload) {
	const lib = payload?.library ?? {};
	const folders = (lib.folders ?? []).map((/** @type {any} */ f) => ({
		id: String(f?.id ?? crypto.randomUUID()),
		name: String(f?.name ?? 'Folder'),
		parentId: f?.parentId ?? null
	}));
	const items = (lib.items ?? []).map((/** @type {any} */ row) => ({
		id: 'vitem:' + crypto.randomUUID(),
		name: String(row?.name ?? 'file'),
		kind: String(row?.kind ?? 'text'),
		folderId: row?.folderId ?? null,
		hash: String(row?.hash ?? ''),
		// a session row records no size and no date. The size is the Blob's, which is the
		// truth; the date is genuinely unknown (the payload never carried one), and a
		// column of the PROJECT's save date would be a plausible wrong answer, so the
		// Added cell reads as unknown instead.
		size: Number(row?.blob?.size) || 0,
		thumbnail: row?.thumbnail ?? null,
		createdAt: 0
	}));
	return { folders, items };
}

/**
 * Mount a saved project. Refuses a session with no library — that is a SCENE, and there
 * is nothing to browse. Mounting the same session twice is refused too, with its name:
 * two roots over one file would each buffer their own edits and the second save would
 * silently overwrite the first.
 * @param {string} sessionId @returns {Promise<MountedVolume | null>}
 */
export async function mountVolume(sessionId) {
	const id = String(sessionId ?? '').trim();
	if (!id) return null;
	await loadMountedVolumes();
	const already = get(mountedVolumes).find((v) => v.sessionId === id);
	if (already) {
		showToast('"' + already.name + '" is already mounted');
		return already;
	}
	const { getSession } = await import('./sessions');
	const payload = await getSession(id);
	if (!payload) {
		showToast('That saved entry is no longer here');
		return null;
	}
	if (!payload.library) {
		showToast('"' + (payload.name ?? 'That entry') + '" is a scene, not a project — nothing to mount');
		return null;
	}
	const { folders, items } = rowsFromPayload(payload);
	/** @type {MountedVolume} */
	const volume = {
		id: crypto.randomUUID(),
		sessionId: id,
		name: String(payload.name ?? 'Project'),
		folders,
		items,
		dirty: false,
		at: Date.now()
	};
	await write((list) => [...list, volume]);
	showToast(
		'Mounted "' + volume.name + '" (' + items.length + ' file' + (items.length === 1 ? '' : 's') + ')'
	);
	return volume;
}

/** Unmount. The saved session is untouched — this drops the VIEW, and (with it) any
 * buffered edits the caller has already asked about. @param {string} id */
export async function unmountVolume(id) {
	await write((list) => list.filter((v) => v.id !== id));
	return true;
}

/**
 * Re-read a volume from its session, discarding the buffer. The source is IndexedDB,
 * which this app owns — so there is no File System Access API here, no change events to
 * miss and nothing to poll: a re-read happens on mount, on an explicit Refresh, and when
 * the sessions store ticks.
 * @param {string} id
 */
export async function refreshVolume(id) {
	const volume = volumeById(id);
	if (!volume) return false;
	const { getSession } = await import('./sessions');
	const payload = await getSession(volume.sessionId);
	if (!payload?.library) {
		await write((list) => list.map((v) => (v.id === id ? { ...v, missing: true } : v)));
		showToast('"' + volume.name + '" is no longer saved — its files cannot be read');
		return false;
	}
	const { folders, items } = rowsFromPayload(payload);
	await write((list) =>
		list.map((v) =>
			v.id === id
				? { ...v, name: String(payload.name ?? v.name), folders, items, dirty: false, missing: false }
				: v
		)
	);
	return true;
}

/**
 * Mark every mounted volume against what is actually saved. Cheap (one idb read per
 * volume, and only its `library` presence is inspected), and it is the whole of fork 3:
 * an item whose source record has gone is rendered as unavailable rather than dropped.
 */
export async function revalidateVolumes() {
	const list = get(mountedVolumes);
	if (!list.length) return;
	const { getSession } = await import('./sessions');
	/** @type {Record<string, boolean>} */
	const gone = {};
	for (const volume of list) {
		const payload = await getSession(volume.sessionId).catch(() => null);
		gone[volume.id] = !payload?.library;
	}
	await write((all) =>
		all.map((v) => {
			const missing = !!gone[v.id];
			if (!!v.missing === missing) return v;
			const next = { ...v };
			if (missing) next.missing = true;
			else delete next.missing;
			return next;
		})
	);
}

/**
 * The bytes of one volume item. A row copied IN carries its own Blob (buffered, and
 * persisted with the mount so it survives a reload before any save); every other row
 * resolves from the SOURCE SESSION by content hash, which is why a read-only mount costs
 * no duplicated bytes at all.
 * @param {string} id @param {string} itemId @returns {Promise<Blob | null>}
 */
export async function volumeBlob(id, itemId) {
	const volume = volumeById(id);
	const row = volume?.items.find((i) => i.id === itemId);
	if (!volume || !row) return null;
	if (row.blob) return row.blob;
	const { getSession } = await import('./sessions');
	const payload = await getSession(volume.sessionId);
	const source = (payload?.library?.items ?? []).find((/** @type {any} */ r) => r?.hash === row.hash);
	return source?.blob ?? null;
}

/** Patch a volume and mark it dirty. The ONE write path for every buffered edit, so
 * "edited" and "needs saving" cannot drift apart.
 * @param {string} id @param {(v: MountedVolume) => MountedVolume} fn */
function edit(id, fn) {
	let touched = false;
	write((list) =>
		list.map((v) => {
			if (v.id !== id) return v;
			touched = true;
			return { ...fn(v), dirty: true };
		})
	);
	return touched;
}

/** @param {string} id */
export function markVolumeDirty(id) {
	return edit(id, (v) => v);
}

/** Folder names carry the library's own rule (no `* \ /`). @param {string} name */
export function isValidVolumeName(name) {
	return !!name?.trim() && !/[*\\/]/.test(name);
}

// ---- P3b: the buffered edits ------------------------------------------------------

/** @param {string} id @param {string} name @param {string | null} parentId */
export function volumeCreateFolder(id, name, parentId = null) {
	if (!isValidVolumeName(name)) return null;
	/** @type {VolumeFolder} */
	const folder = { id: crypto.randomUUID(), name: name.trim(), parentId: parentId ?? null };
	if (!edit(id, (v) => ({ ...v, folders: [...v.folders, folder] }))) return null;
	return folder;
}

/** @param {string} id @param {string} folderId @param {string} name */
export function volumeRenameFolder(id, folderId, name) {
	if (!isValidVolumeName(name)) return false;
	return edit(id, (v) => ({
		...v,
		folders: v.folders.map((f) => (f.id === folderId ? { ...f, name: name.trim() } : f))
	}));
}

/** @param {string} id @param {string} itemId @param {string} name */
export function volumeRenameItem(id, itemId, name) {
	if (!String(name ?? '').trim()) return false;
	return edit(id, (v) => ({
		...v,
		items: v.items.map((i) => (i.id === itemId ? { ...i, name: String(name).trim() } : i))
	}));
}

/** @param {string} id @param {string} itemId @param {string | null} folderId */
export function volumeMoveItem(id, itemId, folderId) {
	return edit(id, (v) => ({
		...v,
		items: v.items.map((i) => (i.id === itemId ? { ...i, folderId: folderId ?? null } : i))
	}));
}

/** Re-parent a folder inside a volume. Refuses cycles, `moveFolder`'s rule.
 * @param {string} id @param {string} folderId @param {string | null} parentId */
export function volumeMoveFolder(id, folderId, parentId) {
	if (folderId === parentId) return false;
	if (parentId && volumeSubtree(id, folderId).includes(parentId)) return false;
	return edit(id, (v) => ({
		...v,
		folders: v.folders.map((f) => (f.id === folderId ? { ...f, parentId: parentId ?? null } : f))
	}));
}

/** @param {string} id @param {string} itemId */
export function volumeDeleteItem(id, itemId) {
	return edit(id, (v) => ({ ...v, items: v.items.filter((i) => i.id !== itemId) }));
}

/** Cascade delete inside a volume: the folder, its subfolders and their files. Buffered
 * like everything else, so it is undone by Refresh until Save is pressed.
 * @param {string} id @param {string} folderId */
export function volumeDeleteFolder(id, folderId) {
	const subtree = volumeSubtree(id, folderId);
	return edit(id, (v) => ({
		...v,
		folders: v.folders.filter((f) => !subtree.includes(f.id)),
		items: v.items.filter((i) => !subtree.includes(i.folderId ?? ''))
	}));
}

/** What a cascade delete inside a volume would remove (for the confirm).
 * @param {string} id @param {string} folderId */
export function volumeFolderCounts(id, folderId) {
	const subtree = volumeSubtree(id, folderId);
	const items = volumeItems(id).filter((i) => subtree.includes(i.folderId ?? ''));
	return { folders: subtree.length, items: items.length };
}

/**
 * Copy bytes INTO a volume (a library file dragged onto a mount). Buffered: the Blob
 * rides the mount record, so the copy survives a reload before any save, and dedupes on
 * the volume's own hashes — a volume is hash-addressed inside itself for the same reason
 * the library is.
 * @param {string} id
 * @param {{name: string, kind: string, hash: string, buffer: ArrayBuffer, folderId?: string | null, thumbnail?: string | null}} file
 * @returns {VolumeItem | null}
 */
export function volumeAddBytes(id, file) {
	const volume = volumeById(id);
	if (!volume) return null;
	const existing = volume.items.find((i) => i.hash === file.hash);
	if (existing) return existing;
	/** @type {VolumeItem} */
	const row = {
		id: 'vitem:' + crypto.randomUUID(),
		name: String(file.name ?? 'file'),
		kind: String(file.kind ?? 'text'),
		folderId: file.folderId ?? null,
		hash: String(file.hash ?? ''),
		size: file.buffer?.byteLength ?? 0,
		thumbnail: file.thumbnail ?? null,
		createdAt: Date.now(),
		blob: new Blob([file.buffer])
	};
	edit(id, (v) => ({ ...v, items: [...v.items, row] }));
	return row;
}

/**
 * SAVE BACK. Rewrites the source session's `payload.library` with this volume's contents
 * and touches NOTHING ELSE: not the live library, not `projectManifest`, not the scene.
 * The session's own scene snapshot is left exactly as saved — a mount is a view of the
 * project's FILES, and rewriting the world from here is what Load is for.
 * @param {string} id @returns {Promise<boolean>}
 */
export async function saveVolume(id) {
	const volume = volumeById(id);
	if (!volume) return false;
	const library = await libraryBlockOf(id);
	if (!library) return false;
	const { writeSessionLibrary } = await import('./sessions');
	const ok = await writeSessionLibrary(volume.sessionId, library);
	if (!ok) {
		write((list) => list.map((v) => (v.id === id ? { ...v, missing: true } : v)));
		showToast('Could not save "' + volume.name + '" — that saved entry is gone');
		return false;
	}
	// the buffered Blobs are now IN the session, so the mount can go back to resolving
	// bytes by hash and stop carrying a second copy of them
	await write((list) =>
		list.map((v) =>
			v.id === id
				? {
						...v,
						items: v.items.map((i) => {
							if (!i.blob) return i;
							const { blob: _drop, ...rest } = i;
							return /** @type {VolumeItem} */ (rest);
						}),
						dirty: false,
						at: Date.now()
					}
				: v
		)
	);
	showToast(
		'Saved "' + volume.name + '" (' + library.items.length + ' file' + (library.items.length === 1 ? '' : 's') + ')'
	);
	return true;
}
