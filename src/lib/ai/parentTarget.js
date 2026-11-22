// mcp-diorama2 (item 1) — ONE RULE FOR `parentUuid` IN EVERY AGENT TOOL. It used to be `type === 'Group'`, which a
// group restored from an older autosave (a plain Object3D, see groupRestore.js) failed, and a miss made the object
// at the scene root with only a warning, so a whole model fell apart silently. Now: any object in the scene that
// can hold children (a group, an empty node, a mesh — the object list's drop-onto rule) is a parent; a light or a
// camera is not; a uuid that names nothing is an ERROR and nothing is made.
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';

/**
 * @param {any} uuid the call's parentUuid
 * @returns {{parent: any, group: boolean} | {error: string} | null} null = no parentUuid (or "root")
 */
export function parentTarget(uuid) {
	if (uuid === undefined || uuid === null || uuid === '' || uuid === 'root') return null;
	const root = /** @type {any} */ (get(objectsGroup));
	const parent = root?.getObjectByProperty?.('uuid', String(uuid));
	return checkParent(parent, root);
}

/**
 * The pure half (unit-tested): may `parent` hold a new child?
 * @param {any} parent @param {any} root the scene's objectsGroup
 */
export function checkParent(parent, root) {
	if (!parent || parent === root) return { error: 'parentUuid: no object with that uuid in the scene (list_scene lists them) — nothing was made' };
	if (parent.isLight || parent.isCamera) return { error: 'parentUuid: "' + (parent.name || parent.type) + '" is a ' + (parent.isLight ? 'light' : 'camera') + '; give a group or an object' };
	return { parent, group: !!parent.isGroup };
}
