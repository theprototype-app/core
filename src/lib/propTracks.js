// 68 — the ALLOWLISTED property registry behind the sequencer's `prop` tracks
// (design note: cloud plans/core/pending/keyframe-model.md, "Path").
//
// Imports nothing (unit layer). A prop track names a `path`; the path is a KEY into this
// registry — get / set / type / units / a post-set hook — never a free three.js path walk:
// a peer must not be able to set any field on any object through a sequence document.
// An unknown path does nothing. The Animation window's channel ids are ALIASES here
// (`pos.x` → `position.x`), so 65 M1 and 57 can move their tracks onto the same model.
//
// Camera paths live on the camera MARKER's `userData.camera` (16-P5: the marker is the
// camera), so recording, playback, saves and undo need nothing new: CameraPreview reads
// fov / roll / focus off the marker each frame.

/** @typedef {{type: string, label: string, unit?: string, get: (o: any) => any, set: (o: any, v: any) => void, applies: (o: any) => boolean, min?: number, max?: number}} PropDef */

const isObj = (/** @type {any} */ o) => !!o && typeof o === 'object';
const hasCamera = (/** @type {any} */ o) => isObj(o?.userData?.camera);
const hasXYZ = (/** @type {any} */ v) => isObj(v) && typeof v.x === 'number';

/** @param {string} key 'position' | 'scale' @param {string} label */
function vec3Def(key, label) {
	return /** @type {PropDef} */ ({
		type: 'vec3',
		label,
		unit: key === 'position' ? 'm' : '',
		applies: (o) => hasXYZ(o?.[key]),
		get: (o) => [o[key].x, o[key].y, o[key].z],
		set: (o, v) => {
			o[key].x = v[0];
			o[key].y = v[1];
			o[key].z = v[2];
		}
	});
}

/** @param {string} key @param {'x'|'y'|'z'} axis @param {string} label @param {string} unit */
function axisDef(key, axis, label, unit) {
	return /** @type {PropDef} */ ({
		type: 'number',
		label,
		unit,
		applies: (o) => hasXYZ(o?.[key]),
		get: (o) => o[key][axis],
		set: (o, v) => {
			o[key][axis] = v;
		}
	});
}

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
			o.userData.camera[field] = Math.min(max, Math.max(min, Number(v)));
		}
	});
}

/** @type {Record<string, PropDef>} */
export const PROPS = {
	position: vec3Def('position', 'Position'),
	'position.x': axisDef('position', 'x', 'Position X', 'm'),
	'position.y': axisDef('position', 'y', 'Position Y', 'm'),
	'position.z': axisDef('position', 'z', 'Position Z', 'm'),
	quaternion: {
		type: 'quat',
		label: 'Rotation',
		applies: (o) => isObj(o?.quaternion) && typeof o.quaternion.w === 'number',
		get: (o) => [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
		set: (o, v) => {
			// set() when it exists, so a three Quaternion fires its onChange → the Euler follows
			if (typeof o.quaternion.set === 'function') o.quaternion.set(v[0], v[1], v[2], v[3]);
			else Object.assign(o.quaternion, { x: v[0], y: v[1], z: v[2], w: v[3] });
		}
	},
	'rotation.x': axisDef('rotation', 'x', 'Rotation X', 'rad'),
	'rotation.y': axisDef('rotation', 'y', 'Rotation Y', 'rad'),
	'rotation.z': axisDef('rotation', 'z', 'Rotation Z', 'rad'),
	scale: vec3Def('scale', 'Scale'),
	visible: {
		type: 'step',
		label: 'Visible',
		applies: (o) => isObj(o) && 'visible' in o,
		get: (o) => (o.visible ? 1 : 0),
		set: (o, v) => {
			o.visible = !!v;
		}
	},
	'camera.fov': cameraDef('fov', 'Field of view', '°', 50, 1, 179),
	'camera.focus': cameraDef('focus', 'Focus distance', 'm', 10, 0.05, 1000),
	'camera.aperture': cameraDef('aperture', 'Aperture', 'f/', 5.6, 0.7, 64),
	'camera.roll': cameraDef('roll', 'Dutch roll', '°', 0, -180, 180),
	'camera.exposure': cameraDef('exposure', 'Exposure', 'EV', 0, -5, 5)
};

/** The Animation window's channel ids → registry paths. */
export const ALIASES = /** @type {Record<string, string>} */ ({
	'pos.x': 'position.x',
	'pos.y': 'position.y',
	'pos.z': 'position.z',
	'rot.x': 'rotation.x',
	'rot.y': 'rotation.y',
	'rot.z': 'rotation.z'
});

/** The canonical path for a name (alias resolved), or '' when it is not allowlisted. @param {string} path */
export function resolvePath(path) {
	const p = ALIASES[path] ?? path;
	return Object.prototype.hasOwnProperty.call(PROPS, p) ? p : '';
}

/** @param {string} path @returns {PropDef|null} */
export function propDef(path) {
	const p = resolvePath(path);
	return p ? PROPS[p] : null;
}

/** The curve type a path animates with ('' = not allowlisted). @param {string} path */
export function propType(path) {
	return propDef(path)?.type ?? '';
}

/** @param {any} object @param {string} path */
export function propApplies(object, path) {
	const def = propDef(path);
	return !!def && def.applies(object);
}

/** Read a property (null when the path is unknown or does not apply). @param {any} object @param {string} path */
export function getProp(object, path) {
	const def = propDef(path);
	if (!def || !def.applies(object)) return null;
	return def.get(object);
}

/**
 * Write a property. Refuses an unknown path, an object it does not apply to, and a value of
 * the wrong shape. @param {any} object @param {string} path @param {any} value @returns {boolean}
 */
export function setProp(object, path, value) {
	const def = propDef(path);
	if (!def || !def.applies(object)) return false;
	if (def.type === 'number' && !Number.isFinite(Number(value))) return false;
	if ((def.type === 'vec3' || def.type === 'color') && !(Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)))
		return false;
	if (def.type === 'quat' && !(Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every(Number.isFinite))) return false;
	def.set(object, def.type === 'number' ? Number(value) : value);
	return true;
}

/** Paths that apply to an object, for menus. @param {any} object */
export function pathsFor(object) {
	return Object.keys(PROPS).filter((p) => PROPS[p].applies(object));
}

/** The camera paths a Film take records (each its own track). */
export const FILM_PATHS = Object.freeze(['position', 'quaternion', 'camera.fov', 'camera.focus', 'camera.aperture', 'camera.roll']);
