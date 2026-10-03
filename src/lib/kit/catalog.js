// 34 R2 (T3) — the kit's node CATALOG, generated from the piece specs. A pure LEAF (the kit
// table + the generator only), so nodeCatalog, Nodes.svelte and nodeDocs can read it without
// creating the kit runtime.

import { KIT_PIECES } from './index.js';
import { kitNodeItems } from './spec.js';

/** every generated item, in table order (with its `io` + `kit` description) */
export function kitItems() {
	return KIT_PIECES.flatMap((row) => kitNodeItems(row.piece.spec));
}

/** the palette groups (one per piece), as plain nodeCatalog items */
export function kitCatalogGroups() {
	return KIT_PIECES.map((row) => ({
		group: row.piece.spec.group,
		items: kitNodeItems(row.piece.spec).map(({ io, kit: _k, ...item }) => item)
	}));
}

/** every kit node type (Nodes.svelte maps them to the generic card) */
export function kitNodeTypes() {
	return kitItems().map((item) => item.type);
}

/** the one-line manual of a kit node (its spec `doc`), or '' @param {string} type */
export function kitNodeDoc(type) {
	for (const row of KIT_PIECES)
		for (const call of row.piece.spec.calls) if ('kit-' + row.name + '-' + call.name === type) return call.doc ?? '';
	return '';
}
