// 40-image (F13) — PER-IMAGE VERSION HISTORY, a LEAF (svelte/store + idb only).
//
// An Explorer image is ONE record whose bytes a Save replaces in place (`replaceItemBytes`
// keeps the id, so every folder, share row and reference stays put). What a save would
// otherwise destroy is the bytes it replaced, so they land here first:
//
//   imgver:list:<itemId>          → [{hash, size, at, label, width, height, type, thumb}]
//   imgver:blob:<itemId>:<hash>   → the Blob
//
// THE FIRST ENTRY IS THE ORIGINAL and is never pruned, so "Restore original" always
// works however many edits follow; the rest keep the newest MAX_VERSIONS - 1. Blobs are
// keyed by item AND hash so two images that happen to share bytes never share a history
// entry — pruning one cannot reach into the other, and nothing needs reference counting.
//
// LOCAL BY DESIGN: the history is this device's record of its own edits. What reaches
// peers is the saved image itself — a shared file republishes its new hash and every
// texture made from it re-applies through the ordinary replicated `map` message.

import { writable } from 'svelte/store';
import { idbGet, idbPut, idbDelete } from '../idb';

const LIST = 'imgver:list:';
const BLOB = 'imgver:blob:';
/** how many versions one image keeps, the Original included */
export const MAX_VERSIONS = 20;

/**
 * @typedef {{hash: string, size: number, at: number, label: string, width?: number, height?: number, type?: string, thumb?: string | null}} ImageVersion
 */

/** bumped on every write, so a panel listing versions can re-read */
export const imageVersionsTick = writable(0);

/** @param {string} itemId @returns {Promise<ImageVersion[]>} oldest first, [0] = the original */
export async function listImageVersions(itemId) {
	const list = await idbGet(LIST + itemId);
	return Array.isArray(list) ? list : [];
}

/**
 * Remember `blob` as a version of this image. A hash already in the list is not added
 * twice (re-saving restored bytes, or saving with no change). The FIRST version recorded
 * is labelled Original whatever `meta.label` says.
 * @param {string} itemId @param {Blob} blob
 * @param {{hash: string, label?: string, width?: number, height?: number, thumb?: string | null}} meta
 * @returns {Promise<ImageVersion[]>} the list after the write
 */
export async function recordImageVersion(itemId, blob, meta) {
	const list = await listImageVersions(itemId);
	if (!meta?.hash || list.some((v) => v.hash === meta.hash)) return list;
	/** @type {ImageVersion} */
	const entry = {
		hash: meta.hash,
		size: blob.size,
		at: Date.now(),
		label: list.length ? meta.label || 'Edit' : 'Original',
		...(meta.width ? { width: meta.width, height: meta.height } : {}),
		...(blob.type ? { type: blob.type } : {}),
		thumb: meta.thumb ?? null
	};
	await idbPut(BLOB + itemId + ':' + meta.hash, blob);
	const next = [...list, entry];
	// keep the original, drop the oldest edits beyond the cap
	while (next.length > MAX_VERSIONS) {
		const [gone] = next.splice(1, 1);
		await idbDelete(BLOB + itemId + ':' + gone.hash);
	}
	await idbPut(LIST + itemId, next);
	imageVersionsTick.update((n) => n + 1);
	return next;
}

/** @param {string} itemId @param {string} hash @returns {Promise<Blob | null>} */
export async function imageVersionBlob(itemId, hash) {
	return (await idbGet(BLOB + itemId + ':' + hash)) ?? null;
}

/** Drop one image's whole history (bytes included). @param {string} itemId */
export async function forgetImageVersions(itemId) {
	const list = await listImageVersions(itemId);
	for (const v of list) await idbDelete(BLOB + itemId + ':' + v.hash);
	await idbDelete(LIST + itemId);
	imageVersionsTick.update((n) => n + 1);
}

/** Is this idb key one of ours? (the storage breakdown classifies by prefix) @param {string} key */
export function isImageVersionKey(key) {
	return String(key).startsWith(LIST) || String(key).startsWith(BLOB);
}
