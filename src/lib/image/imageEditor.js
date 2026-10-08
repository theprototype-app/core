// 40-image (F13) — THE IMAGE EDITOR'S SIDE EFFECTS: opening it, decoding and encoding,
// and what Save / Save as copy / Restore do to the library, the history and the scene.
// The pixel maths is `imageOps.js` (a leaf) and the window is `ImageEditorWindow.svelte`.
//
// WHAT A SAVE IS: the SAME Explorer record with new bytes (`replaceItemBytes`) — its id,
// folder, share flags and every reference stay put, and a shared file republishes its
// new hash through the library's own sweep (the 24-C2 rule that made a text edit to a
// shared file reach peers). Before the bytes are replaced, the outgoing ones are
// recorded as a version, so nothing a save does is unrecoverable.
//
// WHAT A SAVE DOES TO THE SCENE: every material slot whose texture was made from this
// image (`userData.mapSource` = its old hash) is re-textured from the new bytes through
// `setObjectsTexture` — the replicated `map` message, one history entry per slot, ONE undo
// step for the whole save. A texture that was painted over or picked from disk carries no
// source and is left alone: it is no longer that image.

import { writable, get } from 'svelte/store';
import {
	itemById,
	itemBlob,
	replaceItemBytes,
	addItemFromBytes,
	hashBytes,
	nextCopyName,
	explorerItems,
	itemByHash
} from '../explorer';
import { setObjectsTexture, texturesFromSource, linkTextureSource, materialAt } from '../materialsHandler';
import { beginHistoryBatch, endHistoryBatch } from '../history';
import { withWireBatchAsync } from '../wireBatch';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { recordImageVersion, imageVersionBlob } from './imageVersions';
import { makeRaster, fitSize, encodingFor } from './imageOps';

/**
 * The open editor: which Explorer image, plus a `raise` counter so asking again for the
 * same image brings the window forward instead of reloading it (the 21-I3 ruling the
 * preview window keeps). null = closed.
 * @type {import('svelte/store').Writable<{itemId: string, raise: number} | null>}
 */
export const imageEditorTarget = writable(null);

/** Open the Image editor on an Explorer image. @param {string} itemId */
export function openImageEditor(itemId) {
	const item = itemById(itemId);
	if (!item || item.kind !== 'image') {
		showToast('Only an image can be edited here');
		return false;
	}
	const now = get(imageEditorTarget);
	imageEditorTarget.set({ itemId: item.id, raise: (now?.raise ?? 0) + 1 });
	return true;
}

export function closeImageEditor() {
	imageEditorTarget.set(null);
}

/**
 * Edit the texture on one material slot. A texture made from a library image opens that
 * image; one that came from anywhere else (picked from disk, an imported model, a paint
 * stroke) is first put into the library as "<object> texture.webp" and LINKED, so saving
 * it updates the material like any other.
 * @param {string} uuid @param {number} [slot]
 */
export async function editMaterialTexture(uuid, slot = 0) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const material = materialAt(object, slot);
	const url = material?.userData?.mapDataUrl;
	if (!material || !url) {
		showToast('That material has no texture to edit');
		return false;
	}
	const source = material.userData.mapSource;
	const held = source ? itemByHash(source) : null;
	if (held && held.kind === 'image') return openImageEditor(held.id);
	const blob = await (await fetch(url)).blob();
	const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/png' ? 'png' : 'webp';
	const base = String(object?.name || 'Object').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Object';
	const record = await addItemFromBytes(await blob.arrayBuffer(), `${base} texture.${ext}`, null, { imported: true });
	if (!record) return false;
	linkTextureSource(uuid, slot, record.hash);
	pokeScene();
	return openImageEditor(record.id);
}

// ---- decode / encode --------------------------------------------------------------

/** Decode an image blob into a raster (alpha kept, colours un-premultiplied).
 * @param {Blob} blob @returns {Promise<import('./imageOps').Raster>} */
export async function decodeImage(blob) {
	const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('no 2d context');
		ctx.drawImage(bitmap, 0, 0);
		const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		return makeRaster(data.width, data.height, data.data);
	} finally {
		bitmap.close?.();
	}
}

/** A canvas showing this raster. @param {import('./imageOps').Raster} raster */
export function rasterCanvas(raster) {
	const canvas = document.createElement('canvas');
	canvas.width = raster.width;
	canvas.height = raster.height;
	const ctx = canvas.getContext('2d');
	ctx?.putImageData(new ImageData(/** @type {Uint8ClampedArray<ArrayBuffer>} */ (raster.data), raster.width, raster.height), 0, 0);
	return canvas;
}

/** Encode a raster in a file format. @param {import('./imageOps').Raster} raster
 * @param {{type: string, quality?: number}} encoding @returns {Promise<Blob>} */
export function encodeImage(raster, encoding) {
	const canvas = rasterCanvas(raster);
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), encoding.type, encoding.quality)
	);
}

/** A small preview dataURL for a version row. @param {import('./imageOps').Raster} raster */
export function thumbOf(raster) {
	const fit = fitSize(raster.width, raster.height, 96, 96);
	const canvas = document.createElement('canvas');
	canvas.width = fit.width;
	canvas.height = fit.height;
	canvas.getContext('2d')?.drawImage(rasterCanvas(raster), 0, 0, fit.width, fit.height);
	return canvas.toDataURL('image/webp', 0.7);
}

/** @param {Blob} blob */
async function thumbOfBlob(blob) {
	try {
		const raster = await decodeImage(blob);
		return { thumb: thumbOf(raster), width: raster.width, height: raster.height };
	} catch {
		return { thumb: null, width: undefined, height: undefined };
	}
}

// ---- save / copy / restore ----------------------------------------------------------

/**
 * Re-texture every material slot made from `oldHash` with `blob` (now `newHash`), as ONE
 * undo step and one wire batch. @param {string} oldHash @param {Blob} blob @param {string} newHash
 * @returns {Promise<number>} how many slots changed
 */
export async function retextureFromSource(oldHash, blob, newHash) {
	const users = texturesFromSource(oldHash);
	if (!users.length || oldHash === newHash) return 0;
	/** @type {Map<number, string[]>} */
	const bySlot = new Map();
	for (const { uuid, slot } of users) bySlot.set(slot, [...(bySlot.get(slot) ?? []), uuid]);
	let changed = 0;
	beginHistoryBatch();
	try {
		await withWireBatchAsync(async () => {
			for (const [slot, uuids] of bySlot) changed += await setObjectsTexture(uuids, blob, slot, { source: newHash });
		});
	} finally {
		endHistoryBatch(`Update texture (${changed})`);
	}
	pokeScene();
	return changed;
}

/**
 * Replace an image's bytes, keeping both the old and the new state in its history, and
 * carry the change into every texture made from it.
 * @param {string} itemId @param {Blob} blob @param {{label?: string, raster?: import('./imageOps').Raster}} [opts]
 * @returns {Promise<{record: any, textures: number} | null>}
 */
export async function saveImage(itemId, blob, opts = {}) {
	const record = itemById(itemId);
	if (!record) return null;
	const oldHash = record.hash;
	const old = await itemBlob(record.id);
	// the outgoing bytes first: this is the step that makes every later one undoable
	if (old) await recordImageVersion(record.id, old, { hash: oldHash, ...(await thumbOfBlob(old)) });
	const buffer = await blob.arrayBuffer();
	const newHash = await hashBytes(buffer);
	if (newHash === oldHash) return { record, textures: 0 };
	const updated = await replaceItemBytes(record.id, buffer, { type: blob.type });
	const meta = opts.raster
		? { thumb: thumbOf(opts.raster), width: opts.raster.width, height: opts.raster.height }
		: await thumbOfBlob(blob);
	await recordImageVersion(record.id, blob, { hash: newHash, label: opts.label ?? 'Edit', ...meta });
	const textures = await retextureFromSource(oldHash, blob, newHash);
	return { record: updated, textures };
}

/**
 * Put an earlier version back. It is a save like any other (the current bytes are already
 * in the history), so it is itself restorable and it re-textures the scene.
 * @param {string} itemId @param {string} hash
 */
export async function restoreImageVersion(itemId, hash) {
	const blob = await imageVersionBlob(itemId, hash);
	if (!blob) {
		showToast('That version is no longer on this device');
		return null;
	}
	return saveImage(itemId, blob);
}

/**
 * Save the edit as a NEW library image beside the original ("Brick copy.png"), leaving the
 * original and every texture made from it untouched.
 * @param {string} itemId @param {Blob} blob @param {string} [name]
 */
export async function saveImageCopy(itemId, blob, name) {
	const record = itemById(itemId);
	if (!record) return null;
	const siblings = get(explorerItems)
		.filter((item) => (item.folderId ?? null) === (record.folderId ?? null))
		.map((item) => item.name);
	const wanted = encodingFor(name || record.name, blob.type).name;
	const copyName = nextCopyName(wanted, siblings);
	return addItemFromBytes(await blob.arrayBuffer(), copyName, record.folderId ?? null, { allowDuplicate: true, type: blob.type });
}
