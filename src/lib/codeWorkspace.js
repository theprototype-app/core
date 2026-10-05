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
	normalizeCodeRequest,
	moveTab
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
import { scriptInputs, scriptOutputs, RESERVED } from './scriptIO';
import { setScriptSockets } from './scriptSockets';
import { followCode } from './scriptDerive';
import { codeOfNode, isBuiltinCodeType, BUILTIN_CODE } from './builtinCode.js';
import { nodeHasCode, openCodeRequestFor } from './graphContract.js';
import { keyOfTab, nodeKey, modulesInUse, projectTree } from './codeProject.js';

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
	// 36-fb-code (F6): the kit's pieces (`kit/<piece>.js`) live in src/lib/kit, read by codeOpen
	if (id === 'kit') {
		const { moduleSourceFiles } = await import('./codeOpen');
		const hit = (await moduleSourceFiles('kit')).find((f) => f.file === file);
		if (hit) return { title: 'kit/' + file, code: hit.text };
	}
	const { userModules } = await import('./userModules');
	const record = get(userModules).find((/** @type {any} */ r) => r.id === id);
	const bytes = record?.files?.[ref.name || record?.entry];
	if (!bytes) return null;
	return { title: id + '/' + (ref.name || record.entry), code: typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes) };
}

/** does a source have a fork hook (the button shows only then). A module file always does:
 * with nothing registered, the default copies it into the Library (36-fb-code F6).
 * @param {string} source */
export function canFork(source) {
	return typeof sources.get(source)?.fork === 'function' || source === 'module';
}

/**
 * The default "Make editable copy" of a read-only module file: the text becomes a .js file in
 * the Library (the user's own, editable, shareable), opened in its own tab. The module keeps
 * running ITS copy — the toast says so, and that binding a Script node is how a copy runs.
 * A registered fork (registerCodeSource('module', {fork})) replaces this.
 * @param {{moduleId?: string, name?: string}} ref @param {string} code
 */
async function defaultModuleFork(ref, code) {
	const { addItemFromBytes } = await import('./explorer');
	await loadExplorer();
	const base = String(ref.name ?? 'module.js').split('/').pop()?.replace(/\.m?js$/, '') || 'module';
	const name = (ref.moduleId ? ref.moduleId + '-' : '') + base + ' (copy).js';
	const item = await addItemFromBytes(/** @type {ArrayBuffer} */ (new TextEncoder().encode(String(code ?? '')).buffer), name, null, {});
	if (!item) return null;
	showToast('Copied to your Library as ' + item.name + '. The module keeps running its own code — use "Use file…" on a Script node to run your copy.');
	return { source: 'script', ref: { itemId: item.id } };
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
		const code = codeOfNode(node);
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
		// G1: a node bound to a MODULE's file shows it read-only until "Make editable copy"
		const fromModule = node.data?.src?.kind === 'module';
		const title = fromModule
			? String(node.data.src.module ?? 'module') + '/' + String(node.data.src.file ?? 'source.js')
			: (node.data?.name || node.data?.label || (behaviour ? 'Behaviour' : 'Script')) + (behaviour ? '.behaviour.js' : '.js');
		// 36-fb-code (F5): a built-in with code (the Player) opens like a Script node; `nodeType`
		// lets the chrome offer what fits it (its engine's source, no Script-file binding)
		const builtin = isBuiltinCodeType(node.type) ? { nodeType: node.type } : {};
		return { id, kind: behaviour ? 'behaviour' : 'node', title, lang: 'js', code, saved: code, nodeId: node.id, graphId, ...builtin, ...(fromModule ? { readOnly: true } : {}) };
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
		// a module file we cannot read is declined quietly: the Module source window takes it
		if (req.source !== 'module') showToast('Nothing to open: that source is gone');
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

/** 36-fb-code (F6/F8): reorder a tab — the strip and the Open editors list share this order
 * @param {string} id @param {number} toIndex */
export function moveCodeTab(id, toIndex) {
	codeTabs.update((list) => moveTab(list, id, toIndex));
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

// ---------------------------------------------------------------- the unsaved-changes guard (36-fb-code S7)

/** the tabs holding edits that are not saved @returns {CodeTab[]} */
export const dirtyTabs = () => get(codeTabs).filter((t) => isDirty(t));

/** Save every unsaved tab. A tab whose code does not check stays dirty (and badged); the result
 * says which, so the caller keeps the workspace open on them. @returns {Promise<string[]>} ids NOT saved */
export async function saveAllCodeTabs() {
	const failed = [];
	for (const tab of dirtyTabs()) {
		const r = await saveCodeTab(tab.id);
		if (!r.ok) failed.push(tab.id);
	}
	return failed;
}

/** Throw away every unsaved edit (each tab shows its source as it is now). */
export function discardAllCodeTabs() {
	for (const tab of dirtyTabs()) reloadCodeTab(tab.id);
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
		followSockets(nodesBoundTo(out.hash), code);
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
		followSockets(nodesBoundTo(out.hash), code);
		return { ok: true, nodes: out.nodes };
	}
	const before = String(target.node.data?.code ?? '');
	if (before !== code) {
		setNodeData(target.node.id, { code }, target.graphId);
		recordFlowNodesEntry({ op: 'data', graphId: target.graphId, items: [{ id: target.node.id, before: { code: before }, after: { code } }] });
	}
	patchTab(id, (t) => ({ ...t, saved: code, error: null, stale: false, external: undefined }));
	markNodes(ids, null);
	followSockets([target], code);
	return { ok: true, nodes: 1 };
}

/**
 * 36-dataflow (56.3): a v2 Script node grows the sockets its code now uses (`inputs.x`, a
 * returned key) — never removes one, wires may hang on it. Run after a save reached the nodes.
 * @param {{node: any, graphId: string}[]} targets @param {string} code
 */
function followSockets(targets, code) {
	for (const { node, graphId } of targets) {
		if (node.type !== 'script') continue;
		const ins = scriptInputs(node.data);
		const outs = scriptOutputs(node.data);
		if (!ins && !outs.length) continue; // v1: a, b, c — nothing to grow
		const next = followCode(code, ins, outs, RESERVED);
		if (next.changed) setScriptSockets(node.id, { inputs: next.inputs, outputs: next.outputs }, graphId);
	}
}

/** "Make editable copy" of a MODULE-BOUND node tab (G1 src.kind 'module'): 36-dataflow's fork
 * makes the Explorer asset and re-points `data.src`; the tab then reopens as that file's tab.
 * @param {string} id */
export async function forkNodeTab(id) {
	const tab = tabById(id);
	if (!tab?.nodeId || !tab.readOnly) return null;
	const { forkNodeSource } = await import('./codeOpen');
	const src = await forkNodeSource(tab.nodeId, tab.graphId);
	if (!src) return null;
	const ref = { nodeId: tab.nodeId, graphId: tab.graphId };
	closeCodeTab(id, { force: true });
	return openCode({ source: 'script', ref });
}

// 36-fb-code (F5): the core file a built-in's code steers, readable (never editable) — "nothing
// hidden". A lazy raw chunk per file, the coreModuleSources precedent.
const engineSources = import.meta.glob(['./charController.js'], { query: '?raw', import: 'default' });

/** open the engine source behind a built-in node's tab, read-only @param {string} id */
export async function openEngineSource(id) {
	const tab = tabById(id);
	const file = tab?.nodeType ? BUILTIN_CODE[tab.nodeType]?.engine : null;
	const load = file ? engineSources['./' + file] : null;
	if (!load) return null;
	return openCode({ source: 'module', ref: { moduleId: 'core', name: file, code: String(await load()) } });
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
	const fork = sources.get('module')?.fork ?? defaultModuleFork;
	const target = await fork({ moduleId: tab.moduleId, name: tab.name }, tab.code).catch((e) => {
		showToast('Could not make an editable copy: ' + (e?.message ?? e));
		return null;
	});
	if (!target) return null;
	return openCode(/** @type {any} */ (target));
}

// ---------------------------------------------------------------- the sidebars (36-fb-code F6/F7)

/** show a line of an open tab (Outline, Problems, a Find hit in an open file)
 * @param {string} tabId @param {number} line */
export function revealInTab(tabId, line) {
	if (!tabById(tabId)) return;
	activeCodeTab.set(tabId);
	codeRevealLine.set({ tabId, line: Math.max(1, Math.floor(line) || 1), token: ++lineToken });
}

/**
 * The nodes that USE a read-only module file — kit nodes, Code links, module nodes and nodes
 * bound to it — for the Bound nodes panel of a module tab.
 * @param {{moduleId?: string, name?: string}} tab @returns {{node: any, graphId: string}[]}
 */
export function nodesUsingModuleFile(tab) {
	// a built-in's engine source (moduleId 'core'): the nodes whose code steers it (the Players)
	if (tab.moduleId === 'core') {
		/** @type {{node: any, graphId: string}[]} */
		const steer = [];
		for (const [graphId, graph] of Object.entries(get(flowGraphs)))
			for (const node of /** @type {any} */ (graph).nodes ?? [])
				if (isBuiltinCodeType(node.type) && BUILTIN_CODE[node.type].engine === tab.name) steer.push({ node, graphId });
		return steer;
	}
	const want = String(tab.moduleId ?? '') + (tab.name ? '/' + tab.name : '');
	/** @type {{node: any, graphId: string}[]} */
	const out = [];
	for (const [graphId, graph] of Object.entries(get(flowGraphs))) {
		for (const node of /** @type {any} */ (graph).nodes ?? []) {
			const spec = findSpec?.(String(node.type));
			if (!nodeHasCode(node, spec)) continue;
			const req = openCodeRequestFor(node, graphId, spec);
			if (req?.source !== 'module') continue;
			const ref = String(req.ref ?? '');
			// a module's own node names the module alone: it uses the module's entry file
			if (ref === want || (ref === tab.moduleId && (!tab.name || tab.name === 'module.js'))) out.push({ node, graphId });
		}
	}
	return out;
}
/** @type {((type: string) => any) | null} the node-spec lookup (nodeCatalog), primed lazily */
let findSpec = null;
if (typeof window !== 'undefined') import('./nodeCatalog').then((m) => (findSpec = m.findNodeSpec)).catch(() => {});

/**
 * The Project tree as it is now (Ctrl+P's list; the left sidebar builds its own reactively).
 * @param {(graphId: string) => string} [graphTitle]
 */
export function currentProjectTree(graphTitle) {
	return projectTree({
		graphs: get(flowGraphs),
		graphTitle,
		scripts: get(explorerItems).filter((i) => /\.js$/i.test(i.name)),
		boundCount: (hash) => nodesBoundTo(hash).length,
		specOf: (type) => findSpec?.(type)
	});
}

/**
 * Every source Find in files searches, open tabs FIRST (their unsaved text wins over what is
 * stored): script/behaviour/built-in node code, the Explorer's .js files, and — `modules` — the
 * module and kit sources the graphs use. Each carries what a hit opens.
 * @param {{modules?: boolean}} [opts]
 * @returns {Promise<{key: string, title: string, code: string, request: any}[]>}
 */
export async function findSources(opts = {}) {
	const tabs = get(codeTabs);
	/** @type {{key: string, title: string, code: string, request: any}[]} */
	const out = [];
	const seen = new Set();
	const push = (/** @type {string} */ key, /** @type {string} */ title, /** @type {string} */ code, /** @type {any} */ request) => {
		if (!key || seen.has(key)) return;
		seen.add(key);
		out.push({ key, title, code, request });
	};
	for (const t of tabs) push(keyOfTab(t) || 'tab:' + t.id, t.title, t.code, { tabId: t.id });
	await loadExplorer();
	for (const [graphId, graph] of Object.entries(get(flowGraphs))) {
		for (const node of /** @type {any} */ (graph).nodes ?? []) {
			if (node.type !== 'script' && node.type !== 'behaviour' && !isBuiltinCodeType(node.type)) continue;
			const code = String(node.data?.code ?? '');
			const asset = assetSrcOf(node);
			const request = { source: node.type === 'behaviour' ? 'behaviour' : 'script', ref: { nodeId: node.id, graphId } };
			if (asset) {
				const item = itemByHash(asset.hash);
				push(item ? 'f:' + item.id : 'h:' + asset.hash, asset.name, code, request);
			} else push(nodeKey(graphId, node.id), String(node.data?.name || node.data?.label || node.type), code, request);
		}
	}
	for (const item of get(explorerItems)) {
		if (!/\.js$/i.test(item.name) || seen.has('f:' + item.id)) continue;
		const blob = await itemBlob(item.id).catch(() => null);
		push('f:' + item.id, item.name, blob ? await blob.text() : '', { source: 'script', ref: { itemId: item.id } });
	}
	if (opts.modules) {
		const { moduleSourceFiles } = await import('./codeOpen');
		for (const moduleId of modulesInUse(get(flowGraphs), (type) => findSpec?.(type)).keys()) {
			const files = await moduleSourceFiles(moduleId).catch(() => []);
			for (const f of files)
				if (/\.m?js$/.test(f.file)) push('m:' + moduleId + '/' + f.file, moduleId + '/' + f.file, f.text, { source: 'module', ref: { moduleId, name: f.file } });
		}
	}
	return out;
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
		return reconcileExternal(tab, codeOfNode(f.node));
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
	// S7: leaving the page with unsaved code asks first (the browser's own prompt — the only one
	// a page may show there). Closing the workspace keeps the tabs; leaving the page does not.
	window.addEventListener('beforeunload', (e) => {
		if (!dirtyTabs().length) return;
		e.preventDefault();
		e.returnValue = '';
	});
	/** @type {any} */ let timer = null;
	flowGraphs.subscribe(() => {
		clearTimeout(timer);
		timer = setTimeout(followSources, 150);
	});
	explorerItems.subscribe(() => {
		followItems().catch(() => {});
	});
	// G1 (36-dataflow's codeOpen seam): double-click / "Open code" on any code node lands here.
	// A request this workspace cannot satisfy is DECLINED (false) so the built-in fallback opens
	// it — a module file we cannot read goes to the read-only Module source window.
	import('./codeOpen')
		.then((m) =>
			m.registerCodeOpener(async (req) => {
				if (req.source === 'customnode') return false; // NodeDesigner is the def's editor
				return (await openCode(/** @type {any} */ (req))) !== null;
			})
		)
		.catch(() => {});
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
