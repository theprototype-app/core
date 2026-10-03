// 34 R1 — "REPORT THIS MOMENT". The player felt a hitch, saw something wrong, or the frame
// rate dropped in one corner of a level: one press keeps the last 30 s of the light ring, a
// picture of what their EYE saw, and an optional note — saved on the device as a recording
// (the Profiler opens it) and, when "Send performance reports" is on (or the dialog's box is
// ticked), sent as a `moment` report with the screenshot as its own file.
//
// TWO STEPS, ON PURPOSE: `captureMoment()` runs at the PRESS (the data and the picture are of
// the moment, not of the time spent typing a note), `finishMoment(draft, {note, send})` when
// the note is done. Desktop: the Sidebar's "Report this moment" opens a small dialog
// (MomentReport.svelte) between the two. VR: System ▸ "Report moment" captures, then the VR
// keyboard asks for the note (cancel = no note) and it is saved/sent.
//
// THE EYE SCREENSHOT: on the desktop a fresh render of the viewport camera read off the
// canvas (no preserveDrawingBuffer needed); in a headset the canvas is not the eye buffer,
// so the scene is rendered ONCE more from the LEFT-EYE camera into an offscreen target and
// read back — one extra render on demand. (A render target gets no tone mapping, three's
// rule, so a headset shot can look a little flatter than the eye did.)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalRenderer, globalScene, globalCamera } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { lightWindow, saveDocument } from './recorder.js';
import { perfMark } from './perfMarks.js';
import { perfReportsOn, reportsUrl, sendReport, SESSION } from './beacon.js';
import { MOMENT_MS, REPORT_LIMITS } from './tpprof.js';

/** the screenshot's longest side */
export const SHOT_MAX = 960;

/**
 * The dialog's draft (desktop): what was captured at the press. null = closed.
 * @type {import('svelte/store').Writable<null | {doc: import('./tpprof.js').Tpprof, shot: Blob | null, shotUrl: string | null, at: number}>}
 */
export const momentDraft = writable(null);

/** @param {HTMLCanvasElement} canvas @param {number} quality */
function toJpeg(canvas, quality) {
	return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/** the viewport camera's picture (desktop) @param {any} r @param {any} scene @param {any} cam */
async function desktopShot(r, scene, cam) {
	r.render(scene, cam);
	const src = r.domElement;
	const scale = Math.min(1, SHOT_MAX / Math.max(src.width || 1, src.height || 1));
	const c = document.createElement('canvas');
	c.width = Math.max(1, Math.round(src.width * scale));
	c.height = Math.max(1, Math.round(src.height * scale));
	const ctx = c.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(src, 0, 0, c.width, c.height);
	return toJpeg(c, 0.72);
}

/** the left eye's picture (in a headset): one offscreen render @param {any} r @param {any} scene */
async function eyeShot(r, scene) {
	const xrCam = r.xr.getCamera();
	const eye = xrCam?.cameras?.[0] ?? xrCam;
	const vp = eye?.viewport;
	const aspect = vp && vp.w > 0 && vp.z > 0 ? vp.z / vp.w : 1;
	const w = aspect >= 1 ? SHOT_MAX : Math.round(SHOT_MAX * aspect);
	const h = aspect >= 1 ? Math.round(SHOT_MAX / aspect) : SHOT_MAX;
	// a DETACHED copy of the eye: while a session presents, three swaps any camera handed to
	// render() for the XR ArrayCamera (both eyes, viewports in the XR framebuffer's pixels),
	// so the render below runs with xr.enabled off, from a camera whose world matrix is the
	// eye's as XR set it this frame (recomputing it would drop the rig's transform)
	const cam = new THREE.PerspectiveCamera();
	cam.matrixAutoUpdate = false;
	cam.matrixWorldAutoUpdate = false;
	cam.matrixWorld.copy(eye.matrixWorld);
	cam.matrixWorldInverse.copy(eye.matrixWorld).invert();
	cam.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
	cam.projectionMatrix.copy(eye.projectionMatrix);
	cam.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
	cam.layers.mask = eye.layers.mask; // the left eye's layer (1) included
	const target = new THREE.WebGLRenderTarget(w, h);
	target.texture.colorSpace = THREE.SRGBColorSpace;
	const prev = r.getRenderTarget();
	const pixels = new Uint8Array(w * h * 4);
	const xrWas = r.xr.enabled;
	try {
		r.xr.enabled = false;
		r.setRenderTarget(target);
		r.clear();
		r.render(scene, cam);
		r.readRenderTargetPixels(target, 0, 0, w, h, pixels);
	} finally {
		r.xr.enabled = xrWas;
		r.setRenderTarget(prev);
		target.dispose();
	}
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d');
	if (!ctx) return null;
	const img = ctx.createImageData(w, h);
	// GL rows are bottom-up
	for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
	ctx.putImageData(img, 0, 0);
	return toJpeg(c, 0.72);
}

/** What the player's eye saw, as a JPEG Blob (null when there is nothing to render). */
export async function eyeScreenshot() {
	const r = /** @type {any} */ (get(globalRenderer));
	const scene = get(globalScene);
	const cam = get(globalCamera);
	if (!r || !scene) return null;
	try {
		if (r.xr?.isPresenting) return await eyeShot(r, scene);
		if (!cam) return null;
		return await desktopShot(r, scene, cam);
	} catch (error) {
		console.warn('moment screenshot failed', error);
		return null;
	}
}

/** @param {Blob} blob @returns {Promise<string>} */
function dataUrlOf(blob) {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result));
		fr.onerror = () => reject(fr.error);
		fr.readAsDataURL(blob);
	});
}

/**
 * Step 1, at the press: the last 30 s of the light ring + the eye screenshot.
 * @returns {Promise<{doc: import('./tpprof.js').Tpprof, shot: Blob | null, shotUrl: string | null, at: number}>}
 */
export async function captureMoment() {
	perfMark('moment', null);
	const doc = lightWindow(MOMENT_MS, { kind: 'moment', session: SESSION });
	// the moment's own marker lands in the ring AFTER the window was cut; put it at the end
	doc.events.push({ t: doc.meta.durationMs ?? MOMENT_MS, kind: 'moment', detail: null });
	const shot = await eyeScreenshot();
	return { doc, shot, shotUrl: shot ? URL.createObjectURL(shot) : null, at: Date.now() };
}

/**
 * Step 2: keep it (always) and send it (when asked and the build has an endpoint).
 * @param {{doc: import('./tpprof.js').Tpprof, shot: Blob | null, shotUrl?: string | null}} draft
 * @param {{note?: string, send?: boolean}} [opts]
 * @returns {Promise<{id: string, sent: boolean}>}
 */
export async function finishMoment(draft, opts = {}) {
	const note = String(opts.note ?? '').trim().slice(0, 1000);
	const t = draft.doc.meta.durationMs ?? MOMENT_MS;
	const stamp = new Date(draft.doc.meta.startedAt + t);
	const name = 'Moment ' + stamp.toISOString().slice(0, 19).replace('T', ' ');
	// the local copy carries the picture inline (it never leaves the device)
	const local = structuredClone(draft.doc);
	local.meta.name = name;
	local.notes = [{ t, ...(note ? { text: note } : {}), ...(draft.shot ? { screenshot: await dataUrlOf(draft.shot) } : {}) }];
	const id = await saveDocument(local);
	let sent = false;
	if (opts.send && reportsUrl()) {
		// the report names its picture; the bytes ride the `screenshot` file field
		const report = structuredClone(draft.doc);
		report.notes = [{ t, ...(note ? { text: note } : {}), ...(draft.shot ? { screenshot: 'moment.jpg' } : {}) }];
		const shot = draft.shot && draft.shot.size <= 1048576 ? draft.shot : null;
		if (JSON.stringify(report).length <= REPORT_LIMITS.moment.bytes) sent = await sendReport('moment', report, shot);
	}
	if (draft.shotUrl) URL.revokeObjectURL(draft.shotUrl);
	return { id, sent };
}

/** Desktop: capture now, then let the dialog ask for the note. */
export async function openMomentReport() {
	const draft = await captureMoment();
	momentDraft.set(draft);
	return draft;
}

/** The dialog's answer. @param {{note?: string, send?: boolean} | null} answer null = cancel */
export async function closeMomentReport(answer) {
	const draft = get(momentDraft);
	momentDraft.set(null);
	if (!draft) return null;
	if (!answer) {
		if (draft.shotUrl) URL.revokeObjectURL(draft.shotUrl);
		return null;
	}
	const result = await finishMoment(draft, answer);
	showToast(result.sent ? 'Moment saved and sent — thank you' : 'Moment saved (Profiler ▸ recordings)');
	return result;
}

/**
 * VR: capture at the press, then the VR keyboard asks for a note (cancel = none); saved, and
 * sent when performance reports are on. `keyboard` is vrKeyboard's `openVRKeyboard`,
 * handed in so this module does not import the VR family.
 * @param {(opts: {title?: string, initial?: string, onCommit: (text: string) => void, onCancel?: () => void}) => void} [keyboard]
 */
export async function vrReportMoment(keyboard) {
	const draft = await captureMoment();
	const send = get(perfReportsOn) && !!reportsUrl();
	const done = (/** @type {string} */ note) =>
		finishMoment(draft, { note, send }).then((r) => {
			showToast(r.sent ? 'Moment saved and sent' : 'Moment saved');
			return r;
		});
	if (!keyboard) return done('');
	return new Promise((resolve) => {
		keyboard({ title: 'What happened? (optional)', initial: '', onCommit: (text) => resolve(done(text)), onCancel: () => resolve(done('')) });
	});
}
