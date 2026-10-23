// 65 M4/M7 — THE ENCODERS of the frame-exact export: one SINK per format, all with the same shape so
// the render loop (offlineRender.js) does not care what it is writing.
//
//   add(canvas, i)  CAPTURES SYNCHRONOUSLY (the canvas is reused for the next frame the moment this
//                   returns) and queues the slow part; errors are kept, never thrown at the render loop
//   pending()       frames still being worked on — the loop holds the next frame while this is at
//                   `limit` (backpressure: memory stays flat however slow the encoder is)
//   finish()        the file
//   cancel()        drop everything
//
// Every library is a DYNAMIC import, so none of them reaches the boot graph: Mediabunny (MPL-2.0,
// used unmodified) muxes WebCodecs' output into MP4/WebM, gifenc (MIT) writes GIFs, fflate zips.
import { frameDurations } from './frameClock.js';
import { codecCandidates, STILL_QUALITY } from './videoExportCore.js';
import { bitrateFor } from './recordingCore.js';
import { muxAnimatedWebp } from './webpAnim.js';

/**
 * @typedef {{bytes: Uint8Array, mime: string, ext: string, extra?: any}} SinkResult
 * @typedef {{limit: number, pending: () => number, add: (canvas: HTMLCanvasElement, i: number) => void,
 *   finish: () => Promise<SinkResult>, cancel: () => void, error: () => Error | null, label: string}} Sink
 * @typedef {{format: string, size: {w: number, h: number}, fps: number, frames: number, quality: string,
 *   alpha: boolean, name: string, hero?: any}} SinkOptions
 */

/** @param {any} e */
const asError = (e) => (e instanceof Error ? e : new Error(String(e)));

/** A canvas still as bytes. toBlob snapshots the canvas when CALLED, so this captures synchronously.
 * @param {HTMLCanvasElement} canvas @param {string} type @param {number} [quality] @returns {Promise<Blob>} */
function still(canvas, type, quality) {
	return new Promise((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode ' + type))), type, quality)
	);
}

/** Does this browser really encode WebP (Safari hands back a PNG instead)? */
export function canEncodeWebp() {
	try {
		const c = document.createElement('canvas');
		c.width = c.height = 2;
		return c.toDataURL('image/webp').startsWith('data:image/webp');
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------- MP4 / WebM ---- */

/**
 * WebCodecs through Mediabunny. One frame in flight: `CanvasSource.add` resolves when the encoder
 * can take the next one, which is exactly the backpressure the loop wants.
 * @param {HTMLCanvasElement} canvas the output canvas the loop draws each frame into
 * @param {SinkOptions} o @returns {Promise<Sink>}
 */
async function videoSink(canvas, o) {
	const mb = await import('mediabunny');
	const bitrate = bitrateFor(o.size, o.fps, o.quality);
	const codec = await mb.getFirstEncodableVideoCodec(codecCandidates(o.format), { width: o.size.w, height: o.size.h, bitrate });
	if (!codec) throw new Error(`This browser cannot encode ${o.format.toUpperCase()} video at ${o.size.w} × ${o.size.h}. Try WebM, or a smaller size.`);
	const target = new mb.BufferTarget();
	const output = new mb.Output({
		format: o.format === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
		target
	});
	const source = new mb.CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
	output.addVideoTrack(source, { frameRate: o.fps });
	await output.start();
	let pending = 0;
	/** @type {Error | null} */
	let err = null;
	/** @type {Promise<void>} */
	let last = Promise.resolve();
	return {
		label: `${o.format.toUpperCase()} (${codec})`,
		limit: 1,
		pending: () => pending,
		error: () => err,
		add(_c, i) {
			pending++;
			// the sample is taken from the canvas inside add(), before it awaits anything
			last = source.add(i / o.fps, 1 / o.fps).then(
				() => {
					pending--;
				},
				(e) => {
					pending--;
					err = asError(e);
				}
			);
		},
		async finish() {
			await last;
			if (err) throw err;
			await output.finalize();
			const buffer = /** @type {ArrayBuffer} */ (target.buffer);
			return { bytes: new Uint8Array(buffer), mime: o.format === 'webm' ? 'video/webm' : 'video/mp4', ext: o.format, extra: { codec } };
		},
		cancel() {
			void output.cancel().catch(() => {});
		}
	};
}

/* ------------------------------------------------------------------- GIF ---- */

/**
 * gifenc, a palette per frame (a turntable's colours change as it turns). Delays are the cumulative
 * centiseconds (frameDurations), handed over ×10 because gifenc takes milliseconds and divides.
 * @param {SinkOptions} o @returns {Promise<Sink>}
 */
async function gifSink(o) {
	const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
	const gif = GIFEncoder();
	const delays = frameDurations(o.frames, o.fps, 100);
	/** @type {{i: number, data: Uint8ClampedArray}[]} */
	const queue = [];
	let busy = false;
	/** @type {Error | null} */
	let err = null;
	let cancelled = false;
	/** @type {(() => void) | null} */
	let drained = null;
	function pump() {
		if (busy || cancelled) return;
		const job = queue.shift();
		if (!job) {
			drained?.();
			return;
		}
		busy = true;
		// a task per frame, so the progress bar keeps painting between frames
		setTimeout(() => {
			try {
				const palette = quantize(job.data, 256, { format: 'rgb565' });
				const index = applyPalette(job.data, palette, 'rgb565');
				gif.writeFrame(index, o.size.w, o.size.h, { palette, delay: delays[job.i] * 10, repeat: 0 });
			} catch (e) {
				err = asError(e);
			}
			busy = false;
			pump();
		}, 0);
	}
	return {
		label: 'GIF',
		limit: 2,
		pending: () => queue.length + (busy ? 1 : 0),
		error: () => err,
		add(canvas, i) {
			const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
			queue.push({ i, data: ctx.getImageData(0, 0, o.size.w, o.size.h).data });
			pump();
		},
		async finish() {
			if (queue.length || busy) await new Promise((r) => (drained = () => r(undefined)));
			if (err) throw err;
			gif.finish();
			return { bytes: gif.bytes(), mime: 'image/gif', ext: 'gif' };
		},
		cancel() {
			cancelled = true;
			queue.length = 0;
		}
	};
}

/* --------------------------------------------- stills: WebP, PNG, website ---- */

/**
 * Collect one still per frame (in order, whatever order the encodes finish in).
 * @param {string} type @param {number | undefined} quality @param {number} frames
 */
function stillsCollector(type, quality, frames) {
	/** @type {(Uint8Array | null)[]} */
	const stills = new Array(frames).fill(null);
	let pending = 0;
	/** @type {Error | null} */
	let err = null;
	/** @type {(() => void) | null} */
	let drained = null;
	return {
		stills,
		pending: () => pending,
		error: () => err,
		/** @param {HTMLCanvasElement} canvas @param {number} i */
		add(canvas, i) {
			pending++;
			still(canvas, type, quality)
				.then(async (b) => {
					if (b.type !== type) throw new Error(`the browser wrote ${b.type || 'nothing'} instead of ${type}`);
					stills[i] = new Uint8Array(await b.arrayBuffer());
				})
				.catch((e) => (err = asError(e)))
				.finally(() => {
					pending--;
					if (!pending) drained?.();
				});
		},
		async drain() {
			if (pending) await new Promise((r) => (drained = () => r(undefined)));
			if (err) throw err;
			if (stills.some((s) => !s)) throw new Error('a frame is missing');
			return /** @type {Uint8Array[]} */ (stills);
		}
	};
}

/** @param {SinkOptions} o @returns {Sink} */
function webpSink(o) {
	const c = stillsCollector('image/webp', o.alpha ? STILL_QUALITY.high : /** @type {any} */ (STILL_QUALITY)[o.quality], o.frames);
	return {
		label: 'Animated WebP',
		limit: 4,
		pending: c.pending,
		error: c.error,
		add: c.add,
		async finish() {
			const stills = await c.drain();
			const bytes = muxAnimatedWebp(stills, { width: o.size.w, height: o.size.h, durationsMs: frameDurations(o.frames, o.fps, 1000) });
			return { bytes, mime: 'image/webp', ext: 'webp' };
		},
		cancel() {}
	};
}

/** @param {number} i @param {number} n */
const frameName = (i, n) => 'frame_' + String(i).padStart(Math.max(5, String(n - 1).length), '0') + '.png';

/** @param {SinkOptions} o @returns {Sink} */
function pngSink(o) {
	const c = stillsCollector('image/png', undefined, o.frames);
	return {
		label: 'PNG sequence',
		limit: 4,
		pending: c.pending,
		error: c.error,
		add: c.add,
		async finish() {
			const stills = await c.drain();
			const { zipSync } = await import('fflate');
			/** @type {Record<string, [Uint8Array, {level: 0}]>} */
			const files = {};
			const dir = o.name.replace(/\.[^.]+$/, '');
			// PNG is already deflated: store, do not compress twice
			stills.forEach((s, i) => (files[`${dir}/${frameName(i, stills.length)}`] = [s, { level: 0 }]));
			return { bytes: zipSync(files), mime: 'application/zip', ext: 'zip', extra: { files: stills.length } };
		},
		cancel() {}
	};
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
	return btoa(s);
}

/**
 * The website section: WebP stills (JPEG where WebP cannot be encoded), wrapped with the bundled
 * runtime into one script; the zip holds the script, a demo page and the size report.
 * @param {SinkOptions} o @returns {Sink}
 */
function heroSink(o) {
	const webp = canEncodeWebp();
	const type = webp ? 'image/webp' : 'image/jpeg';
	const c = stillsCollector(type, /** @type {any} */ (STILL_QUALITY)[o.quality], o.frames);
	return {
		label: 'Website section',
		limit: 4,
		pending: c.pending,
		error: c.error,
		add: c.add,
		async finish() {
			const stills = await c.drain();
			const [{ default: runtime }, core, { zipSync, gzipSync, strToU8 }, { formatBytes }] = await Promise.all([
				import('virtual:tp-hero-runtime'),
				import('./heroCore.js'),
				import('fflate'),
				import('./videoExportCore.js')
			]);
			const h = o.hero;
			const id = core.heroId(h.title);
			const file = id + '.js';
			const data = core.heroData({
				id,
				label: h.label,
				w: o.size.w,
				h: o.size.h,
				fps: o.fps,
				duration: o.frames / o.fps,
				trigger: h.trigger,
				ease: h.ease,
				smooth: h.smooth,
				fit: h.fit,
				mime: type,
				frames: stills.map(base64)
			});
			const script = core.heroScript(runtime, data);
			const scriptBytes = strToU8(script);
			const report = core.heroSizeReport({
				frameBytes: stills.map((s) => s.length),
				runtimeBytes: runtime.length,
				scriptBytes: scriptBytes.length,
				gzipBytes: gzipSync(scriptBytes, { level: 6 }).length
			});
			const snippet = core.heroSnippet(id, file, { w: o.size.w, h: o.size.h, label: h.label, trigger: h.trigger });
			const page = core.heroDemoPage(id, file, { w: o.size.w, h: o.size.h, label: h.label, trigger: h.trigger, title: h.title });
			const dir = o.name.replace(/\.[^.]+$/, '');
			const bytes = zipSync({
				[`${dir}/index.html`]: strToU8(page),
				[`${dir}/${file}`]: scriptBytes,
				[`${dir}/size-report.txt`]: strToU8(core.heroSizeText(report, formatBytes) + '\n')
			});
			return { bytes, mime: 'application/zip', ext: 'zip', extra: { report, snippet, script, file, id, frameType: type } };
		},
		cancel() {}
	};
}

/**
 * The sink for a plan's path.
 * @param {string} path webcodecs | gif | webp | png | hero @param {HTMLCanvasElement} canvas @param {SinkOptions} o
 * @returns {Promise<Sink>}
 */
export async function createSink(path, canvas, o) {
	switch (path) {
		case 'webcodecs':
			return videoSink(canvas, o);
		case 'gif':
			return gifSink(o);
		case 'webp':
			return webpSink(o);
		case 'png':
			return pngSink(o);
		case 'hero':
			return heroSink(o);
		default:
			throw new Error('no encoder for ' + path);
	}
}
