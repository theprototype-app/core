import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { setShadowMapSize } from './lightParams';

// 37 R1 — MULTI-SELECT v2: the Inspector writes that had NO undo before.
//
// 17-D1 fanned object flags and light rows over the selection, but two families recorded
// nothing: the object FLAGS (visible, cast/receive shadow, render order, frustum culling —
// "No history kind covers these flags, so the batch stays empty") and every LIGHT row (the
// light panel only ever re-sent the whole object). With a set of N that is N objects
// changed by one click and no way back, so each family gets a history kind here, recorded
// per member inside the Inspector's ONE history batch (one undo step for the set) and
// replayed through the SAME wire messages the edit itself sent.
//
// Kept out of objectActions on purpose: its 'props' kind is the merge hot spot every lane
// extends, and these two need nothing from it.

/** the object flags this kind replays; each travels as `objectParameters` */
export const OBJECT_FLAGS = ['visible', 'castShadow', 'receiveShadow', 'renderOrder', 'frustumCulled'];

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/**
 * Write one flag on one object: apply, replicate, and record a `flags` entry (no-op when
 * unchanged). The cast toggle also stamps `userData.shadow` so an opt-out survives the
 * GLTF round-trip (V-1's rule, which the bare flag does not).
 * @param {any} object @param {string} parameter @param {any} value
 * @param {{record?: boolean, before?: any}} [opts] record:false = a scrub's preview frame;
 *   `before` = the value the gesture started from (the scrub's sealing write)
 * @returns {boolean} whether anything changed
 */
export function setObjectFlag(object, parameter, value, opts = {}) {
	if (!object || !OBJECT_FLAGS.includes(parameter)) return false;
	const before = 'before' in opts ? opts.before : object[parameter];
	const changed = object[parameter] !== value;
	if (!changed && before === value) return false;
	writeFlag(object, parameter, value);
	if (opts.record !== false && before !== value)
		recordEntry({ kind: 'flags', uuid: object.uuid, before: { [parameter]: before }, after: { [parameter]: value } });
	return true;
}

/** @param {any} object @param {string} parameter @param {any} value */
function writeFlag(object, parameter, value) {
	object[parameter] = value;
	if (parameter === 'castShadow') {
		if (value) delete object.userData.shadow;
		else object.userData.shadow = false;
	}
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter, uuid: object.uuid, [parameter]: value });
	pokeScene();
}

registerHistoryKind('flags', (entry, state) => {
	const object = objectOf(entry.uuid);
	if (!object) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	for (const key of Object.keys(state ?? {})) if (OBJECT_FLAGS.includes(key)) writeFlag(object, key, state[key]);
	return true;
});

// ---- lights ------------------------------------------------------------------------

/** numeric light fields any light type may carry (LIGHT_PARAMS' keys + intensity) */
const LIGHT_NUMBERS = ['intensity', 'distance', 'decay', 'angle', 'penumbra', 'width', 'height'];

/**
 * Everything the Light section edits, as plain data (the undo snapshot).
 * @param {any} light @returns {Record<string, any>}
 */
export function lightStateOf(light) {
	/** @type {Record<string, any>} */
	const state = { visible: light.visible, castShadow: !!light.castShadow };
	if (light.color?.getHex) state.color = light.color.getHex();
	if (light.groundColor?.getHex) state.groundColor = light.groundColor.getHex();
	for (const key of LIGHT_NUMBERS) if (typeof light[key] === 'number') state[key] = light[key];
	if (light.shadow)
		state.shadow = {
			bias: light.shadow.bias,
			radius: light.shadow.radius,
			mapSize: light.userData?.shadowMapSize ?? light.shadow.mapSize?.x ?? null
		};
	return state;
}

/** @param {any} light @param {Record<string, any>} state */
export function applyLightState(light, state) {
	if (!state) return;
	if ('visible' in state) light.visible = state.visible;
	if ('castShadow' in state) light.castShadow = state.castShadow;
	if (state.color != null && light.color?.setHex) light.color.setHex(state.color);
	if (state.groundColor != null && light.groundColor?.setHex) light.groundColor.setHex(state.groundColor);
	for (const key of LIGHT_NUMBERS) if (typeof state[key] === 'number' && typeof light[key] === 'number') light[key] = state[key];
	if (state.shadow && light.shadow) {
		light.shadow.bias = state.shadow.bias;
		light.shadow.radius = state.shadow.radius;
		if (state.shadow.mapSize) setShadowMapSize(light, state.shadow.mapSize);
	}
}

/** the light panel's replication: the whole object, as it always was @param {any} light */
export function sendLight(light) {
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'object', element: light.toJSON(), override: true });
}

/** @param {Record<string, any>} a @param {Record<string, any>} b */
export function sameLightState(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** record one light's gesture (before → its current state) @param {any} light @param {Record<string, any>} before */
export function recordLightChange(light, before) {
	const after = lightStateOf(light);
	if (sameLightState(before, after)) return false;
	recordEntry({ kind: 'light', uuid: light.uuid, before, after });
	return true;
}

registerHistoryKind('light', (entry, state) => {
	const light = objectOf(entry.uuid);
	if (!light?.isLight) {
		showToast('Cannot undo/redo: the light no longer exists');
		return false;
	}
	applyLightState(light, state);
	sendLight(light);
	pokeScene();
	return true;
});

/**
 * Do the members of `list` disagree on `read`? (the em-dash rule, shared with the
 * Inspector's own `mixed`) @param {(object: any) => any} read @param {any[]} list
 */
export function membersDiffer(read, list) {
	if (!list || list.length < 2) return false;
	const first = read(list[0]);
	return list.some((object) => read(object) !== first);
}

/** Is `read` truthy on EVERY member? (a mixed checkbox reads unchecked) @param {(object: any) => any} read @param {any[]} list */
export function allMembers(read, list) {
	return !!list?.length && list.every((object) => !!read(object));
}
