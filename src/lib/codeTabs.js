// 36-code (plan 75.2/75.4 + B6) — THE CODE WORKSPACE'S TABS, as plain data.
//
// The workspace (codeWorkspace.js + CodeWorkspace.svelte) is a notebook of sources: a Script
// node's code, a script FILE (an Explorer .js item, shared by every node bound to it), a
// behaviour node's module, a module's read-only source, and a flow graph as JSON. Every tab
// is a BUFFER over its source: typing changes `code`, Ctrl+S writes it and moves `saved`.
// What is easy to get subtly wrong lives here, testable with no store, no DOM and no peer:
//   - IDENTITY: which open tab a request means (a file tab is found by its item OR by the
//     hash it currently holds, because a save changes the hash and a peer's copy of the
//     file has another item id),
//   - THE EXTERNAL-EDIT RULE: a clean tab follows its source; a dirty one keeps the user's
//     text and is marked `stale` (never silently overwritten, never silently lost),
//   - THE PARSE CHECK run on save (75.4) — a Script node body, a behaviour module, JSON,
//   - B6: graph JSON -> a validated replacement graph, or one error with a line. Invalid
//     JSON never applies.
//
// A LEAF: imports acorn only (already the behaviour analyzer's parser).

import { parse } from 'acorn';

/**
 * @typedef {'node' | 'file' | 'behaviour' | 'module' | 'graph'} TabKind
 * @typedef {{ message: string, line: number, col?: number }} CodeError
 * @typedef {{
 *   id: string, kind: TabKind, title: string, lang: 'js' | 'json', code: string, saved: string,
 *   readOnly?: boolean, stale?: boolean, external?: string, error?: CodeError | null,
 *   nodeId?: string, graphId?: string, itemId?: string | null, hash?: string, name?: string,
 *   moduleId?: string, line?: number, fromNode?: { nodeId: string, graphId: string } | null,
 *   nodeType?: string
 * }} CodeTab
 */

/** does a request name this tab? `spec` is the resolved identity of what is being opened
 * @param {CodeTab} tab @param {any} spec */
export function tabMatches(tab, spec) {
	if (!spec || tab.kind !== spec.kind) return false;
	switch (tab.kind) {
		case 'node':
		case 'behaviour':
			return tab.nodeId === spec.nodeId && (tab.graphId ?? 'scene') === (spec.graphId ?? 'scene');
		case 'file':
			// the item when both know one (a rename or a save keeps it), else the bytes
			if (tab.itemId && spec.itemId) return tab.itemId === spec.itemId;
			return !!spec.hash && tab.hash === spec.hash;
		case 'module':
			return tab.moduleId === spec.moduleId && (tab.name ?? '') === (spec.name ?? '');
		case 'graph':
			return (tab.graphId ?? 'scene') === (spec.graphId ?? 'scene');
	}
	return false;
}

/** @param {CodeTab[]} tabs @param {any} spec @returns {CodeTab | null} */
export function findTab(tabs, spec) {
	return tabs.find((t) => tabMatches(t, spec)) ?? null;
}

/** @param {CodeTab | null | undefined} tab */
export function isDirty(tab) {
	return !!tab && !tab.readOnly && tab.code !== tab.saved;
}

/**
 * The source changed under an open tab (a peer's edit, an undo, a hash bump from another
 * tab). A CLEAN tab follows it. A DIRTY tab keeps the user's text — overwriting it would
 * lose work, ignoring it would let a later save silently revert the other edit — so it is
 * marked stale with the incoming text kept for "Reload".
 * @param {CodeTab} tab @param {string} external @returns {CodeTab}
 */
export function reconcileExternal(tab, external) {
	const text = String(external ?? '');
	if (text === tab.saved && !tab.stale) return tab;
	if (text === tab.code) return { ...tab, saved: text, stale: false, external: undefined };
	if (!isDirty(tab)) return { ...tab, code: text, saved: text, stale: false, external: undefined };
	return { ...tab, stale: true, external: text };
}

/** throw away the user's edits for the source's current text @param {CodeTab} tab @returns {CodeTab} */
export function reloadTab(tab) {
	const text = tab.stale && tab.external !== undefined ? tab.external : tab.saved;
	return { ...tab, code: text, saved: text, stale: false, external: undefined, error: null };
}

/** the tab to show after `id` closes: its right neighbour, else its left, else none
 * @param {CodeTab[]} tabs @param {string} id @param {string | null} active */
export function nextActiveAfterClose(tabs, id, active) {
	if (active !== id) return active;
	const i = tabs.findIndex((t) => t.id === id);
	if (i < 0) return active;
	return tabs[i + 1]?.id ?? tabs[i - 1]?.id ?? null;
}

// ---------------------------------------------------------------- the parse check (75.4)

/** @param {any} e @param {number} [lineOffset] @returns {CodeError} */
function acornError(e, lineOffset = 0) {
	const msg = String(e?.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '');
	return { message: msg, line: Math.max(1, (e?.loc?.line ?? 1) - lineOffset), col: (e?.loc?.column ?? 0) + 1 };
}

/**
 * Does this source PARSE? Syntax only — the lint and the runtime say the rest, at their own
 * time. `script` = a Script node body (a function body: a top-level `return` is legal),
 * `behaviour` = an ES module (`export default behaviour({…})`), `json` = JSON.
 * @param {string} code @param {'script' | 'behaviour' | 'json'} kind
 * @returns {CodeError | null}
 */
export function parseCheck(code, kind) {
	const src = String(code ?? '');
	if (kind === 'json') {
		try {
			JSON.parse(src);
			return null;
		} catch (e) {
			return jsonError(src, e);
		}
	}
	try {
		parse(src, {
			ecmaVersion: 'latest',
			sourceType: kind === 'behaviour' ? 'module' : 'script',
			allowReturnOutsideFunction: kind === 'script',
			locations: true
		});
		return null;
	} catch (e) {
		return acornError(e);
	}
}

/** JSON.parse's message -> a line, across engines: V8 says "position N" (newer ones also
 * "line L column C"), Firefox "at line L column C" @param {string} src @param {any} e @returns {CodeError} */
function jsonError(src, e) {
	const message = String(e?.message ?? e);
	const lc = /line (\d+) column (\d+)/i.exec(message);
	if (lc) return { message: cleanJsonMessage(message), line: Number(lc[1]), col: Number(lc[2]) };
	const pos = /position (\d+)/i.exec(message);
	if (pos) {
		const before = src.slice(0, Number(pos[1]));
		const line = before.split('\n').length;
		return { message: cleanJsonMessage(message), line, col: before.length - before.lastIndexOf('\n') };
	}
	// current V8 names neither ("Unexpected token '}', ...\"b\": \n}\" is not valid JSON"):
	// JSON is (nearly) a JS expression, so acorn finds the spot; what acorn accepts and JSON
	// does not is a trailing comma or a non-JSON literal, located by pattern
	try {
		parse('(' + src + '\n)', { ecmaVersion: 'latest', locations: true });
	} catch (pe) {
		const at = acornError(pe);
		return { message: cleanJsonMessage(message).replace(/, ".*$/s, ''), line: at.line, col: at.col };
	}
	const trailing = /,\s*[}\]]/.exec(src) ?? /'|\bundefined\b|\/\//.exec(src);
	const line = trailing ? src.slice(0, trailing.index).split('\n').length : 1;
	return { message: trailing?.[0].startsWith(',') ? 'Trailing comma' : cleanJsonMessage(message), line };
}
/** @param {string} m */
const cleanJsonMessage = (m) => m.replace(/^JSON\.parse:\s*/, '').replace(/\s*\(line \d+ column \d+\)$/, '');

// ---------------------------------------------------------------- B6: graph JSON

/** the text a graph tab shows: serialized nodes/edges, pretty @param {{nodes: any[], edges: any[]}} graph */
export function graphJson(graph) {
	return JSON.stringify({ nodes: graph.nodes ?? [], edges: graph.edges ?? [] }, null, 2) + '\n';
}

/** @param {string} src @param {string} needle find the line a node/edge id first appears on */
function lineOf(src, needle) {
	const i = src.indexOf(JSON.stringify(needle));
	return i < 0 ? 1 : src.slice(0, i).split('\n').length;
}

/**
 * Turn an edited graph JSON into the graph to apply — or ONE error naming a line. Nothing
 * here touches a store: the caller applies `nodes`/`edges` and broadcasts the removals.
 * A node with no position keeps the one it had (`current`), or takes a free slot below the
 * graph (the FlowCode rule: xyflow dereferences `node.position` on adopt). Edges must join
 * nodes that exist — a dangling edge is refused rather than drawn to nowhere on every peer.
 * @param {string} text
 * @param {{nodes: any[], edges: any[]}} current the live graph (serialized)
 * @returns {{ok: true, nodes: any[], edges: any[], removedNodes: string[], removedEdges: string[], changed: boolean}
 *   | {ok: false, error: CodeError}}
 */
export function parseGraphJson(text, current) {
	const syntax = parseCheck(text, 'json');
	if (syntax) return { ok: false, error: syntax };
	/** @type {any} */
	const doc = JSON.parse(text);
	const fail = (/** @type {string} */ message, line = 1) => ({ ok: /** @type {false} */ (false), error: { message, line } });
	if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.nodes))
		return fail('Expected an object like { "nodes": [...], "edges": [...] }');
	if (doc.edges !== undefined && !Array.isArray(doc.edges)) return fail('"edges" must be an array', lineOf(text, 'edges'));
	const ids = new Set();
	for (const [i, n] of doc.nodes.entries()) {
		if (!n || typeof n !== 'object' || Array.isArray(n)) return fail('nodes[' + i + '] is not an object');
		if (typeof n.id !== 'string' || !n.id) return fail('nodes[' + i + '] needs a string "id"');
		if (typeof n.type !== 'string' || !n.type) return fail('node "' + n.id + '" needs a string "type"', lineOf(text, n.id));
		if (ids.has(n.id)) return fail('two nodes share the id "' + n.id + '"', lineOf(text, n.id));
		if (n.data !== undefined && (typeof n.data !== 'object' || n.data === null || Array.isArray(n.data)))
			return fail('node "' + n.id + '": "data" must be an object', lineOf(text, n.id));
		if (n.position !== undefined && !(Number.isFinite(n.position?.x) && Number.isFinite(n.position?.y)))
			return fail('node "' + n.id + '": "position" must be {x, y} numbers', lineOf(text, n.id));
		ids.add(n.id);
	}
	const edges = doc.edges ?? [];
	const edgeIds = new Set();
	for (const [i, e] of edges.entries()) {
		if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id) return fail('edges[' + i + '] needs a string "id"');
		if (edgeIds.has(e.id)) return fail('two edges share the id "' + e.id + '"', lineOf(text, e.id));
		edgeIds.add(e.id);
		if (!ids.has(e.source)) return fail('edge "' + e.id + '": no node "' + e.source + '"', lineOf(text, e.id));
		if (!ids.has(e.target)) return fail('edge "' + e.id + '": no node "' + e.target + '"', lineOf(text, e.id));
	}
	const had = new Map((current.nodes ?? []).map((n) => [n.id, n.position]));
	const placed = doc.nodes.filter((/** @type {any} */ n) => n.position);
	const bottom = Math.max(0, ...placed.map((/** @type {any} */ n) => Number(n.position.y) || 0));
	let row = 0;
	const nodes = doc.nodes.map((/** @type {any} */ n) => {
		const out = { ...n, data: n.data ?? {} };
		if (!n.position)
			out.position = had.get(n.id) ?? { x: 60 + (row % 4) * 190, y: bottom + 130 + Math.floor(row++ / 4) * 130 };
		return out;
	});
	const removedNodes = (current.nodes ?? []).map((n) => n.id).filter((id) => !ids.has(id));
	const removedEdges = (current.edges ?? []).map((e) => e.id).filter((id) => !edgeIds.has(id));
	const changed =
		JSON.stringify({ nodes: current.nodes ?? [], edges: current.edges ?? [] }) !== JSON.stringify({ nodes, edges });
	return { ok: true, nodes, edges, removedNodes, removedEdges, changed };
}

/**
 * G1's OpenCodeRequest (graphContract.openCodeRequestFor) carries `ref` as a STRING — a node id
 * (script/behaviour), a def id (customnode) or `module/file` — with `graphId` beside it. Both
 * that and the object form are accepted; this turns either into the object form.
 * @param {any} req */
export function normalizeCodeRequest(req) {
	let ref = req?.ref ?? {};
	if (typeof ref === 'string') {
		if (req.source === 'module') {
			const cut = ref.indexOf('/');
			ref = cut < 0 ? { moduleId: ref } : { moduleId: ref.slice(0, cut), name: ref.slice(cut + 1) };
		} else if (req.source === 'customnode') ref = { defId: ref };
		else ref = { nodeId: ref };
	}
	if (req?.graphId && !ref.graphId && (ref.nodeId || req.source === 'graph')) ref = { ...ref, graphId: req.graphId };
	return { ...req, ref };
}

/** a short display name for a script file: `wobble.js`; a name without .js gets one
 * @param {string} name */
export function scriptFileName(name) {
	const base = String(name ?? '').trim().replace(/[*\\/]/g, '-') || 'script';
	return /\.js$/i.test(base) ? base : base + '.js';
}

/**
 * 36-fb-code (F6/F8): move one tab to a new index (drag in the tab strip or the Open editors
 * list). `toIndex` is where it lands in the list WITHOUT it — the drop-indicator's slot — so a
 * tab dropped on its own slot stays put. Unknown id = the list unchanged (same array).
 * @param {CodeTab[]} tabs @param {string} id @param {number} toIndex @returns {CodeTab[]}
 */
export function moveTab(tabs, id, toIndex) {
	const from = tabs.findIndex((t) => t.id === id);
	if (from < 0) return tabs;
	const rest = tabs.filter((t) => t.id !== id);
	const at = Math.max(0, Math.min(rest.length, Math.floor(Number(toIndex) || 0)));
	if (at === from) return tabs;
	return [...rest.slice(0, at), tabs[from], ...rest.slice(at)];
}
