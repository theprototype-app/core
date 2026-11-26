// 64-2d: encode an image LOSSLESSLY for pixel art — PNG, never webp/jpeg, and image smoothing OFF when it has to
// shrink (an integer step down, so a sheet's grid survives). Sprites go through this (materialsHandler's
// decodeTextureFile `lossless`): a webp re-encode smears every edge. A lazy leaf: only a sprite texture loads it.

/** the longest side a LOSSLESS (sprite) texture keeps — a 64-frame sheet of 32 px is 2048 */
export const SPRITE_TEXTURE_MAX_SIDE = 2048;

/** @param {File | Blob} file @param {number} [maxSize] @returns {Promise<string>} a PNG data URL */
export async function encodeLossless(file, maxSize = SPRITE_TEXTURE_MAX_SIDE) {
	const bitmap = await createImageBitmap(file);
	const side = Math.max(bitmap.width, bitmap.height);
	const div = side > maxSize ? Math.ceil(side / maxSize) : 1;
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.floor(bitmap.width / div));
	canvas.height = Math.max(1, Math.floor(bitmap.height / div));
	const ctx = canvas.getContext('2d');
	if (ctx) {
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	}
	bitmap.close?.();
	return canvas.toDataURL('image/png');
}
