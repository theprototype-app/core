// 36-fb-code (F6): THE PROJECT TREE — every source the scene has, for the code workspace's left
// sidebar. A LEAF (graphContract + builtinCode, both leaves): it is handed the graphs, the
// Explorer's scripts and a node-spec lookup and hands back a tree, so it is testable with no
// store. Three groups, in the order a person goes looking:
//
//   Graphs        per graph (Main first, then each object's): its Script nodes, Behaviour
//                 nodes and built-ins with code (the Player), and the graph itself as JSON
//   Script files  the Explorer's .js items, with how many nodes run each
//   Modules       the module and kit sources the graphs USE (kit nodes, Code links, module
//                 nodes) — read-only, with "Make editable copy"; a module's full file list
//                 is loaded when it is expanded (`lazy`)
//
// Every leaf carries the `request` openCode takes and a `key` that `keyOfTab` also computes,
// so the tree can mark the source the active tab shows.

import { openCodeRequestFor, nodeHasCode } from './graphContract.js';
import { isBuiltinCodeType, BUILTIN_CODE } from './builtinCode.js';

/**
 * @typedef {{
 *   key: string, label: string, detail?: string,
 *   icon: 'script' | 'behaviour' | 'builtin' | 'graph' | 'file' | 'module' | 'folder',
 *   request?: any, readOnly?: boolean, fork?: 'node' | 'module',
 *   children?: ProjectNode[], lazy?: string
 * }} ProjectNode
 */

/** the scene graph's id in flowGraphs */
const SCENE = 'scene';

/** @param {any} node */
const nodeLabel = (node) => String(node?.data?.name || node?.data?.label || node?.type || 'node');

/** the tree key of a node's source @param {string} graphId @param {string} nodeId */
export const nodeKey = (graphId, nodeId) => 'n:' + (graphId || SCENE) + ':' + nodeId;

/**
 * The tree key of the source a tab shows (the leaf to highlight), or ''.
 * @param {any} tab a CodeTab
 */
export function keyOfTab(tab) {
	if (!tab) return '';
	switch (tab.kind) {
		case 'node':
		case 'behaviour':
			return tab.nodeId ? nodeKey(tab.graphId, tab.nodeId) : '';
		case 'file':
			return tab.itemId ? 'f:' + tab.itemId : tab.hash ? 'h:' + tab.hash : '';
		case 'module':
			return 'm:' + (tab.moduleId || '') + '/' + (tab.name || '');
		case 'graph':
			return 'g:' + (tab.graphId || SCENE);
	}
	return '';
}

/**
 * Which module files the graphs reach: `{moduleId: Set<file>}` (an empty set = the module, no
 * particular file). Kit nodes name `kit/<piece>.js`, Code links and module-bound nodes name
 * their file, a module's own node types name the module.
 * @param {Record<string, {nodes: any[]}>} graphs @param {(type: string) => any} specOf
 * @returns {Map<string, Set<string>>}
 */
export function modulesInUse(graphs, specOf) {
	/** @type {Map<string, Set<string>>} */
	const out = new Map();
	const add = (/** @type {string} */ id, /** @type {string} */ file) => {
		if (!id) return;
		if (!out.has(id)) out.set(id, new Set());
		if (file) out.get(id)?.add(file);
	};
	for (const [graphId, graph] of Object.entries(graphs ?? {})) {
		for (const node of graph?.nodes ?? []) {
			const spec = specOf(String(node.type));
			if (!nodeHasCode(node, spec)) continue;
			const req = openCodeRequestFor(node, graphId, spec);
			if (req?.source !== 'module') continue;
			const ref = String(req.ref ?? '');
			const cut = ref.indexOf('/');
			add(cut < 0 ? ref : ref.slice(0, cut), cut < 0 ? '' : ref.slice(cut + 1));
		}
	}
	return out;
}

/**
 * Build the tree.
 * @param {{
 *   graphs: Record<string, {nodes: any[], edges?: any[]}>,
 *   graphTitle?: (graphId: string) => string,
 *   scripts?: {id: string, name: string, hash?: string}[],
 *   boundCount?: (hash: string) => number,
 *   specOf?: (type: string) => any
 * }} input
 * @returns {ProjectNode[]}
 */
export function projectTree(input) {
	const graphs = input.graphs ?? {};
	const specOf = input.specOf ?? (() => null);
	const title = input.graphTitle ?? ((/** @type {string} */ id) => (id === SCENE ? 'Main graph' : 'Object ' + id.slice(0, 6)));

	/** @type {ProjectNode[]} */
	const graphGroups = [];
	const ids = Object.keys(graphs).sort((a, b) => (a === SCENE ? -1 : b === SCENE ? 1 : title(a).localeCompare(title(b))));
	for (const graphId of ids) {
		/** @type {ProjectNode[]} */
		const leaves = [];
		for (const node of graphs[graphId]?.nodes ?? []) {
			const builtin = isBuiltinCodeType(node.type);
			if (node.type !== 'script' && node.type !== 'behaviour' && !builtin) continue;
			const fromModule = node.data?.src?.kind === 'module';
			const asset = node.data?.src?.kind === 'asset' ? String(node.data.src.name ?? '') : '';
			leaves.push({
				key: nodeKey(graphId, node.id),
				label: nodeLabel(node),
				detail: asset ? '→ ' + asset : builtin ? BUILTIN_CODE[node.type].title + ' code' : node.type === 'behaviour' ? 'behaviour' : 'script',
				icon: builtin ? 'builtin' : node.type === 'behaviour' ? 'behaviour' : 'script',
				request: { source: node.type === 'behaviour' ? 'behaviour' : 'script', ref: { nodeId: node.id, graphId } },
				...(fromModule ? { readOnly: true, fork: /** @type {'node'} */ ('node') } : {})
			});
		}
		leaves.sort((a, b) => a.label.localeCompare(b.label));
		leaves.push({ key: 'g:' + graphId, label: 'graph.json', detail: 'the whole graph as JSON', icon: 'graph', request: { source: 'graph', ref: { graphId } } });
		graphGroups.push({ key: 'grp:' + graphId, label: title(graphId), icon: 'folder', children: leaves });
	}

	const scripts = [...(input.scripts ?? [])].sort((a, b) => a.name.localeCompare(b.name));
	/** @type {ProjectNode[]} */
	const files = scripts.map((item) => {
		const n = item.hash && input.boundCount ? input.boundCount(item.hash) : 0;
		return {
			key: 'f:' + item.id,
			label: item.name,
			...(n ? { detail: n === 1 ? '1 node runs it' : n + ' nodes run it' } : {}),
			icon: /** @type {'file'} */ ('file'),
			request: { source: 'script', ref: { itemId: item.id } }
		};
	});

	/** @type {ProjectNode[]} */
	const modules = [];
	for (const [moduleId, used] of [...modulesInUse(graphs, specOf)].sort((a, b) => a[0].localeCompare(b[0]))) {
		modules.push({
			key: 'mod:' + moduleId,
			label: moduleId,
			detail: 'read-only',
			icon: 'folder',
			lazy: moduleId,
			readOnly: true,
			children: [...used].sort().map((file) => moduleLeaf(moduleId, file))
		});
	}

	/** @type {ProjectNode[]} */
	const tree = [{ key: 'grp:graphs', label: 'Graphs', icon: 'folder', children: graphGroups }];
	tree.push({ key: 'grp:files', label: 'Script files', icon: 'folder', children: files });
	if (modules.length) tree.push({ key: 'grp:modules', label: 'Module sources', icon: 'folder', children: modules });
	return tree;
}

/** one read-only module file @param {string} moduleId @param {string} file @returns {ProjectNode} */
export function moduleLeaf(moduleId, file) {
	return {
		key: 'm:' + moduleId + '/' + file,
		label: file,
		icon: 'module',
		readOnly: true,
		fork: 'module',
		request: { source: 'module', ref: { moduleId, name: file } }
	};
}

/**
 * The tree filtered by a search: a leaf stays when every word is in its label, its detail or
 * the folders above it (below the top groups — "minigolf rules" finds minigolf's rules.js); a
 * group stays when anything under it does (the caller shows a filtered group expanded). An
 * empty query returns the tree unchanged.
 * @param {ProjectNode[]} tree @param {string} query @returns {ProjectNode[]}
 */
export function filterTree(tree, query) {
	const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return tree;
	/** @param {ProjectNode} n @param {string} path */
	const hit = (n, path) => {
		const text = (path + ' ' + n.label + ' ' + (n.detail ?? '')).toLowerCase();
		return words.every((w) => text.includes(w));
	};
	/** @param {ProjectNode[]} list @param {string} path @returns {ProjectNode[]} */
	const walk = (list, path) =>
		list.flatMap((n) => {
			if (!n.children) return hit(n, path) ? [n] : [];
			const kids = walk(n.children, path + ' ' + n.label);
			return kids.length ? [{ ...n, children: kids }] : [];
		});
	// the top groups' own names are not part of a path (every leaf would match "graphs")
	return tree.flatMap((g) => {
		if (!g.children) return hit(g, '') ? [g] : [];
		const kids = walk(g.children, '');
		return kids.length ? [{ ...g, children: kids }] : [];
	});
}

/** every leaf of a tree, depth first @param {ProjectNode[]} tree @returns {ProjectNode[]} */
export function leavesOf(tree) {
	return tree.flatMap((n) => (n.children ? leavesOf(n.children) : [n]));
}

/**
 * 36-fb-code (S7): the Ctrl+P list — every leaf that opens something, its folders as the detail
 * ("Main graph", "Module sources › minigolf"), so two `rules.js` can be told apart.
 * @param {ProjectNode[]} tree @returns {(ProjectNode & {detail: string})[]}
 */
export function quickItems(tree) {
	/** @type {(ProjectNode & {detail: string})[]} */
	const out = [];
	/** @param {ProjectNode[]} list @param {string[]} path */
	const walk = (list, path) => {
		for (const n of list) {
			if (n.children) walk(n.children, [...path, n.label]);
			else if (n.request) out.push({ ...n, detail: path.slice(1).join(' › ') || path[0] || '' });
		}
	};
	walk(tree, []);
	return out;
}
