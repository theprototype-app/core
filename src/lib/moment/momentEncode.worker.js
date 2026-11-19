// 95 SM1 — the moment buffer's JPEG encoder, OFF the main thread. The main thread hands over an
// ImageBitmap of the game view (already scaled to the kept size by createImageBitmap) and gets a
// JPEG blob back, in order. One OffscreenCanvas, reused.
/** @type {OffscreenCanvas | null} */
let canvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let ctx = null;

self.onmessage = async (/** @type {MessageEvent} */ e) => {
	const { id, bitmap, w, h, quality } = e.data || {};
	try {
		if (!canvas || canvas.width !== w || canvas.height !== h) {
			canvas = new OffscreenCanvas(w, h);
			ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false }));
		}
		/** @type {OffscreenCanvasRenderingContext2D} */ (ctx).drawImage(bitmap, 0, 0, w, h);
		bitmap.close?.();
		const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
		self.postMessage({ id, blob });
	} catch (err) {
		try {
			bitmap?.close?.();
		} catch {
			/* already gone */
		}
		self.postMessage({ id, error: String(/** @type {any} */ (err)?.message || err) });
	}
};
