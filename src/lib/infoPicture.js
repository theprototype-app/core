// 102b-play: a note's picture from a file — split from infoPoints.js so the editor boot and the
// play app never carry it (the note card imports it when someone adds a picture).
import { normalizePicture, PICTURE_MAX_SIDE } from './infoPoints.js';

/**
 * Shrink an image file into a data URL the boundary accepts (browser only). Longest side
 * PICTURE_MAX_SIDE, JPEG at falling quality until it fits; null when it cannot be read or fit.
 * @param {Blob} file @returns {Promise<string | null>}
 */
export async function pictureFromFile(file) {
	if (!file || !/^image\//.test(file.type || '')) return null;
	/** @type {ImageBitmap | null} */
	let bitmap = null;
	try {
		bitmap = await createImageBitmap(file);
		const scale = Math.min(1, PICTURE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, w, h);
		for (const quality of [0.85, 0.72, 0.6, 0.45]) {
			const url = normalizePicture(canvas.toDataURL('image/jpeg', quality));
			if (url) return url;
		}
		return null;
	} catch {
		return null;
	} finally {
		bitmap?.close?.();
	}
}
