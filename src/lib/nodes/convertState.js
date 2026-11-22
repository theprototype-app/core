// 2.0-int (boot size): what the node menu offers for a node (Convert to code / Convert back / edited),
// split from convertCode.js so a right-click does not pull the planner, the code printer and the
// reference bodies onto the editor boot; those load with the first Convert. A LEAF over referenceShape.js.

import { REFERENCE_TYPES, referenceShape } from './referenceShape.js';

/** the node types Convert to code accepts */
export const CONVERTIBLE = new Set(REFERENCE_TYPES);

/**
 * Is `node` a converted Script node whose code and sockets are still what Convert wrote?
 * @param {any} node
 */
export function isUnchangedConversion(node) {
	const from = node?.data?.convertedFrom;
	if (node?.type !== 'script' || !from || typeof from !== 'object') return false;
	if (typeof from.code !== 'string' || node.data.code !== from.code) return false;
	const shape = referenceShape(from.type, from.data, new Set(from.wired ?? []));
	if (!shape) return false;
	return (
		JSON.stringify(node.data.inputs ?? null) === JSON.stringify(shape.inputs) &&
		JSON.stringify(node.data.outputs ?? null) === JSON.stringify(shape.outputs)
	);
}

/** What the node menu offers for `node`: 'convert', 'back', 'changed' (converted, edited) or null.
 * A HUD Text answers 'back' when a format script made from it still stands in front of it.
 * @param {any} node @param {{nodes: any[]}} [graph] */
export function conversionState(node, graph) {
	if (!node) return null;
	if (node.type === 'hudtext') {
		const script = graph?.nodes?.find((n) => n.type === 'script' && n.data?.convertedFrom?.target === node.id);
		if (script) return isUnchangedConversion(script) ? 'back' : 'changed';
		return 'convert';
	}
	if (CONVERTIBLE.has(node.type)) return 'convert';
	if (node.type === 'script' && node.data?.convertedFrom) return isUnchangedConversion(node) ? 'back' : 'changed';
	return null;
}
