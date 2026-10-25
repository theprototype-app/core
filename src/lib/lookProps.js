// 77 L1 — the FILM-LOOK properties a sequencer property track may drive.
//
// 68 owns the allowlisted property registry (`propTracks.PROPS`, design note cloud
// plans/core/pending/keyframe-model.md "Path"); 68 is not in this lane's base, so these defs
// are written in its PropDef shape `{type, label, unit, min, max, applies, get, set}` and
// `registerLookProps(PROPS)` is the ONE line the 77 int adds to propTracks.js. Until then the
// defs are driven directly (tests, the debug hook) and behave the same.
//
// Imports nothing but the filmLookCore leaf (68's unit-layer rule for the registry).
//
// TWO FAMILIES:
//  - `camera.focus` / `camera.aperture` / `camera.focusPull`: lens fields on the camera
//    marker's `userData.camera` — the same fields (and the same defs) 68's Film mode records,
//    so a recorded focus pull and an authored one are one track.
//  - `look.<kind>.<param>`: a numeric param of an effect in the camera's OWN look document
//    (scenePost, keyed by the camera's uuid). A posed value is a LOCAL LIVE OVERRIDE, never a
//    write into the replicated document: playback is deterministic on every peer (golden rule
//    8), so writing the document per frame would broadcast what every peer already computes.
//    `get` reads the override, else the AUTHORED param (through the resolver postEffects
//    installs), so 68's propPlayback captures the authored value as the base, and `set` of a
//    value equal to the authored one DROPS the override — a released track leaves nothing.
//    Nothing here is on the object, so no serializer can save a posed look.

import { LENS_DEFAULTS } from './filmLookCore';

/** @typedef {{type: string, label: string, unit?: string, get: (o: any) => any, set: (o: any, v: any) => void, applies: (o: any) => boolean, min?: number, max?: number}} PropDef */

/**
 * The look params that can change WITHOUT a chain rebuild (each has a live uniform setter in
 * postEffects' `live` map — the film-look e2e section 1 keeps the two in step).
 * @type {Record<string, Record<string, {label: string, min: number, max: number, unit?: string}>>}
 */
export const LIVE_LOOK = {
	vignette: {
		offset: { label: 'Vignette offset', min: 0, max: 1 },
		darkness: { label: 'Vignette darkness', min: 0, max: 1 }
	},
	grain: { opacity: { label: 'Film grain', min: 0, max: 1 } },
	bloom: { intensity: { label: 'Bloom intensity', min: 0, max: 10 } },
	chromaticaberration: {
		offsetX: { label: 'Chromatic aberration X', min: 0, max: 0.02 },
		offsetY: { label: 'Chromatic aberration Y', min: 0, max: 0.02 }
	},
	huesaturation: {
		hue: { label: 'Hue', min: -Math.PI, max: Math.PI, unit: 'rad' },
		saturation: { label: 'Saturation', min: -1, max: 1 }
	},
	brightnesscontrast: {
		brightness: { label: 'Brightness', min: -1, max: 1 },
		contrast: { label: 'Contrast', min: -1, max: 1 }
	},
	letterbox: {
		aspect: { label: 'Letterbox aspect', min: 0.5, max: 4, unit: ':1' },
		opacity: { label: 'Letterbox opacity', min: 0, max: 1 }
	}
};

const hasCamera = (/** @type {any} */ o) => !!o && typeof o === 'object' && !!o.userData?.camera && typeof o.userData.camera === 'object';
const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));

/** @param {string} field @param {string} label @param {string} unit @param {number} def @param {number} min @param {number} max */
function cameraDef(field, label, unit, def, min, max) {
	return /** @type {PropDef} */ ({
		type: 'number',
		label,
		unit,
		min,
		max,
		applies: hasCamera,
		get: (o) => {
			const v = Number(o.userData.camera[field]);
			return Number.isFinite(v) ? v : def;
		},
		set: (o, v) => {
			o.userData.camera[field] = clamp(Number(v), min, max);
		}
	});
}

// ---- the live overrides -------------------------------------------------------

/** "uuid|kind.param" -> value. LOCAL, never saved, never sent. */
const live = new Map();

/** @type {((uuid: string, kind: string, param: string) => number|null)|null} */
let resolver = null;

/**
 * postEffects installs this: the AUTHORED value of `param` on the first `kind` entry of the
 * camera's own look document, or null when that document has no such entry.
 * @param {(uuid: string, kind: string, param: string) => number|null} fn
 */
export function setLookResolver(fn) {
	resolver = fn;
	return () => {
		if (resolver === fn) resolver = null;
	};
}

/** @param {string} uuid @param {string} kind @param {string} param */
function authored(uuid, kind, param) {
	const v = resolver ? resolver(uuid, kind, param) : null;
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The posed value of a look param on a camera, or undefined. @param {string} uuid @param {string} kind @param {string} param */
export function liveLookValue(uuid, kind, param) {
	return live.get(uuid + '|' + kind + '.' + param);
}

/** Is any look param posed (cheap per-frame early-out)? */
export function liveLookActive() {
	return live.size > 0;
}

/** Drop every override (of one camera, or all). @param {string} [uuid] */
export function clearLiveLook(uuid) {
	if (!uuid) return void live.clear();
	for (const key of [...live.keys()]) if (key.startsWith(uuid + '|')) live.delete(key);
}

/** test/debug view */
export function liveLookDebug() {
	return Object.fromEntries(live);
}

/** @param {string} kind @param {string} param */
export function lookPath(kind, param) {
	return 'look.' + kind + '.' + param;
}

/** @param {string} kind @param {string} param @param {{label: string, min: number, max: number, unit?: string}} spec */
function lookDef(kind, param, spec) {
	return /** @type {PropDef} */ ({
		type: 'number',
		label: spec.label,
		unit: spec.unit ?? '',
		min: spec.min,
		max: spec.max,
		applies: (o) => hasCamera(o) && authored(o.uuid, kind, param) !== null,
		get: (o) => {
			const v = live.get(o.uuid + '|' + kind + '.' + param);
			return v !== undefined ? v : authored(o.uuid, kind, param);
		},
		set: (o, v) => {
			const key = o.uuid + '|' + kind + '.' + param;
			const value = clamp(Number(v), spec.min, spec.max);
			// back to the authored value = no override (a released track leaves nothing behind)
			if (value === authored(o.uuid, kind, param)) live.delete(key);
			else live.set(key, value);
		}
	});
}

/** @type {Record<string, PropDef>} */
export const LOOK_PROPS = {
	// identical to 68's defs (same fields, defaults and clamps), so registering over them is a no-op
	'camera.focus': cameraDef('focus', 'Focus distance', 'm', LENS_DEFAULTS.focus, 0.05, 1000),
	'camera.aperture': cameraDef('aperture', 'Aperture', 'f/', 5.6, 0.7, 64),
	'camera.focusPull': cameraDef('focusPull', 'Focus pull time', 's', 0, 0, 10)
};
for (const [kind, params] of Object.entries(LIVE_LOOK))
	for (const [param, spec] of Object.entries(params)) LOOK_PROPS[lookPath(kind, param)] = lookDef(kind, param, spec);

/**
 * 68's registry hook: merge these paths into its allowlist (`propTracks.PROPS`). The int adds
 * `registerLookProps(PROPS)` to propTracks.js; returns the paths it added.
 * @param {Record<string, any>} registry
 */
export function registerLookProps(registry) {
	const added = [];
	for (const [path, def] of Object.entries(LOOK_PROPS)) {
		if (!Object.prototype.hasOwnProperty.call(registry, path)) added.push(path);
		registry[path] = def;
	}
	return added;
}
