// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
// @ts-ignore - see above
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// @ts-ignore - see above
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
// @ts-ignore - see above
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
// @ts-ignore - see above
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { idbGet, idbPut, idbDelete } from './idb';
import { showToast } from '../stores/appStore';

// Explorer (phase 95): a LOCAL asset library (like prefabs — nothing here
// replicates until an asset is USED). Folder tree + items live as one small
// index record in IndexedDB; the raw file bytes live as one blob record per
// item so the in-memory store only carries metadata + small thumbnails.

const INDEX_KEY = 'explorer:index';
const BLOB_KEY = 'explorer:blob:';
export const MAX_ITEM_BYTES = 25 * 1024 * 1024;

/**
 * R22-R1 — THE NAMING PASS the plan asked for. Three flags now live on a library
 * record and they answer three DIFFERENT questions, which is exactly why they read as
 * confusable and needed settling once:
 *
 *   `imported` — PROVENANCE. A person brought these bytes in from outside (21-I1). Says
 *                nothing about who can see them.
 *   `share`    — DISTRIBUTION, and the only one that replicates anything:
 *                  absent  = LOCAL. Nobody else knows this file exists. THE MIGRATION
 *                            RULE — everything that already existed reads as local for
 *                            free, which is what makes R1 a no-op until Share is pressed.
 *                  'mine'  = I publish this row into the project's shared index.
 *                  'peer'  = the row arrived in the index; somebody else publishes it.
 *                  'no'    = an explicit VETO. Only meaningful inside a shared folder,
 *                            where it is what stops the inheritance sweep putting back
 *                            what the user just unshared.
 *   `wasShared`— it WAS 'peer' and the row went away. The copy stays (hash-addressing
 *                means unshare can never reach into a peer's library) and says so.
 *
 * `owner` rides beside them: display provenance for a row somebody else published, in
 * cloudHooks.ownerStamp's three tiers.
 * @type {import('svelte/store').Writable<{id: string, name: string, parentId: string | null, share?: string, owner?: any, wasShared?: boolean}[]>} */
export const explorerFolders = writable([]);
/** @type {import('svelte/store').Writable<{id: string, name: string, kind: string, folderId: string | null, size: number, hash: string, thumbnail: string | null, createdAt: number, imported?: boolean, share?: string, owner?: any, wasShared?: boolean}[]>} */
export const explorerItems = writable([]);
/**
 * 21-G7 — THE HIDDEN SHELF. Same record shape as `explorerItems`, same idb index
 * record, same id-addressed blobs: an item MOVES between the two lists and nothing
 * else about it changes. It exists because a scene's old versions are real files the
 * project still owns (travel by hash, a .tp export, a peer's assetShare pull all want
 * them) that must not each occupy a card — fork 10: ONE visible Explorer item per
 * scene name, the pointer, and the rest browsed only through Version history.
 *
 * Every hash-addressed read (`itemByHash`) therefore searches BOTH lists, which is
 * what keeps every existing call site working on a hidden version with no edit at all.
 * The record shape is the one `explorerItems` documents — an item MOVES between
 * the two lists and nothing else about it changes, R22-R1 share flags included.
 * @type {import('svelte/store').Writable<{id: string, name: string, kind: string, folderId: string | null, size: number, hash: string, thumbnail: string | null, createdAt: number, imported?: boolean, share?: string, owner?: any, wasShared?: boolean}[]>}
 */
export const hiddenItems = writable([]);
/** selected folder id, null = library root, 'prefabs' = the virtual prefab folder */
/** @type {import('svelte/store').Writable<string | null>} */
export const activeFolder = writable(null);

const EXTENSIONS = {
	image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
	// 23-D1: the containers the app's own recorder writes (MediaRecorder: webm/opus,
	// ogg/opus, mp4) - decoding is decodeAudioData, which handles what the browser records
	audio: ['mp3', 'wav', 'ogg', 'webm', 'weba', 'opus', 'm4a', 'flac'],
	text: ['txt', 'json', 'md', 'cfg', 'js'],
	object: ['glb', 'gltf', 'obj', 'stl', 'fbx'],
	// 21-F4: a LEVEL — a .tpscene zip the travel node loads by content hash. Its own
	// kind so it never opens in the text editor (it is a binary zip) and gets a map icon.
	scene: ['tpscene']
};

/** @param {string} name */
export function kindOf(name) {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	for (const [kind, exts] of Object.entries(EXTENSIONS)) if (exts.includes(ext)) return kind;
	return null;
}

let loaded = false;
/** the in-flight load, so a second caller AWAITS it instead of racing past an
 * already-flipped `loaded` flag with an empty store (21-G7: the version migration is
 * one such second caller, and folding against an empty library is a silent no-op)
 * @type {Promise<void> | null} */
let loading = null;
export async function loadExplorer() {
	if (typeof indexedDB === 'undefined') return;
	if (loaded) return loading ?? undefined;
	loaded = true;
	loading = (async () => {
		try {
			const index = (await idbGet(INDEX_KEY)) ?? { folders: [], items: [] };
			explorerFolders.set(index.folders ?? []);
			explorerItems.set(index.items ?? []);
			// 21-G7: absent in a pre-G7 index, which is exactly right — nothing was hidden
			// yet, and the migration (levels.foldSceneVersions) folds the duplicates on boot
			hiddenItems.set(index.hidden ?? []);
		} catch (error) {
			console.log('explorer load failed', error);
		}
	})();
	return loading;
}

async function persistIndex() {
	try {
		await idbPut(INDEX_KEY, {
			folders: get(explorerFolders),
			items: get(explorerItems),
			hidden: get(hiddenItems)
		});
	} catch (error) {
		console.log('explorer persist failed', error);
	}
}

// ---- folders ----

/** Folder names can't carry `* \ /` (106) @param {string} name */
export function isValidName(name) {
	return !!name?.trim() && !/[*\\/]/.test(name);
}

/**
 * @param {string} name @param {string | null=} parentId
 * @param {{id?: string, share?: string, owner?: any}} [meta] R22-R1: a SHARED folder's
 *   id is network identity — every peer adopting the row must create the folder under
 *   the SAME uuid so each `folderId` reference resolves everywhere with no remapping.
 *   (That is the one place this differs from a .tp import, which remaps ids precisely
 *   because a file must not collide with the library it lands in.) Passing an id that
 *   is already here is a no-op returning the folder that holds it.
 */
export function createFolder(name, parentId = null, meta = {}) {
	if (!isValidName(name)) return null;
	const given = String(meta.id ?? '').trim();
	if (given) {
		const held = get(explorerFolders).find((f) => f.id === given);
		if (held) return held;
	}
	/** @type {any} */
	const folder = { id: given || crypto.randomUUID(), name: name.trim(), parentId };
	if (meta.share) folder.share = meta.share;
	if (meta.owner) folder.owner = meta.owner;
	explorerFolders.update((list) => [...list, folder]);
	persistIndex();
	return folder;
}

/** @param {string} id @param {string} name */
export function renameFolder(id, name) {
	if (!isValidName(name)) return false;
	explorerFolders.update((list) => list.map((f) => (f.id === id ? { ...f, name: name.trim() } : f)));
	persistIndex();
	return true;
}

/** Every folder id inside a subtree, root included @param {string} id */
export function folderSubtree(id) {
	const list = get(explorerFolders);
	const out = [id];
	for (let i = 0; i < out.length; i++)
		for (const f of list) if (f.parentId === out[i]) out.push(f.id);
	return out;
}

/** What a cascade delete would remove (for the confirm, 106) @param {string} id */
export function folderCounts(id) {
	const subtree = folderSubtree(id);
	const items = get(explorerItems).filter((item) => subtree.includes(item.folderId ?? ''));
	return { folders: subtree.length, items: items.length };
}

/** Cascade delete (106): the folder, its subfolders AND their items @param {string} id */
export async function deleteFolder(id) {
	const subtree = folderSubtree(id);
	// 21-G7: a hidden version lives in the same folder as the scene it belongs to, so a
	// cascade delete has to take it too — otherwise the bytes outlive every way of
	// reaching them
	const doomed = [...get(explorerItems), ...get(hiddenItems)].filter((item) =>
		subtree.includes(item.folderId ?? '')
	);
	explorerFolders.update((list) => list.filter((f) => !subtree.includes(f.id)));
	explorerItems.update((list) => list.filter((item) => !subtree.includes(item.folderId ?? '')));
	hiddenItems.update((list) => list.filter((item) => !subtree.includes(item.folderId ?? '')));
	activeFolder.update((current) => (current && subtree.includes(current) ? null : current));
	for (const item of doomed) await idbDelete(BLOB_KEY + item.id);
	await persistIndex();
}

/**
 * R22 round 36 — REMOVE FOLDER RECORDS AND NOTHING ELSE.
 *
 * `deleteFolder` above is the DESTROYER: it takes the folders, the items inside them and
 * their blobs. That is exactly wrong for a delete that goes to the bin, where the whole
 * point is that the files still exist (hidden, bytes intact, `folderId` untouched) so
 * Restore can put them back where they were. So the bin needs the other half on its own:
 * the PLACES go, the things do not.
 *
 * It is also what a peer runs when it applies somebody else's folder deletion — a peer
 * must never destroy bytes on the strength of a message (the recycle-bin rule), and the
 * hidden items inside keep pointing at these ids so the tree can be rebuilt from the log.
 * @param {string[]} ids @returns {number} how many records went
 */
export function removeFolderRecords(ids) {
	const doomed = new Set(ids ?? []);
	if (!doomed.size) return 0;
	explorerFolders.update((list) => list.filter((f) => !doomed.has(f.id)));
	// standing in a folder that no longer exists shows an empty grid with a breadcrumb
	// naming nothing — the same reset `deleteFolder` performs, for the same reason
	activeFolder.update((current) => (current && doomed.has(current) ? null : current));
	persistIndex();
	return doomed.size;
}

/**
 * R22 round 36 — the DISPLAY PATH of a folder: its own name and every ancestor's, root
 * first. Recorded on a deleted row because a name that can no longer be resolved (the
 * folder purged from the library AND evicted from the log) cannot be re-derived — the
 * thumbnail's own argument, one field over.
 *
 * BOUNDED like every other parent walk here: a corrupted index must not hang the caller.
 * @param {string | null | undefined} folderId @returns {string[]} `[]` for the root or an
 *   id nothing here knows
 */
export function folderPath(folderId) {
	const byId = new Map(get(explorerFolders).map((f) => [f.id, f]));
	/** @type {string[]} */
	const out = [];
	let at = folderId ?? null;
	for (let i = 0; at && i < 64; i++) {
		const folder = byId.get(at);
		if (!folder) break;
		out.push(folder.name);
		at = folder.parentId ?? null;
	}
	return out.reverse();
}

/** Re-parent a folder by drag (106); refuses cycles @param {string} id @param {string | null} parentId */
export function moveFolder(id, parentId) {
	if (id === parentId) return false;
	if (parentId && folderSubtree(id).includes(parentId)) return false; // no cycles
	explorerFolders.update((list) =>
		list.map((f) => (f.id === id ? { ...f, parentId } : f))
	);
	persistIndex();
	return true;
}

/**
 * 21-G8: wipe the whole user library — every item's blob, every folder, the index.
 * The destructive half of "Open project" (fork 12: open REPLACES); the caller owns
 * the warning dialog. Prefabs and packs live in their own stores and are untouched.
 */
export async function clearLibrary() {
	// 21-G7 (union): the hidden shelf is part of the library — old scene versions
	// belong to the project being replaced, so their bytes go too
	const doomed = [...get(explorerItems), ...get(hiddenItems)];
	explorerItems.set([]);
	hiddenItems.set([]);
	explorerFolders.set([]);
	activeFolder.set(null);
	for (const item of doomed) await idbDelete(BLOB_KEY + item.id);
	await persistIndex();
}

/**
 * R22-R1: patch fields on a library record. The ONE write path for the share flags,
 * so `sharedLibrary.js` never reaches into the store shape itself — and undefined in
 * the patch DELETES the key, which is what keeps 'absent = local' expressible (a
 * record carrying `share: undefined` is not the same document as one carrying nothing,
 * and only the second one serializes byte-identically to a pre-R1 index).
 * @param {string} id @param {Record<string, any>} patch
 * @param {'item'|'folder'} [which]
 * @returns {boolean} did anything change
 */
export function patchRecord(id, patch, which = 'item') {
	const store = which === 'folder' ? explorerFolders : explorerItems;
	let changed = false;
	store.update((list) =>
		/** @type {any} */ (list).map((/** @type {any} */ row) => {
			if (row.id !== id) return row;
			const next = { ...row };
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined) {
					if (k in next) {
						delete next[k];
						changed = true;
					}
				} else if (next[k] !== v) {
					next[k] = v;
					changed = true;
				}
			}
			return changed ? next : row;
		})
	);
	if (changed) persistIndex();
	return changed;
}

/** @param {string} itemId @param {string | null} folderId */
export function moveItem(itemId, folderId) {
	explorerItems.update((list) =>
		list.map((item) => (item.id === itemId ? { ...item, folderId } : item))
	);
	persistIndex();
}

// ---- items ----

/** @param {ArrayBuffer} buffer */
async function sha256(buffer) {
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The content hash of some bytes, exported because AN ITEM'S IDENTITY IS ITS HASH — a
 * caller that wants to know "do I already hold this?" BEFORE writing anything has to be
 * able to ask the same question this module answers internally. Every import path does.
 * @param {ArrayBuffer} buffer @returns {Promise<string>}
 */
export function hashBytes(buffer) {
	return sha256(buffer);
}

/** offscreen render shared by every 3D kind (prefabs pattern) @param {any} object */
function renderObjectThumbnail(object) {
	try {
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setSize(128, 128);
		const scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.4));
		scene.add(object);
		const box = new THREE.Box3().setFromObject(object);
		if (!isFinite(box.min.x)) return null;
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001);
		const center = box.getCenter(new THREE.Vector3());
		const camera = new THREE.PerspectiveCamera(40, 1, size / 100, size * 10);
		camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.9));
		camera.lookAt(center);
		renderer.render(scene, camera);
		const url = renderer.domElement.toDataURL('image/webp', 0.72);
		renderer.dispose();
		renderer.forceContextLoss?.();
		return url;
	} catch (error) {
		console.log('explorer thumbnail failed', error);
		return null;
	}
}

/** @param {Blob} blob */
function imageThumbnail(blob) {
	return new Promise((resolve) => {
		const img = new Image();
		const url = URL.createObjectURL(blob);
		img.onload = () => {
			const scale = Math.min(1, 128 / Math.max(img.width, img.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(img.width * scale));
			canvas.height = Math.max(1, Math.round(img.height * scale));
			canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
			URL.revokeObjectURL(url);
			resolve(canvas.toDataURL('image/webp', 0.75));
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve(null);
		};
		img.src = url;
	});
}

/** Parse a 3D file into a THREE object (thumbnail + N4 preview) @param {ArrayBuffer} buffer @param {string} ext */
export async function parseObjectFile(buffer, ext) {
	if (ext === 'obj') return new OBJLoader().parse(new TextDecoder().decode(buffer));
	if (ext === 'stl') {
		const geometry = new STLLoader().parse(buffer);
		return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8899aa }));
	}
	if (ext === 'fbx') return new FBXLoader().parse(buffer, '');
	// glb/gltf
	const gltf = await new Promise((resolve, reject) =>
		new GLTFLoader().parse(buffer, '', resolve, reject)
	);
	// R22 ROUND 15: CARRY THE CLIPS. GLTFLoader hands back `{scene, animations}` as two
	// separate fields, so returning the scene alone silently dropped every animation in
	// the file — and this is the ONE parse path the Explorer, its thumbnails and the
	// preview all go through, so an animated GLB has been arriving here inert. Hanging
	// them on the object is three's own convention (its examples do exactly this) and it
	// is what FBXLoader already does unprompted, which is why FBX was the only format
	// where animation data survived the trip.
	gltf.scene.animations = gltf.animations ?? [];
	return gltf.scene;
}

/** @param {Blob} blob @param {string} name @param {string} kind */
async function thumbnailFor(blob, name, kind) {
	try {
		if (kind === 'image') return await imageThumbnail(blob);
		if (kind === 'object') {
			const ext = name.split('.').pop()?.toLowerCase() ?? '';
			const object = await parseObjectFile(await blob.arrayBuffer(), ext);
			return renderObjectThumbnail(object);
		}
	} catch (error) {
		console.log('thumbnail skipped for ' + name, error);
	}
	return null; // audio/text get icon cards
}

/**
 * THE DUPLICATE-IMPORT SEAM (loose-scenes fix, bug 2a). An item's identity IS its
 * content hash, so re-importing bytes the library already holds can only ever mean one
 * of three things — reuse what is there, say nothing, or make a genuinely new file —
 * and which one is a USER SETTING plus, in the Ask case, a modal.
 *
 * It is a registration seam and not an import, for the ordinary reason: the decision
 * needs the setting store, a modal component and (for a scene copy) fflate, while this
 * module is the LEAF every one of those sits above. importDuplicates.js registers
 * itself; with nothing registered the behaviour is `reuse`, which is what every
 * programmatic caller wants anyway.
 * @type {((dupes: any[], context: any) => Promise<{copies: {name: string, buffer: ArrayBuffer}[]}>) | null}
 */
let duplicateResolver = null;
/** @param {(dupes: any[], context: any) => Promise<any>} fn */
export function registerDuplicateResolver(fn) {
	duplicateResolver = fn;
}

/**
 * Import dropped/picked files into a folder.
 *
 * DEDUPE (loose-scenes fix): this used to write an item unconditionally, so dropping
 * the same file twice minted TWO items sharing one hash — and `itemByHash` answers with
 * the first, which is the invariant travel-by-hash, the .tp export and every assetShare
 * pull stand on. It now asks the same question `addItemFromBytes` always asked, and
 * routes the answer through `duplicateResolver` so the user can SEE it.
 *
 * The return contract is "the item each input file resolved to", existing items
 * included — a picker handing us a texture the library already holds wants that item,
 * not an empty array (ShaderTexturePicker / HudImagePicker both index `created[0]`).
 * @param {FileList | File[]} files @param {string | null} folderId
 * @param {{duplicates?: 'ask' | 'reuse'}} [opts] `reuse` = silently answer with the
 *   item already held (programmatic callers: the pickers, a generated mesh); `ask` =
 *   consult the setting and, when it says so, the user
 */
export async function importFiles(files, folderId = null, opts = {}) {
	const created = [];
	/** @type {any[]} */
	const dupes = [];
	let fresh = 0;
	for (const file of [...files]) {
		const kind = kindOf(file.name);
		if (!kind) {
			showToast('Unsupported: ' + file.name + ' (images, audio, text/config, 3D objects)');
			continue;
		}
		if (file.size > MAX_ITEM_BYTES) {
			showToast(file.name + ' is over the 25 MB Explorer limit');
			continue;
		}
		const buffer = await file.arrayBuffer();
		const hash = await sha256(buffer);
		const visible = get(explorerItems).find((item) => item.hash === hash);
		if (visible) {
			dupes.push({ name: file.name, kind, hash, buffer, existing: visible });
			created.push(visible);
			continue;
		}
		// bytes on the HIDDEN shelf are an old scene version we folded away — bring the
		// record back rather than asking about a file the user cannot see (and rather than
		// minting a second item for one blob). Exactly what addItemFromBytes does, and the
		// fold sweep still gets the last word on whether it stays a card.
		const shelved = get(hiddenItems).find((item) => item.hash === hash);
		if (shelved) {
			setItemHidden(shelved.id, false);
			created.push(shelved);
			continue;
		}
		const item = await writeItem(buffer, file.name, folderId === 'prefabs' ? null : folderId, {
			kind,
			type: file.type,
			imported: true
		});
		// the in-flight guard can hand back an item an earlier file in this same batch
		// already wrote (one file listed twice in a drop) — count what LANDED, not calls
		if (!created.some((c) => c.id === item.id)) fresh++;
		created.push(item);
	}
	if (fresh) {
		await persistIndex();
		showToast('Imported ' + fresh + ' item' + (fresh === 1 ? '' : 's'));
	}
	if (dupes.length && opts.duplicates === 'ask' && duplicateResolver) {
		const { copies } = (await duplicateResolver(dupes, { folderId })) ?? { copies: [] };
		for (const copy of copies ?? []) {
			const item = await writeItem(
				copy.buffer,
				copy.name,
				folderId === 'prefabs' ? null : folderId,
				{ imported: true }
			);
			created.push(item);
		}
		if (copies?.length) await persistIndex();
	}
	return created;
}

/** hash -> the write currently in flight for it @type {Map<string, Promise<any>>} */
const writing = new Map();

/**
 * The one place an item RECORD is minted. Extracted from the two import paths so the
 * dedupe, the `imported` stamp and the thumbnail rule cannot drift between them; the
 * caller owns `persistIndex` because a batch import should write the index once.
 * @param {ArrayBuffer} buffer @param {string} name @param {string | null} folderId
 * @param {{kind?: string, type?: string, imported?: boolean, hash?: string, thumbnail?: string | null}} [meta]
 */
async function writeItem(buffer, name, folderId, meta = {}) {
	const hash = meta.hash ?? (await sha256(buffer));
	// THE RACE, and why a plain itemByHash check upstream is not enough: writing an
	// item awaits a thumbnail (an image decode, a GLB parse — up to the 4s cap below),
	// and the store is not updated until that resolves. Two drops of one file inside
	// that window BOTH looked fresh and BOTH wrote, leaving two items sharing one hash
	// — measured on a 1x1 PNG dropped three times 500ms apart. `itemByHash` answers with
	// whichever came first, so travel-by-hash, the .tp export and every assetShare pull
	// would have been resolving against an arbitrary one of them.
	//
	// An in-flight PROMISE per hash (not a bare flag) is what makes the second caller
	// correct rather than merely blocked: it awaits the first write and receives the
	// SAME item, which is exactly the answer the dedupe path gives.
	const pending = writing.get(hash);
	if (pending) return pending;
	const job = writeItemNow(buffer, name, folderId, { ...meta, hash });
	writing.set(hash, job);
	try {
		return await job;
	} finally {
		writing.delete(hash);
	}
}

/** @param {ArrayBuffer} buffer @param {string} name @param {string | null} folderId
 *  @param {{kind?: string, type?: string, imported?: boolean, hash?: string, thumbnail?: string | null,
 *    id?: string, share?: string, owner?: any}} meta
 *  `thumbnail` (24-C1): a copy carries its source's, so a duplicate costs no decode.
 *  `id` (24-C2): the record is minted under a GIVEN uuid — a shared row's id is network
 *  identity, so a peer materialising the row must hold it under the same one (the
 *  `createFolder(name, parent, {id})` rule). `share`/`owner` stamp the adoption marks at
 *  write, so the record never spends a sweep looking like a local file nobody decided about. */
async function writeItemNow(buffer, name, folderId, meta) {
	const kind = meta.kind ?? kindOf(name) ?? 'text';
	const blob = new Blob([buffer], meta.type ? { type: meta.type } : undefined);
	// the thumbnail is DECORATIVE — never let a wedged loader/renderer block
	// storing the bytes (a hung GLB parse used to silently swallow shared
	// assets on the receiving peer, R-3); the card falls back to an icon
	const thumbnail =
		meta.thumbnail !== undefined
			? meta.thumbnail
			: await Promise.race([
					thumbnailFor(blob, name, kind),
					new Promise((resolve) => setTimeout(() => resolve(null), 4000))
				]);
	const item = {
		id: String(meta.id ?? '').trim() || crypto.randomUUID(),
		name,
		kind,
		folderId,
		size: buffer.byteLength,
		hash: /** @type {string} */ (meta.hash),
		thumbnail,
		createdAt: Date.now(),
		// loose-scenes fix (bug 1, second half): PROVENANCE. `hideOldVersions` folds
		// same-NAMED scene files together as versions of one scene, which is right for
		// the legacy duplicates that migration was written for and WRONG for two files a
		// user dragged in independently — one of them silently vanishes onto the hidden
		// shelf. A stamp is the only thing that can tell the two apart, and its ABSENCE
		// means "this app minted it", so every item written before today keeps folding.
		...(meta.imported ? { imported: true } : {}),
		...(meta.share ? { share: meta.share } : {}),
		...(meta.owner ? { owner: meta.owner } : {})
	};
	await idbPut(BLOB_KEY + item.id, blob);
	explorerItems.update((list) => [...list, item]);
	return item;
}

/**
 * Add raw bytes programmatically (97 shared sounds land here). Dedupes by
 * content hash — SILENTLY, which is right here: every caller of this one is the app
 * writing its own bytes (a save, a pack, a peer's push), where "we already hold these"
 * is the answer rather than a question. The paths where a PERSON is importing go
 * through `importFiles` / the duplicate resolver instead.
 * @param {ArrayBuffer} buffer @param {string} name
 * @param {string | null} folderId
 * @param {{imported?: boolean, allowDuplicate?: boolean, id?: string, share?: string, owner?: any, thumbnail?: string | null}} [opts]
 *   loose-scenes fix: stamp provenance — see `writeItem`. Absent means "this app minted
 *   it", so nothing already stored changes. `allowDuplicate` (24-C1): skip the hash dedupe
 *   and mint a SECOND record for bytes we already hold — a copy is a record, its bytes are
 *   content. `id` (24-C2): write the record under THIS uuid — a shared row's identity — and
 *   skip the dedupe for the same reason; a record already held under that id is returned
 *   as-is (idempotent, the `createFolder` rule). `share`/`owner` ride onto the record.
 *   `thumbnail` (24-C3): a scene copy carries its source card's picture rather than
 *   decoding one (a .tpscene decodes to none anyway); undefined = derive as before.
 */
export async function addItemFromBytes(buffer, name, folderId = null, opts = {}) {
	const wantId = String(opts.id ?? '').trim();
	// a write FOR a given id goes through the per-id lock: the shared library's sweep and
	// the bytes landing from a peer both want to mint the same record, and the second
	// caller must receive the first one's record rather than a twin under one id
	if (wantId) return mintOnce(wantId, () => addItemFromBytesNow(buffer, name, folderId, opts, wantId));
	return addItemFromBytesNow(buffer, name, folderId, opts, '');
}

/** @type {Map<string, Promise<any>>} record id -> the write minting it (24-C2) */
const mintingById = new Map();

/**
 * 24-C2: ONE WRITE PER RECORD ID. Two async callers can ask for the same id inside one
 * tick — `landBytes` writing a row's record as the bytes arrive, and the library sweep
 * copying the same row from a sibling record — and both would pass an `itemById` check
 * before either had written. The second waits for the first and gets its record, the same
 * shape as `writeItem`'s in-flight promise per hash.
 * @param {string} id @param {() => Promise<any>} fn
 */
async function mintOnce(id, fn) {
	const pending = mintingById.get(id);
	if (pending) return pending;
	const job = fn();
	mintingById.set(id, job);
	try {
		return await job;
	} finally {
		mintingById.delete(id);
	}
}

/** the body of addItemFromBytes, once any id lock is held
 * @param {ArrayBuffer} buffer @param {string} name @param {string | null} folderId
 * @param {{imported?: boolean, allowDuplicate?: boolean, id?: string, share?: string, owner?: any, thumbnail?: string | null}} opts
 * @param {string} wantId */
async function addItemFromBytesNow(buffer, name, folderId, opts, wantId) {
	if (wantId) {
		const held = itemById(wantId);
		if (held) return held;
	}
	const hash = await sha256(buffer);
	if (!opts.allowDuplicate && !wantId) {
		const existing = get(explorerItems).find((item) => item.hash === hash);
		if (existing) return existing;
		// 21-G7: we may already hold these exact bytes on the hidden shelf — a restored
		// version being saved again, or a peer pushing back a hash we folded away. Bring
		// the record back rather than minting a second item for one blob; the caller's
		// publish then decides whether it stays visible (it is the pointer) or is folded
		// straight back by the hide sweep.
		const shelved = get(hiddenItems).find((item) => item.hash === hash);
		if (shelved) {
			setItemHidden(shelved.id, false);
			return shelved;
		}
	}
	const thumb = opts.thumbnail !== undefined ? { thumbnail: opts.thumbnail } : {};
	const item =
		opts.allowDuplicate || wantId
			? await writeItemNow(buffer, name, folderId, {
					hash,
					imported: !!opts.imported,
					...thumb,
					...(wantId ? { id: wantId } : {}),
					...(opts.share ? { share: opts.share } : {}),
					...(opts.owner ? { owner: opts.owner } : {})
				})
			: await writeItem(buffer, name, folderId, { hash, imported: !!opts.imported, ...thumb });
	await persistIndex();
	return item;
}

// ---- 24-C1: Duplicate / Copy / Paste — a record is a pointer, bytes are content ----
//
// The git model, and the folder precedent this library already keeps ("a folder's id is
// network identity"): a copy is a NEW RECORD holding the SAME hash. Locally that is a
// second id-addressed blob (nothing is shared between records, so deleting one leaves the
// other); on the wire (C2) it is a second row with the same content pointer, which a peer
// that already holds the hash materialises with no transfer. `share` is NOT copied — the
// copy is local until shared, unless it lands in a shared folder, where the inheritance
// sweep picks it up exactly as it would a dropped file.

/**
 * The Finder/Blender copy name: "Tower.glb" → "Tower copy.glb" → "Tower copy 2.glb",
 * extension preserved, an existing " copy N" suffix collapsed rather than stacked.
 * @param {string} name @param {Iterable<string>} siblings names already in the folder
 */
export function nextCopyName(name, siblings) {
	const m = /^(.*?)(\.[^./]+)?$/.exec(String(name || 'file'));
	const rawBase = m?.[1] ?? '';
	// a dot-file (".env") has no extension: the whole name is the stem
	const ext = rawBase ? (m?.[2] ?? '') : '';
	const stem = (rawBase || String(name || 'file')).replace(/ copy( \d+)?$/i, '') || 'file';
	const taken = new Set([...siblings].map((s) => String(s).toLowerCase()));
	for (let n = 1; n < 10000; n++) {
		const candidate = (n === 1 ? stem + ' copy' : stem + ' copy ' + n) + ext;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
	return stem + ' copy ' + Date.now() + ext;
}

/** the names in one folder (visible items), for collision checks @param {string | null} folderId */
function namesIn(folderId) {
	return get(explorerItems)
		.filter((item) => (item.folderId ?? null) === (folderId ?? null))
		.map((item) => item.name);
}

/**
 * A second record for an item's bytes — a local blob read, no hashing (the hash is
 * known), the thumbnail carried over, `share` NOT copied. Into the same folder it takes
 * the copy name; into another folder it keeps its name unless that collides.
 * @param {string} id @param {{folderId?: string | null, name?: string, id?: string, share?: string, owner?: any}} [opts]
 *   `folderId` undefined = the source's folder. `id`/`share`/`owner` (24-C2): the copy is
 *   being made FOR a shared row a peer published — it takes the row's id (network identity)
 *   and its adoption marks, and a record already held under that id is returned as-is.
 * @returns {Promise<any | null>} the new record
 */
export async function duplicateItem(id, opts = {}) {
	const wantId = String(opts.id ?? '').trim();
	// the same per-id lock as addItemFromBytes: a copy made FOR a shared row must not race
	// the bytes of that row landing from a peer into a second record under one id
	if (wantId) return mintOnce(wantId, () => duplicateItemNow(id, opts, wantId));
	return duplicateItemNow(id, opts, '');
}

/** the body of duplicateItem, once any id lock is held
 * @param {string} id @param {{folderId?: string | null, name?: string, id?: string, share?: string, owner?: any}} opts
 * @param {string} wantId */
async function duplicateItemNow(id, opts, wantId) {
	if (wantId) {
		const held = itemById(wantId);
		if (held) return held;
	}
	const source = allItems().find((item) => item.id === id);
	if (!source) return null;
	const blob = await itemBlob(id);
	if (!blob) return null;
	const folderId = opts.folderId === undefined ? source.folderId ?? null : opts.folderId;
	const siblings = namesIn(folderId);
	const sameFolder = (folderId ?? null) === (source.folderId ?? null);
	const collides = siblings.some((n) => n.toLowerCase() === source.name.toLowerCase());
	const name = opts.name ?? (sameFolder || collides ? nextCopyName(source.name, siblings) : source.name);
	const item = await writeItemNow(await blob.arrayBuffer(), name, folderId, {
		hash: source.hash,
		kind: source.kind,
		type: blob.type || undefined,
		imported: !!source.imported,
		thumbnail: source.thumbnail ?? null,
		...(wantId ? { id: wantId } : {}),
		...(opts.share ? { share: opts.share } : {}),
		...(opts.owner ? { owner: opts.owner } : {})
	});
	await persistIndex();
	return item;
}

/**
 * A folder and everything under it as new records (a new folder id — network identity
 * is minted here, C2 makes its rows zero-transfer for held hashes). Same naming rule
 * against the sibling folders.
 * @param {string} id @param {string | null} [parentId] undefined = beside the source
 * @returns {Promise<any | null>} the new root folder
 */
export async function duplicateFolder(id, parentId) {
	const source = get(explorerFolders).find((f) => f.id === id);
	if (!source) return null;
	const into = parentId === undefined ? source.parentId ?? null : parentId;
	if (into && folderSubtree(id).includes(into)) return null; // never into itself
	const siblingNames = get(explorerFolders)
		.filter((f) => (f.parentId ?? null) === (into ?? null))
		.map((f) => f.name);
	const sameParent = (into ?? null) === (source.parentId ?? null);
	const collides = siblingNames.some((n) => n.toLowerCase() === source.name.toLowerCase());
	const name = sameParent || collides ? nextCopyName(source.name, siblingNames) : source.name;
	const copy = createFolder(name, into);
	if (!copy) return null;
	/** @param {string} fromId @param {string} toId */
	const walk = async (fromId, toId) => {
		for (const item of get(explorerItems).filter((i) => i.folderId === fromId))
			await duplicateItem(item.id, { folderId: toId, name: item.name });
		for (const sub of get(explorerFolders).filter((f) => f.parentId === fromId)) {
			const made = createFolder(sub.name, toId);
			if (made) await walk(sub.id, made.id);
		}
	};
	await walk(id, copy.id);
	await persistIndex();
	return copy;
}

/** Delete an item and its bytes. 21-G7: the id may name a HIDDEN version (Version
 * history ▸ Delete) — one filter over each list, so the caller never has to know which
 * shelf it was on. @param {string} id */
export async function deleteItem(id) {
	explorerItems.update((list) => list.filter((item) => item.id !== id));
	hiddenItems.update((list) => list.filter((item) => item.id !== id));
	await idbDelete(BLOB_KEY + id);
	await persistIndex();
}

/**
 * 21-G7: move one item between the visible library and the hidden shelf. The record is
 * carried across UNCHANGED and the blob is never touched (it is id-addressed), so
 * hiding is reversible and costs nothing.
 * @param {string} id @param {boolean} hidden @returns {boolean} did anything move
 */
export function setItemHidden(id, hidden = true) {
	const from = hidden ? explorerItems : hiddenItems;
	const to = hidden ? hiddenItems : explorerItems;
	const record = get(from).find((item) => item.id === id);
	if (!record) return false;
	from.update((list) => list.filter((item) => item.id !== id));
	to.update((list) => (list.some((item) => item.id === id) ? list : [...list, record]));
	persistIndex();
	return true;
}

/** Every item on either shelf — the hash-addressed reads and the .tp export walk this.
 * @returns {any[]} */
export function allItems() {
	return [...get(explorerItems), ...get(hiddenItems)];
}

/** @param {string} id @param {string} name */
export function renameItem(id, name) {
	explorerItems.update((list) => list.map((item) => (item.id === id ? { ...item, name } : item)));
	persistIndex();
}

/** the item whose properties show in the Inspector (107) */
/** @type {import('svelte/store').Writable<string | null>} */
export const inspectedFile = writable(null);

/**
 * loose-scenes fix (bug 2a): "show me the one I already have". A REQUEST store rather
 * than a callback, because the asker is a modal at the App root and the answer —
 * switch folder, select the card, scroll it into view — belongs to the Explorer
 * component, which may not even be mounted. It writes an id; the Explorer consumes it
 * and clears it, and a request nobody consumes simply expires with the session.
 * @type {import('svelte/store').Writable<string | null>}
 */
export const revealItemId = writable(null);
/** @param {string} id */
export function revealItem(id) {
	revealItemId.set(String(id ?? '') || null);
}

/** Save edited text back into an item — hash + size recompute (107)
 * @param {string} id @param {string} text */
export async function updateItemBytes(id, text) {
	const buffer = new TextEncoder().encode(text).buffer;
	const hash = await sha256(buffer);
	await idbPut(BLOB_KEY + id, new Blob([buffer], { type: 'text/plain' }));
	explorerItems.update((list) =>
		list.map((item) => (item.id === id ? { ...item, hash, size: buffer.byteLength } : item))
	);
	await persistIndex();
}

/** The stored file bytes @param {string} id @returns {Promise<Blob | null>} */
export function itemBlob(id) {
	return idbGet(BLOB_KEY + id).then((blob) => blob ?? null);
}

/**
 * Find an item by content hash (97 pull path). 21-G7: VISIBLE first, then the hidden
 * shelf — this one line is what keeps travel-by-hash, the .tp export and a peer's
 * assetShare pull working on an old scene version with no call-site edits anywhere.
 * @param {string} hash
 */
export function itemByHash(hash) {
	return (
		get(explorerItems).find((item) => item.hash === hash) ??
		get(hiddenItems).find((item) => item.hash === hash) ??
		null
	);
}

// ---- 24-C2: a record is a pointer, and the pointer has an identity ------------------
//
// Four reads and writes the shared library needs once a row is `{id, hash}` rather than a
// hash: find a record by its id on EITHER shelf, list every record holding one hash (the
// copies), re-key a record onto a row's id (a peer's own copy of the same bytes BINDS to the
// arriving row rather than sitting beside a duplicate), and replace a record's bytes in
// place (an edited copy is the same record with a new hash — one transfer, no second card).

/** A record by id, visible or hidden. @param {string} id @returns {any | null} */
export function itemById(id) {
	const want = String(id ?? '').trim();
	if (!want) return null;
	return (
		get(explorerItems).find((item) => item.id === want) ??
		get(hiddenItems).find((item) => item.id === want) ??
		null
	);
}

/** Every record holding these bytes, visible first then hidden. @param {string} hash @returns {any[]} */
export function itemsByHash(hash) {
	const want = String(hash ?? '').trim();
	if (!want) return [];
	return [...get(explorerItems), ...get(hiddenItems)].filter((item) => item.hash === want);
}

/**
 * Give a record a new id, blob included. The blob is copied under the new key BEFORE the
 * index changes and dropped under the old one after, so no read in between finds a record
 * whose bytes are missing. Refuses to collide with a record already held under `newId`.
 * @param {string} oldId @param {string} newId @returns {Promise<boolean>} did it move
 */
export async function rekeyItem(oldId, newId) {
	const from = String(oldId ?? '').trim();
	const to = String(newId ?? '').trim();
	if (!from || !to || from === to) return false;
	if (itemById(to) || !itemById(from)) return false;
	const blob = await idbGet(BLOB_KEY + from);
	if (blob) await idbPut(BLOB_KEY + to, blob);
	const swap = (/** @type {any[]} */ list) => list.map((item) => (item.id === from ? { ...item, id: to } : item));
	explorerItems.update(swap);
	hiddenItems.update(swap);
	if (blob) await idbDelete(BLOB_KEY + from);
	await persistIndex();
	return true;
}

/**
 * Replace a record's bytes in place: new blob under the SAME id, hash and size recomputed,
 * the thumbnail re-derived (time-boxed like every write). `updateItemBytes` is the text
 * editor's special case of this; the shared library uses it when a row it holds points at a
 * hash it does not — the publisher edited the file, and the record follows.
 * @param {string} id @param {ArrayBuffer} buffer @param {{type?: string}} [opts]
 * @returns {Promise<any | null>} the updated record
 */
export async function replaceItemBytes(id, buffer, opts = {}) {
	const record = itemById(id);
	if (!record) return null;
	const hash = await sha256(buffer);
	const blob = new Blob([buffer], opts.type ? { type: opts.type } : undefined);
	const thumbnail = await Promise.race([
		thumbnailFor(blob, record.name, record.kind),
		new Promise((resolve) => setTimeout(() => resolve(record.thumbnail ?? null), 4000))
	]);
	await idbPut(BLOB_KEY + record.id, blob);
	const patch = (/** @type {any[]} */ list) =>
		list.map((item) => (item.id === record.id ? { ...item, hash, size: buffer.byteLength, thumbnail } : item));
	explorerItems.update(patch);
	hiddenItems.update(patch);
	await persistIndex();
	return itemById(record.id);
}
