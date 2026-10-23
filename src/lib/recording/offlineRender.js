// 65 M4/M7 — THE FRAME-EXACT EXPORT: a timeline, a turntable or a flythrough rendered FRAME BY FRAME
// into MP4 / WebM (WebCodecs + Mediabunny), a GIF or WebP loop, a PNG sequence, or a website section.
//
// It rides the 36-share recorder's two threlte stages (RecordingDriver → recorder.js `setFrameHooks`),
// but on FRAME time instead of wall time:
//   pose stage    pose frame i — the timeline through `scrubSequence(id, i / fps)` (the Timeline
//                 editor's own local scrub: clips posed at their offsets, the shot at that moment;
//                 no events, no audio, nothing sent), the camera path at `pathT(i)`
//   capture stage once a frame has been RENDERED with that pose — and rendered once more, because a
//                 shot's camera is copied in the main stage, one frame after the scrub that chose it
//                 (the SETTLE frame) — and the encoder has room, copy it (centre crop, never stretched)
//                 and hand it to the sink; only then does i advance.
// So the file has exactly round(duration × fps) frames, each showing its own instant, however long a
// 4K frame took to draw or the encoder to swallow it. A hidden tab simply pauses the export (no frames
// are drawn, none are lost). World motion that runs on its own clock (flow spins, physics) is not
// frame-exact — the timeline and the camera are.
//
// Loaded LAZILY (the dialog's Start): the encoders never reach the boot graph. Everything is LOCAL:
// the camera, the scrub and the file are this viewer's; nothing is sent, nothing is undone.
import { get } from 'svelte/store';
import { globalRenderer, globalScene, isVRMode, isLocked } from '../../stores/sceneStore';
import { recordingState, recordingPrefs, IDLE_RECORDING } from './recordingStores.js';
import { coerceRecordingPrefs, coverRect, recordingFileName } from './recordingCore.js';
import { pathT, timelineTime, sinkHasRoom } from './frameClock.js';
import { exportPlan, probeCaps, FORMAT_INFO } from './videoExportCore.js';
import { createSink, canEncodeWebp } from './exportSinks.js';
import {
	sceneBlocker,
	takeOverScene,
	planPose,
	applyPose,
	setGizmoHidden,
	setFrameHooks,
	recordingDriver,
	startRecording,
	thumbnailOf,
	saveToExplorer
} from './recorder.js';
import { sequences } from '../sequences';
import { findSequence } from '../sequenceCore';
import { scrubSequence, releaseScrub, previewShots } from '../sequencePlayer';

/** renders a frame is held for after its first render (see the header: the shot camera lags one) */
const SETTLE = 1;
/** frames the pixel-ratio change gets to reach the canvas and the composer's targets */
const PREP_FRAMES = 4;

/**
 * @type {null | {
 *   prefs: import('./recordingCore.js').RecordingPrefs, plan: ReturnType<typeof exportPlan>,
 *   sink: import('./exportSinks.js').Sink, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
 *   seq: any, pose: ((t: number) => any) | null, loop: boolean, phase: 'preparing'|'rendering'|'finishing',
 *   prep: number, i: number, posed: number, settle: number, poseRender: number, thumbnail: string | null,
 *   restore: () => void, shotsWere: boolean, lastPublish: number, startedAt: number
 * }}
 */
let session = null;

/** what this browser can do (the dialog reads it too) */
export function exportCaps() {
	return probeCaps(globalThis, canEncodeWebp());
}

/** @param {import('./recordingCore.js').RecordingPrefs} prefs */
function planFor(prefs) {
	const dom = /** @type {any} */ (get(globalRenderer))?.domElement;
	const seq = prefs.mode === 'timeline' ? findSequence(get(sequences), prefs.sequence) : null;
	return { plan: exportPlan(prefs, exportCaps(), { w: dom?.width || 1280, h: dom?.height || 720 }, seq), seq };
}

/**
 * Why this export cannot start, or ''.
 * @param {import('./recordingCore.js').RecordingPrefs} prefs
 */
export function exportBlocker(prefs) {
	const { plan } = planFor(prefs);
	if (plan.path === 'mediarecorder') return '';
	return sceneBlocker(prefs) || plan.blocker;
}

/**
 * Start an export with the remembered options (or `override`). Resolves once it has STARTED (or was
 * refused, the reason in `recordingState.error`); the file arrives through `recordingState` ('done').
 * Where WebCodecs is missing, MP4/WebM fall back to the live MediaRecorder recorder.
 * @param {Partial<import('./recordingCore.js').RecordingPrefs>} [override]
 * @returns {Promise<boolean>}
 */
export async function startExport(override) {
	const prefs = coerceRecordingPrefs({ ...get(recordingPrefs), ...(override || {}) });
	const { plan, seq } = planFor(prefs);
	if (plan.path === 'mediarecorder') return startRecording(prefs);
	const blocked = session ? 'An export is already running.' : sceneBlocker(prefs) || plan.blocker;
	if (blocked) {
		recordingState.set({ ...IDLE_RECORDING, status: 'error', error: blocked });
		return false;
	}
	const canvas = document.createElement('canvas');
	canvas.width = plan.size.w;
	canvas.height = plan.size.h;
	canvas.id = 'recording-canvas';
	canvas.style.cssText = 'position:fixed;left:-100000px;top:0;width:2px;height:2px;pointer-events:none';
	document.body.appendChild(canvas);
	// willReadFrequently: the GIF encoder reads every frame back
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: plan.alpha, willReadFrequently: plan.path === 'gif' }));
	const name = recordingFileName(prefs.mode, new Date(), plan.ext);
	recordingState.set({ ...IDLE_RECORDING, status: 'preparing', duration: plan.duration });
	/** @type {import('./exportSinks.js').Sink} */
	let sink;
	try {
		sink = await createSink(plan.path, canvas, {
			format: plan.format,
			size: plan.size,
			fps: plan.fps,
			frames: plan.frames,
			quality: prefs.quality,
			alpha: plan.alpha,
			name,
			hero: {
				title: seq?.name || (prefs.mode === 'flythrough' ? 'Flythrough' : prefs.mode === 'timeline' ? 'Timeline' : 'Turntable'),
				label: seq?.name || 'Animated scene',
				trigger: prefs.heroTrigger,
				ease: prefs.heroEase,
				smooth: prefs.heroSmooth,
				fit: prefs.heroFit
			}
		});
	} catch (e) {
		canvas.remove();
		recordingState.set({ ...IDLE_RECORDING, status: 'error', error: e instanceof Error ? e.message : String(e) });
		return false;
	}
	// the dialog may have been cancelled, or another take started, while the encoder loaded
	const again = sceneBlocker(prefs);
	if (again || get(recordingState).status !== 'preparing') {
		sink.cancel();
		canvas.remove();
		if (again) recordingState.set({ ...IDLE_RECORDING, status: 'error', error: again });
		return false;
	}
	const restore = takeOverScene({ hideHelpers: prefs.hideHelpers, transparent: plan.alpha }, plan.size);
	const shotsWere = get(previewShots);
	if (seq) previewShots.set(true); // an export films the shots, whatever the editor's preview pref says
	session = {
		prefs,
		plan,
		sink,
		canvas,
		ctx,
		seq,
		pose: planPose(prefs),
		// a whole number of turns comes back to its first frame: never draw it twice
		loop: prefs.mode === 'turntable' && Number.isInteger(prefs.revolutions),
		phase: 'preparing',
		prep: 0,
		i: 0,
		posed: -1,
		settle: 0,
		poseRender: -1,
		thumbnail: null,
		restore,
		shotsWere,
		lastPublish: 0,
		startedAt: performance.now()
	};
	setFrameHooks({ before, after, cancel: cancelExport });
	recordingDriver()?.invalidate?.();
	return true;
}

/* -------------------------------------------------------------- per frame ---- */

/** the pose stage */
function before() {
	const s = session;
	if (!s || s.phase === 'finishing') return;
	if (get(isVRMode)) return fail('The export stopped: VR started.');
	if (get(isLocked) === true) return fail('The export stopped: Play started.');
	if (s.prefs.hideHelpers) setGizmoHidden(true);
	if (s.plan.alpha) {
		// the sky may be re-applied (a peer's environment edit) while we film: keep it off
		const scene = /** @type {any} */ (get(globalScene));
		if (scene && scene.background) scene.background = null;
	}
	const frame = s.phase === 'preparing' ? 0 : s.i;
	const { plan } = s;
	if (s.seq) scrubSequence(s.seq.id, timelineTime(frame, plan.fps, s.seq));
	if (s.pose) applyPose(s.pose(pathT(frame, plan.frames, s.loop)));
	if (s.posed !== frame) {
		s.posed = frame;
		s.settle = SETTLE;
	}
	s.poseRender = rendererFrame();
	recordingDriver()?.invalidate?.();
}

function rendererFrame() {
	return /** @type {any} */ (get(globalRenderer))?.info?.render?.frame ?? -1;
}

/** the capture stage */
function after() {
	const s = session;
	if (!s || s.phase === 'finishing') return;
	if (s.phase === 'preparing') {
		if (++s.prep >= PREP_FRAMES) s.phase = 'rendering';
		return;
	}
	// nothing was rendered since the pose (a paused or throttled frame): it is not frame i yet
	if (rendererFrame() === s.poseRender) return;
	if (s.settle > 0) {
		s.settle--;
		return;
	}
	const err = s.sink.error();
	if (err) return fail('The encoder failed: ' + err.message);
	if (!sinkHasRoom(s.sink.pending(), s.sink.limit)) return;
	const dom = /** @type {any} */ (get(globalRenderer)).domElement;
	const { w, h } = s.plan.size;
	const crop = coverRect(dom.width, dom.height, w, h);
	if (s.plan.alpha) s.ctx.clearRect(0, 0, w, h);
	s.ctx.drawImage(dom, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
	try {
		s.sink.add(s.canvas, s.i);
	} catch (e) {
		return fail('The encoder failed: ' + (e instanceof Error ? e.message : String(e)));
	}
	if (!s.thumbnail && s.i >= Math.floor(s.plan.frames * 0.4)) s.thumbnail = thumbnailOf(s.canvas);
	s.i++;
	const done = s.i >= s.plan.frames;
	const now = performance.now();
	if (now - s.lastPublish > 100 || done) {
		s.lastPublish = now;
		recordingState.update((st) => ({
			...st,
			status: 'recording',
			progress: s.i / s.plan.frames,
			elapsed: s.i / s.plan.fps,
			frames: s.i
		}));
	}
	if (done) void finish();
}

/* ------------------------------------------------------------ the ending ---- */

function teardown() {
	const s = session;
	if (!s) return;
	setFrameHooks(null);
	session = null;
	if (s.seq) {
		releaseScrub();
		previewShots.set(s.shotsWere);
	}
	s.restore();
	s.canvas.remove();
}

async function finish() {
	const s = session;
	if (!s || s.phase !== 'rendering') return;
	s.phase = 'finishing';
	recordingState.update((st) => ({ ...st, status: 'finishing', progress: 1 }));
	teardown();
	try {
		const out = await s.sink.finish();
		const name = recordingFileName(s.prefs.mode, new Date(), out.ext);
		const blob = new Blob([/** @type {BlobPart} */ (out.bytes)], { type: out.mime });
		const kind = out.mime.startsWith('video/') ? 'video' : out.mime.startsWith('image/') ? 'image' : '';
		const saved = kind
			? await saveToExplorer(out.bytes, name, s.thumbnail, out.mime, kind)
			: { itemId: null, note: 'A .zip is not kept in the Explorer: download it.' };
		const extra = out.extra ?? {};
		recordingState.set({
			...IDLE_RECORDING,
			status: 'done',
			progress: 1,
			elapsed: s.plan.duration,
			duration: s.plan.duration,
			frames: s.plan.frames,
			result: {
				name,
				url: URL.createObjectURL(blob),
				blob,
				bytes: blob.size,
				durationMs: Math.round((s.plan.frames / s.plan.fps) * 1000),
				width: s.plan.size.w,
				height: s.plan.size.h,
				fps: s.plan.fps,
				mime: out.mime,
				itemId: saved.itemId,
				savedNote: saved.note,
				format: s.plan.format,
				frames: s.plan.frames,
				exact: true,
				encoder: s.sink.label,
				report: extra.report,
				snippet: extra.snippet,
				script: extra.script,
				scriptFile: extra.file
			}
		});
	} catch (e) {
		recordingState.set({
			...IDLE_RECORDING,
			status: 'error',
			error: `Could not finish the ${/** @type {any} */ (FORMAT_INFO)[s.plan.format]?.label ?? 'file'}: ` + (e instanceof Error ? e.message : String(e))
		});
	}
}

/** @param {string} reason */
function fail(reason) {
	const s = session;
	if (!s) return;
	s.sink.cancel();
	teardown();
	recordingState.set({ ...IDLE_RECORDING, status: reason ? 'error' : 'idle', error: reason });
}

/** Cancel the running export; nothing is saved. */
export function cancelExport() {
	fail('');
}

/** test/debug read: the live export's numbers (null when idle) */
export function exportDebug() {
	const s = session;
	return s
		? { phase: s.phase, frame: s.i, frames: s.plan.frames, path: s.plan.path, size: s.plan.size, pending: s.sink.pending(), alpha: s.plan.alpha, posed: s.posed }
		: null;
}
