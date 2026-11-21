// Catalog of all available node types, grouped for the palette and context menu.
// `defaults` seeds node.data on creation (and gets replicated to peers with the node).
// `params` describes the controls rendered by AnimationNode-style generic nodes.
// Modules contribute additional groups through moduleNodeGroups (moduleSDK).

import { get } from 'svelte/store';
import { moduleNodeGroups } from './moduleSDK';
// 34 R2: the kit's node groups (a pure leaf over the piece specs)
import { kitCatalogGroups } from './kit/catalog.js';
// 2.0 N1: the core groups (each family file imports the option lists it spells)
import { coreCatalogGroups } from './nodes/index.js';
/**
 * 2.0 N1: the shapes moved with the core entries into the node registry; re-exported here so every
 * `import('./nodeCatalog').NodeSpec` keeps resolving.
 * @typedef {import('./nodes/registry.js').NodeParam} NodeParam
 * @typedef {import('./nodes/registry.js').NodeSpec} NodeSpec
 */

/**
 * 2.0 N1: the core groups are GENERATED from the node definitions (src/lib/nodes/families/<group>.js,
 * palette order = family order, item order = file order): each entry there is this list's item plus
 * its sockets, card and value. The kit groups follow, generated from the piece specs as before.
 * @type {{ group: string, items: NodeSpec[] }[]}
 */
export const nodeCatalog = [
	...coreCatalogGroups,
	// 34 R2 (T3): the game kit — one group per piece, GENERATED from the piece specs
	// (src/lib/kit/<piece>.spec.js), the same spec that builds api.kit.<piece>
	...kitCatalogGroups()
];

// Node types the animation runtime evaluates every frame (134 adds the base-
// managed object actions: LookAt orients, Set Color paints, Visibility toggles)
export const animationTypes = [
	'shake', 'spin', 'bounce', 'orbit', 'pulse', 'blink', 'pathpatrol',
	'hoveranimate', 'toggleanim', // 78 F2 / F3
	'rotor', 'flowfloat', // 36-fb F25/F24 (sim/motionNodes.js)
	'followpath', 'wander', 'orientvelocity', 'bodywave', // 40 F15 (motion/motionNodes.js)
	'oscillate', 'moveto', 'rotateto', 'scaleto', // 85 N1/N2 (motion/tweenNodes.js)
	'lightswitch', 'lightintensity', 'lightcycle', // 85 N4 (motion/lightNodes.js)
	'windsway', 'waterflow', // 85 N5 (motion/swayNodes.js)
	'ambientanimal', // 85 N3 (motion/ambientNodes.js)
	'highlight', 'pressbutton', // 85 I2 (motion/pressNodes.js)
	'lookat', 'setcolor', 'visibility', 'setuniform',
	'constraintweight', 'constrainttarget', // 102 M7 (rig/constraintRuntime overrides)
	'camerarig', // 37 (R8)
	'deviceparam', 'notetrigger' // 23-B3
];

/**
 * Palette group a node type belongs to — drives the category accent color
 * (built-in groups by name, module groups fall back to the module accent,
 * user-designed custom nodes return null).
 * @param {string} type
 */
export function groupOf(type) {
	for (const group of nodeCatalog)
		if (group.items.some((/** @type {any} */ i) => i.type === type)) return group.group;
	for (const group of get(moduleNodeGroups))
		if (group.items.some((/** @type {any} */ i) => i.type === type)) return group.group;
	return null;
}

/** @param {string} type */
export function findNodeSpec(type) {
	for (const group of nodeCatalog) {
		const item = group.items.find((i) => i.type === type);
		if (item) return item;
	}
	for (const group of get(moduleNodeGroups)) {
		const item = group.items.find((/** @type {any} */ i) => i.type === type);
		if (item) return item;
	}
	return null;
}
