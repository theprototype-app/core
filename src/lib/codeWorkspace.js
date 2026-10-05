// 36-code (plan 75.2-75.4 + U10's code half, contract C1) — THE CODE WORKSPACE.
//
// One notebook of sources, each a TAB that buffers its text until Ctrl+S:
//   node       an inline Script node's code
//   behaviour  a behaviour node's module
//   file       a script FILE (an Explorer .js item) — shared by every node bound to it
//   module     a module's behaviour source, READ-ONLY, with "Make editable copy"
//   graph      a flow graph as JSON (B6) — Ctrl+S applies it; invalid JSON never applies
// The tab model (identity, the external-edit rule, the parse check, graph JSON) is the leaf
// `codeTabs.js`; the files and the hash bump are `scriptAssets.js`; this module is the stores,
// the open/save/close verbs and the follow-the-source watch. The UI is CodeWorkspace.svelte.
//
// THE ENTRY POINT other lanes call: `openCode({source, ref, line?})` (G1: a double-click on a
// script / behaviour / kit node opens its code here). `scriptEditorOpen.set(nodeId)` — the old
// ScriptPanel seam — still works: it opens that node's tab.
//
// SAVE NEVER APPLIES BROKEN CODE: a failed parse keeps the buffer dirty, badges the tab and
// every node it would have reloaded (`scriptFileErrors`, beside the runtime's `scriptErrors`),
// and the nodes keep running the last good version (QUESTIONS-36-code #2).

import { writable, get } from 'svelte/store';
import {
	flowGraphs,
	scriptEditorOpen,
	scriptFileErrors,
	customNodeDefs,
	nodeDesignerOpen,
	SCENE_GRAPH,
	findNodeAnyGraph,
	setActiveGraph
} from '../stores/flowStore';
import { codeWorkspaceClose, showToast, focusFlowNode } from '../stores/appStore';
import { setNodeData, serializeNode, serializeEdge } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';
import { safeStorage } from './safeStorage';
import {
	findTab,
	isDirty,
	reconcileExternal,
	reloadTab,
	nextActiveAfterClose,
	parseCheck,
	parseGraphJson,
	graphJson,
	normalizeCodeRequest
} from './codeTabs';
export { normalizeCodeRequest };
import {
	assetSrcOf,
	nodesBoundTo,
	saveScriptFile,
	saveNodeAsScriptFile,
	bindScriptNode,
	unbindScriptNode,
	startScriptAssets
} from './scriptAssets';
import { itemByHash, itemById, itemBlob, explorerItems, loadExplorer } from './explorer';

/** @typedef {import('./codeTabs').CodeTab} CodeTab */

/** @type {import('svelte/store').Writable<CodeTab[]>} */
export const codeTabs = writable([]);
/** @type {import('svelte/store').Writable<string | null>} */
export const activeCodeTab = writable(null);
/** nodeId -> why the last save did not reach it (lives in flowStore, beside scriptErrors) */
export { scriptFileErrors };
/** bumped when an already-open tab is asked for again: the window raises (the previewRaise shape) */
export const codeWorkspaceRaise = writable(0);
/** a line to reveal in a tab, write-once: `{tabId, line, token}` @type {import('svelte/store').Writable<any>} */
export const codeRevealLine = writable(null);

/** LOCAL pref: inline node/behaviour tabs apply as you type (debounced) instead of on Ctrl+S */
export const codeApplyLive = writable(safeStorage.getItem('code:applyLive') === 'true');
codeApplyLive.subscribe((v) => safeStorage.setItem('code:applyLive', String(!!v)));

let seq = 0;
let lineToken = 0;

// ---------------------------------------------------------------- sources other lanes provide

/** @type {Map<string, {resolve?: (ref: any) => Promise<{title?: string, code: string} | null>, fork?: (ref: any, code: string) => Promise<{source: string, ref: any} | null>}>} */
const sources = new Map();

/**
 * Teach the workspace a source it cannot read itself. 36-dataflow registers 'module': how to
 * fetch a module behaviour's source, and the FORK behind "Make editable copy" (create the
 * editable node/file, return what to open). Returns a disposer.
 * @param {string} source @param {{resolve?: (ref: any) => Promise<any>, fork?: (ref: any, code: string) => Promise<any>}} impl
 */
export function registerCodeSource(source, impl) {
	sources.set(source, impl);
	return () => {
		if (sources.get(source) === impl) sources.delete(source);
	};
}

// the raw sources of every core module (lazy chunks, loaded only when one is opened) — the
// ModulesManager download precedent — so a module's code is readable with nothing registered
const coreModuleSources = import.meta.glob('../modules/**/*.js', { query: '?raw', import: 'default' });

/**
 * The default 'module' resolver: a core module's file, else an installed user module's file
 * (`name` = a path inside the module, absent = its entry). A registered resolver wins.
 * @param {{moduleId?: string, name?: string}} ref @returns {Promise<{title: string, code: string} | null>}
 */
async function builtinModuleSource(ref) {
	const id = String(ref.moduleId ?? '');
	if (!id) return null;
	const file = ref.name || 'module.js';
	const loader = coreModuleSources['../modules/' + id + '/' + file];
	if (loader) return { title: id + '/' + file, code: String(await loader()) };
	const { userModules } = await import('./userModules');
	const record = get(userModules).find((/** @type {any} */ r) => r.id === id);
	const bytes = record?.files?.[ref.name || record?.entry];
	if (!bytes) return null;
	return { title: id + '/' + (ref.name || record.entry), code: typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes) };
}

/** does a source have a fork hook (the button shows only then) @param {string} source */
export function canFork(source) {
	return typeof sources.get(source)?.fork === 'function';
}

// ---------------------------------------------------------------- opening

/** @param {string} nodeId @param {string} [graphId] */
function findNode(nodeId, graphId) {
	if (graphId) {
		const node = get(flowGraphs)[graphId]?.nodes.find((/** @type {any} */ n) => n.id === nodeId);
		if (node) return { node, graphId };
	}
	return findNodeAnyGraph((/** @type {any} */ n) => n.id === nodeId);
}

/** @param {string} graphId */
function serializedGraph(graphId) {
	const g = get(flowGraphs)[graphId] ?? { nodes: [], edges: [] };
	return { nodes: g.nodes.map(serializeNode), edges: g.edges.map(serializeEdge) };
}

/** a label for a graph: the scene, or the owner object's name @param {string} graphId */
async function graphTitle(graphId) {
	if (graphId === SCENE_GRAPH) return 'Main graph.json'; // G1: the scene graph IS Main
	try {
		const { objectsGroup } = await import('../stores/sceneStore');
		/** @type {any} */
		const g = get(objectsGroup);
		const o = g?.getObjectByProperty?.('uuid', graphId);
		return (o?.name || 'Object ' + graphId.slice(0, 6)) + ' graph.json';
	} catch {
		return 'Graph ' + graphId.slice(0, 6) + '.json';
	}
}

/**
 * Resolve a request into a tab (without adding it). null = nothing to open.
 * @param {{source: string, ref: any}} req @returns {Promise<CodeTab | null>}
 */
async function resolve(req) {
	const ref = req.ref ?? {};
	const id = 'code-' + ++seq;
	if (req.source === 'graph') {
		const graphId = ref.graphId ?? SCENE_GRAPH;
		const text = graphJson(serializedGraph(graphId));
		return { id, kind: 'graph', title: await graphTitle(graphId), lang: 'json', code: text, saved: text, graphId };
	}
	if (req.source === 'module') {
		const impl = sources.get('module');
		/** @type {any} */
		const got =
			(typeof ref.code === 'string' ? { code: ref.code } : null) ??
			(impl?.resolve ? await impl.resolve(ref).catch(() => null) : null) ??
			(await builtinModuleSource(ref).catch(() => null));
		if (!got) return null;
		const name = ref.name ?? got.title ?? ref.moduleId ?? 'module';
		const code = String(got.code ?? '');
		return { id, kind: 'module', title: got.title ?? name, lang: 'js', code, saved: code, readOnly: true, moduleId: ref.moduleId ?? '', name };
	}
	// script / behaviour
	if (ref.nodeId) {
		const found = findNode(ref.nodeId, ref.graphId);
		if (!found) return null;
		const { node, graphId } = found;
		const code = String(node.data?.code ?? '');
		const bound = assetSrcOf(node);
		if (bound) {
			await loadExplorer();
			return {
				id, kind: 'file', title: bound.name, lang: 'js', code, saved: code,
				hash: bound.hash, name: bound.name, itemId: itemByHash(bound.hash)?.id ?? null,
				fromNode: { nodeId: node.id, graphId }
			};
		}
		const behaviour = node.type === 'behaviour';
		const title = (node.data?.name || node.data?.label || (behaviour ? 'Behaviour' : 'Script')) + (behaviour ? '.behaviour.js' : '.js');
		return { id, kind: behaviour ? 'behaviour' : 'node', title, lang: 'js', code, saved: code, nodeId: node.id, graphId };
	}
	await loadExplorer();
	const item = (ref.itemId ? itemById(ref.itemId) : null) ?? (ref.hash ? itemByHash(ref.hash) : null);
	if (item) {
		const blob = await itemBlob(item.id);
		const code = blob ? await blob.text() : '';
		return { id, kind: 'file', title: item.name, lang: 'js', code, saved: code, hash: item.hash, name: item.name, itemId: item.id };
	}
	// a peer's file we hold no copy of: the bound nodes carry its text
	const bound = ref.hash ? nodesBoundTo(ref.hash) : [];
	if (!bound.length) return null;
	const code = String(bound[0].node.data?.code ?? '');
	const name = assetSrcOf(bound[0].node)?.name ?? ref.name ?? 'script.js';
	return { id, kind: 'file', title: name, lang: 'js', code, saved: code, hash: ref.hash, name, itemId: null };
}

/**
 * OPEN SOURCE CODE IN THE WORKSPACE — the G1 entry point. Raises an already-open tab.
 * `ref` is an object (`{nodeId, graphId?}` · `{itemId}` · `{hash}` · `{moduleId, name?, code?}`
 * · `{graphId}`) or G1's string form (see `normalizeCodeRequest`).
 * @param {{source: 'script' | 'behaviour' | 'module' | 'graph' | 'customnode', ref: any, graphId?: string, line?: number, readonly?: boolean}} request
 * @returns {Promise<string | null>} the tab id
 */
export async function openCode(request) {
	startCodeWorkspace();
	const req = normalizeCodeRequest(request);
	if (req.source === 'customnode') {
		// a custom node's code is its DEF's, edited where defs are (NodeDesigner)
		const def = get(customNodeDefs).find((/** @type {any} */ d) => d.id === req.ref.defId);
		if (def) nodeDesignerOpen.set(/** @type {any} */ (def));
		return null;
	}
	const tab = await resolve(req);
	if (!tab) {
		showToast('Nothing to open: that source is gone');
		return null;
	}
	const spec = tab.kind === 'node' || tab.kind === 'behaviour' ? { kind: tab.kind, nodeId: tab.nodeId, graphId: tab.graphId } : tab;
	const held = findTab(get(codeTabs), spec);
	const tabId = held?.id ?? tab.id;
	if (!held) codeTabs.update((list) => [...list, tab]);
	else codeWorkspaceRaise.update((n) => n + 1);
	activeCodeTab.set(tabId);
	codeWorkspaceClose.set(false);
	import('./bottomDock').then((m) => m.activateDock('code')).catch(() => {});
	if (req.line) codeRevealLine.set({ tabId, line: req.line, token: ++lineToken });
	return tabId;
}

// ---------------------------------------------------------------- editing / closing

/** @param {string} id @param {(t: CodeTab) => CodeTab} fn */
function patchTab(id, fn) {
	codeTabs.update((list) => list.map((t) => (t.id === id ? fn(t) : t)));
}
/** @param {string} id */
export const tabById = (id) => get(codeTabs).find((t) => t.id === id) ?? null;

/** @type {Map<string, any>} */
const liveTimers = new Map();

/** the editor's text changed @param {string} id @param {string} code */
export function setTabCode(id, code) {
	patchTab(id, (t) => (t.readOnly ? t : { ...t, code }));
	const tab = tabById(id);
	if (!tab || !get(codeApplyLive) || (tab.kind !== 'node' && tab.kind !== 'behaviour')) return;
	clearTimeout(liveTimers.get(id));
	liveTimers.set(id, setTimeout(() => saveCodeTab(id, { quiet: true }), 500));
}

/** throw away edits for the source's text @param {string} id */
export function reloadCodeTab(id) {
	patchTab(id, reloadTab);
}

/** Close a tab. A dirty one only with `force` (the UI asks first). @param {string} id @param {{force?: boolean}} [opts] */
export function closeCodeTab(id, opts = {}) {
	const tab = tabById(id);
	if (!tab) return true;
	if (isDirty(tab) && !opts.force) return false;
	const list = get(codeTabs);
	activeCodeTab.set(nextActiveAfterClose(list, id, get(activeCodeTab)));
	codeTabs.set(list.filter((t) => t.id !== id));
	clearTimeout(liveTimers.get(id));
	if (!get(codeTabs).length) codeWorkspaceClose.set(true);
	return true;
}

// ---------------------------------------------------------------- saving

/** the nodes a tab writes to @param {CodeTab} tab @returns {{node: any, graphId: string}[]} */
export function boundNodesOf(tab) {
	if (tab.kind === 'node' || tab.kind === 'behaviour') {
		const f = tab.nodeId ? findNode(tab.nodeId, tab.graphId) : null;
		return f ? [f] : [];
	}
	if (tab.kind === 'file') return nodesBoundTo(tab.hash ?? '');
	return [];
}

/** a file is a behaviour module when a behaviour node holds it, or it reads like one @param {CodeTab} tab */
function parseKindOf(tab) {
	if (tab.kind === 'graph') return 'json';
	if (tab.kind === 'behaviour') return 'behaviour';
	if (tab.kind === 'node') return 'script';
	const bound = boundNodesOf(tab);
	if (bound.some((b) => b.node.type === 'behaviour')) return 'behaviour';
	if (bound.length) return 'script';
	return /^\s*export\s+default\b/m.test(tab.code) ? 'behaviour' : 'script';
}

/** @param {string[]} nodeIds @param {string | null} message */
function markNodes(nodeIds, message) {
	scriptFileErrors.update((map) => {
		const next = { ...map };
		for (const id of nodeIds) {
			if (message) next[id] = message;
			else delete next[id];
		}
		return next;
	});
}

/**
 * Ctrl+S: re-validate, write, and hot-reload what the tab feeds. A failed check writes
 * NOTHING (the buffer stays dirty, the badges say why).
 * @param {string} id @param {{quiet?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, error?: import('./codeTabs').CodeError, nodes?: number}>}
 */
export function saveCodeTab(id, opts = {}) {
	// one save per tab at a time: a file save is several awaits long, and two interleaved
	// would both bump from the same old hash
	const prev = saving.get(id) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(() => saveNow(id, opts));
	saving.set(id, next);
	next.finally(() => saving.get(id) === next && saving.delete(id));
	return next;
}
/** @type {Map<string, Promise<any>>} */
const saving = new Map();

/** @param {string} id @param {{quiet?: boolean}} opts
 * @returns {Promise<{ok: boolean, error?: import('./codeTabs').CodeError, nodes?: number}>} */
async function saveNow(id, opts) {
	const tab = tabById(id);
	if (!tab) return { ok: false };
	if (tab.readOnly) {
		if (!opts.quiet) showToast('This source is read-only — use "Make editable copy" to change it');
		return { ok: false };
	}
	const code = tab.code;
	const bound = boundNodesOf(tab);
	const ids = bound.map((b) => b.node.id);

	if (tab.kind === 'graph') {
		const graphId = tab.graphId ?? SCENE_GRAPH;
		const result = parseGraphJson(code, serializedGraph(graphId));
		if (!result.ok) {
			patchTab(id, (t) => ({ ...t, error: result.error }));
			return { ok: false, error: result.error };
		}
		if (result.changed) {
			const { applyGraphJson } = await import('./graphJsonApply');
			applyGraphJson(graphId, result);
		}
		patchTab(id, (t) => ({ ...t, saved: code, error: null, stale: false, external: undefined }));
		return { ok: true };
	}

	const error = parseCheck(code, /** @type {'script' | 'behaviour'} */ (parseKindOf(tab)));
	if (error) {
		patchTab(id, (t) => ({ ...t, error }));
		markNodes(ids, 'edit not applied — line ' + error.line + ': ' + error.message);
		return { ok: false, error };
	}

	if (tab.kind === 'file') {
		const out = await saveScriptFile({ hash: tab.hash ?? '', name: tab.name ?? tab.title, itemId: tab.itemId }, code);
		patchTab(id, (t) => ({ ...t, hash: out.hash, itemId: out.itemId, saved: code, error: null, stale: false, external: undefined }));
		markNodes(ids, null);
		return { ok: true, nodes: out.nodes };
	}

	// an inline node (script or behaviour) — unless it has been bound since the tab opened
	const target = bound[0];
	if (!target) {
		patchTab(id, (t) => ({ ...t, error: { message: 'The node this tab edits is gone', line: 1 } }));
		return { ok: false };
	}
	const ref = assetSrcOf(target.node);
	if (ref) {
		const out = await saveScriptFile({ hash: ref.hash, name: ref.name }, code);
		patchTab(id, (t) => ({ ...t, saved: code, error: null, stale: false, external: undefined }));
		markNodes(ids, null);
		return { ok: true, nodes: out.nodes };
	}
	const before = String(target.node.data?.code ?? '');
	if (before !== code) {
		setNodeData(target.node.id, { code }, target.graphId);
		recordFlowNodesEntry({ op: 'data', graphId: target.graphId, items: [{ id: target.node.id, before: { code: before }, after: { code } }] });
	}
	patchTab(id, (t) => ({ ...t, saved: code, error: null, stale: false, external: undefined }));
	markNodes(ids, null);
	return { ok: true, nodes: 1 };
}

// ---------------------------------------------------------------- files <-> nodes

/** "Save as script file" for an inline node tab; the tab becomes the file's tab @param {string} id */
export async function convertTabToFile(id) {
	const tab = tabById(id);
	if (!tab?.nodeId || (tab.kind !== 'node' && tab.kind !== 'behaviour')) return null;
	if (isDirty(tab)) {
		const saved = await saveCodeTab(id);
		if (!saved.ok) return null;
	}
	const out = await saveNodeAsScriptFile(tab.nodeId, tab.graphId);
	if (!out) return null;
	const fromNode = { nodeId: tab.nodeId, graphId: tab.graphId ?? SCENE_GRAPH };
	patchTab(id, (t) => ({ ...t, kind: 'file', title: out.name, name: out.name, hash: out.hash, itemId: out.itemId, fromNode, nodeId: undefined }));
	showToast(out.existed ? 'Bound to ' + out.name + ' (already in your Library)' : 'Saved as ' + out.name + ' in the Explorer');
	return out;
}

/** bind the tab's node to an Explorer script @param {string} id @param {{itemId?: string, hash?: string}} source */
export async function bindTabToFile(id, source) {
	const tab = tabById(id);
	const nodeId = tab?.nodeId ?? tab?.fromNode?.nodeId;
	if (!tab || !nodeId) return null;
	const graphId = tab.graphId ?? tab.fromNode?.graphId;
	const ref = await bindScriptNode(nodeId, graphId, source);
	if (!ref) return null;
	closeCodeTab(id, { force: true });
	return openCode({ source: 'script', ref: { nodeId, graphId } });
}

/** back to inline code: the file tab of `node` becomes a node tab @param {string} id */
export async function unbindTab(id) {
	const tab = tabById(id);
	const from = tab?.fromNode ?? (tab ? boundNodesOf(tab)[0] && { nodeId: boundNodesOf(tab)[0].node.id, graphId: boundNodesOf(tab)[0].graphId } : null);
	if (!tab || !from) return null;
	unbindScriptNode(from.nodeId, from.graphId);
	closeCodeTab(id, { force: true });
	return openCode({ source: 'script', ref: from });
}

/** "Make editable copy" of a read-only module tab — 36-dataflow's fork does the copy @param {string} id */
export async function forkCodeTab(id) {
	const tab = tabById(id);
	if (!tab || tab.kind !== 'module') return null;
	const fork = sources.get('module')?.fork;
	if (!fork) {
		showToast('Editable copies of module code are not available in this build');
		return null;
	}
	const target = await fork({ moduleId: tab.moduleId, name: tab.name }, tab.code).catch((e) => {
		showToast('Could not make an editable copy: ' + (e?.message ?? e));
		return null;
	});
	if (!target) return null;
	return openCode(/** @type {any} */ (target));
}

// ---------------------------------------------------------------- go-to

/** show a node in the Node editor: its graph becomes the editor scope, then it is centred
 * @param {string} nodeId @param {string} [graphId] */
export async function goToNode(nodeId, graphId) {
	const found = findNode(nodeId, graphId);
	if (!found) {
		showToast('That node is gone');
		return;
	}
	// the editor's scope FOLLOWS the selection, so select the graph's owner (or nothing)
	const oa = await import('./objectActions');
	if (found.graphId === SCENE_GRAPH) oa.deselectObject();
	else oa.applySelectionSet([found.graphId]);
	setActiveGraph(found.graphId);
	focusFlowNode(nodeId);
}

// ---------------------------------------------------------------- following the source

/** recompute every tab's view of its source after a graph or library change */
function followSources() {
	const tabs = get(codeTabs);
	if (!tabs.length) return;
	let changed = false;
	const next = tabs.map((tab) => {
		const t = followOne(tab);
		if (t !== tab) changed = true;
		return t;
	});
	if (changed) codeTabs.set(next);
}

/** @param {CodeTab} tab @returns {CodeTab} */
function followOne(tab) {
	if (tab.kind === 'node' || tab.kind === 'behaviour') {
		const f = tab.nodeId ? findNode(tab.nodeId, tab.graphId) : null;
		if (!f) return tab.error?.message === 'The node this tab edits is gone' ? tab : { ...tab, error: { message: 'The node this tab edits is gone', line: 1 } };
		return reconcileExternal(tab, String(f.node.data?.code ?? ''));
	}
	if (tab.kind === 'file') {
		const bound = nodesBoundTo(tab.hash ?? '');
		if (bound.length) return reconcileExternal(tab, String(bound[0].node.data?.code ?? ''));
		// no node bears our hash any more: did the file MOVE under us (a peer's save, an undo)?
		const from = tab.fromNode ? findNode(tab.fromNode.nodeId, tab.fromNode.graphId) : null;
		const ref = from ? assetSrcOf(from.node) : null;
		if (ref && ref.name === tab.name && ref.hash !== tab.hash) {
			const followed = reconcileExternal({ ...tab, hash: ref.hash, itemId: itemByHash(ref.hash)?.id ?? tab.itemId }, String(from?.node.data?.code ?? ''));
			return followed;
		}
		return tab;
	}
	if (tab.kind === 'graph') return reconcileExternal(tab, graphJson(serializedGraph(tab.graphId ?? SCENE_GRAPH)));
	return tab;
}

/** an unbound file tab follows its Explorer item (a peer's copy replaced in place) */
async function followItems() {
	for (const tab of get(codeTabs)) {
		if (tab.kind !== 'file' || !tab.itemId || nodesBoundTo(tab.hash ?? '').length) continue;
		const item = itemById(tab.itemId);
		if (!item || item.hash === tab.hash) continue;
		const blob = await itemBlob(item.id);
		if (!blob) continue;
		const text = await blob.text();
		patchTab(tab.id, (t) => reconcileExternal({ ...t, hash: item.hash, name: item.name, title: item.name }, text));
	}
}

let started = false;
/** boot (idempotent): the watches, and the old `scriptEditorOpen` seam */
export function startCodeWorkspace() {
	if (started || typeof window === 'undefined') return;
	started = true;
	startScriptAssets();
	/** @type {any} */ let timer = null;
	flowGraphs.subscribe(() => {
		clearTimeout(timer);
		timer = setTimeout(followSources, 150);
	});
	explorerItems.subscribe(() => {
		followItems().catch(() => {});
	});
	// "Edit code" on a Script node, and anyone else still using the ScriptPanel seam
	scriptEditorOpen.subscribe((nodeId) => {
		if (!nodeId) return;
		// cleared OUTSIDE this subscriber (never write a store from inside its own)
		queueMicrotask(() => {
			scriptEditorOpen.set(null);
			openCode({ source: 'script', ref: { nodeId } });
		});
	});
}
