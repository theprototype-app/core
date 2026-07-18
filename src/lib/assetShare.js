import { get } from 'svelte/store';
import { peers, showToast } from '../stores/appStore';
import { explorerFolders, itemBlob, itemByHash, addItemFromBytes, createFolder } from './explorer';

// Shared assets (97): the Explorer library is local, but any file a node USES
// is shared — bytes travel keyed by content hash, PUSHED once on assign and
// PULLED on demand by any peer missing the hash (late joiners, autosave
// restores, session loads). Received files land in the receiver's Explorer
// under a built-in 'Shared' folder so they are visible and reusable.

export const MAX_SHARED_BYTES = 5 * 1024 * 1024;

function sharedFolderId() {
	const existing = get(explorerFolders).find((f) => f.name === 'Shared' && !f.parentId);
	if (existing) return existing.id;
	return createFolder('Shared', null)?.id ?? null;
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
	await addItemFromBytes(buffer, data.name ?? 'shared-asset', sharedFolderId());
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
