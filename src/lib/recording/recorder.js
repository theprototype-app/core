// 36-share (B13) — THE RECORDER: a turntable or a flythrough of the viewport, written to a webm by
// MediaRecorder over a canvas, saved to the Explorer and offered as a download.
//
// How a frame gets into the file. The drawing buffer is not preserved, so the canvas can only be
// read inside the frame that drew it: `RecordingDriver.svelte` (mounted in Scene) calls
// `recordingBeforeRender()` from a stage between the main stage and the render stage — the camera
// is posed AFTER OrbitControls' own update, so the frame shows exactly our pose — and
// `recordingAfterRender()` from a stage after the render stage, which copies the fresh frame into
// an output canvas of the chosen size (centre-cropped, never stretched) and asks its capture track
// for a frame. A frame the app did not render (paused, throttled, a load holding frames) is
// detected by `renderer.info.render.frame` standing still and is skipped, never captured blank.
//
// Time is WALL time: the camera is where it should be at `now - t0`, so the motion keeps its speed
// when frames drop and the file's length is the requested length (MediaRecorder stamps frames by
// wall clock too). Chrome writes the webm with no Duration; `fixWebmDuration` adds it afterwards.
//
// Everything here is LOCAL: the camera is this viewer's, nothing is sent, nothing is undone. The
// Explorer item is a local library file like any other (private until shared).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, globalRenderer, objectsGroup, orbitControls, selectedObjects, isVRMode, isLocked, TControls, cameraClaim } from '../../stores/sceneStore';
import { recordingState, recordingPrefs, IDLE_RECORDING } from './recordingStores.js';
import { recordingClean, setMarkersHidden, markersAreHidden } from '../helperLayer';
import {
	coerceRecordingPrefs,
	outputSize,
	coverRect,
	dprBoost,
	bitrateFor,
	pickMimeType,
	recordingFileName,
	planOrbit,
	turntablePose,
	planFlythrough,
	flythroughPose,
	sphereOfBoxes
} from './recordingCore.js';
import { fixWebmDuration } from './webmDuration.js';

export const RECORDINGS_FOLDER = 'Recordings';

/** what the driver component hands over: threlte's own pixel-ratio knob (Scene's governor rule —
 * renderer.setPixelRatio directly would be undone by threlte's resize effect)
 * @type {{getDpr: () => number, setDpr: (v: number) => void} | null} */
let driver = null;

/** @param {{getDpr: () => number, setDpr: (v: number) => void} | null} d @returns {() => void} */
export function registerRecordingDriver(d) {
	driver = d;
	return () => {
		if (driver === d) driver = null;
	};
}

/**
 * The live recording. One at a time.
 * @type {null | {
 *   prefs: import('./recordingCore.js').RecordingPrefs, durationMs: number, frameMs: number,
 *   pose: (t: number) => {position: number[], target: number[], fov?: number | null},
 *   out: {w: number, h: number}, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
 *   stream: MediaStream, track: any, manual: boolean, recorder: MediaRecorder, chunks: Blob[], mime: string, ext: string,
 *   phase: 'preparing' | 'recording' | 'finishing', t0: number, lastCapture: number, lastRenderFrame: number,
 *   frames: number, thumbnail: string | null, lastPublish: number, cancelled: boolean, stopAt: number,
 *   restore: () => void, onStop: Promise<void>, prepFrames: number
 * }}
 */
let session = null;

/** @returns {boolean} */
export function isRecording() {
	return !!session;
}

/**
 * Why a recording cannot start right now, or '' when it can.
 * @param {import('./recordingCore.js').RecordingPrefs} [prefs]
 */
export function recordingBlocker(prefs) {
	if (session) return 'A recording is already running.';
	if (typeof MediaRecorder === 'undefined') return 'This browser cannot record video (no MediaRecorder).';
	if (!pickMimeType((m) => MediaRecorder.isTypeSupported(m))) return 'This browser cannot record webm or mp4 video.';
	const r = /** @type {any} */ (get(globalRenderer));
	if (!r?.domElement?.captureStream) return 'The viewport cannot be captured in this browser.';
	if (get(isVRMode)) return 'Leave VR to record — the headset owns the camera.';
	if (get(isLocked) === true) return 'Leave Play to record — the recorder drives the editor camera.';
	if (!get(orbitControls) || !get(globalCamera)) return 'The viewport is not ready yet.';
	if (prefs?.mode === 'flythrough' && !flythroughViews()) return 'A flythrough needs at least two saved camera views (right-click the viewport ▸ Camera bookmarks ▸ Save current view).';
	return '';
}

/* --------------------------------------------------------------- planning ---- */

/** the saved camera views, in order — loaded on demand so this module stays off the boot graph */
let bookmarksStore = /** @type {any} */ (null);
import('../cameraBookmarks')
	.then((m) => (bookmarksStore = m.bookmarks))
	.catch(() => {});

function flythroughViews() {
	const list = bookmarksStore ? /** @type {any[]} */ (get(bookmarksStore)) : [];
	return planFlythrough(list);
}

/** world boxes of what a turntable orbits: the selection, else every visible object @param {'selection'|'scene'} target */
function framedBoxes(target) {
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return [];
	const selected = /** @type {string[]} */ (get(selectedObjects) || []);
	const pick =
		target === 'selection' && selected.length
			? selected.map((uuid) => group.getObjectByProperty('uuid', uuid)).filter(Boolean)
			: group.children.filter((/** @type {any} */ c) => c.visible !== false);
	const box = new THREE.Box3();
	/** @type {{min: number[], max: number[]}[]} */
	const out = [];
	for (const obj of pick) {
		box.setFromObject(obj);
		if (!box.isEmpty()) out.push({ min: box.min.toArray(), max: box.max.toArray() });
	}
	return out;
}

/** @param {import('./recordingCore.js').RecordingPrefs} prefs */
function planPose(prefs) {
	const camera = /** @type {any} */ (get(globalCamera));
	const controls = /** @type {any} */ (get(orbitControls));
	if (prefs.mode === 'flythrough') {
		const path = flythroughViews();
		if (!path) return null;
		return (/** @type {number} */ t) => flythroughPose(path, t);
	}
	const sphere = sphereOfBoxes(framedBoxes(prefs.target)) ?? { center: /** @type {[number, number, number]} */ (controls.target.toArray()), radius: 2 };
	const orbit = planOrbit({
		position: camera.position.toArray(),
		center: sphere.center,
		radius: sphere.radius,
		fovDeg: camera.fov,
		aspect: camera.aspect,
		frame: prefs.frame,
		revolutions: prefs.revolutions,
		direction: prefs.direction
	});
	return (/** @type {number} */ t) => turntablePose(orbit, t);
}

/* ------------------------------------------------------------------- start ---- */

/**
 * Start recording with the remembered options (or `override`). Resolves when the recording has
 * STARTED (or refused, with the reason in `recordingState.error`); the file arrives later through
 * `recordingState` (status 'done').
 * @param {Partial<import('./recordingCore.js').RecordingPrefs>} [override]
 * @returns {Promise<boolean>}
 */
export async function startRecording(override) {
	const prefs = coerceRecordingPrefs({ ...get(recordingPrefs), ...(override || {}) });
	const blocked = recordingBlocker(prefs);
	if (blocked) {
		recordingState.set({ ...IDLE_RECORDING, status: 'error', error: blocked });
		return false;
	}
	const renderer = /** @type {any} */ (get(globalRenderer));
	const camera = /** @type {any} */ (get(globalCamera));
	const controls = /** @type {any} */ (get(orbitControls));
	const pose = planPose(prefs);
	if (!pose) {
		recordingState.set({ ...IDLE_RECORDING, status: 'error', error: 'Nothing to record along.' });
		return false;
	}
	const picked = /** @type {{mime: string, ext: string}} */ (pickMimeType((m) => MediaRecorder.isTypeSupported(m)));
	const dom = /** @type {HTMLCanvasElement} */ (renderer.domElement);
	const out = outputSize(prefs.resolution, { w: dom.width, h: dom.height });

	// --- the scene as the recording wants it, every change remembered for the restore
	const saved = {
		position: camera.position.clone(),
		target: controls.target.clone(),
		fov: camera.fov,
		enabled: controls.enabled,
		dpr: driver ? driver.getDpr() : 0,
		markers: markersAreHidden()
	};
	controls.enabled = false;
	cameraClaim.update((n) => n + 1);
	/** @type {number | null} */
	let boostedDpr = null;
	if (driver) {
		const boost = dprBoost({ w: dom.clientWidth, h: dom.clientHeight }, saved.dpr || window.devicePixelRatio || 1, out);
		if (boost > 1.001) {
			boostedDpr = (saved.dpr || window.devicePixelRatio || 1) * boost;
			driver.setDpr(boostedDpr);
		}
	}
	if (prefs.hideHelpers) {
		recordingClean.set(true);
		setMarkersHidden(true);
	}

	const canvas = document.createElement('canvas');
	canvas.width = out.w;
	canvas.height = out.h;
	canvas.id = 'recording-canvas';
	canvas.style.cssText = 'position:fixed;left:-100000px;top:0;width:2px;height:2px;pointer-events:none';
	document.body.appendChild(canvas);
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false }));
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, out.w, out.h);
	let stream = canvas.captureStream(0);
	let track = /** @type {any} */ (stream.getVideoTracks()[0]);
	const manual = typeof track?.requestFrame === 'function';
	if (!manual) {
		stream.getTracks().forEach((t) => t.stop());
		stream = canvas.captureStream(prefs.fps);
		track = stream.getVideoTracks()[0];
	}
	/** @type {Blob[]} */
	const chunks = [];
	let recorder;
	try {
		recorder = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: bitrateFor(out, prefs.fps, prefs.quality) });
	} catch (e) {
		stream.getTracks().forEach((t) => t.stop());
		canvas.remove();
		restoreScene();
		recordingState.set({ ...IDLE_RECORDING, status: 'error', error: 'The video encoder refused these settings: ' + (e instanceof Error ? e.message : String(e)) });
		return false;
	}
	recorder.ondataavailable = (e) => {
		if (e.data && e.data.size) chunks.push(e.data);
	};
	const onStop = new Promise((resolve) => {
		recorder.onstop = () => resolve(undefined);
	});

	function restoreScene() {
		const cam = /** @type {any} */ (get(globalCamera));
		const ctl = /** @type {any} */ (get(orbitControls));
		if (cam) {
			cam.position.copy(saved.position);
			if (typeof saved.fov === 'number' && cam.fov !== saved.fov) {
				cam.fov = saved.fov;
				cam.updateProjectionMatrix();
			}
		}
		if (ctl) {
			ctl.target.copy(saved.target);
			ctl.enabled = saved.enabled;
			ctl.update?.();
		}
		// put the pixel ratio back only if nothing else (the quality governor) moved it meanwhile
		if (driver && boostedDpr !== null && Math.abs(driver.getDpr() - boostedDpr) < 1e-6) driver.setDpr(saved.dpr);
		if (prefs.hideHelpers) {
			recordingClean.set(false);
			setMarkersHidden(saved.markers);
		}
		setGizmoHidden(false);
	}

	session = {
		prefs,
		durationMs: prefs.duration * 1000,
		frameMs: 1000 / prefs.fps,
		pose,
		out,
		canvas,
		ctx,
		stream,
		track,
		manual,
		recorder,
		chunks,
		mime: picked.mime,
		ext: picked.ext,
		phase: 'preparing',
		t0: 0,
		lastCapture: -Infinity,
		lastRenderFrame: -1,
		frames: 0,
		thumbnail: null,
		lastPublish: 0,
		cancelled: false,
		stopAt: 0,
		restore: restoreScene,
		onStop,
		prepFrames: 0
	};
	document.addEventListener('visibilitychange', onVisibility);
	recordingState.set({ ...IDLE_RECORDING, status: 'preparing', duration: prefs.duration });
	return true;
}

function onVisibility() {
	if (document.visibilityState === 'hidden' && session && session.phase !== 'finishing') abort('Recording stopped: the tab was hidden, and a hidden tab draws no frames.');
}

/** @type {{obj: any, was: boolean} | null} */
let gizmoHidden = null;
/** the transform gizmo's visuals live in `getHelper()`, not on the controls (three r16x+) @param {boolean} hide */
function setGizmoHidden(hide) {
	if (hide) {
		const tc = /** @type {any} */ (get(TControls));
		const gizmo = tc?.getHelper?.() ?? tc;
		if (!gizmo) return;
		if (!gizmoHidden || gizmoHidden.obj !== gizmo) gizmoHidden = { obj: gizmo, was: gizmo.visible };
		gizmo.visible = false;
	} else if (gizmoHidden) {
		gizmoHidden.obj.visible = gizmoHidden.was;
		gizmoHidden = null;
	}
}

/* -------------------------------------------------------------- per frame ---- */

/** @param {{position: number[], target: number[], fov?: number | null}} p */
function applyPose(p) {
	const camera = /** @type {any} */ (get(globalCamera));
	const controls = /** @type {any} */ (get(orbitControls));
	if (!camera || !controls) return;
	camera.position.fromArray(p.position);
	controls.target.fromArray(p.target);
	camera.lookAt(controls.target);
	if (typeof p.fov === 'number' && Number.isFinite(p.fov) && camera.fov !== p.fov) {
		camera.fov = p.fov;
		camera.updateProjectionMatrix();
	}
	camera.updateMatrixWorld();
}

/** the driver's pose stage: after OrbitControls' update, before the render */
export function recordingBeforeRender() {
	const s = session;
	if (!s) return;
	if (get(isVRMode)) return abort('Recording stopped: VR started.');
	if (get(isLocked) === true) return abort('Recording stopped: Play started.');
	if (s.prefs.hideHelpers) setGizmoHidden(true);
	if (s.phase === 'preparing') {
		applyPose(s.pose(0));
		// a few frames for a pixel-ratio change to reach the canvas and the composer's targets
		if (++s.prepFrames >= 4) {
			s.phase = 'recording';
			s.recorder.start(500);
			s.t0 = performance.now();
			recordingState.update((st) => ({ ...st, status: 'recording' }));
		}
		return;
	}
	if (s.phase !== 'recording') return;
	const t = Math.min(1, (performance.now() - s.t0) / s.durationMs);
	applyPose(s.pose(t));
}

/** the driver's capture stage: right after the render, while the drawing buffer still holds it */
export function recordingAfterRender() {
	const s = session;
	if (!s || s.phase !== 'recording') return;
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer) return;
	const frameNo = renderer.info?.render?.frame ?? -1;
	const rendered = frameNo !== s.lastRenderFrame;
	s.lastRenderFrame = frameNo;
	const now = performance.now();
	const elapsed = now - s.t0;
	const last = elapsed >= s.durationMs;
	// capture at the requested rate; a 60 Hz display recording 30 fps takes every other frame
	if (rendered && (now - s.lastCapture >= s.frameMs * 0.92 || last)) {
		const dom = renderer.domElement;
		const crop = coverRect(dom.width, dom.height, s.out.w, s.out.h);
		s.ctx.drawImage(dom, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, s.out.w, s.out.h);
		if (s.manual) s.track.requestFrame();
		s.lastCapture = now;
		s.frames++;
		if (!s.thumbnail && elapsed >= s.durationMs * 0.4) s.thumbnail = thumbnailOf(s.canvas);
	}
	if (now - s.lastPublish > 100 || last) {
		s.lastPublish = now;
		recordingState.update((st) => ({ ...st, progress: Math.min(1, elapsed / s.durationMs), elapsed: Math.min(elapsed, s.durationMs) / 1000, frames: s.frames }));
	}
	if (last) finish();
}

/** a small picture for the Explorer card @param {HTMLCanvasElement} src */
function thumbnailOf(src) {
	try {
		const scale = Math.min(1, 160 / Math.max(src.width, src.height));
		const c = document.createElement('canvas');
		c.width = Math.max(1, Math.round(src.width * scale));
		c.height = Math.max(1, Math.round(src.height * scale));
		c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
		return c.toDataURL('image/webp', 0.75);
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------ the ending ---- */

function teardown() {
	const s = session;
	if (!s) return;
	document.removeEventListener('visibilitychange', onVisibility);
	s.stream.getTracks().forEach((t) => t.stop());
	s.canvas.remove();
	s.restore();
	session = null;
}

async function finish() {
	const s = session;
	if (!s || s.phase !== 'recording') return;
	s.phase = 'finishing';
	s.stopAt = performance.now();
	recordingState.update((st) => ({ ...st, status: 'finishing', progress: 1 }));
	try {
		s.recorder.stop();
	} catch {
		/* already inactive */
	}
	await s.onStop;
	teardown();
	if (s.cancelled) return;
	try {
		const durationMs = Math.round(Math.min(s.stopAt - s.t0, s.durationMs + s.frameMs));
		const raw = new Uint8Array(await new Blob(s.chunks).arrayBuffer());
		const bytes = s.ext === 'webm' ? fixWebmDuration(raw, durationMs) : raw;
		const type = s.mime.split(';')[0];
		const blob = new Blob([/** @type {BlobPart} */ (bytes)], { type });
		const name = recordingFileName(s.prefs.mode, new Date(), s.ext);
		const saved = await saveToExplorer(bytes, name, s.thumbnail, type);
		recordingState.set({
			...IDLE_RECORDING,
			status: 'done',
			progress: 1,
			elapsed: durationMs / 1000,
			duration: s.prefs.duration,
			frames: s.frames,
			result: {
				name,
				url: URL.createObjectURL(blob),
				blob,
				bytes: blob.size,
				durationMs,
				width: s.out.w,
				height: s.out.h,
				fps: s.prefs.fps,
				mime: type,
				itemId: saved.itemId,
				savedNote: saved.note
			}
		});
	} catch (e) {
		recordingState.set({ ...IDLE_RECORDING, status: 'error', error: 'Could not finish the video: ' + (e instanceof Error ? e.message : String(e)) });
	}
}

/**
 * The file in the Explorer's Recordings folder, as a `video` item.
 * @param {Uint8Array} bytes @param {string} name @param {string | null} thumbnail @param {string} type
 * @returns {Promise<{itemId: string | null, note: string}>}
 */
async function saveToExplorer(bytes, name, thumbnail, type) {
	try {
		const explorer = await import('../explorer');
		await explorer.loadExplorer();
		if (bytes.byteLength > explorer.MAX_ITEM_BYTES) {
			return { itemId: null, note: `Not kept in the Explorer: it is over the library's ${Math.round(explorer.MAX_ITEM_BYTES / 1048576)} MB file limit. Download it instead.` };
		}
		const folders = /** @type {any[]} */ (get(explorer.explorerFolders));
		const folder = folders.find((f) => f.name === RECORDINGS_FOLDER && !f.parentId) ?? explorer.createFolder(RECORDINGS_FOLDER, null);
		const buffer = /** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		const item = await explorer.addItemFromBytes(buffer, name, folder?.id ?? null, { kind: 'video', type, thumbnail, allowDuplicate: true });
		return { itemId: item?.id ?? null, note: `Saved to Explorer ▸ ${RECORDINGS_FOLDER}.` };
	} catch (e) {
		return { itemId: null, note: 'Not kept in the Explorer (' + (e instanceof Error ? e.message : String(e)) + '). Download it instead.' };
	}
}

/** @param {string} reason */
function abort(reason) {
	const s = session;
	if (!s) return;
	s.cancelled = true;
	if (s.phase === 'recording') {
		s.phase = 'finishing';
		try {
			s.recorder.stop();
		} catch {
			/* not started */
		}
	}
	teardown();
	recordingState.set({ ...IDLE_RECORDING, status: reason ? 'error' : 'idle', error: reason });
}

/** Cancel the running recording; nothing is saved. */
export function cancelRecording() {
	abort('');
}

/** Forget a finished/failed result (the dialog's Close / New recording). */
export function resetRecording() {
	const st = get(recordingState);
	if (session) return;
	if (st.result?.url) setTimeout(() => URL.revokeObjectURL(/** @type {string} */ (st.result?.url)), 60000);
	recordingState.set({ ...IDLE_RECORDING });
}

/** Download the finished file. */
export function downloadRecording() {
	const r = get(recordingState).result;
	if (!r) return;
	const a = document.createElement('a');
	a.href = r.url;
	a.download = r.name;
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/** test/debug read: the live session's numbers (null when idle) */
export function recordingDebug() {
	const s = session;
	return s ? { phase: s.phase, frames: s.frames, out: s.out, mime: s.mime, manual: s.manual } : null;
}
