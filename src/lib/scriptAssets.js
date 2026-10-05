// 36-code (plan 75.1 + 75.3, contract C1) — SCRIPT FILES, AND THE NODES BOUND TO THEM.
//
// A script FILE is an ordinary Explorer `.js` item, addressed (like every item) by the hash
// of its bytes. A Script or behaviour node can be BOUND to one: it carries
// `data.src = {kind: 'asset', hash, name, from?}` beside `data.code` (G1's CodeSrc, owner
// 36-dataflow — QUESTIONS-36-dataflow #2).
//
// THE CODE STAYS IN THE NODE. `data.code` is what the runtime reads on every peer, the same
// frame, with nothing to fetch — so determinism, late joiners, undo, autosave and .tpscene
// are the node-data paths they already were. The hash NAMES the file the code came from, and
// the invariant is `sha256(data.code) === src.hash` after every save. An async fetch at
// run time was the alternative (plan 75.3 read literally) and would let two peers run
// different code until bytes landed — QUESTIONS-36-code #1.
//
// THE HASH BUMP: saving a file changes its hash, so every node bound to the OLD hash — in
// every graph — gets `{code, src: {kind: 'asset', hash: new, name, from: old}}` through ordinary
// `nodedata`, as ONE undo entry. `from` is the lineage a peer's Explorer uses to make its own
// copy of the file follow (`followScriptBumps`), so the library does not fill with versions.
//
// Not a leaf (stores, Explorer, history); nothing in history's import subtree reaches it.

import { get } from 'svelte/store';
import { allNodes, findNodeAnyGraph, flowGraphs, SCENE_GRAPH } from '../stores/flowStore';
import { setNodeData } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';
import {
	addItemFromBytes,
	updateItemBytes,
	replaceItemBytes,
	itemByHash,
	itemById,
	itemBlob,
	hashBytes,
	loadExplorer,
	activeFolder,
	explorerFolders
} from './explorer';
import { scriptFileName } from './codeTabs';

/** node types whose `data.code` is a source a file can hold */
export const CODE_NODE_TYPES = ['script', 'behaviour'];

/** @param {string} text */
const bytesOf = (text) => /** @type {ArrayBuffer} */ (new TextEncoder().encode(String(text ?? '')).buffer);

/** the content hash of a source, the same number the Explorer keys the file by @param {string} text */
export function hashText(text) {
	return hashBytes(bytesOf(text));
}

/** the node's bound script asset (G1 `data.src` of kind 'asset'), or null
 * @param {any} node @returns {{kind: 'asset', hash: string, name: string, from?: string} | null} */
export function assetSrcOf(node) {
	const src = node?.data?.src;
	return src && src.kind === 'asset' && typeof src.hash === 'string' && src.hash ? src : null;
}

/** @param {string} hash @param {string} name @param {string} [from] */
const assetSrc = (hash, name, from) => ({ kind: 'asset', hash, name, ...(from ? { from } : {}) });

/** every node, in every graph, bound to a file with this hash @param {string} hash
 * @returns {{node: any, graphId: string}[]} */
export function nodesBoundTo(hash) {
	if (!hash) return [];
	return allNodes()
		.filter((n) => assetSrcOf(n)?.hash === hash)
		.map((node) => ({ node, graphId: node.__graph ?? SCENE_GRAPH }));
}

/** @param {string} nodeId @param {string} [graphId] */
function findNode(nodeId, graphId) {
	if (graphId) {
		const g = get(flowGraphs)[graphId];
		const node = g?.nodes.find((/** @type {any} */ n) => n.id === nodeId);
		if (node) return { node, graphId };
	}
	return findNodeAnyGraph((/** @type {any} */ n) => n.id === nodeId);
}

/** where a new script file lands: the folder the Explorer shows when it is a real one, else
 * the root (the app never invents a folder for your work — 21-H1) */
function targetFolder() {
	const id = get(activeFolder);
	return id && get(explorerFolders).some((/** @type {any} */ f) => f.id === id) ? id : null;
}

/** push a file's bytes to every peer's Explorer (assetShare; lazy — it reaches the wire) @param {string} hash */
function pushFile(hash) {
	import('./assetShare').then((m) => m.sendAsset(hash)).catch(() => {});
}

/**
 * Write `{code, src}` on several nodes as ONE undo step and ordinary `nodedata`.
 * @param {{node: any, graphId: string}[]} targets @param {(node: any) => any} patchFor
 */
function writeNodes(targets, patchFor) {
	if (!targets.length) return;
	/** @type {{id: string, graphId: string, before: any, after: any}[]} */
	const items = [];
	for (const { node, graphId } of targets) {
		const after = patchFor(node);
		/** @type {any} */
		const before = {};
		for (const k of Object.keys(after)) before[k] = node.data?.[k] ?? null;
		setNodeData(node.id, after, graphId);
		items.push({ id: node.id, graphId, before, after });
	}
	recordFlowNodesEntry({ op: 'data', graphId: items[0].graphId, items });
}

/**
 * Bind a node to a script file: its code becomes the file's text. `source` is an Explorer
 * item (`{itemId}`) or a hash this device holds (`{hash}`).
 * @param {string} nodeId @param {string | undefined} graphId
 * @param {{itemId?: string, hash?: string}} source
 * @returns {Promise<{hash: string, name: string} | null>}
 */
export async function bindScriptNode(nodeId, graphId, source) {
	await loadExplorer();
	const found = findNode(nodeId, graphId);
	if (!found || !CODE_NODE_TYPES.includes(found.node.type)) return null;
	const item = source.itemId ? itemById(source.itemId) : source.hash ? itemByHash(source.hash) : null;
	if (!item) return null;
	const blob = await itemBlob(item.id);
	if (!blob) return null;
	const code = await blob.text();
	const ref = assetSrc(item.hash, item.name);
	writeNodes([found], () => ({ code, src: ref }));
	pushFile(item.hash);
	return ref;
}

/**
 * "Save as script file": the node's current code becomes an Explorer `.js` item and the node
 * is bound to it. THIS IS THE "MAKE EDITABLE COPY" LANDING CALL — a fork creates the node
 * (with the module's source as its code), then calls this. Bytes we already hold are the SAME
 * file (an item's identity is its hash), so binding to them is the answer, not a duplicate.
 * @param {string} nodeId @param {string} [graphId] @param {string} [name]
 * @returns {Promise<{hash: string, name: string, itemId: string, existed: boolean} | null>}
 */
export async function saveNodeAsScriptFile(nodeId, graphId, name) {
	await loadExplorer();
	const found = findNode(nodeId, graphId);
	if (!found || !CODE_NODE_TYPES.includes(found.node.type)) return null;
	const code = String(found.node.data?.code ?? '');
	const fileName = scriptFileName(name || found.node.data?.name || found.node.type + '-' + String(nodeId).slice(0, 5));
	const hash = await hashText(code);
	const held = itemByHash(hash);
	const item = held ?? (await addItemFromBytes(bytesOf(code), fileName, targetFolder()));
	if (!item) return null;
	const ref = assetSrc(item.hash, item.name);
	writeNodes([found], () => ({ src: ref }));
	pushFile(item.hash);
	return { ...ref, itemId: item.id, existed: !!held };
}

/** Back to inline code: the node keeps its code and forgets the file.
 * @param {string} nodeId @param {string} [graphId] */
export function unbindScriptNode(nodeId, graphId) {
	const found = findNode(nodeId, graphId);
	if (!found || !assetSrcOf(found.node)) return;
	// null, not undefined: nodedata is merged, and an absent key never reaches a peer
	writeNodes([found], () => ({ src: null }));
}

/**
 * Save a script file and HOT-RELOAD every node bound to it (the hash bump).
 * The caller has already parse-checked `code`. `file.hash` is the hash the file had when the
 * editor last saw it — the nodes still bound to that hash are the ones that move.
 * @param {{hash: string, name: string, itemId?: string | null}} file @param {string} code
 * @returns {Promise<{hash: string, itemId: string | null, nodes: number}>}
 */
export async function saveScriptFile(file, code) {
	await loadExplorer();
	const hash = await hashText(code);
	const old = file.hash;
	/** @type {any} */
	let item = (file.itemId && itemById(file.itemId)) || (old && itemByHash(old)) || null;
	if (item && item.hash !== hash) {
		await updateItemBytes(item.id, code);
		item = itemById(item.id);
	} else if (!item) {
		item = itemByHash(hash) ?? (await addItemFromBytes(bytesOf(code), scriptFileName(file.name), targetFolder()));
	}
	const name = item?.name ?? scriptFileName(file.name);
	const bound = old && old !== hash ? nodesBoundTo(old) : [];
	writeNodes(bound, () => ({ code, src: assetSrc(hash, name, old) }));
	return { hash, itemId: item?.id ?? null, nodes: bound.length };
}

// ---------------------------------------------------------------- the peer side of a bump

/** hashes whose follow is in flight, so one graph change cannot start two writes */
const following = new Set();

/**
 * A bump arrived (from a peer, or an undo): a node now names a file `{hash, from}` this
 * device holds only as `from`. That item is the SAME file one save behind — its record
 * follows (bytes replaced in place, same id), the shared library's "an edited copy is the
 * same record with a new hash" rule. Bytes come from the node, so nothing is pulled.
 */
function followScriptBumps() {
	for (const node of allNodes()) {
		const ref = assetSrcOf(node);
		if (!ref?.from || ref.from === ref.hash || following.has(ref.hash)) continue;
		if (itemByHash(ref.hash)) continue;
		const prev = itemByHash(ref.from);
		if (!prev) continue;
		const code = String(node.data?.code ?? '');
		following.add(ref.hash);
		hashText(code)
			.then((h) => (h === ref.hash ? replaceItemBytes(prev.id, bytesOf(code), { type: 'text/plain' }) : null))
			.catch(() => {})
			.finally(() => following.delete(ref.hash));
	}
}

let started = false;
/** boot: watch the graphs for bumps (debounced — a bump is one write per bound node) */
export function startScriptAssets() {
	if (started || typeof window === 'undefined') return;
	started = true;
	/** @type {any} */ let timer = null;
	flowGraphs.subscribe(() => {
		clearTimeout(timer);
		timer = setTimeout(followScriptBumps, 300);
	});
}
