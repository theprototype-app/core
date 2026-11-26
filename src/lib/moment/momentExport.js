// 95 SM2 — a kept moment written to a GIF or an MP4 through the 68-V9 encoders (exportSinks.js:
// gifenc / WebCodecs + Mediabunny) and the same export plan (videoExportCore.js: what this browser
// can write, the phone and hot size caps). No encoder of its own. Loaded LAZILY by the preview.
//
// The kept frames are JPEG blobs captured at up to MOMENT_FPS, irregularly when the game was slow;
// `resampleFrames` picks the frame each instant of the file shows, so the file plays for exactly the
// trimmed length at the game's own speed.
import { createSink } from '../recording/exportSinks.js';
import { exportPlan } from '../recording/videoExportCore.js';
import { coerceRecordingPrefs } from '../recording/recordingCore.js';
import { sinkHasRoom } from '../recording/frameClock.js';
import { exportCaps } from '../recording/offlineRender.js';
import { resampleFrames, momentFileName, momentAudioSlice } from './momentCore.js';

/** the formats a moment offers, in the order the preview shows them */
export const MOMENT_FORMATS = Object.freeze(['gif', 'mp4']);

/**
 * Why this browser cannot write a moment in `format`, or ''.
 * @param {string} format @param {{w: number, h: number}} size
 */
export function momentFormatBlocker(format, size) {
	const plan = planFor(format, 3, size);
	if (plan.path === 'mediarecorder') return 'This browser cannot write an MP4 frame by frame: make a GIF instead.';
	return plan.blocker;
}

/** @param {string} format @param {number} seconds @param {{w: number, h: number}} size */
function planFor(format, seconds, size) {
	const prefs = coerceRecordingPrefs({ format, fps: 15, duration: Math.max(1, seconds), resolution: 'viewport', quality: 'medium' });
	return exportPlan(prefs, exportCaps(), size);
}

/**
 * Write the file.
 * @param {{frames: {t: number, data: Blob}[], start: number, end: number, format: string, size: {w: number, h: number},
 *   fps: number, signal?: AbortSignal, onProgress?: (done: number, total: number) => void,
 *   audio?: {sampleRate: number, channels: Float32Array[]} | null}} o
 *   `start`/`end` seconds from the first kept frame; `audio` (102b-sound) the moment's sound, t = 0 at the first kept
 *   frame — an MP4 carries it, a GIF has no sound
 * @returns {Promise<{blob: Blob, name: string, mime: string, ext: string, frames: number, fps: number, durationMs: number,
 *   width: number, height: number, encoder: string, sound: string | null, soundNote: string}>}
 */
export async function encodeMoment(o) {
	const first = o.frames[0]?.t ?? 0;
	const times = o.frames.map((f) => f.t - first);
	const plan = planFor(o.format, o.end - o.start, o.size);
	if (plan.path === 'mediarecorder') throw new Error('This browser cannot write an MP4 frame by frame: make a GIF instead.');
	if (plan.blocker) throw new Error(plan.blocker);
	const fps = plan.fps;
	const order = resampleFrames(times, o.start, o.end, fps);
	if (!order.length) throw new Error('There is nothing in that part of the moment.');
	const { w, h } = plan.size;
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	// willReadFrequently: the GIF encoder reads every frame back
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false, willReadFrequently: plan.path === 'gif' }));
	const name = momentFileName(new Date(), plan.ext);
	const audio = plan.path === 'webcodecs' ? momentAudioSlice(o.audio, o.start, order.length / fps) : null;
	const sink = await createSink(plan.path, canvas, { format: plan.format, size: plan.size, fps, frames: order.length, quality: 'medium', alpha: false, name, audio });
	let drawn = -1;
	try {
		for (let i = 0; i < order.length; i++) {
			if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
			const k = order[i];
			if (k !== drawn) {
				const bitmap = await createImageBitmap(o.frames[k].data);
				ctx.drawImage(bitmap, 0, 0, w, h);
				bitmap.close?.();
				drawn = k;
			}
			while (!sinkHasRoom(sink.pending(), sink.limit)) {
				if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
				await new Promise((r) => setTimeout(r, 4));
			}
			const err = sink.error();
			if (err) throw err;
			sink.add(canvas, i);
			o.onProgress?.(i + 1, order.length);
		}
		const out = await sink.finish();
		const blob = new Blob([/** @type {BlobPart} */ (out.bytes)], { type: out.mime });
		return {
			blob,
			name: momentFileName(new Date(), out.ext),
			mime: out.mime,
			ext: out.ext,
			frames: order.length,
			fps,
			durationMs: Math.round((order.length / fps) * 1000),
			width: w,
			height: h,
			encoder: sink.label,
			sound: out.extra?.sound ?? null,
			soundNote: out.extra?.soundNote ?? ''
		};
	} catch (e) {
		sink.cancel();
		throw e;
	}
}
