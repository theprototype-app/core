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
//   - (codeParse.js) THE PARSE CHECK run on save (75.4) and B6's graph JSON reader.
//
// A LEAF: imports nothing. THE PARSE CHECK and B6's graph JSON reader live in codeParse.js, which
// imports acorn (~34 KB gz): this file is on the editor's boot (codeWorkspace, scriptAssets) and acorn is
// not (102-boot-diet).

/**
 * @typedef {'node' | 'file' | 'behaviour' | 'module' | 'graph'} TabKind
 * @typedef {{ message: string, line: number, col?: number }} CodeError
 * @typedef {{
 *   id: string, kind: TabKind, title: string, lang: 'js' | 'json' | 'text', code: string, saved: string,
 *   readOnly?: boolean, stale?: boolean, external?: string, error?: CodeError | null,
 *   nodeId?: string, graphId?: string, itemId?: string | null, hash?: string, name?: string,
 *   moduleId?: string, line?: number, fromNode?: { nodeId: string, graphId: string } | null,
 *   nodeType?: string, format?: 'json' | 'text'
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
			// showhide-v8 §4: one graph opens two ways — graph.json and the compact flow code text
			return (tab.graphId ?? 'scene') === (spec.graphId ?? 'scene') && (tab.format ?? 'json') === (spec.format ?? 'json');
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

/**
 * 50 Y1 — THE EXTERNAL-EDIT RULE FOR A SHARED BUFFER. The buffer is everyone's (sharedText.js),
 * so a source change usually IS that buffer arriving through a save — the peer who pressed
 * Ctrl+S recorded it in the shared document first (`savedFromBuffer`) — and then this tab is
 * simply saved, whatever unsaved text sits on top. A change that came some other way (an undo
 * of the node, a peer on an older build) follows a CLEAN buffer — but through ONE writer,
 * never by every peer rewriting the shared text (`follow` asks the caller to arrange that) —
 * and leaves a dirty one stale, the classic rule.
 * @param {CodeTab} tab @param {string} external @param {boolean} savedFromBuffer
 * @returns {{tab: CodeTab, follow: boolean}}
 */
export function reconcileShared(tab, external, savedFromBuffer) {
	const text = String(external ?? '');
	if (text === tab.saved && !tab.stale) return { tab, follow: false };
	if (text === tab.code || savedFromBuffer) return { tab: { ...tab, saved: text, stale: false, external: undefined }, follow: false };
	if (!isDirty(tab)) return { tab: { ...tab, saved: text, stale: false, external: undefined }, follow: true };
	return { tab: { ...tab, stale: true, external: text }, follow: false };
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

// ---------------------------------------------------------------- B6: graph JSON

/** the text a graph tab shows: serialized nodes/edges, pretty @param {{nodes: any[], edges: any[]}} graph */
export function graphJson(graph) {
	return JSON.stringify({ nodes: graph.nodes ?? [], edges: graph.edges ?? [] }, null, 2) + '\n';
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
	if (req?.graphId && !ref.graphId && (ref.nodeId || req.source === 'graph' || req.source === 'flowtext')) ref = { ...ref, graphId: req.graphId };
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
