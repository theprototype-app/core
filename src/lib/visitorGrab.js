// Roadmap 71 TR6: may a visitor (the role `viewer`) carry a physics object?
//
// Viewers cannot grab by default. A scene that wants otherwise switches on `play.visitorsGrab`
// (Physics > Visitors can grab objects), and then only DYNAMIC bodies nobody has locked can be taken.
// A build with no roles plugin has no viewers, so nothing here changes it.
//
// Both ends ask the same question. `mayGrab` spares an honest client a carry nobody else would see;
// `visitorMessageAllowed` is what the roles plugin asks about a viewer's message, on every peer.
import { get } from 'svelte/store';
import { canEditObject, isLocalOnly, isViewer } from './objectPermissions';
import { resolvePlaySettings } from './playSettings';
import { globalScene, lockedObjects, objectsGroup } from '../stores/sceneStore';

/** @returns {boolean} the scene's switch, a publisher's word included */
export const visitorsCanGrab = () => /** @type {any} */ (resolvePlaySettings(get(globalScene))).visitorsGrab === true;

/** the switch aside: a body a visitor could take @param {any} object */
const takeable = (object) =>
	object?.userData?.physics?.mode === 'dynamic' &&
	!get(lockedObjects).some((/** @type {any} */ entry) => entry[1] === object.uuid);

/**
 * May the person on THIS page carry or knock this object in Play?
 * @param {any} object @returns {boolean}
 */
export function mayGrab(object) {
	if (!isViewer()) return canEditObject(object);
	return isLocalOnly(object) || (takeable(object) && visitorsCanGrab());
}

/** a carry never resizes, so a `move` that would is not a carry @param {any} object @param {any} scale */
function sameScale(object, scale) {
	if (scale == null) return true;
	if (!Array.isArray(scale) || scale.length !== 3) return false;
	const ours = object.scale.toArray();
	return scale.every((/** @type {any} */ v, /** @type {number} */ i) => Math.abs(Number(v) - ours[i]) < 1e-3);
}

/**
 * Would a visitor's message be part of a grab this scene allows? Unknown objects are refused.
 * @param {any} data a `move`, `throw` or `hit` @returns {boolean}
 */
export function visitorMessageAllowed(data) {
	if (typeof data?.uuid !== 'string' || !visitorsCanGrab()) return false;
	const object = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', data.uuid);
	if (!object || !takeable(object)) return false;
	return data.type !== 'move' || sameScale(object, data.scale);
}
