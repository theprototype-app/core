import { get } from 'svelte/store';
import { customNodeDefs, flowNodes, flowEdges } from '../stores/flowStore';
import { peers } from '../stores/appStore';

// User-designed node definitions ({id, name, params[], code}) — replicated
// with the annotations pattern: CRUD broadcasts + full sync in the handshake.
// Node instances reference defs by data.defId; the runtime executes def.code.

/** @param {string} id */
export function findNodeDef(id) {
	return get(customNodeDefs).find((def) => def.id === id) ?? null;
}

/** Build node.data defaults for an instance of a def @param {any} def */
export function defDefaults(def) {
	const data = { defId: def.id };
	(def.params ?? []).forEach((param) => {
		data[param.key] = param.kind === 'select' ? param.options?.[0] : param.min ?? 0;
	});
	return data;
}

// --- remote appliers (no re-broadcast) ---

/** @param {any} def */
export function applyNodeDef(def) {
	customNodeDefs.update((defs) => {
		const existing = defs.findIndex((d) => d.id === def.id);
		if (existing >= 0) return defs.map((d, i) => (i === existing ? def : d));
		return [...defs, def];
	});
	// B4.5: a def edit can REMOVE params — prune edges into now-gone input
	// sockets. Runs in the applier so every peer prunes identically (a
	// deterministic invariant, never a broadcast).
	pruneCustomNodeEdges(def.id);
}

/** B4.5: drop edges targeting a custom-node input whose def param no longer
 * exists (deleted-handle edges would dangle + diverge). @param {string} defId */
export function pruneCustomNodeEdges(defId) {
	const def = get(customNodeDefs).find((d) => d.id === defId);
	const valid = new Set((def?.params ?? []).filter((/** @type {any} */ p) => p.kind === 'range').map((/** @type {any} */ p) => p.key));
	const instances = new Set(
		get(flowNodes)
			.filter((n) => n.data?.defId === defId)
			.map((n) => n.id)
	);
	if (!instances.size) return;
	flowEdges.update((edges) =>
		edges.filter((e) => !(instances.has(e.target) && e.targetHandle && !valid.has(e.targetHandle)))
	);
}

/** B4.5: snapshot post-pass — a stale peer's snapshot must not resurrect
 * dangling custom-node edges (drift-heal safe). */
export function pruneAllCustomNodeEdges() {
	get(customNodeDefs).forEach((def) => pruneCustomNodeEdges(def.id));
}

/** @param {string} id */
export function applyNodeDefDelete(id) {
	customNodeDefs.update((defs) => defs.filter((d) => d.id !== id));
}

/** @param {any[]} defs */
export function applyNodeDefsSnapshot(defs) {
	if (Array.isArray(defs)) defs.forEach(applyNodeDef);
}

// --- local actions (apply + broadcast) ---

/** Create or update a definition @param {any} def */
export function saveNodeDef(def) {
	applyNodeDef(def);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'nodedef', def: def });
}

/** @param {string} id */
export function deleteNodeDef(id) {
	applyNodeDefDelete(id);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'nodedefdelete', id: id });
}

/**
 * Send all definitions to a peer (handshake). Retries until the connection
 * back to them is open — earlier messages are dropped by peerjs.
 * @param {string} peerId
 */
export function sendNodeDefs(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const defs = get(customNodeDefs);
	if (defs.length === 0) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendNodeDefs(peerId, attempt + 1), 500);
		return;
	}
	conn.send({ type: 'nodedefs', defs: defs });
}
