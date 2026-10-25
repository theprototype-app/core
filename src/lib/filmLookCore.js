// 77 L1 — FILM-LOOK maths: the lens a camera carries, the focus pull, the letterbox matte.
//
// Imports nothing (unit layer): postEffects builds the passes, lookProps registers the
// animatable paths, the Inspector reads the presets — all three share these numbers.
//
// The LENS lives on the camera MARKER's `userData.camera` (16-P5: the marker is the camera),
// beside fov / aspect — the same fields 68's Film mode records as prop tracks:
//   focus        focus distance, metres (finite = this camera carries its own)
//   aperture     f-number
//   focusTarget  uuid of an object to keep in focus ('' = none); wins over `focus`
//   focusPoint   [x, y, z] in the target's LOCAL frame (tap-to-focus hit), absent = its centre
//   focusPull    seconds a change of focus takes to land (0 = a cut)

export const LENS_DEFAULTS = Object.freeze({ focus: 10, aperture: 2.8, focusPull: 0 });

/** f-number + focus distance → the DOF effect's in-focus range and bokeh scale (68's maths). */
export function dofFromLens(/** @type {number} */ focus, /** @type {number} */ aperture) {
	const n = Math.max(0.7, Math.min(64, aperture || 5.6));
	const d = Math.max(0.05, focus || 10);
	return { focusDistance: d, focusRange: Math.max(0.05, (d * n) / 16), bokehScale: Math.max(0, Math.min(10, (4 * 2.8) / n)) };
}

const finite = (/** @type {any} */ v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : NaN);

/**
 * The lens fields of a camera spec, normalised. `focus` / `aperture` stay NaN when the camera
 * carries none, so a DOF effect can fall back to its own values (68's `source: camera` rule).
 * @param {any} spec userData.camera
 */
export function lensOf(spec) {
	const s = spec && typeof spec === 'object' ? spec : {};
	const point = Array.isArray(s.focusPoint) && s.focusPoint.length >= 3 && s.focusPoint.slice(0, 3).every(Number.isFinite) ? s.focusPoint.slice(0, 3) : null;
	const pull = finite(s.focusPull);
	return {
		focus: finite(s.focus),
		aperture: finite(s.aperture),
		focusTarget: typeof s.focusTarget === 'string' ? s.focusTarget : '',
		focusPoint: point,
		focusPull: Number.isFinite(pull) ? Math.max(0, Math.min(10, pull)) : 0
	};
}

/**
 * One frame of a FOCUS PULL: move `current` toward `desired` so it lands in about `pull`
 * seconds. Eased in DIOPTERS (1/d) — the space a focus ring turns in — so a pull from 2 m to
 * infinity does not race through the near range (roadmap 68's perceptual-units pitfall).
 * A cut (pull 0) or a first frame (current not finite) snaps.
 * @param {number} current @param {number} desired @param {number} delta seconds @param {number} pull seconds
 */
export function easeFocus(current, desired, delta, pull) {
	if (!Number.isFinite(desired)) return current;
	if (!Number.isFinite(current) || !(pull > 0)) return desired;
	const a = 1 / Math.max(0.05, current);
	const b = 1 / Math.max(0.05, desired);
	// exponential approach that is 99% of the way after `pull` seconds (ln 100 ≈ 4.6)
	const k = 1 - Math.exp((-Math.max(0, delta) * 4.6) / pull);
	const next = a + (b - a) * k;
	// close enough: land exactly, so a settled pull stops writing a moving value
	if (Math.abs(next - b) < 1e-4) return desired;
	return 1 / next;
}

/** A camera's framing preset as a number (0 = 'free': the frame follows the canvas) —
 * cameraObjects.aspectRatio's table, here so the leaf needs no import. @param {any} aspect */
export function framingAspect(aspect) {
	if (aspect === '4:3') return 4 / 3;
	if (aspect === '1:1') return 1;
	if (aspect === '2.39:1') return 2.39;
	if (aspect === '16:9') return 16 / 9;
	return 0;
}

/**
 * The letterbox MATTE on the canvas: each bar's size as a fraction of the CANVAS (`y` = top and
 * bottom bars, `x` = pillars). The matte is cut from the camera's FRAMING (the 16-P5 frame the
 * guide shows and a capture keeps), which sits centred in a canvas of another shape — so what is
 * outside the frame is matte too. The shader in postEffects computes the same rectangle.
 * @param {number} canvasAspect @param {number} framing the camera's framing aspect (0 = the canvas) @param {number} matte (0 = off)
 */
export function matteBars(canvasAspect, framing, matte) {
	if (!(matte > 0) || !(canvasAspect > 0)) return { x: 0, y: 0 };
	const f = framing > 0 ? framing : canvasAspect;
	const frame = canvasAspect > f ? { w: f / canvasAspect, h: 1 } : { w: 1, h: canvasAspect / f };
	const w = frame.w * (matte < f ? matte / f : 1);
	const h = frame.h * (matte > f ? f / matte : 1);
	const bar = (/** @type {number} */ v) => (v >= 1 - 1e-9 ? 0 : (1 - v) / 2);
	return { x: bar(w), y: bar(h) };
}

/** The matte presets the Camera Inspector offers (0 = off). */
export const LETTERBOX_PRESETS = Object.freeze([
	{ value: 0, label: 'Off' },
	{ value: 1.85, label: '1.85:1' },
	{ value: 2, label: '2:1' },
	{ value: 2.39, label: '2.39:1' },
	{ value: 2.76, label: '2.76:1' },
	{ value: 4 / 3, label: '4:3' },
	{ value: 1, label: '1:1' }
]);
