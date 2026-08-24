import { get, writable } from 'svelte/store';
import { peers, showToast } from '../stores/appStore';
import { explorerFolders, itemBlob, itemByHash, addItemFromBytes, createFolder } from './explorer';
import { projectManifest } from './projectManifest';
import { idbGet, idbPut } from './idb';

// Shared assets (97): the Explorer library is local, but any file a node USES
// is shared — bytes travel keyed by content hash, PUSHED once on assign and
// PULLED on demand by any peer missing the hash (late joiners, autosave
// restores, session loads). Received files land in the receiver's Explorer
// under a built-in 'Shared' folder so they are visible and reusable.

export const MAX_SHARED_BYTES = 5 * 1024 * 1024;

/**
 * R22 round 2 — DO NOT CREATE A FOLDER NOBODY ASKED FOR. This used to run on every
 * arriving asset, so a `Shared` folder appeared the first time any byte landed — and
 * since R1 the adoption then MOVES that file to the placement its index row names,
 * leaving an empty folder behind for good. An empty folder the user did not make is
 * noise, and the standard is to create a location only when something goes in it.
 *
 * So: reuse one if it is already there, and otherwise create it ONLY when this asset
 * genuinely has nowhere else to go — which is the pre-R1 case that still exists (a node
 * texture, a hand model, a pack push: bytes the project uses that no shared index row
 * mentions).
 * @param {boolean} create may we mint it?
 */
function sharedFolderId(create) {
	const existing = get(explorerFolders).find((f) => f.name === 'Shared' && !f.parentId);
	if (existing) return existing.id;
	return create ? (createFolder('Shared', null)?.id ?? null) : null;
}

/**
 * Where should arriving bytes land? The shared index has the answer whenever the file is
 * one somebody shared: its row names a folder, and that folder has already been adopted
 * (folder rows are applied before item rows). Only bytes with NO row fall back.
 *
 * Read through the store rather than importing sharedLibrary: that module imports THIS
 * one, and the row we need is a plain lookup in a document we can already see.
 * @param {string} hash @returns {string | null}
 */
function destinationFor(hash) {
	/** @type {any} */
	const doc = get(projectManifest);
	const row = (doc?.items ?? []).find((/** @type {any} */ r) => r?.hash === hash);
	if (row) {
		const folder = row.folderId
			? get(explorerFolders).find((f) => f.id === row.folderId)
			: null;
		// the row's own folder when we have it, else the library ROOT — never a `Shared`
		// folder, because a shared file has a home the project agrees on
		return folder?.id ?? null;
	}
	return sharedFolderId(true);
}

/** Push an item's bytes to every peer @param {string} hash */
export async function sendAsset(hash) {
	const item = itemByHash(hash);
	/** @type {any} */
	const peer = get(peers);
	if (!item || !peer) return;
	const blob = await itemBlob(item.id);
	if (!blob) return;
	if (blob.size > MAX_SHARED_BYTES) {
		showToast(item.name + ' is over the 5 MB sharing limit — peers will not hear it');
		return;
	}
	peer.send({ type: 'assetfile', hash, name: item.name, buffer: await blob.arrayBuffer() });
}

/** @type {Set<string>} hashes already asked for (one ask per session) */
const pendingRequests = new Set();

/** Pull missing bytes from the mesh, once per hash @param {string} hash */
export function requestAsset(hash) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer || !hash || pendingRequests.has(hash) || itemByHash(hash)) return;
	pendingRequests.add(hash);
	peer.send({ type: 'getasset', hash });
}

/** Receive pushed bytes -> Shared folder (content-hash dedup) @param {any} data */
export async function applyAssetFile(data) {
	if (!data?.hash || !data?.buffer) return;
	pendingRequests.delete(data.hash);
	if (itemByHash(data.hash)) return;
	// binarypack may deliver a typed-array VIEW into a larger buffer — slice
	// the exact bytes or the content hash comes out wrong
	const raw = data.buffer;
	const buffer =
		raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	await addItemFromBytes(buffer, data.name ?? 'shared-asset', destinationFor(data.hash));
}

/**
 * Answer a peer's pull. Replies over OUR stable outgoing connection to that
 * peer (the incoming conn a request arrives on can be a stale duplicate from
 * the connect dance — sendAnnotations pattern).
 * @param {string} peerId @param {any} data
 */
export async function answerAssetRequest(peerId, data) {
	const item = itemByHash(data?.hash);
	if (!item) return; // another peer may hold it
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return;
	const blob = await itemBlob(item.id);
	if (!blob || blob.size > MAX_SHARED_BYTES) return;
	conn.send({ type: 'assetfile', hash: item.hash, name: item.name, buffer: await blob.arrayBuffer() });
}

// ---- R22 round 2: THUMBNAILS TRAVEL --------------------------------------------
//
// THE REPORT: a shared file shows an icon until you download it, and only then grows a
// picture. Which is exactly what the code did — a thumbnail is DERIVED from the bytes by
// `writeItemNow`, and a peer that has no bytes has nothing to derive it from.
//
// Two ways to fix it and only one of them is cheap. Putting the thumbnail ON THE INDEX
// ROW would bloat a document that re-replicates in full on every share toggle: measured
// 2-6 KB per 128px webp dataURL, so a fifty-file library would put a quarter of a
// megabyte on the wire every time somebody pressed Share. That is the same reasoning
// `shaderTextures` used to refuse an embedded dataURL for a graph texture.
//
// So thumbnails ride their own tiny channel, addressed by the same content hash as the
// bytes: ONE new message type (`assetthumb`) plus an additive `thumb` flag on the
// existing `getasset`, which an older peer simply answers with the whole file — a
// correct, merely wasteful, degradation.
//
// The cache is LOCAL and idb-backed: a thumbnail is a derived picture, never project
// data, and re-deriving it after a reload would need bytes this peer does not have.

const THUMB_KEY = 'explorer:thumbs';
/** how many remote thumbnails to keep. A bound, not a policy — each is a few KB, and the
 * oldest are dropped first, which is right because the newest are what is on screen. */
const THUMB_CAP = 500;

/** hash -> dataURL, for files we do NOT hold. @type {import('svelte/store').Writable<Record<string, string>>} */
export const sharedThumbs = writable({});

let thumbsLoaded = false;
/** Load the cache once. Idempotent. */
export async function loadSharedThumbs() {
	if (thumbsLoaded || typeof indexedDB === 'undefined') return;
	thumbsLoaded = true;
	try {
		const stored = await idbGet(THUMB_KEY);
		if (stored && typeof stored === 'object') sharedThumbs.set(stored);
	} catch {}
}

let thumbSaveTimer = /** @type {any} */ (null);
function persistThumbs() {
	// debounced: a burst of arriving thumbnails is one write, not one write each
	clearTimeout(thumbSaveTimer);
	thumbSaveTimer = setTimeout(() => {
		try {
			void idbPut(THUMB_KEY, get(sharedThumbs));
		} catch {}
	}, 400);
}

/** @type {Set<string>} hashes whose thumbnail we have already asked for (one ask per session) */
const thumbAsked = new Set();

/**
 * Ask the mesh for the PICTURE of a hash, not the file. Safe to call per render — the
 * guard is the same one-ask-per-session rule `requestAsset` uses, so a grid of fifty
 * remote cards produces fifty requests once and none afterwards.
 * @param {string} hash
 */
export function requestAssetThumb(hash) {
	const h = String(hash ?? '').trim();
	if (!h || thumbAsked.has(h)) return;
	if (get(sharedThumbs)[h] || itemByHash(h)) return; // have the picture, or the file
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	thumbAsked.add(h);
	// `thumb` is ADDITIVE on the existing request: a peer on an older build ignores it
	// and answers with the whole file, which is wasteful and not wrong
	peer.send({ type: 'getasset', hash: h, thumb: true });
}

/**
 * Push the picture of an item we hold to every peer. Called when a file is SHARED, so a
 * peer's card has something to show before anybody asks — the push half of golden rule
 * 9, one payload size down.
 * @param {string} hash
 */
export function sendAssetThumb(hash) {
	const item = itemByHash(hash);
	/** @type {any} */
	const peer = get(peers);
	if (!item?.thumbnail || !peer) return;
	peer.send({ type: 'assetthumb', hash: item.hash, thumb: item.thumbnail });
}

/** Receive one. @param {any} data */
export function applyAssetThumb(data) {
	const hash = String(data?.hash ?? '').trim();
	const thumb = String(data?.thumb ?? '');
	// a dataURL and nothing else: this string goes straight into an <img src>, so anything
	// that is not an inline image is refused rather than rendered
	if (!hash || !thumb.startsWith('data:image/')) return;
	if (thumb.length > 200000) return; // a 128px webp is a few KB; this is not one
	sharedThumbs.update((map) => {
		if (map[hash] === thumb) return map;
		const next = { ...map, [hash]: thumb };
		const keys = Object.keys(next);
		if (keys.length > THUMB_CAP) for (const k of keys.slice(0, keys.length - THUMB_CAP)) delete next[k];
		return next;
	});
	persistThumbs();
}

/**
 * Answer a peer's thumbnail request over our stable outgoing connection (the
 * answerAssetRequest rule, verbatim — an incoming conn can be a stale duplicate).
 * @param {string} peerId @param {any} data
 */
export function answerAssetThumbRequest(peerId, data) {
	const item = itemByHash(data?.hash);
	if (!item?.thumbnail) return; // no picture to give; another peer may have one
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return;
	conn.send({ type: 'assetthumb', hash: item.hash, thumb: item.thumbnail });
}

/** Drop the cached picture for a hash we now hold the FILE for — the real item's own
 * thumbnail is better (it is the one this machine rendered) and keeping both means two
 * sources of truth for one card. @param {string} hash */
export function forgetSharedThumb(hash) {
	const h = String(hash ?? '').trim();
	if (!h) return;
	sharedThumbs.update((map) => {
		if (!(h in map)) return map;
		const next = { ...map };
		delete next[h];
		return next;
	});
	persistThumbs();
}
