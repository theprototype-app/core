// 36 B7: the `.tpnode` file — a node GROUP (or any selection) saved on its own, to reuse in
// another scene or hand to another person. A zero-import leaf.
//
// The file is the clipboard payload (nodeGroups.copyPayload: serialized nodes + the wires
// between them) with a header; importing it goes through the same instantiatePayload as a
// paste, so every id is fresh and the canonical edge ids are rebuilt. Wires to nodes that
// were not saved are not in the file, by construction.

export const TPNODE_VERSION = 1;
const MAX_NODES = 2000;

/**
 * @param {{nodes: any[], edges: any[]}} payload @param {string} name
 * @param {{app?: string}} [meta]
 */
export function buildTpnode(payload, name, meta = {}) {
	return {
		tpnode: TPNODE_VERSION,
		name: String(name || 'Node group'),
		app: meta.app ?? '',
		created: new Date().toISOString(),
		nodes: payload.nodes,
		edges: payload.edges
	};
}

/** A file name for a group. @param {string} name */
export function tpnodeFileName(name) {
	const base = String(name || 'node-group')
		.trim()
		.replace(/[^\w\- ]+/g, '')
		.replace(/\s+/g, '-')
		.slice(0, 60);
	return (base || 'node-group') + '.tpnode';
}

/**
 * Read a `.tpnode` file. Refuses anything that is not one (a wrong file is the common
 * case — someone drops a .tpscene), a NEWER format, and malformed nodes.
 * @param {string} text
 * @returns {{ok: true, name: string, payload: {nodes: any[], edges: any[]}} | {ok: false, error: string}}
 */
export function parseTpnode(text) {
	/** @type {any} */
	let doc;
	try {
		doc = JSON.parse(String(text));
	} catch {
		return { ok: false, error: 'That file is not a node group (.tpnode)' };
	}
	if (!doc || typeof doc !== 'object' || typeof doc.tpnode !== 'number')
		return { ok: false, error: 'That file is not a node group (.tpnode)' };
	if (doc.tpnode > TPNODE_VERSION)
		return { ok: false, error: 'That node group was saved by a newer version of the app — update to open it' };
	if (!Array.isArray(doc.nodes) || !doc.nodes.length) return { ok: false, error: 'That node group is empty' };
	if (doc.nodes.length > MAX_NODES) return { ok: false, error: 'That node group is too large' };
	const nodes = [];
	for (const n of doc.nodes) {
		if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') return { ok: false, error: 'That node group is damaged' };
		const x = Number(n.position?.x);
		const y = Number(n.position?.y);
		nodes.push({
			id: n.id,
			type: n.type,
			position: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 },
			data: n.data && typeof n.data === 'object' ? n.data : {},
			...(typeof n.class === 'string' ? { class: n.class } : {})
		});
	}
	const ids = new Set(nodes.map((n) => n.id));
	const edges = (Array.isArray(doc.edges) ? doc.edges : []).filter(
		(/** @type {any} */ e) => e && ids.has(e.source) && ids.has(e.target)
	);
	return { ok: true, name: String(doc.name || 'Node group'), payload: { nodes, edges } };
}
