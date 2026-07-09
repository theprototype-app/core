import { get } from 'svelte/store';
import { customNodeDefs } from '../stores/flowStore';
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
