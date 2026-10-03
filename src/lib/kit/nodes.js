// 34 R2 (T3) — the kit's FLOW NODES, all generated from the piece specs (spec.js).
//
//   value   a module value node (moduleNodeIO) — a pure read of the replicated kit document
//   event   a trigger SOURCE (vtype 'event'): the authority pulses it once (runtime.js emit)
//   action  acts on its trigger's STAMP EDGE inside flowRuntime's game-node pass (the
//           setgamestate family, so a fresh node adopting an old stamp does nothing), and every
//           peer that sees the stamp asks the kit with the SAME request id — one change
//
// flowRuntime calls `installKitNodes()` once at start and `runKitNodeAction` on a fresh stamp;
// nodeCatalog lists `kitCatalogGroups()`; Nodes.svelte renders every kit type with the generic
// card (`kitNodeTypes()`).

import { registerModuleValueNode, registerModuleNodeInputs } from '../moduleNodeIO';
import { kitItems } from './catalog.js';
import { kit } from './runtime.js';

export { kitItems };

/** the ACTION types flowRuntime's game-node pass acts for */
export const KIT_ACTION_TYPES = new Set(kitItems().filter((i) => i.kit.kind === 'action').map((i) => i.type));

let installed = false;
/** declare every value/event output and named input to the socket system (once) */
export function installKitNodes() {
	if (installed) return;
	installed = true;
	for (const item of kitItems()) {
		if (item.kit.kind === 'value') {
			registerModuleValueNode(item.type, (/** @type {any} */ data) => kit.evalNodeValue(item.type, data), item.io.output);
		} else if (item.kit.kind === 'event') {
			// a source: what downstream reads is its trigger stamp, which fireModuleTrigger writes
			registerModuleValueNode(item.type, (/** @type {any} */ _d, /** @type {any} */ _t, /** @type {any} */ ctx) => ctx?.trigger?.stamp ?? 0, 'event');
		}
		const inputs = { ...item.io.inputs };
		if (Object.keys(inputs).length) registerModuleNodeInputs(item.type, inputs);
	}
}

/**
 * A kit action node saw a fresh trigger stamp (flowRuntime, every peer).
 * @param {string} type @param {Record<string, any>} data the resolved inputs
 * @param {string} nodeId @param {number} stamp
 */
export function runKitNodeAction(type, data, nodeId, stamp) {
	return kit.runNodeAction(type, data, { rid: 'node:' + nodeId + ':' + stamp });
}
