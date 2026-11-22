// Roadmap 56 C8 — PICTURES IN THE CHAT, the browser half: every way a picture gets into the composer
// (a file, the phone camera, paste, a drop, an Explorer image, the viewport, the selection) ends in
// `prepareImage`, which DOWNSCALES and RE-ENCODES on this device and STRIPS metadata (attachCore.js)
// before anything can be sent. Viewers never attach (the composer hides the button; the store and the
// agent page refuse too).

import { get, writable } from 'svelte/store';
import { rolesInfo } from '../cloudHooks';
import { safeStorage } from '../safeStorage';
import { MAX_ATTACH_BYTES, MAX_ATTACHMENTS, encodePlan, stripMetadata, sniffType, toBase64, attachName, metadataOf } from './attachCore.js';

/** what the last prepare did, for the suites (sizes, metadata before/after) @type {import('svelte/store').Writable<any>} */
export const lastPrepare = writable(null);
/** the composer's tray, mirrored for the suites (ChatAttach owns the array) @type {import('svelte/store').Writable<any[]>} */
export const composerPending = writable([]);

/** C8: "Keep sent pictures in Explorer" — the default for Keep in Explorer (LOCAL, off) */
export const keepSentPictures = writable(safeStorage.getItem('chat:keepSentPictures') === 'true');
keepSentPictures.subscribe((on) => {
	try {
		safeStorage.setItem('chat:keepSentPictures', String(on));
	} catch {
		/* storage off: the setting lasts this session */
	}
});
/** settings search (I4) */
export const keywords = ['picture', 'photo', 'image', 'attach', 'chat', 'references', 'exif', 'gps', 'location'];

/** @returns {boolean} */
export function canAttach() {
	/** @type {any} */
	const info = get(rolesInfo);
	return info?.myRole !== 'viewer';
}

/** @param {HTMLCanvasElement} canvas @param {string} type @param {number} q @returns {Promise<Blob | null>} */
function encode(canvas, type, q) {
	return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q));
}

/** WebP where the browser can WRITE it (Safari cannot: its toBlob silently returns PNG), else JPEG */
let webpWrites = /** @type {boolean | null} */ (null);
function outputType() {
	if (webpWrites === null) {
		try {
			const c = document.createElement('canvas');
			c.width = c.height = 1;
			webpWrites = c.toDataURL('image/webp').startsWith('data:image/webp');
		} catch {
			webpWrites = false;
		}
	}
	return webpWrites ? 'image/webp' : 'image/jpeg';
}

/**
 * One picture, ready for the wire: `{mimeType, data (base64, no prefix), name, w, h, bytes}`, or
 * `{error}`. Orientation is applied from the EXIF (createImageBitmap 'from-image') BEFORE the
 * metadata is dropped, so a portrait phone photo stays upright.
 * @param {Blob} blob @param {string} [name]
 * @param {{maxBytes?: number, maxEdge?: number, type?: string}} [opts] `type` pins the output format
 * @returns {Promise<{mimeType: string, data: string, name: string, w: number, h: number, bytes: number} | {error: string}>}
 */
export async function prepareImage(blob, name = '', opts = {}) {
	const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
	let source = blob;
	let type = sniffType(head) || String(blob.type || '');
	if (type === 'image/heic' || /\.hei[cf]$/i.test(name)) {
		const { heicToJpegFile } = await import('../heic.js');
		/** @type {string} */
		let why = '';
		const out = await heicToJpegFile(/** @type {any} */ (blob), { onError: (m) => (why = m) });
		if (!out) return { error: why || 'Could not read this HEIC photo' };
		source = out;
		type = 'image/jpeg';
	}
	if (!type.startsWith('image/')) return { error: (name || 'That file') + ' is not a picture' };
	/** @type {ImageBitmap} */
	let bitmap;
	try {
		bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
	} catch {
		return { error: 'Could not read ' + (name || 'this picture') };
	}
	const before = metadataOf(new Uint8Array(await blob.slice(0, Math.min(blob.size, 256 * 1024)).arrayBuffer()));
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	if (!ctx) return { error: 'This browser cannot draw pictures' };
	const outType = opts.type ?? outputType();
	const maxBytes = opts.maxBytes ?? MAX_ATTACH_BYTES;
	/** @type {Uint8Array | null} */
	let bytes = null;
	let size = { w: 1, h: 1 };
	for (const step of encodePlan(bitmap.width, bitmap.height, opts.maxEdge)) {
		if (canvas.width !== step.w || canvas.height !== step.h) {
			canvas.width = step.w;
			canvas.height = step.h;
			ctx.clearRect(0, 0, step.w, step.h);
			if (outType === 'image/jpeg') {
				// JPEG has no alpha: a transparent screenshot would turn black
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, step.w, step.h);
			}
			ctx.drawImage(bitmap, 0, 0, step.w, step.h);
		}
		const out = await encode(canvas, outType, step.quality);
		if (!out) continue;
		bytes = new Uint8Array(await out.arrayBuffer());
		size = { w: step.w, h: step.h };
		if (bytes.length <= maxBytes) break;
	}
	bitmap.close?.();
	if (!bytes) return { error: 'Could not encode ' + (name || 'this picture') };
	const realType = sniffType(bytes) || outType;
	const clean = stripMetadata(bytes, realType);
	lastPrepare.set({ name, inBytes: blob.size, inMeta: before, outBytes: clean.length, outMeta: metadataOf(clean), w: size.w, h: size.h, type: realType });
	return { mimeType: realType, data: toBase64(clean), name: attachName(name, realType), w: size.w, h: size.h, bytes: clean.length };
}

/**
 * Several files (a picker, a drop, a paste) up to the per-message room left. Non-pictures and
 * failures come back as `errors`.
 * @param {Iterable<Blob & {name?: string}>} files @param {number} [room]
 */
export async function prepareFiles(files, room = MAX_ATTACHMENTS) {
	/** @type {any[]} */
	const ready = [];
	/** @type {string[]} */
	const errors = [];
	let skipped = 0;
	for (const f of files) {
		if (ready.length >= room) {
			skipped++;
			continue;
		}
		const r = await prepareImage(f, f.name ?? '');
		if ('error' in r) errors.push(r.error);
		else ready.push(r);
	}
	if (skipped) errors.push(`At most ${MAX_ATTACHMENTS} pictures per message — ${skipped} left out`);
	return { ready, errors };
}

/** @param {string} dataUrl */
async function dataUrlBlob(dataUrl) {
	return (await fetch(dataUrl)).blob();
}

/** Roadmap 73 AI2: the same picture as JPEG, the one format every vision provider reads (Grok refuses
 * WebP). Through prepareImage again, so the metadata rule holds for this output too.
 * @param {{mimeType: string, data: string, name?: string}} image */
export async function asJpeg(image) {
	if (image.mimeType === 'image/jpeg') return image;
	const r = await prepareImage(await dataUrlBlob('data:' + image.mimeType + ';base64,' + image.data), image.name ?? '', { type: 'image/jpeg' });
	return 'error' in r ? image : r;
}

/** C8 "Viewport screenshot": what you are looking at, at the chat's size */
/** @param {{maxBytes?: number, maxEdge?: number, type?: string}} [opts] */
export async function viewportPicture(opts) {
	const { viewportThumbnail } = await import('../sessions');
	const url = viewportThumbnail(2048);
	if (!url) return { error: 'No viewport to capture (in VR, take the headset off first)' };
	return prepareImage(await dataUrlBlob(url), 'viewport', opts);
}

/**
 * C8 "Selection — ask about this": the selected object framed on its own (no gizmos or helpers),
 * plus a line naming it so the agent knows WHICH object the picture is of.
 * @returns {Promise<{image?: any, text?: string, error?: string}>}
 */
export async function selectionPicture() {
	const { selectedObjects, objectsGroup } = await import('../../stores/sceneStore');
	/** @type {any} */
	const sel = get(selectedObjects);
	const uuids = (Array.isArray(sel) ? sel : sel instanceof Set ? [...sel] : []).map((/** @type {any} */ o) => (typeof o === 'string' ? o : o?.uuid)).filter(Boolean);
	if (!uuids.length) return { error: 'Select an object first' };
	/** @type {any} */
	const group = get(objectsGroup);
	const objects = uuids.map((/** @type {string} */ u) => group?.getObjectByProperty?.('uuid', u)).filter(Boolean);
	const { takeScreenshot } = await import('../agent/screenshot.js');
	const url = await takeScreenshot(/** @type {any} */ ({ view: 'focus', uuid: uuids[0], size: 1568, quiet: true }));
	if (!url) return { error: 'Could not capture the selection' };
	const names = objects.map((/** @type {any} */ o) => `"${o.name || o.type}" (${o.uuid})`).join(', ');
	const image = await prepareImage(await dataUrlBlob(url), 'selection-' + (objects[0]?.name || 'object'));
	if ('error' in image) return { error: image.error };
	return { image, text: 'About the selected object' + (objects.length > 1 ? 's' : '') + ' ' + names + ': ' };
}

/** an Explorer image item (a drag from the Explorer, or the + menu's From Explorer)
 * @param {string} itemId @param {{maxBytes?: number, maxEdge?: number, type?: string}} [opts] */
export async function explorerPicture(itemId, opts) {
	const explorer = await import('../explorer');
	const item = explorer.itemById(itemId);
	if (!item || item.kind !== 'image') return { error: 'That Explorer file is not a picture' };
	const blob = await explorer.itemBlob(item.id);
	if (!blob) return { error: item.name + ' has no bytes on this device yet' };
	return prepareImage(blob, item.name, opts);
}
