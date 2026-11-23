// 105-noise — one worker of the noise pool (noiseRun.js). Two jobs: a BAND of a noise fill (rows y0..y1 of the
// image, over that band of the base) and SHRINK (the live preview's base, so a 2048 image is never resized on the
// page). Results go back transferred, never copied.
import { noiseRaster } from './noiseCore.js';
import { resizeRaster, fitSize } from './imageOps.js';

self.onmessage = (/** @type {MessageEvent} */ event) => {
	const msg = event.data ?? {};
	try {
		const t = performance.now();
		/** @type {{width: number, height: number, data: Uint8ClampedArray}} */
		let out;
		if (msg.op === 'shrink') {
			const fit = fitSize(msg.base.width, msg.base.height, msg.maxSide, msg.maxSide);
			out = fit.scale < 1 ? resizeRaster(msg.base, fit.width, fit.height) : msg.base;
		} else {
			out = noiseRaster(msg.options, { width: msg.width, height: msg.height, y0: msg.y0, y1: msg.y1, base: msg.base ?? null });
		}
		const ms = performance.now() - t;
		/** @type {any} */ (self).postMessage({ id: msg.id, width: out.width, height: out.height, data: out.data, ms }, [out.data.buffer]);
	} catch (error) {
		self.postMessage({ id: msg.id, error: String(/** @type {any} */ (error)?.message ?? error) });
	}
};
